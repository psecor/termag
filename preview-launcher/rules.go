package main

// The confined app's filesystem allowlist, in one place (tech spec, "Confining
// the app for wider audiences (SR9)"). rules_test.go pins what may appear here.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Origin says who can change a rule path, which decides how it is opened.
type Origin int

const (
	// FromHome paths are the user's: opened with RESOLVE_NO_SYMLINKS, so no
	// component may be a symlink.
	FromHome Origin = iota
	// FromSystem paths are root's: opened following symlinks, and the target
	// must belong to a system account, not be writable by the user and lie
	// outside $HOME.
	FromSystem
)

// Access is what a rule grants.
type Access int

const (
	// ReadExec: read files and directories, execute files.
	ReadExec Access = iota
	// ReadWrite: everything but making device nodes. Only the run directory.
	ReadWrite
	// ReadFile: read one file.
	ReadFile
	// DevNode: read, write and truncate one device node.
	DevNode
	// ListDir: list directories, read no file. The checkout root gets it
	// beside its node_modules rule: esbuild (Storybook's and Vite's
	// dependency scan) resolves a package by listing each parent directory,
	// and without it misses node_modules in an unreadable checkout.
	ListDir
)

func (a Access) String() string {
	return [...]string{"read-exec", "read-write", "read-file", "dev-node", "list-dir"}[a]
}

// Grant is one Landlock rule.
type Grant struct {
	Path   string
	Origin Origin
	Access Access
	// Optional grants are skipped when the path doesn't exist (no ~/.cache/yarn,
	// no /lib64 on arm64). A required one that is missing refuses the start.
	Optional bool
}

// Layout names the paths the rules are built from.
type Layout struct {
	Home     string // the box user's home
	Checkout string // the workstream checkout, read-only
	Run      string // ~/.local/state/termag-preview/<run>, the only writable rule
}

// Home-relative grants other than the checkout and the run directory: the
// package caches (read-only, so a confined app can't poison the owner's next
// unconfined install) and the toolchains the image installs in $HOME. Not
// ~/.npmrc (it can hold a registry token) and not the rest of ~/.nvm.
var homeCaches = []string{".npm", ".cache/pnpm", ".cache/yarn"}
var homeToolchains = []string{".nvm/versions", ".cache/node/corepack", ".local/bin"}

// System directories, read and execute. Not /opt or /snap: no dev server the
// prototype (pl-L) ran needed them, and the image puts user-owned directories in /opt.
var systemDirs = []string{"/usr", "/lib", "/lib64", "/bin", "/sbin"}

// Named /etc entries. Not /etc itself.
var etcFiles = []string{
	"/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd",
	"/etc/group", "/etc/localtime", "/etc/ld.so.cache",
}
var etcDirs = []string{"/etc/ssl", "/etc/ca-certificates", "/etc/alternatives", "/etc/ld.so.conf.d"}

// What runtimes need to start. /proc is safe read-only because Landlock
// refuses ptrace-class access (environ, mem, fd) to processes outside the
// domain. /sys/fs/cgroup is read-only so the app can't move itself out of its
// cgroup.
var runtimeDirs = []string{"/proc", "/sys/devices/system/cpu", "/sys/fs/cgroup"}
var devNodes = []string{"/dev/null", "/dev/zero", "/dev/urandom", "/dev/random", "/dev/tty"}

// CheckoutGrant is how much of the checkout the confined app may read.
type CheckoutGrant int

const (
	// CheckoutNodeModules grants <checkout>/node_modules only, which is all
	// the symlink overlay reaches. The default: the app runs from the run
	// directory's copy, so it never needs the checkout's .git, its ignored
	// .env files or anything else in it.
	CheckoutNodeModules CheckoutGrant = iota
	// CheckoutNone: node_modules was copied into the run directory too.
	// There is no grant of the whole checkout: read-only, it still served
	// /@fs/<checkout>/.git/config, an ignored .env and the history (pl-L).
	CheckoutNone
)

func (c CheckoutGrant) String() string {
	return [...]string{"node-modules", "none"}[c]
}

func ParseCheckoutGrant(s string) (CheckoutGrant, error) {
	for c := CheckoutNodeModules; c <= CheckoutNone; c++ {
		if c.String() == s {
			return c, nil
		}
	}
	return 0, fmt.Errorf("checkout grant %q: want node-modules or none", s)
}

