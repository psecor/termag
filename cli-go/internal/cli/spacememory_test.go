package cli

import (
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseDuration(t *testing.T) {
	for in, want := range map[string]time.Duration{"60s": time.Minute, " 5m ": 5 * time.Minute, "90": 90 * time.Second, "250ms": 250 * time.Millisecond, "1d": 24 * time.Hour} {
		if got, err := parseDuration(in); err != nil || got != want {
			t.Errorf("%q: %v %v", in, got, err)
		}
	}
	if _, err := parseDuration("1w"); err == nil || err.Error() != `Not a duration: "1w" (e.g. 60s, 5m)` {
		t.Errorf("1w: %v", err)
	}
}

// The WHATWG decoder: one U+FFFD per maximal invalid subpart.
func TestNodeUTF8(t *testing.T) {
	for in, want := range map[string]string{
		"ok é":         "ok é",
		"a\xe2\x82b":   "a�b",
		"\xff\xfe":     "��",
		"\xf0\x9f\x98": "�",
		"\xed\xa0\x80": "���",
		"x\xc3":        "x�",
	} {
		if got := nodeUTF8([]byte(in)); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}

func TestGenerationOf(t *testing.T) {
	m := newFileMap()
	m.set("memory/b.md", localFile{Etag: `"2"`})
	m.set("memory/a.md", localFile{Etag: `"1"`})
	// sha256("memory/a.md\0\"1\"\nmemory/b.md\0\"2\"\n")[:16], as spaceMemory.ts computes it.
	if got := generationOf(m); got != "42af562717ca7fbc" {
		t.Errorf("got %s", got)
	}
}

func TestKindOfAndPlan(t *testing.T) {
	if k := kindOf("skills/Foo/SKILL.md"); k != nil {
		t.Error("an upper-case skill name is not a skill")
	}
	if k := kindOf("tools/x.html"); k != nil {
		t.Error("tools/ is not memory")
	}
	load, skipped := planLoad([]listedFile{{rel: "memory/a.md", size: 9000}, {rel: "prompt.md", size: 10}, {rel: "tools/x", size: 1}})
	if len(load) != 1 || load[0] != "prompt.md" || len(skipped) != 1 || skipped[0].Reason != "over 8 KB" {
		t.Errorf("%v %v", load, skipped)
	}
}

func TestHookIsQuietWhenManaged(t *testing.T) {
	var out []string
	c := &Ctx{Env: map[string]string{"TERMAG_SPACE_MEMORY_MANAGED": "1"}, Home: t.TempDir(), Out: func(s string) { out = append(out, s) }, Err: func(string) {}}
	a, err := ParseCommandLine([]string{"space", "memory", "context", "--hook", "SessionStart"})
	if err != nil {
		t.Fatal(err)
	}
	if code, err := cmdSpaceMemory(c, a); code != 0 || err != nil || len(out) != 0 {
		t.Errorf("%d %v %v", code, err, out)
	}
}

func TestUnportedMemoryFallsBack(t *testing.T) {
	for _, sub := range []string{"add", "edit", "rm", "log", "pane-claude"} {
		a := &ParsedArgs{Args: []string{sub}}
		if _, err := cmdSpaceMemory(&Ctx{}, a); err != errFallback {
			t.Errorf("%s: %v", sub, err)
		}
	}
}

// A hook with no memory prints nothing, and never fails.
func TestHookWithoutMemory(t *testing.T) {
	home := t.TempDir()
	_ = os.MkdirAll(filepath.Join(home, ".termag", "spaces"), 0o700)
	var out []string
	c := &Ctx{Env: map[string]string{}, Home: home, Out: func(s string) { out = append(out, s) }, Err: func(string) {}, Now: time.Now}
	a, _ := ParseCommandLine([]string{"space", "memory", "context", "--hook", "SessionStart"})
	if code, err := cmdSpaceMemory(c, a); code != 0 || err != nil || len(out) != 0 {
		t.Fatalf("%d %v %v", code, err, out)
	}
}

// A mirror subfolder replaced by a symlink to a folder elsewhere: space sync removes the link
// without following it and restores the folder; the linked-to folder is untouched. (space get keeps
// refusing a linked parent; see TestSpaceGetRefusesASymlinkedFolderUnderTheRoot.)
func TestSpaceSyncRepairsAMirrorFolderThatBecameASymlink(t *testing.T) {
	goBin := goBinary(t)
	f := newFakeSpaces()
	defer f.srv.Close()
	home := filepath.Join(t.TempDir(), "home")
	defer chmodWritable(home)
	freshHome(t, home, f.srv.URL)
	if r := runCLI(t, []string{goBin, "space", "sync", "s1", "--json"}, home, ""); r.code != 0 {
		t.Fatalf("first sync: %+v", r)
	}
	mirror := filepath.Join(home, "termag", "spaces", "s1")
	deep := filepath.Join(mirror, "docs", "deep")
	if b, err := os.ReadFile(filepath.Join(deep, "one.txt")); err != nil || string(b) != "one" {
		t.Fatalf("first sync did not mirror docs/deep/one.txt: %q %v", b, err)
	}
	outside := t.TempDir()
	decoy := filepath.Join(outside, "one.txt")
	if err := os.WriteFile(decoy, []byte("not the mirror's"), 0o644); err != nil {
		t.Fatal(err)
	}
	chmodWritable(mirror)
	if err := os.RemoveAll(deep); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, deep); err != nil {
		t.Fatal(err)
	}
	r := runCLI(t, []string{goBin, "space", "sync", "s1", "--json"}, home, "")
	if r.code != 0 {
		t.Fatalf("repair sync: %+v", r)
	}
	st, err := os.Lstat(deep)
	if err != nil || st.Mode()&os.ModeSymlink != 0 || !st.IsDir() {
		t.Fatalf("docs/deep is not a folder again: %v %v", st, err)
	}
	if b, err := os.ReadFile(filepath.Join(deep, "one.txt")); err != nil || string(b) != "one" {
		t.Fatalf("docs/deep/one.txt not restored: %q %v", b, err)
	}
	if b, _ := os.ReadFile(decoy); string(b) != "not the mirror's" {
		t.Fatalf("wrote through the link: %q", b)
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 1 {
		t.Fatalf("the linked-to folder changed: %v", entries)
	}
}

// The same repair, but the mirror folder holding the link is read-only, so the link can't be
// unlinked, and the folder it points at holds a folder named like a mirrored file. The sync must
// fail, and remove nothing outside the mirror: before, clearWay walked on through the link it could
// not remove and deleted that outside folder.
func TestSpaceSyncNeverDeletesThroughALinkItCannotRemove(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores the read-only folder")
	}
	goBin := goBinary(t)
	f := newFakeSpaces()
	defer f.srv.Close()
	home := filepath.Join(t.TempDir(), "home")
	defer chmodWritable(home)
	freshHome(t, home, f.srv.URL)
	if r := runCLI(t, []string{goBin, "space", "sync", "s1", "--json"}, home, ""); r.code != 0 {
		t.Fatalf("first sync: %+v", r)
	}
	mirror := filepath.Join(home, "termag", "spaces", "s1")
	docs := filepath.Join(mirror, "docs")
	deep := filepath.Join(docs, "deep")
	outside := t.TempDir()
	// A folder outside named like the mirrored file docs/deep/one.txt, with a file of its own.
	victim := filepath.Join(outside, "one.txt")
	if err := os.MkdirAll(victim, 0o755); err != nil {
		t.Fatal(err)
	}
	decoy := filepath.Join(victim, "precious")
	if err := os.WriteFile(decoy, []byte("keep me"), 0o644); err != nil {
		t.Fatal(err)
	}
	chmodWritable(mirror)
	if err := os.RemoveAll(deep); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, deep); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(docs, 0o555); err != nil { // the link can't be unlinked now
		t.Fatal(err)
	}
	r := runCLI(t, []string{goBin, "space", "sync", "s1", "--json"}, home, "")
	// First: the outside content survived.
	if b, err := os.ReadFile(decoy); err != nil || string(b) != "keep me" {
		t.Fatalf("deleted through the link: %q %v", b, err)
	}
	if st, err := os.Lstat(victim); err != nil || !st.IsDir() {
		t.Fatalf("the outside folder is gone: %v %v", st, err)
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 1 {
		t.Fatalf("the outside folder changed: %v", entries)
	}
	// Then: the sync failed, safely, saying why.
	if r.code == 0 || !strings.Contains(r.stdout+r.stderr, "could not remove "+deep) {
		t.Fatalf("want a failed sync naming the link: %+v", r)
	}
	if st, err := os.Lstat(deep); err != nil || st.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the link should still be there: %v %v", st, err)
	}
	_ = os.Chmod(docs, 0o755)
}

