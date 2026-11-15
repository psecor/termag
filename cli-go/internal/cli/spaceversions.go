package cli

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// spaceVersions.ts: the version of each space file this user last read on this machine, so a
// later write can say which one it replaces (If-Match). One file per space,
// ~/.termag/spaces/.versions/<space>.json, shared with the Node CLI: the format is kept as is.

var spaceNameRE = regexp.MustCompile(`^[a-z0-9-]{2,40}$`)

const maxVersionEntries = 5000

// readVersion is one entry, in the Node CLI's key order.
type readVersion struct {
	Etag      string `json:"etag"`
	VersionID string `json:"versionId,omitempty"`
	At        string `json:"at"`
	Via       string `json:"via"`
}

type versionFile struct {
	files *Object // path -> readVersion (or the raw entry as read)
}

func versionsPath(home, space string) (string, error) {
	if !spaceNameRE.MatchString(space) {
		b, _ := json.Marshal(space)
		return "", fmt.Errorf("Not a space name: %s", b)
	}
	return filepath.Join(home, ".termag", "spaces", ".versions", space+".json"), nil
}

func readVersions(home, space string) versionFile {
	empty := versionFile{files: newObject()}
	p, err := versionsPath(home, space)
	if err != nil {
		return empty
	}
	text, err := os.ReadFile(p)
	if err != nil {
		return empty
	}
	var top struct {
		Version int             `json:"version"`
		Files   json.RawMessage `json:"files"`
	}
	if json.Unmarshal(text, &top) != nil || top.Version != 1 || len(top.Files) == 0 {
		return empty
	}
	files := newObject()
	if files.UnmarshalJSON(top.Files) != nil {
		return empty
	}
	return versionFile{files: files}
}

func entryOf(v any) (readVersion, bool) {
	switch t := v.(type) {
	case readVersion:
		return t, true
	case json.RawMessage:
		var rv readVersion
		if json.Unmarshal(t, &rv) == nil {
			return rv, true
		}
	}
	return readVersion{}, false
}

func writeVersions(home, space string, v versionFile) error {
	p, err := versionsPath(home, space)
	if err != nil {
		return err
	}
	file, err := checkInSpaces(home, p)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	if _, err := checkInSpaces(home, file); err != nil {
		return err
	}
	if v.files.Len() > maxVersionEntries {
		// Oldest reads go first: they are the ones least likely to be written back.
		keys := append([]string(nil), v.files.Keys()...)
		at := func(k string) string { x, _ := v.files.Get(k); e, _ := entryOf(x); return e.At }
		sort.SliceStable(keys, func(i, j int) bool { return at(keys[i]) > at(keys[j]) })
		kept := newObject()
		for _, k := range keys[:maxVersionEntries] {
			x, _ := v.files.Get(k)
			kept.Set(k, x)
		}
		v.files = kept
	}
	top := newObject().Set("version", 1).Set("files", v.files)
	rnd := make([]byte, 4)
	_, _ = rand.Read(rnd)
	tmp := file + "." + hex.EncodeToString(rnd) + ".tmp"
	if err := os.WriteFile(tmp, []byte(CompactJSON(top)), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

// versionOf is the version of space:path this client read last.
func versionOf(home, space, path string) *readVersion {
	x, ok := readVersions(home, space).files.Get(path)
	if !ok {
		return nil
	}
	e, ok := entryOf(x)
	if !ok {
		return nil
	}
	return &e
}

type seenVersion struct {
	Path      string
	Etag      string
	VersionID string
}

// rememberVersions records reads (or writes) of several paths at once.
func rememberVersions(c *Ctx, home, space string, seen []seenVersion, via string) error {
	var known []seenVersion
	for _, s := range seen {
		if s.Etag != "" {
			known = append(known, s)
		}
	}
	if len(known) == 0 {
		return nil
	}
	v := readVersions(home, space)
	at := isoString(c.now())
	for _, s := range known {
		v.files.Set(s.Path, readVersion{Etag: s.Etag, VersionID: s.VersionID, At: at, Via: via})
	}
	return writeVersions(home, space, v)
}

func rememberVersion(c *Ctx, home, space, path, etag, versionID, via string) error {
	return rememberVersions(c, home, space, []seenVersion{{path, etag, versionID}}, via)
}

// forgetVersions forgets path, or everything under a folder path ending in /.
func forgetVersions(home, space, path string) error {
	v := readVersions(home, space)
	before := v.files.Len()
	for _, p := range append([]string(nil), v.files.Keys()...) {
		if p == path || (strings.HasSuffix(path, "/") && strings.HasPrefix(p, path)) || path == "" {
			v.files.Delete(p)
		}
	}
	if v.files.Len() != before {
		return writeVersions(home, space, v)
	}
	return nil
}

// remembering: the version cache is a hint; a refused write to it is said on stderr.
func remembering(c *Ctx, err error) {
	if err != nil {
		c.Err("termag: not remembering file versions: " + err.Error())
	}
}

var _ = time.Now
