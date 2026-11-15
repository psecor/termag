package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// `termag ask` (cli/src/ask.ts). Its output is a contract: termag-desktop
// parses the stderr lines, the `thread:` line and the `--json` A2A Tasks ("id" before
// "contextId"), so every JSON object here is built in order (Object), never from a Go map.

func init() { register("ask", cmdAsk) }

const (
	askWaitS           = 50
	askRequestTimeout  = 70 * time.Second
	askRetryFor        = 10 * time.Minute
	askRetryDelay      = time.Second
	askRetryDelayMax   = 5 * time.Second
	askMaxTitleChars   = 60
	askTitleExample    = `--title "Members-only file composer (#765)"`
	askExtensionURI    = "urn:termag:ask:v1"
	askReplyKeptPeriod = 14 * 24 * time.Hour
)

var (
	askRefRE         = regexp.MustCompile(`^[A-Za-z0-9_-]+/[^/@:\s]+(@[^/@:\s]+)?(:[A-Za-z0-9][A-Za-z0-9_-]*)?$`)
	askIDRE          = regexp.MustCompile(`^[a-z0-9]{8,40}$`)
	askPRRE          = regexp.MustCompile(`^(?:(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#?\d{1,9}|https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/\d{1,9}/?)$`)
	fireworksModelRE = regexp.MustCompile(`^fireworks(?::[A-Za-z0-9._/-]{1,200})?$`)
	claudeSessionRE  = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)
	untrustedCloseRE = regexp.MustCompile(`(?i)</untrusted-reply`)
)

// claudeModels is lifecycle.ts's CLAUDE_MODELS.
var claudeModels = []string{"opus", "sonnet", "haiku"}

var a2aState = map[string]string{
	"submitted":  "TASK_STATE_SUBMITTED",
	"working":    "TASK_STATE_WORKING",
	"completed":  "TASK_STATE_COMPLETED",
	"failed":     "TASK_STATE_FAILED",
	"canceled":   "TASK_STATE_CANCELED",
	"superseded": "TASK_STATE_COMPLETED",
	"rejected":   "TASK_STATE_REJECTED",
}

func a2aStateOf(status string) string {
	if s, ok := a2aState[status]; ok {
		return s
	}
	return "TASK_STATE_UNSPECIFIED"
}

// askPr is one PR of a thread; raw is the server's object.
type askPr struct {
	raw    *Object
	Key    string
	URL    string
	Number json.RawMessage
	Branch json.RawMessage // absent: nil
	hasKey bool
}

// askMessage is a message view (AskMessage in ask.ts). raw keeps every field as sent, so the
// A2A metadata passes server values through exactly (absent stays absent, null stays null).
type askMessage struct {
	raw            *Object
	Message        string
	Thread         string
	Title          *string
	Target         string
	Status         string
	CreatedAt      string
	StartedAt      *string
	CompletedAt    *string
	Error          *string
	Reply          *string
	ReplyBytes     *float64
	ReplyDelivered bool
	ReplyStored    *bool
	ReplyKept      *bool
	Publish        *struct {
		Status string  `json:"status"`
		Detail *string `json:"detail"`
	}
	SupersededBy *string
	AnsweredWith *string
	Notice       *string
	Model        *string
	ModelIgnored *string
	prs          []askPr
}

func rawOf(o *Object, k string) json.RawMessage {
	v, ok := o.Get(k)
	if !ok {
		return nil
	}
	if r, ok := v.(json.RawMessage); ok {
		return r
	}
	b, _ := json.Marshal(v)
	return b
}

func parseAskMessage(raw json.RawMessage) (*askMessage, error) {
	var t struct {
		Message        string   `json:"message"`
		Thread         string   `json:"thread"`
		Title          *string  `json:"title"`
		Target         string   `json:"target"`
		Status         string   `json:"status"`
		CreatedAt      string   `json:"createdAt"`
		StartedAt      *string  `json:"startedAt"`
		CompletedAt    *string  `json:"completedAt"`
		Error          *string  `json:"error"`
		Reply          *string  `json:"reply"`
		ReplyBytes     *float64 `json:"replyBytes"`
		ReplyDelivered bool     `json:"replyDelivered"`
		ReplyStored    *bool    `json:"replyStored"`
		ReplyKept      *bool    `json:"replyKept"`
		Publish        *struct {
			Status string  `json:"status"`
			Detail *string `json:"detail"`
		} `json:"publish"`
		SupersededBy *string `json:"supersededBy"`
		AnsweredWith *string `json:"answeredWith"`
		Notice       *string `json:"notice"`
		Model        *string `json:"model"`
		ModelIgnored *string `json:"modelIgnored"`
	}
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, newErr("failed", "Unexpected answer from the orchestrator: "+err.Error())
	}
	o := newObject()
	if err := o.UnmarshalJSON(raw); err != nil {
		return nil, newErr("failed", "Unexpected answer from the orchestrator: "+err.Error())
	}
	m := &askMessage{raw: o, Message: t.Message, Thread: t.Thread, Title: t.Title, Target: t.Target, Status: t.Status,
		CreatedAt: t.CreatedAt, StartedAt: t.StartedAt, CompletedAt: t.CompletedAt, Error: t.Error, Reply: t.Reply,
		ReplyBytes: t.ReplyBytes, ReplyDelivered: t.ReplyDelivered, ReplyStored: t.ReplyStored, ReplyKept: t.ReplyKept,
		Publish: t.Publish, SupersededBy: t.SupersededBy, AnsweredWith: t.AnsweredWith, Notice: t.Notice, Model: t.Model, ModelIgnored: t.ModelIgnored}
	// prsOf: m.prs ?? (m.pr ? [{ key: '', ...m.pr }] : [])
	if prs := rawOf(o, "prs"); prs != nil && string(prs) != "null" {
		var items []json.RawMessage
		_ = json.Unmarshal(prs, &items)
		for _, it := range items {
			m.prs = append(m.prs, parseAskPr(it, false))
		}
	} else if pr := rawOf(o, "pr"); pr != nil && string(pr) != "null" && string(pr) != "false" {
		m.prs = []askPr{parseAskPr(pr, true)}
	}
	return m, nil
}