// A panic in one of listLoadable's goroutines becomes the command's ordinary error instead of
// ending the process with exit 2 (which Claude Code reads as a hook blocking the prompt). Without
// the recover, this test binary itself would crash.
func TestSpaceMemoryGoroutinePanicIsAnOrdinaryError(t *testing.T) {
	f := newFakeSpaces()
	defer f.srv.Close()
	home := filepath.Join(t.TempDir(), "home")
	defer chmodWritable(home)
	freshHome(t, home, f.srv.URL)
	var calls atomic.Int32
	listLoadableHook = func(i int) {
		calls.Add(1)
		if i == 1 {
			panic("boom in a listing goroutine")
		}
	}
	defer func() { listLoadableHook = nil }()
	run := func(stdin string, argv ...string) (int, string, string) {
		var out, errb strings.Builder
		c := &Ctx{
			Env:      map[string]string{"TERMAG_TELEMETRY": "0", "TERMAG_AGENT_CONFIG": filepath.Join(home, "agent.config.json"), "TERMAG_SPACE": "s1"},
			Home:     home,
			Out:      LineWriter(&out),
			Err:      LineWriter(&errb),
			HTTP:     newHTTPClient(nil),
			ReadFile: func(p string) ([]byte, bool) { b, err := os.ReadFile(p); return b, err == nil },
			Stdin:    strings.NewReader(stdin),
			Now:      time.Now,
			Sleep:    func(time.Duration) {},
		}
		return Run(argv, c), out.String(), errb.String()
	}
	code, _, errText := run("", "space", "memory", "sync", "s1")
	if code != 1 || !strings.HasPrefix(errText, "termag: internal error: boom in a listing goroutine") {
		t.Errorf("sync: exit %d, stderr %q; want exit 1 with the usual termag: line", code, errText)
	}
	code, _, errText = run("", "space", "memory", "sync", "s1", "--json")
	if code != 1 || !strings.HasPrefix(errText, `{"error":{"code":"failed","message":"internal error: boom`) {
		t.Errorf("sync --json: exit %d, stderr %q", code, errText)
	}
	// The hook path: never 2 (which would block the prompt). A hook never fails the prompt, so it
	// prints what it can without memory and exits 0, as with any other failure.
	for _, hook := range []string{"SessionStart", "UserPromptSubmit"} {
		before := calls.Load()
		code, _, _ = run(`{"session_id":"panic-test-`+hook+`","cwd":"`+home+`"}`, "space", "memory", "context", "--hook", hook, "--refresh", "60s")
		if code != 0 {
			t.Errorf("hook %s: exit %d, want 0", hook, code)
		}
		if calls.Load() == before {
			t.Errorf("hook %s never reached the listing goroutines", hook)
		}
	}
}

// A stale file the prune cannot remove (its folder is read-only) fails the sync with the usual
// failed-space result and exit 1, rather than reporting success with the file still there.
func TestSpaceSyncFailsWhenPruneCannotRemove(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores the read-only folder")
	}
	goBin := goBinary(t)
	f := newFakeSpaces()
	defer f.srv.Close()
	home := filepath.Join(t.TempDir(), "home")
	defer chmodWritable(home)
	freshHome(t, home, f.srv.URL)
	if r := runCLI(t, []string{goBin, "space", "sync", "s1", "--json"}, home, ""); r.code != 0 {
		t.Fatalf("first sync: %+v", r)
	}
	docs := filepath.Join(home, "termag", "spaces", "s1", "docs")
	chmodWritable(docs)
	stale := filepath.Join(docs, "stale.txt")
	if err := os.WriteFile(stale, []byte("gone from the space"), 0o444); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(docs, 0o555); err != nil {
		t.Fatal(err)
	}
	r := runCLI(t, []string{goBin, "space", "sync", "s1", "--json"}, home, "")
	_ = os.Chmod(docs, 0o755)
	if r.code != 1 || !strings.Contains(r.stdout, `"kind": "failed"`) || !strings.Contains(r.stdout, "stale.txt") {
		t.Fatalf("want a failed sync naming the file: %+v", r)
	}
	if _, err := os.Lstat(stale); err != nil {
		t.Fatalf("the stale file should still be there: %v", err)
	}
}
