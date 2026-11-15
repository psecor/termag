package cli

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// Usage reports (usage.ts): one POST /usage per run, best effort.

const reportTimeout = 1500 * time.Millisecond

// reportedAtStart: commands that report as they start (most run until someone ends them).
var reportedAtStart = map[string]bool{"tui": true, "ssh": true, "attach": true, "ssh-proxy": true, "forward": true, "events": true, "logout": true}

// awaitedAtStart: logout revokes the sign-in its report would go with, so it waits for it first.
var awaitedAtStart = map[string]bool{"logout": true}

// usageReport is the report, in usage.ts's key order.
type usageReport struct {
	Command     string `json:"command"`
	Phase       string `json:"phase"`
	Version     string `json:"version"`
	ExitCode    *int   `json:"exitCode,omitempty"`
	DurationMs  *int64 `json:"durationMs,omitempty"`
	Interactive bool   `json:"interactive"`
	ClaudeCode  bool   `json:"claudeCode"`
	// Runtime tells the orchestrator's cli.command event (termag.runtime) this Go binary from the
	// Node CLI, which sends "node" in the same place (cli/src/usage.ts RUNTIME, #1701).
	Runtime string `json:"runtime"`
}

// usageRuntime is this CLI's implementation, as the usage report names it.
const usageRuntime = "go"

func usageOptedOut(env map[string]string) bool {
	t := strings.ToLower(strings.TrimSpace(env["TERMAG_TELEMETRY"]))
	dnt := strings.TrimSpace(env["DO_NOT_TRACK"])
	return t == "0" || t == "false" || t == "off" || (dnt != "" && dnt != "0")
}

func newUsageReport(c *Ctx, command string, exitCode *int, duration time.Duration) usageReport {
	r := usageReport{Command: command, Phase: "started", Version: Version, Interactive: c.Interactive, ClaudeCode: c.Env["CLAUDECODE"] == "1", Runtime: usageRuntime}
	if exitCode != nil {
		r.Phase = "finished"
		r.ExitCode = exitCode
		ms := duration.Round(time.Millisecond).Milliseconds()
		r.DurationMs = &ms
	}
	return r
}

// usageBearer is the bearer a finished run's report goes with, never refreshed.
func usageBearer(login *StoredLogin, boxToken string, now time.Time) string {
	if login == nil {
		return boxToken
	}
	exp, ok := parseJSDate(login.AccessTokenExpiresAt())
	if login.AccessToken() != "" && ok && exp.Add(-refreshMargin).After(now) {
		return login.AccessToken()
	}
	return ""
}

// reportUsage is usageReporter: a finished run that made no request of its own hands its report
// to a detached process (the hooks' path), any other sends its own on the open connection.
func reportUsage(c *Ctx, a *ParsedArgs, r usageReport) {
	if usageOptedOut(c.Env) {
		return
	}
	s, err := newSession(c, a)
	if err != nil {
		return
	}
	var api *Api
	if r.Phase == "started" && !awaitedAtStart[r.Command] {
		if api, err = authedApi(c, s, reportTimeout); err != nil {
			return
		}
	} else {
		boxToken := ""
		if s.Target.Box != nil {
			boxToken = s.Target.Box.Token
		}
		token := usageBearer(LoadLogin(s.CredsPath, s.Target.Host), boxToken, c.now())
		if token == "" {
			return
		}
		if r.Phase == "finished" && c.PostInBackground != nil && c.requestCount() == 0 {
			req, _ := newCLIRequest(s.Target.Host, "POST", "/usage", r, token)
			c.PostInBackground(BackgroundRequest{cliRequest: req, TimeoutMs: int(reportTimeout / time.Millisecond)})
			return
		}
		api = &Api{Host: s.Target.Host, Token: token, Client: c.HTTP, Timeout: reportTimeout}
	}
	_ = api.Request(context.Background(), "POST", "/usage", r, nil)
}

// BackgroundRequest is a request another process sends (backgroundPost.ts), with its timeout.
type BackgroundRequest struct {
	cliRequest
	TimeoutMs int `json:"timeoutMs"`
}

// usagePostCommand is the hidden argv[1] of the detached sender: this binary run again.
const usagePostCommand = "__usage-post"

// postInBackground starts this binary as the detached sender and returns at once. The request,
// bearer included, goes down its stdin: never argv (ps) or the environment.
func postInBackground(req BackgroundRequest) {
	self, err := os.Executable()
	if err != nil {
		return
	}
	cmd := exec.Command(self, usagePostCommand)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return
	}
	if cmd.Start() != nil {
		return
	}
	b, _ := json.Marshal(req)
	_, _ = stdin.Write(b)
	_ = stdin.Close()
	_ = cmd.Process.Release()
}

// RunUsagePost is the detached sender: one request from stdin, sent once, never retried.
func RunUsagePost() int {
	b, err := io.ReadAll(os.Stdin)
	if err != nil {
		return 0
	}
	var r BackgroundRequest
	if json.Unmarshal(b, &r) != nil || r.URL == "" {
		return 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(r.TimeoutMs)*time.Millisecond)
	defer cancel()
	var body io.Reader
	if r.Body != nil {
		body = strings.NewReader(*r.Body)
	}
	hr, err := http.NewRequestWithContext(ctx, r.Method, r.URL, body)
	if err != nil {
		return 0
	}
	for k, v := range r.Headers {
		hr.Header.Set(k, v)
	}
	if res, err := newHTTPClient(nil).Do(hr); err == nil {
		res.Body.Close()
	}
	return 0
}
