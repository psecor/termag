package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// The ask and bug report tests run every scenario twice against the same fake orchestrator
// (fakeask_test.go): through the Node CLI and through Run. stdout, stderr, the exit code and the
// bodies the orchestrator received must be the same, byte for byte (timestamps of "now" aside).
// Without a built Node CLI (cli/dist, or TERMAG_NODE_CLI=<path to termag.js>) only the Go side
// runs, against the exit code and the checks the scenario names.

func nodeCLI(t *testing.T) string {
	if p := os.Getenv("TERMAG_NODE_CLI"); p != "" {
		return p
	}
	wd, _ := os.Getwd()
	root := filepath.Join(wd, "..", "..", "..")
	if _, err := os.Stat(filepath.Join(root, "cli", "dist", "main.js")); err != nil {
		return ""
	}
	if _, err := exec.LookPath("node"); err != nil {
		return ""
	}
	return filepath.Join(root, "cli", "bin", "termag.js")
}

type cliRun struct {
	stdout, stderr string
	exit           int
	asks, bugs     []string
}

type askScenario struct {
	name   string
	setup  func(s *fakeAsk)
	argv   []string
	stdin  string
	env    map[string]string
	files  map[string]string // written under HOME before the run; argv may name them as $HOME/<name>
	exit   int
	checks func(t *testing.T, r cliRun)
}

var isoNowRE = regexp.MustCompile(`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z`)
var messageIDRE = regexp.MustCompile(`"messageId":"[^"]*"`)

var localHostRE = regexp.MustCompile(`http://127\.0\.0\.1:\d+`)

// clientIDRE is a message id the CLI chose (a + 24 hex), random per run.
var clientIDRE = regexp.MustCompile(`\ba[0-9a-f]{24}\b`)

func normalize(s string) string {
	s = isoNowRE.ReplaceAllString(s, "<ts>")
	s = localHostRE.ReplaceAllString(s, "<host>")
	return clientIDRE.ReplaceAllString(s, "<client-id>")
}

var cliVersionRE = regexp.MustCompile(`"cliVersion":"[^"]*"`)

func bodiesOf(raws []json.RawMessage) []string {
	var out []string
	for _, r := range raws {
		b := messageIDRE.ReplaceAllString(string(r), `"messageId":"<id>"`)
		out = append(out, cliVersionRE.ReplaceAllString(b, `"cliVersion":"<v>"`))
	}
	return out
}

func scenarioEnv(t *testing.T, sc askScenario, srvURL string) (map[string]string, string) {
	home := t.TempDir()
	cfg := filepath.Join(home, "agent.config.json")
	ws := strings.Replace(srvURL, "http://", "ws://", 1) + "/termag/ws/agent"
	_ = os.WriteFile(cfg, []byte(`{"termag_url":"`+ws+`","token":"`+fakeBoxToken+`"}`), 0o600)
	for name, text := range sc.files {
		_ = os.WriteFile(filepath.Join(home, name), []byte(text), 0o600)
	}
	env := map[string]string{"HOME": home, "PATH": os.Getenv("PATH"), "TERMAG_AGENT_CONFIG": cfg, "TERMAG_TELEMETRY": "0"}
	for k, v := range sc.env {
		env[k] = v
	}
	return env, home
}

func expandArgv(argv []string, home string) []string {
	out := make([]string, len(argv))
	for i, a := range argv {
		out[i] = strings.ReplaceAll(a, "$HOME", home)
	}
	return out
}

func runGo(t *testing.T, sc askScenario) cliRun {
	s := newFakeAsk()
	if sc.setup != nil {
		sc.setup(s)
	}
	srv := startFakeAsk(t, s)
	env, home := scenarioEnv(t, sc, srv.URL)
	var out, errb bytes.Buffer
	c := &Ctx{
		Env: env, Home: home, Hostname: "zane-mbp.local",
		Out: LineWriter(&out), Err: LineWriter(&errb), HTTP: newHTTPClient(nil),
		ReadFile: func(p string) ([]byte, bool) { b, err := os.ReadFile(p); return b, err == nil },
		Stdin:    strings.NewReader(sc.stdin), Now: time.Now, Sleep: func(time.Duration) {},
	}
	tmuxSessionHook = func() string { return env["FAKE_TMUX_SESSION"] }
	defer func() { tmuxSessionHook = nil }()
	code := Run(expandArgv(sc.argv, home), c)
	return cliRun{stdout: normalize(out.String()), stderr: normalize(errb.String()), exit: code, asks: bodiesOf(s.asks), bugs: bodiesOf(s.bugs)}
}

