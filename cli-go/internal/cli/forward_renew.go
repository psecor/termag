package cli

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// forward/renew.ts: one access-token renewal for every open v2 connection of a forward, sent in
// band as `{"t":"token","token":…}`, only to connections of the same sign-in (the JWT's jti).
// A v1 connection is never added: that orchestrator would relay the frame to the box.

const (
	fwdRenewEvery    = 5 * time.Minute
	fwdRenewValidFor = 15 * time.Minute
	fwdRenewRetry    = 30 * time.Second
)

func fwdTokenFrame(token string) string {
	return CompactJSON(newObject().Set("t", "token").Set("token", token))
}

// fwdSignInOf is the jti of a JWT access token, read without verifying; "" when there is none.
func fwdSignInOf(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) < 2 || parts[1] == "" {
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return ""
	}
	var payload struct {
		Jti any `json:"jti"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return ""
	}
	s, _ := payload.Jti.(string)
	return s
}

type fwdHeldConn struct {
	token string
	skip  func() bool
	open  func() bool
}

type fwdRenewer struct {
	source    BearerSource
	every     time.Duration
	validFor  time.Duration
	retry     time.Duration
	onError   func(error)
	onRenewed func()

	mu       sync.Mutex
	held     map[*websocket.Conn]*fwdHeldConn
	stranded map[*websocket.Conn]bool
	timer    *time.Timer
	asking   bool
	stopped  bool
}

func fwdNewRenewer(source BearerSource, every, retry time.Duration, onError func(error), onRenewed func()) *fwdRenewer {
	if every == 0 {
		every = fwdRenewEvery
	}
	if retry == 0 {
		retry = fwdRenewRetry
	}
	return &fwdRenewer{source: source, every: every, validFor: fwdRenewValidFor, retry: retry, onError: onError, onRenewed: onRenewed,
		held: map[*websocket.Conn]*fwdHeldConn{}, stranded: map[*websocket.Conn]bool{}}
}

func (r *fwdRenewer) wanted(h *fwdHeldConn) bool { return h.open() && (h.skip == nil || !h.skip()) }

// schedule must be called with mu held.
func (r *fwdRenewer) schedule(d time.Duration) {
	if r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
	if r.stopped || len(r.held) == 0 {
		return
	}
	r.timer = time.AfterFunc(d, func() {
		r.mu.Lock()
		r.timer = nil
		r.mu.Unlock()
		r.ask()
	})
}

func (r *fwdRenewer) ask() {
	r.mu.Lock()
	if r.asking || r.stopped {
		r.mu.Unlock()
		return
	}
	any := false
	for _, h := range r.held {
		if r.wanted(h) {
			any = true
		}
	}
	if !any {
		r.schedule(r.every)
		r.mu.Unlock()
		return
	}
	r.asking = true
	r.mu.Unlock()
	token, err := r.source(context.Background(), "", r.validFor)
	r.mu.Lock()
	r.asking = false
	if err != nil {
		r.mu.Unlock()
		if r.onError != nil {
			r.onError(err)
		}
		r.mu.Lock()
		r.schedule(r.retry)
		r.mu.Unlock()
		return
	}
	if r.stopped {
		r.mu.Unlock()
		return
	}
	r.mu.Unlock()
	if r.onRenewed != nil {
		r.onRenewed()
	}
	signIn := fwdSignInOf(token)
	r.mu.Lock()
	type send struct{ ws *websocket.Conn }
	var sends []send
	for ws, h := range r.held {
		if h.token == token || !r.wanted(h) {
			continue
		}
		if fwdSignInOf(h.token) != signIn {
			r.stranded[ws] = true
			continue
		}
		h.token = token
		sends = append(sends, send{ws})
	}
	r.schedule(r.every)
	r.mu.Unlock()
	frame := []byte(fwdTokenFrame(token))
	for _, s := range sends {
		_ = s.ws.Write(context.Background(), websocket.MessageText, frame)
	}
}

// add: a v2 connection opened with token; open says it still is, skip that it is ending.
func (r *fwdRenewer) add(ws *websocket.Conn, token string, open, skip func() bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	h := &fwdHeldConn{token: token, skip: skip, open: open}
	if r.stopped || !r.wanted(h) {
		return
	}
	r.held[ws] = h
	if r.timer == nil && !r.asking {
		r.schedule(r.every)
	}
}

// remove: the connection closed. It forgets the connection in both maps and says whether it was
// stranded (opened under a sign-in a later `termag login` replaced), which the close's notice needs.
// The last one gone: no ask until another opens.
func (r *fwdRenewer) remove(ws *websocket.Conn) (stranded bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	stranded = r.stranded[ws]
	delete(r.held, ws)
	delete(r.stranded, ws)
	if len(r.held) == 0 && r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
	return stranded
}

func (r *fwdRenewer) stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stopped = true
	r.held = map[*websocket.Conn]*fwdHeldConn{}
	r.stranded = map[*websocket.Conn]bool{}
	if r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
}
