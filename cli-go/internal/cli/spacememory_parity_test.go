package cli

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
)

// The parity test: one scripted run of space memory and space sync against a fake orchestrator
// and S3, by the Node CLI and by this one, in the same HOME; stdout, stderr, exit codes and every
// file left under HOME must match (timestamps normalized). Then the two alternate on one HOME.
// Skipped without node and a built Node CLI (TERMAG_PARITY_NODE_CLI, or cli/bin/termag.js with dist/).

type fakeFile struct {
	body     string
	modified string
}

type fakeSpaces struct {
	mu        sync.Mutex
	files     map[string]map[string]fakeFile // space -> path -> file
	memory404 bool
	failS3    map[string]bool
	srv       *httptest.Server
}

func (f *fakeSpaces) etag(body string) string {
	sum := md5.Sum([]byte(body))
	return `"` + hex.EncodeToString(sum[:]) + `"`
}

func newFakeSpaces() *fakeSpaces {
	f := &fakeSpaces{}
	f.reset()
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	return f
}

func (f *fakeSpaces) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	big := strings.Repeat("x", 9000)
	f.memory404 = false
	f.failS3 = map[string]bool{}
	f.files = map[string]map[string]fakeFile{
		"s1": {
			".termag/prompt.md":            {"Be kind to the build.\n", "2026-11-01T10:00:00.000Z"},
			".termag/memory/a.md":          {"---\nname: a\ndescription: \"First   fact\"\n---\nbody a\n", "2026-11-02T10:00:00.000Z"},
			".termag/memory/b.md":          {"---\nname: b\ndescription: leaks\n---\ntoken tmag_ABCDEFGHIJKLMNOPQRS\n", "2026-11-03T10:00:00.000Z"},
			".termag/memory/big.md":        {big, "2026-11-04T10:00:00.000Z"},
			".termag/memory/nofront.md":    {"just a body é\n", "2026-11-05T10:00:00.000Z"},
			".termag/skills/foo/SKILL.md":  {"---\nname: foo\ndescription: Does foo\n---\nUse it.\n", "2026-11-01T11:00:00.000Z"},
			".termag/skills/foo/helper.sh": {"echo hi\n", "2026-11-01T11:00:00.000Z"},
			".termag/skills/bar/notes.txt": {"notes\n", "2026-11-01T12:00:00.000Z"},
			".termag/tools/t.html":         {"<b>tool</b>", "2026-11-01T12:00:00.000Z"},
			".termag/automations/x/log.md": {"run", "2026-11-01T12:00:00.000Z"},
			"docs/readme.md":               {"# readme\n", "2026-11-06T12:00:00.000Z"},
			"docs/deep/one.txt":            {"one", "2026-11-06T12:00:00.000Z"},
			"top.txt":                      {"top", "2026-11-06T12:00:00.000Z"},
		},
		"s2": {
			"a.txt": {"s2 a", "2026-11-06T12:00:00.000Z"},
			"b.txt": {"s2 b", "2026-11-06T12:00:00.000Z"},
		},
	}
}

func (f *fakeSpaces) writeJSON(w http.ResponseWriter, status int, v string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(v))
}

