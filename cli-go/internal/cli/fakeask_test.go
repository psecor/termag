package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeAsk is cli/src/test/fakeAsk.ts in Go: the orchestrator's /ask routes, /bug-reports and the
// box list a wake needs. Message ids are the fake's own (message0001…), whatever the CLI proposes,
// so a Node run and a Go run of one scenario print the same ids; a repeated messageId replays.

type fakeAskMsg struct {
	Message, Thread, Target, Status string
	Hop, Hops                       int
	polls, handedOut                int
	delivered                       bool
	supersededBy                    string
	model                           string
}

type fakeAsk struct {
	mu             sync.Mutex
	pollsUntilDone int
	outcome        string
	reply          string
	pr             map[string]any
	prs            []map[string]any
	publish        map[string]any
	messages       []*fakeAskMsg
	byClientID     map[string]*fakeAskMsg
	asks           []json.RawMessage
	bugs           []json.RawMessage
	failPolls      []int
	failAsk        int
	reject         string
	queued         any // false, true, "box", "setup"
	targets        []any
	threads        []any
	handoffReads   int
	stored         any // nil, true, "no-key"
	completedAt    string
	steer          any // nil, true, "behind:<reason>"
	notify         string
	model          any // nil, "unknown", "ignored:<why>"
	cancelStop     map[string]any
	boxes          []map[string]any // GET /boxes; a start moves the box to starting, the next list to running
	bugAnswer      map[string]any
	pollDelay      time.Duration
}

func newFakeAsk() *fakeAsk {
	return &fakeAsk{pollsUntilDone: 1, outcome: "completed", reply: "The flag is read in server/flags.go.", byClientID: map[string]*fakeAskMsg{}, handoffReads: 1, queued: false}
}

func (s *fakeAsk) find(id string) *fakeAskMsg {
	for _, m := range s.messages {
		if m.Message == id {
			return m
		}
	}
	return nil
}

func fakeSend(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(CompactJSON(body)))
}

func (s *fakeAsk) view(m *fakeAskMsg, consume bool) *Object {
	done := m.Status == "completed" || m.Status == "failed" || m.Status == "canceled"
	kept := s.stored == true && done && m.Status != "canceled"
	var reply any
	if done && m.Status != "canceled" && (kept || m.handedOut < s.handoffReads) {
		reply = s.reply
	}
	if reply != nil && consume {
		m.handedOut++
		m.delivered = true
	}
	o := newObject().Set("message", m.Message).Set("thread", m.Thread).Set("target", m.Target).Set("status", m.Status).
		Set("hop", m.Hop).Set("hops", m.Hops).Set("createdAt", "2026-10-09T00:00:00.000Z")
	if done {
		ca := s.completedAt
		if ca == "" {
			ca = "2026-10-09T00:01:00.000Z"
		}
		o.Set("completedAt", ca)
	} else {
		o.Set("completedAt", nil)
	}
	switch m.Status {
	case "failed":
		o.Set("error", "claude exited 1")
	case "canceled":
		o.Set("error", "canceled by alice")
	default:
		o.Set("error", nil)
	}
	o.Set("reply", reply)
	if done && m.Status != "canceled" {
		o.Set("replyBytes", len(s.reply))
	} else {
		o.Set("replyBytes", nil)
	}
	o.Set("replyDelivered", m.delivered)
	if s.stored != nil {
		o.Set("replyStored", kept).Set("replyKept", s.stored != "no-key")
	}
	if m.Status == "superseded" {
		if m.supersededBy != "" {
			o.Set("supersededBy", m.supersededBy)
		} else {
			o.Set("supersededBy", nil)
		}
	}
	if s.model != "unknown" {
		ign, _ := s.model.(string)
		if strings.HasPrefix(ign, "ignored:") || m.model == "" {
			o.Set("model", nil)
		} else {
			o.Set("model", m.model)
		}
		if strings.HasPrefix(ign, "ignored:") && m.model != "" {
			o.Set("modelIgnored", strings.TrimPrefix(ign, "ignored:"))
		}
	}
	if done {
		pub := s.publish
		if pub == nil {
			st := "none"
			if s.pr != nil {
				st = "published"
			}
			pub = map[string]any{"status": st, "detail": nil}
		}
		o.Set("publish", newObject().Set("status", pub["status"]).Set("detail", pub["detail"]))
		if s.pr != nil {
			o.Set("pr", newObject().Set("url", s.pr["url"]).Set("number", s.pr["number"]).Set("branch", s.pr["branch"]))
		} else {
			o.Set("pr", nil)
		}
	} else {
		o.Set("publish", nil).Set("pr", nil)
	}
	if s.prs != nil {
		list := []any{}
		if done {
			for _, p := range s.prs {
				list = append(list, newObject().Set("key", p["key"]).Set("url", p["url"]).Set("number", p["number"]).Set("branch", p["branch"]))
			}
		}
		o.Set("prs", list)
	}
	return o
}

