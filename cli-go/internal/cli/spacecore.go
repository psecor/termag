package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// The parts of space.ts that space, space memory and space sync share.

const spaceTimeout = 60 * time.Second
const transferRetries = 3

// SpaceView is one space as GET /spaces lists it; Raw is the server's object, for --json.
type SpaceView struct {
	Raw         json.RawMessage `json:"-"`
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Description *string         `json:"description"`
	Role        string          `json:"role"`
	ReadOnly    bool            `json:"readOnly"`
	UsedBytes   float64         `json:"usedBytes"`
	QuotaBytes  float64         `json:"quotaBytes"`
	Access      *struct {
		Kind string `json:"kind"`
		Via  string `json:"via"`
	} `json:"access"`
}

func (s SpaceView) MarshalJSON() ([]byte, error) { return s.Raw, nil }

func (s *SpaceView) UnmarshalJSON(b []byte) error {
	type plain SpaceView
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*s = SpaceView(p)
	s.Raw = append(json.RawMessage(nil), b...)
	return nil
}

// TreeFile is one file of a tree page; Raw is the server's object.
type TreeFile struct {
	Raw        json.RawMessage `json:"-"`
	Name       string          `json:"name"`
	Path       string          `json:"path"`
	Size       float64         `json:"size"`
	ModifiedAt *string         `json:"modifiedAt"`
	Etag       *string         `json:"etag"`
	Shared     bool            `json:"shared"`
}

func (f TreeFile) MarshalJSON() ([]byte, error) { return f.Raw, nil }

func (f *TreeFile) UnmarshalJSON(b []byte) error {
	type plain TreeFile
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*f = TreeFile(p)
	f.Raw = append(json.RawMessage(nil), b...)
	return nil
}

type treeDir struct {
	Raw  json.RawMessage `json:"-"`
	Name string          `json:"name"`
	Path string          `json:"path"`
}

func (d treeDir) MarshalJSON() ([]byte, error) { return d.Raw, nil }

func (d *treeDir) UnmarshalJSON(b []byte) error {
	type plain treeDir
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*d = treeDir(p)
	d.Raw = append(json.RawMessage(nil), b...)
	return nil
}

type treePage struct {
	Prefix     string     `json:"prefix"`
	Dirs       []treeDir  `json:"dirs"`
	Files      []TreeFile `json:"files"`
	NextCursor *string    `json:"nextCursor"`
}

// RemoteRef is `space:path`, or a bare path with the space left out.
type RemoteRef struct {
	Space string // "" for none
	Path  string
}

var literalSpaceRE = regexp.MustCompile(`^space:([a-z0-9-]{2,40}):`)

// parseRemote: `space:<name>:<path>` (the literal word, as prompts write it) names space <name>.
func parseRemote(raw string) RemoteRef {
	if m := literalSpaceRE.FindStringSubmatch(raw); m != nil {
		return RemoteRef{Space: m[1], Path: raw[len(m[0]):]}
	}
	if colon := strings.Index(raw, ":"); colon > 0 && spaceNameRE.MatchString(raw[:colon]) {
		return RemoteRef{Space: raw[:colon], Path: raw[colon+1:]}
	}
	return RemoteRef{Path: raw}
}

// jsToFixed1 is n.toFixed(1).
// It rounds the exact binary value with a tie going up, as JS does (Go's %.1f ties to even, and
// v*10 in float64 can round across a boundary: 1.15 is 1.1 in JS).
func jsToFixed1(v float64) string {
	if v < 0 || math.IsNaN(v) || math.IsInf(v, 0) || v >= 1e21 {
		return fmt.Sprintf("%.1f", v)
	}
	f := new(big.Float).SetPrec(256).SetFloat64(v)
	f.Mul(f, new(big.Float).SetPrec(256).SetInt64(10)) // exact at this precision
	n, _ := f.Int(nil)                                 // floor, for v >= 0
	frac := new(big.Float).SetPrec(256).Sub(f, new(big.Float).SetPrec(256).SetInt(n))
	if frac.Cmp(big.NewFloat(0.5)) >= 0 {
		n.Add(n, big.NewInt(1))
	}
	q, r := new(big.Int).QuoRem(n, big.NewInt(10), new(big.Int))
	return q.String() + "." + r.String()
}