func runNode(t *testing.T, script string, sc askScenario) cliRun {
	s := newFakeAsk()
	if sc.setup != nil {
		sc.setup(s)
	}
	srv := startFakeAsk(t, s)
	env, home := scenarioEnv(t, sc, srv.URL)
	cmd := exec.Command("node", append([]string{script}, expandArgv(sc.argv, home)...)...)
	for k, v := range env {
		if k == "FAKE_TMUX_SESSION" {
			continue
		}
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Stdin = strings.NewReader(sc.stdin)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("node: %v", err)
	}
	return cliRun{stdout: normalize(out.String()), stderr: normalize(errb.String()), exit: code, asks: bodiesOf(s.asks), bugs: bodiesOf(s.bugs)}
}

func card(name string, params map[string]any, description string) map[string]any {
	return map[string]any{"name": name, "description": description, "provider": map[string]any{"organization": "zane"},
		"capabilities": map[string]any{"streaming": false, "pushNotifications": false, "extensions": []any{map[string]any{"uri": "urn:termag:ask:v1", "params": params}}}}
}

func seedWorking(s *fakeAsk, id, thread, target string) {
	m := &fakeAskMsg{Message: id, Thread: thread, Target: target, Status: "working", Hops: 1}
	s.messages = append(s.messages, m)
	s.byClientID["seed-"+id] = m
}