func (f *fakeSpaces) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p := r.URL.Path
	if strings.HasPrefix(p, "/s3/") {
		rest := strings.TrimPrefix(p, "/s3/")
		space, path, _ := strings.Cut(rest, "/")
		if f.failS3[space+":"+path] {
			w.WriteHeader(500)
			_, _ = w.Write([]byte("<Error><Code>InternalError</Code></Error>"))
			return
		}
		file, ok := f.files[space][path]
		if !ok {
			w.WriteHeader(404)
			return
		}
		_, _ = w.Write([]byte(file.body))
		return
	}
	p = strings.TrimPrefix(p, "/termag/api/cli/v1")
	q := r.URL.Query()
	switch {
	case p == "/spaces" && r.Method == "GET":
		f.writeJSON(w, 200, `{"spaces":[{"id":"sp1","name":"s1","description":null,"role":"editor","readOnly":false,"usedBytes":1234,"quotaBytes":107374182400,"access":{"kind":"explicit"}},{"id":"sp2","name":"s2","description":"two","role":"viewer","readOnly":true,"usedBytes":10,"quotaBytes":1073741824,"access":{"kind":"inherited","via":"ownerbox"}}]}`)
	case p == "/session-space":
		if q.Get("project") == "p1" {
			f.writeJSON(w, 200, `{"space":"s1"}`)
		} else {
			f.writeJSON(w, 200, `{"space":null}`)
		}
	case strings.HasPrefix(p, "/spaces/") && strings.HasSuffix(p, "/memory"):
		if f.memory404 {
			f.writeJSON(w, 404, `{"error":"Not found"}`)
			return
		}
		f.writeJSON(w, 200, `{"role":"editor","readOnly":false,"writable":true,"me":"u1","writers":{".termag/memory/a.md":{"userId":"u2","email":"bo@example.com","name":"Bo","box":"bobox","at":"2026-11-07T09:00:00.000Z"},".termag/memory/nofront.md":{"userId":"u1","email":null,"name":"Me","box":null,"at":"2026-11-01T09:00:00.000Z"}}}`)
	case strings.HasPrefix(p, "/spaces/") && strings.HasSuffix(p, "/tree"):
		space := strings.TrimSuffix(strings.TrimPrefix(p, "/spaces/"), "/tree")
		f.tree(w, space, q.Get("prefix"), q.Get("recursive") == "1", q.Get("cursor"))
	case strings.HasPrefix(p, "/spaces/") && strings.HasSuffix(p, "/files/download"):
		space := strings.TrimSuffix(strings.TrimPrefix(p, "/spaces/"), "/files/download")
		var body struct{ Path string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		file, ok := f.files[space][body.Path]
		if !ok {
			f.writeJSON(w, 404, `{"error":"No such file"}`)
			return
		}
		out, _ := json.Marshal(map[string]any{"url": f.srv.URL + "/s3/" + space + "/" + body.Path, "size": len(file.body), "etag": f.etag(file.body), "versionId": "v-" + f.etag(file.body)[1:7]})
		f.writeJSON(w, 200, string(out))
	default:
		f.writeJSON(w, 404, `{"error":"Not found"}`)
	}
}

// tree pages two entries at a time, so the cursor is exercised.
func (f *fakeSpaces) tree(w http.ResponseWriter, space, prefix string, recursive bool, cursor string) {
	type entry struct {
		dir        bool
		name, path string
	}
	var paths []string
	for p := range f.files[space] {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	dirs := map[string]bool{}
	var entries []entry
	for _, p := range paths {
		if !strings.HasPrefix(p, prefix) {
			continue
		}
		rest := p[len(prefix):]
		if !recursive && strings.Contains(rest, "/") {
			d := rest[:strings.Index(rest, "/")]
			if !dirs[d] {
				dirs[d] = true
				entries = append(entries, entry{true, d, prefix + d + "/"})
			}
			continue
		}
		entries = append(entries, entry{false, filepath.Base(p), p})
	}
	start := 0
	fmt.Sscan(cursor, &start)
	end := start + 2
	next := "null"
	if end < len(entries) {
		next = fmt.Sprintf(`"%d"`, end)
	} else {
		end = len(entries)
	}
	var ds, fs []string
	for _, e := range entries[start:end] {
		if e.dir {
			ds = append(ds, fmt.Sprintf(`{"name":%q,"path":%q}`, e.name, e.path))
		} else {
			file := f.files[space][e.path]
			fs = append(fs, fmt.Sprintf(`{"name":%q,"path":%q,"size":%d,"modifiedAt":%q,"etag":%q}`, e.name, e.path, len(file.body), file.modified, f.etag(file.body)))
		}
	}
	f.writeJSON(w, 200, fmt.Sprintf(`{"prefix":%q,"dirs":[%s],"files":[%s],"nextCursor":%s}`, prefix, strings.Join(ds, ","), strings.Join(fs, ","), next))
}

type parityStep struct {
	name   string
	args   []string
	stdin  string
	before func(f *fakeSpaces)
}

var (
	goBinOnce sync.Once
	goBinPath string
	goBinErr  error
)

func goBinary(t *testing.T) string {
	goBinOnce.Do(func() {
		dir, err := os.MkdirTemp("", "termag-go-bin-")
		if err != nil {
			goBinErr = err
			return
		}
		goBinPath = filepath.Join(dir, "termag")
		out, err := exec.Command("go", "build", "-o", goBinPath, filepath.Join(repoRoot(t), "cli-go", "cmd", "termag")).CombinedOutput()
		if err != nil {
			goBinErr = fmt.Errorf("%v: %s", err, out)
		}
	})
	if goBinErr != nil {
		t.Fatal(goBinErr)
	}
	return goBinPath
}

func memoryNodeCLI(t *testing.T) (string, string) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("no node")
	}
	script := os.Getenv("TERMAG_PARITY_NODE_CLI")
	if script == "" {
		script = filepath.Join(repoRoot(t), "cli", "bin", "termag.js")
		if _, err := os.Stat(filepath.Join(repoRoot(t), "cli", "dist", "main.js")); err != nil {
			t.Skip("the Node CLI is not built (make install-cli, or set TERMAG_PARITY_NODE_CLI)")
		}
	}
	return node, script
}

