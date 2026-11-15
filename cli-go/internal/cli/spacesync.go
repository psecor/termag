package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// `termag space sync [space]` (cli/src/spaceSync.ts): read-only copies at ~/termag/spaces/<space>/.
// The box agent runs it with --json for the desktop's Files panel: stdout's shape, exit 1 with
// JSON on a partial failure and the error line on stderr are its contract.

func init() {
	register("space sync", cmdSpaceSync)
}

const (
	mirrorFileBytes  = 50 * 1024 * 1024
	mirrorTotalBytes = 1024 * 1024 * 1024
	mirrorFiles      = 5000
	mirrorLockStale  = 10 * time.Minute
	mirrorLockBeat   = time.Minute
)

func mirrorsDir(home string) string { return filepath.Join(home, "termag", "spaces") }

// checkInMirrors: dir, resolved, if it is ~/termag/spaces or inside it with no symlink from ~/termag down.
func checkInMirrors(home, dir string) (string, error) {
	root := absPath(mirrorsDir(home))
	target := absPath(dir)
	if target != root && !strings.HasPrefix(target, root+string(filepath.Separator)) {
		return "", newErr("failed", fmt.Sprintf("Refusing to touch %s: it is outside %s", target, root))
	}
	from := absPath(filepath.Join(home, "termag"))
	rel, _ := filepath.Rel(from, target)
	at := from
	for _, part := range append([]string{""}, strings.Split(rel, string(filepath.Separator))...) {
		if part == "." {
			continue
		}
		if part != "" {
			at = filepath.Join(at, part)
		}
		st, err := os.Lstat(at)
		if err != nil {
			break
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return "", newErr("failed", fmt.Sprintf("Refusing to touch %s: %s is a symlink; remove it and run again", target, at))
		}
	}
	return target, nil
}

type mirrorFile struct {
	Etag string  `json:"etag"`
	Size float64 `json:"size"`
}

func mirrorStatePath(home, space string) (string, error) {
	return checkInSpaces(home, filepath.Join(spacesDir(home), ".mirrors", space+".json"))
}

// readMirrorState: the previous sync's files (only the etags and sizes are read back).
func readMirrorState(home, space string) map[string]mirrorFile {
	p, err := mirrorStatePath(home, space)
	if err != nil {
		return nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	var st struct {
		Files map[string]mirrorFile `json:"files"`
	}
	if json.Unmarshal(b, &st) != nil {
		return nil
	}
	if st.Files == nil {
		st.Files = map[string]mirrorFile{}
	}
	return st.Files
}

func writeMirrorState(home string, state *Object, space string) error {
	file, err := mirrorStatePath(home, space)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(spacesDir(home), ".mirrors"), 0o700); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", file, os.Getpid())
	if err := os.WriteFile(tmp, []byte(CompactJSON(state)), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

// planMirror: by path, each file under the per-file cap, until the file count or byte total runs out.
func planMirror(files []TreeFile) (copy []TreeFile, skipped []pathReason) {
	sorted := append([]TreeFile(nil), files...)
	sort.SliceStable(sorted, func(i, j int) bool { return jsLess(sorted[i].Path, sorted[j].Path) })
	skipped = []pathReason{}
	var bytes float64
	for _, f := range sorted {
		switch {
		case f.Size > mirrorFileBytes:
			skipped = append(skipped, pathReason{f.Path, "over 50 MiB"})
		case len(copy) >= mirrorFiles:
			skipped = append(skipped, pathReason{f.Path, fmt.Sprintf("past %d files", mirrorFiles)})
		case bytes+f.Size > mirrorTotalBytes:
			skipped = append(skipped, pathReason{f.Path, "past the 1 GiB a copy holds"})
		default:
			copy = append(copy, f)
			bytes += f.Size
		}
	}
	return copy, skipped
}

// jsLess is JS's < on strings: UTF-16 code unit order.
func jsLess(a, b string) bool {
	ua, ub := []rune(a), []rune(b)
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			x, y := ua[i], ub[i]
			// A supplementary rune's high surrogate (D800-DBFF) sorts below U+E000-FFFF.
			if x > 0xFFFF {
				x = 0xD800
			}
			if y > 0xFFFF {
				y = 0xD800
			}
			if x == y {
				return ua[i] < ub[i]
			}
			return x < y
		}
	}
	return len(ua) < len(ub)
}

