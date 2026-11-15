package cli

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"github.com/coder/websocket"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// ---- in-process: the Go forwarder against the fake ----

func fwdFreePort(t *testing.T) int {
	t.Helper()
	for {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		p := ln.Addr().(*net.TCPAddr).Port
		ln.Close()
		if p >= 1024 {
			return p
		}
	}
}

// fwdStartIn starts a forwarder against the fake; the second result snapshots its notices.
func fwdStartIn(t *testing.T, f *fwdFake, specs []string, tweak func(*fwdOptions)) (*fwdForwarder, func() []string) {
	t.Helper()
	home, xdg := fwdLoginHome(t, f)
	c, _, _ := testCtx(t)
	c.Home = home
	c.Env["XDG_CONFIG_HOME"] = xdg
	c.Env["TERMAG_URL"] = f.host()
	s, err := newSession(c, &ParsedArgs{})
	if err != nil {
		t.Fatal(err)
	}
	src, err := bearerFor(c, s)
	if err != nil {
		t.Fatal(err)
	}
	ports, err := fwdParsePortSpecs(specs)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	notes := []string{}
	opts := fwdOptions{host: f.host(), box: &ConnectBox{ID: "i1", Name: "devbox"}, ports: ports, token: src,
		notify: func(l string) { mu.Lock(); notes = append(notes, l); mu.Unlock() }, retryDelay: 10 * time.Millisecond}
	if tweak != nil {
		tweak(&opts)
	}
	fw, err := fwdStart(c, opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { fw.stop() })
	return fw, func() []string { mu.Lock(); defer mu.Unlock(); return append([]string(nil), notes...) }
}

func fwdEcho(t *testing.T, port int, host string, payload []byte) []byte {
	t.Helper()
	conn, err := net.Dial("tcp", fwdHostPort(host, port))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	go func() {
		conn.Write(payload)
		conn.(*net.TCPConn).CloseWrite()
	}()
	got, _ := io.ReadAll(conn)
	return got
}