// AppGrants is the ruleset for the confined app.
func AppGrants(l Layout, cg CheckoutGrant) []Grant {
	var g []Grant
	switch cg {
	case CheckoutNodeModules:
		// Opened with RESOLVE_NO_SYMLINKS like every home rule, so a
		// node_modules that is itself a symlink refuses the start. The
		// listing right shows the checkout's file names, not their contents.
		g = append(g,
			Grant{Path: l.Checkout, Origin: FromHome, Access: ListDir},
			Grant{Path: filepath.Join(l.Checkout, "node_modules"), Origin: FromHome, Access: ReadExec, Optional: true})
	}
	g = append(g, Grant{Path: l.Run, Origin: FromHome, Access: ReadWrite})
	for _, p := range homeCaches {
		g = append(g, Grant{Path: filepath.Join(l.Home, p), Origin: FromHome, Access: ReadExec, Optional: true})
	}
	for _, p := range homeToolchains {
		g = append(g, Grant{Path: filepath.Join(l.Home, p), Origin: FromHome, Access: ReadExec, Optional: true})
	}
	return append(g, systemGrants()...)
}

// SyncGrants is the ruleset for the sync helper: read the checkout, write the
// run directory's work copy, and run git (for `git ls-files`) from /usr. A
// linked worktree's git metadata lives outside the checkout (LinkedGitDirs),
// so gitDirs are granted read-only too; the app never gets them.
func SyncGrants(l Layout, work string, gitDirs []string) []Grant {
	g := []Grant{
		{Path: l.Checkout, Origin: FromHome, Access: ReadExec},
		{Path: work, Origin: FromHome, Access: ReadWrite},
	}
	for _, d := range gitDirs {
		g = append(g, Grant{Path: d, Origin: FromHome, Access: ReadExec})
	}
	return append(g, systemGrants()...)
}

// LinkedGitDirs is a linked worktree's git metadata, for the sync helper's
// git ls-files (Devin, #1519): a workstream checkout,
// <project>/.worktrees/<name>, has a .git file pointing at
// <repo>/.git/worktrees/<name>, whose objects and config are in <repo>/.git.
// Read here, before confinement, without running git on the checkout. Only
// that shape is accepted (a gitdir named worktrees/<name> under a common dir
// with HEAD and objects, both under $HOME), so a .git file can't point the
// helper's read rights anywhere else. A plain checkout (a .git directory)
// needs nothing: nil.
func LinkedGitDirs(checkout, home string) ([]string, error) {
	dotgit := filepath.Join(checkout, ".git")
	fi, err := os.Lstat(dotgit)
	if err != nil {
		return nil, fmt.Errorf("checkout %s: %w", checkout, err)
	}
	if fi.IsDir() {
		return nil, nil
	}
	if !fi.Mode().IsRegular() || fi.Size() > 4096 {
		return nil, fmt.Errorf("%s is neither a directory nor a worktree's .git file", dotgit)
	}
	b, err := os.ReadFile(dotgit)
	if err != nil {
		return nil, err
	}
	rest, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir: ")
	if !ok || rest == "" {
		return nil, fmt.Errorf("%s has no gitdir line", dotgit)
	}
	gitdir := rest
	if !filepath.IsAbs(gitdir) {
		gitdir = filepath.Join(checkout, gitdir)
	}
	gitdir = filepath.Clean(gitdir)
	common := filepath.Dir(filepath.Dir(gitdir))
	if filepath.Base(filepath.Dir(gitdir)) != "worktrees" {
		return nil, fmt.Errorf("%s points at %s, not a worktree's git dir", dotgit, gitdir)
	}
	if c, err := os.ReadFile(filepath.Join(gitdir, "commondir")); err == nil {
		want := strings.TrimSpace(string(c))
		if !filepath.IsAbs(want) {
			want = filepath.Join(gitdir, want)
		}
		if filepath.Clean(want) != common {
			return nil, fmt.Errorf("%s's commondir is %s, not %s", gitdir, want, common)
		}
	}
	for _, p := range []string{filepath.Join(common, "HEAD"), filepath.Join(common, "objects")} {
		if _, err := os.Lstat(p); err != nil {
			return nil, fmt.Errorf("%s isn't a git directory: %w", common, err)
		}
	}
	var out []string
	for _, d := range []string{gitdir, common} {
		if !within(d, home) || d == home {
			return nil, fmt.Errorf("%s is outside %s", d, home)
		}
		if !within(d, checkout) {
			out = append(out, d)
		}
	}
	return out, nil
}