func removeEntry(p string) {
	st, err := os.Lstat(p)
	if err != nil {
		return
	}
	if st.IsDir() {
		_ = os.Chmod(p, 0o700)
		entries, _ := os.ReadDir(p)
		for _, e := range entries {
			removeEntry(filepath.Join(p, e.Name()))
		}
		_ = os.Remove(p)
		return
	}
	_ = os.Remove(p)
}

// clearWay: every folder from the copy's root down to target is a real folder. It walks the path
// with Lstat and never through a link: the first entry on the way that is not a real folder (a link,
// a file) is unlinked itself, its parent having been checked as a real folder inside root, and the
// walk stops there, since nothing below it exists any more. If unlinking fails (a read-only folder),
// it returns the error and removes nothing else: never the link's target, never anything reached
// through it. The target itself, when it is a link or a folder, goes the same way.
func clearWay(root, target string) error {
	rel, err := filepath.Rel(root, target)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("refusing to clear %s: it is not inside %s", target, root)
	}
	unlink := func(at string, st os.FileInfo) error {
		// at's parent is root or a real folder already walked: check it is still root's before removing.
		if err := confinedUnder(root, at); err != nil {
			return fmt.Errorf("refusing to remove %s: %v", at, err)
		}
		if st.IsDir() { // a real folder (Lstat): its own entries are Lstat'd too, links unlinked
			removeEntry(at)
		} else {
			_ = os.Remove(at)
		}
		if _, err := os.Lstat(at); err == nil {
			return fmt.Errorf("could not remove %s, which is in the way of the copy (a read-only folder?); nothing else was removed", at)
		}
		return nil
	}
	parts := strings.Split(rel, string(filepath.Separator))
	at := root
	for _, part := range parts[:len(parts)-1] {
		at = filepath.Join(at, part)
		st, err := os.Lstat(at)
		if err != nil {
			return nil // missing: MkdirAll makes it
		}
		if !st.IsDir() {
			return unlink(at, st) // nothing exists below it now
		}
	}
	if st, err := os.Lstat(target); err == nil && !st.Mode().IsRegular() {
		return unlink(target, st)
	}
	return nil
}

// prune removes what the copy holds that the space doesn't (and empty folders).
func prune(root string, wanted map[string]bool) (int, error) {
	removed := 0
	var walk func(dir string) (bool, error)
	walk = func(dir string) (bool, error) {
		empty := true
		entries, err := os.ReadDir(dir)
		if err != nil {
			return false, err
		}
		for _, e := range entries {
			p := filepath.Join(dir, e.Name())
			rel, _ := filepath.Rel(root, p)
			rel = filepath.ToSlash(rel)
			switch {
			case e.IsDir():
				sub, err := walk(p)
				if err != nil {
					return false, err
				}
				if sub {
					if err := os.Remove(p); err != nil {
						return false, err
					}
				} else {
					empty = false
				}
			case e.Type().IsRegular() && wanted[rel]:
				empty = false
			default:
				// Not a folder: a stale file or a link, removed without following it. A failure
				// fails the sync, as Node's rmSync does (force only ignores a missing file).
				if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
					return false, err
				}
				removed++
			}
		}
		return empty, nil
	}
	_, err := walk(root)
	return removed, err
}

