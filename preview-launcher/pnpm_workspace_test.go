package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func link(t *testing.T, target, at string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(at), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, at); err != nil {
		t.Fatal(err)
	}
}

// pnpmWorkspace lays out a pnpm workspace in checkout, as pnpm installs one:
// the root's node_modules holds .pnpm, a link to each hoisted package and a
// scope directory of workspace links; each member's node_modules holds
// relative links and .bin scripts. Committed, with node_modules ignored.
func pnpmWorkspace(t *testing.T, checkout string) {
	t.Helper()
	write(t, filepath.Join(checkout, ".gitignore"), "node_modules\n")
	write(t, filepath.Join(checkout, "package.json"), "{}")
	write(t, filepath.Join(checkout, "packages/lib/package.json"), "{}")
	write(t, filepath.Join(checkout, "packages/lib/index.js"), "lib source")
	write(t, filepath.Join(checkout, "packages/app/package.json"), "{}")
	write(t, filepath.Join(checkout, "packages/app/index.js"), "app source")
	nm := filepath.Join(checkout, "node_modules")
	write(t, filepath.Join(nm, ".pnpm/clsx@2.1.1/node_modules/clsx/index.js"), "clsx")
	write(t, filepath.Join(nm, ".pnpm/dep@1.0.0/node_modules/dep/index.js"), "dep")
	link(t, ".pnpm/clsx@2.1.1/node_modules/clsx", filepath.Join(nm, "clsx"))
	link(t, "../../packages/lib", filepath.Join(nm, "@ws/lib"))
	write(t, filepath.Join(nm, "@types/node/index.d.ts"), "types")
	app := filepath.Join(checkout, "packages/app/node_modules")
	link(t, "../../../node_modules/.pnpm/clsx@2.1.1/node_modules/clsx", filepath.Join(app, "clsx"))
	link(t, "../../../lib", filepath.Join(app, "@ws/lib"))
	write(t, filepath.Join(app, ".bin/clsx"), "#!/bin/sh\n")
	write(t, filepath.Join(app, ".vite/deps/x.js"), "the owner's cache")
	for _, args := range [][]string{{"init", "-q"}, {"add", "-A"}, {"-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = checkout
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
}

func syncWorkspace(t *testing.T, checkout, work string, copyNodeModules bool) *Syncer {
	t.Helper()
	if err := os.MkdirAll(work, 0o700); err != nil {
		t.Fatal(err)
	}
	s, err := NewSyncer(checkout, work)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	if err := s.Initial(copyNodeModules); err != nil {
		t.Fatal(err)
	}
	return s
}

// resolvesInto says whether p reads want and its real path is under dir.
func resolvesInto(t *testing.T, p, want, dir string) {
	t.Helper()
	if got := readOrErr(p); got != want {
		t.Errorf("%s: %q, want %q", p, got, want)
		return
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil || !strings.HasPrefix(real, dir+"/") {
		t.Errorf("%s resolves to %s (%v), want under %s", p, real, err, dir)
	}
}

// A pnpm workspace's imports resolve in the copy: the members' node_modules
// are recreated, and every workspace link lands on the copy's source, not
// the checkout's (which the app can't read).
func TestPnpmWorkspaceOverlay(t *testing.T) {
	home := t.TempDir()
	checkout, work := filepath.Join(home, "p/app"), filepath.Join(home, "state/r1/work")
	pnpmWorkspace(t, checkout)
	s := syncWorkspace(t, checkout, work, false)

	resolvesInto(t, filepath.Join(work, "node_modules/clsx/index.js"), "clsx", filepath.Join(checkout, "node_modules"))
	resolvesInto(t, filepath.Join(work, "node_modules/@ws/lib/index.js"), "lib source", filepath.Join(work, "packages"))
	resolvesInto(t, filepath.Join(work, "node_modules/@types/node/index.d.ts"), "types", filepath.Join(checkout, "node_modules"))
	resolvesInto(t, filepath.Join(work, "packages/app/node_modules/clsx/index.js"), "clsx", filepath.Join(checkout, "node_modules"))
	resolvesInto(t, filepath.Join(work, "packages/app/node_modules/@ws/lib/index.js"), "lib source", filepath.Join(work, "packages"))
	if fi, err := os.Lstat(filepath.Join(work, "node_modules/@ws")); err != nil || !fi.IsDir() {
		t.Errorf("node_modules/@ws is not a directory: %v", err)
	}
	if fi, err := os.Lstat(filepath.Join(work, "packages/app/node_modules/.bin/clsx")); err != nil || !fi.Mode().IsRegular() {
		t.Errorf(".bin/clsx not copied: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(work, "packages/app/node_modules/.vite")); err == nil {
		t.Error("the owner's .vite cache was copied")
	}
	if _, err := os.Lstat(filepath.Join(work, "packages/lib/node_modules")); err == nil {
		t.Error("a member without node_modules got one")
	}

	// An install later: a dependency added to the app, one dropped, a scoped
	// package removed. The app's own cache in a member's node_modules stays.
	nm := filepath.Join(checkout, "node_modules")
	appNM := filepath.Join(checkout, "packages/app/node_modules")
	os.Remove(filepath.Join(appNM, "clsx"))
	link(t, "../../../node_modules/.pnpm/dep@1.0.0/node_modules/dep", filepath.Join(appNM, "dep"))
	os.RemoveAll(filepath.Join(nm, "@types"))
	write(t, filepath.Join(work, "packages/app/node_modules/.vite/deps/y.js"), "the run's cache")
	if err := s.Overlay(); err != nil {
		t.Fatal(err)
	}
	resolvesInto(t, filepath.Join(work, "packages/app/node_modules/dep/index.js"), "dep", filepath.Join(checkout, "node_modules"))
	for _, p := range []string{"packages/app/node_modules/clsx", "node_modules/@types"} {
		if _, err := os.Lstat(filepath.Join(work, p)); err == nil {
			t.Errorf("%s still in the copy", p)
		}
	}
	if got := readOrErr(filepath.Join(work, "packages/app/node_modules/.vite/deps/y.js")); got != "the run's cache" {
		t.Errorf("the run's cache: %q", got)
	}
}

// With node_modules copied (Storybook, Next.js) the members' links resolve
// to the copy's own node_modules.
func TestPnpmWorkspaceCopy(t *testing.T) {
	home := t.TempDir()
	checkout, work := filepath.Join(home, "p/app"), filepath.Join(home, "state/r1/work")
	pnpmWorkspace(t, checkout)
	syncWorkspace(t, checkout, work, true)
	resolvesInto(t, filepath.Join(work, "packages/app/node_modules/clsx/index.js"), "clsx", filepath.Join(work, "node_modules"))
	resolvesInto(t, filepath.Join(work, "packages/app/node_modules/@ws/lib/index.js"), "lib source", filepath.Join(work, "packages"))
}

// Pinning (I11): confined, the app reads a workspace's packages through the
// copy's links, and still can't read the checkout's source they mirror.
func TestConfinedPnpmWorkspaceReads(t *testing.T) {
	f := newFixture(t)
	if err := os.RemoveAll(filepath.Join(f.l.Checkout, "node_modules")); err != nil {
		t.Fatal(err)
	}
	pnpmWorkspace(t, f.l.Checkout)
	syncWorkspace(t, f.l.Checkout, f.work, false)
	w := f.work
	res := f.launch(t, nil, "read",
		w+"/node_modules/clsx/index.js", w+"/node_modules/@ws/lib/index.js",
		w+"/packages/app/node_modules/clsx/index.js", w+"/packages/app/node_modules/@ws/lib/index.js",
		f.l.Checkout+"/packages/lib/index.js", f.l.Checkout+"/packages/app/node_modules/@ws/lib/index.js")
	expect(t, res, map[string]string{
		"read " + w + "/node_modules/clsx/index.js":                            "ok",
		"read " + w + "/node_modules/@ws/lib/index.js":                         "ok",
		"read " + w + "/packages/app/node_modules/clsx/index.js":               "ok",
		"read " + w + "/packages/app/node_modules/@ws/lib/index.js":            "ok",
		"read " + f.l.Checkout + "/packages/lib/index.js":                      "EACCES",
		"read " + f.l.Checkout + "/packages/app/node_modules/@ws/lib/index.js": "EACCES",
	})
}

// A member whose node_modules the checkout no longer has loses its copy, so
// the run can't import what was uninstalled (Devin, #1786).
func TestPnpmWorkspaceMemberUninstalled(t *testing.T) {
	home := t.TempDir()
	checkout, work := filepath.Join(home, "p/app"), filepath.Join(home, "state/r1/work")
	pnpmWorkspace(t, checkout)
	s := syncWorkspace(t, checkout, work, false)
	if _, err := os.Lstat(filepath.Join(work, "packages/app/node_modules/clsx")); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(checkout, "packages/app/node_modules")); err != nil {
		t.Fatal(err)
	}
	if err := s.Overlay(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(work, "packages/app/node_modules")); err == nil {
		t.Error("the uninstalled member's node_modules is still in the copy")
	}
	if got := readOrErr(filepath.Join(work, "packages/app/index.js")); got != "app source" {
		t.Errorf("the member's source: %q", got)
	}
}

// A link into a node_modules dot directory the overlay leaves out (a pnpm
// store configured as node_modules/.store) points at the checkout's, which
// the app reads through its node_modules grant, not at a path the copy lacks
// (Devin, #1786).
func TestPnpmWorkspaceCustomStore(t *testing.T) {
	home := t.TempDir()
	checkout, work := filepath.Join(home, "p/app"), filepath.Join(home, "state/r1/work")
	write(t, filepath.Join(checkout, "node_modules/.store/pkg@1/node_modules/pkg/index.js"), "pkg")
	link(t, ".store/pkg@1/node_modules/pkg", filepath.Join(checkout, "node_modules/pkg"))
	link(t, "../../../node_modules/.store/pkg@1/node_modules/pkg", filepath.Join(checkout, "packages/app/node_modules/pkg"))
	pnpmWorkspace(t, checkout)
	syncWorkspace(t, checkout, work, false)
	store := filepath.Join(checkout, "node_modules/.store")
	resolvesInto(t, filepath.Join(work, "node_modules/pkg/index.js"), "pkg", store)
	resolvesInto(t, filepath.Join(work, "packages/app/node_modules/pkg/index.js"), "pkg", store)
	if _, err := os.Lstat(filepath.Join(work, "node_modules/.store")); err == nil {
		t.Error("the store was linked into the copy")
	}
	// pnpm's own store is linked, so its links stay relative.
	if target, _ := os.Readlink(filepath.Join(work, "packages/app/node_modules/clsx")); target != "../../../node_modules/.pnpm/clsx@2.1.1/node_modules/clsx" {
		t.Errorf("clsx links to %q", target)
	}
}

// Confined and watching: an install that changes only a member's
// node_modules (a dependency added to it, a scoped one too) reaches the run
// (Devin, #1786).
func TestConfinedSyncMemberOnlyInstall(t *testing.T) {
	requireLandlock(t)
	f := newSyncFixture(t)
	pnpmWorkspace(t, f.checkout)
	cmd := exec.Command(launcherBin, "sync", "--home", f.home, "--checkout", f.checkout, "--run", f.run, "--watch")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	waitFor(t, func() bool { return strings.Contains(stderr.String(), "watching") }, "ready")
	appNM := filepath.Join(f.checkout, "packages/app/node_modules")
	link(t, "../../../node_modules/.pnpm/dep@1.0.0/node_modules/dep", filepath.Join(appNM, "dep"))
	link(t, "../../../lib", filepath.Join(appNM, "@ws/lib2"))
	waitFor(t, func() bool {
		return readOrErr(filepath.Join(f.work, "packages/app/node_modules/dep/index.js")) == "dep" &&
			readOrErr(filepath.Join(f.work, "packages/app/node_modules/@ws/lib2/index.js")) == "lib source"
	}, "a member-only install in the run\n"+stderr.String())
	// A .bin script written after its package's link, in a later batch: copied as a file, so an event of its own
	// (Bugbot, #1786).
	write(t, filepath.Join(appNM, ".bin/dep"), "#!/bin/sh\necho dep\n")
	waitFor(t, func() bool {
		return readOrErr(filepath.Join(f.work, "packages/app/node_modules/.bin/dep")) == "#!/bin/sh\necho dep\n"
	}, "a member's later .bin script in the run\n"+stderr.String())
	// And its node_modules removed altogether.
	if err := os.RemoveAll(appNM); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		_, err := os.Lstat(filepath.Join(f.work, "packages/app/node_modules"))
		return os.IsNotExist(err)
	}, "the member's node_modules gone from the run\n"+stderr.String())
}

// An install into a member already copied, while the first copy is still going: there is no member
// watch yet, so the pass after the watches are added catches it (Devin, #1786).
func TestWatchCatchesAMemberInstallDuringTheFirstCopy(t *testing.T) {
	f := newSyncFixture(t)
	pnpmWorkspace(t, f.checkout)
	s := f.syncer(t)
	appNM := filepath.Join(f.checkout, "packages/app/node_modules")
	ready := make(chan struct{})
	var log bytes.Buffer
	go s.Watch(&log, true, func() error {
		if err := s.Initial(false); err != nil {
			return err
		}
		link(t, "../../../node_modules/.pnpm/dep@1.0.0/node_modules/dep", filepath.Join(appNM, "dep"))
		return nil
	}, func() { close(ready) })
	select {
	case <-ready:
	case <-time.After(10 * time.Second):
		t.Fatalf("not ready\n%s", log.String())
	}
	if got := readOrErr(filepath.Join(f.work, "packages/app/node_modules/dep/index.js")); got != "dep" {
		t.Errorf("the install during the first copy is missing from the run: %q", got)
	}
}

// A member's copy that keeps failing in the catch-up pass keeps the sync from ready (Devin, #1786): the app
// would start without a dependency no event brings back.
func TestWatchNotReadyWhenTheMembersCatchUpKeepsFailing(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads a mode-0 file")
	}
	f := newSyncFixture(t)
	pnpmWorkspace(t, f.checkout)
	s := f.syncer(t)
	unreadable := filepath.Join(f.checkout, "packages/app/node_modules/real/index.js")
	ready := false
	var log bytes.Buffer
	err := s.Watch(&log, true, func() error {
		if err := s.Initial(false); err != nil {
			return err
		}
		// Installed after the first copy, and unreadable: every catch-up try fails.
		write(t, unreadable, "x")
		return os.Chmod(unreadable, 0)
	}, func() { ready = true })
	os.Chmod(unreadable, 0o644)
	if err == nil || ready {
		t.Fatalf("ready with a member's copy failing: %v\n%s", err, log.String())
	}
	if !strings.Contains(err.Error(), "workspace members") {
		t.Errorf("error: %v", err)
	}
}