// formatBytes is space.ts's formatBytes.
func formatBytes(n float64) string {
	if n < 1024 {
		return jsNumber(n) + " B"
	}
	units := []string{"KiB", "MiB", "GiB", "TiB"}
	v := n / 1024
	i := 0
	for v >= 1024 && i < len(units)-1 {
		v /= 1024
		i++
	}
	if v < 10 {
		return jsToFixed1(v) + " " + units[i]
	}
	return jsNumber(jsRound(v)) + " " + units[i]
}

// jsRound is Math.round (halves go up).
func jsRound(v float64) float64 { return math.Floor(v + 0.5) }

// localTarget is where a remote file lands under root; refuses anything that would escape it,
// lexically or through a symlink already on disk under root (a folder in the tree that links
// elsewhere). Deliberately stricter than the Node CLI, whose localTarget is lexical only.
func localTarget(root, relativePath string) (string, error) {
	target, err := lexicalTarget(root, relativePath)
	if err != nil {
		return "", err
	}
	return target, confinedTarget(root, relativePath, target)
}

// lexicalTarget is localTarget's path check only, before any symlink on disk is looked at. A caller
// that removes what is in the way without following it (space sync's repair, clearWay) checks the
// path first, clears the way, and only then runs confinedTarget.
func lexicalTarget(root, relativePath string) (string, error) {
	base := absPath(root)
	target := absPath(filepath.Join(append([]string{base}, strings.Split(relativePath, "/")...)...))
	if target != base && !strings.HasPrefix(target, base+string(filepath.Separator)) {
		q, _ := json.Marshal(relativePath)
		return "", newErr("failed", fmt.Sprintf("Refusing to write %s outside %s", q, base))
	}
	if target == base {
		return "", newErr("failed", "Refusing to overwrite "+base+" itself")
	}
	return target, nil
}

// confinedTarget refuses target when a symlink on disk takes its folder outside root.
func confinedTarget(root, relativePath, target string) error {
	base := absPath(root)
	if err := confinedUnder(base, target); err != nil {
		q, _ := json.Marshal(relativePath)
		return newErr("failed", fmt.Sprintf("Refusing to write %s outside %s: %s", q, base, err.Error()))
	}
	return nil
}

// resolveExisting is p with its longest existing prefix resolved through symlinks.
func resolveExisting(p string) string {
	rest := ""
	for cur := p; ; {
		if r, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(r, rest)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return p
		}
		rest = filepath.Join(filepath.Base(cur), rest)
		cur = parent
	}
}

// confinedUnder: target's folder, resolved through the symlinks on disk, is still base's (also
// resolved, so a destination that is itself a link is fine). The file itself may be a link: the
// download replaces it with a rename, never writing through it.
func confinedUnder(base, target string) error {
	rb := resolveExisting(base)
	dir := filepath.Dir(target)
	rd := resolveExisting(dir)
	if rd != rb && !strings.HasPrefix(rd, rb+string(filepath.Separator)) {
		return fmt.Errorf("%s leads to %s through a symlink", dir, rd)
	}
	return nil
}

var contentTypes = map[string]string{
	"txt": "text/plain", "md": "text/markdown", "json": "application/json", "csv": "text/csv", "yaml": "application/yaml", "yml": "application/yaml",
	"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "pdf": "application/pdf",
	"zip": "application/zip", "gz": "application/gzip", "tar": "application/x-tar", "html": "text/html", "svg": "image/svg+xml",
}

func contentTypeFor(p string) string {
	if dot := strings.LastIndex(p, "."); dot > 0 {
		if t, ok := contentTypes[strings.ToLower(p[dot+1:])]; ok {
			return t
		}
	}
	return "application/octet-stream"
}