// mirrorLock: one sync of a space at a time; a running one touches its lock every minute.
func mirrorLock(c *Ctx, home, space string) (func(), error) {
	if err := os.MkdirAll(filepath.Join(spacesDir(home), ".mirrors"), 0o700); err != nil {
		return nil, err
	}
	file, err := checkInSpaces(home, filepath.Join(spacesDir(home), ".mirrors", "."+space+".lock"))
	if err != nil {
		return nil, err
	}
	token := fmt.Sprintf("%d %s", os.Getpid(), randomUUID())
	if f, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600); err == nil {
		_, _ = f.WriteString(token)
		f.Close()
	} else {
		st, err := os.Stat(file)
		if err != nil || c.now().Sub(st.ModTime()) < mirrorLockStale {
			return nil, nil
		}
		if os.WriteFile(file, []byte(token), 0o600) != nil {
			return nil, nil
		}
	}
	ours := func() bool { b, err := os.ReadFile(file); return err == nil && string(b) == token }
	stop := make(chan struct{})
	go func() {
		// A panic must not end the process (exit 2 would block a prompt): the heartbeat just stops,
		// and the lock goes stale on its own, as if this process had died.
		defer func() { _ = recover() }()
		t := time.NewTicker(mirrorLockBeat)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				if ours() {
					now := time.Now()
					_ = os.Chtimes(file, now, now)
				}
			}
		}
	}()
	return func() {
		close(stop)
		if ours() {
			_ = os.Remove(file)
		}
	}, nil
}

func randomUUID() string {
	b := []byte(randomHex(16))
	h := string(b)
	// Version 4, variant 10xx, as crypto.randomUUID.
	return h[0:8] + "-" + h[8:12] + "-4" + h[13:16] + "-" + string("89ab"[int(h[16])%4]) + h[17:20] + "-" + h[20:32]
}

var stagingSuffixRE = regexp.MustCompile(`^[A-Za-z0-9]{6}$`)

// mirrorStaging: a fresh folder beside the copies for downloads in progress; a killed sync's goes first.
func mirrorStaging(home, space string) (string, error) {
	root, err := checkInMirrors(home, mirrorsDir(home))
	if err != nil {
		return "", err
	}
	prefix := ".staging-" + space + "-"
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), prefix) && stagingSuffixRE.MatchString(e.Name()[len(prefix):]) {
			removeEntry(filepath.Join(root, e.Name()))
		}
	}
	return mkdtemp(filepath.Join(root, prefix))
}

// mirrorResult is one space's outcome, in spaceSync.ts's key order.
type mirrorResult struct {
	Kind       string // synced, busy, failed
	Space      string
	Dir        string
	Files      int
	Bytes      float64
	Downloaded int
	Removed    int
	Skipped    []pathReason
	Error      string
}

func (r mirrorResult) object() *Object {
	o := newObject().Set("kind", r.Kind).Set("space", r.Space).Set("dir", r.Dir)
	switch r.Kind {
	case "synced":
		o.Set("files", r.Files).Set("bytes", json.Number(jsNumber(r.Bytes))).Set("downloaded", r.Downloaded).Set("removed", r.Removed).Set("skipped", r.Skipped)
	case "failed":
		o.Set("error", r.Error)
	}
	return o
}