func parseAskPr(raw json.RawMessage, addKey bool) askPr {
	src := newObject()
	_ = src.UnmarshalJSON(raw)
	o := src
	if addKey {
		o = newObject().Set("key", "")
		for _, k := range src.Keys() {
			v, _ := src.Get(k)
			o.Set(k, v)
		}
	}
	p := askPr{raw: o, Number: rawOf(o, "number"), Branch: rawOf(o, "branch")}
	if k := rawOf(o, "key"); k != nil {
		p.hasKey = true
		_ = json.Unmarshal(k, &p.Key)
	}
	if v, ok := o.Get("key"); ok {
		if s, ok := v.(string); ok {
			p.Key = s
		}
	}
	_ = json.Unmarshal(rawOf(o, "url"), &p.URL)
	return p
}

func (p askPr) branchText() string {
	var s string
	if p.Branch != nil && json.Unmarshal(p.Branch, &s) == nil {
		return s
	}
	return ""
}

func askFinished(status string) bool {
	return status == "completed" || status == "failed" || status == "canceled" || status == "superseded"
}

func truthy(p *string) bool { return p != nil && *p != "" }

// a2aTask is the message as an A2A v1.0 Task in its JSON binding.
func a2aTask(m *askMessage) *Object {
	artifacts := []any{}
	if m.Reply != nil {
		artifacts = append(artifacts, newObject().Set("artifactId", m.Message+"-reply").Set("name", "reply").
			Set("parts", []any{newObject().Set("text", *m.Reply).Set("mediaType", "text/plain")}))
	}
	prs := []any{}
	for _, p := range m.prs {
		id := m.Message + "-pr"
		if p.Key != "" {
			id = m.Message + "-pr-" + p.Key
		}
		meta := newObject()
		if p.Number != nil {
			meta.Set("number", p.Number)
		}
		if p.Branch != nil {
			meta.Set("branch", p.Branch)
		}
		if p.Key != "" {
			meta.Set("key", p.Key)
		}
		art := newObject().Set("artifactId", id).Set("name", "pull-request")
		if p.URL != "" || rawOf(p.raw, "url") != nil {
			art.Set("parts", []any{newObject().Set("url", rawOf(p.raw, "url"))})
		} else {
			art.Set("parts", []any{newObject()})
		}
		art.Set("metadata", meta)
		artifacts = append(artifacts, art)
		prs = append(prs, p.raw)
	}
	ts := m.CreatedAt
	if m.CompletedAt != nil {
		ts = *m.CompletedAt
	} else if m.StartedAt != nil {
		ts = *m.StartedAt
	}
	status := newObject().Set("state", a2aStateOf(m.Status)).Set("timestamp", ts)
	note := ""
	switch {
	case truthy(m.AnsweredWith) && askFinished(m.Status) && !truthy(m.Error):
		note = "answered together with follow-up " + *m.AnsweredWith
	case m.Status == "superseded" && truthy(m.SupersededBy):
		note = "superseded by message " + *m.SupersededBy + ", whose reply answers this one too"
	case m.Error != nil:
		note = *m.Error
	}
	if note != "" {
		status.Set("message", newObject().Set("messageId", m.Message+"-status").Set("contextId", m.Thread).Set("taskId", m.Message).
			Set("role", "ROLE_AGENT").Set("parts", []any{newObject().Set("text", note)}))
	}
	termag := newObject()
	for _, k := range []string{"target", "status", "hop", "hops", "error", "replyBytes", "replyDelivered"} {
		if r := rawOf(m.raw, k); r != nil {
			termag.Set(k, r)
		}
	}
	termag.Set("replyStored", m.ReplyStored != nil && *m.ReplyStored)
	if r := rawOf(m.raw, "replyStored"); r != nil && string(r) != "null" {
		termag.Set("replyStored", r)
	}
	for _, k := range []string{"publish", "pr"} {
		if r := rawOf(m.raw, k); r != nil {
			termag.Set(k, r)
		}
	}
	termag.Set("prs", prs)
	if truthy(m.SupersededBy) {
		termag.Set("supersededBy", *m.SupersededBy)
	}
	if truthy(m.AnsweredWith) {
		termag.Set("answeredWith", *m.AnsweredWith)
	}
	if truthy(m.Notice) {
		termag.Set("notice", *m.Notice)
	}
	if truthy(m.Model) {
		termag.Set("model", *m.Model)
	}
	if truthy(m.ModelIgnored) {
		termag.Set("modelIgnored", *m.ModelIgnored)
	}
	return newObject().Set("id", m.Message).Set("contextId", m.Thread).Set("status", status).Set("artifacts", artifacts).
		Set("metadata", newObject().Set("termag", termag))
}

// askStarted is POST /ask's answer.
type askStarted struct {
	raw          *Object
	Thread       string  `json:"thread"`
	Message      string  `json:"message"`
	Status       string  `json:"status"`
	Hop          float64 `json:"hop"`
	Target       string  `json:"target"`
	Branch       string  `json:"branch"`
	TargetPr     float64 `json:"targetPr"`
	Queued       bool    `json:"queued"`
	QueuedFor    string  `json:"queuedFor"`
	Steered      bool    `json:"steered"`
	Supersedes   string  `json:"supersedes"`
	QueuedBehind string  `json:"queuedBehind"`
	SteerRefused string  `json:"steerRefused"`
	ReplyKept    bool    `json:"replyKept"`
	Notify       string  `json:"notify"`
	Model        *string `json:"model"`
	ModelIgnored string  `json:"modelIgnored"`
	hasModel     bool
}

func startedTask(c *Ctx, s *askStarted) *Object {
	termag := newObject()
	for _, k := range []string{"target", "status", "hop", "hops", "branch"} {
		if r := rawOf(s.raw, k); r != nil {
			termag.Set(k, r)
		}
	}
	if s.Notify != "" {
		termag.Set("notify", s.Notify)
	}
	if truthy(s.Model) && s.ModelIgnored == "" {
		termag.Set("model", *s.Model)
	}
	if s.ModelIgnored != "" {
		termag.Set("modelIgnored", s.ModelIgnored)
	}
	return newObject().Set("id", s.Message).Set("contextId", s.Thread).
		Set("status", newObject().Set("state", a2aStateOf(s.Status)).Set("timestamp", isoString(c.now()))).
		Set("artifacts", []any{}).Set("metadata", newObject().Set("termag", termag))
}

// rejectedTask: an ask the target refused at once; nothing was stored.
func rejectedTask(c *Ctx, id, thread, reason string) *Object {
	o := newObject().Set("id", id)
	if thread != "" {
		o.Set("contextId", thread)
	}
	msg := newObject().Set("messageId", id+"-status")
	if thread != "" {
		msg.Set("contextId", thread)
	}
	msg.Set("taskId", id).Set("role", "ROLE_AGENT").Set("parts", []any{newObject().Set("text", reason)})
	o.Set("status", newObject().Set("state", "TASK_STATE_REJECTED").Set("message", msg).Set("timestamp", isoString(c.now())))
	o.Set("artifacts", []any{})
	o.Set("metadata", newObject().Set("termag", newObject().Set("status", "rejected").Set("error", reason)))
	return o
}