// enc is encodeURIComponent.
func enc(s string) string {
	const keep = "-_.!~*'()"
	var b strings.Builder
	for _, c := range []byte(s) {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || strings.IndexByte(keep, c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

var _ = url.PathEscape

// spaceApi is space.ts's api(): the authed client with the spaces' longer timeout.
func spaceApi(c *Ctx, a *ParsedArgs) (*Api, error) {
	s, err := newSession(c, a)
	if err != nil {
		return nil, err
	}
	return authedApi(c, s, spaceTimeout)
}

func listSpaces(api *Api) ([]SpaceView, error) {
	var res struct {
		Spaces []SpaceView `json:"spaces"`
	}
	if err := api.Request(context.Background(), "GET", "/spaces", nil, &res); err != nil {
		return nil, err
	}
	if res.Spaces == nil {
		res.Spaces = []SpaceView{}
	}
	return res.Spaces, nil
}

// spaceOf is the space a remote ref names, or the only one the caller reaches.
func spaceOf(api *Api, ref RemoteRef) (string, error) {
	if ref.Space != "" {
		return ref.Space, nil
	}
	spaces, err := listSpaces(api)
	if err != nil {
		return "", err
	}
	switch len(spaces) {
	case 1:
		return spaces[0].Name, nil
	case 0:
		return "", newErr("not_found", "You reach no spaces; ask a space owner to add you or this box")
	}
	names := make([]string, len(spaces))
	for i, s := range spaces {
		names[i] = s.Name
	}
	return "", usageError("Name the space as space:path; you reach " + strings.Join(names, ", "))
}

// withRetry retries a transfer that failed plainly (a CliError of another code is final).
func withRetry[T any](c *Ctx, what string, fn func() (T, error)) (T, error) {
	var last error
	var zero T
	for attempt := 1; attempt <= transferRetries; attempt++ {
		v, err := fn()
		if err == nil {
			return v, nil
		}
		last = err
		var ce *CliError
		if errors.As(err, &ce) && ce.Code != "failed" {
			return zero, err
		}
		if attempt < transferRetries {
			c.sleep(time.Duration(250*(1<<attempt)) * time.Millisecond)
		}
	}
	return zero, newErr("failed", what+": "+last.Error())
}

var s3CodeRE = regexp.MustCompile(`<Code>([^<]+)</Code>`)

// s3Client follows redirects, as fetch does by default (the orchestrator's client never does).
func (c *Ctx) s3Client() *http.Client {
	cl := *c.HTTP
	cl.CheckRedirect = nil
	return &cl
}

// s3Fetch sends a presigned request; the caller closes the body.
func s3Fetch(c *Ctx, req *http.Request, what string) (*http.Response, error) {
	res, err := c.s3Client().Do(req)
	if err != nil {
		return nil, errors.New("fetch failed") // undici's TypeError message; withRetry adds what
	}
	// Storage refusing a signed condition: someone wrote between the orchestrator's check and this PUT.
	if res.StatusCode == 412 {
		res.Body.Close()
		return nil, &CliError{Code: "changed", Status: 412, Message: what + ": it changed since you read it (someone wrote it just now); nothing written"}
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		code := ""
		if m := s3CodeRE.FindSubmatch(body); m != nil {
			code = " " + string(m[1])
		}
		return nil, newErr("failed", fmt.Sprintf("%s: storage answered HTTP %d%s", what, res.StatusCode, code))
	}
	return res, nil
}

// listAll is every file under prefix, every page; recursive false lists only the files directly in it.
func listAll(api *Api, space, prefix string, recursive bool) ([]TreeFile, error) {
	files := []TreeFile{}
	cursor := ""
	rec := "recursive=1&"
	if !recursive {
		rec = ""
	}
	for {
		q := fmt.Sprintf("/spaces/%s/tree?%sprefix=%s", enc(space), rec, enc(prefix))
		if cursor != "" {
			q += "&cursor=" + enc(cursor)
		}
		var page treePage
		if err := api.Request(context.Background(), "GET", q, nil, &page); err != nil {
			return nil, err
		}
		files = append(files, page.Files...)
		if page.NextCursor == nil || *page.NextCursor == "" {
			return files, nil
		}
		cursor = *page.NextCursor
	}
}

type downloaded struct {
	Size      float64
	Etag      string
	VersionID string
}

// download fetches space:path to dest. With keep (the remote as the user wrote it, for the hint),
// an existing dest is never replaced: checked once the remote is known to exist, and again
// atomically as the download lands.
func download(c *Ctx, api *Api, space, path, dest string, keep *string) (downloaded, error) {
	what := fmt.Sprintf("download %s:%s", space, path)
	return withRetry(c, what, func() (downloaded, error) {
		var r struct {
			URL       string  `json:"url"`
			Size      float64 `json:"size"`
			Etag      *string `json:"etag"`
			VersionID *string `json:"versionId"`
		}
		if err := api.Request(context.Background(), "POST", "/spaces/"+enc(space)+"/files/download", newObject().Set("path", path), &r); err != nil {
			return downloaded{}, err
		}
		if keep != nil {
			if err := refuseToClobber([]string{dest}, *keep); err != nil {
				return downloaded{}, err
			}
		}
		req, err := http.NewRequest("GET", r.URL, nil)
		if err != nil {
			return downloaded{}, newErr("failed", err.Error())
		}
		res, err := s3Fetch(c, req, what)
		if err != nil {
			return downloaded{}, err
		}
		defer res.Body.Close()
		if err := os.MkdirAll(filepath.Dir(dest), 0o777); err != nil {
			return downloaded{}, err
		}
		tmp := dest + ".termag-partial"
		// A new file, never one already there: a planted link of that name is not written through.
		_ = os.Remove(tmp)
		defer os.Remove(tmp)
		f, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o666)
		if err != nil {
			return downloaded{}, err
		}
		if _, err := io.Copy(f, res.Body); err != nil {
			f.Close()
			return downloaded{}, err
		}
		if err := f.Close(); err != nil {
			return downloaded{}, err
		}
		if keep != nil {
			if err := placeWithoutReplacing(tmp, dest, *keep); err != nil {
				return downloaded{}, err
			}
		} else if err := os.Rename(tmp, dest); err != nil {
			return downloaded{}, err
		}
		return downloaded{Size: r.Size, Etag: strOr(r.Etag, ""), VersionID: strOr(r.VersionID, "")}, nil
	})
}

// placeWithoutReplacing moves tmp to dest only if nothing is at dest, decided in the same system
// call that creates it (a hard link; an exclusive-create copy where links are unsupported).
func placeWithoutReplacing(tmp, dest, remote string) error {
	err := os.Link(tmp, dest)
	if err == nil {
		return nil
	}
	if errors.Is(err, os.ErrExist) {
		return refuseToClobber([]string{dest}, remote)
	}
	if !errors.Is(err, syscall.EPERM) && !errors.Is(err, syscall.ENOTSUP) && !errors.Is(err, syscall.EOPNOTSUPP) && !errors.Is(err, syscall.EXDEV) {
		return err
	}
	src, err := os.Open(tmp)
	if err != nil {
		return err
	}
	defer src.Close()
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o666)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return refuseToClobber([]string{dest}, remote)
		}
		return err
	}
	if _, err := io.Copy(out, src); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// occupied: anything at path, a dangling symlink included.
func occupied(p string) bool { _, err := os.Lstat(p); return err == nil }

// refuseToClobber: space get with no destination never replaces an existing file.
func refuseToClobber(locals []string, remote string) error {
	var existing []string
	for _, l := range locals {
		if occupied(l) {
			existing = append(existing, l)
		}
	}
	if len(existing) == 0 {
		return nil
	}
	shown := existing
	more := ""
	if len(existing) > 3 {
		shown = existing[:3]
		more = fmt.Sprintf(" and %d more", len(existing)-3)
	}
	verb := "exist"
	if len(existing) == 1 {
		verb = "exists"
	}
	return newErr("conflict", fmt.Sprintf("%s%s already %s, and space get with no destination does not replace files. Give a destination: `termag space get %s <dest>` (a path outside a git checkout, or the existing path to replace it).",
		strings.Join(shown, ", "), more, verb, remote))
}
