package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

// `termag forward` (forward/command.ts, forwarder.ts, dial.ts, probe.ts, holder.ts): loopback
// listeners on this machine, each accepted connection relayed over its own WebSocket through the
// orchestrator to a port on a box. Both subprotocols are offered, v2 first, and v1 stays
// supported (rollout decision 2026-11-12). The dial honours HTTP(S)_PROXY (wsdial.go).

func init() { register("forward", cmdForward) }

const (
	fwdSubprotocolV1 = "termag-forward.v1"
	fwdSubprotocolV2 = "termag-forward.v2"
	fwdCapability    = "port-forward-v1"
	fwdStopGrace     = 2 * time.Second
)

// fwdListenHosts: loopback only, both families; never a wildcard address.
var fwdListenHosts = []string{"127.0.0.1", "::1"}

// fwdUntilInterrupted blocks until the person asks the forward to stop (tests replace it).
var fwdUntilInterrupted = func() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	<-ch
	// Once stopping, a second signal ends the process at once, as Node's removed handlers do.
	signal.Reset(syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
}

// fwdExec runs a program for its output (lsof); tests replace it.
var fwdExec = func(name string, args ...string) (string, int) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return string(out), ee.ExitCode()
		}
		return "", 127
	}
	return string(out), 0
}

var fwdLsofOdd = regexp.MustCompile(`[^\x21-\x7e]`)
var fwdPidRE = regexp.MustCompile(`^\d+$`)

// fwdPortHolder: who listens on a local TCP port, from lsof, e.g. `node (pid 4242, user alice)`.
func fwdPortHolder(port int) string {
	out, code := fwdExec("lsof", "-nP", fmt.Sprintf("-iTCP:%d", port), "-sTCP:LISTEN")
	if code != 0 {
		return ""
	}
	var order []string
	holders := map[string]string{}
	lines := strings.Split(out, "\n")
	for _, line := range lines[1:] {
		f := strings.Fields(line)
		if len(f) < 2 || !fwdPidRE.MatchString(f[1]) {
			continue
		}
		name := fwdLsofOdd.ReplaceAllString(f[0], "?")
		if len(name) > 40 {
			name = name[:40]
		}
		user := ""
		if len(f) > 2 {
			user = ", user " + f[2]
		}
		if _, seen := holders[f[1]]; !seen {
			order = append(order, f[1])
		}
		holders[f[1]] = fmt.Sprintf("%s (pid %s%s)", name, f[1], user)
	}
	var parts []string
	for _, pid := range order {
		parts = append(parts, holders[pid])
	}
	return strings.Join(parts, ", ")
}

// ---- probe ----

type fwdProbe struct {
	OK       bool
	Code     string
	Status   int
	Message  string
	Fallback string
}

// fwdProbeForward asks whether the orchestrator would forward to this box, before any listener
// is bound. One retry while it drains.
func fwdProbeForward(api *Api, box *ConnectBox, ports []fwdPort, retryDelay time.Duration) (fwdProbe, error) {
	for attempt := 0; ; attempt++ {
		err := api.Request(context.Background(), "GET", "/boxes/"+enc(box.ID)+"/forward", nil, nil)
		if err == nil {
			return fwdProbe{OK: true}, nil
		}
		ce, ok := err.(*CliError)
		if !ok || ce.Status == 0 || ce.Status == 401 || ce.Code == "edge_auth" || ce.Code == "not_cli_enabled" || ce.Code == "unreachable" {
			return fwdProbe{}, err
		}
		code := ce.BodyString("code")
		if code == "" {
			code = "failed"
			if ce.Status == 404 {
				code = "not_found"
			}
		}
		if fwdRetryCodes[code] && attempt == 0 {
			time.Sleep(retryDelay)
			continue
		}
		p := fwdProbe{Code: code, Status: ce.Status, Message: fwdDescribeRefusal(code, box.Name, api.Host, 0, ce.BodyString("error"))}
		if fwdSuggestsSSH(code) {
			p.Fallback = fwdSSHFallback(box.Name, ports)
		}
		return p, nil
	}
}

// ---- dial ----

type fwdDialOutcome struct {
	kind   string // open, refused, failed
	ws     *websocket.Conn
	status int
	code   string
	errMsg string
	reason string
}

func fwdForwardURL(host, boxID string, port int) string {
	return wsURL(host, fmt.Sprintf("/boxes/%s/forward/%d", enc(boxID), port))
}