func fwdUntil(t *testing.T, cond func() bool) {
	t.Helper()
	end := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(end) {
			t.Fatal("timed out waiting")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestForwardPortSpecs(t *testing.T) {
	cases := map[string]string{
		"3000":       "",
		"80:8080":    "",
		"80":         "`80`: local port 80 is below 1024; pick a local port of 1024 or more; e.g. 80:8080",
		"3000:":      "`3000:` is not <port>[:<local>], e.g. 3000 or 3000:3001",
		"1:2:3":      "`1:2:3` is not <port>[:<local>], e.g. 3000 or 3000:3001",
		"x":          "`x`: the box port must be a number from 1 to 65535",
		"3000:70000": "`3000:70000`: the local port must be a number from 1 to 65535",
		"60000:1000": "`60000:1000`: local port 1000 is below 1024; pick a local port of 1024 or more",
	}
	for spec, want := range cases {
		_, err := fwdParsePortSpec(spec)
		got := ""
		if err != nil {
			got = err.Error()
		}
		if got != want {
			t.Errorf("%q: %q, want %q", spec, got, want)
		}
	}
	if _, err := fwdParsePortSpecs([]string{"3000", "4000:3000"}); err == nil || err.Error() != "Local port 3000 is named twice; each forward needs its own local port" {
		t.Error(err)
	}
}

func TestForwardEchoBothFamiliesAndTotals(t *testing.T) {
	f := fwdNewFake(t)
	local := fwdFreePort(t)
	fw, _ := fwdStartIn(t, f, []string{fmt.Sprintf("3000:%d", local)}, nil)
	if got := fw.listening[0].Addresses; len(got) == 0 || got[0] != fmt.Sprintf("127.0.0.1:%d", local) {
		t.Fatalf("addresses %v", got)
	}
	payload := make([]byte, 3<<20)
	rand.Read(payload)
	for _, host := range []string{"127.0.0.1", "::1"} {
		if host == "::1" && len(fw.listening[0].Addresses) < 2 {
			continue
		}
		if got := fwdEcho(t, local, host, payload); !bytes.Equal(got, payload) {
			t.Fatalf("%s: echo of %d bytes came back as %d", host, len(payload), len(got))
		}
	}
	tot := fw.stop()
	n := int64(len(fw.listening[0].Addresses))
	if tot.Connections != int(n) || tot.Failed != 0 || tot.BytesUp != n*int64(len(payload)) || tot.BytesDown != tot.BytesUp {
		t.Errorf("totals %+v", tot)
	}
	for _, c := range f.snapshot() {
		if c.protocol != fwdSubprotocolV2 || c.closeCode != 1000 || !c.gotFin {
			t.Errorf("conn %+v", c)
		}
	}
}

func TestForwardV1OnlyServerAndNoTokenFrames(t *testing.T) {
	f := fwdNewFake(t)
	f.v1Only = true
	local := fwdFreePort(t)
	fwdStartIn(t, f, []string{fmt.Sprintf("3000:%d", local)}, func(o *fwdOptions) { o.renewEvery = 50 * time.Millisecond })
	conn, _ := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", local))
	conn.Write([]byte("hi"))
	buf := make([]byte, 2)
	io.ReadFull(conn, buf)
	time.Sleep(200 * time.Millisecond)
	conn.Close()
	cs := f.snapshot()
	if len(cs) != 1 || cs[0].protocol != fwdSubprotocolV1 || len(cs[0].tokens) != 0 || len(cs[0].stray) != 0 {
		t.Errorf("v1 conn %+v", cs)
	}
}

func TestForwardRenewsMidStreamOnV2(t *testing.T) {
	f := fwdNewFake(t)
	local := fwdFreePort(t)
	fwdStartIn(t, f, []string{fmt.Sprintf("3000:%d", local)}, func(o *fwdOptions) { o.renewEvery = 50 * time.Millisecond })
	conn, _ := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", local))
	defer conn.Close()
	conn.Write([]byte("a"))
	b := make([]byte, 1)
	io.ReadFull(conn, b)
	fwdUntil(t, func() bool { return len(f.snapshot()) == 1 })
	// The renewer asks with validFor 15 min; with an hour left there is nothing new to send.
	time.Sleep(200 * time.Millisecond)
	if n := len(f.snapshot()[0].tokens); n != 0 {
		t.Fatalf("sent %d token frames with a fresh token", n)
	}
	// Now the stored token lapses in 10 min: the next ask refreshes and sends it in band.
	fwdExpireLogin(t, f)
	fwdUntil(t, func() bool { return len(f.snapshot()[0].tokens) >= 1 })
	tok := f.snapshot()[0].tokens[0]
	if fwdSignInOf(tok) != "dev1" {
		t.Errorf("renewed token %q", tok)
	}
	// The stream still works after the renewal.
	conn.Write([]byte("b"))
	io.ReadFull(conn, b)
	if b[0] != 'b' {
		t.Errorf("after renewal got %q", b)
	}
}

// fwdExpireLogin makes the stored access token lapse in 10 minutes, under the renewer's margin.
var fwdLoginPaths sync.Map

func fwdExpireLogin(t *testing.T, f *fwdFake) {
	v, ok := fwdLoginPaths.Load(f)
	if !ok {
		t.Fatal("no login path")
	}
	path := v.(string)
	l := LoadLogin(path, f.host())
	l.obj.Set("accessTokenExpiresAt", isoString(time.Now().Add(10*time.Minute)))
	if err := SaveLogin(path, f.host(), l); err != nil {
		t.Fatal(err)
	}
}

func TestForwardRetriesOnceOn1012AndRefusals(t *testing.T) {
	f := fwdNewFake(t)
	f.queue[3000] = []string{"closeAfterOpen:1012"}
	f.queue[3001] = []string{"refuse:403:port_refused:not allowed by the box"}
	a, b := fwdFreePort(t), fwdFreePort(t)
	_, notes := fwdStartIn(t, f, []string{fmt.Sprintf("3000:%d", a), fmt.Sprintf("3001:%d", b)}, nil)
	if got := fwdEcho(t, a, "127.0.0.1", []byte("again")); string(got) != "again" {
		t.Errorf("after 1012: %q", got)
	}
	fwdEcho(t, b, "127.0.0.1", []byte("x"))
	fwdUntil(t, func() bool { return len(notes()) > 0 })
	want := fmt.Sprintf("devbox:3001 (localhost:%d): port_refused: devbox refused to forward port 3001: not allowed by the box", b)
	if got := notes(); got[0] != want {
		t.Errorf("notes %q", got)
	}
}

// A 1012 after the first 4 KiB frame of a 12 KiB request went out: the box has part of it, so the
// connection must not be handed back as untouched (the redial would send a truncated request); it
// is reset, and no second dial happens. Before the fix, progress counted only per chunk, so the
// connection was redialed with neither the first 4 KiB nor the rest of the chunk.
func TestForwardDoesNotRedialAConnectionAFrameLeftOn(t *testing.T) {
	f := fwdNewFake(t)
	f.queue[3000] = []string{"closeAfterFirstFrame:1012"}
	// Hold the chunk's later frames until the close has landed, so it lands mid-chunk every time.
	var once sync.Once
	hook := func() { once.Do(func() { time.Sleep(150 * time.Millisecond) }) }
	fwdAfterFrame.Store(&hook)
	t.Cleanup(func() { fwdAfterFrame.Store(nil) })
	a := fwdFreePort(t)
	fwdStartIn(t, f, []string{fmt.Sprintf("3000:%d", a)}, nil)
	payload := bytes.Repeat([]byte("0123456789abcdef"), 12*1024/16)
	got := fwdEcho(t, a, "127.0.0.1", payload)
	if len(got) != 0 {
		t.Errorf("echoed %d bytes after a reset", len(got))
	}
	time.Sleep(200 * time.Millisecond)
	conns := f.snapshot()
	if len(conns) != 1 || conns[0].received != fwdFirstFrame || conns[0].closeCode != 1012 {
		t.Errorf("want one dial that got the first frame and closed 1012; got %+v", conns)
	}
}

// A 1012 before any frame of the request went out: the connection is redialed and the retry
// carries every byte, the chunk already read from TCP included.
func TestForwardRedialCarriesEveryByteOfAnUntouchedRequest(t *testing.T) {
	f := fwdNewFake(t)
	f.queue[3000] = []string{"closeAfterOpen:1012"}
	a := fwdFreePort(t)
	fwdStartIn(t, f, []string{fmt.Sprintf("3000:%d", a)}, nil)
	payload := bytes.Repeat([]byte("0123456789abcdef"), 12*1024/16)
	if got := fwdEcho(t, a, "127.0.0.1", payload); !bytes.Equal(got, payload) {
		t.Errorf("after the redial: %d of %d bytes", len(got), len(payload))
	}
	conns := f.snapshot()
	if len(conns) != 1 || conns[0].received != len(payload) {
		t.Errorf("the redial got %+v", conns)
	}
}

func TestForwardBackpressureWithASlowReader(t *testing.T) {
	f := fwdNewFake(t)
	f.behave[3000] = "firehose"
	f.total = 64 << 20
	local := fwdFreePort(t)
	fwdStartIn(t, f, []string{fmt.Sprintf("3000:%d", local)}, nil)
	conn, _ := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", local))
	defer conn.Close()
	conn.(*net.TCPConn).SetReadBuffer(64 << 10)
	time.Sleep(500 * time.Millisecond) // read nothing: the box's sends back up
	fwdUntil(t, func() bool { return len(f.snapshot()) == 1 })
	sent := f.snapshot()[0].sent
	if sent >= f.total {
		t.Fatalf("the box sent everything (%d) to a reader that read nothing", sent)
	}
	got, _ := io.Copy(io.Discard, conn)
	if got != int64(f.total) {
		t.Errorf("read %d of %d", got, f.total)
	}
	t.Logf("in flight while stalled: %d MiB of %d", sent>>20, f.total>>20)
}

func TestForwardBindConflictNamesTheHolder(t *testing.T) {
	f := fwdNewFake(t)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	busy := ln.Addr().(*net.TCPAddr).Port
	old := fwdExec
	fwdExec = func(string, ...string) (string, int) {
		return fmt.Sprintf("COMMAND PID USER FD TYPE\nnode 4242 alice 20u IPv4\n"), 0
	}
	defer func() { fwdExec = old }()
	home, xdg := fwdLoginHome(t, f)
	c, _, _ := testCtx(t)
	c.Home, c.Env["XDG_CONFIG_HOME"], c.Env["TERMAG_URL"] = home, xdg, f.host()
	_, err := fwdStart(c, fwdOptions{host: f.host(), box: &ConnectBox{ID: "i1", Name: "devbox"}, ports: []fwdPort{{Port: 3000, Local: busy}},
		token: func(context.Context, string, time.Duration) (string, error) { return "", nil }, notify: func(string) {}})
	want := fmt.Sprintf("Local port %d is already in use by node (pid 4242, user alice); stop it, or use another local port: termag forward devbox 3000:%d", busy, busy+1)
	if err == nil || err.Error() != want || err.(*CliError).Code != "conflict" {
		t.Errorf("%v", err)
	}
}

func TestForwardSignInOf(t *testing.T) {
	if fwdSignInOf(fwdJWT("abc", 1)) != "abc" || fwdSignInOf("opaque") != "" || fwdSignInOf("a.!!.c") != "" {
		t.Error("signInOf")
	}
	if fwdTokenFrame(`t"1`) != `{"t":"token","token":"t\"1"}` {
		t.Error(fwdTokenFrame(`t"1`))
	}
}

// ---- Node vs Go: both CLIs as processes against the same fake ----

var (
	fwdGoBinOnce sync.Once
	fwdGoBinPath string
	fwdGoBinErr  error
)

func fwdGoBinary(t *testing.T) string {
	fwdGoBinOnce.Do(func() {
		dir, err := os.MkdirTemp("", "fwd-go-bin")
		if err != nil {
			fwdGoBinErr = err
			return
		}
		fwdGoBinPath = filepath.Join(dir, "termag")
		out, err := exec.Command("go", "build", "-o", fwdGoBinPath, "../../cmd/termag").CombinedOutput()
		if err != nil {
			fwdGoBinErr = fmt.Errorf("%v: %s", err, out)
		}
	})
	if fwdGoBinErr != nil {
		t.Fatal(fwdGoBinErr)
	}
	return fwdGoBinPath
}

func fwdNodeCLI(t *testing.T) []string {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("no node")
	}
	for _, s := range []string{os.Getenv("TERMAG_NODE_CLI"), os.Getenv("TERMAG_PARITY_NODE_CLI"), "../../../cli/bin/termag.js"} {
		if s == "" {
			continue
		}
		abs, _ := filepath.Abs(s)
		if _, err := os.Stat(filepath.Join(filepath.Dir(filepath.Dir(abs)), "dist", "main.js")); err == nil {
			return []string{node, abs}
		}
	}
	t.Skip("the Node CLI is not built (set TERMAG_NODE_CLI to cli/bin/termag.js)")
	return nil
}

type fwdRun struct {
	stdout, stderr string
	code           int
}

// fwdRunCLI starts a forward, waits for its ready output, runs scenario(localPort), then SIGINTs it.
func fwdRunCLI(t *testing.T, argv []string, f *fwdFake, local int, json bool, scenario func(local int)) fwdRun {
	t.Helper()
	home, xdg := fwdLoginHome(t, f)
	args := append(append([]string{}, argv[1:]...), "forward", "devbox", fmt.Sprintf("3000:%d", local))
	if json {
		args = append(args, "--json")
	}
	cmd := exec.Command(argv[0], args...)
	cmd.Env = []string{"HOME=" + home, "XDG_CONFIG_HOME=" + xdg, "PATH=" + os.Getenv("PATH"), "TERMAG_URL=" + f.host(),
		"TERMAG_TELEMETRY=0", "TERMAG_AGENT_CONFIG=" + filepath.Join(home, "none.json")}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	rd := bufio.NewReader(out)
	ready, readDone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(readDone)
		first := true
		for {
			line, err := rd.ReadString('\n')
			stdout.WriteString(line)
			if first && (strings.HasPrefix(line, "{") || strings.HasPrefix(line, "Ctrl-C")) {
				first = false
				close(ready)
			}
			if err != nil {
				if first {
					close(ready)
				}
				return
			}
		}
	}()
	select {
	case <-ready:
	case <-time.After(15 * time.Second):
		cmd.Process.Kill()
		t.Fatalf("%v never got ready: %s", argv, stderr.String())
	}
	if scenario != nil {
		scenario(local)
	}
	time.Sleep(100 * time.Millisecond)
	cmd.Process.Signal(syscall.SIGINT)
	// The reader finishes at the process's EOF before Wait closes the pipe (and before stdout is read).
	select {
	case <-readDone:
	case <-time.After(15 * time.Second):
		cmd.Process.Kill()
		<-readDone
	}
	err := cmd.Wait()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	}
	return fwdRun{stdout: stdout.String(), stderr: stderr.String(), code: code}
}