type runOutput struct {
	stdout, stderr string
	code           int
}

func runCLI(t *testing.T, argv []string, home, stdin string, extraEnv ...string) runOutput {
	cmd := exec.Command(argv[0], argv[1:]...)
	env := []string{"HOME=" + home, "PATH=" + os.Getenv("PATH"), "TERMAG_TELEMETRY=0", "TERMAG_AGENT_CONFIG=" + filepath.Join(home, "agent.config.json")}
	cmd.Env = append(env, extraEnv...)
	cmd.Stdin = strings.NewReader(stdin)
	var out, errb strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	return runOutput{out.String(), errb.String(), code}
}

var timestampRE = regexp.MustCompile(`"(syncedAt|at|startedAt)":"[^"]*"`)

func memoryNormalize(s string) string { return timestampRE.ReplaceAllString(s, `"$1":"T"`) }

// snapshot: every path under home with its mode and (normalized) content.
func snapshot(t *testing.T, home string) []string {
	var out []string
	_ = filepath.WalkDir(home, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(home, p)
		info, _ := os.Lstat(p)
		line := fmt.Sprintf("%s %o", rel, info.Mode().Perm())
		if info.Mode().IsRegular() {
			b, _ := os.ReadFile(p)
			line += " " + memoryNormalize(string(b))
		}
		out = append(out, line)
		return nil
	})
	return out
}

func freshHome(t *testing.T, home, host string) {
	chmodWritable(home)
	_ = os.RemoveAll(home)
	if err := os.MkdirAll(filepath.Join(home, "termag", "projects", "p1", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := fmt.Sprintf(`{"termag_url":"%s/termag/ws/agent","token":"tmag_paritytestparitytest"}`, strings.Replace(host, "http://", "ws://", 1))
	_ = os.WriteFile(filepath.Join(home, "agent.config.json"), []byte(cfg), 0o600)
}

func chmodWritable(dir string) {
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && d.Type()&fs.ModeSymlink == 0 {
			_ = os.Chmod(p, 0o755)
		}
		return nil
	})
}

