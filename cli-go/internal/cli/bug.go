package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode/utf16"
)

// `termag bug report` (cli/src/bug.ts). bug list/show/triage run in the
// Node CLI until phase 2 (they take the box's own credential only).
// TODO(cli-go phase 2): bug list, bug show, bug triage.

func init() { register("bug report", cmdBugReport) }

var (
	bugSeverities = []string{"low", "medium", "high"}
	bugAreas      = []string{"spaces", "asks", "publish", "boxes", "chat", "cli", "broker", "other"}
	aiAgentRE     = regexp.MustCompile(`^([a-z][a-z0-9-]*?)_(\d+(?:-\d+)*)_agent$`)
)

// bugErrorTail: the orchestrator keeps the tail of longer error output (in UTF-16 units, as JS counts).
const bugErrorTail = 20_000

type agentInfo struct{ provider, version, model string }

// agentFromEnv is the coding agent this CLI runs under, from what the agents put in the environment.
func agentFromEnv(env map[string]string) agentInfo {
	m := aiAgentRE.FindStringSubmatch(env["AI_AGENT"])
	name := ""
	if m != nil {
		name = m[1]
	}
	var info agentInfo
	switch {
	case name == "claude-code" || (name == "" && env["CLAUDECODE"] == "1"):
		info.provider = "claude"
	case name != "":
		info.provider = name
	case env["CODEX_SANDBOX"] != "" || env["CODEX_THREAD_ID"] != "":
		info.provider = "codex"
	}
	if m != nil {
		info.version = m[1] + " " + strings.ReplaceAll(m[2], "-", ".")
	}
	if info.provider == "claude" {
		info.model = strings.TrimFunc(env["ANTHROPIC_MODEL"], isJSWhitespace)
	}
	return info
}

func bugOneOf(a *ParsedArgs, name string, allowed []string) (string, error) {
	v, ok := a.Options[name]
	if !ok {
		return "", nil
	}
	s := "true" // String(true) for a flag given as a boolean
	if v.IsStr {
		s = v.Str
	}
	s = strings.TrimFunc(s, isJSWhitespace)
	for _, x := range allowed {
		if x == s {
			return s, nil
		}
	}
	return "", usageError(fmt.Sprintf("--%s takes one of %s", name, strings.Join(allowed, ", ")))
}

// jsSliceTail is s.slice(-n) on a JS string (UTF-16 units).
func jsSliceTail(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[len(u)-n:]))
}

func cmdBugReport(c *Ctx, a *ParsedArgs) (int, error) {
	rawTitle, _ := a.Str("title")
	title := strings.TrimFunc(rawTitle, isJSWhitespace)
	if title == "" {
		return 0, usageError("Missing --title. Usage: " + specByName["bug report"].Usage)
	}
	if len(a.Args) == 0 || a.Args[0] != "-" {
		return 0, usageError("Give the body on stdin: `termag bug report --title \"…\" - < body.md`")
	}
	severity, err := bugOneOf(a, "severity", bugSeverities)
	if err != nil {
		return 0, err
	}
	area, err := bugOneOf(a, "area", bugAreas)
	if err != nil {
		return 0, err
	}
	if c.Stdin == nil {
		return 0, newErr("failed", "Cannot read stdin here")
	}
	raw, err := io.ReadAll(c.Stdin)
	if err != nil {
		return 0, newErr("failed", err.Error())
	}
	body := strings.TrimFunc(string(raw), isJSWhitespace)
	if body == "" {
		return 0, usageError("The body on stdin is empty: say what you ran, what you expected and what happened")
	}
	errorOutput, hasErrorOutput := "", false
	if f, ok := a.Str("error-file"); ok {
		text, ok := c.ReadFile(f)
		if !ok {
			return 0, newErr("not_found", "Can't read --error-file "+f)
		}
		errorOutput, hasErrorOutput = string(text), true
	}

	agent := agentFromEnv(c.Env)
	var redacted []string
	seen := map[string]bool{}
	addKinds := func(kinds []string) {
		for _, k := range kinds {
			if !seen[k] {
				seen[k] = true
				redacted = append(redacted, k)
			}
		}
	}
	// clean: undefined for an empty or missing string, as `if (!s) return undefined`.
	clean := func(s string) (string, bool) {
		if s == "" {
			return "", false
		}
		t, kinds := redactSecrets(s)
		addKinds(kinds)
		return t, true
	}
	payload := newObject()
	setStr := func(k, v string, ok bool) {
		if ok {
			payload.Set(k, v)
		}
	}
	setClean := func(k, v string) {
		if t, ok := clean(v); ok {
			payload.Set(k, t)
		}
	}
	setClean("title", title)
	setClean("body", body)
	setStr("severity", severity, severity != "")
	setStr("area", area, area != "")
	cmd, _ := a.Str("command")
	setClean("command", cmd)
	if hasErrorOutput {
		// Redacted before the tail is cut, so a key whose header falls outside the tail still goes.
		if t, ok := clean(errorOutput); ok {
			payload.Set("errorOutput", jsSliceTail(t, bugErrorTail))
		}
	}
	payload.Set("cliVersion", Version)
	if v, ok := a.Str("agent"); ok {
		payload.Set("agentProvider", v)
	} else if agent.provider != "" {
		payload.Set("agentProvider", agent.provider)
	}
	if v, ok := a.Str("model"); ok {
		payload.Set("agentModel", v)
	} else if agent.model != "" {
		payload.Set("agentModel", agent.model)
	}
	setStr("agentVersion", agent.version, agent.version != "")
	setStr("projectId", c.Getenv("TERMAG_PROJECT_ID"), c.Getenv("TERMAG_PROJECT_ID") != "")
	setStr("workstream", c.Getenv("TERMAG_WORKSTREAM"), c.Getenv("TERMAG_WORKSTREAM") != "")

	s, err := newSession(c, a)
	if err != nil {
		return 0, err
	}
	api, err := authedApi(c, s, 0)
	if err != nil {
		return 0, err
	}
	res, err := api.RequestRaw(context.Background(), "POST", "/bug-reports", payload)
	if err != nil {
		return 0, err
	}
	filed := newObject()
	_ = filed.UnmarshalJSON(res)
	var parsed struct {
		ID       string   `json:"id"`
		Redacted []string `json:"redacted"`
	}
	_ = json.Unmarshal(res, &parsed)
	addKinds(parsed.Redacted)
	if redacted == nil {
		redacted = []string{}
	}
	if a.JSON {
		filed.Set("redacted", redacted) // { ...filed, redacted: kinds }
		c.Out(JSONText(filed))
		return ExitOK, nil
	}
	c.Out(fmt.Sprintf("Filed bug report %s.", parsed.ID))
	if len(redacted) > 0 {
		c.Err(fmt.Sprintf("Redacted before filing: %s.", strings.Join(redacted, ", ")))
	}
	c.Out(fmt.Sprintf("Mention %s in your handoff.", parsed.ID))
	return ExitOK, nil
}