func fwdNormalize(s string, local int) string {
	if local != 0 {
		s = strings.ReplaceAll(s, fmt.Sprint(local), "LOCAL")
	}
	return regexp.MustCompile(`127\.0\.0\.1:\d+/termag`).ReplaceAllString(s, "HOST/termag")
}

func TestForwardNodeAndGoAgree(t *testing.T) {
	node := fwdNodeCLI(t)
	goBin := []string{fwdGoBinary(t)}
	payload := make([]byte, 2<<20)
	rand.Read(payload)
	sum := sha256.Sum256(payload)
	echo := func(t *testing.T) func(int) {
		return func(local int) {
			got := fwdEcho(t, local, "127.0.0.1", payload)
			if sha256.Sum256(got) != sum {
				t.Errorf("echo through the forward: %d bytes, sha differs", len(got))
			}
		}
	}
	scenarios := []struct {
		name  string
		json  bool
		setup func(f *fwdFake)
		run   func(t *testing.T) func(int)
	}{
		{"echo", false, nil, echo},
		{"echo --json", true, nil, echo},
		{"v1-only orchestrator", true, func(f *fwdFake) { f.v1Only = true }, echo},
		{"retry once on 1012", false, func(f *fwdFake) { f.queue[3000] = []string{"closeAfterOpen:1012"} }, echo},
		{"port_refused notice", false, func(f *fwdFake) {
			f.queue[3000] = []string{"refuse:403:port_refused:the box says no", "refuse:403:port_refused:the box says no"}
		}, func(t *testing.T) func(int) {
			return func(local int) {
				fwdEcho(t, local, "127.0.0.1", []byte("x"))
				fwdEcho(t, local, "127.0.0.1", []byte("x"))
			}
		}},
		{"a dropped connection", false, func(f *fwdFake) { f.queue[3000] = []string{"closeAfterOpen:1011"} }, func(t *testing.T) func(int) {
			return func(local int) { fwdEcho(t, local, "127.0.0.1", []byte("x")) }
		}},
	}
	for _, sc := range scenarios {
		t.Run(sc.name, func(t *testing.T) {
			var runs [2]fwdRun
			for i, argv := range [][]string{node, goBin} {
				f := fwdNewFake(t)
				if sc.setup != nil {
					sc.setup(f)
				}
				local := fwdFreePort(t)
				r := fwdRunCLI(t, argv, f, local, sc.json, sc.run(t))
				r.stdout, r.stderr = fwdNormalize(r.stdout, local), fwdNormalize(r.stderr, local)
				runs[i] = r
				if strings.Contains(sc.name, "v1") {
					for _, c := range f.snapshot() {
						if c.protocol != fwdSubprotocolV1 || len(c.stray) > 0 {
							t.Errorf("%s: %+v", argv[0], c)
						}
					}
				}
			}
			if os.Getenv("FWD_SHOW") != "" {
				t.Logf("node:\n%s%s(exit %d)", runs[0].stdout, runs[0].stderr, runs[0].code)
			}
			if runs[0] != runs[1] {
				t.Errorf("Node and Go differ:\n--- node (exit %d)\n%s%s\n--- go (exit %d)\n%s%s", runs[0].code, runs[0].stdout, runs[0].stderr, runs[1].code, runs[1].stdout, runs[1].stderr)
			}
		})
	}
	// Probe refusals and argument errors: no listener, one line on stderr.
	for _, tc := range []struct {
		name  string
		probe string
		args  []string
	}{
		{"probe not_found", `404 {"error":"nope","code":"not_found"}`, []string{"forward", "devbox", "3000:23000", "3001:23001"}},
		{"probe forbidden --json", `403 {"error":"no","code":"forbidden"}`, []string{"forward", "devbox", "3000:23000", "--json"}},
		{"no ports", "", []string{"forward", "devbox"}},
		{"bad spec", "", []string{"forward", "devbox", "80"}},
		{"unknown box", "", []string{"forward", "nobox", "3000:23000"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var outs [2]string
			for i, argv := range [][]string{node, goBin} {
				f := fwdNewFake(t)
				if tc.probe != "" {
					var st int
					fmt.Sscanf(tc.probe, "%d", &st)
					f.probe.status, f.probe.body = st, tc.probe[4:]
				}
				home, xdg := fwdLoginHome(t, f)
				cmd := exec.Command(argv[0], append(append([]string{}, argv[1:]...), tc.args...)...)
				cmd.Env = []string{"HOME=" + home, "XDG_CONFIG_HOME=" + xdg, "PATH=" + os.Getenv("PATH"), "TERMAG_URL=" + f.host(), "TERMAG_TELEMETRY=0", "TERMAG_AGENT_CONFIG=" + filepath.Join(home, "none.json")}
				var o, e bytes.Buffer
				cmd.Stdout, cmd.Stderr = &o, &e
				err := cmd.Run()
				code := 0
				if ee, ok := err.(*exec.ExitError); ok {
					code = ee.ExitCode()
				}
				outs[i] = fmt.Sprintf("exit %d\n%s--\n%s", code, o.String(), fwdNormalize(e.String(), 0))
			}
			if outs[0] != outs[1] {
				t.Errorf("Node and Go differ:\n--- node\n%s\n--- go\n%s", outs[0], outs[1])
			}
		})
	}
}