func paritySteps(home string) []parityStep {
	sess := filepath.Join(home, "sess.json")
	hookIn := fmt.Sprintf(`{"session_id":"hooksession-1","cwd":%q}`, filepath.Join(home, "termag", "projects", "p1", "sub"))
	return []parityStep{
		{name: "sync json", args: []string{"space", "memory", "sync", "s1", "--json"}},
		{name: "context start", args: []string{"space", "memory", "context", "s1", "--session", sess, "--json"}},
		{name: "context none", args: []string{"space", "memory", "context", "s1", "--session", sess, "--json"}},
		{name: "hook start", args: []string{"space", "memory", "context", "--hook", "SessionStart", "--refresh", "60s"}, stdin: hookIn},
		{name: "hook prompt none", args: []string{"space", "memory", "context", "--hook", "UserPromptSubmit", "--refresh", "60s"}, stdin: hookIn},
		{name: "change", args: []string{"space", "memory", "sync", "s1"}, before: func(f *fakeSpaces) {
			f.files["s1"][".termag/memory/a.md"] = fakeFile{"---\nname: a\ndescription: Changed fact\n---\nbody a2\n", "2026-11-08T10:00:00.000Z"}
			f.files["s1"][".termag/memory/c.md"] = fakeFile{"---\nname: c\ndescription: New\n---\nc\n", "2026-11-08T11:00:00.000Z"}
			delete(f.files["s1"], ".termag/skills/bar/notes.txt")
			f.files["s1"][".termag/skills/foo/more.md"] = fakeFile{"more\n", "2026-11-08T11:00:00.000Z"}
		}},
		{name: "context notice", args: []string{"space", "memory", "context", "s1", "--session", sess, "--json"}},
		{name: "hook prompt notice", args: []string{"space", "memory", "context", "--hook", "UserPromptSubmit", "--refresh", "60s"}, stdin: hookIn},
		{name: "context text", args: []string{"space", "memory", "context", "s1"}},
		{name: "ls", args: []string{"space", "memory", "ls", "s1"}},
		{name: "ls json", args: []string{"space", "memory", "list", "s1", "--json"}},
		{name: "cat", args: []string{"space", "memory", "cat", "s1", "a"}},
		{name: "cat json", args: []string{"space", "memory", "cat", "s1", "nofront", "--json"}},
		{name: "cat withheld", args: []string{"space", "memory", "cat", "s1", "b"}},
		{name: "cat bad name", args: []string{"space", "memory", "cat", "s1", "Bad_Name", "--json"}},
		{name: "sync default", args: []string{"space", "memory", "sync", "--json"}},
		{name: "sync if-older", args: []string{"space", "memory", "sync", "s1", "--if-older", "5m", "--json"}},
		{name: "many", args: []string{"space", "memory", "sync", "s1"}, before: func(f *fakeSpaces) {
			for i := 0; i < 80; i++ {
				desc := strings.Repeat(fmt.Sprintf("fact %d  with\twhitespace é ", i), 12)
				f.files["s1"][fmt.Sprintf(".termag/memory/m-%02d.md", i)] = fakeFile{"---\nname: m" + fmt.Sprint(i) + "\ndescription: '" + desc + "'\n---\nbody\n", fmt.Sprintf("2026-11-10T10:%02d:00.000Z", i%60)}
			}
			f.files["s1"][".termag/prompt.md"] = fakeFile{strings.Repeat("a", 4095) + "éé and more\n", "2026-11-10T09:00:00.000Z"}
			f.files["s1"][".termag/memory/broken.md"] = fakeFile{"---\nname: broken\ndescription: bytes \xe2\x82 and \xff\xfe here\n---\n", "2026-11-10T09:00:00.000Z"}
		}},
		{name: "many index", args: []string{"space", "memory", "context", "s1"}},
		{name: "bad sub", args: []string{"space", "memory", "nope"}},
		{name: "bad hook", args: []string{"space", "memory", "context", "--hook", "Stop"}},
		{name: "mirror json", args: []string{"space", "sync", "--json"}},
		{name: "mirror text", args: []string{"space", "sync", "s1"}, before: func(f *fakeSpaces) {
			delete(f.files["s1"], "docs/deep/one.txt")
			f.files["s1"]["top.txt"] = fakeFile{"top changed", "2026-11-09T12:00:00.000Z"}
		}},
		{name: "mirror partial", args: []string{"space", "sync", "--json"}, before: func(f *fakeSpaces) {
			f.files["s2"]["c.txt"] = fakeFile{"new", "2026-11-09T12:00:00.000Z"}
			f.failS3["s2:c.txt"] = true
		}},
		{name: "mirror not reached", args: []string{"space", "sync", "nope", "--json"}},
		{name: "mirror bad name", args: []string{"space", "sync", "Bad!"}},
		{name: "memory off", args: []string{"space", "memory", "sync", "s1", "--json"}, before: func(f *fakeSpaces) { f.memory404 = true }},
		{name: "context off notice", args: []string{"space", "memory", "context", "s1", "--session", sess, "--json"}},
		{name: "context off", args: []string{"space", "memory", "context", "s1", "--session", sess, "--json"}},
	}
}