// A scope directory the overlay made goes with its packages, but only its own links: what the app wrote inside
// stays, and so does the directory then (#1786).
func TestOverlayRemovesOnlyItsOwnScopeEntries(t *testing.T) {
	f := newSyncFixture(t)
	pnpmWorkspace(t, f.checkout)
	s := syncWorkspace(t, f.checkout, f.work, false)
	write(t, filepath.Join(f.work, "node_modules/@types/apps-own/index.d.ts"), "the app's")
	if err := os.RemoveAll(filepath.Join(f.checkout, "node_modules/@types")); err != nil {
		t.Fatal(err)
	}
	if err := s.Overlay(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(f.work, "node_modules/@types/node")); err == nil {
		t.Error("the removed package's link is still there")
	}
	if got := readOrErr(filepath.Join(f.work, "node_modules/@types/apps-own/index.d.ts")); got != "the app's" {
		t.Errorf("the app's entry: %q", got)
	}
	// With nothing of the app's in it, the scope directory goes too.
	write(t, filepath.Join(f.checkout, "node_modules/@gone/pkg/index.js"), "x")
	if err := s.Overlay(); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(f.checkout, "node_modules/@gone")); err != nil {
		t.Fatal(err)
	}
	if err := s.Overlay(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(f.work, "node_modules/@gone")); err == nil {
		t.Error("an emptied scope directory is still there")
	}
}
