package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The golden fixtures are the Node CLI's own output (tools/genspec.mjs).

func TestHelpMatchesNodeForEveryCommand(t *testing.T) {
	top, err := os.ReadFile("testdata/help/_top.txt")
	if err != nil {
		t.Fatal(err)
	}
	if got := HelpText(""); got != string(top) {
		t.Errorf("top-level help differs:\n%s", got)
	}
	if len(commandSpecs) != 68 {
		t.Errorf("want 68 commands, have %d", len(commandSpecs))
	}
	for _, s := range commandSpecs {
		want, err := os.ReadFile(filepath.Join("testdata", "help", strings.ReplaceAll(s.Name, " ", "_")+".txt"))
		if err != nil {
			t.Fatal(err)
		}
		if got := HelpText(s.Name); got != string(want) {
			t.Errorf("help for %q differs", s.Name)
		}
	}
}

func TestEveryHelpProbeExitsZero(t *testing.T) {
	for _, s := range commandSpecs {
		c, out, _ := testCtx(t)
		argv := append(strings.Fields(s.Name), "--help")
		if code := Run(argv, c); code != 0 {
			t.Errorf("%v exit %d", argv, code)
		}
		if !strings.HasPrefix(out.String(), s.Summary+".") {
			t.Errorf("%v printed %q", argv, out.String())
		}
	}
}