func mirrorSpace(c *Ctx, api *Api, space string) (mirrorResult, error) {
	home := c.Home
	dir := filepath.Join(mirrorsDir(home), space)
	if _, err := checkInSpaces(home, spacesDir(home)); err != nil {
		return mirrorResult{}, err
	}
	release, err := mirrorLock(c, home, space)
	if err != nil {
		return mirrorResult{}, err
	}
	if release == nil {
		return mirrorResult{Kind: "busy", Space: space, Dir: dir}, nil
	}
	defer release()
	stage := ""
	defer func() {
		if stage != "" {
			removeEntry(stage)
		}
	}()
	if _, err := checkInMirrors(home, dir); err != nil {
		return mirrorResult{}, err
	}
	prev := readMirrorState(home, space)
	all, err := listAll(api, space, "", true)
	if err != nil {
		return mirrorResult{}, err
	}
	copy, skipped := planMirror(all)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return mirrorResult{}, err
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		return mirrorResult{}, err
	}
	if stage, err = mirrorStaging(home, space); err != nil {
		return mirrorResult{}, err
	}
	files := newObject()
	sizes := map[string]float64{}
	var seen []seenVersion
	downloaded := 0
	for _, f := range copy {
		// The path first; then clearWay removes a link (or file) in the way without following it,
		// checking each removal is root's before it is made, and fails rather than reach through a
		// link it could not remove; only then the symlink confinement of the target. A mirror folder
		// that became a link is repaired, never written or deleted through.
		target, err := lexicalTarget(dir, f.Path)
		if err != nil {
			return mirrorResult{}, err
		}
		if err := clearWay(dir, target); err != nil {
			return mirrorResult{}, err
		}
		if err := confinedTarget(dir, f.Path, target); err != nil {
			return mirrorResult{}, err
		}
		etag := jsNumber(f.Size) + ":" + strOr(f.ModifiedAt, "")
		if f.Etag != nil {
			etag = *f.Etag
		}
		have, had := prev[f.Path]
		st, statErr := os.Stat(target)
		if !had || have.Etag != etag || statErr != nil || float64(st.Size()) != f.Size {
			staged := filepath.Join(stage, fmt.Sprint(downloaded))
			got, err := download(c, api, space, f.Path, staged, nil)
			if err != nil {
				return mirrorResult{}, err
			}
			if err := os.Chmod(staged, 0o444); err != nil {
				return mirrorResult{}, err
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return mirrorResult{}, err
			}
			if err := os.Rename(staged, target); err != nil {
				return mirrorResult{}, err
			}
			downloaded++
			if got.Etag != "" {
				if v := versionOf(home, space, f.Path); v == nil || v.Etag != got.Etag {
					seen = append(seen, seenVersion{Path: f.Path, Etag: got.Etag, VersionID: got.VersionID})
				}
			}
			e := got.Etag
			if e == "" {
				e = etag
			}
			files.Set(f.Path, mirrorFile{Etag: e, Size: got.Size})
			sizes[f.Path] = got.Size
			continue
		}
		files.Set(f.Path, mirrorFile{Etag: etag, Size: f.Size})
		sizes[f.Path] = f.Size
	}
	wanted := map[string]bool{}
	for _, k := range files.Keys() {
		wanted[k] = true
	}
	removed, err := prune(dir, wanted)
	if err != nil {
		return mirrorResult{}, err
	}
	state := newObject().Set("version", 1).Set("space", space).Set("syncedAt", isoString(c.now())).Set("files", files).Set("skipped", skipped)
	if err := writeMirrorState(home, state, space); err != nil {
		return mirrorResult{}, err
	}
	remembering(c, rememberVersions(c, home, space, seen, "sync"))
	var bytes float64
	for _, k := range files.Keys() {
		bytes += sizes[k]
	}
	return mirrorResult{Kind: "synced", Space: space, Dir: dir, Files: len(copy), Bytes: bytes, Downloaded: downloaded, Removed: removed, Skipped: skipped}, nil
}

// removeMirror: a copy this CLI made (it has a state file), removed with its state.
func removeMirror(c *Ctx, home, space string) (bool, error) {
	sp, err := mirrorStatePath(home, space)
	if err != nil {
		return false, err
	}
	if !occupiedFollow(sp) {
		return false, nil
	}
	release, err := mirrorLock(c, home, space)
	if err != nil || release == nil {
		return false, err
	}
	defer release()
	dir, err := checkInMirrors(home, filepath.Join(mirrorsDir(home), space))
	if err != nil {
		return false, err
	}
	removeEntry(dir)
	if occupiedFollow(dir) {
		return false, nil
	}
	_ = os.Remove(sp)
	return true, nil
}

func staleMirrors(home string, reached map[string]bool) []string {
	entries, err := os.ReadDir(filepath.Join(spacesDir(home), ".mirrors"))
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		n := e.Name()
		if !strings.HasSuffix(n, ".json") {
			continue
		}
		s := n[:len(n)-len(".json")]
		if spaceNameRE.MatchString(s) && !reached[s] {
			out = append(out, s)
		}
	}
	return out
}

