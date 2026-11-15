package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

func spaceWrite(t *testing.T, path, data string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSpacePutSingleThenConflict(t *testing.T) {
	f := newSpaceFake(t)
	home := t.TempDir()
	local := spaceWrite(t, filepath.Join(home, "w", "notes.md"), "hello")
	r := spaceRunIn(t, f, home, "space", "put", local, "team:docs/", "--json")
	if r.code != 0 {
		t.Fatalf("put: %d %s", r.code, r.err)
	}
	want := fmt.Sprintf("{\n  \"space\": \"team\",\n  \"files\": [\n    {\n      \"local\": %q,\n      \"path\": \"docs/notes.md\",\n      \"size\": 5,\n      \"etag\": \"\\\"e1\\\"\"\n    }\n  ]\n}\n", local)
	if r.out != want {
		t.Fatalf("json:\n%s\nwant:\n%s", r.out, want)
	}
	if got := string(f.files["docs/notes.md"]); got != "hello" {
		t.Fatalf("stored %q", got)
	}
	if v := versionOf(home, "team", "docs/notes.md"); v == nil || v.Etag != `"e1"` || v.Via != "put" || v.VersionID != "v2" {
		t.Fatalf("version cache: %+v", v)
	}
	// Someone else writes; our put says which version it replaces and is refused: exit 6.
	f.put("docs/notes.md", "theirs")
	r = spaceRunIn(t, f, home, "space", "put", local, "team:docs/notes.md")
	if r.code != ExitChanged || r.err != "termag: docs/notes.md changed since you read it\n" || r.out != "" {
		t.Fatalf("conflict: %+v", r)
	}
	r = spaceRunIn(t, f, home, "space", "put", local, "team:docs/notes.md", "--json")
	if r.code != 6 || r.err != `{"error":{"code":"changed","message":"docs/notes.md changed since you read it"}}`+"\n" {
		t.Fatalf("conflict json: %+v", r)
	}
	// --force writes without the condition.
	r = spaceRunIn(t, f, home, "space", "put", local, "team:docs/notes.md", "--force")
	if r.code != 0 || r.out != "team:docs/notes.md (5 B)\n" {
		t.Fatalf("force: %+v", r)
	}
	// --if-new on an existing file is refused.
	r = spaceRunIn(t, f, home, "space", "put", local, "team:docs/notes.md", "--if-new")
	if r.code != 6 {
		t.Fatalf("if-new: %+v", r)
	}
	r = spaceRunIn(t, f, home, "space", "put", local, "team:docs/notes.md", "--if-new", "--force")
	if r.code != 2 || r.err != "termag: Give one of --force, --if-match and --if-new\n" {
		t.Fatalf("two flags: %+v", r)
	}
}

func TestSpacePutOldOrchestrator(t *testing.T) {
	f := newSpaceFake(t)
	f.noCond = true
	home := t.TempDir()
	local := spaceWrite(t, filepath.Join(home, "a.txt"), "x")
	r := spaceRunIn(t, f, home, "space", "put", local, "team:a.txt", "--if-match", `"e9"`)
	if r.code != 1 || r.err != "termag: This orchestrator cannot check versions yet; nothing written to team:a.txt. --force writes without the check.\n" {
		t.Fatalf("explicit: %+v", r)
	}
	f.put("a.txt", "old")
	if err := rememberVersion(&Ctx{Now: time.Now}, home, "team", "a.txt", f.etags["a.txt"], "", "get"); err != nil {
		t.Fatal(err)
	}
	r = spaceRunIn(t, f, home, "space", "put", local, "team:a.txt")
	if r.code != 0 || r.err != "termag: this orchestrator can't check versions yet; team:a.txt is written without the check\n" {
		t.Fatalf("implicit: %+v", r)
	}
}

func TestSpacePutMultipartBatches(t *testing.T) {
	f := newSpaceFake(t)
	f.partBytes = 2
	home := t.TempDir()
	data := strings.Repeat("abcdefghij", 4) // 40 bytes, 20 parts: one batch of 16, one of 4
	local := spaceWrite(t, filepath.Join(home, "big.bin"), data)
	r := spaceRunIn(t, f, home, "space", "put", local, "team:big.bin")
	if r.code != 0 {
		t.Fatalf("put: %+v", r)
	}
	if string(f.files["big.bin"]) != data {
		t.Fatalf("assembled %q", f.files["big.bin"])
	}
	if len(f.partReqs) != 2 || len(f.partReqs[0]) != 16 || f.partReqs[1][0] != 17 || len(f.partReqs[1]) != 4 {
		t.Fatalf("batches %v", f.partReqs)
	}
	if !strings.HasPrefix(r.err, "  part 1/20\n  part 2/20\n") || !strings.HasSuffix(r.err, "  part 20/20\n") {
		t.Fatalf("progress %q", r.err)
	}
	if r.out != "team:big.bin (40 B)\n" {
		t.Fatalf("out %q", r.out)
	}
	// An explicit condition an old orchestrator can't check aborts the multipart upload it started.
	f.noCond = true
	r = spaceRunIn(t, f, home, "space", "put", local, "team:big.bin", "--if-match", f.etags["big.bin"], "--json")
	if r.code != 1 || f.aborted != 1 || r.out != "" {
		t.Fatalf("abort: %+v aborted=%d", r, f.aborted)
	}
}

func TestSpacePutRecursiveWithConflict(t *testing.T) {
	f := newSpaceFake(t)
	home := t.TempDir()
	dir := filepath.Join(home, "dist")
	spaceWrite(t, filepath.Join(dir, "b.txt"), "b")
	spaceWrite(t, filepath.Join(dir, "a.txt"), "a")
	spaceWrite(t, filepath.Join(dir, "sub", "c.txt"), "c")
	// We read site/b.txt once; it changed since.
	f.put("site/b.txt", "old")
	if err := rememberVersion(&Ctx{Now: time.Now}, home, "team", "site/b.txt", `"stale"`, "", "get"); err != nil {
		t.Fatal(err)
	}
	r := spaceRunIn(t, f, home, "space", "put", "-r", dir, "team:site")
	if r.code != ExitChanged {
		t.Fatalf("code %+v", r)
	}
	wantErr := "put team:site/a.txt (1 B)\nrefused team:site/b.txt: site/b.txt changed since you read it\nput team:site/sub/c.txt (1 B)\n"
	if r.err != wantErr {
		t.Fatalf("stderr %q", r.err)
	}
	if r.out != "2 files into team:site; 1 refused, changed since you read them: site/b.txt (put them again with --force to overwrite)\n" {
		t.Fatalf("stdout %q", r.out)
	}
	f.put("site/b.txt", "newer")
	r = spaceRunIn(t, f, home, "space", "put", "-r", dir, "team:site/", "--json")
	var got struct {
		Files     []json.RawMessage `json:"files"`
		Conflicts []putConflict     `json:"conflicts"`
	}
	if err := json.Unmarshal([]byte(r.out), &got); err != nil || r.code != 6 || len(got.Files) != 2 || len(got.Conflicts) != 1 || r.err != "" {
		t.Fatalf("json %+v %v", r, err)
	}
	if !strings.Contains(r.out, "\"conflicts\": [\n    {\n      \"path\": \"site/b.txt\",\n      \"message\"") {
		t.Fatalf("conflict shape %s", r.out)
	}
	r = spaceRunIn(t, f, home, "space", "put", dir, "team:site")
	if r.code != 2 || r.err != "termag: "+dir+" is a folder; use -r\n" {
		t.Fatalf("no -r %+v", r)
	}
	r = spaceRunIn(t, f, home, "space", "put", "-r", "--if-match", "x", dir, "team:site")
	if r.code != 2 {
		t.Fatalf("-r --if-match %+v", r)
	}
}

func TestSpacePutRefusesSecretMemory(t *testing.T) {
	f := newSpaceFake(t)
	home := t.TempDir()
	local := spaceWrite(t, filepath.Join(home, "m.md"), "ok\nkey AKIA"+strings.Repeat("Q", 16)+"\n") // built here so the secret scanners don't flag the test
	r := spaceRunIn(t, f, home, "space", "put", local, "team:.termag/memory/m.md")
	if r.code != 1 || r.err != "termag: Refusing to upload: .termag/memory/m.md looks like a AWS access key id (line 2); space memory is read by every member's agents. Remove the secret first\n" {
		t.Fatalf("%+v", r)
	}
	if len(f.files) != 0 {
		t.Fatal("uploaded")
	}
	if r := spaceRunIn(t, f, home, "space", "put", local, "team:.termag/tools/m.md"); r.code != 0 {
		t.Fatalf("tools/ is not scanned: %+v", r)
	}
}

func TestSpaceGet(t *testing.T) {
	f := newSpaceFake(t)
	home := t.TempDir()
	f.put("docs/a.md", "AAA")
	f.put("docs/sub/b.md", "B")
	dest := filepath.Join(home, "out") + "/"
	r := spaceRunIn(t, f, home, "space", "get", "team:docs/a.md", dest, "--json")
	local := filepath.Join(home, "out", "a.md")
	want := fmt.Sprintf("{\n  \"space\": \"team\",\n  \"files\": [\n    {\n      \"path\": \"docs/a.md\",\n      \"local\": %q,\n      \"size\": 3,\n      \"etag\": \"\\\"e1\\\"\",\n      \"versionId\": \"v-docs/a.md\"\n    }\n  ]\n}\n", local)
	if r.code != 0 || r.out != want {
		t.Fatalf("%+v\nwant %s", r, want)
	}
	if b, _ := os.ReadFile(local); string(b) != "AAA" {
		t.Fatalf("got %q", b)
	}
	if v := versionOf(home, "team", "docs/a.md"); v == nil || v.Via != "get" {
		t.Fatalf("cache %+v", v)
	}
	r = spaceRunIn(t, f, home, "space", "get", "-r", "team:docs", filepath.Join(home, "tree"))
	if r.code != 0 || r.out != "2 files into "+filepath.Join(home, "tree")+"\n" || r.err != "got team:docs/a.md (3 B)\ngot team:docs/sub/b.md (1 B)\n" {
		t.Fatalf("-r %+v", r)
	}
	if b, _ := os.ReadFile(filepath.Join(home, "tree", "sub", "b.md")); string(b) != "B" {
		t.Fatalf("tree %q", b)
	}
	r = spaceRunIn(t, f, home, "space", "get", "team:docs/")
	if r.code != 2 || r.err != "termag: That is a folder; use -r\n" {
		t.Fatalf("folder %+v", r)
	}
	r = spaceRunIn(t, f, home, "space", "get", "team:nope.md", filepath.Join(home, "x"))
	if r.code != 3 {
		t.Fatalf("missing %+v", r)
	}
}

func TestSpaceGetWithoutDestNeverClobbers(t *testing.T) {
	f := newSpaceFake(t)
	home := t.TempDir()
	f.put("a.md", "remote")
	wd, _ := os.Getwd()
	t.Cleanup(func() { _ = os.Chdir(wd) })
	if err := os.Chdir(home); err != nil {
		t.Fatal(err)
	}
	spaceWrite(t, filepath.Join(home, "a.md"), "mine")
	r := spaceRunIn(t, f, home, "space", "get", "a.md") // the only space
	// The working directory as the process sees it: on macOS the temp folder is under /var, a link
	// to /private/var, and Getwd reports the resolved path.
	cwd, _ := os.Getwd()
	wantErr := "termag: " + filepath.Join(cwd, "a.md") + " already exists, and space get with no destination does not replace files. Give a destination: `termag space get a.md <dest>` (a path outside a git checkout, or the existing path to replace it).\n"
	if r.code != 1 || r.err != wantErr {
		t.Fatalf("%+v", r)
	}
	if b, _ := os.ReadFile(filepath.Join(home, "a.md")); string(b) != "mine" {
		t.Fatal("clobbered")
	}
}

func TestSpaceRmMv(t *testing.T) {
	f := newSpaceFake(t)
	home := t.TempDir()
	f.put("a.md", "1")
	f.put("dir/x", "2")
	f.put("dir/y", "3")
	if err := rememberVersion(&Ctx{Now: time.Now}, home, "team", "a.md", `"e1"`, "", "get"); err != nil {
		t.Fatal(err)
	}
	r := spaceRunIn(t, f, home, "space", "mv", "team:a.md", "team:b.md", "--json")
	if r.code != 0 || r.out != "{\n  \"space\": \"team\",\n  \"from\": \"a.md\",\n  \"to\": \"b.md\",\n  \"ok\": true,\n  \"moved\": 1,\n  \"failed\": []\n}\n" {
		t.Fatalf("mv %+v", r)
	}
	if f.lastBody["ifMatch"] != `"e1"` {
		t.Fatalf("mv condition %v", f.lastBody)
	}
	if versionOf(home, "team", "a.md") != nil {
		t.Fatal("mv kept the version")
	}
	r = spaceRunIn(t, f, home, "space", "mv", "team:a.md", "other:b.md")
	if r.code != 2 || r.err != "termag: mv works inside one space; use get and put to copy between spaces\n" {
		t.Fatalf("cross-space %+v", r)
	}
	// rm of a file this client read sends its version; a newer one is refused with exit 6.
	if err := rememberVersion(&Ctx{Now: time.Now}, home, "team", "b.md", `"old"`, "", "get"); err != nil {
		t.Fatal(err)
	}
	r = spaceRunIn(t, f, home, "space", "rm", "team:b.md")
	if r.code != 6 || f.lastQuery != "path=b.md&ifMatch=%22old%22" {
		t.Fatalf("rm conflict %+v %q", r, f.lastQuery)
	}
	r = spaceRunIn(t, f, home, "space", "rm", "team:b.md", "--force")
	if r.code != 0 || r.out != "Deleted 1 file from team:b.md\n" {
		t.Fatalf("rm %+v", r)
	}
	r = spaceRunIn(t, f, home, "space", "rm", "-r", "team:dir", "--json")
	if r.code != 0 || f.lastQuery != "path=dir&recursive=1" || r.out != "{\n  \"space\": \"team\",\n  \"path\": \"dir\",\n  \"ok\": true,\n  \"deleted\": 2,\n  \"failed\": []\n}\n" {
		t.Fatalf("rm -r %+v %q", r, f.lastQuery)
	}
	r = spaceRunIn(t, f, home, "space", "rm", "-r", "team:")
	if r.code != 2 || r.err != "termag: Refusing to empty a whole space; name a folder\n" {
		t.Fatalf("rm space %+v", r)
	}
}

func TestSpaceLsFake(t *testing.T) {
	f := newSpaceFake(t)
	home := t.TempDir()
	r := spaceRunIn(t, f, home, "space", "ls")
	if r.out != "SPACE  ROLE    ACCESS  USED\nteam   editor  -       2.0 KiB of 1.0 GiB\n" {
		t.Fatalf("%q", r.out)
	}
	r = spaceRunIn(t, f, home, "space", "ls", "team")
	if r.out != "team: is empty.\n" {
		t.Fatalf("%q", r.out)
	}
	f.put("n.md", strings.Repeat("x", 1178))
	r = spaceRunIn(t, f, home, "space", "ls", "team")
	if r.out != "NAME  SIZE     MODIFIED\nn.md  1.2 KiB  2026-11-12 10:20\n" {
		t.Fatalf("%q", r.out)
	}
}

func TestFormatBytesMatchesJS(t *testing.T) {
	// node: the same formatBytes over these sizes.
	cases := map[float64]string{0: "0 B", 1023: "1023 B", 1024: "1.0 KiB", 1177.6: "1.1 KiB", 1178: "1.2 KiB", 2560: "2.5 KiB",
		10239: "10.0 KiB", 10240: "10 KiB", 10751.9: "10 KiB", 1048575: "1024 KiB", 1572864: "1.5 MiB", 689756024: "658 MiB",
		107374182400: "100 GiB", 1280: "1.3 KiB", 1075.2: "1.1 KiB", 10188.8: "9.9 KiB"}
	for n, want := range cases {
		if got := formatBytes(n); got != want {
			t.Errorf("formatBytes(%v) = %q, want %q", n, got, want)
		}
	}
}

func TestLocaleLessMatchesNode(t *testing.T) {
	names := []string{"b", "B", "a", "A", "_x", "10", "9", "-a", ".z", "a.txt", "a-b", "ab", "Ab", "z"}
	sort.SliceStable(names, func(i, j int) bool { return localeLess(names[i], names[j]) })
	// node: [...].sort((x, y) => x.localeCompare(y))
	want := `["_x","-a",".z","10","9","a","A","a-b","a.txt","ab","Ab","b","B","z"]`
	if b, _ := json.Marshal(names); string(b) != want {
		t.Fatalf("%s\nwant %s", b, want)
	}
}

func TestSpaceUsageBeforeAuth(t *testing.T) {
	c := &Ctx{Env: map[string]string{}, Home: t.TempDir(), ReadFile: func(string) ([]byte, bool) { return nil, false }}
	var errb strings.Builder
	c.Out = func(string) {}
	c.Err = func(s string) { errb.WriteString(s + "\n") }
	for argv, want := range map[string]string{
		"space get":         "termag: Usage: termag space get <space:path> [dest] [-r] [--mine]\n",
		"space url a/":      "termag: Name a file, not a folder\n",
		"space put a":       "termag: Usage: termag space put <local> <space:path> [-r] [--mine] [--if-match <etag> | --if-new | --force]\n",
		"space put /nope x": "termag: No such file: /nope\n",
	} {
		errb.Reset()
		Run(strings.Fields(argv), c)
		if errb.String() != want {
			t.Errorf("%s: %q", argv, errb.String())
		}
	}
}

// `space get -r` into a folder where a subfolder is a symlink to somewhere else: nothing is written
// through it (the Node CLI's localTarget is lexical and would follow it; this is deliberate).
func TestSpaceGetRefusesASymlinkedFolderUnderTheRoot(t *testing.T) {
	f := newSpaceFake(t)
	home := t.TempDir()
	outside := t.TempDir()
	f.put("docs/sub/b.md", "B")
	root := filepath.Join(home, "tree")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "sub")); err != nil {
		t.Fatal(err)
	}
	r := spaceRunIn(t, f, home, "space", "get", "-r", "team:docs", root)
	if r.code != 1 || !strings.Contains(r.err, `termag: Refusing to write "sub/b.md" outside `+root+": "+filepath.Join(root, "sub")+" leads to ") {
		t.Fatalf("%+v", r)
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("wrote through the link: %v", entries)
	}
	// A destination that is itself a link is the person's choice, and fine.
	linked := filepath.Join(home, "linked")
	if err := os.Symlink(outside, linked); err != nil {
		t.Fatal(err)
	}
	r = spaceRunIn(t, f, home, "space", "get", "-r", "team:docs", linked)
	if r.code != 0 {
		t.Fatalf("a linked destination: %+v", r)
	}
	if b, _ := os.ReadFile(filepath.Join(outside, "sub", "b.md")); string(b) != "B" {
		t.Fatalf("through the linked destination: %q", b)
	}
}