func TestParserMatchesNode(t *testing.T) {
	raw, err := os.ReadFile("testdata/parse.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Argv   []string        `json:"argv"`
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
		Code   string          `json:"code"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		got, err := ParseCommandLine(tc.Argv)
		if tc.Error != "" {
			ce, _ := err.(*CliError)
			if ce == nil || ce.Message != tc.Error || ce.Code != tc.Code {
				t.Errorf("%q: want error %q, got %v", tc.Argv, tc.Error, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%q: unexpected error %v", tc.Argv, err)
			continue
		}
		b, _ := json.Marshal(got)
		var g, w any
		_ = json.Unmarshal(b, &g)
		_ = json.Unmarshal(tc.Result, &w)
		if !reflect.DeepEqual(g, w) {
			t.Errorf("%q:\n got %s\nwant %s", tc.Argv, b, tc.Result)
		}
	}
}

type helperFixtures struct {
	NormalizeHost []struct {
		Input string `json:"input"`
		OK    string `json:"ok"`
		Error string `json:"error"`
	} `json:"normalizeHost"`
	DeviceNameFrom []struct{ Input, OK string } `json:"deviceNameFrom"`
	Table          []struct {
		Headers []string   `json:"headers"`
		Rows    [][]string `json:"rows"`
		OK      string     `json:"ok"`
	} `json:"table"`
	FormatDate []struct {
		Input *string `json:"input"`
		OK    string  `json:"ok"`
	} `json:"formatDate"`
	FormatBytes []struct {
		Input float64 `json:"input"`
		OK    string  `json:"ok"`
	} `json:"formatBytes"`
	RedactSecrets []struct {
		Input    []string `json:"inputPieces"`
		Text     string   `json:"text"`
		Redacted []string `json:"redacted"`
	} `json:"redactSecrets"`
}

func loadHelpers(t *testing.T) helperFixtures {
	raw, err := os.ReadFile("testdata/helpers.json")
	if err != nil {
		t.Fatal(err)
	}
	var f helperFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestNormalizeHostMatchesWHATWG(t *testing.T) {
	for _, tc := range loadHelpers(t).NormalizeHost {
		got, err := NormalizeHost(tc.Input)
		if tc.Error != "" {
			if err == nil || err.Error() != tc.Error {
				t.Errorf("%q: want error %q, got %q, %v", tc.Input, tc.Error, got, err)
			}
			continue
		}
		if err != nil || got != tc.OK {
			t.Errorf("%q: want %q, got %q, %v", tc.Input, tc.OK, got, err)
		}
	}
}

func TestHelpersMatchNode(t *testing.T) {
	f := loadHelpers(t)
	for _, tc := range f.DeviceNameFrom {
		if got := deviceNameFrom(tc.Input); got != tc.OK {
			t.Errorf("deviceNameFrom(%q) = %q, want %q", tc.Input, got, tc.OK)
		}
	}
	for _, tc := range f.Table {
		if got := Table(tc.Headers, tc.Rows); got != tc.OK {
			t.Errorf("table %v:\n%q\nwant\n%q", tc.Headers, got, tc.OK)
		}
	}
	for _, tc := range f.FormatDate {
		in := ""
		if tc.Input != nil {
			in = *tc.Input
		}
		if got := FormatDate(in); got != tc.OK {
			t.Errorf("formatDate(%q) = %q, want %q", in, got, tc.OK)
		}
	}
	for _, tc := range f.FormatBytes {
		if got := formatBytes(tc.Input); got != tc.OK {
			t.Errorf("formatBytes(%v) = %q, want %q", tc.Input, got, tc.OK)
		}
	}
	for _, tc := range f.RedactSecrets {
		text, kinds := redactSecrets(strings.Join(tc.Input, ""))
		if kinds == nil {
			kinds = []string{}
		}
		if text != tc.Text || !reflect.DeepEqual(kinds, tc.Redacted) {
			t.Errorf("redactSecrets(%q) = %q %v, want %q %v", tc.Input, text, kinds, tc.Text, tc.Redacted)
		}
	}
}

func TestSecretPatternsMatchTheTSList(t *testing.T) {
	src, err := os.ReadFile("../../../cli/src/secretPatterns.ts")
	if err != nil {
		t.Skip("no cli/ next to cli-go/")
	}
	for _, p := range secretPatterns {
		if !bytes.Contains(src, []byte("{ re: /"+p.re.String()+"/, what: '"+p.what+"' }")) {
			t.Errorf("pattern %q (%s) is not in secretPatterns.ts as written here", p.re, p.what)
		}
	}
	if n := bytes.Count(src, []byte("{ re: /")); n != len(secretPatterns) {
		t.Errorf("secretPatterns.ts has %d patterns, Go %d", n, len(secretPatterns))
	}
}

// testCtx is a Ctx with captured output, an empty home and no telemetry.
func testCtx(t *testing.T) (*Ctx, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	var out, errb bytes.Buffer
	home := t.TempDir()
	c := &Ctx{
		Env:      map[string]string{"TERMAG_TELEMETRY": "0"},
		Home:     home,
		Hostname: "test-host",
		Out:      LineWriter(&out),
		Err:      LineWriter(&errb),
		HTTP:     newHTTPClient(&int64Counter{}),
		ReadFile: func(p string) ([]byte, bool) { b, err := os.ReadFile(p); return b, err == nil },
		Stdin:    strings.NewReader(""),
		Now:      time.Now,
		Sleep:    func(time.Duration) {},
		requests: &int64Counter{},
	}
	return c, &out, &errb
}

func TestErrorsAndExitCodes(t *testing.T) {
	cases := []struct {
		argv     []string
		code     int
		stderr   string
		nostdout bool
	}{
		{[]string{"bogus"}, 2, "termag: Unknown command `bogus`. Run `termag --help`.\n", true},
		{[]string{"bogus", "--json"}, 2, `{"error":{"code":"usage","message":"Unknown command ` + "`bogus`" + `. Run ` + "`termag --help`" + `."}}` + "\n", true},
		{[]string{"whoami", "extra"}, 2, "termag: Too many arguments. Usage: termag whoami\n", true},
		{[]string{"whoami"}, 4, "termag: Not signed in to https://app.termag.example.com/termag; run `termag login`\n", true},
		{[]string{"whoami", "--json"}, 4, `{"error":{"code":"auth_required","message":"Not signed in to https://app.termag.example.com/termag; run ` + "`termag login`" + `"}}` + "\n", true},
	}
	for _, tc := range cases {
		c, out, errb := testCtx(t)
		if code := Run(tc.argv, c); code != tc.code {
			t.Errorf("%v: exit %d, want %d", tc.argv, code, tc.code)
		}
		if errb.String() != tc.stderr {
			t.Errorf("%v: stderr %q, want %q", tc.argv, errb.String(), tc.stderr)
		}
		if tc.nostdout && out.Len() != 0 {
			t.Errorf("%v: stdout %q, want none", tc.argv, out.String())
		}
	}
	c, out, _ := testCtx(t)
	if code := Run(nil, c); code != 2 || !strings.HasPrefix(out.String(), "termag: manage termag") {
		t.Errorf("no command: exit %d, %q", code, out.String())
	}
	c, out, _ = testCtx(t)
	Version = "0.1.200+abcdef12"
	if Run([]string{"--version"}, c); out.String() != "termag 0.1.200+abcdef12\n" {
		t.Errorf("--version printed %q", out.String())
	}
	c, out, _ = testCtx(t)
	if Run([]string{"--version", "--json"}, c); out.String() != `{"version":"0.1.200+abcdef12"}`+"\n" {
		t.Errorf("--version --json printed %q", out.String())
	}
}

func TestUnportedCommandsFallBackWithTheirArgv(t *testing.T) {
	var got []string
	FallbackHook = func(argv []string) int { got = argv; return 42 }
	defer func() { FallbackHook = nil }()
	c, _, _ := testCtx(t)
	if code := Run([]string{"doctor", "--yes"}, c); code != 42 || !reflect.DeepEqual(got, []string{"doctor", "--yes"}) {
		t.Errorf("doctor: exit %d, argv %v", code, got)
	}
	// A parse error is reported by Go, never handed on.
	got = nil
	if code := Run([]string{"doctor", "--bogus"}, c); code != 2 || got != nil {
		t.Errorf("a bad doctor line: exit %d, argv %v", code, got)
	}
}

// When the Node CLI cannot start, fallback's error follows --json like every other error: the
// {"error":{"code","message"}} object on stderr, else a termag: line. TERMAG_CLI_CHECKOUT names a
// checkout with no cli/bin/termag.js, so execNode fails before it would exec.
func TestFallbackErrorsFollowTheJSONFlag(t *testing.T) {
	checkout := t.TempDir()
	script := filepath.Join(checkout, "cli", "bin", "termag.js")
	msg := "this command runs in the Node CLI, and " + script + " is missing; run `make install-cli` in the termag checkout"
	for _, tc := range []struct {
		argv       []string
		wantStderr string
	}{
		{[]string{"doctor", "--json"}, CompactJSON(newObject().Set("error", newObject().Set("code", "failed").Set("message", msg))) + "\n"},
		{[]string{"--json", "doctor"}, CompactJSON(newObject().Set("error", newObject().Set("code", "failed").Set("message", msg))) + "\n"},
		{[]string{"doctor"}, "termag: " + msg + "\n"},
	} {
		c, out, errb := testCtx(t)
		c.Env["TERMAG_CLI_CHECKOUT"] = checkout
		code := Run(tc.argv, c)
		if code != 1 || errb.String() != tc.wantStderr || out.Len() != 0 {
			t.Errorf("%v: exit %d, stdout %q, stderr %q; want exit 1, stderr %q", tc.argv, code, out.String(), errb.String(), tc.wantStderr)
		}
	}
	// The golden shape, spelled out once.
	c, _, errb := testCtx(t)
	c.Env["TERMAG_CLI_CHECKOUT"] = checkout
	Run([]string{"doctor", "--json"}, c)
	if want := `{"error":{"code":"failed","message":` + strconv.Quote(msg) + `}}` + "\n"; errb.String() != want {
		t.Errorf("doctor --json: stderr %q, want %q", errb.String(), want)
	}
}

func TestLineWriterSurvivesAClosedPipe(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	r.Close()
	writeLine := LineWriter(w)
	writeLine("one") // EPIPE (SIGPIPE is not fatal for a non-stdio fd)
	writeLine("two")
	w.Close()
}

// fakeOrchestrator answers the routes the framework commands use.
func fakeOrchestrator(t *testing.T, h http.HandlerFunc) (*httptest.Server, *int32) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		h(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func writeLogin(t *testing.T, c *Ctx, host string, accessExpiresIn time.Duration) string {
	path := CredentialsPath(c.Env, c.Home)
	l := newStoredLogin("tmcli_devicetokendevicetoken", "access-1", isoString(time.Now().Add(accessExpiresIn)), "test-host", "a@b.c", "ab", "2027-01-01T00:00:00.000Z", "2027-06-01T00:00:00.000Z")
	if err := SaveLogin(path, host, l); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRefreshOn401AndSave(t *testing.T) {
	var refreshed int32
	srv, _ := fakeOrchestrator(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/termag/api/cli/v1/token":
			atomic.AddInt32(&refreshed, 1)
			w.Write([]byte(`{"accessToken":"access-2","accessTokenExpiresIn":900,"expiresAt":"2027-02-01T00:00:00.000Z","maxExpiresAt":"2027-06-01T00:00:00.000Z"}`))
		case "/termag/api/cli/v1/whoami":
			if r.Header.Get("Authorization") != "Bearer access-2" {
				w.WriteHeader(401)
				w.Write([]byte(`{"error":"expired"}`))
				return
			}
			if !strings.HasPrefix(r.Header.Get("User-Agent"), "termag-cli/") {
				t.Errorf("User-Agent %q", r.Header.Get("User-Agent"))
			}
			w.Write([]byte(`{"user":{"email":"a@b.c","unixUsername":"ab","displayName":"A"},"credential":{"kind":"device","deviceName":"test-host","expiresAt":"2027-02-01T00:00:00.000Z","maxExpiresAt":"2027-06-01T00:00:00.000Z"}}`))
		}
	})
	c, out, errb := testCtx(t)
	host := srv.URL + "/termag"
	c.Env["TERMAG_URL"] = host
	path := writeLogin(t, c, host, time.Hour)
	if code := Run([]string{"whoami", "--json"}, c); code != 0 {
		t.Fatalf("exit %d: %s", code, errb.String())
	}
	want := `{
  "host": "` + host + `",
  "user": {
    "email": "a@b.c",
    "unixUsername": "ab",
    "displayName": "A"
  },
  "credential": {
    "kind": "device",
    "deviceName": "test-host",
    "expiresAt": "2027-02-01T00:00:00.000Z",
    "maxExpiresAt": "2027-06-01T00:00:00.000Z"
  }
}
`
	if out.String() != want {
		t.Errorf("whoami --json:\n%s", out.String())
	}
	if refreshed != 1 {
		t.Errorf("refreshed %d times", refreshed)
	}
	saved := LoadLogin(path, host)
	if saved.AccessToken() != "access-2" || saved.str("expiresAt") != "2027-02-01T00:00:00.000Z" {
		t.Errorf("refresh not saved: %+v", saved.obj)
	}
}

func TestCredentialsFileShape(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "termag", "credentials.json")
	// Another host's entry, with a field the CLI does not know, written by someone else.
	os.MkdirAll(filepath.Dir(path), 0o700)
	os.WriteFile(path, []byte(`{"version":1,"hosts":{"https://z.example/termag":{"token":"tmcli_other","deviceName":"z","extra":[1,2]}}}`), 0o600)
	l := newStoredLogin("tmcli_abc", "acc", "2026-11-12T10:00:00.000Z", "my-mac", "a@b.c", "ab", "2026-11-19T10:00:00.000Z", "2027-02-10T10:00:00.000Z")
	if err := SaveLogin(path, "https://a.example/termag", l); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	want := `{
  "version": 1,
  "hosts": {
    "https://z.example/termag": {
      "token": "tmcli_other",
      "deviceName": "z",
      "extra": [
        1,
        2
      ]
    },
    "https://a.example/termag": {
      "token": "tmcli_abc",
      "accessToken": "acc",
      "accessTokenExpiresAt": "2026-11-12T10:00:00.000Z",
      "deviceName": "my-mac",
      "email": "a@b.c",
      "unixUsername": "ab",
      "expiresAt": "2026-11-19T10:00:00.000Z",
      "maxExpiresAt": "2027-02-10T10:00:00.000Z"
    }
  }
}
`
	if string(got) != want {
		t.Errorf("credentials.json:\n%s", got)
	}
	st, _ := os.Stat(path)
	dst, _ := os.Stat(filepath.Dir(path))
	if st.Mode().Perm() != 0o600 || dst.Mode().Perm() != 0o700 {
		t.Errorf("modes %v %v", st.Mode(), dst.Mode())
	}
	if ok, _ := RemoveLogin(path, "https://a.example/termag"); !ok || LoadLogin(path, "https://a.example/termag") != nil || LoadLogin(path, "https://z.example/termag") == nil {
		t.Error("remove")
	}
	// XDG_CONFIG_HOME, on macOS too.
	if p := CredentialsPath(map[string]string{"XDG_CONFIG_HOME": "/x"}, "/h"); p != "/x/termag/credentials.json" {
		t.Error(p)
	}
	if p := CredentialsPath(map[string]string{}, "/h"); p != "/h/.config/termag/credentials.json" {
		t.Error(p)
	}
	if s := expiresAtFrom(time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC), 900); s != "2026-11-12T10:15:00.000Z" {
		t.Error(s)
	}
}

func TestApiErrorMapping(t *testing.T) {
	cases := []struct {
		status int
		ctype  string
		body   string
		code   string
		msg    string
	}{
		{302, "", "", "edge_auth", "%s redirected the CLI to login.example for a browser sign-in: its edge does not let the CLI API through yet"},
		{401, "text/html", "<html>", "auth_required", "%s refused the CLI's credential; run `termag login`"},
		{503, "text/html", "<html>", "unreachable", "%s is not answering right now (HTTP 503); the orchestrator may be restarting"},
		{404, "text/html", "nope", "not_cli_enabled", "%s did not answer as a termag orchestrator with the CLI API (HTTP 404); it may predate the CLI"},
		{404, "application/json", `{"error":"No box x"}`, "not_found", "No box x"},
		{400, "application/json", `{"error":"bad"}`, "usage", "bad"},
		{403, "application/json", `{"error":"no"}`, "forbidden", "no"},
		{409, "application/json", `{"error":"busy"}`, "conflict", "busy"},
		{412, "application/json", `{"error":"changed"}`, "changed", "changed"},
		{422, "application/json", `{"error":"x","code":"github-required"}`, "precondition", "x"},
		{400, "application/json", `{"error":"lapsed","code":"invalid_grant"}`, "auth_required", "lapsed"},
		{500, "application/json", `{}`, "failed", "HTTP 500"},
	}
	for _, tc := range cases {
		srv, _ := fakeOrchestrator(t, func(w http.ResponseWriter, r *http.Request) {
			if tc.status == 302 {
				w.Header().Set("Location", "https://login.example/x")
			}
			if tc.ctype != "" {
				w.Header().Set("Content-Type", tc.ctype)
			}
			w.WriteHeader(tc.status)
			w.Write([]byte(tc.body))
		})
		api := &Api{Host: srv.URL, Token: "t", Client: newHTTPClient(nil)}
		err := api.Request(nil, "GET", "/x", nil, nil)
		ce, _ := err.(*CliError)
		if ce == nil || ce.Code != tc.code || ce.Message != strings.ReplaceAll(tc.msg, "%s", srv.URL) {
			t.Errorf("%d %s: got %v", tc.status, tc.body, err)
		}
	}
	api := &Api{Host: "http://127.0.0.1:1", Token: "t", Client: newHTTPClient(nil)}
	if err := api.Request(nil, "GET", "/x", nil, nil); err == nil || err.Error() != "Can't reach the orchestrator at http://127.0.0.1:1 (ECONNREFUSED)" {
		t.Errorf("refused: %v", err)
	}
	slow, _ := fakeOrchestrator(t, func(w http.ResponseWriter, r *http.Request) { time.Sleep(300 * time.Millisecond) })
	api = &Api{Host: slow.URL, Client: newHTTPClient(nil), Timeout: 50 * time.Millisecond}
	if err := api.Request(nil, "GET", "/x", nil, nil); err == nil || err.(*CliError).Code != "timeout" {
		t.Errorf("timeout: %v", err)
	}
}

// HTTP(S)_PROXY is honoured (rollout decision 2026-11-12; Node's fetch ignores it), and NO_PROXY and
// loopback are not proxied.
func TestProxyEnvironmentIsHonoured(t *testing.T) {
	var proxied []string
	proxy, _ := fakeOrchestrator(t, func(w http.ResponseWriter, r *http.Request) {
		proxied = append(proxied, r.URL.String())
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})
	direct, _ := fakeOrchestrator(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("NO_PROXY", "skip.example")
	if err := (&Api{Host: "http://orchestrator.example/termag", Client: newHTTPClient(nil)}).Request(nil, "GET", "/whoami", nil, nil); err != nil {
		t.Fatalf("through the proxy: %v", err)
	}
	if len(proxied) != 1 || proxied[0] != "http://orchestrator.example/termag/api/cli/v1/whoami" {
		t.Errorf("proxy saw %v", proxied)
	}
	if err := (&Api{Host: direct.URL, Client: newHTTPClient(nil)}).Request(nil, "GET", "/x", nil, nil); err != nil || len(proxied) != 1 {
		t.Errorf("loopback went through the proxy: %v %v", err, proxied)
	}
	if err := (&Api{Host: "http://skip.example", Client: newHTTPClient(nil), Timeout: time.Second}).Request(nil, "GET", "/x", nil, nil); err == nil || len(proxied) != 1 {
		t.Errorf("NO_PROXY host went through the proxy: %v %v", err, proxied)
	}
}

func TestBoxAndProjectTables(t *testing.T) {
	srv, _ := fakeOrchestrator(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/termag/api/cli/v1/boxes":
			w.Write([]byte(`{"boxes":[
			 {"name":"a","addressable":true,"state":"running","agentConnected":true,"error":null,"projects":[{"id":"1","name":"p","label":"space orchestrator for s"}],"size":"large","instanceType":"m7g.2xlarge","diskGiB":200,"setupEnabled":false},
			 {"name":"b c","addressable":false,"state":"failed","agentConnected":false,"error":"boom","projects":[],"size":"4vcpu-32gib","instanceType":null,"resize":{"to":"large","phase":"resizing","running":true}}]}`))
		case "/termag/api/cli/v1/projects":
			w.Write([]byte(`{"projects":[{"ref":"a/p","provider":"claude","status":"needs_input_now","waitingReason":null},{"ref":"a/q","provider":null,"status":"waiting","waitingReason":"permission"}]}`))
		}
	})
	c, out, errb := testCtx(t)
	c.Env["TERMAG_URL"] = srv.URL + "/termag"
	writeLogin(t, c, srv.URL+"/termag", time.Hour)
	if code := Run([]string{"box", "ls"}, c); code != 0 {
		t.Fatal(errb.String())
	}
	// As the Node CLI prints it for the same answer (checked side by side).
	want := "BOX  STATE         SIZE                               DISK    AGENT      PROJECTS\n" +
		"a    running       large (m7g.2xlarge), setup off     200 GB  connected  p (space orchestrator for s)\n" +
		"b c  failed: boom  4 vCPU, 32 GB -> large (resizing)  -       -          -\n"
	if out.String() != want {
		t.Errorf("box list:\n%q\nwant\n%q", out.String(), want)
	}
	if errb.String() != "termag: \"b c\" can't be used as a box name on the command line (letters, digits, - and _ only); rename in the web UI.\n" {
		t.Errorf("stderr %q", errb.String())
	}
	c, out, _ = testCtx(t)
	c.Env["TERMAG_URL"] = srv.URL + "/termag"
	writeLogin(t, c, srv.URL+"/termag", time.Hour)
	Run([]string{"project", "list"}, c)
	if out.String() != "PROJECT  AGENT   STATUS\na/p      claude  needs input_now\na/q      -       waiting (permission)\n" {
		t.Errorf("project list:\n%q", out.String())
	}
}

func TestUsageReportShapeAndOptOut(t *testing.T) {
	var got []string
	srv, _ := fakeOrchestrator(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/termag/api/cli/v1/usage" {
			b := new(bytes.Buffer)
			b.ReadFrom(r.Body)
			got = append(got, b.String())
			w.WriteHeader(204)
			return
		}
		w.Write([]byte(`{"projects":[]}`))
	})
	c, _, _ := testCtx(t)
	delete(c.Env, "TERMAG_TELEMETRY")
	c.Env["TERMAG_URL"] = srv.URL + "/termag"
	c.Env["CLAUDECODE"] = "1"
	writeLogin(t, c, srv.URL+"/termag", time.Hour)
	Run([]string{"project", "list"}, c)
	if len(got) != 1 || !strings.HasPrefix(got[0], `{"command":"project list","phase":"finished","version":"`) || !strings.Contains(got[0], `"exitCode":0,"durationMs":`) || !strings.HasSuffix(got[0], `"interactive":false,"claudeCode":true,"runtime":"go"}`) {
		t.Errorf("report %v", got)
	}
	for _, env := range []map[string]string{{"TERMAG_TELEMETRY": "0"}, {"TERMAG_TELEMETRY": "off"}, {"DO_NOT_TRACK": "1"}} {
		if !usageOptedOut(env) {
			t.Errorf("%v not opted out", env)
		}
	}
	if usageOptedOut(map[string]string{"DO_NOT_TRACK": "0"}) {
		t.Error("DO_NOT_TRACK=0 opted out")
	}
	// A run with no request of its own hands its report to the background sender.
	var bg []BackgroundRequest
	c, _, _ = testCtx(t)
	delete(c.Env, "TERMAG_TELEMETRY")
	c.Env["TERMAG_URL"] = srv.URL + "/termag"
	writeLogin(t, c, srv.URL+"/termag", time.Hour)
	c.PostInBackground = func(r BackgroundRequest) { bg = append(bg, r) }
	reportUsage(c, &ParsedArgs{Command: "space memory"}, newUsageReport(c, "space memory", new(int), time.Millisecond))
	if len(bg) != 1 || bg[0].URL != srv.URL+"/termag/api/cli/v1/usage" || bg[0].Headers["Authorization"] != "Bearer access-1" || bg[0].TimeoutMs != 1500 {
		t.Errorf("background %+v", bg)
	} else if bg[0].Body == nil || !strings.HasSuffix(*bg[0].Body, `"claudeCode":false,"runtime":"go"}`) || !strings.Contains(*bg[0].Body, `"phase":"finished"`) {
		t.Errorf("background body %v", bg[0].Body)
	}
	// A report at start (logout's, awaited before the revoke) carries it too.
	got = nil
	c, _, _ = testCtx(t)
	delete(c.Env, "TERMAG_TELEMETRY")
	c.Env["TERMAG_URL"] = srv.URL + "/termag"
	writeLogin(t, c, srv.URL+"/termag", time.Hour)
	reportUsage(c, &ParsedArgs{Command: "logout"}, newUsageReport(c, "logout", nil, 0))
	if len(got) != 1 || got[0] != `{"command":"logout","phase":"started","version":"`+Version+`","interactive":false,"claudeCode":false,"runtime":"go"}` {
		t.Errorf("start report %v", got)
	}
}

// A burst of bearers after the access token lapsed (forward connections, the memory listing's
// goroutines): one POST /token, one save, every caller gets the new token, and credentials.json is
// whole afterwards. Before, each refreshed and all wrote one <path>.<pid>.tmp; most saves failed.
func TestConcurrentRefreshesCollapseToOne(t *testing.T) {
	var posts atomic.Int32
	srv, _ := fakeOrchestrator(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/termag/api/cli/v1/token" {
			w.WriteHeader(404)
			return
		}
		n := posts.Add(1)
		time.Sleep(20 * time.Millisecond) // a slow orchestrator widens the race
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"accessToken":"access-new-%d","accessTokenExpiresIn":3600,"expiresAt":"2027-02-01T00:00:00.000Z","maxExpiresAt":"2027-06-01T00:00:00.000Z"}`, n)
	})
	c, _, _ := testCtx(t)
	host := srv.URL + "/termag"
	c.Env["TERMAG_URL"] = host
	path := writeLogin(t, c, host, -time.Minute) // lapsed
	s, err := newSession(c, &ParsedArgs{})
	if err != nil {
		t.Fatal(err)
	}
	const n = 32
	var wg sync.WaitGroup
	tokens := make([]string, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			src, err := bearerFor(c, s)
			if err != nil {
				errs[i] = err
				return
			}
			tokens[i], errs[i] = src(context.Background(), "", 15*time.Minute)
		}(i)
	}
	wg.Wait()
	if got := posts.Load(); got != 1 {
		t.Errorf("%d token POSTs, want 1", got)
	}
	for i := range tokens {
		if errs[i] != nil || tokens[i] != "access-new-1" {
			t.Errorf("caller %d: %q %v", i, tokens[i], errs[i])
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var top map[string]any
	if json.Unmarshal(raw, &top) != nil {
		t.Fatalf("credentials.json is not valid JSON: %q", raw)
	}
	if l := LoadLogin(path, host); l == nil || l.AccessToken() != "access-new-1" || l.Token() != "tmcli_devicetokendevicetoken" {
		t.Fatalf("the login after the burst: %+v", l)
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", st.Mode())
	}
	if left, _ := filepath.Glob(path + ".*.tmp"); len(left) != 0 {
		t.Errorf("temp files left behind: %v", left)
	}
}

// A refresh that waited for another and finds the login gone (a `termag logout` meanwhile) fails as
// signed out, and never writes the old login back.
func TestRefreshAfterLogoutDoesNotRestoreTheLogin(t *testing.T) {
	var posts atomic.Int32
	srv, _ := fakeOrchestrator(t, func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"accessToken":"access-new","accessTokenExpiresIn":3600,"expiresAt":"2027-02-01T00:00:00.000Z","maxExpiresAt":"2027-06-01T00:00:00.000Z"}`))
	})
	c, _, _ := testCtx(t)
	host := srv.URL + "/termag"
	path := writeLogin(t, c, host, -time.Minute)
	login := LoadLogin(path, host) // what a long-running command holds
	if ok, err := RemoveLogin(path, host); !ok || err != nil {
		t.Fatal(ok, err)
	}
	_, err := freshAccess(context.Background(), c, host, path, login, "", 0)
	if ce, _ := err.(*CliError); ce == nil || ce.Code != "auth_required" {
		t.Fatalf("want auth_required, got %v", err)
	}
	if LoadLogin(path, host) != nil || posts.Load() != 0 {
		t.Fatalf("the login came back (posts %d)", posts.Load())
	}
}