var askScenarios = []askScenario{
	{name: "asks and prints the fenced reply", argv: []string{"ask", "devbox/webapp", "Where is the flag read?"},
		checks: func(t *testing.T, r cliRun) {
			if !strings.Contains(r.stdout, `<untrusted-reply from="devbox/webapp" thread="thread00001" message="message0001">`) || !strings.HasSuffix(r.stdout, "thread: thread00001\n") {
				t.Errorf("stdout %q", r.stdout)
			}
			if !strings.Contains(r.stderr, "termag: waiting for devbox/webapp (message message0001, thread thread00001)…") {
				t.Errorf("stderr %q", r.stderr)
			}
		}},
	{name: "a PR and a title", setup: func(s *fakeAsk) {
		s.pr = map[string]any{"url": "https://github.com/example-org/webapp/pull/7", "number": 7, "branch": "termag-alice/thread00001"}
	}, argv: []string{"ask", "devbox/webapp", "Fix it", "--title", "  Fix   the flag  "}},
	{name: "--json is an A2A Task, id before contextId", setup: func(s *fakeAsk) {
		s.pr = map[string]any{"url": "https://github.com/example-org/webapp/pull/7", "number": 7, "branch": "termag-alice/thread00001"}
	}, argv: []string{"ask", "devbox/webapp", "Fix it", "--json"},
		checks: func(t *testing.T, r cliRun) {
			if i, j := strings.Index(r.stdout, `"id"`), strings.Index(r.stdout, `"contextId"`); i < 0 || j < i {
				t.Errorf("id must come before contextId:\n%s", r.stdout)
			}
		}},
	{name: "several PRs, a partial publish", setup: func(s *fakeAsk) {
		s.pr = map[string]any{"url": "https://github.com/o/r/pull/7", "number": 7, "branch": "a"}
		s.prs = []map[string]any{{"key": "", "url": "https://github.com/o/r/pull/7", "number": 7, "branch": "a"}, {"key": "docs", "url": "https://github.com/o/r/pull/8", "number": 8, "branch": nil}}
		s.publish = map[string]any{"status": "partial", "detail": "pr/ci: protected paths"}
	}, argv: []string{"ask", "devbox/webapp", "Fix it", "--thread", "thread00009"}},
	{name: "several PRs --json", setup: func(s *fakeAsk) {
		s.prs = []map[string]any{{"key": "", "url": "https://github.com/o/r/pull/7", "number": 7, "branch": "a"}, {"key": "docs", "url": "https://github.com/o/r/pull/8", "number": 8, "branch": nil}}
	}, argv: []string{"ask", "devbox/webapp", "Fix it", "--json"}},
	{name: "a failed run exits 1", setup: func(s *fakeAsk) { s.outcome = "failed" }, argv: []string{"ask", "devbox/webapp", "x"}, exit: 1},
	{name: "a failed run --json", setup: func(s *fakeAsk) { s.outcome = "failed" }, argv: []string{"ask", "devbox/webapp", "x", "--json"}, exit: 1},
	{name: "the prompt from stdin", argv: []string{"ask", "devbox/webapp", "-"}, stdin: "from stdin\n"},
	{name: "an empty stdin prompt", argv: []string{"ask", "devbox/webapp", "-"}, stdin: " \n", exit: 2},
	{name: "a project it cannot reach exits 3", argv: []string{"ask", "devbox/missing", "x"}, exit: 3},
	{name: "--no-wait, reply not kept", argv: []string{"ask", "devbox/webapp", "x", "--no-wait", "--no-notify"}},
	{name: "--no-wait, kept", setup: func(s *fakeAsk) { s.stored = true }, argv: []string{"ask", "devbox/webapp", "x", "--no-wait"}},
	{name: "--no-wait, a chat notice", setup: func(s *fakeAsk) { s.notify = "chat" }, argv: []string{"ask", "devbox/webapp", "x", "--no-wait"}},
	{name: "--no-wait --json", setup: func(s *fakeAsk) { s.notify = "pane" }, argv: []string{"ask", "devbox/webapp", "x", "--no-wait", "--json"}},
	{name: "--reply waits on a working message", setup: func(s *fakeAsk) {
		s.pollsUntilDone = 2
		seedWorking(s, "message0001", "thread00001", "devbox/webapp")
	},
		argv: []string{"ask", "--reply", "message0001"}},
	{name: "--reply --no-wait on a working message", setup: func(s *fakeAsk) {
		s.pollsUntilDone = 5
		s.stored = true
		seedWorking(s, "message0001", "thread00001", "devbox/webapp")
	},
		argv: []string{"ask", "--reply", "message0001", "--no-wait"}},
	{name: "--reply to a reply nobody waited for", setup: func(s *fakeAsk) {
		s.handoffReads = 0
		seedWorking(s, "message0001", "thread00001", "devbox/webapp")
	}, argv: []string{"ask", "--reply", "message0001"}, exit: 1},
	{name: "--timeout gives up with exit 5", setup: func(s *fakeAsk) {
		s.pollsUntilDone = 1000
		s.pollDelay = 20 * time.Millisecond
		seedWorking(s, "message0001", "thread00001", "devbox/webapp")
	},
		argv: []string{"ask", "--reply", "message0001", "--timeout", "0.001"}, exit: 5},
	{name: "retries a 502 and a draining 503 on the poll", setup: func(s *fakeAsk) { s.failPolls = []int{502, 503} }, argv: []string{"ask", "devbox/webapp", "x"}},
	{name: "retries the ask itself with the same id", setup: func(s *fakeAsk) { s.failAsk = 1 }, argv: []string{"ask", "devbox/webapp", "x"},
		checks: func(t *testing.T, r cliRun) {
			if len(r.asks) != 2 || r.asks[0] != r.asks[1] {
				t.Errorf("asks %v", r.asks)
			}
		}},
	{name: "a rejection", setup: func(s *fakeAsk) { s.reject = "devbox is stopped" }, argv: []string{"ask", "devbox/webapp", "x", "--no-wait"}, exit: 1},
	{name: "a rejection --json", setup: func(s *fakeAsk) { s.reject = "devbox is stopped" }, argv: []string{"ask", "devbox/webapp", "x", "--json", "--thread", "thread00007"}, exit: 1},
	{name: "a rejection for a box that is not parked", setup: func(s *fakeAsk) {
		s.reject = "devbox is stopped"
		s.boxes = []map[string]any{{"id": "b1", "name": "devbox", "state": "running", "agentConnected": false}}
	}, argv: []string{"ask", "devbox/webapp", "x"}, exit: 1},
	{name: "wakes the caller's own stopped box, then asks again", setup: func(s *fakeAsk) {
		s.reject = "devbox is stopped"
		s.boxes = []map[string]any{{"id": "b1", "name": "devbox", "state": "stopped", "agentConnected": false}}
	}, argv: []string{"ask", "devbox/webapp", "x"}},
	{name: "held for a box that is starting", setup: func(s *fakeAsk) { s.queued = "box" }, argv: []string{"ask", "devbox/webapp", "x", "--no-wait"}},
	{name: "held for a clone", setup: func(s *fakeAsk) { s.queued = "setup" }, argv: []string{"ask", "devbox/webapp", "x", "--no-wait"}},
	{name: "--update-pr", argv: []string{"ask", "devbox/webapp", "x", "--update-pr", "example-org/webapp#1234", "--no-wait"}},
	{name: "a follow-up joins the working turn", setup: func(s *fakeAsk) { s.steer = true; seedWorking(s, "message0001", "thread00001", "devbox/webapp") },
		argv: []string{"ask", "devbox/webapp", "and also", "--thread", "thread00001", "--no-wait"}},
	{name: "a follow-up queued behind", setup: func(s *fakeAsk) {
		s.steer = "behind:no steering on this box"
		seedWorking(s, "message0001", "thread00001", "devbox/webapp")
	},
		argv: []string{"ask", "devbox/webapp", "and also", "--thread", "thread00001", "--no-wait"}},
	{name: "a wait on a superseded message, answered together", setup: func(s *fakeAsk) {
		seedWorking(s, "message0001", "thread00001", "devbox/webapp")
		seedWorking(s, "message0002", "thread00001", "devbox/webapp")
		s.messages[0].Status, s.messages[0].supersededBy = "superseded", "message0002"
	}, argv: []string{"ask", "--reply", "message0001"}},
	{name: "--model sonnet", argv: []string{"ask", "devbox/webapp", "x", "--model", "SONNET", "--no-wait"}},
	{name: "--model on an orchestrator that predates it", setup: func(s *fakeAsk) { s.model = "unknown" }, argv: []string{"ask", "devbox/webapp", "x", "--model", "opus", "--no-wait"}},
	{name: "--model ignored by the box", setup: func(s *fakeAsk) { s.model = "ignored:a headless run" }, argv: []string{"ask", "devbox/webapp", "x", "--model", "opus", "--no-wait", "--json"}},
	{name: "a Fireworks model on an orchestrator that predates --model", setup: func(s *fakeAsk) { s.model = "unknown" },
		argv: []string{"ask", "devbox/webapp", "x", "--model", "Fireworks:kimi-k3"}, exit: 1},
	{name: "who asks: a chat turn, and the Claude session", env: map[string]string{"TERMAG_PROJECT_ID": "p1", "TERMAG_WORKSTREAM": "main", "CLAUDE_CODE_SESSION_ID": "0123abcd-ef"},
		argv: []string{"ask", "devbox/webapp", "x", "--no-wait"}},
	{name: "--cancel", setup: func(s *fakeAsk) { seedWorking(s, "message0001", "thread00001", "devbox/webapp") }, argv: []string{"ask", "--cancel", "message0001"}},
	{name: "--cancel --json", setup: func(s *fakeAsk) { seedWorking(s, "message0001", "thread00001", "devbox/webapp") }, argv: []string{"ask", "--cancel", "message0001", "--json"}},
	{name: "--cancel a finished ask", setup: func(s *fakeAsk) {
		seedWorking(s, "message0001", "thread00001", "devbox/webapp")
		s.messages[0].Status = "completed"
	}, argv: []string{"ask", "--cancel", "message0001"}, exit: 1},
	{name: "--inbox", setup: func(s *fakeAsk) {
		s.stored = true
		s.pr = map[string]any{"url": "https://github.com/o/r/pull/7", "number": 7, "branch": "b"}
		seedWorking(s, "message0001", "thread00001", "devbox/webapp")
		seedWorking(s, "message0002", "thread00002", "lab/api@fix")
		s.messages[1].Status = "completed"
	}, argv: []string{"ask", "--inbox"}},
	{name: "--inbox --json", setup: func(s *fakeAsk) {
		seedWorking(s, "message0001", "thread00001", "devbox/webapp")
		s.messages[0].Status = "failed"
	}, argv: []string{"ask", "--inbox", "--json"}},
	{name: "--inbox empty", argv: []string{"ask", "--inbox"}},
	{name: "--targets", setup: func(s *fakeAsk) {
		s.targets = []any{card("devbox/webapp", map[string]any{"askable": true, "reason": nil, "shared": false}, "Example app"),
			card("lab/api@fix", map[string]any{"askable": false, "reason": "lab is not connected (stopped)", "shared": true}, ""),
			card("devbox/webapp@login", map[string]any{"askable": true, "reason": nil, "shared": false, "sessionTitle": "Fix login redirect"}, "")}
	}, argv: []string{"ask", "--targets"}},
	{name: "--find, exact titles first", setup: setupFind, argv: []string{"ask", "--find", "login  REDIRECT"}},
	{name: "--find an exact thread title", setup: setupFind, argv: []string{"ask", "--find", "fix login redirect tests"}},
	{name: "--find by thread id", setup: setupFind, argv: []string{"ask", "--find", "ask-thread00002"}},
	{name: "--find a target that can't take an ask", setup: setupFind, argv: []string{"ask", "--find", "cookies"}},
	{name: "--find --json", setup: setupFind, argv: []string{"ask", "--find", "composer", "--json"}},
	{name: "--find nothing", setup: setupFind, argv: []string{"ask", "--find", "nothing like it"}, exit: 3},
	{name: "--find NFKC", setup: setupFind, argv: []string{"ask", "--find", "ｃｏｍｐｏｓｅｒ"}},

	{name: "bug report", argv: []string{"bug", "report", "--title", " CLI broke ", "--area", "cli", "-"}, stdin: "it broke\n",
		env: map[string]string{"AI_AGENT": "claude-code_2-1-312_agent", "ANTHROPIC_MODEL": " claude-opus "}},
	{name: "bug report redacts and tails the error file", argv: []string{"bug", "report", "--title", "token " + fakeBoxToken + " leaked", "--severity", "high", "--command", "termag ask", "--error-file", "$HOME/err.txt", "-"},
		stdin: "body with ghp_" + strings.Repeat("a", 40) + "\n", files: map[string]string{"err.txt": "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n" + strings.Repeat("x", 25000)},
		env: map[string]string{"CODEX_SANDBOX": "1", "TERMAG_PROJECT_ID": "p1"}},
	{name: "bug report --json merges the server's redactions", setup: func(s *fakeAsk) {
		s.bugAnswer = map[string]any{"id": "bug0002", "status": "new", "redacted": []any{"Slack token", "GitHub token"}}
	}, argv: []string{"bug", "report", "--title", "x", "--agent", "codex", "--model", "o3", "-", "--json"}, stdin: "ghp_" + strings.Repeat("b", 40)},
	{name: "bug report without stdin's -", argv: []string{"bug", "report", "--title", "x"}, exit: 2},
	{name: "bug report a missing error file", argv: []string{"bug", "report", "--title", "x", "--error-file", "/nope/none", "-"}, stdin: "b", exit: 3},
	{name: "bug report an empty body", argv: []string{"bug", "report", "--title", "x", "-"}, stdin: "  \n", exit: 2},
}

