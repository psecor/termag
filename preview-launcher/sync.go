package main

// The one-way sync from the checkout into the run directory's work copy. It
// runs under its own Landlock ruleset (read the checkout, write the work
// copy), and on top of that never follows a symlink: every path is resolved
// beneath a directory descriptor with RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS,
// files are written to a temporary name and renamed into place (so a symlink
// the app planted at the destination is replaced, never written through), and
// a symlink in the checkout is copied as a symlink.

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// Dot entries of the checkout's node_modules the overlay links. Everything
// else that starts with a dot is a tool's cache (.vite, .cache, .vite-temp,
// .astro) and starts empty in the run directory, where the tool can write it.
var nodeModulesDotLinks = map[string]bool{
	".bin": true, ".pnpm": true, ".modules.yaml": true, ".package-lock.json": true,
	".yarn-integrity": true, ".yarn-state.yml": true, ".prisma": true,
}

// Root files copied even when ignored: dev servers read .env files from the
// project root themselves, and they are almost always ignored.
func isRootEnvFile(rel string) bool {
	return !strings.Contains(rel, "/") && (rel == ".env" || strings.HasPrefix(rel, ".env."))
}

const tmpPrefix = ".termag-sync-"

type Syncer struct {
	checkout, work string
	src, dst       int // O_PATH directory descriptors
	synced         map[string]bool
	// overlaid: the entries of work/node_modules (and of its scope
	// directories, "@scope/pkg") the overlay made, so a refresh removes only
	// its own.
	overlaid map[string]bool
	// mirrored: the workspace members whose node_modules NestedNodeModules
	// recreated, so one the checkout no longer has goes from work too.
	mirrored map[string]bool
}

func NewSyncer(checkout, work string) (*Syncer, error) {
	how := &unix.OpenHow{Flags: unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS}
	src, err := unix.Openat2(unix.AT_FDCWD, checkout, how)
	if err != nil {
		return nil, fmt.Errorf("open checkout: %w", err)
	}
	dst, err := unix.Openat2(unix.AT_FDCWD, work, how)
	if err != nil {
		unix.Close(src)
		return nil, fmt.Errorf("open work: %w", err)
	}
	return &Syncer{checkout: checkout, work: work, src: src, dst: dst, synced: map[string]bool{}, overlaid: map[string]bool{}, mirrored: map[string]bool{}}, nil
}

func (s *Syncer) Close() { unix.Close(s.src); unix.Close(s.dst) }

var beneath = uint64(unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS)

func openBeneath(dirfd int, rel string, flags int, mode uint32) (int, error) {
	return unix.Openat2(dirfd, rel, &unix.OpenHow{Flags: uint64(flags | unix.O_CLOEXEC), Mode: uint64(mode), Resolve: beneath})
}

// listFiles is the copy's file list: tracked and untracked-but-not-ignored
// files, without .git, plus root .env files.
func (s *Syncer) listFiles(paths ...string) ([]string, error) {
	// --literal-pathspecs: these are the checkout's own file names, and one like `:(exclude)*` or `*` must stay a
	// name, not pathspec magic (Bugbot, #1519). Only here: check-ignore takes plain paths and refuses the option.
	args := []string{"--literal-pathspecs", "ls-files", "-z", "-co", "--exclude-standard"}
	if len(paths) > 0 {
		args = append(append(args, "--"), paths...)
	}
	out, err := git(s.checkout, args...)
	if err != nil {
		return nil, fmt.Errorf("git ls-files: %w", err)
	}
	var files []string
	for _, f := range bytes.Split(out, []byte{0}) {
		if len(f) > 0 && !isGitPath(string(f)) {
			files = append(files, string(f))
		}
	}
	return files, nil
}

func isGitPath(rel string) bool {
	return rel == ".git" || strings.HasPrefix(rel, ".git/") || strings.Contains(rel, "/.git/")
}

