package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

// `termag events` (cli/src/events/{command,model,socket}.ts): the box list, polled, and the
// session statuses pushed on the CLI's status socket, /api/cli/v1/ws/status, as one stream.

func init() { register("events", cmdEvents) }

// The schedule and timeouts; package vars so tests can shorten them.
var (
	// evBackoff is the browser's schedule, capped at 30 s (socket.ts BACKOFF_MS).
	evBackoff = []time.Duration{0, 500 * time.Millisecond, time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 15 * time.Second, 30 * time.Second}
	// evStale: the server sends a heartbeat every 25 s; two missed, plus slack.
	evStale        = 60 * time.Second
	evSettlingPoll = 5 * time.Second
	evIdlePoll     = 30 * time.Second
	// evUntilInterrupted replaces waiting for Ctrl-C/SIGTERM/SIGHUP (tests).
	evUntilInterrupted func() <-chan struct{}
)

// evReauthClose is CLI_WS_REAUTH_CLOSE_CODE in backend/src/routes/cliWs.ts.
const evReauthClose = 4401

// evFinal1008 are the 1008 reasons no wait can change.
var evFinal1008 = []string{"termag login", "credential revoked", "login required", "unknown user", "unknown path"}

// ---- model.ts ----

type evBoxRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// evBoxEvent's field order is the JSON's (model.ts BoxEvent).
type evBoxEvent struct {
	Type           string   `json:"type"`
	At             string   `json:"at"`
	Box            evBoxRef `json:"box"`
	State          string   `json:"state"`
	Previous       *string  `json:"previous"`
	AgentConnected bool     `json:"agentConnected"`
	Error          string   `json:"error,omitempty"`
}

type evSessionBox struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

type evSessionEvent struct {
	Type          string        `json:"type"`
	At            string        `json:"at"`
	Session       string        `json:"session"`
	Box           *evSessionBox `json:"box,omitempty"`
	Status        string        `json:"status"`
	Previous      *string       `json:"previous"`
	WaitingReason string        `json:"waitingReason,omitempty"`
	StoppedAt     string        `json:"stoppedAt,omitempty"`
}

type evFrame struct {
	kind          string // status, boxes-changed, other
	session       string
	instanceID    string // "" for null
	status        string
	waitingReason string
	stoppedAt     string
}

func evOptionalString(v any) string {
	s, _ := v.(string)
	return s
}

// evParseFrame is model.ts parseFrame; nil for anything that isn't an object with a known type.
func evParseFrame(text string) *evFrame {
	var f any
	if json.Unmarshal([]byte(text), &f) != nil {
		return nil
	}
	o, ok := f.(map[string]any)
	if !ok {
		return nil
	}
	typ, isStr := o["type"].(string)
	if isStr && typ == "status" {
		session, ok1 := o["session"].(string)
		status, ok2 := o["status"].(string)
		if !ok1 || !ok2 {
			return nil
		}
		fr := &evFrame{kind: "status", session: session, status: status}
		fr.instanceID, _ = o["instanceId"].(string)
		if status == "waiting" {
			fr.waitingReason = evOptionalString(o["waitingReason"])
		}
		if s, ok := o["stoppedAt"].(string); ok {
			if t, ok := parseJSDate(s); ok {
				fr.stoppedAt = isoString(t)
			}
		}
		return fr
	}
	if isStr && typ == "workspace" {
		if w, _ := o["what"].(string); w == "boxes" {
			return &evFrame{kind: "boxes-changed"}
		}
		return &evFrame{kind: "other"}
	}
	if isStr {
		return &evFrame{kind: "other"}
	}
	return nil
}

var evSettling = map[string]bool{"provisioning": true, "awaiting-agent": true, "stopping": true, "starting": true, "hibernating": true}

type evBox struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	State          string  `json:"state"`
	AgentConnected bool    `json:"agentConnected"`
	Error          *string `json:"error"`
}

// evTracker is model.ts EventTracker. The orders are a JS Map's: first insertion.
type evTracker struct {
	boxes        map[string]evBox
	boxOrder     []string
	sessions     map[string]*evFrame
	sessionOrder []string
}

func newEvTracker() *evTracker {
	return &evTracker{boxes: map[string]evBox{}, sessions: map[string]*evFrame{}}
}

func evStrPtr(s string) *string { return &s }