func fwdDial(ctx context.Context, c *Ctx, url, token string) fwdDialOutcome {
	r := wsDial(ctx, c, url, token, []string{fwdSubprotocolV2, fwdSubprotocolV1})
	if r.Conn != nil {
		return fwdDialOutcome{kind: "open", ws: r.Conn}
	}
	if r.Status != 0 {
		st := r.Status
		if st >= 300 && st < 400 {
			return fwdDialOutcome{kind: "refused", status: st, code: "edge_auth", errMsg: "the orchestrator's edge redirected the CLI to a browser sign-in"}
		}
		var body map[string]any
		if json.Unmarshal(r.Body, &body) != nil || body == nil {
			code := fmt.Sprintf("http_%d", st)
			if st == 401 {
				code = "auth_required"
			}
			return fwdDialOutcome{kind: "refused", status: st, code: code}
		}
		code, _ := body["code"].(string)
		if code == "" {
			code = fmt.Sprintf("http_%d", st)
			if st == 401 {
				code = "auth_required"
			}
		}
		e, _ := body["error"].(string)
		return fwdDialOutcome{kind: "refused", status: st, code: code, errMsg: e}
	}
	if ctx.Err() != nil {
		return fwdDialOutcome{kind: "failed", reason: "aborted"}
	}
	return fwdDialOutcome{kind: "failed", reason: wsErrorReason(r.Err)}
}

// ---- the forwarder ----

type fwdListening struct {
	Port      int      `json:"port"`
	Local     int      `json:"local"`
	Name      string   `json:"name"`
	Addresses []string `json:"addresses"`
}

type fwdTotals struct {
	Connections int   `json:"connections"`
	Failed      int   `json:"failed"`
	BytesUp     int64 `json:"bytesUp"`
	BytesDown   int64 `json:"bytesDown"`
}

type fwdOptions struct {
	host       string
	box        *ConnectBox
	ports      []fwdPort
	token      BearerSource
	notify     func(string)
	retryDelay time.Duration
	pingEvery  time.Duration
	renewEvery time.Duration
	renewRetry time.Duration
}

type fwdConn struct {
	tcp    *net.TCPConn
	cancel context.CancelFunc
	pipe   *fwdPipe
	done   chan struct{}
}

type fwdForwarder struct {
	opts      fwdOptions
	mu        sync.Mutex
	totals    fwdTotals
	listening []fwdListening
	listeners []net.Listener
	live      map[*fwdConn]bool
	stopping  bool
	shown     map[string]bool
	renewer   *fwdRenewer
	wg        sync.WaitGroup
}

func fwdHostPort(host string, port int) string {
	if strings.Contains(host, ":") {
		return fmt.Sprintf("[%s]:%d", host, port)
	}
	return fmt.Sprintf("%s:%d", host, port)
}

// notice prints a line once per wave: a key is forgotten when a connection gets through.
func (f *fwdForwarder) notice(key, line string) {
	f.mu.Lock()
	if f.shown[key] {
		f.mu.Unlock()
		return
	}
	f.shown[key] = true
	f.mu.Unlock()
	f.opts.notify(line)
}

func (f *fwdForwarder) recovered(l *fwdListening) {
	f.mu.Lock()
	wave := f.shown["wave"]
	delete(f.shown, "wave")
	prefix := fmt.Sprintf("%d:", l.Local)
	for k := range f.shown {
		if strings.HasPrefix(k, prefix) {
			delete(f.shown, k)
		}
	}
	f.mu.Unlock()
	if wave {
		f.opts.notify(fmt.Sprintf("connections to %s work again", f.opts.box.Name))
	}
}

func (f *fwdForwarder) failed() {
	f.mu.Lock()
	f.totals.Failed++
	f.mu.Unlock()
}

func (f *fwdForwarder) ended() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stopping
}

func fwdIsNoFamily(err error) bool {
	return errors.Is(err, syscall.EADDRNOTAVAIL) || errors.Is(err, syscall.EAFNOSUPPORT) || errors.Is(err, syscall.EPROTONOSUPPORT)
}

func (f *fwdForwarder) bindError(err error, p fwdPort) error {
	if errors.Is(err, syscall.EADDRINUSE) {
		holder := fwdPortHolder(p.Local)
		if holder != "" {
			holder = " by " + holder
		}
		free := ""
		if p.Local+1 <= 65535 {
			free = fmt.Sprintf("; stop it, or use another local port: termag forward %s %d:%d", f.opts.box.Name, p.Port, p.Local+1)
		}
		return newErr("conflict", fmt.Sprintf("Local port %d is already in use%s%s", p.Local, holder, free))
	}
	if errors.Is(err, syscall.EACCES) {
		return newErr("failed", fmt.Sprintf("Not allowed to listen on local port %d", p.Local))
	}
	code := err.Error()
	var se syscall.Errno
	if errors.As(err, &se) {
		code = fwdErrnoName(se)
	}
	return newErr("failed", fmt.Sprintf("Can't listen on local port %d: %s", p.Local, code))
}