func setupFind(s *fakeAsk) {
	cardOf := func(name string, title any, askable bool) map[string]any {
		var reason any
		if !askable {
			reason = "lab is not connected (stopped)"
		}
		return card(name, map[string]any{"askable": askable, "reason": reason, "shared": false, "sessionTitle": title}, "")
	}
	s.targets = []any{cardOf("devbox/webapp", nil, true), cardOf("devbox/webapp@login", "Fix the login redirect", true), cardOf("lab/api@cookies", "Login cookies", false)}
	thread := func(id string, title, sessionTitle any) map[string]any {
		return map[string]any{"thread": id, "title": title, "sessionTitle": sessionTitle, "target": "devbox/webapp", "updatedAt": "2026-10-28T12:00:00.000Z"}
	}
	s.threads = []any{thread("thread00001", "Members-only file composer (#765)", "Gate the composer"), thread("thread00002", nil, "Fix login redirect tests")}
}

func TestAskAndBugReportAgainstNode(t *testing.T) {
	script := nodeCLI(t)
	if script == "" {
		t.Log("no built Node CLI: checking the Go side alone")
	}
	for _, sc := range askScenarios {
		t.Run(sc.name, func(t *testing.T) {
			g := runGo(t, sc)
			if g.exit != sc.exit {
				t.Errorf("exit %d, want %d\nstdout: %s\nstderr: %s", g.exit, sc.exit, g.stdout, g.stderr)
			}
			if sc.checks != nil {
				sc.checks(t, g)
			}
			if script == "" {
				return
			}
			n := runNode(t, script, sc)
			if n.stdout != g.stdout {
				t.Errorf("stdout differs\n--- node\n%s\n--- go\n%s", n.stdout, g.stdout)
			}
			if n.stderr != g.stderr {
				t.Errorf("stderr differs\n--- node\n%s\n--- go\n%s", n.stderr, g.stderr)
			}
			if n.exit != g.exit {
				t.Errorf("exit: node %d, go %d", n.exit, g.exit)
			}
			if strings.Join(n.asks, "\n") != strings.Join(g.asks, "\n") {
				t.Errorf("POST /ask bodies differ\n--- node\n%s\n--- go\n%s", strings.Join(n.asks, "\n"), strings.Join(g.asks, "\n"))
			}
			if strings.Join(n.bugs, "\n") != strings.Join(g.bugs, "\n") {
				t.Errorf("POST /bug-reports bodies differ\n--- node\n%s\n--- go\n%s", strings.Join(n.bugs, "\n"), strings.Join(g.bugs, "\n"))
			}
		})
	}
}