func runScript(t *testing.T, f *fakeSpaces, cli []string, home string, steps []parityStep) ([]string, []string) {
	f.reset()
	freshHome(t, home, f.srv.URL)
	var outs []string
	for _, s := range steps {
		if s.before != nil {
			f.mu.Lock()
			s.before(f)
			f.mu.Unlock()
		}
		r := runCLI(t, append(append([]string(nil), cli...), s.args...), home, s.stdin)
		outs = append(outs, fmt.Sprintf("== %s (exit %d)\n%s\n-- stderr\n%s", s.name, r.code, memoryNormalize(r.stdout), memoryNormalize(r.stderr)))
	}
	return outs, snapshot(t, home)
}

func TestSpaceMemoryParityWithNode(t *testing.T) {
	node, script := memoryNodeCLI(t)
	goBin := goBinary(t)
	f := newFakeSpaces()
	defer f.srv.Close()
	home := filepath.Join(t.TempDir(), "home")
	defer chmodWritable(home)
	steps := paritySteps(home)
	nodeOut, nodeFS := runScript(t, f, []string{node, script}, home, steps)
	goOut, goFS := runScript(t, f, []string{goBin}, home, steps)
	for i := range steps {
		if nodeOut[i] != goOut[i] {
			t.Errorf("step %s differs:\n--- node\n%s\n--- go\n%s", steps[i].name, nodeOut[i], goOut[i])
		}
	}
	if strings.Join(nodeFS, "\n") != strings.Join(goFS, "\n") {
		t.Errorf("files differ:\n--- node\n%s\n--- go\n%s", strings.Join(nodeFS, "\n"), strings.Join(goFS, "\n"))
	}
	if os.Getenv("TERMAG_PARITY_DUMP") != "" {
		t.Log(strings.Join(goOut, "\n") + "\n" + strings.Join(goFS, "\n"))
	}
	if t.Failed() {
		return
	}
	// Each step's output must not be trivially empty: the script exercises the paths it names.
	for _, want := range []string{"\"kind\": \"start\"", "changed since this session started", "WITHHELD", "\"kind\": \"failed\"", "hookSpecificOutput", "Changed fact"} {
		if !strings.Contains(strings.Join(goOut, "\n"), want) {
			t.Errorf("the script never printed %q", want)
		}
	}
}

// Node and Go alternate on one HOME: each reads the state, sessions and caches the other wrote.
func TestSpaceMemoryAlternatesWithNode(t *testing.T) {
	node, script := memoryNodeCLI(t)
	goBin := goBinary(t)
	f := newFakeSpaces()
	defer f.srv.Close()
	home := filepath.Join(t.TempDir(), "home")
	defer chmodWritable(home)
	steps := paritySteps(home)
	nodeOut, _ := runScript(t, f, []string{node, script}, home, steps)
	f.reset()
	freshHome(t, home, f.srv.URL)
	for i, s := range steps {
		if s.before != nil {
			f.mu.Lock()
			s.before(f)
			f.mu.Unlock()
		}
		cli := []string{goBin}
		if i%2 == 0 {
			cli = []string{node, script}
		}
		r := runCLI(t, append(cli, s.args...), home, s.stdin)
		got := fmt.Sprintf("== %s (exit %d)\n%s\n-- stderr\n%s", s.name, r.code, memoryNormalize(r.stdout), memoryNormalize(r.stderr))
		if got != nodeOut[i] {
			t.Errorf("alternating, step %s (%s) differs from Node alone:\n--- node\n%s\n--- alternating\n%s", s.name, cli[0], nodeOut[i], got)
		}
	}
}

// The repository's root, from this file's place in it.
func repoRoot(t *testing.T) string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..")
}