func (t *evTracker) boxList(list []evBox, at string) []any {
	var events []any
	seen := map[string]bool{}
	for _, box := range list {
		seen[box.ID] = true
		before, had := t.boxes[box.ID]
		if !had {
			t.boxOrder = append(t.boxOrder, box.ID)
		}
		t.boxes[box.ID] = box
		if had && before.State == box.State {
			continue
		}
		e := evBoxEvent{Type: "box", At: at, Box: evBoxRef{box.ID, box.Name}, State: box.State, AgentConnected: box.AgentConnected}
		if had {
			e.Previous = evStrPtr(before.State)
		}
		if box.State == "failed" && box.Error != nil && *box.Error != "" {
			e.Error = *box.Error
		}
		events = append(events, e)
	}
	var kept []string
	for _, id := range t.boxOrder {
		if seen[id] {
			kept = append(kept, id)
			continue
		}
		gone := t.boxes[id]
		delete(t.boxes, id)
		events = append(events, evBoxEvent{Type: "box", At: at, Box: evBoxRef{id, gone.Name}, State: "terminated", Previous: evStrPtr(gone.State)})
	}
	t.boxOrder = kept
	return events
}

func (t *evTracker) status(f *evFrame, at string) *evSessionEvent {
	key := f.instanceID + "\x00" + f.session
	before, had := t.sessions[key]
	if !had {
		t.sessionOrder = append(t.sessionOrder, key)
	}
	t.sessions[key] = f
	if had && before.status == f.status && before.waitingReason == f.waitingReason {
		return nil
	}
	e := &evSessionEvent{Type: "session", At: at, Session: f.session, Status: f.status, WaitingReason: f.waitingReason, StoppedAt: f.stoppedAt}
	if f.instanceID != "" {
		e.Box = &evSessionBox{ID: f.instanceID}
		if b, ok := t.boxes[f.instanceID]; ok && b.Name != "" {
			e.Box.Name = b.Name
		}
	}
	if had {
		e.Previous = evStrPtr(before.status)
	}
	return e
}

func (t *evTracker) settling() bool {
	for _, b := range t.boxes {
		if evSettling[b.State] {
			return true
		}
	}
	return false
}

func evChange(previous *string, now string) string {
	if previous == nil {
		return now
	}
	return *previous + " -> " + now
}

// evDescribe is model.ts describeEvent.
func evDescribe(e any) string {
	switch e := e.(type) {
	case evBoxEvent:
		s := fmt.Sprintf("%s box %s: %s", e.At, e.Box.Name, evChange(e.Previous, e.State))
		if e.State == "running" && !e.AgentConnected {
			s += " (agent not connected)"
		}
		if e.Error != "" {
			s += " (" + e.Error + ")"
		}
		return s
	case *evSessionEvent:
		where := ""
		if e.Box != nil {
			n := e.Box.Name
			if n == "" {
				n = e.Box.ID
			}
			where = " on " + n
		}
		s := fmt.Sprintf("%s session %s%s: %s", e.At, e.Session, where, evChange(e.Previous, e.Status))
		if e.WaitingReason != "" {
			s += " (" + e.WaitingReason + ")"
		}
		return s
	}
	return ""
}

// ---- socket.ts ----

type evNext struct {
	kind   string // retry, renew, fatal
	reason string
	err    *CliError
}

var evHTTPRE = regexp.MustCompile(`Unexpected server response: (\d{3})`)

// evNextAfterClose is socket.ts nextAfterClose. lastError carries `ws`'s message for an upgrade
// that got an HTTP answer instead ("Unexpected server response: NNN").
func evNextAfterClose(code int, reason, lastError string, renewed bool) evNext {
	if m := evHTTPRE.FindStringSubmatch(lastError); m != nil {
		var status int
		fmt.Sscanf(m[1], "%d", &status)
		switch {
		case status == 401 || status == 403:
			if renewed {
				return evNext{kind: "fatal", err: &CliError{Code: "auth_required", Status: status,
					Message: fmt.Sprintf("The orchestrator refused the CLI's credential on its status socket (HTTP %d); run `termag login`", status)}}
			}
			return evNext{kind: "renew"}
		case status >= 300 && status < 400:
			return evNext{kind: "fatal", err: &CliError{Code: "edge_auth", Status: status,
				Message: "The orchestrator's edge redirected the status socket to a browser sign-in: it does not let the CLI through yet"}}
		case status == 404:
			return evNext{kind: "fatal", err: &CliError{Code: "not_cli_enabled", Status: status, Message: "This orchestrator has no CLI status socket; it may predate it"}}
		}
		return evNext{kind: "retry", reason: fmt.Sprintf("HTTP %d", status)}
	}
	if code == evReauthClose {
		return evNext{kind: "renew"}
	}
	if code == 1008 {
		low := strings.ToLower(reason)
		for _, f := range evFinal1008 {
			if strings.Contains(low, f) {
				c := "auth_required"
				if strings.Contains(reason, "unknown path") {
					c = "not_cli_enabled"
				}
				return evNext{kind: "fatal", err: newErr(c, reason)}
			}
		}
	}
	r := reason
	if r == "" {
		r = lastError
	}
	if r == "" {
		r = fmt.Sprintf("closed (%d)", code)
	}
	return evNext{kind: "retry", reason: r}
}