// A file in the tree that is a symlink (and a planted `.termag-partial` link) is replaced, never
// written through: the file it points at keeps its bytes.
func TestSpaceGetReplacesASymlinkedFileWithoutWritingThroughIt(t *testing.T) {
	f := newSpaceFake(t)
	home := t.TempDir()
	outside := filepath.Join(t.TempDir(), "precious")
	spaceWrite(t, outside, "keep me")
	other := filepath.Join(t.TempDir(), "other")
	spaceWrite(t, other, "keep me too")
	f.put("docs/a.md", "AAA")
	root := filepath.Join(home, "tree")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "a.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, filepath.Join(root, "a.md.termag-partial")); err != nil {
		t.Fatal(err)
	}
	r := spaceRunIn(t, f, home, "space", "get", "-r", "team:docs", root)
	if r.code != 0 {
		t.Fatalf("%+v", r)
	}
	if b, _ := os.ReadFile(outside); string(b) != "keep me" {
		t.Fatalf("wrote through the file link: %q", b)
	}
	if b, _ := os.ReadFile(other); string(b) != "keep me too" {
		t.Fatalf("wrote through the partial link: %q", b)
	}
	st, err := os.Lstat(filepath.Join(root, "a.md"))
	if err != nil || st.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("a.md is still a link: %v %v", st, err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "a.md")); string(b) != "AAA" {
		t.Fatalf("a.md %q", b)
	}
}

// Project files and My files aren't ported yet: a run that could use them is Node's (projectFilesInPlay).
func TestSpaceProjectFilesGoToNode(t *testing.T) {
	cases := []struct {
		env  map[string]string
		argv []string
	}{
		{map[string]string{"TERMAG_SPACE": "ana-termag"}, []string{"space", "put", "a", "b/"}},
		{map[string]string{"TERMAG_MY_FILES": "ana-my-files"}, []string{"space", "ls"}},
		{map[string]string{}, []string{"space", "get", "--mine", "a"}},
		{map[string]string{}, []string{"space", "rm", "--mine", "a"}},
		{map[string]string{}, []string{"space", "mv", "--mine", "a", "b"}},
		{map[string]string{}, []string{"space", "url", "--mine", "a"}},
	}
	for _, tc := range cases {
		a, err := ParseCommandLine(tc.argv)
		if err != nil {
			t.Fatalf("%v: %v", tc.argv, err)
		}
		c := &Ctx{Env: tc.env, Home: t.TempDir()}
		handler := handlers[a.Command]
		if _, err := handler(c, a); err != errFallback {
			t.Errorf("%v with %v: %v, want the Node fallback", tc.argv, tc.env, err)
		}
	}
}