func isRejection(err error) (*CliError, bool) {
	var ce *CliError
	if errors.As(err, &ce) && ce.Body != nil {
		if s, _ := ce.Body["status"].(string); s == "rejected" {
			return ce, true
		}
	}
	return nil, false
}

func newAskMessageID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return "a" + hex.EncodeToString(b)
}

// askTitle is --title collapsed and checked. Its length counts code points, as Node's
// `[...title].length` does (not UTF-16 units: an emoji is one character).
func askTitle(raw string) (string, error) {
	title := collapseSpace(raw)
	if title == "" {
		return "", usageError("--title is empty; give the thread a short, specific name, e.g. " + askTitleExample)
	}
	if n := utf8.RuneCountInString(title); n > askMaxTitleChars {
		return "", usageError(fmt.Sprintf("--title is %d characters; use at most %d characters", n, askMaxTitleChars))
	}
	return title, nil
}

// replyEnvelope fences the reply as untrusted data. A closing tag inside, matched in any case, is
// replaced by the lowercase constant, as Node's text.replace(/<\/untrusted-reply/gi, …) does.
func replyEnvelope(m *askMessage, text string) string {
	body := untrustedCloseRE.ReplaceAllLiteralString(text, `<\/untrusted-reply`)
	return fmt.Sprintf("<untrusted-reply from=\"%s\" thread=\"%s\" message=\"%s\">\n%s\n</untrusted-reply>", m.Target, m.Thread, m.Message, body)
}