// evDialError is `ws`'s error message for a dial with no answer: `connect ECONNREFUSED 1.2.3.4:5`.
func evDialError(err error) string {
	var op *net.OpError
	if errors.As(err, &op) && op.Op == "dial" {
		code := netErrorCode(err)
		if strings.HasPrefix(code, "E") && op.Addr != nil {
			return "connect " + code + " " + op.Addr.String()
		}
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		c := "EAI_AGAIN"
		if dns.IsNotFound {
			c = "ENOTFOUND"
		}
		return "getaddrinfo " + c + " " + dns.Name
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "Opening handshake has timed out"
	}
	return wsErrorReason(err)
}

type evSocketOpts struct {
	url     string
	token   BearerSource
	onText  func(string)
	onOpen  func()
	onDown  func(reason string, retryIn time.Duration)
	onFatal func(*CliError)
}

// evOpenStatusSocket is socket.ts openStatusSocket. stop ends it; nothing is called after stop.
func evOpenStatusSocket(c *Ctx, o evSocketOpts) (stop func()) {
	ctx, cancel := context.WithCancel(context.Background())
	var mu sync.Mutex
	stopped := false
	attempt := 0
	isStopped := func() bool { mu.Lock(); defer mu.Unlock(); return stopped }
	backoff, staleAfter := evBackoff, evStale

	go func() {
		refused := ""
		delay := time.Duration(0)
		for {
			if delay > 0 {
				select {
				case <-ctx.Done():
					return
				case <-time.After(delay):
				}
			}
			if isStopped() {
				return
			}
			renewed := refused != ""
			token, err := o.token(ctx, refused, 0)
			if isStopped() {
				return
			}
			retry := func(reason string) {
				mu.Lock()
				i := attempt
				attempt++
				mu.Unlock()
				if i >= len(backoff) {
					i = len(backoff) - 1
				}
				delay = backoff[i]
				o.onDown(reason, delay)
			}
			if err != nil {
				if ce, ok := err.(*CliError); ok && ce.Code == "auth_required" {
					o.onFatal(ce)
					return
				}
				retry(err.Error())
				continue
			}
			refused = ""
			res := wsDial(ctx, c, o.url, token, nil)
			if isStopped() {
				if res.Conn != nil {
					res.Conn.CloseNow()
				}
				return
			}
			code, reason, lastError, stale := 1006, "", "", false
			if res.Conn == nil {
				if res.Status != 0 {
					lastError = fmt.Sprintf("Unexpected server response: %d", res.Status)
				} else {
					lastError = evDialError(res.Err)
				}
			} else {
				code, reason, stale = evReadSocket(ctx, res.Conn, o, &mu, &attempt, staleAfter)
				if isStopped() {
					return
				}
			}
			if stale {
				retry(fmt.Sprintf("no word from the orchestrator in %d s", int(math.Round(staleAfter.Seconds()))))
				continue
			}
			next := evNextAfterClose(code, reason, lastError, renewed)
			switch next.kind {
			case "fatal":
				mu.Lock()
				stopped = true
				mu.Unlock()
				o.onFatal(next.err)
				return
			case "renew":
				refused = token
				delay = 0
			default:
				retry(next.reason)
			}
		}
	}()
	return func() {
		mu.Lock()
		stopped = true
		mu.Unlock()
		cancel()
	}
}

// evReadSocket reads frames until the socket closes or goes stale; the close's code and reason.
func evReadSocket(ctx context.Context, conn *websocket.Conn, o evSocketOpts, mu *sync.Mutex, attempt *int, staleAfter time.Duration) (code int, reason string, stale bool) {
	o.onOpen()
	var lastMu sync.Mutex
	last := time.Now()
	staleCh := make(chan struct{})
	done := make(chan struct{})
	defer close(done)
	go func() {
		tick := staleAfter
		if tick > 5*time.Second {
			tick = 5 * time.Second
		}
		t := time.NewTicker(tick)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				conn.CloseNow()
				return
			case <-t.C:
				lastMu.Lock()
				quiet := time.Since(last)
				lastMu.Unlock()
				if quiet > staleAfter {
					close(staleCh)
					conn.CloseNow()
					return
				}
			}
		}
	}()
	for {
		_, data, err := conn.Read(context.Background())
		if err != nil {
			select {
			case <-staleCh:
				return 1006, "", true
			default:
			}
			var ce websocket.CloseError
			if errors.As(err, &ce) {
				return int(ce.Code), ce.Reason, false
			}
			return 1006, "", false
		}
		lastMu.Lock()
		last = time.Now()
		lastMu.Unlock()
		mu.Lock()
		*attempt = 0
		mu.Unlock()
		o.onText(string(data))
	}
}