func fwdErrnoName(e syscall.Errno) string {
	switch e {
	case syscall.EADDRNOTAVAIL:
		return "EADDRNOTAVAIL"
	case syscall.EAFNOSUPPORT:
		return "EAFNOSUPPORT"
	}
	return e.Error()
}

// fwdStart binds every port's loopback listeners (all or nothing), then relays what they accept.
func fwdStart(c *Ctx, opts fwdOptions) (*fwdForwarder, error) {
	if opts.retryDelay == 0 {
		opts.retryDelay = 500 * time.Millisecond
	}
	f := &fwdForwarder{opts: opts, live: map[*fwdConn]bool{}, shown: map[string]bool{}}
	f.renewer = fwdNewRenewer(opts.token, opts.renewEvery, opts.renewRetry,
		func(err error) {
			f.notice("renew", fmt.Sprintf("can't renew the access token of open connections (%s); trying again, and each lasts until its token expires", err.Error()))
		},
		func() { f.mu.Lock(); delete(f.shown, "renew"); f.mu.Unlock() })
	for _, p := range opts.ports {
		l := fwdListening{Port: p.Port, Local: p.Local, Name: p.Name, Addresses: []string{}}
		if l.Name == "" {
			l.Name = fmt.Sprintf("%s:%d", opts.box.Name, p.Port)
		}
		var bound []net.Listener
		for i, host := range fwdListenHosts {
			ln, err := net.Listen("tcp", fwdHostPort(host, p.Local))
			if err != nil {
				if i > 0 && fwdIsNoFamily(err) {
					continue
				}
				for _, b := range bound {
					b.Close()
				}
				for _, b := range f.listeners {
					b.Close()
				}
				return nil, f.bindError(err, p)
			}
			bound = append(bound, ln)
			l.Addresses = append(l.Addresses, fwdHostPort(host, p.Local))
		}
		f.listeners = append(f.listeners, bound...)
		f.listening = append(f.listening, l)
		for _, ln := range bound {
			f.wg.Add(1)
			go f.acceptLoop(c, ln, f.listening[len(f.listening)-1])
		}
	}
	return f, nil
}

func (f *fwdForwarder) acceptLoop(c *Ctx, ln net.Listener, l fwdListening) {
	defer f.wg.Done()
	var backoff time.Duration
	for {
		conn, err := ln.Accept()
		if err != nil {
			if f.ended() {
				return
			}
			if errors.Is(err, net.ErrClosed) {
				return
			}
			f.notice(fmt.Sprintf("%d:listen", l.Local), fmt.Sprintf("the listener on %s failed: %s", ln.Addr().String(), err.Error()))
			// A persistent error (out of file descriptors) must not spin: back off as net/http does,
			// 5 ms doubling to 1 s, reset by the next accepted connection.
			if backoff == 0 {
				backoff = 5 * time.Millisecond
			} else if backoff *= 2; backoff > time.Second {
				backoff = time.Second
			}
			time.Sleep(backoff)
			continue
		}
		backoff = 0
		tcp := conn.(*net.TCPConn)
		f.mu.Lock()
		if f.stopping {
			f.mu.Unlock()
			tcp.Close()
			continue
		}
		f.totals.Connections++
		ctx, cancel := context.WithCancel(context.Background())
		fc := &fwdConn{tcp: tcp, cancel: cancel, done: make(chan struct{})}
		f.live[fc] = true
		f.mu.Unlock()
		lc := l
		go func() {
			defer close(fc.done)
			f.relay(ctx, c, fc, &lc)
			f.mu.Lock()
			delete(f.live, fc)
			f.mu.Unlock()
		}()
	}
}

// fwdAfterDial, nil outside tests, runs as each dial returns (a test stops the connection there).
var fwdAfterDial atomic.Pointer[func(*fwdConn)]

