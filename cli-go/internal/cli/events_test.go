package cli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A fake orchestrator for `termag events` (cli/src/test/fakeStatus.ts and the /boxes route): the
// box list, and a status socket whose answer to each dial a test scripts.

const evToken = "tmag_eventsfaketoken0123456789"

// evDial is what the fake does with one dial of the status socket.
type evDial struct {
	status int    // answer with this HTTP status instead of upgrading (with Location for a 3xx)
	body   string // its JSON body
	replay []any  // frames sent once upgraded
	close  int    // after the replay, close with this code (0: stay open; -1: drop the TCP connection)
	reason string // the close's reason
	quiet  bool   // send nothing at all, not even the replay (the stale case)
}

type evFake struct {
	t      *testing.T
	srv    *httptest.Server
	mu     sync.Mutex
	boxes  []map[string]any
	boxErr []int // statuses /boxes answers before it works
	dials  []evDial
	dialN  int
	conns  []*websocket.Conn
	auths  []string
	hosts  []string // the Host of every request: a proxied one names the orchestrator, not the fake
}

func newEvFake(t *testing.T) *evFake {
	f := &evFake{t: t}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(func() {
		f.mu.Lock()
		for _, c := range f.conns {
			c.CloseNow()
		}
		f.mu.Unlock()
		f.srv.Close()
	})
	return f
}