// ---- command.ts ----

func cmdEvents(c *Ctx, a *ParsedArgs) (int, error) {
	s, err := newSession(c, a)
	if err != nil {
		return 0, err
	}
	token, err := bearerFor(c, s)
	if err != nil {
		return 0, err
	}
	api := &Api{Host: s.Target.Host, Source: token, Client: c.HTTP}
	tracker := newEvTracker()
	var outMu sync.Mutex // the box poll and the socket both emit; one at a time, as Node's one thread
	emit := func(events []any) {
		for _, e := range events {
			if a.JSON {
				c.Out(CompactJSON(e))
			} else {
				c.Out(evDescribe(e))
			}
		}
	}
	notice := func(line string) { c.Err("termag events: " + line) }

	failed := make(chan *CliError, 1)
	fail := func(e *CliError) {
		select {
		case failed <- e:
		default:
		}
	}
	var socketMu sync.Mutex
	var stopSocket func()
	down := false

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	poke := make(chan struct{}, 1)
	doPoke := func() {
		select {
		case poke <- struct{}{}:
		default:
		}
	}
	settlingPoll := evSettlingPoll
	if c.PollInterval > 0 {
		settlingPoll = c.PollInterval
	}

	firstRead := func() {
		socketMu.Lock()
		defer socketMu.Unlock()
		if ctx.Err() != nil {
			return
		}
		stopSocket = evOpenStatusSocket(c, evSocketOpts{
			url:   wsURL(s.Target.Host, "/ws/status"),
			token: token,
			onText: func(text string) {
				f := evParseFrame(text)
				if f == nil {
					return
				}
				switch f.kind {
				case "status":
					outMu.Lock()
					if e := tracker.status(f, isoString(c.now())); e != nil {
						emit([]any{e})
					}
					outMu.Unlock()
				case "boxes-changed":
					doPoke()
				}
			},
			// Back after a drop: the replay that follows has the statuses that changed meanwhile.
			onOpen: func() {
				outMu.Lock()
				defer outMu.Unlock()
				if !down {
					return
				}
				down = false
				notice("connected again")
				doPoke()
			},
			onDown: func(reason string, retryIn time.Duration) {
				outMu.Lock()
				defer outMu.Unlock()
				if !down {
					suffix := ""
					if retryIn > 0 {
						suffix = fmt.Sprintf(" in %d s", int(math.Ceil(retryIn.Seconds())))
					}
					notice(fmt.Sprintf("lost the status socket (%s); reconnecting%s", reason, suffix))
				}
				down = true
			},
			onFatal: fail,
		})
	}

	// pollBoxes: every settlingPoll while a box is settling, else evIdlePoll, and at once on a poke.
	backoff, idlePoll := evBackoff, evIdlePoll
	pollDone := make(chan struct{})
	go func() {
		defer close(pollDone)
		failures := 0
		first := true
		for {
			// A poke that came during the read makes the next one immediate.
			select {
			case <-poke:
			default:
			}
			var res struct {
				Boxes []evBox `json:"boxes"`
			}
			err := api.Request(ctx, "GET", "/boxes", nil, &res)
			if ctx.Err() != nil {
				return
			}
			var delay time.Duration
			if err != nil {
				if ce, ok := err.(*CliError); ok && ce.Code == "auth_required" {
					fail(ce)
					return
				}
				if failures == 0 {
					notice(fmt.Sprintf("can't read the box list (%s); retrying", err.Error()))
				}
				failures++
				i := failures
				if i >= len(backoff) {
					i = len(backoff) - 1
				}
				delay = backoff[i]
			} else {
				outMu.Lock()
				emit(tracker.boxList(res.Boxes, isoString(c.now())))
				settling := tracker.settling()
				outMu.Unlock()
				if failures > 0 {
					notice("reading the box list again")
				}
				failures = 0
				if first {
					first = false
					firstRead() // boxes first, so the sessions' first events can name theirs
				}
				delay = idlePoll
				if settling {
					delay = settlingPoll
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-poke:
			case <-time.After(delay):
			}
		}
	}()

	var interrupted <-chan struct{}
	if evUntilInterrupted != nil {
		interrupted = evUntilInterrupted()
	} else {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
		defer signal.Stop(sig)
		ch := make(chan struct{})
		go func() { <-sig; close(ch) }()
		interrupted = ch
	}
	var outcome *CliError
	select {
	case outcome = <-failed:
	case <-interrupted:
	case <-c.OutGone: // the reader of stdout went away, as `| head -1` does
	}
	cancel()
	socketMu.Lock()
	if stopSocket != nil {
		stopSocket()
	}
	socketMu.Unlock()
	if outcome != nil {
		return 0, outcome
	}
	return ExitOK, nil
}