func (f *fwdForwarder) relay(ctx context.Context, c *Ctx, fc *fwdConn, p *fwdListening) {
	tcp := fc.tcp
	url := fwdForwardURL(f.opts.host, f.opts.box.ID, p.Port)
	label := fmt.Sprintf("%s (localhost:%d)", p.Name, p.Local)
	fail := func(key, line string) {
		f.failed()
		f.notice(key, line)
		tcp.Close()
	}
	rejected := ""
	var pending []byte
	for attempt := 0; ; attempt++ {
		if f.ended() || ctx.Err() != nil {
			tcp.Close()
			return
		}
		token, err := f.opts.token(ctx, rejected, fwdRenewValidFor)
		if err != nil {
			fail("wave", fmt.Sprintf("can't get an access token: %s; listeners stay up", err.Error()))
			return
		}
		if f.ended() {
			tcp.Close()
			return
		}
		out := fwdDial(ctx, c, url, token)
		if hook := fwdAfterDial.Load(); hook != nil {
			(*hook)(fc)
		}
		// One check, so a stop that lands between two of them can't strand a socket that opened:
		// whichever way the forward is ending, an open socket is closed here.
		if f.ended() || ctx.Err() != nil {
			if out.kind == "open" {
				_ = out.ws.Close(fwdCloseNormal, "")
			}
			tcp.Close()
			return
		}
		retry := attempt == 0
		switch out.kind {
		case "failed":
			fail("wave", fmt.Sprintf("can't reach the orchestrator at %s (%s); listeners stay up and new connections dial again", f.opts.host, out.reason))
			return
		case "refused":
			if retry && fwdRetryCodes[out.code] {
				time.Sleep(f.opts.retryDelay)
				continue
			}
			if out.code == "auth_required" && rejected == "" {
				rejected = token
				continue
			}
			if out.code == "auth_required" || out.code == "edge_auth" {
				fail("wave", fmt.Sprintf("%s refused the CLI's credential; run `termag login` (listeners stay up)", f.opts.host))
				return
			}
			what := fwdDescribeRefusal(out.code, f.opts.box.Name, f.opts.host, p.Port, out.errMsg)
			fail(fmt.Sprintf("%d:%s", p.Local, out.code), fmt.Sprintf("%s: %s: %s", label, out.code, what))
			return
		}
		ws := out.ws
		pipeOpen := true
		var pmu sync.Mutex
		isOpen := func() bool { pmu.Lock(); defer pmu.Unlock(); return pipeOpen }
		if ws.Subprotocol() == fwdSubprotocolV2 {
			f.renewer.add(ws, token, isOpen, f.ended)
		}
		var throughMu sync.Mutex
		through := false
		pipe := fwdStartPipe(tcp, ws, fwdPipeOpts{
			keepIfUntouched: func(code int) bool { return retry && code == fwdCloseDraining },
			pingEvery:       f.opts.pingEvery,
			pending:         pending,
			onBytes: func(up, down int) {
				f.mu.Lock()
				f.totals.BytesUp += int64(up)
				f.totals.BytesDown += int64(down)
				f.mu.Unlock()
				if down > 0 {
					throughMu.Lock()
					first := !through
					through = true
					throughMu.Unlock()
					if first {
						f.recovered(p)
					}
				}
			},
		})
		f.mu.Lock()
		fc.pipe = pipe
		f.mu.Unlock()
		res := <-pipe.Done()
		pmu.Lock()
		pipeOpen = false
		pmu.Unlock()
		outlived := f.renewer.remove(ws)
		f.mu.Lock()
		fc.pipe = nil
		f.mu.Unlock()
		throughMu.Lock()
		wasThrough := through
		throughMu.Unlock()
		if res.Untouched {
			pending = res.Pending
			time.Sleep(f.opts.retryDelay)
			continue
		}
		ended := f.ended()
		remote := res.ClosedBy == "remote" && !ended
		switch {
		case res.Code == fwdCloseNormal:
			if !wasThrough {
				f.recovered(p)
			}
		case res.Code == fwdCloseLifetime && remote:
			f.failed()
			f.notice(fmt.Sprintf("%d:lifetime", p.Local), fmt.Sprintf("%s: a connection reached the orchestrator's 12 h limit and was closed; a new connection will work (listeners stay up)", label))
		case res.Code == fwdCloseTokenNotRenewed && remote:
			f.failed()
			if outlived {
				f.notice(fmt.Sprintf("%d:signin", p.Local), fmt.Sprintf("%s: a connection opened under an earlier sign-in reached its access token's expiry and was closed: a later `termag login` replaced that sign-in, which can't renew it; new connections use the new one (listeners stay up)", label))
			} else {
				f.notice(fmt.Sprintf("%d:token", p.Local), fmt.Sprintf("%s: a connection was closed: %s; a new connection gets a fresh one (listeners stay up)", label, fwdDescribeClose(res.Code, f.opts.box.Name)))
			}
		case res.Code == fwdCloseRenewalRefused && remote:
			f.failed()
			f.notice(fmt.Sprintf("%d:refused", p.Local), fmt.Sprintf("%s: a connection was closed: %s; a new connection gets a fresh token (listeners stay up)", label, fwdDescribeClose(res.Code, f.opts.box.Name)))
		case remote:
			f.failed()
			f.notice("wave", fmt.Sprintf("a connection to %s dropped: %s; listeners stay up and new connections dial again", p.Name, fwdDescribeClose(res.Code, f.opts.box.Name)))
		}
		return
	}
}