// CleanGrants is the ruleset for the cleanup helper: the run directory only.
func CleanGrants(l Layout) []Grant {
	return []Grant{{Path: l.Run, Origin: FromHome, Access: ReadWrite}}
}

func systemGrants() []Grant {
	var g []Grant
	for _, p := range systemDirs {
		g = append(g, Grant{Path: p, Origin: FromSystem, Access: ReadExec, Optional: true})
	}
	for _, p := range etcFiles {
		g = append(g, Grant{Path: p, Origin: FromSystem, Access: ReadFile, Optional: true})
	}
	for _, p := range etcDirs {
		g = append(g, Grant{Path: p, Origin: FromSystem, Access: ReadExec, Optional: true})
	}
	for _, p := range runtimeDirs {
		g = append(g, Grant{Path: p, Origin: FromSystem, Access: ReadExec, Optional: true})
	}
	for _, p := range devNodes {
		g = append(g, Grant{Path: p, Origin: FromSystem, Access: DevNode, Optional: true})
	}
	return g
}

// within reports whether p is base or below it, lexically.
func within(p, base string) bool {
	return p == base || strings.HasPrefix(p, base+"/")
}

// CheckLayout refuses layouts the rules can't be built safely from: relative
// or unclean paths, a run directory inside the checkout (it would make part of
// the checkout writable), or a checkout or run directory outside $HOME.
func CheckLayout(l Layout) error {
	for name, p := range map[string]string{"home": l.Home, "checkout": l.Checkout, "run": l.Run} {
		if p == "" || !filepath.IsAbs(p) || filepath.Clean(p) != p {
			return fmt.Errorf("%s path %q must be absolute and clean", name, p)
		}
	}
	if !within(l.Checkout, l.Home) || l.Checkout == l.Home {
		return fmt.Errorf("checkout %s must be below %s", l.Checkout, l.Home)
	}
	if !within(l.Run, l.Home) || l.Run == l.Home {
		return fmt.Errorf("run directory %s must be below %s", l.Run, l.Home)
	}
	if within(l.Run, l.Checkout) || within(l.Checkout, l.Run) {
		return fmt.Errorf("run directory %s and checkout %s must not contain each other", l.Run, l.Checkout)
	}
	return nil
}

// CheckGrants is the invariant rules_test.go pins: every rule under $HOME is
// the checkout root or its node_modules (read-only), the run directory (the
// only writable rule), or one of the named caches and toolchains (read-only).
// No other rule names a path inside the checkout.
func CheckGrants(l Layout, grants []Grant, work string, gitDirs ...string) error {
	checkoutNM := filepath.Join(l.Checkout, "node_modules")
	allowed := map[string]Access{l.Checkout: ReadExec, checkoutNM: ReadExec, l.Run: ReadWrite}
	// The sync helper's linked-worktree metadata, read-only (LinkedGitDirs).
	for _, d := range gitDirs {
		allowed[d] = ReadExec
	}
	if work != "" {
		allowed[work] = ReadWrite
	}
	for _, p := range append(append([]string{}, homeCaches...), homeToolchains...) {
		allowed[filepath.Join(l.Home, p)] = ReadExec
	}
	for _, g := range grants {
		if g.Access == ReadWrite && g.Path != l.Run && g.Path != work {
			return fmt.Errorf("%s is writable; only the run directory may be", g.Path)
		}
		if g.Path != l.Checkout && g.Path != checkoutNM && within(g.Path, l.Checkout) {
			return fmt.Errorf("%s is inside the checkout", g.Path)
		}
		if g.Origin == FromSystem && within(g.Path, l.Home) {
			return fmt.Errorf("%s is under $HOME but opened as a system path", g.Path)
		}
		if within(g.Path, l.Home) {
			want, ok := allowed[g.Path]
			if !ok {
				return fmt.Errorf("%s is under $HOME and not a named grant", g.Path)
			}
			if g.Path == l.Checkout && g.Access == ListDir {
				continue
			}
			if want != g.Access {
				return fmt.Errorf("%s granted %s, want %s", g.Path, g.Access, want)
			}
		}
	}
	return nil
}