func cmdSpaceSync(c *Ctx, a *ParsedArgs) (int, error) {
	api, err := spaceApi(c, a)
	if err != nil {
		return 0, err
	}
	all, err := listSpaces(api)
	if err != nil {
		return 0, err
	}
	var spaces []SpaceView
	reached := map[string]bool{}
	for _, s := range all {
		if spaceNameRE.MatchString(s.Name) {
			spaces = append(spaces, s)
			reached[s.Name] = true
		}
	}
	named, hasNamed := "", len(a.Args) > 0
	if hasNamed {
		named = a.Args[0]
		if !spaceNameRE.MatchString(named) {
			return 0, usageError(CompactJSON(named) + " is not a space name")
		}
		if !reached[named] {
			_, _ = removeMirror(c, c.Home, named)
			return 0, newErr("not_found", "You don't reach "+named)
		}
	}
	var results []mirrorResult
	removed := []string{}
	if !hasNamed {
		for _, stale := range staleMirrors(c.Home, reached) {
			ok, err := removeMirror(c, c.Home, stale)
			if err != nil {
				results = append(results, mirrorResult{Kind: "failed", Space: stale, Dir: filepath.Join(mirrorsDir(c.Home), stale), Error: err.Error()})
			} else if ok {
				removed = append(removed, stale)
			}
		}
	}
	for _, view := range spaces {
		if hasNamed && view.Name != named {
			continue
		}
		r, err := func() (r mirrorResult, err error) {
			defer func() {
				if p := recover(); p != nil {
					err = fmt.Errorf("%v", p)
				}
			}()
			return mirrorSpace(c, api, view.Name)
		}()
		if err != nil {
			r = mirrorResult{Kind: "failed", Space: view.Name, Dir: filepath.Join(mirrorsDir(c.Home), view.Name), Error: err.Error()}
		}
		results = append(results, r)
	}
	failed := false
	for _, r := range results {
		if r.Kind == "failed" {
			failed = true
		}
	}
	code := ExitOK
	if failed {
		code = ExitFailed
	}
	if a.JSON {
		byName := map[string]SpaceView{}
		for _, s := range spaces {
			byName[s.Name] = s
		}
		out := []*Object{}
		for _, r := range results {
			o := r.object()
			if s, ok := byName[r.Space]; ok {
				o.Set("role", s.Role).Set("readOnly", s.ReadOnly)
				if raw := spaceAccessRaw(s); raw != nil {
					o.Set("access", raw)
				}
			}
			out = append(out, o)
		}
		c.Out(JSONText(newObject().Set("root", mirrorsDir(c.Home)).Set("default", nullable(defaultSpace(spaces, c.Env))).Set("spaces", out).Set("removed", removed)))
		return code, nil
	}
	if len(results) == 0 && len(removed) == 0 {
		c.Out("You reach no spaces.")
	}
	for _, r := range results {
		switch r.Kind {
		case "busy":
			c.Out(r.Space + ": another sync is running")
		case "failed":
			c.Err(r.Space + ": " + r.Error)
		default:
			notCopied := ""
			if len(r.Skipped) > 0 {
				notCopied = fmt.Sprintf("; %d not copied (--json says why)", len(r.Skipped))
			}
			plural := "s"
			if r.Files == 1 {
				plural = ""
			}
			c.Out(fmt.Sprintf("%s: %d file%s (%s) in %s%s", r.Space, r.Files, plural, formatBytes(r.Bytes), r.Dir, notCopied))
		}
	}
	for _, s := range removed {
		c.Out(s + ": removed, you no longer reach it")
	}
	return code, nil
}

// spaceAccessRaw is a space's `access` as the server sent it, or nil when absent or null.
func spaceAccessRaw(s SpaceView) json.RawMessage {
	var m map[string]json.RawMessage
	if json.Unmarshal(s.Raw, &m) != nil {
		return nil
	}
	v, ok := m["access"]
	if !ok || string(v) == "null" {
		return nil
	}
	return v
}