// Connections opened under a sign-in a later login replaced are marked stranded for their close's
// notice; a close consumes the mark, so closed sockets don't stay in the renewer's memory.
func TestForwardRenewerForgetsStrandedConnectionsOnClose(t *testing.T) {
	newSignIn := fwdJWT("new-sign-in", 1)
	r := fwdNewRenewer(func(context.Context, string, time.Duration) (string, error) { return newSignIn, nil },
		time.Hour, time.Hour, nil, nil)
	defer r.stop()
	const n = 100
	conns := make([]*websocket.Conn, n)
	for i := range conns {
		conns[i] = new(websocket.Conn)
		r.add(conns[i], fwdJWT("old-sign-in", i), func() bool { return true }, nil)
	}
	r.ask()
	r.mu.Lock()
	marked := len(r.stranded)
	r.mu.Unlock()
	if marked != n {
		t.Fatalf("%d of %d old-sign-in connections marked stranded", marked, n)
	}
	for i, ws := range conns {
		if !r.remove(ws) {
			t.Errorf("connection %d: remove did not report it stranded", i)
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.stranded) != 0 || len(r.held) != 0 {
		t.Errorf("after the closes: %d stranded, %d held", len(r.stranded), len(r.held))
	}
}

// Accept failing over and over (out of file descriptors) backs off instead of spinning.
type fwdFailingListener struct {
	net.Listener
	calls atomic.Int32
}

func (l *fwdFailingListener) Accept() (net.Conn, error) {
	l.calls.Add(1)
	return nil, errors.New("accept: too many open files")
}

func TestForwardAcceptErrorsBackOff(t *testing.T) {
	inner, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer inner.Close()
	ln := &fwdFailingListener{Listener: inner}
	f := &fwdForwarder{live: map[*fwdConn]bool{}, shown: map[string]bool{}}
	f.opts.notify = func(string) {}
	f.wg.Add(1)
	go f.acceptLoop(nil, ln, fwdListening{Local: 1})
	time.Sleep(300 * time.Millisecond)
	f.mu.Lock()
	f.stopping = true
	f.mu.Unlock()
	f.wg.Wait()
	if n := ln.calls.Load(); n > 20 {
		t.Errorf("%d accepts in 300 ms: it spins", n)
	}
}

// A stalled local reader while keepalives fire: the box side sends more than the TCP buffers hold
// (but under the queue's high-water mark), then pings the CLI, while the local reader reads
// nothing. The pong must still come back (the socket keeps being read), the CLI's own pings must
// be answered, and once the reader catches up every byte arrives: the connection is neither
// dropped nor wedged. Before, the WebSocket read sat behind the blocked TCP write, so the box's
// ping went unanswered until the local side read.
func TestForwardKeepaliveSurvivesAStalledLocalReader(t *testing.T) {
	const payload = 768 << 10 // over the shrunk TCP buffers, under fwdDownHigh
	pongs := make(chan error, 1)
	srv := httptestNewWSServer(t, func(ws *websocket.Conn) {
		ctx := context.Background()
		// A pong reaches Ping only through a concurrent Read (coder/websocket); this one also
		// answers the CLI's pings and sees its close.
		readDone := make(chan struct{})
		go func() {
			defer close(readDone)
			for {
				if _, _, err := ws.Read(ctx); err != nil {
					return
				}
			}
		}()
		chunk := bytes.Repeat([]byte{7}, 16<<10)
		for sent := 0; sent < payload; sent += len(chunk) {
			if ws.Write(ctx, websocket.MessageBinary, chunk) != nil {
				return
			}
		}
		pctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		pongs <- ws.Ping(pctx) // the CLI answers while its local reader reads nothing
		cancel()
		_ = ws.Write(ctx, websocket.MessageText, []byte(fwdFin))
		<-readDone
	})
	ws, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	ws.SetReadLimit(4 << 20)

	// The local connection: the forwarder's end with a small send buffer, the reader's with a small
	// receive buffer, so the kernel holds far less than the payload.
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	reader, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	reader.(*net.TCPConn).SetReadBuffer(16 << 10)
	accepted, _ := ln.Accept()
	local := accepted.(*net.TCPConn)
	local.SetWriteBuffer(16 << 10)

	p := fwdStartPipe(local, ws, fwdPipeOpts{pingEvery: 50 * time.Millisecond})
	select {
	case err := <-pongs:
		if err != nil {
			t.Fatalf("the box's ping went unanswered while the local reader stalled: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no ping result")
	}
	time.Sleep(200 * time.Millisecond) // the CLI's own pings fire meanwhile
	// A deadline, so a regression in delivery fails here instead of hanging the test.
	reader.SetReadDeadline(time.Now().Add(10 * time.Second))
	got, _ := io.Copy(io.Discard, reader)
	if got != payload {
		t.Errorf("the local reader got %d of %d bytes", got, payload)
	}
	reader.Close()
	select {
	case res := <-p.Done():
		if res.Down != payload {
			t.Errorf("down %d, want %d", res.Down, payload)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the pipe never finished: wedged")
	}
}

// httptestNewWSServer serves one WebSocket handler and returns its http:// URL.
func httptestNewWSServer(t *testing.T, handle func(*websocket.Conn)) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
		if err != nil {
			return
		}
		handle(ws)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// The remote end closes (a deploy's 1012, a box restart) while the local reader is stalled and
// bytes are still queued for it: the forward must not wait on the blocked local write. As Node's
// resetAndDestroy on any code but 1000, the queue is dropped and the local socket reset at once.
func TestForwardRemoteCloseWithAStalledLocalReaderTearsDown(t *testing.T) {
	const payload = 768 << 10 // over the shrunk TCP buffers, under fwdDownHigh
	srv := httptestNewWSServer(t, func(ws *websocket.Conn) {
		ctx := context.Background()
		chunk := bytes.Repeat([]byte{7}, 16<<10)
		for sent := 0; sent < payload; sent += len(chunk) {
			if ws.Write(ctx, websocket.MessageBinary, chunk) != nil {
				return
			}
		}
		ws.Close(websocket.StatusCode(1012), "draining")
	})
	ws := fwdDialTest(t, srv)
	// On macOS this failed (the reader never saw the end) while the reset closed the socket under
	// the writer's blocked write; the write is now cut short before the reset.
	local, reader := fwdLocalPair(t)

	start := time.Now()
	p := fwdStartPipe(local, ws, fwdPipeOpts{pingEvery: time.Second})
	select {
	case res := <-p.Done():
		if took := time.Since(start); took > time.Second {
			t.Errorf("teardown took %v", took)
		}
		if res.Code != 1012 || res.ClosedBy != "remote" || res.Untouched {
			t.Errorf("result %+v", res)
		}
	case <-time.After(fwdStopGrace + 5*time.Second):
		t.Fatal("the forward hung on the blocked local write after the remote close")
	}
	// The local side was let go: the forward closed its end, and (on Linux) the reader sees the
	// reset. macOS CI's reader can miss a reset sent while segments are still in flight to it,
	// as here within milliseconds of the upgrade (Node's resetAndDestroy sends it at the same
	// moment), so there only the forward's own end is checked.
	if err := local.SetReadDeadline(time.Now()); !errors.Is(err, net.ErrClosed) {
		t.Errorf("the forward kept its end of the local socket open (%v)", err)
	}
	if runtime.GOOS == "linux" {
		reader.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, err := io.Copy(io.Discard, reader)
		if ne, ok := err.(net.Error); ok && ne.Timeout() {
			t.Error("the reader never saw the reset")
		}
	}
}

// fwdLocalPair: the forwarder's end of a local connection with a small send buffer, and the
// reader's with a small receive buffer, so the kernel holds far less than the tests' payloads. The
// sizes are set before the handshake: a receive buffer shrunk after it leaves the advertised window
// stuck shut once the reader has stalled a while, and the stream waits on zero-window probes.
func fwdLocalPair(t *testing.T) (local *net.TCPConn, reader *net.TCPConn) {
	t.Helper()
	sockopt := func(opt int) func(string, string, syscall.RawConn) error {
		return func(_, _ string, c syscall.RawConn) error {
			var serr error
			if err := c.Control(func(fd uintptr) { serr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, opt, 16<<10) }); err != nil {
				return err
			}
			return serr
		}
	}
	ln, err := (&net.ListenConfig{Control: sockopt(syscall.SO_SNDBUF)}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	c, err := (&net.Dialer{Control: sockopt(syscall.SO_RCVBUF)}).Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	reader = c.(*net.TCPConn)
	t.Cleanup(func() { reader.Close() })
	accepted, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	return accepted.(*net.TCPConn), reader
}

func fwdDialTest(t *testing.T, srv string) *websocket.Conn {
	t.Helper()
	ws, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	ws.SetReadLimit(4 << 20)
	return ws
}

// A box closes with 1000 while a slow local reader, one still reading, is behind: every queued byte
// reaches it and the connection ends with a FIN, as Node's socket.end() does. Before, the flush after
// the close gave each TCP write 2 s, and a 192 KiB write to a reader taking 48 KiB/s timed out, so
// the rest was dropped and the connection reset.
func TestForwardSlowReaderGetsEveryByteAfterANormalClose(t *testing.T) {
	const frame, payload = 192 << 10, 384 << 10
	srv := httptestNewWSServer(t, func(ws *websocket.Conn) {
		ctx := context.Background()
		for sent := 0; sent < payload; sent += frame {
			if ws.Write(ctx, websocket.MessageBinary, bytes.Repeat([]byte{9}, frame)) != nil {
				return
			}
		}
		ws.Close(websocket.StatusNormalClosure, "")
	})
	local, reader := fwdLocalPair(t)
	p := fwdStartPipe(local, fwdDialTest(t, srv), fwdPipeOpts{pingEvery: time.Second})
	reader.SetReadDeadline(time.Now().Add(30 * time.Second))
	buf := make([]byte, 12<<10)
	got := 0
	var err error
	for {
		var n int
		n, err = reader.Read(buf)
		got += n
		if err != nil {
			break
		}
		time.Sleep(250 * time.Millisecond) // about 48 KiB/s
	}
	if got != payload || err != io.EOF {
		t.Fatalf("the slow reader got %d of %d bytes, then %v (want EOF)", got, payload, err)
	}
	select {
	case res := <-p.Done():
		if res.Code != fwdCloseNormal || res.Down != payload {
			t.Errorf("result %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the pipe never finished")
	}
}

// A box closes with 1000 while the local reader reads nothing at all: the flush ends once it has
// taken no byte for fwdFlushStall, the rest is dropped and the local socket reset, and the pipe
// settles rather than holding the connection forever.
func TestForwardNormalCloseWithAStalledReaderEndsAfterTheStall(t *testing.T) {
	old := fwdFlushStall
	fwdFlushStall = 500 * time.Millisecond
	t.Cleanup(func() { fwdFlushStall = old })
	const payload = 768 << 10
	srv := httptestNewWSServer(t, func(ws *websocket.Conn) {
		ctx := context.Background()
		chunk := bytes.Repeat([]byte{7}, 16<<10)
		for sent := 0; sent < payload; sent += len(chunk) {
			if ws.Write(ctx, websocket.MessageBinary, chunk) != nil {
				return
			}
		}
		ws.Close(websocket.StatusNormalClosure, "")
	})
	local, reader := fwdLocalPair(t)
	p := fwdStartPipe(local, fwdDialTest(t, srv), fwdPipeOpts{pingEvery: time.Second})
	select {
	case res := <-p.Done():
		if res.Code != fwdCloseNormal || res.ClosedBy != "remote" {
			t.Errorf("result %+v", res)
		}
	case <-time.After(fwdFlushStall + 5*time.Second):
		t.Fatal("the flush after a 1000 close never gave up on a reader that reads nothing")
	}
	reader.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, err := io.Copy(io.Discard, reader)
	if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Error("the local socket was left open")
	}
}

// Bugbot's "a paused queue drops keepalives", checked against the orchestrator's rule
// (agentTunnels.ts tunnelHeartbeat): a peer that pings is cut once a heartbeat interval passes
// with no ping, message or pong from it. The box sends 3 MiB while the local reader reads
// nothing, so the queue passes fwdDownHigh and downstream stops reading the socket (as Node's
// ws.pause() does); over several intervals the CLI's own pings must keep the tunnel alive, and
// once the reader catches up every byte arrives. With the pinger off, this test fails.
func TestForwardPausedQueueKeepsTheTunnelAlive(t *testing.T) {
	const frame, payload = 64 << 10, 3 << 20
	const interval = 300 * time.Millisecond
	var alive, terminated atomic.Bool
	alive.Store(true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			CompressionMode: websocket.CompressionDisabled,
			// Heard, not answered: a coder/websocket pong waits for the write lock this handler's
			// blocked Write holds and fails the read after 5 s, where Node's ws queues it. The
			// heartbeat needs only the ping.
			OnPingReceived: func(context.Context, []byte) bool { alive.Store(true); return false },
		})
		if err != nil {
			return
		}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go func() { // the heartbeat
			tk := time.NewTicker(interval)
			defer tk.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-tk.C:
					if !alive.Swap(false) {
						terminated.Store(true)
						ws.CloseNow()
						return
					}
				}
			}
		}()
		go func() { // the CLI's frames and pings (OnPingReceived runs inside Read)
			for {
				if _, _, err := ws.Read(ctx); err != nil {
					cancel()
					return
				}
				alive.Store(true)
			}
		}()
		for sent := 0; sent < payload; sent += frame {
			if ws.Write(ctx, websocket.MessageBinary, bytes.Repeat([]byte{5}, frame)) != nil {
				return
			}
		}
		_ = ws.Write(ctx, websocket.MessageText, []byte(fwdFin))
		<-ctx.Done()
	}))
	t.Cleanup(srv.Close)
	local, reader := fwdLocalPair(t)
	p := fwdStartPipe(local, fwdDialTest(t, srv.URL), fwdPipeOpts{pingEvery: interval / 3})
	time.Sleep(6 * interval) // the local reader reads nothing
	p.mu.Lock()
	down := p.down
	p.mu.Unlock()
	if down >= payload {
		t.Fatalf("downstream read all %d bytes: the queue never paused, so this tests nothing", down)
	}
	if terminated.Load() {
		t.Fatal("the heartbeat cut the tunnel while the queue was paused")
	}
	reader.SetReadDeadline(time.Now().Add(20 * time.Second))
	got, _ := io.Copy(io.Discard, reader) // ends at the box's fin
	if got != payload {
		t.Errorf("the local reader got %d of %d bytes", got, payload)
	}
	if terminated.Load() {
		t.Error("the heartbeat cut the tunnel")
	}
	reader.Close()
	select {
	case <-p.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the pipe never finished")
	}
}