// Initial copies the source and builds the node_modules overlay.
// Resync makes the work copy match the checkout without events, after an
// inotify overflow: every file git lists and every root .env file (as Initial
// takes them) copied, every file synced before but no longer there removed.
// One listing for the whole checkout, never every path as an argument.
func (s *Syncer) Resync() error {
	files, err := s.listFiles()
	if err != nil {
		return err
	}
	want := map[string]bool{}
	for _, f := range files {
		want[f] = true
	}
	ents, _ := os.ReadDir(s.checkout)
	for _, e := range ents {
		if isRootEnvFile(e.Name()) {
			want[e.Name()] = true
		}
	}
	// Every path is tried; any that failed makes the resync an error, so the caller tries again (Bugbot and
	// Devin, #1519).
	failed := 0
	var first error
	for f := range want {
		if err := s.CopyPath(f); err != nil {
			failed++
			if first == nil {
				first = err
			}
		}
	}
	for f := range s.synced {
		if !want[f] {
			if err := s.removePath(f); err != nil {
				failed++
				if first == nil {
					first = err
				}
			}
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d paths not synced, first: %w", failed, first)
	}
	return nil
}

func (s *Syncer) Initial(copyNodeModules bool) error {
	files, err := s.listFiles()
	if err != nil {
		return err
	}
	ents, _ := os.ReadDir(s.checkout)
	for _, e := range ents {
		if isRootEnvFile(e.Name()) {
			files = append(files, e.Name())
		}
	}
	for _, f := range files {
		if err := s.CopyPath(f); err != nil {
			return err
		}
	}
	if copyNodeModules {
		if err := s.CopyNodeModules(); err != nil {
			return err
		}
		return s.NestedNodeModules()
	}
	return s.Overlay()
}

// mkdirBeneath makes every directory of rel (a directory path) in work,
// refusing symlinks, and returns an O_PATH descriptor for it.
func (s *Syncer) mkdirBeneath(rel string) (int, error) {
	fd, err := unix.Dup(s.dst)
	if err != nil {
		return -1, err
	}
	if rel == "." || rel == "" {
		return fd, nil
	}
	for _, part := range strings.Split(rel, "/") {
		if err := unix.Mkdirat(fd, part, 0o755); err != nil && !errors.Is(err, unix.EEXIST) {
			unix.Close(fd)
			return -1, err
		}
		next, err := openBeneath(fd, part, unix.O_PATH|unix.O_DIRECTORY, 0)
		if err != nil && (errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR)) {
			// Something the app planted where a source directory goes:
			// replace it with a directory.
			if err = removeEntry(fd, part); err == nil {
				if err = unix.Mkdirat(fd, part, 0o755); err == nil {
					next, err = openBeneath(fd, part, unix.O_PATH|unix.O_DIRECTORY, 0)
				}
			}
		}
		unix.Close(fd)
		if err != nil {
			return -1, fmt.Errorf("work dir %s: %w", rel, err)
		}
		fd = next
	}
	return fd, nil
}

// CopyPath copies one checkout path (relative) into work, or removes it from
// work when it no longer exists in the checkout.
func (s *Syncer) CopyPath(rel string) error {
	rel = filepath.Clean(rel)
	if rel == "." || strings.HasPrefix(rel, "../") || filepath.IsAbs(rel) || isGitPath(rel) {
		return fmt.Errorf("refusing path %q", rel)
	}
	dir, name := filepath.Split(rel)
	dir = strings.TrimSuffix(dir, "/")
	var st unix.Stat_t
	srcDir, err := openBeneath(s.src, orDot(dir), unix.O_PATH|unix.O_DIRECTORY, 0)
	if err == nil {
		err = unix.Fstatat(srcDir, name, &st, unix.AT_SYMLINK_NOFOLLOW)
		if err != nil {
			unix.Close(srcDir)
		}
	}
	if err != nil {
		if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ENOTDIR) {
			return s.removePath(rel)
		}
		if errors.Is(err, unix.ELOOP) {
			return nil // under a symlinked directory in the checkout: the link itself is copied
		}
		return err
	}
	defer unix.Close(srcDir)
	dstDir, err := s.mkdirBeneath(dir)
	if err != nil {
		return err
	}
	defer unix.Close(dstDir)
	tmp := fmt.Sprintf("%s%d-%d", tmpPrefix, os.Getpid(), time.Now().UnixNano())
	switch st.Mode & unix.S_IFMT {
	case unix.S_IFLNK:
		target, err := readlinkat(srcDir, name)
		if err != nil {
			return err
		}
		if err := unix.Symlinkat(target, dstDir, tmp); err != nil {
			return err
		}
	case unix.S_IFREG:
		if err := copyFile(srcDir, name, dstDir, tmp, st.Mode&0o777); err != nil {
			return err
		}
	default:
		return nil // directories come from their files; sockets and devices aren't copied
	}
	if err := renameReplacing(dstDir, tmp, name); err != nil {
		unix.Unlinkat(dstDir, tmp, 0)
		return fmt.Errorf("%s: %w", rel, err)
	}
	s.synced[rel] = true
	return nil
}

func orDot(dir string) string {
	if dir == "" {
		return "."
	}
	return dir
}

func readlinkat(dirfd int, name string) (string, error) {
	buf := make([]byte, 4096)
	n, err := unix.Readlinkat(dirfd, name, buf)
	if err != nil {
		return "", err
	}
	return string(buf[:n]), nil
}