// stop is Ctrl-C: stop accepting, close live connections with 1000, and return the totals.
func (f *fwdForwarder) stop() fwdTotals {
	f.mu.Lock()
	f.stopping = true
	for _, ln := range f.listeners {
		ln.Close()
	}
	var conns []*fwdConn
	for fc := range f.live {
		conns = append(conns, fc)
	}
	f.mu.Unlock()
	f.renewer.stop()
	for _, fc := range conns {
		f.mu.Lock()
		p := fc.pipe
		f.mu.Unlock()
		if p != nil {
			p.Stop(fwdStopGrace)
		} else {
			fc.cancel()
			fc.tcp.Close()
		}
	}
	// One deadline for all of them: a closed channel stays ready, unlike a time.After fired once.
	deadline := make(chan struct{})
	timer := time.AfterFunc(fwdStopGrace+500*time.Millisecond, func() { close(deadline) })
	defer timer.Stop()
	for _, fc := range conns {
		select {
		case <-fc.done:
		case <-deadline:
		}
	}
	f.wg.Wait()
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.totals
}

func fwdDescribeTotals(t fwdTotals, box string) string {
	conns := fmt.Sprintf("%d connection", t.Connections)
	if t.Connections != 1 {
		conns += "s"
	}
	failed := ""
	if t.Failed > 0 {
		failed = fmt.Sprintf(" (%d failed)", t.Failed)
	}
	return fmt.Sprintf("Forwarded %s%s: %s to %s, %s from it.", conns, failed, formatBytes(float64(t.BytesUp)), box, formatBytes(float64(t.BytesDown)))
}

func cmdForward(c *Ctx, a *ParsedArgs) (int, error) {
	if len(a.Args) < 2 {
		return 0, usageError("Name a box and at least one port. Usage: termag forward <box> <port>[:<local>]…")
	}
	boxName, specs := a.Args[0], a.Args[1:]
	ports, err := fwdParsePortSpecs(specs)
	if err != nil {
		return 0, err
	}
	s, err := newSession(c, a)
	if err != nil {
		return 0, err
	}
	api, box, err := resolveBox(c, s, boxName, true)
	if err != nil {
		return 0, err
	}
	probe, err := fwdProbeForward(api, box, ports, time.Second)
	if err != nil {
		return 0, err
	}
	if !probe.OK {
		meanwhile := ""
		if probe.Fallback != "" {
			meanwhile = fmt.Sprintf(". Meanwhile, `%s` forwards the same ports over SSM", probe.Fallback)
		}
		code := "failed"
		if probe.Code == "forbidden" {
			code = "forbidden"
		}
		return 0, &CliError{Code: code, Message: probe.Message + meanwhile, Status: probe.Status, Body: map[string]any{"code": probe.Code}}
	}
	token, err := bearerFor(c, s)
	if err != nil {
		return 0, err
	}
	f, err := fwdStart(c, fwdOptions{host: s.Target.Host, box: box, ports: ports, token: token,
		notify: func(line string) { c.Err("termag forward: " + line) }})
	if err != nil {
		return 0, err
	}
	if a.JSON {
		c.Out(CompactJSON(newObject().Set("box", newObject().Set("id", box.ID).Set("name", box.Name)).Set("listening", f.listening)))
	} else {
		for _, l := range f.listening {
			c.Out(fmt.Sprintf("Forwarding localhost:%d to %s:%d (%s)", l.Local, box.Name, l.Port, strings.Join(l.Addresses, ", ")))
		}
		c.Out("Ctrl-C to stop.")
	}
	fwdUntilInterrupted()
	totals := f.stop()
	if a.JSON {
		c.Out(CompactJSON(newObject().Set("totals", totals)))
	} else {
		c.Out(fwdDescribeTotals(totals, box.Name))
	}
	return ExitOK, nil
}