func (f *evFake) serve(w http.ResponseWriter, r *http.Request) {
	auth := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	f.mu.Lock()
	f.hosts = append(f.hosts, r.Host)
	f.mu.Unlock()
	switch r.URL.Path {
	case "/termag/api/cli/v1/boxes":
		f.mu.Lock()
		var st int
		if len(f.boxErr) > 0 {
			st, f.boxErr = f.boxErr[0], f.boxErr[1:]
		}
		body, _ := json.Marshal(map[string]any{"boxes": f.boxes})
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if auth != evToken {
			w.WriteHeader(401)
			w.Write([]byte(`{"error":"Unknown token"}`))
			return
		}
		if st != 0 {
			w.WriteHeader(st)
			w.Write([]byte(fmt.Sprintf(`{"error":"box list down (%d)"}`, st)))
			return
		}
		w.Write(body)
	case "/termag/api/cli/v1/ws/status":
		f.mu.Lock()
		f.auths = append(f.auths, auth)
		d := evDial{}
		if f.dialN < len(f.dials) {
			d = f.dials[f.dialN]
		}
		f.dialN++
		f.mu.Unlock()
		if d.status != 0 {
			if d.status >= 300 && d.status < 400 {
				w.Header().Set("Location", "https://login.example/oauth")
			}
			if d.body != "" {
				w.Header().Set("Content-Type", "application/json")
			}
			w.WriteHeader(d.status)
			w.Write([]byte(d.body))
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		f.mu.Lock()
		f.conns = append(f.conns, c)
		f.mu.Unlock()
		if !d.quiet {
			for _, fr := range d.replay {
				b, _ := json.Marshal(fr)
				c.Write(context.Background(), websocket.MessageText, b)
			}
		}
		switch {
		case d.close > 0:
			time.Sleep(50 * time.Millisecond)
			c.Close(websocket.StatusCode(d.close), d.reason)
		case d.close < 0:
			time.Sleep(50 * time.Millisecond)
			c.CloseNow()
		default:
			go func() { // keep reading so pings and the client's close are answered
				for {
					if _, _, err := c.Read(context.Background()); err != nil {
						return
					}
				}
			}()
		}
	default:
		w.WriteHeader(404)
	}
}

// push sends a frame to every open socket.
func (f *evFake) push(frame any) {
	b, _ := json.Marshal(frame)
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.conns {
		c.Write(context.Background(), websocket.MessageText, b)
	}
}

func (f *evFake) setBoxes(boxes []map[string]any) {
	f.mu.Lock()
	f.boxes = boxes
	f.mu.Unlock()
}

func (f *evFake) home(t *testing.T) string {
	home := t.TempDir()
	cfg := fmt.Sprintf(`{"termag_url":"ws%s/termag/ws/agent","token":"%s"}`, strings.TrimPrefix(f.srv.URL, "http"), evToken)
	if err := os.WriteFile(filepath.Join(home, "agent.config.json"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

func evBoxJSON(id, name, state string, agent bool, errText any) map[string]any {
	return map[string]any{"id": id, "name": name, "addressable": true, "kind": "ec2", "state": state, "status": state,
		"agentConnected": agent, "error": errText, "projects": []any{}}
}

func evStatus(session, instance, status string, extra map[string]any) map[string]any {
	m := map[string]any{"type": "status", "session": session, "status": status}
	if instance != "" {
		m["instanceId"] = instance
	}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

// evProc is one CLI process running `events`, its output read as it comes.
type evProc struct {
	cmd  *exec.Cmd
	mu   sync.Mutex
	out  bytes.Buffer
	errb bytes.Buffer
	done chan struct{}
	code int
}

func evStart(t *testing.T, argv []string, home string, args ...string) *evProc {
	cmd := exec.Command(argv[0], append(argv[1:], args...)...)
	cmd.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH"), "TERMAG_TELEMETRY=0", "TERMAG_AGENT_CONFIG=" + filepath.Join(home, "agent.config.json")}
	p := &evProc{cmd: cmd, done: make(chan struct{})}
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	copyTo := func(r interface{ Read([]byte) (int, error) }, b *bytes.Buffer) {
		defer wg.Done()
		sc := bufio.NewReader(r)
		for {
			line, err := sc.ReadString('\n')
			if line != "" {
				p.mu.Lock()
				b.WriteString(line)
				p.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}
	wg.Add(2)
	go copyTo(stdout, &p.out)
	go copyTo(stderr, &p.errb)
	go func() {
		wg.Wait()
		err := cmd.Wait()
		if ee, ok := err.(*exec.ExitError); ok {
			p.code = ee.ExitCode()
		}
		close(p.done)
	}()
	t.Cleanup(func() { cmd.Process.Kill(); <-p.done })
	return p
}

// waitFor waits until stdout has n lines and stderr contains want (when given), or the process ends.
func (p *evProc) waitFor(t *testing.T, n int, want string) {
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		p.mu.Lock()
		lines := strings.Count(p.out.String(), "\n")
		errs := p.errb.String()
		p.mu.Unlock()
		if lines >= n && (want == "" || strings.Contains(errs, want)) {
			return
		}
		select {
		case <-p.done:
			return
		case <-time.After(20 * time.Millisecond):
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	t.Fatalf("timed out waiting for %d lines and %q; stdout:\n%s\nstderr:\n%s", n, want, p.out.String(), p.errb.String())
}

// stop sends SIGINT (unless the process already ended) and returns its output.
func (p *evProc) stop(t *testing.T) (string, string, int) {
	select {
	case <-p.done:
	default:
		p.cmd.Process.Signal(syscall.SIGINT)
		select {
		case <-p.done:
		case <-time.After(10 * time.Second):
			t.Fatal("did not stop on SIGINT")
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.out.String(), p.errb.String(), p.code
}

var evTimeRE = regexp.MustCompile(`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z`)
var evPortRE = regexp.MustCompile(`127\.0\.0\.1:\d+`)

// evMask hides the times the CLIs stamp (`at`), but keeps the server's own (stoppedAt) when they are fixed.
func evMask(s string) string {
	s = strings.ReplaceAll(s, "2026-11-11T17:38:09.000Z", "<STOPPED>")
	return evPortRE.ReplaceAllString(evTimeRE.ReplaceAllString(s, "<at>"), "127.0.0.1:<port>")
}

type evScenario struct {
	name  string
	json  bool
	setup func(f *evFake)
	// drive pokes the fake while the CLI runs; nil just waits for the replay.
	drive func(t *testing.T, f *evFake, p *evProc)
	// ends: the CLI exits by itself (a fatal close); no SIGINT.
	ends bool
	// dials, when set, is how many socket dials the scenario must see.
	dials int
}

func evBoxes2() []map[string]any {
	return []map[string]any{evBoxJSON("b1", "devbox", "running", true, nil), evBoxJSON("b2", "spare", "running", false, nil)}
}

func evReplay() []any {
	return []any{
		evStatus("bob-proj-agent", "b1", "working", nil),
		evStatus("bob-other-agent", "b1", "waiting", map[string]any{"waitingReason": "approval"}),
		evStatus("shared-agent", "elsewhere", "idle", map[string]any{"stoppedAt": "2026-11-11T17:38:09Z"}),
		evStatus("host-agent", "", "not_running", nil),
		map[string]any{"type": "heartbeat"},
		map[string]any{"no": "type"},
	}
}

func evScenarios() []evScenario {
	changes := func(t *testing.T, f *evFake, p *evProc) {
		p.waitFor(t, 6, "")
		f.push(evStatus("bob-proj-agent", "b1", "working", map[string]any{"contextTokens": 5})) // no change
		f.push(evStatus("bob-proj-agent", "b1", "waiting", map[string]any{"waitingReason": "user_input"}))
		f.push(evStatus("bob-other-agent", "b1", "waiting", map[string]any{"waitingReason": "unknown"}))
		p.waitFor(t, 8, "")
		f.setBoxes([]map[string]any{evBoxJSON("b1", "devbox", "stopping", false, nil), evBoxJSON("b3", "fresh", "failed", false, "no capacity")})
		f.push(map[string]any{"type": "workspace", "what": "boxes"})
		p.waitFor(t, 11, "")
		f.push(map[string]any{"type": "workspace", "what": "projects"})
		f.push(evStatus("new-agent", "b3", "working", nil))
		p.waitFor(t, 12, "")
	}
	return []evScenario{
		{name: "replay and changes", setup: func(f *evFake) { f.boxes = evBoxes2(); f.dials = []evDial{{replay: evReplay()}} }, drive: changes},
		{name: "replay and changes --json", json: true, setup: func(f *evFake) { f.boxes = evBoxes2(); f.dials = []evDial{{replay: evReplay()}} }, drive: changes},
		{name: "reconnect after HTTP 500, a 1012 and a 1000 with no frames", setup: func(f *evFake) {
			f.boxes = evBoxes2()
			f.dials = []evDial{
				{status: 500, body: `{"error":"boom"}`},
				{replay: evReplay()[:1], close: 1012, reason: "restarting"},
				{close: 1000},
				{close: -1},
				{replay: evReplay()[:2]},
			}
		}, drive: func(t *testing.T, f *evFake, p *evProc) {
			p.waitFor(t, 4, "")
			deadline := time.Now().Add(15 * time.Second)
			for time.Now().Before(deadline) {
				f.mu.Lock()
				n := f.dialN
				f.mu.Unlock()
				if n >= 5 {
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
			p.waitFor(t, 4, "connected again")
			time.Sleep(300 * time.Millisecond)
		}, dials: 5},
		{name: "4401 redials at once with a renewed token", setup: func(f *evFake) {
			f.boxes = evBoxes2()
			f.dials = []evDial{{replay: evReplay()[:1], close: 4401, reason: "access token expired"}, {replay: evReplay()[:2]}}
		}, drive: func(t *testing.T, f *evFake, p *evProc) { p.waitFor(t, 4, ""); time.Sleep(300 * time.Millisecond) }, dials: 2},
		{name: "1008 termag login is final (exit 4)", setup: func(f *evFake) {
			f.boxes = evBoxes2()
			f.dials = []evDial{{replay: evReplay()[:1], close: 1008, reason: "credential revoked; run `termag login`"}}
		}, ends: true},
		{name: "1008 unknown path is final (exit 1)", json: true, setup: func(f *evFake) {
			f.boxes = evBoxes2()
			f.dials = []evDial{{close: 1008, reason: "unknown path"}}
		}, ends: true},
		{name: "1008 other reason retries", setup: func(f *evFake) {
			f.boxes = evBoxes2()
			f.dials = []evDial{{close: 1008, reason: "policy says no"}, {replay: evReplay()[:1]}}
		}, drive: func(t *testing.T, f *evFake, p *evProc) { p.waitFor(t, 3, "connected again") }},
		{name: "401 twice ends with exit 4", setup: func(f *evFake) {
			f.boxes = evBoxes2()
			f.dials = []evDial{{status: 401}, {status: 401, body: `{"error":"nope"}`}}
		}, ends: true, dials: 2},
		{name: "403 then a good dial", setup: func(f *evFake) {
			f.boxes = evBoxes2()
			f.dials = []evDial{{status: 403}, {replay: evReplay()[:1]}}
		}, drive: func(t *testing.T, f *evFake, p *evProc) { p.waitFor(t, 3, ""); time.Sleep(200 * time.Millisecond) }},
		{name: "404 means no status socket (exit 1)", setup: func(f *evFake) {
			f.boxes = evBoxes2()
			f.dials = []evDial{{status: 404, body: `{"error":"Not found"}`}}
		}, ends: true},
		{name: "a 3xx is the edge (exit 1, --json)", json: true, setup: func(f *evFake) {
			f.boxes = evBoxes2()
			f.dials = []evDial{{status: 302}}
		}, ends: true},
		{name: "the box list fails, then works", setup: func(f *evFake) {
			f.boxes = evBoxes2()
			f.boxErr = []int{500, 503}
			f.dials = []evDial{{replay: evReplay()[:1]}}
		}, drive: func(t *testing.T, f *evFake, p *evProc) { p.waitFor(t, 3, "reading the box list again") }},
		{name: "the box list refuses the credential (exit 4)", setup: func(f *evFake) {
			f.boxes = evBoxes2()
			f.boxErr = []int{401}
		}, ends: true},
	}
}

func TestEventsMatchesNode(t *testing.T) {
	node, script := memoryNodeCLI(t)
	goBin := goBinary(t)
	for _, sc := range evScenarios() {
		sc := sc
		t.Run(sc.name, func(t *testing.T) {
			t.Parallel()
			var outs [2]string
			for i, argv := range [][]string{{node, script}, {goBin}} {
				f := newEvFake(t)
				sc.setup(f)
				args := []string{"events"}
				if sc.json {
					args = append(args, "--json")
				}
				p := evStart(t, argv, f.home(t), args...)
				if sc.drive != nil {
					sc.drive(t, f, p)
				} else if !sc.ends {
					p.waitFor(t, 2, "")
				}
				if sc.ends {
					select {
					case <-p.done:
					case <-time.After(20 * time.Second):
						t.Fatal("did not end by itself")
					}
				}
				out, errs, code := p.stop(t)
				outs[i] = fmt.Sprintf("exit %d\n-- stdout\n%s-- stderr\n%s", code, evMask(out), evMask(errs))
				if sc.dials != 0 && f.dialN != sc.dials {
					t.Errorf("%s: %d dials, want %d", argv[0], f.dialN, sc.dials)
				}
				for _, a := range f.auths {
					if a != evToken {
						t.Errorf("dialed with %q", a)
					}
				}
			}
			if os.Getenv("EV_SHOW") != "" {
				t.Logf("%s", outs[1])
			}
			if outs[0] != outs[1] {
				t.Errorf("Node and Go differ.\n== node\n%s\n== go\n%s", outs[0], outs[1])
			}
		})
	}
}

// `termag events | head -1` exits 0: the reader going away ends the stream.
func TestEventsEndsWhenTheReaderGoes(t *testing.T) {
	node, script := memoryNodeCLI(t)
	for _, argv := range [][]string{{node, script}, {goBinary(t)}} {
		f := newEvFake(t)
		f.boxes = evBoxes2()
		f.dials = []evDial{{replay: evReplay()}}
		home := f.home(t)
		cmd := exec.Command(argv[0], append(argv[1:], "events")...)
		cmd.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH"), "TERMAG_TELEMETRY=0", "TERMAG_AGENT_CONFIG=" + filepath.Join(home, "agent.config.json")}
		r, w, _ := os.Pipe()
		cmd.Stdout = w
		var errb bytes.Buffer
		cmd.Stderr = &errb
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		w.Close()
		line, _ := bufio.NewReader(r).ReadString('\n')
		r.Close() // head -1 exits
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		var err error
	loop:
		for i := 0; ; i++ {
			select {
			case err = <-done:
				break loop
			case <-time.After(200 * time.Millisecond):
				if i > 50 {
					cmd.Process.Kill()
					t.Fatalf("%s: still running after its reader went", argv[0])
				}
				f.push(evStatus(fmt.Sprintf("s%d", i), "b1", "working", nil)) // something to write
			}
		}
		if err != nil || errb.Len() != 0 || !strings.Contains(line, "box devbox: running") {
			t.Errorf("%s: %v, stderr %q, first line %q", argv[0], err, errb.String(), line)
		}
	}
}

// Go only (Node's 60 s can't be shortened from the outside): a quiet socket is dropped and dialed again.
func TestEventsRedialsAStaleSocket(t *testing.T) {
	oldStale, oldBackoff := evStale, evBackoff
	evStale, evBackoff = 300*time.Millisecond, []time.Duration{0, 10 * time.Millisecond}
	stopCh := make(chan struct{})
	evUntilInterrupted = func() <-chan struct{} { return stopCh }
	defer func() { evStale, evBackoff, evUntilInterrupted = oldStale, oldBackoff, nil }()

	f := newEvFake(t)
	f.boxes = evBoxes2()
	f.dials = []evDial{{quiet: true}, {replay: evReplay()[:1]}}
	c, _, _ := testCtx(t)
	out, errb := &evSafeBuf{}, &evSafeBuf{}
	c.Out, c.Err = LineWriter(out), LineWriter(errb)
	c.Home = f.home(t)
	c.Env["TERMAG_AGENT_CONFIG"] = filepath.Join(c.Home, "agent.config.json")
	codeCh := make(chan int, 1)
	go func() { codeCh <- Run([]string{"events", "--json"}, c) }()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(out.String(), `"session":"bob-proj-agent"`) {
		time.Sleep(20 * time.Millisecond)
	}
	close(stopCh)
	if code := <-codeCh; code != 0 {
		t.Fatalf("exit %d: %s", code, errb.String())
	}
	if f.dialN < 2 {
		t.Errorf("dials %d", f.dialN)
	}
	want := "termag events: lost the status socket (no word from the orchestrator in 0 s); reconnecting\ntermag events: connected again\n"
	if errb.String() != want {
		t.Errorf("stderr %q", errb.String())
	}
}

func TestEventsNextAfterClose(t *testing.T) {
	cases := []struct {
		code      int
		reason    string
		lastError string
		renewed   bool
		kind      string
		detail    string
	}{
		{1006, "", "Unexpected server response: 401", false, "renew", ""},
		{1006, "", "Unexpected server response: 403", true, "fatal", "auth_required"},
		{1006, "", "Unexpected server response: 307", false, "fatal", "edge_auth"},
		{1006, "", "Unexpected server response: 404", false, "fatal", "not_cli_enabled"},
		{1006, "", "Unexpected server response: 502", false, "retry", "HTTP 502"},
		{4401, "expired", "", false, "renew", ""},
		{1008, "Login required", "", false, "fatal", "auth_required"},
		{1008, "unknown path /x", "", false, "fatal", "not_cli_enabled"},
		{1008, "other", "", false, "retry", "other"},
		{1000, "", "", false, "retry", "closed (1000)"},
		{1006, "", "connect ECONNREFUSED 127.0.0.1:1", false, "retry", "connect ECONNREFUSED 127.0.0.1:1"},
	}
	for _, tc := range cases {
		n := evNextAfterClose(tc.code, tc.reason, tc.lastError, tc.renewed)
		got := n.reason
		if n.err != nil {
			got = n.err.Code
		}
		if n.kind != tc.kind || got != tc.detail {
			t.Errorf("%d %q %q: %s %q", tc.code, tc.reason, tc.lastError, n.kind, got)
		}
	}
}

// HTTP_PROXY is honoured by the box list and by the status socket's dial (rollout decision
// 2026-11-12): the fake plays the proxy, so it sees requests for a host that doesn't exist.
func TestEventsDialsThroughTheProxy(t *testing.T) {
	stopCh := make(chan struct{})
	evUntilInterrupted = func() <-chan struct{} { return stopCh }
	defer func() { evUntilInterrupted = nil }()
	f := newEvFake(t)
	f.boxes = evBoxes2()
	f.dials = []evDial{{replay: evReplay()[:1]}}
	t.Setenv("HTTP_PROXY", f.srv.URL)
	t.Setenv("NO_PROXY", "")
	c, _, _ := testCtx(t)
	out, errb := &evSafeBuf{}, &evSafeBuf{}
	c.Out, c.Err = LineWriter(out), LineWriter(errb)
	cfg := filepath.Join(c.Home, "agent.config.json")
	os.WriteFile(cfg, []byte(`{"termag_url":"ws://orchestrator.invalid/termag/ws/agent","token":"`+evToken+`"}`), 0o600)
	c.Env["TERMAG_AGENT_CONFIG"] = cfg
	codeCh := make(chan int, 1)
	go func() { codeCh <- Run([]string{"events"}, c) }()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(out.String(), "session bob-proj-agent") {
		time.Sleep(20 * time.Millisecond)
	}
	close(stopCh)
	if code := <-codeCh; code != 0 {
		t.Fatalf("exit %d: %s", code, errb.String())
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dialN != 1 || len(f.hosts) < 2 {
		t.Fatalf("dials %d, requests %v", f.dialN, f.hosts)
	}
	for _, h := range f.hosts {
		if h != "orchestrator.invalid" {
			t.Errorf("a request for %q did not go through the proxy", h)
		}
	}
}

// evSafeBuf is a buffer the CLI writes while the test reads it.
type evSafeBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *evSafeBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}
func (s *evSafeBuf) String() string { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }
