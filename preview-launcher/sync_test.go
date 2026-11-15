package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

type syncFixture struct {
	home, checkout, run, work, outside string
}

func newSyncFixture(t *testing.T) *syncFixture {
	t.Helper()
	home := t.TempDir()
	f := &syncFixture{
		home:     home,
		checkout: filepath.Join(home, "p/app"),
		run:      filepath.Join(home, "state/r1"),
		outside:  filepath.Join(home, "outside"),
	}
	f.work = filepath.Join(f.run, "work")
	write(t, filepath.Join(f.checkout, "src/main.js"), "main")
	write(t, filepath.Join(f.checkout, "public/index.html"), "<h1>")
	write(t, filepath.Join(f.checkout, ".gitignore"), "node_modules\ndist\n.env\n")
	write(t, filepath.Join(f.checkout, "dist/old.js"), "build output")
	write(t, filepath.Join(f.checkout, ".env"), "A=1")
	write(t, filepath.Join(f.checkout, "node_modules/react/index.js"), "react")
	write(t, filepath.Join(f.checkout, "node_modules/.vite/deps/x.js"), "the owner's cache")
	write(t, filepath.Join(f.outside, "secret"), "secret")
	write(t, filepath.Join(f.outside, "target"), "untouched")
	// A committed symlink to a file outside the checkout.
	if err := os.Symlink(filepath.Join(f.outside, "secret"), filepath.Join(f.checkout, "public/leak")); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "-q"}, {"add", "-A"}, {"-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = f.checkout
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	write(t, filepath.Join(f.checkout, "src/untracked.js"), "new")
	if err := os.MkdirAll(f.work, 0o700); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *syncFixture) syncer(t *testing.T) *Syncer {
	t.Helper()
	s, err := NewSyncer(f.checkout, f.work)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func readOrErr(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return "error"
	}
	return string(b)
}

func TestInitialCopy(t *testing.T) {
	f := newSyncFixture(t)
	s := f.syncer(t)
	if err := s.Initial(false); err != nil {
		t.Fatal(err)
	}
	for p, want := range map[string]string{
		"src/main.js": "main", "src/untracked.js": "new", "public/index.html": "<h1>", ".env": "A=1",
	} {
		if got := readOrErr(filepath.Join(f.work, p)); got != want {
			t.Errorf("%s: %q, want %q", p, got, want)
		}
	}
	for _, p := range []string{".git", "dist/old.js", "node_modules/.vite"} {
		if _, err := os.Lstat(filepath.Join(f.work, p)); err == nil {
			t.Errorf("%s copied", p)
		}
	}
	// Symlinks stay symlinks.
	if target, err := os.Readlink(filepath.Join(f.work, "public/leak")); err != nil || target != filepath.Join(f.outside, "secret") {
		t.Errorf("public/leak: %q %v", target, err)
	}
	// The overlay: a real directory, a link per package, no owner's cache.
	if fi, err := os.Lstat(filepath.Join(f.work, "node_modules")); err != nil || !fi.IsDir() {
		t.Fatalf("node_modules is not a directory: %v", err)
	}
	if target, _ := os.Readlink(filepath.Join(f.work, "node_modules/react")); target != filepath.Join(f.checkout, "node_modules/react") {
		t.Errorf("react links to %q", target)
	}
}

func TestCopyNodeModules(t *testing.T) {
	f := newSyncFixture(t)
	s := f.syncer(t)
	if err := s.Initial(true); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Lstat(filepath.Join(f.work, "node_modules/react/index.js")); err != nil || !fi.Mode().IsRegular() {
		t.Errorf("react/index.js not copied: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(f.work, "node_modules/.vite")); err == nil {
		t.Error("the owner's .vite cache was copied")
	}
}

// Pinning (SR9): a symlink planted in the run directory at a path the sync
// later writes is replaced, not written through, and nothing outside the run
// directory changes.
func TestPlantedSymlinksAreReplaced(t *testing.T) {
	f := newSyncFixture(t)
	s := f.syncer(t)
	if err := s.Initial(false); err != nil {
		t.Fatal(err)
	}
	// The app plants a file symlink where a source file goes, and a directory
	// symlink where a source directory goes.
	os.Remove(filepath.Join(f.work, "src/main.js"))
	if err := os.Symlink(filepath.Join(f.outside, "target"), filepath.Join(f.work, "src/main.js")); err != nil {
		t.Fatal(err)
	}
	os.RemoveAll(filepath.Join(f.work, "public"))
	if err := os.Symlink(f.outside, filepath.Join(f.work, "public")); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(f.checkout, "src/main.js"), "edited")
	write(t, filepath.Join(f.checkout, "public/index.html"), "edited")
	for _, p := range []string{"src/main.js", "public/index.html"} {
		if err := s.CopyPath(p); err != nil {
			t.Fatalf("%s: %v", p, err)
		}
	}
	if got := readOrErr(filepath.Join(f.outside, "target")); got != "untouched" {
		t.Errorf("outside target now %q", got)
	}
	if _, err := os.Lstat(filepath.Join(f.outside, "index.html")); err == nil {
		t.Error("index.html written through the planted directory link")
	}
	for _, p := range []string{"src/main.js", "public/index.html"} {
		fi, err := os.Lstat(filepath.Join(f.work, p))
		if err != nil || !fi.Mode().IsRegular() || readOrErr(filepath.Join(f.work, p)) != "edited" {
			t.Errorf("%s not replaced with the edited file: %v", p, err)
		}
	}
}

func TestDeletionOnlyRemovesWhatTheSyncCopied(t *testing.T) {
	f := newSyncFixture(t)
	s := f.syncer(t)
	if err := s.Initial(false); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(f.work, "dist/app.js"), "the app's build output")
	os.Remove(filepath.Join(f.checkout, "src/untracked.js"))
	if err := s.CopyPath("src/untracked.js"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(f.work, "src/untracked.js")); err == nil {
		t.Error("deleted file still in work")
	}
	if err := s.CopyPath("dist/app.js"); err != nil {
		t.Fatal(err)
	}
	if readOrErr(filepath.Join(f.work, "dist/app.js")) != "the app's build output" {
		t.Error("the sync removed an output it never copied")
	}
}

// A git listing that fails says nothing about what's gone: a batch of changes
// leaves the work copy as it was (Bugbot, #1519).
func TestFailedListingRemovesNothing(t *testing.T) {
	f := newSyncFixture(t)
	s := f.syncer(t)
	if err := s.Initial(false); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(f.checkout, ".git"), filepath.Join(f.checkout, ".git-gone")); err != nil {
		t.Fatal(err)
	}
	var log strings.Builder
	s.flush(map[string]bool{"src/main.js": true, "public/index.html": true}, &log)
	for _, p := range []string{"src/main.js", "public/index.html"} {
		if _, err := os.Lstat(filepath.Join(f.work, p)); err != nil {
			t.Errorf("%s removed after a failed listing: %v", p, err)
		}
	}
	if !strings.Contains(log.String(), "2 changes not synced") {
		t.Errorf("log: %q", log.String())
	}
}

// A copy that fails part way leaves no temp file in the work copy (Bugbot, #1519).
func TestFailedCopyLeavesNoTempFile(t *testing.T) {
	f := newSyncFixture(t)
	s := f.syncer(t)
	// A directory opens read-only, then its read fails: the temp name exists by then.
	if err := copyFile(s.src, "src", s.dst, tmpPrefix+"t", 0o644); err == nil {
		t.Fatal("copying a directory succeeded")
	}
	ents, _ := os.ReadDir(f.work)
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), tmpPrefix) {
			t.Errorf("left %s", e.Name())
		}
	}
}

func TestCopyPathRefusesEscapes(t *testing.T) {
	f := newSyncFixture(t)
	s := f.syncer(t)
	for _, p := range []string{"../outside/secret", "/etc/passwd", ".git/config", "a/.git/hooks/x", "."} {
		if err := s.CopyPath(p); err == nil {
			t.Errorf("%s accepted", p)
		}
	}
}

// The helper, confined, with the watch: an edit reaches the work copy, and a
// planted symlink is replaced while the target outside stays as it was.
func TestConfinedSyncWatch(t *testing.T) {
	requireLandlock(t)
	f := newSyncFixture(t)
	cmd := exec.Command(launcherBin, "sync", "--home", f.home, "--checkout", f.checkout, "--run", f.run, "--watch")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	waitFor(t, func() bool { return strings.Contains(stderr.String(), "ready") }, "ready")
	os.Remove(filepath.Join(f.work, "src/main.js"))
	if err := os.Symlink(filepath.Join(f.outside, "target"), filepath.Join(f.work, "src/main.js")); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(f.checkout, "src/main.js"), "edited")
	write(t, filepath.Join(f.checkout, "src/new/deep.js"), "deep")
	waitFor(t, func() bool {
		return readOrErr(filepath.Join(f.work, "src/main.js")) == "edited" && readOrErr(filepath.Join(f.work, "src/new/deep.js")) == "deep"
	}, "the edits\n"+stderr.String())
	if got := readOrErr(filepath.Join(f.outside, "target")); got != "untouched" {
		t.Errorf("outside target now %q", got)
	}
	if fi, _ := os.Lstat(filepath.Join(f.work, "src/main.js")); fi == nil || !fi.Mode().IsRegular() {
		t.Error("planted symlink not replaced")
	}
	write(t, filepath.Join(f.checkout, "dist/ignored.js"), "ignored")
	time.Sleep(300 * time.Millisecond)
	if _, err := os.Lstat(filepath.Join(f.work, "dist/ignored.js")); err == nil {
		t.Error("an ignored file was synced")
	}
}

// The cleanup empties the run directory and follows nothing.
func TestConfinedClean(t *testing.T) {
	requireLandlock(t)
	f := newSyncFixture(t)
	if err := os.Symlink(f.outside, filepath.Join(f.work, "planted")); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(f.work, "a/b/c.js"), "x")
	out, err := exec.Command(launcherBin, "clean", "--home", f.home, "--checkout", f.checkout, "--run", f.run).CombinedOutput()
	if err != nil {
		t.Fatalf("%v %s", err, out)
	}
	if ents, _ := os.ReadDir(f.run); len(ents) != 0 {
		t.Errorf("run dir not empty: %v", ents)
	}
	if readOrErr(filepath.Join(f.outside, "secret")) != "secret" {
		t.Error("cleanup followed the planted link")
	}
}

func waitFor(t *testing.T, cond func() bool, what string) {
	t.Helper()
	for i := 0; i < 100; i++ {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// A workstream checkout is a linked worktree: its .git is a file pointing at
// <repo>/.git/worktrees/<name>. The confined sync can read that metadata and
// copies the worktree (Devin, #1519).
func TestConfinedSyncLinkedWorktree(t *testing.T) {
	requireLandlock(t)
	f := newSyncFixture(t)
	wt := filepath.Join(f.checkout, ".worktrees/feature")
	cmd := exec.Command("git", "-C", f.checkout, "worktree", "add", "-q", "-b", "feature", wt)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("worktree add: %v %s", err, out)
	}
	write(t, filepath.Join(wt, "src/feature.js"), "feature")
	cmd = exec.Command(launcherBin, "sync", "--home", f.home, "--checkout", wt, "--run", f.run)
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "ready") {
		t.Fatalf("sync of a linked worktree: %v\n%s", err, out)
	}
	for _, p := range []string{"src/main.js", "src/feature.js", "public/index.html"} {
		if _, err := os.Lstat(filepath.Join(f.work, p)); err != nil {
			t.Errorf("%s not copied: %v", p, err)
		}
	}
	dirs, err := LinkedGitDirs(wt, f.home)
	want := []string{filepath.Join(f.checkout, ".git/worktrees/feature"), filepath.Join(f.checkout, ".git")}
	if err != nil || strings.Join(dirs, "|") != strings.Join(want, "|") {
		t.Errorf("git dirs %v %v, want %v", dirs, err, want)
	}
}

// A .git file can't aim the sync helper's read rights anywhere but a
// worktree's own git directory.
func TestLinkedGitDirsRefusesOtherTargets(t *testing.T) {
	home := t.TempDir()
	c := filepath.Join(home, "p/app")
	write(t, filepath.Join(home, ".aws/credentials"), "secret")
	write(t, filepath.Join(home, ".aws/worktrees/x/HEAD"), "ref")
	for name, target := range map[string]string{
		"~/.aws":                          filepath.Join(home, ".aws"),
		"a worktrees dir without objects": filepath.Join(home, ".aws/worktrees/x"),
		"outside home":                    "/etc/worktrees/x",
	} {
		write(t, filepath.Join(c, ".git"), "gitdir: "+target+"\n")
		if dirs, err := LinkedGitDirs(c, home); err == nil {
			t.Errorf("%s accepted: %v", name, dirs)
		}
	}
	os.Remove(filepath.Join(c, ".git"))
	os.MkdirAll(filepath.Join(c, ".git"), 0o755)
	if dirs, err := LinkedGitDirs(c, home); err != nil || dirs != nil {
		t.Errorf("a plain checkout: %v %v", dirs, err)
	}
}

// A checkout with no node_modules at the start gets the overlay once an
// install makes it (Bugbot, #1519).
func TestConfinedSyncOverlayAfterALateInstall(t *testing.T) {
	requireLandlock(t)
	f := newSyncFixture(t)
	if err := os.RemoveAll(filepath.Join(f.checkout, "node_modules")); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(launcherBin, "sync", "--home", f.home, "--checkout", f.checkout, "--run", f.run, "--watch")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	waitFor(t, func() bool { return strings.Contains(stderr.String(), "watching") }, "ready")
	write(t, filepath.Join(f.checkout, "node_modules/vite/package.json"), "{}")
	waitFor(t, func() bool {
		target, err := os.Readlink(filepath.Join(f.work, "node_modules/vite"))
		return err == nil && target == filepath.Join(f.checkout, "node_modules/vite")
	}, "the overlay after a late install\n"+stderr.String())
}

// A file whose name is pathspec magic is only a name to the sync's git (Bugbot, #1519).
func TestPathspecLikeNamesAreLiteral(t *testing.T) {
	f := newSyncFixture(t)
	s := f.syncer(t)
	if err := s.Initial(false); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(f.checkout, ":(exclude)*"), "a file")
	var log strings.Builder
	s.flush(map[string]bool{":(exclude)*": true, "src/main.js": true}, &log)
	for _, p := range []string{":(exclude)*", "src/main.js", "public/index.html"} {
		if _, err := os.Lstat(filepath.Join(f.work, p)); err != nil {
			t.Errorf("%s missing after the flush: %v", p, err)
		}
	}
}

