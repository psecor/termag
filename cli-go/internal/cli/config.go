package cli

import (
	"encoding/json"
	"net"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// DefaultHost is the production orchestrator (config.ts).
const DefaultHost = "https://app.termag.example.com/termag"

// Every deployment serves termag under this path (BASE_PATH).
const defaultBasePath = "/termag"

var (
	schemeRE   = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)
	loopbackRE = regexp.MustCompile(`(?i)^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$`)
)

// whatwgOrigin parses an http(s) URL as the WHATWG URL parser (Node's `new URL`) would, for the
// parts termag keeps: the scheme, the host (lowercased, IPv6 compressed, default port dropped)
// and the path (dot segments resolved). ok is false where `new URL` would throw.
func whatwgOrigin(text string) (scheme, host, path string, hasUser bool, ok bool) {
	u, err := url.Parse(text)
	if err != nil {
		return "", "", "", false, false
	}
	scheme = strings.ToLower(u.Scheme)
	if u.User != nil {
		hasUser = true
	}
	if scheme != "http" && scheme != "https" {
		return scheme, "", "", hasUser, true
	}
	hostname := strings.ToLower(u.Hostname())
	if hostname == "" {
		return "", "", "", false, false
	}
	if ip := net.ParseIP(hostname); ip != nil && strings.Contains(hostname, ":") {
		hostname = "[" + ip.String() + "]"
	}
	port := u.Port()
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n > 65535 {
			return "", "", "", false, false
		}
		port = strconv.Itoa(n)
		if (scheme == "http" && n == 80) || (scheme == "https" && n == 443) {
			port = ""
		}
	}
	host = hostname
	if port != "" {
		host += ":" + port
	}
	path = removeDotSegments(u.EscapedPath())
	if path == "" {
		path = "/"
	}
	return scheme, host, path, hasUser, true
}

func removeDotSegments(p string) string {
	if p == "" {
		return ""
	}
	segs := strings.Split(p, "/")
	var out []string
	for i, s := range segs {
		last := i == len(segs)-1
		switch s {
		case ".":
			if last {
				out = append(out, "")
			}
		case "..":
			if len(out) > 1 {
				out = out[:len(out)-1]
			}
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, s)
		}
	}
	res := strings.Join(out, "/")
	if !strings.HasPrefix(res, "/") {
		res = "/" + res
	}
	return res
}

// NormalizeHost is config.ts's normalizeHost: scheme + host + base path, no trailing slash. It is
// also the key credentials.json is read by, by termag-desktop too.
func NormalizeHost(input string) (string, error) {
	text := strings.TrimSpace(input)
	if text == "" {
		return "", usageError("--host must not be empty")
	}
	if !schemeRE.MatchString(text) {
		hostPart := strings.SplitN(text, "/", 2)[0]
		if loopbackRE.MatchString(hostPart) {
			text = "http://" + text
		} else {
			text = "https://" + text
		}
	}
	scheme, host, path, hasUser, ok := whatwgOrigin(text)
	if !ok {
		return "", usageError("Not a valid orchestrator URL: " + input)
	}
	if scheme != "http" && scheme != "https" {
		return "", usageError("The orchestrator URL must be http(s): " + input)
	}
	if hasUser {
		return "", usageError("The orchestrator URL must not contain credentials")
	}
	path = strings.TrimRight(path, "/")
	if path == "" {
		path = defaultBasePath
	}
	return scheme + "://" + host + path, nil
}

var wsAgentSuffix = regexp.MustCompile(`/ws/agent/?$`)

// baseURLFromAgentURL: ws://host:3040/termag/ws/agent → http://host:3040/termag.
func baseURLFromAgentURL(agentWsURL string) (string, bool) {
	u, err := url.Parse(agentWsURL)
	if err != nil || u.Scheme == "" {
		return "", false
	}
	scheme := strings.ToLower(u.Scheme)
	switch scheme {
	case "ws":
		scheme = "http"
	case "wss":
		scheme = "https"
	case "http", "https":
	default:
		return "", false
	}
	u.Scheme = scheme
	_, host, path, _, ok := whatwgOrigin(u.String())
	if !ok {
		return "", false
	}
	path = strings.TrimRight(wsAgentSuffix.ReplaceAllString(path, ""), "/")
	if path == "" {
		path = defaultBasePath
	}
	return scheme + "://" + host + path, true
}

func agentConfigCandidates(env map[string]string, home string) []string {
	var out []string
	if p := env["TERMAG_AGENT_CONFIG"]; p != "" {
		out = append(out, p)
	}
	return append(out,
		filepath.Join(home, "src", "termag", "agent", "agent.config.json"),
		filepath.Join(home, ".config", "termag", "agent.config.json"),
		filepath.Join(home, ".termag", "agent.config.json"),
	)
}

// BoxCredential is the agent token of the machine we run on, so a box needs no `termag login`.
type BoxCredential struct {
	Host  string
	Token string
	Path  string
}

func findBoxCredential(env map[string]string, home string, read func(string) ([]byte, bool)) *BoxCredential {
	for _, p := range agentConfigCandidates(env, home) {
		text, ok := read(p)
		if !ok || len(text) == 0 {
			continue
		}
		var cfg map[string]any
		if json.Unmarshal(text, &cfg) != nil {
			continue
		}
		ws, _ := cfg["termag_url"].(string)
		if _, isStr := cfg["termag_url"].(string); !isStr {
			ws, _ = cfg["server_url"].(string)
		}
		token, _ := cfg["token"].(string)
		if ws == "" || token == "" || !strings.HasPrefix(token, "tmag_") {
			continue
		}
		host, ok := baseURLFromAgentURL(ws)
		if !ok {
			continue
		}
		return &BoxCredential{Host: host, Token: token, Path: p}
	}
	return nil
}

// Target is which orchestrator to talk to, and the box credential when it belongs to it.
type Target struct {
	Host   string
	Source string // flag, env, box, default
	Box    *BoxCredential
}

func resolveTarget(flagHost *string, env map[string]string, home string, read func(string) ([]byte, bool)) (Target, error) {
	box := findBoxCredential(env, home, read)
	var t Target
	var err error
	switch {
	case flagHost != nil:
		t.Host, err = NormalizeHost(*flagHost)
		t.Source = "flag"
	case env["TERMAG_URL"] != "":
		t.Host, err = NormalizeHost(env["TERMAG_URL"])
		t.Source = "env"
	case box != nil:
		t.Host, t.Source = box.Host, "box"
	default:
		t.Host, t.Source = DefaultHost, "default"
	}
	if err != nil {
		return Target{}, err
	}
	if box != nil && box.Host == t.Host {
		t.Box = box
	}
	return t, nil
}