// jsNumberFrom is Number(s) for a string.
func jsNumberFrom(s string) float64 {
	t := strings.TrimFunc(s, isJSWhitespace)
	if t == "" {
		return 0
	}
	lower := strings.ToLower(t)
	for _, p := range []struct {
		prefix string
		base   int
	}{{"0x", 16}, {"0o", 8}, {"0b", 2}} {
		if strings.HasPrefix(lower, p.prefix) {
			n, err := strconv.ParseUint(t[2:], p.base, 64)
			if err != nil {
				return math.NaN()
			}
			return float64(n)
		}
	}
	if t == "Infinity" || t == "+Infinity" {
		return math.Inf(1)
	}
	if t == "-Infinity" {
		return math.Inf(-1)
	}
	for _, r := range t {
		if !(r >= '0' && r <= '9') && r != '.' && r != 'e' && r != 'E' && r != '+' && r != '-' {
			return math.NaN()
		}
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

// askTimeoutSeconds is --timeout, or 0 for none.
func askTimeoutSeconds(a *ParsedArgs) (float64, bool, error) {
	if !a.Has("timeout") {
		return 0, false, nil
	}
	raw, isStr := a.Str("timeout")
	n := jsNumberFrom(raw)
	if !isStr || math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 {
		return 0, false, usageError("--timeout takes a number of seconds")
	}
	return n, true, nil
}

func isTransient(err error) (*CliError, bool) {
	var ce *CliError
	if !errors.As(err, &ce) {
		return nil, false
	}
	return ce, ce.Code == "unreachable" || ce.Code == "timeout" || ce.Status == 502 || ce.Status == 503 || ce.Status == 504
}

func (c *Ctx) askRetryFor() time.Duration {
	if c.AskRetryFor > 0 {
		return c.AskRetryFor
	}
	return askRetryFor
}

func (c *Ctx) askPollInterval() time.Duration {
	if c.PollInterval > 0 {
		return c.PollInterval
	}
	return askRetryDelay
}

// waitForMessage long-polls until the message finishes (one 50 s request at a time), once with
// --no-wait, or until --timeout. An orchestrator that stops answering is retried with backoff.
func waitForMessage(c *Ctx, api *Api, firstID string, a *ParsedArgs, announced bool) (*askMessage, error) {
	id := firstID
	noWait := a.Bool("no-wait")
	limit, hasLimit, err := askTimeoutSeconds(a)
	if err != nil {
		return nil, err
	}
	var deadline time.Time
	if hasLimit {
		deadline = c.now().Add(time.Duration(limit * float64(time.Second)))
	}
	retryFor := c.askRetryFor()
	base := c.askPollInterval()
	kept := false
	later := func() string {
		if kept {
			return fmt.Sprintf("`termag ask --reply %s` waits again while it runs, and prints the reply once it has finished", id)
		}
		return fmt.Sprintf("`termag ask --reply %s` waits again while it runs (the reply goes only to a waiting poll)", id)
	}
	stillRunning := func() error {
		return newErr("timeout", fmt.Sprintf("Still running after %ss; %s", jsNumber(limit), later()))
	}
	notified := announced
	var failingSince time.Time
	failing := false
	delay := base
	for {
		wait := askWaitS
		if hasLimit {
			left := int(math.Max(0, math.Ceil(float64(deadline.Sub(c.now()))/float64(time.Second))))
			if left < wait {
				wait = left
			}
		}
		if noWait {
			wait = 0
		}
		raw, err := api.RequestRaw(context.Background(), "GET", fmt.Sprintf("/ask/messages/%s?wait=%d", id, wait), nil)
		if err != nil {
			ce, transient := isTransient(err)
			if noWait || !transient {
				return nil, err
			}
			now := c.now()
			if !failing {
				failing, failingSince = true, now
				if !a.JSON {
					c.Err(fmt.Sprintf("termag: %s; retrying (message %s)…", ce.Message, id))
				}
			}
			if now.Sub(failingSince) >= retryFor {
				return nil, &CliError{Code: ce.Code, Message: fmt.Sprintf("%s; gave up retrying, %s", ce.Message, later()), Status: ce.Status}
			}
			if hasLimit && !now.Before(deadline) {
				return nil, stillRunning()
			}
			d := delay
			if hasLimit && deadline.Sub(now) < d {
				d = deadline.Sub(now)
			}
			c.sleep(d)
			delay *= 2
			if delay > askRetryDelayMax {
				delay = askRetryDelayMax
			}
			continue
		}
		failing = false
		delay = base
		m, err := parseAskMessage(raw)
		if err != nil {
			return nil, err
		}
		kept = m.ReplyKept != nil && *m.ReplyKept
		if m.Status == "superseded" && truthy(m.SupersededBy) && !noWait {
			if !a.JSON {
				c.Err(fmt.Sprintf("termag: %s was superseded by message %s; waiting for that reply…", id, *m.SupersededBy))
			}
			id = *m.SupersededBy
			continue
		}
		if askFinished(m.Status) && truthy(m.AnsweredWith) && !a.JSON {
			c.Err("termag: answered together with follow-up " + *m.AnsweredWith)
		}
		if askFinished(m.Status) || noWait {
			return m, nil
		}
		if hasLimit && !c.now().Before(deadline) {
			return nil, stillRunning()
		}
		if !notified && !a.JSON {
			c.Err(fmt.Sprintf("termag: waiting for %s (message %s, thread %s)…", m.Target, id, m.Thread))
			notified = true
		}
	}
}

// askSender is the session this ask comes from.
func askSender(c *Ctx) *Object {
	claude := strings.TrimFunc(c.Getenv("CLAUDE_CODE_SESSION_ID"), isJSWhitespace)
	hasClaude := claude != "" && claudeSessionRE.MatchString(claude)
	projectID := strings.TrimFunc(c.Getenv("TERMAG_PROJECT_ID"), isJSWhitespace)
	workstream := strings.TrimFunc(c.Getenv("TERMAG_WORKSTREAM"), isJSWhitespace)
	withClaude := func(o *Object) *Object {
		if hasClaude {
			o.Set("claudeSession", claude)
		}
		return o
	}
	if projectID != "" && workstream != "" {
		return withClaude(newObject().Set("projectId", projectID).Set("workstream", workstream))
	}
	if c.Getenv("TMUX") != "" {
		if s := tmuxSessionName(c); s != "" {
			return withClaude(newObject().Set("session", s))
		}
	}
	if hasClaude {
		return newObject().Set("claudeSession", claude)
	}
	return nil
}

// tmuxSessionHook replaces the tmux call in tests.
var tmuxSessionHook func() string

// tmuxSessionName: `tmux display-message -p '#S'`, with a 2 s limit.
func tmuxSessionName(c *Ctx) string {
	if tmuxSessionHook != nil {
		return tmuxSessionHook()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tmux", "display-message", "-p", "#S").Output()
	if err != nil {
		return ""
	}
	return strings.TrimFunc(string(out), isJSWhitespace)
}

// postAsk is POST /ask, retried like a poll through a deploy: the message id is ours, so the
// orchestrator answers a repeat with the ask it already started.
func postAsk(c *Ctx, api *Api, body *Object, id string, a *ParsedArgs) (*askStarted, error) {
	retryFor := c.askRetryFor()
	delay := c.askPollInterval()
	var failingSince time.Time
	failing := false
	for {
		raw, err := api.RequestRaw(context.Background(), "POST", "/ask", body)
		if err == nil {
			var s askStarted
			if err := json.Unmarshal(raw, &s); err != nil {
				return nil, newErr("failed", "Unexpected answer from the orchestrator: "+err.Error())
			}
			s.raw = newObject()
			_ = s.raw.UnmarshalJSON(raw)
			_, s.hasModel = s.raw.Get("model")
			return &s, nil
		}
		ce, transient := isTransient(err)
		if !transient {
			return nil, err
		}
		now := c.now()
		if !failing {
			failing, failingSince = true, now
			if !a.JSON {
				c.Err(fmt.Sprintf("termag: %s; retrying the ask (message %s)…", ce.Message, id))
			}
		}
		if now.Sub(failingSince) >= retryFor {
			return nil, &CliError{Code: ce.Code, Status: ce.Status, Message: fmt.Sprintf("%s; gave up retrying. The ask may have started: `termag ask --reply %s` waits for it, or check `termag ask --inbox`", ce.Message, id)}
		}
		c.sleep(delay)
		delay *= 2
		if delay > askRetryDelayMax {
			delay = askRetryDelayMax
		}
	}
}

func replyLost(m *askMessage) bool {
	return askFinished(m.Status) && m.Reply == nil && m.ReplyBytes != nil
}

func replyGone(c *Ctx, m *askMessage) string {
	old := false
	if m.CompletedAt != nil {
		if t, ok := parseJSDate(*m.CompletedAt); ok {
			old = c.now().Sub(t) > askReplyKeptPeriod
		}
	}
	if m.ReplyKept != nil && *m.ReplyKept && old {
		return fmt.Sprintf("The reply to %s was kept for 14 days and has been deleted. Ask again (`--thread %s` keeps the context).", m.Message, m.Thread)
	}
	if m.ReplyDelivered {
		return fmt.Sprintf("The reply to %s went to an earlier poll and was not stored.", m.Message)
	}
	return fmt.Sprintf("The reply to %s was not delivered: nothing was waiting when it arrived, and it was not stored. Ask again (`--thread %s` keeps the context).", m.Message, m.Thread)
}

func commitsState(m *askMessage) string {
	if !askFinished(m.Status) || m.Status == "canceled" || m.Status == "superseded" || m.Publish == nil {
		return "-"
	}
	if m.Publish.Status == "published" {
		return "pushed"
	}
	return m.Publish.Status
}

func printMessage(c *Ctx, m *askMessage) {
	sup := strOr(m.SupersededBy, "")
	switch {
	case m.Reply != nil:
		c.Out(replyEnvelope(m, *m.Reply))
	case m.Status == "superseded":
		by, wait := "a follow-up", "<message>"
		if m.SupersededBy != nil {
			by, wait = *m.SupersededBy, *m.SupersededBy
		}
		c.Out(fmt.Sprintf("The ask %s was superseded by %s, which went into its turn and whose reply answers it: `termag ask --reply %s` waits for that.", m.Message, by, wait))
	case !askFinished(m.Status) && sup != "":
		c.Out(fmt.Sprintf("Still running on %s: follow-up %s joined its turn, and the reply at the turn's end answers both; `termag ask --reply %s` waits for it.", m.Target, sup, m.Message))
	case !askFinished(m.Status):
		tail := " (only a waiting poll gets the reply)"
		if m.ReplyKept != nil && *m.ReplyKept {
			tail = ", or prints the reply once it has finished"
		}
		c.Out(fmt.Sprintf("Still running on %s; `termag ask --reply %s` waits for it%s.", m.Target, m.Message, tail))
	case m.Status == "canceled":
		why := ""
		if truthy(m.Error) {
			why = " (" + *m.Error + ")"
		}
		c.Out(fmt.Sprintf("The ask %s was canceled%s; nothing came back.", m.Message, why))
	case m.ReplyBytes == nil:
		c.Out(fmt.Sprintf("No reply came back for %s.", m.Message))
	default:
		c.Out(replyGone(c, m))
	}
	if m.Status == "failed" && truthy(m.Error) {
		c.Err("termag: the run failed: " + *m.Error)
	}
	if cs := commitsState(m); cs != "-" {
		c.Out("commits: " + cs)
	}
	for _, p := range m.prs {
		line := "pr: " + p.URL
		if b := p.branchText(); b != "" {
			line += " (" + b + ")"
		}
		c.Out(line)
	}
	if m.Publish != nil && m.Publish.Status != "published" && m.Publish.Status != "none" && truthy(m.Publish.Detail) {
		what := "commits not published"
		if m.Publish.Status == "partial" {
			what = "some branches not published"
		}
		c.Err(fmt.Sprintf("termag: %s: %s", what, *m.Publish.Detail))
	}
	c.Out("thread: " + m.Thread)
}

func askExitFor(m *askMessage) int {
	if m.Status == "failed" || m.Status == "canceled" || replyLost(m) {
		return ExitFailed
	}
	return ExitOK
}

// replyState is the inbox's REPLY column.
func replyState(m *askMessage) string {
	if m.Status == "superseded" {
		if truthy(m.SupersededBy) {
			return "-> " + *m.SupersededBy
		}
		return "-"
	}
	if !askFinished(m.Status) || m.Status == "canceled" {
		return "-"
	}
	if m.ReplyBytes == nil {
		return "none"
	}
	if m.ReplyStored != nil && *m.ReplyStored {
		if m.ReplyDelivered {
			return "read"
		}
		return "NEW"
	}
	if m.ReplyDelivered {
		return "delivered"
	}
	return "dropped"
}

func prColumn(m *askMessage) string {
	if len(m.prs) == 0 {
		return "-"
	}
	if len(m.prs) > 1 {
		return fmt.Sprintf("%s (+%d)", m.prs[0].URL, len(m.prs)-1)
	}
	return m.prs[0].URL
}

func askApi(c *Ctx, a *ParsedArgs, timeout time.Duration) (*Api, error) {
	s, err := newSession(c, a)
	if err != nil {
		return nil, err
	}
	return authedApi(c, s, timeout)
}

func cmdAskInbox(c *Ctx, a *ParsedArgs) (int, error) {
	api, err := askApi(c, a, 0)
	if err != nil {
		return 0, err
	}
	var res struct {
		Messages []json.RawMessage `json:"messages"`
	}
	if err := api.Request(context.Background(), "GET", "/ask/inbox", nil, &res); err != nil {
		return 0, err
	}
	var msgs []*askMessage
	for _, r := range res.Messages {
		m, err := parseAskMessage(r)
		if err != nil {
			return 0, err
		}
		msgs = append(msgs, m)
	}
	if a.JSON {
		tasks := []any{}
		for _, m := range msgs {
			tasks = append(tasks, a2aTask(m))
		}
		c.Out(JSONText(newObject().Set("tasks", tasks)))
		return ExitOK, nil
	}
	if len(msgs) == 0 {
		c.Out("Nothing submitted, working or finished in the last day.")
		return ExitOK, nil
	}
	var rows [][]string
	for _, m := range msgs {
		rows = append(rows, []string{m.Message, m.Thread, m.Target, m.Status, replyState(m), commitsState(m), prColumn(m),
			strOr(m.Notice, "-"), strOr(m.Model, "-"), strOr(m.Title, "")})
	}
	c.Out(Table([]string{"MESSAGE", "THREAD", "TARGET", "STATUS", "REPLY", "COMMITS", "PR", "NOTICE", "MODEL", "TITLE"}, rows))
	return ExitOK, nil
}

// targetCard is one A2A agent card of GET /ask/targets; raw passes through for --json.
type targetCard struct {
	Raw         json.RawMessage `json:"-"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Provider    struct {
		Organization string `json:"organization"`
	} `json:"provider"`
	Capabilities struct {
		Extensions []struct {
			URI    string `json:"uri"`
			Params *struct {
				Askable      bool    `json:"askable"`
				Reason       *string `json:"reason"`
				Shared       bool    `json:"shared"`
				SessionTitle *string `json:"sessionTitle"`
			} `json:"params"`
		} `json:"extensions"`
	} `json:"capabilities"`
}

func (t targetCard) MarshalJSON() ([]byte, error) { return t.Raw, nil }

func (t *targetCard) UnmarshalJSON(b []byte) error {
	type plain targetCard
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*t = targetCard(p)
	t.Raw = append(json.RawMessage(nil), b...)
	return nil
}

type askParamsView struct {
	Askable      bool
	Reason       *string
	Shared       bool
	SessionTitle *string
}

func askParams(t *targetCard) *askParamsView {
	for _, e := range t.Capabilities.Extensions {
		if e.URI == askExtensionURI {
			if e.Params == nil {
				return nil
			}
			return &askParamsView{e.Params.Askable, e.Params.Reason, e.Params.Shared, e.Params.SessionTitle}
		}
	}
	return nil
}

func askableText(t *targetCard) string {
	if t == nil {
		return "?"
	}
	p := askParams(t)
	if p == nil {
		return "?"
	}
	if p.Askable {
		return "yes"
	}
	return "no: " + strOr(p.Reason, "unknown")
}

func cmdAskTargets(c *Ctx, a *ParsedArgs) (int, error) {
	api, err := askApi(c, a, 0)
	if err != nil {
		return 0, err
	}
	var res struct {
		Agents []targetCard `json:"agents"`
	}
	if err := api.Request(context.Background(), "GET", "/ask/targets", nil, &res); err != nil {
		return 0, err
	}
	if res.Agents == nil {
		res.Agents = []targetCard{}
	}
	if a.JSON {
		c.Out(JSONText(newObject().Set("agents", res.Agents)))
		return ExitOK, nil
	}
	if len(res.Agents) == 0 {
		c.Out("No projects of yours on a box of yours to ask: create one.")
		return ExitOK, nil
	}
	var rows [][]string
	for i := range res.Agents {
		t := &res.Agents[i]
		p := askParams(t)
		owner := t.Provider.Organization
		title := "-"
		if p != nil {
			if p.Shared {
				owner += " (shared)"
			}
			if truthy(p.SessionTitle) {
				title = *p.SessionTitle
			}
		}
		desc := t.Description
		if desc == "" {
			desc = "-"
		}
		rows = append(rows, []string{t.Name, owner, askableText(t), title, desc})
	}
	c.Out(Table([]string{"TARGET", "OWNER", "ASKABLE", "TITLE", "DESCRIPTION"}, rows))
	return ExitOK, nil
}

// threadTarget is one of your ask threads with a chat (GET /ask/targets `threads`).
type threadTarget struct {
	Raw          json.RawMessage `json:"-"`
	Thread       string          `json:"thread"`
	Title        *string         `json:"title"`
	SessionTitle *string         `json:"sessionTitle"`
	Target       string          `json:"target"`
}

func (t threadTarget) MarshalJSON() ([]byte, error) { return t.Raw, nil }

func (t *threadTarget) UnmarshalJSON(b []byte) error {
	type plain threadTarget
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*t = threadTarget(p)
	t.Raw = append(json.RawMessage(nil), b...)
	return nil
}

var jsWhitespaceRun = regexp.MustCompile(`[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)

// collapseSpace is s.replace(/\s+/g, ' ').trim().
func collapseSpace(s string) string {
	return strings.TrimFunc(jsWhitespaceRun.ReplaceAllString(s, " "), isJSWhitespace)
}

func findNorm(s string) string { return collapseSpace(strings.ToLower(norm.NFKC.String(s))) }

type foundSession struct {
	card   *targetCard
	thread *threadTarget
	title  string
	exact  bool
}

// findSessions: every word of the query in the session's title or address, exact titles first.
func findSessions(query string, agents []targetCard, threads []threadTarget) []foundSession {
	q := findNorm(query)
	var words []string
	for _, w := range strings.Split(q, " ") {
		if w != "" {
			words = append(words, w)
		}
	}
	matches := func(texts ...*string) bool {
		var parts []string
		for _, t := range texts {
			if truthy(t) {
				parts = append(parts, *t)
			}
		}
		hay := findNorm(strings.Join(parts, " "))
		if len(words) == 0 {
			return false
		}
		for _, w := range words {
			if !strings.Contains(hay, w) {
				return false
			}
		}
		return true
	}
	exact := func(texts ...*string) bool {
		for _, t := range texts {
			if t != nil && findNorm(*t) == q {
				return true
			}
		}
		return false
	}
	var found []foundSession
	for i := range agents {
		card := &agents[i]
		var title *string
		if p := askParams(card); p != nil {
			title = p.SessionTitle
		}
		name := card.Name
		if matches(title, &name) {
			t := "-"
			if truthy(title) {
				t = *title
			}
			found = append(found, foundSession{card: card, title: t, exact: exact(title)})
		}
	}
	for i := range threads {
		th := &threads[i]
		id := th.Thread
		askID := "ask-" + th.Thread
		if matches(th.Title, th.SessionTitle, &id, &askID) {
			t := askID
			if truthy(th.Title) {
				t = *th.Title
			} else if truthy(th.SessionTitle) {
				t = *th.SessionTitle
			}
			found = append(found, foundSession{thread: th, title: t, exact: exact(th.Title, th.SessionTitle)})
		}
	}
	var out []foundSession
	for _, f := range found {
		if f.exact {
			out = append(out, f)
		}
	}
	for _, f := range found {
		if !f.exact {
			out = append(out, f)
		}
	}
	return out
}

func cmdAskFind(c *Ctx, a *ParsedArgs, query string) (int, error) {
	api, err := askApi(c, a, 0)
	if err != nil {
		return 0, err
	}
	var res struct {
		Agents  []targetCard   `json:"agents"`
		Threads []threadTarget `json:"threads"`
	}
	if err := api.Request(context.Background(), "GET", "/ask/targets", nil, &res); err != nil {
		return 0, err
	}
	found := findSessions(query, res.Agents, res.Threads)
	if a.JSON {
		agents, threads := []any{}, []any{}
		for _, f := range found {
			if f.card != nil {
				agents = append(agents, f.card)
			} else {
				threads = append(threads, f.thread)
			}
		}
		c.Out(JSONText(newObject().Set("agents", agents).Set("threads", threads)))
		if len(found) > 0 {
			return ExitOK, nil
		}
		return ExitNotFound, nil
	}
	if len(found) == 0 {
		c.Out(fmt.Sprintf("No session or ask thread of yours is titled like \"%s\". `termag ask --targets` lists every target with its title.", query))
		return ExitNotFound, nil
	}
	byName := map[string]*targetCard{} // new Map(...): a later name wins
	for i := range res.Agents {
		byName[res.Agents[i].Name] = &res.Agents[i]
	}
	var rows [][]string
	anyThread := false
	for _, f := range found {
		if f.card != nil {
			rows = append(rows, []string{f.card.Name, "-", askableText(f.card), f.title})
		} else {
			anyThread = true
			rows = append(rows, []string{f.thread.Target, f.thread.Thread, askableText(byName[f.thread.Target]), f.title})
		}
	}
	c.Out(Table([]string{"TARGET", "THREAD", "ASKABLE", "TITLE"}, rows))
	c.Out("")
	if anyThread {
		c.Out("Ask one: termag ask <TARGET> - < <prompt file>; for a THREAD, add --thread <THREAD> to talk to that same session.")
	} else {
		c.Out("Ask one: termag ask <TARGET> - < <prompt file>")
	}
	return ExitOK, nil
}

func cmdAskCancel(c *Ctx, a *ParsedArgs, id string) (int, error) {
	api, err := askApi(c, a, 0)
	if err != nil {
		return 0, err
	}
	raw, err := api.RequestRaw(context.Background(), "POST", "/ask/messages/"+id+"/cancel", nil)
	if err != nil {
		return 0, err
	}
	m, err := parseAskMessage(raw)
	if err != nil {
		return 0, err
	}
	if a.JSON {
		c.Out(JSONText(a2aTask(m)))
		return ExitOK, nil
	}
	var stop struct {
		Stop *struct {
			Detail string `json:"detail"`
		} `json:"stop"`
	}
	_ = json.Unmarshal(raw, &stop)
	if stop.Stop != nil {
		c.Out(fmt.Sprintf("Canceled %s on %s: %s.", m.Message, m.Target, stop.Stop.Detail))
	} else {
		c.Out(fmt.Sprintf("%s on %s was already canceled.", m.Message, m.Target))
	}
	c.Out("thread: " + m.Thread)
	return ExitOK, nil
}

// askModelOption is --model: a Claude tier (any case) or a Fireworks model; "" without it.
func askModelOption(a *ParsedArgs) (string, error) {
	if !a.Has("model") {
		return "", nil
	}
	raw, _ := a.Str("model")
	value := strings.TrimFunc(raw, isJSWhitespace)
	lower := strings.ToLower(value)
	for _, m := range claudeModels {
		if lower == m {
			return lower, nil
		}
	}
	fw := value
	if len(value) >= 9 && strings.EqualFold(value[:9], "fireworks") && (len(value) == 9 || value[9] == ':') {
		fw = "fireworks" + value[9:]
	}
	if fireworksModelRE.MatchString(fw) && fw != "fireworks:" {
		return fw, nil
	}
	return "", usageError(fmt.Sprintf("--model takes %s, or fireworks:<model> for a Fireworks model (e.g. fireworks:kimi-k3)", strings.Join(claudeModels, ", ")))
}

func isClaudeModel(m string) bool {
	for _, x := range claudeModels {
		if x == m {
			return true
		}
	}
	return false
}

func readPrompt(c *Ctx, raw string) (string, error) {
	if raw != "-" {
		return raw, nil
	}
	if c.Stdin == nil {
		return "", usageError("reading the prompt from stdin is not available here")
	}
	b, err := io.ReadAll(c.Stdin)
	if err != nil {
		return "", newErr("failed", err.Error())
	}
	return string(b), nil
}

func cmdAsk(c *Ctx, a *ParsedArgs) (int, error) {
	reply, hasReply := a.Options["reply"]
	cancel, hasCancel := a.Options["cancel"]
	find, hasFind := a.Options["find"]
	inbox, targets := a.Bool("inbox"), a.Bool("targets")
	if a.Has("model") && (inbox || targets || hasFind || hasCancel || hasReply) {
		return 0, usageError("--model goes with an ask: termag ask <box>/<project> <prompt|-> --model opus|sonnet|haiku|fireworks:<model>")
	}
	if inbox {
		if len(a.Args) > 0 || hasReply || hasCancel || targets || hasFind {
			return 0, usageError("--inbox takes no other arguments")
		}
		return cmdAskInbox(c, a)
	}
	if targets {
		if len(a.Args) > 0 || hasReply || hasCancel || hasFind {
			return 0, usageError("--targets takes no other arguments")
		}
		return cmdAskTargets(c, a)
	}
	if hasFind {
		if len(a.Args) > 0 || hasReply || hasCancel {
			return 0, usageError("--find takes no other arguments")
		}
		if !find.IsStr || strings.TrimFunc(find.Str, isJSWhitespace) == "" {
			return 0, usageError("Usage: termag ask --find <title>")
		}
		return cmdAskFind(c, a, find.Str)
	}
	if hasCancel {
		if len(a.Args) > 0 || hasReply || !cancel.IsStr || !askIDRE.MatchString(cancel.Str) {
			return 0, usageError("Usage: termag ask --cancel <message>")
		}
		return cmdAskCancel(c, a, cancel.Str)
	}
	s, err := newSession(c, a)
	if err != nil {
		return 0, err
	}
	if hasReply {
		if len(a.Args) > 0 || !reply.IsStr || !askIDRE.MatchString(reply.Str) {
			return 0, usageError("Usage: termag ask --reply <message>")
		}
		api, err := authedApi(c, s, askRequestTimeout)
		if err != nil {
			return 0, err
		}
		m, err := waitForMessage(c, api, reply.Str, a, false)
		if err != nil {
			return 0, err
		}
		if truthy(m.ModelIgnored) {
			c.Err("termag: warning: its --model was ignored: " + *m.ModelIgnored)
		}
		if a.JSON {
			c.Out(JSONText(a2aTask(m)))
		} else {
			printMessage(c, m)
		}
		return askExitFor(m), nil
	}
	// --new-box makes the box and the project (lifecycle.ts): the Node CLI runs it until that is ported.
	// TODO(cli-go phase 2): port projectOnNewBox and run --new-box here.
	if a.Bool("new-box") {
		return 0, errFallback
	}

	var target, rawPrompt string
	hasPrompt := false
	if len(a.Args) > 0 {
		target = a.Args[0]
	}
	if len(a.Args) > 1 {
		rawPrompt, hasPrompt = a.Args[1], true
	}
	if target == "" || !hasPrompt {
		return 0, usageError("Usage: " + strings.TrimSpace(strings.Split(specByName["ask"].Usage, "\n")[0]))
	}
	if !askRefRE.MatchString(target) {
		return 0, usageError(fmt.Sprintf("\"%s\" is not <box>/<project>[@<workstream>][:<repo>]", target))
	}
	thread, hasThread := a.Options["thread"]
	if hasThread && (!thread.IsStr || !askIDRE.MatchString(thread.Str)) {
		return 0, usageError("--thread takes a thread id")
	}
	// newBoxOptions without --new-box: its options go with it.
	if a.Has("size") || a.Has("disk") || len(a.Lists["from"]) > 0 || a.Has("from") || a.Has("environment") {
		return 0, usageError("--size, --disk, --from and --environment go with --new-box, which makes the box and the project")
	}
	title := ""
	if rawTitle, ok := a.Str("title"); ok || a.Has("title") {
		var err error
		if title, err = askTitle(rawTitle); err != nil {
			return 0, err
		}
	}
	pr := ""
	if a.Has("update-pr") {
		raw, _ := a.Str("update-pr")
		pr = strings.TrimFunc(raw, isJSWhitespace)
		if pr == "" || !askPRRE.MatchString(pr) {
			return 0, usageError("--update-pr takes a pull request: <n>, <owner>/<name>#<n> or its github.com URL")
		}
	}
	model, err := askModelOption(a)
	if err != nil {
		return 0, err
	}
	prompt, err := readPrompt(c, rawPrompt)
	if err != nil {
		return 0, err
	}
	if strings.TrimFunc(prompt, isJSWhitespace) == "" {
		return 0, usageError("The prompt is empty")
	}
	api, err := authedApi(c, s, askRequestTimeout)
	if err != nil {
		return 0, err
	}
	askAt := target
	newID := newAskMessageID
	if c.NewMessageID != nil {
		newID = c.NewMessageID
	}
	id := newID()
	body := newObject().Set("target", askAt).Set("prompt", prompt).Set("messageId", id)
	if hasThread {
		body.Set("threadId", thread.Str)
	}
	if title != "" {
		body.Set("title", title)
	}
	if sender := askSender(c); sender != nil {
		body.Set("sender", sender)
	}
	if pr != "" {
		body.Set("pr", pr)
	}
	if model != "" {
		body.Set("model", model)
	}
	if a.Bool("no-notify") {
		body.Set("notify", false)
	}
	threadID := ""
	if hasThread {
		threadID = thread.Str
	}

	started, err := postAsk(c, api, body, id, a)
	if err != nil {
		// pickRepo is --new-box's alone, so a repo_required refusal passes through here.
		if rej, ok := isRejection(err); ok && rej.BodyString("code") == "box_offline" && !a.Bool("no-wait") {
			woke, werr := wakeBox(c, api, askAt, a)
			if werr != nil {
				return 0, werr
			}
			if woke {
				started, err = postAsk(c, api, body, id, a)
			}
		}
	}
	if err != nil {
		rej, ok := isRejection(err)
		if !ok {
			return 0, err
		}
		if a.JSON {
			c.Out(JSONText(rejectedTask(c, id, threadID, rej.Message)))
		} else {
			c.Err("termag: rejected: " + rej.Message)
		}
		return ExitFailed, nil
	}
	if !a.JSON && started.Steered {
		c.Err(fmt.Sprintf("termag: %s was still working; this follow-up went into its turn, so that message is superseded and the reply to both comes here", started.Supersedes))
	} else if !a.JSON && started.QueuedBehind != "" {
		why := ""
		if started.SteerRefused != "" {
			why = " (" + started.SteerRefused + ")"
		}
		c.Err(fmt.Sprintf("termag: %s is still working and its turn can't take this follow-up%s; it is queued as the next turn on the thread, with a reply of its own", started.QueuedBehind, why))
	}
	if model != "" && !started.hasModel && fireworksModelRE.MatchString(model) {
		var outcome string
		raw, cerr := api.RequestRaw(context.Background(), "POST", "/ask/messages/"+started.Message+"/cancel", nil)
		if cerr != nil {
			outcome = started.Message + " could not be canceled"
			c.Err(fmt.Sprintf("termag: could not cancel %s: %s", started.Message, cerr.Error()))
		} else {
			var r map[string]json.RawMessage
			_ = json.Unmarshal(raw, &r)
			stopRaw, has := r["stop"]
			var stop *struct {
				Stopped bool   `json:"stopped"`
				Detail  string `json:"detail"`
			}
			if has {
				_ = json.Unmarshal(stopRaw, &stop)
			}
			switch {
			case !has:
				outcome = started.Message + " was canceled (this orchestrator does not say whether the run stopped)"
			case stop == nil || stop.Stopped:
				outcome = started.Message + " was canceled"
			default:
				d := ""
				if stop.Detail != "" {
					d = " (" + stop.Detail + ")"
				}
				outcome = fmt.Sprintf("canceled the ask message, but the run on %s did not stop%s", started.Target, d)
			}
		}
		why := fmt.Sprintf("this orchestrator predates --model, so %s would run on Claude; %s: ask again once the deploy is out", model, outcome)
		if a.JSON {
			c.Out(JSONText(rejectedTask(c, started.Message, started.Thread, why)))
		} else {
			c.Err("termag: rejected: " + why)
		}
		return ExitFailed, nil
	}
	if model != "" && !started.hasModel {
		c.Err(fmt.Sprintf("termag: warning: --model %s was ignored: the orchestrator predates it; the ask runs on the thread's model, else the box's default", model))
	} else if model != "" && started.ModelIgnored != "" {
		c.Err(fmt.Sprintf("termag: warning: --model %s was ignored: %s", model, started.ModelIgnored))
	}
	if !a.JSON && started.TargetPr != 0 {
		remembers := ", as it remembers"
		if pr != "" {
			remembers = ""
		}
		c.Err(fmt.Sprintf("termag: the thread publishes to PR #%s (%s)%s", jsNumber(started.TargetPr), started.Branch, remembers))
	}
	if !hasThread && title == "" && !a.JSON {
		c.Err(fmt.Sprintf("termag: tip: name this thread with --title \"<short, specific name>\", e.g. %s; untitled, it shows as ask-<thread id>", askTitleExample))
	}
	if started.Queued && started.QueuedFor != "turn" && !a.JSON {
		var waitFor string
		if started.QueuedFor == "setup" {
			waitFor = started.Target + " is still being set up; the ask runs once its clone is done"
		} else {
			waitFor = strings.Split(target, "/")[0] + " is starting; the ask runs once it is up"
		}
		c.Err(fmt.Sprintf("termag: %s (the orchestrator holds it, so it runs even if this command stops)", waitFor))
	}
	if a.Bool("no-wait") {
		if a.JSON {
			c.Out(JSONText(startedTask(c, started)))
			return ExitOK, nil
		}
		told := ""
		if started.Notify != "" {
			who := "pane"
			if started.Notify == "chat" {
				who = "chat"
			}
			told = fmt.Sprintf(" termag tells this %s when it finishes, with a [termag] notice: no need to poll.", who)
		}
		hop := jsNumber(started.Hop)
		switch {
		case started.ReplyKept:
			c.Out(fmt.Sprintf("Asked %s (hop %s).%s The reply is kept for 14 days: `termag ask --reply %s` prints it once the run finishes, and waits while it runs.", started.Target, hop, told, started.Message))
		case started.Notify != "":
			c.Out(fmt.Sprintf("Asked %s (hop %s).%s The notice has no reply, and nothing keeps it: only a `termag ask --reply %s` waiting when it finishes gets it.", started.Target, hop, told, started.Message))
		default:
			c.Out(fmt.Sprintf("Asked %s (hop %s). Nothing keeps the reply: only a `termag ask --reply %s` waiting when it finishes gets it.", started.Target, hop, started.Message))
		}
		c.Out("thread: " + started.Thread)
		return ExitOK, nil
	}
	if !a.JSON {
		c.Err(fmt.Sprintf("termag: waiting for %s (message %s, thread %s)…", started.Target, started.Message, started.Thread))
	}
	m, err := waitForMessage(c, api, started.Message, a, !a.JSON)
	if err != nil {
		return 0, err
	}
	if model != "" && started.ModelIgnored == "" && truthy(m.ModelIgnored) {
		c.Err(fmt.Sprintf("termag: warning: --model %s was ignored: %s", model, *m.ModelIgnored))
	}
	if a.JSON {
		c.Out(JSONText(a2aTask(m)))
	} else {
		printMessage(c, m)
	}
	return askExitFor(m), nil
}