// node_modules deleted and made again (npm ci) is watched anew (Devin, #1519).
func TestConfinedSyncOverlayAfterNodeModulesIsRemade(t *testing.T) {
	requireLandlock(t)
	f := newSyncFixture(t)
	cmd := exec.Command(launcherBin, "sync", "--home", f.home, "--checkout", f.checkout, "--run", f.run, "--watch")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	waitFor(t, func() bool { return strings.Contains(stderr.String(), "watching") }, "ready")
	if err := os.RemoveAll(filepath.Join(f.checkout, "node_modules")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	write(t, filepath.Join(f.checkout, "node_modules/react/index.js"), "react again")
	time.Sleep(200 * time.Millisecond)
	write(t, filepath.Join(f.checkout, "node_modules/vite/package.json"), "{}")
	waitFor(t, func() bool {
		target, err := os.Readlink(filepath.Join(f.work, "node_modules/vite"))
		return err == nil && target == filepath.Join(f.checkout, "node_modules/vite")
	}, "the overlay after node_modules was remade\n"+stderr.String())
}

// node_modules moved away and made again (Devin, #1519): the new one is overlaid, and the moved one, now a source
// directory, syncs. Its watch would otherwise have followed it: the kernel hands the moved directory's new watch the
// same descriptor, and its edits were taken for node_modules' and never reached the work copy.
func TestConfinedSyncNodeModulesMovedAway(t *testing.T) {
	requireLandlock(t)
	f := newSyncFixture(t)
	cmd := exec.Command(launcherBin, "sync", "--home", f.home, "--checkout", f.checkout, "--run", f.run, "--watch")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	waitFor(t, func() bool { return strings.Contains(stderr.String(), "watching") }, "ready")
	if err := os.Rename(filepath.Join(f.checkout, "node_modules"), filepath.Join(f.checkout, "old_modules")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	// Before node_modules is made again (which gives it a new watch), an edit in the moved directory.
	write(t, filepath.Join(f.checkout, "old_modules/edited.js"), "moved")
	waitFor(t, func() bool { return readOrErr(filepath.Join(f.work, "old_modules/edited.js")) == "moved" }, "an edit in the moved directory\n"+stderr.String())
	write(t, filepath.Join(f.checkout, "node_modules/vite/package.json"), "{}")
	waitFor(t, func() bool {
		target, err := os.Readlink(filepath.Join(f.work, "node_modules/vite"))
		return err == nil && target == filepath.Join(f.checkout, "node_modules/vite")
	}, "the overlay after node_modules was moved away and made again\n"+stderr.String())
}

// A directory made after the start whose name is an option to git (--stdin) is synced, and the sync
// carries on (Bugbot, #1519). The `--` itself is pinned by TestIsIgnoredTakesOptionLikeNamesAsPaths.
func TestConfinedSyncOptionLikeDirectory(t *testing.T) {
	requireLandlock(t)
	f := newSyncFixture(t)
	cmd := exec.Command(launcherBin, "sync", "--home", f.home, "--checkout", f.checkout, "--run", f.run, "--watch")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	waitFor(t, func() bool { return strings.Contains(stderr.String(), "watching") }, "ready")
	write(t, filepath.Join(f.checkout, "--stdin/x.js"), "x")
	time.Sleep(200 * time.Millisecond)
	write(t, filepath.Join(f.checkout, "--stdin/y.js"), "y")
	write(t, filepath.Join(f.checkout, "src/main.js"), "after")
	waitFor(t, func() bool {
		return readOrErr(filepath.Join(f.work, "--stdin/y.js")) == "y" && readOrErr(filepath.Join(f.work, "src/main.js")) == "after"
	}, "the sync carrying on past --stdin\n"+stderr.String())
}

// An ignored directory named like an option is ignored: git check-ignore takes it as a path, after
// `--`, not as a switch it rejects (Bugbot and Devin, #1519).
func TestIsIgnoredTakesOptionLikeNamesAsPaths(t *testing.T) {
	f := newSyncFixture(t)
	write(t, filepath.Join(f.checkout, ".gitignore"), "node_modules\ndist\n.env\n-build\n")
	if !isIgnored(f.checkout, "-build") {
		t.Error("-build, ignored, read as not ignored")
	}
	if isIgnored(f.checkout, "src") {
		t.Error("src read as ignored")
	}
}

// After an overflow the copy is made to match without events: a new directory's file, a new root .env
// file, an edit and a deletion all land (Bugbot and Devin, #1519).
func TestResyncMatchesTheCheckoutWithoutEvents(t *testing.T) {
	f := newSyncFixture(t)
	s := f.syncer(t)
	if err := s.Initial(false); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(f.checkout, "src/new/feature.js"), "new")
	write(t, filepath.Join(f.checkout, ".env.local"), "B=2")
	write(t, filepath.Join(f.checkout, "src/main.js"), "edited")
	if err := os.Remove(filepath.Join(f.checkout, "src/untracked.js")); err != nil {
		t.Fatal(err)
	}
	if err := s.Resync(); err != nil {
		t.Fatal(err)
	}
	for p, want := range map[string]string{"src/new/feature.js": "new", ".env.local": "B=2", "src/main.js": "edited"} {
		if got := readOrErr(filepath.Join(f.work, p)); got != want {
			t.Errorf("%s: %q, want %q", p, got, want)
		}
	}
	if _, err := os.Lstat(filepath.Join(f.work, "src/untracked.js")); err == nil {
		t.Error("a deleted file is still in the copy")
	}
	// A path that can't be copied makes it an error to retry.
	if err := os.Chmod(filepath.Join(f.checkout, "src/main.js"), 0o000); err != nil {
		t.Fatal(err)
	}
	if err := s.Resync(); err == nil || !strings.Contains(err.Error(), "paths not synced") {
		t.Errorf("an unreadable file resynced: %v", err)
	}
	os.Chmod(filepath.Join(f.checkout, "src/main.js"), 0o644)
	// A listing that fails is an error to retry, not silence.
	os.Rename(filepath.Join(f.checkout, ".git"), filepath.Join(f.checkout, ".git-gone"))
	if err := s.Resync(); err == nil {
		t.Error("a failed listing resynced")
	}
}

// Pinning (Bugbot, #1519): node_modules' watch descriptor is cleared once the kernel drops the watch, so a later
// source directory given the same number isn't taken for node_modules.
func TestNodeModulesDescriptorClearedWhenItsWatchGoes(t *testing.T) {
	isNM, nm := nodeModulesEvent(7, unix.IN_MODIFY, 7)
	if !isNM || nm != 7 {
		t.Fatalf("an event of node_modules: %v %d", isNM, nm)
	}
	isNM, nm = nodeModulesEvent(7, unix.IN_DELETE_SELF, nm)
	if !isNM || nm != 7 {
		t.Fatalf("its removal: %v %d", isNM, nm)
	}
	isNM, nm = nodeModulesEvent(7, unix.IN_IGNORED, nm)
	if !isNM || nm != -1 {
		t.Fatalf("its watch dropped: %v %d", isNM, nm)
	}
	// The number again, now a source directory's.
	if isNM, _ = nodeModulesEvent(7, unix.IN_CREATE, nm); isNM {
		t.Error("a reused descriptor was taken for node_modules")
	}
	if isNM, _ = nodeModulesEvent(8, unix.IN_CREATE, 7); isNM {
		t.Error("another descriptor taken for node_modules")
	}
}