var fakeCancelRE = regexp.MustCompile(`^POST /ask/messages/([^/]+)/cancel$`)
var fakeMsgRE = regexp.MustCompile(`^GET /ask/messages/([^/]+)$`)
var fakeStartRE = regexp.MustCompile(`^POST /boxes/([^/]+)/start$`)

func (s *fakeAsk) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, _ := io.ReadAll(r.Body)
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	path := strings.TrimPrefix(r.URL.Path, "/termag/api/cli/v1")
	route := r.Method + " " + path
	switch {
	case route == "POST /usage":
		w.WriteHeader(204)
	case route == "POST /ask":
		s.asks = append(s.asks, raw)
		gateway := func() {
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(502)
			_, _ = w.Write([]byte("<html>502 Bad Gateway</html>"))
		}
		if s.failAsk > 0 {
			s.failAsk--
			gateway()
			return
		}
		if body["target"] == "devbox/missing" {
			fakeSend(w, 404, map[string]any{"error": "No project devbox/missing", "code": "not_found"})
			return
		}
		if s.reject != "" {
			thread := body["threadId"]
			fakeSend(w, 409, newObject().Set("error", s.reject).Set("code", "box_offline").Set("status", "rejected").Set("message", body["messageId"]).Set("thread", thread))
			return
		}
		cid, _ := body["messageId"].(string)
		m, replayed := s.byClientID[cid]
		var steer *Object
		if !replayed {
			n := len(s.messages) + 1
			thread, _ := body["threadId"].(string)
			if thread == "" {
				thread = fmt.Sprintf("thread0000%d", n)
			}
			hops := 1
			var busy *fakeAskMsg
			for _, x := range s.messages {
				if x.Thread == thread {
					hops++
					if x.Status == "working" {
						busy = x
					}
				}
			}
			m = &fakeAskMsg{Message: fmt.Sprintf("message000%d", n), Thread: thread, Target: fmt.Sprint(body["target"]), Status: "working", Hops: hops}
			if busy != nil && body["threadId"] != nil {
				if s.steer == true {
					busy.Status = "superseded"
					busy.supersededBy = m.Message
					steer = newObject().Set("steered", true).Set("supersedes", busy.Message)
				} else if st, ok := s.steer.(string); ok && strings.HasPrefix(st, "behind:") {
					steer = newObject().Set("steered", false).Set("queuedBehind", busy.Message).Set("steerRefused", strings.TrimPrefix(st, "behind:"))
				}
			}
			if s.model != "unknown" {
				if mm, ok := body["model"].(string); ok {
					m.model = mm
				}
			}
			s.messages = append(s.messages, m)
			s.byClientID[cid] = m
		}
		o := newObject().Set("thread", m.Thread).Set("message", m.Message).Set("status", m.Status).Set("hop", 0).Set("hops", m.Hops).
			Set("target", m.Target).Set("branch", "termag-alice/"+m.Thread)
		if pr, ok := body["pr"].(string); ok {
			num := regexp.MustCompile(`(\d+)/?$`).FindStringSubmatch(pr)
			o.Set("targetPr", json.RawMessage(num[1])).Set("branch", "termag-alice/oldthread")
		}
		if s.notify != "" && body["notify"] != false {
			o.Set("notify", s.notify)
		}
		if replayed {
			o.Set("replayed", true)
		}
		if mm, ok := body["model"].(string); ok && s.model != "unknown" {
			o.Set("model", mm)
			if ign, _ := s.model.(string); strings.HasPrefix(ign, "ignored:") {
				o.Set("modelIgnored", strings.TrimPrefix(ign, "ignored:"))
			}
		}
		if s.stored != nil {
			o.Set("replyKept", s.stored != "no-key")
		}
		if steer != nil {
			for _, k := range steer.Keys() {
				v, _ := steer.Get(k)
				o.Set(k, v)
			}
		}
		if s.queued != false {
			o.Set("queued", true).Set("status", "submitted")
			if q, ok := s.queued.(string); ok {
				o.Set("queuedFor", q)
			}
		}
		fakeSend(w, 202, o)
	case route == "GET /ask/targets":
		o := newObject().Set("agents", s.targets)
		if s.targets == nil {
			o.Set("agents", []any{})
		}
		if s.threads != nil {
			o.Set("threads", s.threads)
		}
		fakeSend(w, 200, o)
	case route == "GET /ask/inbox":
		list := []any{}
		for _, m := range s.messages {
			list = append(list, s.view(m, false))
		}
		fakeSend(w, 200, newObject().Set("messages", list))
	case fakeCancelRE.MatchString(route):
		id := fakeCancelRE.FindStringSubmatch(route)[1]
		m := s.find(id)
		if m == nil {
			fakeSend(w, 404, map[string]any{"error": "Message not found", "code": "not_found"})
			return
		}
		if m.Status == "canceled" {
			fakeSend(w, 200, s.view(m, false).Set("stop", nil))
			return
		}
		if m.Status != "working" {
			fakeSend(w, 409, map[string]any{"error": "Can't cancel: the message is already " + m.Status, "code": "finished"})
			return
		}
		m.Status = "canceled"
		stop := s.cancelStop
		if stop == nil {
			stop = map[string]any{"stopped": true, "detail": "the run was stopped"}
		}
		fakeSend(w, 200, s.view(m, false).Set("stop", newObject().Set("stopped", stop["stopped"]).Set("detail", stop["detail"])))
	case fakeMsgRE.MatchString(route):
		m := s.find(fakeMsgRE.FindStringSubmatch(route)[1])
		asked := m
		for m != nil && m.Status == "superseded" && m.supersededBy != "" {
			m = s.find(m.supersededBy)
		}
		if m == nil {
			fakeSend(w, 404, map[string]any{"error": "No such message", "code": "not_found"})
			return
		}
		if len(s.failPolls) > 0 {
			f := s.failPolls[0]
			s.failPolls = s.failPolls[1:]
			if f == 502 {
				w.Header().Set("Content-Type", "text/html")
				w.WriteHeader(502)
				_, _ = w.Write([]byte("<html>502 Bad Gateway</html>"))
				return
			}
			fakeSend(w, 503, map[string]any{"error": "This orchestrator is draining"})
			return
		}
		if s.pollDelay > 0 {
			time.Sleep(s.pollDelay)
		}
		m.polls++
		if m.polls >= s.pollsUntilDone && m.Status == "working" {
			m.Status = s.outcome
		}
		if asked != m {
			v := s.view(m, true)
			v.Delete("modelIgnored")
			v.Set("message", asked.Message).Set("supersededBy", asked.supersededBy).Set("answeredWith", m.Message)
			fakeSend(w, 200, v)
			return
		}
		fakeSend(w, 200, s.view(m, true))
	case route == "POST /bug-reports":
		s.bugs = append(s.bugs, raw)
		ans := s.bugAnswer
		if ans == nil {
			ans = map[string]any{"id": "bug0001", "status": "new", "redacted": []any{}}
		}
		fakeSend(w, 201, newObject().Set("id", ans["id"]).Set("status", ans["status"]).Set("redacted", ans["redacted"]))
	case route == "GET /boxes":
		list := []any{}
		for _, b := range s.boxes {
			if b["state"] == "starting" && b["started"] == true {
				b["state"] = "running"
				b["agentConnected"] = true
				s.reject = "" // the box is up: the next ask goes through
			}
			list = append(list, newObject().Set("id", b["id"]).Set("name", b["name"]).Set("state", b["state"]).Set("agentConnected", b["agentConnected"]).Set("error", nil))
		}
		fakeSend(w, 200, newObject().Set("boxes", list))
	case fakeStartRE.MatchString(route):
		id := fakeStartRE.FindStringSubmatch(route)[1]
		for _, b := range s.boxes {
			if b["id"] == id {
				b["state"] = "starting"
				b["started"] = true
				fakeSend(w, 200, newObject().Set("box", newObject().Set("id", b["id"]).Set("name", b["name"]).Set("state", "starting").Set("agentConnected", false).Set("error", nil)))
				return
			}
		}
		fakeSend(w, 404, map[string]any{"error": "No such box"})
	default:
		fakeSend(w, 404, map[string]any{"error": "no route " + route})
	}
}

func startFakeAsk(t *testing.T, s *fakeAsk) *httptest.Server {
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return srv
}