func copyFile(srcDir int, name string, dstDir int, tmp string, mode uint32) error {
	in, err := openBeneath(srcDir, name, unix.O_RDONLY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	inf := os.NewFile(uintptr(in), name)
	defer inf.Close()
	out, err := openBeneath(dstDir, tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW, mode)
	if err != nil {
		return err
	}
	outf := os.NewFile(uintptr(out), tmp)
	defer outf.Close()
	_, err = io.Copy(outf, inf)
	if err == nil {
		err = unix.Fchmod(out, mode)
	}
	if err != nil {
		// No partial temp file left behind in the work copy (Bugbot, #1519).
		unix.Unlinkat(dstDir, tmp, 0)
	}
	return err
}

// renameReplacing renames tmp over name. rename(2) replaces a file or a
// symlink at name without following it; a directory there is removed first.
func renameReplacing(dirfd int, tmp, name string) error {
	err := unix.Renameat(dirfd, tmp, dirfd, name)
	if errors.Is(err, unix.EISDIR) || errors.Is(err, unix.ENOTEMPTY) || errors.Is(err, unix.EEXIST) {
		if err = removeEntry(dirfd, name); err == nil {
			err = unix.Renameat(dirfd, tmp, dirfd, name)
		}
	}
	return err
}

// removePath removes a path that left the checkout, if the sync put it there.
// Outputs the app wrote are never touched.
func (s *Syncer) removePath(rel string) error {
	if !s.synced[rel] {
		return nil
	}
	delete(s.synced, rel)
	dir, name := filepath.Split(rel)
	fd, err := openBeneath(s.dst, orDot(strings.TrimSuffix(dir, "/")), unix.O_PATH|unix.O_DIRECTORY, 0)
	if err != nil {
		return nil
	}
	defer unix.Close(fd)
	if err := unix.Unlinkat(fd, name, 0); err != nil && !errors.Is(err, unix.ENOENT) {
		return removeEntry(fd, name)
	}
	return nil
}

// Overlay makes work/node_modules a real, writable directory holding a
// symlink to each package in the checkout's node_modules. Tools that write
// caches into node_modules (.vite, .cache) write them here; a write into a
// package itself goes through the link to the read-only checkout and fails
// with EACCES.
//
// A package manager's own relative links are copied as they are instead
// (overlayTarget), and a scope directory (@scope) is a real directory of
// links rather than one link into the checkout: a workspace's
// node_modules/@scope/pkg -> ../../packages/pkg then resolves to the copy's
// packages/pkg, which the app can read and which follows edits, not to the
// checkout's, which Landlock refuses. Then the workspace members' own
// node_modules (NestedNodeModules).
func (s *Syncer) Overlay() error {
	ents, err := os.ReadDir(filepath.Join(s.checkout, "node_modules"))
	if errors.Is(err, os.ErrNotExist) {
		return s.NestedNodeModules()
	}
	if err != nil {
		return err
	}
	nm, err := s.mkdirBeneath("node_modules")
	if err != nil {
		return err
	}
	defer unix.Close(nm)
	want := map[string]bool{}
	for _, e := range ents {
		n := e.Name()
		if strings.HasPrefix(n, ".") && !nodeModulesDotLinks[n] {
			continue
		}
		want[n] = true
		if strings.HasPrefix(n, "@") && e.IsDir() && e.Type()&os.ModeSymlink == 0 {
			if err := s.overlayScope(nm, n, want); err != nil {
				return err
			}
			continue
		}
		target, err := s.overlayTarget("node_modules/" + n)
		if err != nil {
			return err
		}
		if err := linkEntry(nm, n, target); err != nil {
			return err
		}
		s.overlaid[n] = true
	}
	// Drop links to packages that were removed; leave the app's own entries.
	have, _ := os.ReadDir(filepath.Join(s.work, "node_modules"))
	for _, e := range have {
		n := e.Name()
		if want[n] {
			continue
		}
		if s.overlaid[n] {
			delete(s.overlaid, n)
			if e.IsDir() && e.Type()&os.ModeSymlink == 0 {
				// A scope directory it made: its own links only, then the directory if that empties it. What the
				// app wrote there stays (#1786).
				s.removeOverlaidScope(nm, n)
			} else {
				removeEntry(nm, n)
			}
		} else if t, err := readlinkat(nm, n); err == nil && strings.HasPrefix(t, filepath.Join(s.checkout, "node_modules")+"/") {
			unix.Unlinkat(nm, n, 0)
		}
	}
	return s.NestedNodeModules()
}

func (s *Syncer) removeOverlaidScope(nm int, scope string) {
	dir, err := openBeneath(nm, scope, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return
	}
	defer unix.Close(dir)
	for key := range s.overlaid {
		if pkg, ok := strings.CutPrefix(key, scope+"/"); ok {
			delete(s.overlaid, key)
			unix.Unlinkat(dir, pkg, 0)
		}
	}
	unix.Unlinkat(nm, scope, unix.AT_REMOVEDIR) // ENOTEMPTY: the app's entries keep it
}

// overlayScope makes work/node_modules/<scope> a real directory holding an
// overlay link for each of the checkout's <scope>/<pkg>.
func (s *Syncer) overlayScope(nm int, scope string, want map[string]bool) error {
	ents, err := os.ReadDir(filepath.Join(s.checkout, "node_modules", scope))
	if err != nil {
		return err
	}
	// A link the overlay made before (the scope was one link then) is replaced by the directory.
	if t, err := readlinkat(nm, scope); err == nil && t != "" {
		if err := unix.Unlinkat(nm, scope, 0); err != nil {
			return err
		}
	}
	dir, err := s.mkdirBeneath("node_modules/" + scope)
	if err != nil {
		return err
	}
	defer unix.Close(dir)
	s.overlaid[scope] = true
	mine := map[string]bool{}
	for _, e := range ents {
		key := scope + "/" + e.Name()
		want[key] = true
		mine[e.Name()] = true
		target, err := s.overlayTarget("node_modules/" + key)
		if err != nil {
			return err
		}
		if err := linkEntry(dir, e.Name(), target); err != nil {
			return err
		}
		s.overlaid[key] = true
	}
	have, _ := os.ReadDir(filepath.Join(s.work, "node_modules", scope))
	for _, e := range have {
		key := scope + "/" + e.Name()
		if !mine[e.Name()] && s.overlaid[key] {
			delete(s.overlaid, key)
			unix.Unlinkat(dir, e.Name(), 0)
		}
	}
	return nil
}

// overlayTarget is what the overlay links rel (node_modules/<pkg>) to:
// linkTarget's for a symlink, else the checkout's path.
func (s *Syncer) overlayTarget(rel string) (string, error) {
	abs := filepath.Join(s.checkout, rel)
	t, err := os.Readlink(abs)
	if errors.Is(err, unix.EINVAL) {
		return abs, nil
	}
	if err != nil {
		return "", err
	}
	return s.linkTarget(rel, t), nil
}

// linkTarget is what the copy's link at rel points at, for the checkout's
// link there to t. A relative t that resolves to the same place inside the
// copy is kept as it is: pnpm's node_modules/<pkg> -> .pnpm/<pkg>@<v>/...,
// a workspace's -> ../packages/<pkg> (the copy's own source). One that
// wouldn't becomes the absolute path it resolves to in the checkout: into a
// node_modules dot directory the overlay leaves out (a store configured as
// node_modules/.store), which the app reads through the checkout's
// node_modules as before, or out of the checkout. An absolute t is kept.
func (s *Syncer) linkTarget(rel, t string) string {
	if filepath.IsAbs(t) {
		return t
	}
	resolved := filepath.Join(s.checkout, filepath.Dir(rel), t)
	inside, err := filepath.Rel(s.checkout, resolved)
	if err != nil || inside == ".." || strings.HasPrefix(inside, "../") {
		return resolved
	}
	parts := strings.Split(inside, "/")
	for i, p := range parts {
		if p == "node_modules" && i+1 < len(parts) && strings.HasPrefix(parts[i+1], ".") && !nodeModulesDotLinks[parts[i+1]] {
			return resolved
		}
	}
	return t
}

// linkEntry points name under dirfd at target, replacing what is there
// without following it, unless it already does.
func linkEntry(dirfd int, name, target string) error {
	if cur, err := readlinkat(dirfd, name); err == nil && cur == target {
		return nil
	}
	tmp := fmt.Sprintf("%s%d-%d", tmpPrefix, os.Getpid(), time.Now().UnixNano())
	if err := unix.Symlinkat(target, dirfd, tmp); err != nil {
		return err
	}
	if err := renameReplacing(dirfd, tmp, name); err != nil {
		// No stray temp link left in the work copy's node_modules (Bugbot, #1519).
		unix.Unlinkat(dirfd, tmp, 0)
		return err
	}
	return nil
}

// workspaceMembers is every directory of the copy (the root aside) whose
// checkout counterpart has a node_modules directory: a pnpm, npm or yarn
// workspace's members (packages/<pkg>, apps/<app>). Found from the files the
// sync copied, so no walk of the checkout and nothing git ignores.
func (s *Syncer) workspaceMembers() []string {
	dirs := map[string]bool{}
	for f := range s.synced {
		for d := filepath.Dir(f); d != "." && !dirs[d]; d = filepath.Dir(d) {
			dirs[d] = true
		}
	}
	var members []string
	for d := range dirs {
		if filepath.Base(d) == "node_modules" || strings.Contains(d, "/node_modules/") || strings.HasPrefix(d, "node_modules/") {
			continue
		}
		if fi, err := os.Lstat(filepath.Join(s.checkout, d, "node_modules")); err == nil && fi.IsDir() {
			members = append(members, d)
		}
	}
	sort.Strings(members)
	return members
}

// NestedNodeModules recreates each workspace member's node_modules in work.
// The run's node_modules overlay is the root's only, and the app may read
// nothing else of the checkout, so without these a member's imports (and the
// root's, through the member's links) don't resolve. pnpm's are links
// (../../node_modules/.pnpm/<pkg>/..., ../../packages/<pkg>) and .bin
// scripts: copied as they are, the links resolve to the root overlay and to
// the copy's own packages. npm and yarn hoist all but a version clash, the
// one package copied as files. A tool's cache in one (.vite) starts empty.
// Not tracked as source; refreshed with the overlay, which a package
// manager's install updates through the root's node_modules (.modules.yaml,
// .package-lock.json).
func (s *Syncer) NestedNodeModules() error {
	members := s.workspaceMembers()
	now := map[string]bool{}
	for _, m := range members {
		now[m] = true
		rel := m + "/node_modules"
		if err := s.mirrorTree(rel, rel); err != nil {
			return fmt.Errorf("%s: %w", rel, err)
		}
		s.mirrored[m] = true
	}
	// A member whose node_modules the checkout no longer has (an uninstall, a
	// clean): its copy goes too, so the run can't import what was removed.
	for m := range s.mirrored {
		if now[m] {
			continue
		}
		delete(s.mirrored, m)
		dir, err := openBeneath(s.dst, m, unix.O_PATH|unix.O_DIRECTORY, 0)
		if err != nil {
			continue // the member itself is gone from the copy
		}
		err = removeEntry(dir, "node_modules")
		unix.Close(dir)
		if err != nil {
			return fmt.Errorf("%s/node_modules: %w", m, err)
		}
	}
	return nil
}

// A directory Watch watches for a member-only install, relative to the
// checkout. contents: its files' writes and modes too, not only its names.
type memberDir struct {
	rel      string
	contents bool
}

// The members' catch-up pass, before ready: how many tries, how far apart.
const (
	catchUpTries = 5
	catchUpWait  = 200 * time.Millisecond
)

// MemberNodeModulesDirs is what Watch watches for a member-only install:
// each mirrored member's node_modules and its scope directories, for names,
// and its .bin, for contents too. pnpm's packages are links, so a new or
// changed link is a name event here. .bin's scripts are copied as files, so a
// script written after its package's link (Bugbot, #1786) has to be an event
// of its own. A package copied as files (npm's or yarn's version clash) isn't
// watched inside: rebuilt in place, it reaches the run with the next install
// (#1786: pnpm is the case this is for).
func (s *Syncer) MemberNodeModulesDirs() []memberDir {
	var dirs []memberDir
	for m := range s.mirrored {
		rel := m + "/node_modules"
		dirs = append(dirs, memberDir{rel: rel})
		ents, _ := os.ReadDir(filepath.Join(s.checkout, rel))
		for _, e := range ents {
			if !e.IsDir() || e.Type()&os.ModeSymlink != 0 {
				continue
			}
			switch n := e.Name(); {
			case n == ".bin":
				dirs = append(dirs, memberDir{rel: rel + "/" + n, contents: true})
			case strings.HasPrefix(n, "@"):
				dirs = append(dirs, memberDir{rel: rel + "/" + n})
			}
		}
	}
	sort.Slice(dirs, func(i, j int) bool { return dirs[i].rel < dirs[j].rel })
	return dirs
}

// mirrorTree copies the checkout's rel into work like copyTree, then removes
// what work holds there that the checkout no longer does. top is the
// node_modules whose dot entries are a tool's caches (nodeModulesDotLinks).
func (s *Syncer) mirrorTree(rel, top string) error {
	names, err := s.copyTreeIn(rel, top, true)
	if err != nil {
		return err
	}
	// Made even when empty in the checkout, and a link planted there replaced by the directory.
	made, err := s.mkdirBeneath(rel)
	if err != nil {
		return err
	}
	unix.Close(made)
	dir, err := openBeneath(s.dst, rel, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer unix.Close(dir)
	have, err := readDirNames(dir)
	if err != nil {
		return err
	}
	for _, n := range have {
		if names[n] || strings.HasPrefix(n, tmpPrefix) || (rel == top && strings.HasPrefix(n, ".") && !nodeModulesDotLinks[n]) {
			continue
		}
		if err := removeEntry(dir, n); err != nil {
			return err
		}
	}
	return nil
}

// removeEntry removes name under dirfd, recursively, never following links.
func removeEntry(dirfd int, name string) error {
	err := unix.Unlinkat(dirfd, name, 0)
	if err == nil || errors.Is(err, unix.ENOENT) {
		return nil
	}
	if !errors.Is(err, unix.EISDIR) && !errors.Is(err, unix.EPERM) {
		return err
	}
	fd, err := openBeneath(dirfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	if err := removeChildren(fd); err != nil {
		unix.Close(fd)
		return err
	}
	unix.Close(fd)
	return unix.Unlinkat(dirfd, name, unix.AT_REMOVEDIR)
}

func removeChildren(fd int) error {
	names, err := readDirNames(fd)
	if err != nil {
		return err
	}
	for _, n := range names {
		if err := removeEntry(fd, n); err != nil {
			return err
		}
	}
	return nil
}

func readDirNames(fd int) ([]string, error) {
	dup, err := unix.Dup(fd)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(dup), "")
	defer f.Close()
	return f.Readdirnames(-1)
}

// RemoveContents empties dir without following any symlink in it.
func RemoveContents(dir string) error {
	fd, err := unix.Openat2(unix.AT_FDCWD, dir, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS})
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	return removeChildren(fd)
}

// Watch keeps work current from inotify events until killed. With a copied
// node_modules (refreshOverlay false) a package installed later doesn't reach
// the run; the owner restarts it.
// Watch follows the checkout until killed. initial (the first copy) runs once
// the watches are in place, so an edit made during the copy is an event the
// loop then syncs, never lost between the two (Bugbot, #1519); ready runs
// after it.
func (s *Syncer) Watch(log io.Writer, refreshOverlay bool, initial func() error, ready func()) error {
	in, err := unix.InotifyInit1(unix.IN_CLOEXEC)
	if err != nil {
		return err
	}
	const mask = unix.IN_CLOSE_WRITE | unix.IN_MOVED_TO | unix.IN_MOVED_FROM | unix.IN_CREATE |
		unix.IN_DELETE | unix.IN_ATTRIB | unix.IN_ONLYDIR | unix.IN_DONT_FOLLOW
	wds := map[int]string{}
	var add func(rel string)
	unwatched := 0
	add = func(rel string) {
		if isGitPath(rel) || rel == "node_modules" || strings.HasSuffix(rel, "/node_modules") {
			return
		}
		wd, err := unix.InotifyAddWatch(in, filepath.Join(s.checkout, rel), mask)
		if err != nil {
			// Gone since it was listed: nothing to follow. Anything else (a
			// full watch table) means edits there won't reach the run: say so
			// (Bugbot, #1519).
			if !errors.Is(err, unix.ENOENT) {
				unwatched++
				fmt.Fprintf(log, "termag-preview sync: not watching %s (%v): edits there won't reach the run until it restarts\n", rel, err)
			}
			return
		}
		wds[wd] = rel
		ents, _ := os.ReadDir(filepath.Join(s.checkout, rel))
		for _, e := range ents {
			if e.IsDir() && e.Type()&os.ModeSymlink == 0 {
				child := filepath.Join(rel, e.Name())
				if isIgnored(s.checkout, child) {
					continue
				}
				add(child)
			}
		}
	}
	add(".")
	const nmMask = unix.IN_CREATE | unix.IN_DELETE | unix.IN_MOVED_TO | unix.IN_MOVED_FROM | unix.IN_ONLYDIR | unix.IN_DONT_FOLLOW
	// -1 while the checkout has no node_modules yet: the root's watch sees it
	// arrive (an npm install after the start) and starts this one then (Bugbot, #1519).
	nmWD, err := unix.InotifyAddWatch(in, filepath.Join(s.checkout, "node_modules"), nmMask)
	if err != nil {
		nmWD = -1
	}
	if len(wds) == 0 {
		return fmt.Errorf("can't watch the checkout")
	}
	// Not ready with part of the checkout unwatched: edits there would never
	// reach the run (Devin, #1519). Directories made later are logged instead.
	if unwatched > 0 {
		return fmt.Errorf("%d directories of the checkout can't be watched; raise fs.inotify.max_user_watches", unwatched)
	}
	if initial != nil {
		if err := initial(); err != nil {
			return err
		}
	}
	// The workspace members' node_modules (NestedNodeModules), each and its
	// scope directories: an install that changes only a member's links
	// refreshes the overlay too (Devin, #1786). Added again after each refresh
	// (a member installed later); a directory already watched keeps its
	// descriptor.
	memberWDs := map[int]bool{}
	// The number it couldn't watch, each logged: gone since it was listed is
	// nothing to follow, anything else (a full watch table) is (Devin, #1786).
	watchMembers := func() int {
		if !refreshOverlay {
			return 0
		}
		failed := 0
		for _, d := range s.MemberNodeModulesDirs() {
			m := uint32(nmMask)
			if d.contents {
				m |= unix.IN_CLOSE_WRITE | unix.IN_ATTRIB
			}
			wd, err := unix.InotifyAddWatch(in, filepath.Join(s.checkout, d.rel), m)
			switch {
			case err == nil:
				memberWDs[wd] = true
			case errors.Is(err, unix.ENOENT):
			default:
				failed++
				fmt.Fprintf(log, "termag-preview sync: not watching %s (%v): installs there won't reach the run until it restarts\n", d.rel, err)
			}
		}
		return failed
	}
	// Watched only after the first copy made them, so an install during the
	// copy is caught by one more pass with the watches in place (Devin, #1786),
	// and a member that pass finds is watched too.
	failed := watchMembers()
	if refreshOverlay && len(s.mirrored) > 0 {
		// Tried a few times: a link removed mid-copy (an install still going) passes on the next try (Bugbot,
		// #1786). One that keeps failing (a full disk) keeps the sync from ready, rather than starting the app
		// without a dependency no event will bring back (Devin, #1786).
		var err error
		for try := 0; try < catchUpTries; try++ {
			if try > 0 {
				fmt.Fprintln(log, "termag-preview sync: workspace members, trying again:", err)
				time.Sleep(catchUpWait)
			}
			if err = s.NestedNodeModules(); err == nil {
				break
			}
		}
		if err != nil {
			return fmt.Errorf("workspace members: %w", err)
		}
		failed = watchMembers()
	}
	// As for the source: not ready with a member's installs unwatched.
	if failed > 0 {
		return fmt.Errorf("%d directories of the workspace members' node_modules can't be watched; raise fs.inotify.max_user_watches", failed)
	}
	if ready != nil {
		ready()
	}
	fmt.Fprintf(log, "termag-preview sync: watching %d directories\n", len(wds))

	buf := make([]byte, 64*1024)
	pending := map[string]bool{}
	overlay := false
	overflowed := false
	for {
		// Batch a burst of events (an editor's save is several) for 50 ms.
		n, err := unix.Read(in, buf)
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return err
		}
		deadline := time.Now().Add(50 * time.Millisecond)
		for {
			for off := 0; off+unix.SizeofInotifyEvent <= n; {
				ev := (*unix.InotifyEvent)(unsafe.Pointer(&buf[off]))
				nameb := buf[off+unix.SizeofInotifyEvent : off+unix.SizeofInotifyEvent+int(ev.Len)]
				name := string(bytes.TrimRight(nameb, "\x00"))
				off += unix.SizeofInotifyEvent + int(ev.Len)
				// The kernel's queue overflowed: events were lost, so nothing short of a full resync is right (Bugbot, #1519).
				if ev.Mask&unix.IN_Q_OVERFLOW != 0 {
					overflowed = true
					continue
				}
				var isNM bool
				if isNM, nmWD = nodeModulesEvent(int(ev.Wd), ev.Mask, nmWD); isNM {
					overlay = true
					continue
				}
				if memberWDs[int(ev.Wd)] {
					// Its watch gone (the directory removed): the descriptor may be a source directory's next.
					if ev.Mask&unix.IN_IGNORED != 0 {
						delete(memberWDs, int(ev.Wd))
					}
					overlay = true
					continue
				}
				base, ok := wds[int(ev.Wd)]
				if !ok || name == "" || strings.HasPrefix(name, tmpPrefix) {
					continue
				}
				rel := filepath.Join(base, name)
				made := ev.Mask&unix.IN_ISDIR != 0 && ev.Mask&(unix.IN_CREATE|unix.IN_MOVED_TO) != 0
				if rel == "node_modules" && ev.Mask&unix.IN_ISDIR != 0 && ev.Mask&unix.IN_MOVED_FROM != 0 && nmWD > 0 {
					// Moved away, its watch would follow it: dropped, so its descriptor can't be mistaken later.
					unix.InotifyRmWatch(in, uint32(nmWD))
					nmWD = -1
					overlay = true
				}
				if made && rel == "node_modules" {
					// Made, or made again (npm ci deletes it first): watch the new one (Devin, #1519).
					if wd, err := unix.InotifyAddWatch(in, filepath.Join(s.checkout, "node_modules"), nmMask); err == nil {
						nmWD = wd
					} else {
						nmWD = -1
						fmt.Fprintf(log, "termag-preview sync: not watching node_modules (%v): package changes won't reach the run until it restarts\n", err)
					}
					overlay = true
					continue
				}
				// A member's node_modules made, removed or replaced: the overlay's, not the source's.
				if filepath.Base(rel) == "node_modules" {
					overlay = true
					continue
				}
				// A directory made after the start is watched unless git ignores it (a build's dist,
				// .next), whose bursts would only crowd out the source's events (Bugbot, #1519).
				if made && !isIgnored(s.checkout, rel) {
					add(rel)
				}
				pending[rel] = true
			}
			wait := time.Until(deadline)
			if wait <= 0 {
				break
			}
			ready, _ := unix.Poll([]unix.PollFd{{Fd: int32(in), Events: unix.POLLIN}}, int(wait.Milliseconds())+1)
			if ready <= 0 {
				break
			}
			if n, err = unix.Read(in, buf); err != nil {
				break
			}
		}
		if overflowed {
			// Events were lost: watch what was made meanwhile (a walk; a directory already watched keeps its
			// watch), node_modules again, then make the copy match without events (Bugbot and Devin, #1519).
			fmt.Fprintln(log, "termag-preview sync: the event queue overflowed; resyncing the whole checkout")
			add(".")
			// A failed add (node_modules gone meanwhile) clears the old descriptor, which the kernel may hand to a
			// source directory next (Bugbot, #1519).
			if wd, err := unix.InotifyAddWatch(in, filepath.Join(s.checkout, "node_modules"), nmMask); err == nil {
				nmWD = wd
			} else {
				nmWD = -1
			}
			if err := s.Resync(); err != nil {
				// Tried again after the next batch of events, rather than dropped.
				fmt.Fprintln(log, "termag-preview sync: resync:", err)
			} else {
				overflowed = false
			}
			overlay = true
			pending = map[string]bool{}
		}
		if len(pending) > 0 {
			s.flush(pending, log)
			pending = map[string]bool{}
		}
		if overlay && refreshOverlay {
			if err := s.Overlay(); err != nil {
				fmt.Fprintln(log, "termag-preview sync: overlay:", err)
			}
			watchMembers()
			overlay = false
		}
	}
}