func TestReplyEnvelopeDefusesClosingTag(t *testing.T) {
	m := &askMessage{Target: "devbox/webapp", Thread: "t1", Message: "m1"}
	// Any case is matched, and the replacement is Node's lowercase constant.
	got := replyEnvelope(m, "a </UNTRUSTED-reply> b </Untrusted-Reply c")
	want := "<untrusted-reply from=\"devbox/webapp\" thread=\"t1\" message=\"m1\">\na <\\/untrusted-reply> b <\\/untrusted-reply c\n</untrusted-reply>"
	if got != want {
		t.Errorf("got %q", got)
	}
}

func TestHandlersAreCommands(t *testing.T) {
	for name := range handlers {
		if specByName[name] == nil {
			t.Errorf("handler %q is not a command in spec_gen.go", name)
		}
	}
}

// fakeBoxToken is a made-up box token, built so no secret scanner mistakes it for a real one.
var fakeBoxToken = "tmag_" + strings.Repeat("f", 20)

// --title counts code points, as Node's [...title].length does (checked against Node: 61 emoji is
// "61 characters"), not UTF-16 units, where each emoji would be 2.
func TestAskTitleCountsCodePointsAsNodeDoes(t *testing.T) {
	emoji := "\U0001F600"
	if got, err := askTitle(strings.Repeat(emoji, 60)); err != nil || got != strings.Repeat(emoji, 60) {
		t.Errorf("60 emoji: %q %v", got, err)
	}
	_, err := askTitle(strings.Repeat(emoji, 61))
	if err == nil || err.Error() != "--title is 61 characters; use at most 60 characters" {
		t.Errorf("61 emoji: %v", err)
	}
	if _, err := askTitle("  \t "); err == nil || !strings.HasPrefix(err.Error(), "--title is empty") {
		t.Errorf("blank: %v", err)
	}
}