// Bugbot: a stop that lands as a dial opens. Before, the open socket was checked against the
// forward's stopping alone and then, a moment later, against the connection's context too; a
// cancel between the two returned without closing the socket, and the orchestrator held the
// tunnel until its heartbeat. Now one check covers both, and the socket is closed with 1000.
func TestForwardStopAsADialOpensClosesTheSocket(t *testing.T) {
	f := fwdNewFake(t)
	hook := func(fc *fwdConn) { fc.cancel() } // the connection's context ends as the socket opens
	fwdAfterDial.Store(&hook)
	t.Cleanup(func() { fwdAfterDial.Store(nil) })
	a := fwdFreePort(t)
	fwdStartIn(t, f, []string{fmt.Sprintf("3000:%d", a)}, nil)
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", a))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fwdUntil(t, func() bool {
		conns := f.snapshot()
		return len(conns) == 1 && conns[0].closeCode != 0
	})
	if conns := f.snapshot(); conns[0].closeCode != fwdCloseNormal {
		t.Errorf("the socket closed with %d, want 1000", conns[0].closeCode)
	}
}

// Bugbot: "1012 retry races with first send". A draining orchestrator's 1012 that comes with the
// upgrade, and a local client that has sent its request before the pipe starts (the worst case for
// the 3 ms hold): over many connections, every one is handed back untouched with the whole request
// pending for the redial, and the box never gets a byte. Before the read side marked the close
// ahead of releasing the hold this held too, because of the invariant the next test pins.
func TestForwardA1012WithTheUpgradeLeavesAnEagerClientUntouched(t *testing.T) {
	var frames atomic.Int64
	srv := httptestNewWSServer(t, func(ws *websocket.Conn) {
		go func() {
			for {
				if typ, _, err := ws.Read(context.Background()); err != nil {
					return
				} else if typ == websocket.MessageBinary {
					frames.Add(1)
				}
			}
		}()
		ws.Close(websocket.StatusCode(fwdCloseDraining), "draining")
	})
	request := []byte("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
	for i := 0; i < 200; i++ {
		local, client := fwdLocalPair(t)
		if _, err := client.Write(request); err != nil {
			t.Fatal(err)
		}
		p := fwdStartPipe(local, fwdDialTest(t, srv), fwdPipeOpts{pingEvery: time.Second,
			keepIfUntouched: func(code int) bool { return code == fwdCloseDraining }})
		select {
		case res := <-p.Done():
			// What the redial sends: the bytes the pipe read and kept, then whatever it never
			// read off the socket.
			unread, n := make([]byte, 4096), 0
			if len(res.Pending) < len(request) {
				local.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
				n, _ = local.Read(unread)
			}
			if !res.Untouched || res.Up != 0 || string(res.Pending)+string(unread[:n]) != string(request) {
				t.Fatalf("connection %d: untouched %v, up %d, pending %q + unread %q (code %d)", i, res.Untouched, res.Up, res.Pending, unread[:n], res.Code)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("connection %d: the pipe never finished", i)
		}
		local.Close()
		client.Close()
	}
	if n := frames.Load(); n != 0 {
		t.Errorf("the box got %d data frames", n)
	}
}

// The invariant under the pipe's first send: once Read has returned the peer's close,
// coder/websocket has answered it and refuses any write, so no byte can follow the close.
func TestForwardNoWriteGoesOutAfterAReadClose(t *testing.T) {
	got := make(chan int, 1)
	srv := httptestNewWSServer(t, func(ws *websocket.Conn) {
		n := 0
		go func() { time.Sleep(2 * time.Second); ws.CloseNow() }()
		ws.Close(websocket.StatusCode(fwdCloseDraining), "draining")
		// Close read up to the client's answer; anything after it would be here.
		for {
			if typ, _, err := ws.Read(context.Background()); err != nil {
				break
			} else if typ == websocket.MessageBinary {
				n++
			}
		}
		got <- n
	})
	ws := fwdDialTest(t, srv)
	if _, _, err := ws.Read(context.Background()); websocket.CloseStatus(err) != fwdCloseDraining {
		t.Fatalf("read %v, want the 1012", err)
	}
	if err := ws.Write(context.Background(), websocket.MessageBinary, []byte("late")); err == nil {
		t.Error("a write after the read close succeeded")
	}
	if n := <-got; n != 0 {
		t.Errorf("the server got %d frames after its close", n)
	}
}