func isIgnored(checkout, rel string) bool {
	// `--`: a directory named like an option (-, --stdin) is a path (Bugbot, #1519).
	_, err := git(checkout, "check-ignore", "-q", "--", rel)
	return err == nil
}

// flush copies or removes each changed path that belongs in the copy.
func (s *Syncer) flush(pending map[string]bool, log io.Writer) {
	paths := make([]string, 0, len(pending))
	for p := range pending {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	// A listing that failed says nothing about what's gone: change nothing
	// (Bugbot, #1519). The paths stay as they were until a later event.
	files, err := s.listFiles(paths...)
	if err != nil {
		fmt.Fprintf(log, "termag-preview sync: %d changes not synced: %v\n", len(paths), err)
		return
	}
	keep := map[string]bool{}
	for _, f := range files {
		keep[f] = true
	}
	for _, p := range paths {
		switch {
		case keep[p] || isRootEnvFile(p):
			if err := s.CopyPath(p); err != nil {
				fmt.Fprintln(log, "termag-preview sync:", err)
			}
		case s.synced[p]:
			_ = s.removePath(p) // gone, or ignored now
		default:
			// A directory: copy what git lists below it.
			for f := range keep {
				if strings.HasPrefix(f, p+"/") {
					_ = s.CopyPath(f)
				}
			}
			for f := range s.synced {
				if strings.HasPrefix(f, p+"/") && !keep[f] {
					_ = s.CopyPath(f) // removes it when it's gone
				}
			}
		}
	}
	fmt.Fprintf(log, "termag-preview sync: %d changes\n", len(paths))
}

// CopyNodeModules copies the checkout's node_modules into work as real files,
// for tools that refuse a node_modules reached through symlinks leaving the
// project root (Turbopack). Symlinks inside it stay symlinks.
func (s *Syncer) CopyNodeModules() error {
	if _, err := os.Lstat(filepath.Join(s.checkout, "node_modules")); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return s.copyTree("node_modules")
}

func (s *Syncer) copyTree(rel string) error {
	_, err := s.copyTreeIn(rel, "node_modules", false)
	return err
}

// copyTreeIn copies the checkout's rel into work, symlinks as symlinks, and
// returns the names it holds. Dot entries of top (a node_modules) other than
// nodeModulesDotLinks are a tool's cache: they start empty in the run directory.
// With prune, each directory below is mirrorTree's, so what the checkout no
// longer holds goes from work too.
func (s *Syncer) copyTreeIn(rel, top string, prune bool) (map[string]bool, error) {
	src, err := openBeneath(s.src, rel, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	names, err := readDirNames(src)
	unix.Close(src)
	if err != nil {
		return nil, err
	}
	kept := map[string]bool{}
	for _, n := range names {
		child := rel + "/" + n
		if rel == top && strings.HasPrefix(n, ".") && !nodeModulesDotLinks[n] {
			continue // a tool's cache: starts empty in the run directory
		}
		var st unix.Stat_t
		if err := unix.Fstatat(s.src, child, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			if errors.Is(err, unix.ENOENT) {
				continue // removed since the listing (an install running)
			}
			return nil, err
		}
		kept[n] = true
		if st.Mode&unix.S_IFMT == unix.S_IFDIR {
			if prune {
				if err := s.mirrorTree(child, top); err != nil {
					return nil, err
				}
			} else if _, err := s.copyTreeIn(child, top, false); err != nil {
				return nil, err
			}
			continue
		}
		if prune && st.Mode&unix.S_IFMT == unix.S_IFLNK {
			if err := s.copyLink(child); err != nil {
				return nil, err
			}
			continue
		}
		if err := s.CopyPath(child); err != nil {
			return nil, err
		}
		delete(s.synced, child) // installs are not tracked as source
	}
	return kept, nil
}

// copyLink recreates the checkout's link at rel in work, pointing at
// linkTarget's target.
func (s *Syncer) copyLink(rel string) error {
	src, err := openBeneath(s.src, filepath.Dir(rel), unix.O_PATH|unix.O_DIRECTORY, 0)
	if err != nil {
		return err
	}
	t, err := readlinkat(src, filepath.Base(rel))
	unix.Close(src)
	if err != nil {
		return err
	}
	dst, err := s.mkdirBeneath(filepath.Dir(rel))
	if err != nil {
		return err
	}
	defer unix.Close(dst)
	return linkEntry(dst, filepath.Base(rel), s.linkTarget(rel, t))
}

// nodeModulesEvent says whether an inotify event on descriptor wd is node_modules' own (only the overlay needs
// refreshing), and what node_modules' descriptor is after it. Once the kernel drops that watch (IN_IGNORED, as
// when node_modules is removed) the descriptor is cleared: the kernel may hand the number to a source directory
// next, whose edits would otherwise be taken for node_modules' and never reach the work copy (Bugbot, #1519).
func nodeModulesEvent(wd int, mask uint32, nmWD int) (bool, int) {
	if nmWD <= 0 || wd != nmWD {
		return false, nmWD
	}
	if mask&unix.IN_IGNORED != 0 {
		return true, -1
	}
	return true, nmWD
}
