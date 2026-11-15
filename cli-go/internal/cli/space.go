package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

// space.ts: ls, get, url, put, rm, mv. share/unshare/create/members/boxes/slack run in Node.
// TODO(cli-go phase 2): space share, unshare, create, members, boxes, slack.

const partURLBatch = 16

func init() {
	register("space ls", cmdSpaceLs)
	register("space get", cmdSpaceGet)
	register("space url", cmdSpaceUrl)
	register("space put", cmdSpacePut)
	register("space rm", cmdSpaceRm)
	register("space mv", cmdSpaceMv)
}

func spaceUsage(command string) *CliError { return usageError("Usage: " + specByName[command].Usage) }

// TODO(cli-go phase 2): Project files and My files: a bare
// path defaults to $TERMAG_SPACE, --mine to $TERMAG_MY_FILES, and ls labels both. Until it's ported, a run
// that could use them goes to Node, which has them (cli/src/space.ts resolveSpace).
func projectFilesInPlay(c *Ctx, a *ParsedArgs) bool {
	return a.Bool("mine") || c.Env["TERMAG_SPACE"] != "" || c.Env["TERMAG_MY_FILES"] != ""
}

// spreadInto is `{ ...o, ...raw }` for a server object: its keys replace o's in place, new ones go last.
func spreadInto(o *Object, raw json.RawMessage) *Object {
	r := newObject()
	if len(raw) > 0 && r.UnmarshalJSON(raw) == nil {
		for _, k := range r.Keys() {
			v, _ := r.Get(k)
			o.Set(k, v)
		}
	}
	return o
}

// ---- ls ----

func cmdSpaceLs(c *Ctx, a *ParsedArgs) (int, error) {
	if projectFilesInPlay(c, a) {
		return 0, errFallback
	}
	api, err := spaceApi(c, a)
	if err != nil {
		return 0, err
	}
	if len(a.Args) == 0 {
		spaces, err := listSpaces(api)
		if err != nil {
			return 0, err
		}
		if a.JSON {
			c.Out(JSONText(newObject().Set("spaces", spaces)))
			return ExitOK, nil
		}
		if len(spaces) == 0 {
			c.Out("No spaces. Create one with `termag space create <name>`.")
			return ExitOK, nil
		}
		rows := make([][]string, len(spaces))
		for i, s := range spaces {
			role := s.Role
			if s.ReadOnly {
				role += " (read-only)"
			}
			access := "-"
			if s.Access != nil {
				if s.Access.Kind == "explicit" {
					access = "this box"
				} else {
					access = "via " + s.Access.Via
				}
			}
			rows[i] = []string{s.Name, role, access, formatBytes(s.UsedBytes) + " of " + formatBytes(s.QuotaBytes)}
		}
		c.Out(Table([]string{"SPACE", "ROLE", "ACCESS", "USED"}, rows))
		return ExitOK, nil
	}
	raw := a.Args[0]
	var ref RemoteRef
	if !strings.Contains(raw, ":") && spaceNameRE.MatchString(raw) {
		ref = RemoteRef{Space: raw}
	} else {
		ref = parseRemote(raw)
	}
	space, err := spaceOf(api, ref)
	if err != nil {
		return 0, err
	}
	dirs := []treeDir{}
	files := []TreeFile{}
	cursor := ""
	prefix := ""
	for {
		q := "prefix=" + enc(ref.Path)
		if cursor != "" {
			q += "&cursor=" + enc(cursor)
		}
		var page treePage
		if err := api.Request(context.Background(), "GET", "/spaces/"+enc(space)+"/tree?"+q, nil, &page); err != nil {
			return 0, err
		}
		prefix = page.Prefix
		dirs = append(dirs, page.Dirs...)
		files = append(files, page.Files...)
		if page.NextCursor == nil || *page.NextCursor == "" {
			break
		}
		cursor = *page.NextCursor
	}
	if a.JSON {
		c.Out(JSONText(newObject().Set("space", space).Set("prefix", prefix).Set("dirs", dirs).Set("files", files)))
		return ExitOK, nil
	}
	if len(dirs) == 0 && len(files) == 0 {
		c.Out(fmt.Sprintf("%s:%s is empty.", space, prefix))
		return ExitOK, nil
	}
	var rows [][]string
	for _, d := range dirs {
		rows = append(rows, []string{d.Name + "/", "-", "-"})
	}
	for _, f := range files {
		name := f.Name
		if f.Shared {
			name += " (shared)"
		}
		mod := "-"
		if f.ModifiedAt != nil && *f.ModifiedAt != "" {
			m := *f.ModifiedAt
			if len(m) > 16 {
				m = m[:16]
			}
			mod = strings.Replace(m, "T", " ", 1)
		}
		rows = append(rows, []string{name, formatBytes(f.Size), mod})
	}
	c.Out(Table([]string{"NAME", "SIZE", "MODIFIED"}, rows))
	return ExitOK, nil
}

// ---- get ----

// gotFile is one downloaded file, in space.ts's key order.
type gotFile struct {
	Path      string  `json:"path"`
	Local     string  `json:"local"`
	Size      float64 `json:"size"`
	Etag      string  `json:"etag,omitempty"`
	VersionID string  `json:"versionId,omitempty"`
}

// jsBasename is path.basename (no "." for an empty path, trailing slashes ignored).
func jsBasename(p string) string {
	p = strings.TrimRight(p, "/")
	if p == "" {
		return ""
	}
	return p[strings.LastIndex(p, "/")+1:]
}

func cmdSpaceGet(c *Ctx, a *ParsedArgs) (int, error) {
	if projectFilesInPlay(c, a) {
		return 0, errFallback
	}
	if len(a.Args) == 0 || a.Args[0] == "" {
		return 0, spaceUsage("space get")
	}
	rawRemote := a.Args[0]
	hasDest := len(a.Args) > 1
	rawDest := ""
	if hasDest {
		rawDest = a.Args[1]
	}
	api, err := spaceApi(c, a)
	if err != nil {
		return 0, err
	}
	ref := parseRemote(rawRemote)
	space, err := spaceOf(api, ref)
	if err != nil {
		return 0, err
	}
	var got []gotFile
	root := ""
	rec := a.Bool("recursive")
	if rec {
		prefix := ref.Path
		if prefix != "" && !strings.HasSuffix(prefix, "/") {
			prefix += "/"
		}
		rootArg := rawDest
		if !hasDest {
			rootArg = space
			if prefix != "" {
				rootArg = jsBasename(prefix[:len(prefix)-1])
			}
		}
		root = absPath(rootArg)
		files, err := listAll(api, space, prefix, true)
		if err != nil {
			return 0, err
		}
		if len(files) == 0 {
			return 0, newErr("not_found", fmt.Sprintf("Nothing under %s:%s", space, prefix))
		}
		type planned struct{ path, local string }
		plan := make([]planned, len(files))
		locals := make([]string, len(files))
		for i, f := range files {
			l, err := localTarget(root, f.Path[min(len(prefix), len(f.Path)):])
			if err != nil {
				return 0, err
			}
			plan[i] = planned{f.Path, l}
			locals[i] = l
		}
		var keep *string
		if rawDest == "" {
			k := "-r " + rawRemote
			keep = &k
			if err := refuseToClobber(locals, k); err != nil {
				return 0, err
			}
		}
		for _, p := range plan {
			// Again as each file lands: an earlier download, or another process, may have changed the tree.
			if err := confinedUnder(absPath(root), p.local); err != nil {
				q, _ := json.Marshal(p.path[min(len(prefix), len(p.path)):])
				return 0, newErr("failed", fmt.Sprintf("Refusing to write %s outside %s: %s", q, absPath(root), err.Error()))
			}
			v, err := download(c, api, space, p.path, p.local, keep)
			if err != nil {
				return 0, err
			}
			got = append(got, gotFile{Path: p.path, Local: p.local, Size: v.Size, Etag: v.Etag, VersionID: v.VersionID})
			if !a.JSON {
				c.Err(fmt.Sprintf("got %s:%s (%s)", space, p.path, formatBytes(v.Size)))
			}
		}
	} else {
		if ref.Path == "" || strings.HasSuffix(ref.Path, "/") {
			return 0, usageError("That is a folder; use -r")
		}
		localArg := jsBasename(ref.Path)
		if hasDest {
			localArg = rawDest
		}
		local := absPath(localArg)
		if rawDest != "" {
			if st, err := os.Stat(local); strings.HasSuffix(rawDest, "/") || (err == nil && st.IsDir()) {
				local = filepath.Join(local, jsBasename(ref.Path))
			}
		}
		var keep *string
		if rawDest == "" {
			keep = &rawRemote
		}
		v, err := download(c, api, space, ref.Path, local, keep)
		if err != nil {
			return 0, err
		}
		got = append(got, gotFile{Path: ref.Path, Local: local, Size: v.Size, Etag: v.Etag, VersionID: v.VersionID})
	}
	seen := make([]seenVersion, len(got))
	for i, g := range got {
		seen[i] = seenVersion{g.Path, g.Etag, g.VersionID}
	}
	remembering(c, rememberVersions(c, c.Home, space, seen, "get"))
	switch {
	case a.JSON:
		c.Out(JSONText(newObject().Set("space", space).Set("files", got)))
	case !rec:
		c.Out(fmt.Sprintf("%s (%s)", got[0].Local, formatBytes(got[0].Size)))
	default:
		c.Out(fmt.Sprintf("%d files into %s", len(got), root))
	}
	return ExitOK, nil
}

// ---- url ----

func cmdSpaceUrl(c *Ctx, a *ParsedArgs) (int, error) {
	if projectFilesInPlay(c, a) {
		return 0, errFallback
	}
	if len(a.Args) == 0 || a.Args[0] == "" {
		return 0, spaceUsage("space url")
	}
	ref := parseRemote(a.Args[0])
	if ref.Path == "" || strings.HasSuffix(ref.Path, "/") {
		return 0, usageError("Name a file, not a folder")
	}
	api, err := spaceApi(c, a)
	if err != nil {
		return 0, err
	}
	space, err := spaceOf(api, ref)
	if err != nil {
		return 0, err
	}
	var r struct {
		URL  string `json:"url"`
		Path string `json:"path"`
	}
	if err := api.Request(context.Background(), "POST", "/spaces/"+enc(space)+"/files/link", newObject().Set("path", ref.Path), &r); err != nil {
		return 0, err
	}
	if a.JSON {
		c.Out(JSONText(newObject().Set("space", space).Set("path", r.Path).Set("url", r.URL)))
	} else {
		c.Out(r.URL)
	}
	return ExitOK, nil
}

// ---- put ----

// writeCondition is { ifMatch } or { ifNoneMatch: '*' }; nil for none.
type writeCondition struct {
	ifMatch     string
	ifNoneMatch bool
}

func (w *writeCondition) addTo(o *Object) *Object {
	if w == nil {
		return o
	}
	if w.ifNoneMatch {
		return o.Set("ifNoneMatch", "*")
	}
	return o.Set("ifMatch", w.ifMatch)
}

type written struct {
	Size      float64
	Etag      string
	VersionID string
}

type uploadStart struct {
	Kind        string            `json:"kind"`
	URL         string            `json:"url"`
	Headers     map[string]string `json:"headers"`
	UploadID    string            `json:"uploadId"`
	PartBytes   int64             `json:"partBytes"`
	PartCount   int               `json:"partCount"`
	Conditional *bool             `json:"conditional"`
}

type writtenResp struct {
	Etag      *string `json:"etag"`
	VersionID *string `json:"versionId"`
}

func readPart(f *os.File, offset, length int64) ([]byte, error) {
	buf := make([]byte, length)
	n, err := f.ReadAt(buf, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return buf[:n], nil
}

// upload is space.ts's upload: one file, saying which version it replaces (exit 6 when refused).
// implicit marks a condition from the version cache: an orchestrator too old to check it then
// writes unconditionally, with a warning, where an explicit one refuses.
func upload(c *Ctx, api *Api, space, local, path string, quiet bool, condition *writeCondition, implicit bool) (written, error) {
	st, err := os.Stat(local)
	if err != nil {
		return written{}, err
	}
	size := st.Size()
	base := "/spaces/" + enc(space)
	bg := context.Background()
	var start uploadStart
	body := newObject().Set("path", path).Set("size", size).Set("contentType", contentTypeFor(local))
	if err := api.Request(bg, "POST", base+"/files/upload", condition.addTo(body), &start); err != nil {
		return written{}, err
	}
	abort := func() {
		_ = api.Request(bg, "DELETE", base+"/uploads/"+enc(start.UploadID)+"?path="+enc(path), nil, nil)
	}
	cond := condition
	if cond != nil && (start.Conditional == nil || !*start.Conditional) {
		if !implicit {
			if start.Kind == "multipart" {
				abort()
			}
			return written{}, newErr("failed", fmt.Sprintf("This orchestrator cannot check versions yet; nothing written to %s:%s. --force writes without the check.", space, path))
		}
		c.Err(fmt.Sprintf("termag: this orchestrator can't check versions yet; %s:%s is written without the check", space, path))
		cond = nil
	}
	done := func(w writtenResp) written {
		return written{Size: float64(size), Etag: strOr(w.Etag, ""), VersionID: strOr(w.VersionID, "")}
	}
	what := fmt.Sprintf("upload %s:%s", space, path)

	if start.Kind == "single" {
		put, err := withRetry(c, what, func() (http.Header, error) {
			f, err := os.Open(local)
			if err != nil {
				return nil, err
			}
			data, err := readPart(f, 0, size)
			f.Close()
			if err != nil {
				return nil, err
			}
			req, err := http.NewRequest("PUT", start.URL, bytes.NewReader(data))
			if err != nil {
				return nil, err
			}
			for k, v := range start.Headers {
				req.Header.Set(k, v)
			}
			res, err := s3Fetch(c, req, what)
			if err != nil {
				return nil, err
			}
			_, _ = io.Copy(io.Discard, res.Body)
			res.Body.Close()
			return res.Header, nil
		})
		if err != nil {
			return written{}, err
		}
		// The ETag the PUT answered lets the orchestrator find this write among the versions.
		etag := put.Get("Etag")
		b := cond.addTo(newObject().Set("path", path))
		if cond != nil && etag != "" {
			b.Set("etag", etag)
		}
		var w writtenResp
		if err := api.Request(bg, "POST", base+"/files/uploaded", b, &w); err != nil {
			return written{}, err
		}
		return done(w), nil
	}

	f, err := os.Open(local)
	if err != nil {
		return written{}, err
	}
	defer f.Close()
	res, err := func() (written, error) {
		type part struct {
			PartNumber int    `json:"partNumber"`
			Etag       string `json:"etag"`
		}
		parts := []part{}
		for first := 1; first <= start.PartCount; first += partURLBatch {
			n := min(partURLBatch, start.PartCount-first+1)
			numbers := make([]int, n)
			for i := range numbers {
				numbers[i] = first + i
			}
			var urls struct {
				Parts []struct {
					PartNumber int    `json:"partNumber"`
					URL        string `json:"url"`
				} `json:"parts"`
			}
			if err := api.Request(bg, "POST", base+"/uploads/"+enc(start.UploadID)+"/parts", newObject().Set("path", path).Set("size", size).Set("partNumbers", numbers), &urls); err != nil {
				return written{}, err
			}
			for _, p := range urls.Parts {
				etag, err := withRetry(c, fmt.Sprintf("%s part %d", what, p.PartNumber), func() (string, error) {
					data, err := readPart(f, int64(p.PartNumber-1)*start.PartBytes, start.PartBytes)
					if err != nil {
						return "", err
					}
					req, err := http.NewRequest("PUT", p.URL, bytes.NewReader(data))
					if err != nil {
						return "", err
					}
					res, err := s3Fetch(c, req, fmt.Sprintf("upload part %d", p.PartNumber))
					if err != nil {
						return "", err
					}
					_, _ = io.Copy(io.Discard, res.Body)
					res.Body.Close()
					tag := res.Header.Get("Etag")
					if tag == "" {
						return "", errors.New("storage returned no ETag (is ETag exposed by CORS?)")
					}
					return tag, nil
				})
				if err != nil {
					return written{}, err
				}
				parts = append(parts, part{p.PartNumber, etag})
				if !quiet {
					c.Err(fmt.Sprintf("  part %d/%d", p.PartNumber, start.PartCount))
				}
			}
		}
		var w writtenResp
		if err := api.Request(bg, "POST", base+"/uploads/"+enc(start.UploadID)+"/complete", cond.addTo(newObject().Set("path", path).Set("parts", parts)), &w); err != nil {
			return written{}, err
		}
		return done(w), nil
	}()
	if err != nil {
		abort()
		return written{}, err
	}
	return res, nil
}

// icuPunct is ICU root collation's order of ASCII punctuation and symbols, all before digits.
const icuPunct = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$"

// localeLess orders names as String#localeCompare (ICU root collation) does for ASCII names:
// punctuation in ICU's order, then digits, then letters case-insensitively, lowercase first on a
// tie. Non-ASCII letters sort by code point after ASCII ones (ICU would fold accents).
func localeLess(x, y string) bool {
	rank := func(r rune) int {
		if i := strings.IndexRune(icuPunct, r); i >= 0 && r < 0x80 {
			return i
		}
		switch {
		case r >= '0' && r <= '9':
			return 100 + int(r-'0')
		case r < 0x80 && unicode.IsLetter(r):
			return 200 + int(unicode.ToLower(r)-'a')
		}
		return 1000 + int(unicode.ToLower(r))
	}
	xr, yr := []rune(x), []rune(y)
	for i := 0; i < len(xr) && i < len(yr); i++ {
		if ra, rb := rank(xr[i]), rank(yr[i]); ra != rb {
			return ra < rb
		}
	}
	if len(xr) != len(yr) {
		return len(xr) < len(yr)
	}
	for i := range xr { // tertiary: lowercase before uppercase
		if xr[i] != yr[i] {
			return unicode.IsLower(xr[i])
		}
	}
	return false
}

// walk lists the regular files under dir, depth first, each folder sorted as Node sorts it.
func walk(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(entries, func(i, j int) bool { return localeLess(entries[i].Name(), entries[j].Name()) })
	var out []string
	for _, e := range entries {
		full := filepath.Join(dir, e.Name())
		switch {
		case e.IsDir():
			sub, err := walk(full)
			if err != nil {
				return nil, err
			}
			out = append(out, sub...)
		case e.Type().IsRegular():
			out = append(out, full)
		}
	}
	return out, nil
}

func latin1(b []byte) string {
	r := make([]rune, len(b))
	for i, c := range b {
		r[i] = rune(c)
	}
	return string(r)
}

// refuseSecretMemory: a file going to a space's .termag/ that looks like it holds a secret is refused.
func refuseSecretMemory(local, path string) error {
	if !strings.HasPrefix(path, ".termag/") {
		return nil
	}
	st, err := os.Stat(local)
	if err != nil {
		return err
	}
	if st.Size() > 2*1024*1024 {
		return nil
	}
	b, err := os.ReadFile(local)
	if err != nil {
		return err
	}
	if refusal := memoryPutRefusal(path, latin1(b)); refusal != "" {
		return newErr("failed", "Refusing to upload: "+refusal)
	}
	return nil
}

// writeConditionFor: --force none, --if-match / --if-new as given, else the version this client read.
func writeConditionFor(c *Ctx, a *ParsedArgs, space, path string) (*writeCondition, bool) {
	if a.Bool("force") {
		return nil, false
	}
	if m, ok := a.Str("if-match"); ok {
		return &writeCondition{ifMatch: m}, false
	}
	if a.Bool("if-new") {
		return &writeCondition{ifNoneMatch: true}, false
	}
	if read := versionOf(c.Home, space, path); read != nil {
		return &writeCondition{ifMatch: read.Etag}, true
	}
	return nil, true
}

func checkWriteFlags(a *ParsedArgs, many bool) error {
	_, ifMatch := a.Str("if-match")
	set := 0
	for _, b := range []bool{a.Bool("force"), ifMatch, a.Bool("if-new")} {
		if b {
			set++
		}
	}
	if set > 1 {
		return usageError("Give one of --force, --if-match and --if-new")
	}
	if many && ifMatch {
		return usageError("--if-match names one file's version; with -r each file uses the version you read")
	}
	return nil
}

type putFile struct {
	Local string  `json:"local"`
	Path  string  `json:"path"`
	Size  float64 `json:"size"`
	Etag  string  `json:"etag,omitempty"`
}

type putConflict struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

func cmdSpacePut(c *Ctx, a *ParsedArgs) (int, error) {
	if projectFilesInPlay(c, a) {
		return 0, errFallback
	}
	if len(a.Args) < 2 || a.Args[0] == "" {
		return 0, spaceUsage("space put")
	}
	rawLocal, rawRemote := a.Args[0], a.Args[1]
	local := absPath(rawLocal)
	if _, err := os.Stat(local); err != nil {
		return 0, newErr("not_found", "No such file: "+rawLocal)
	}
	lst, err := os.Lstat(local)
	if err != nil {
		return 0, err
	}
	isDir := lst.IsDir()
	if isDir && !a.Bool("recursive") {
		return 0, usageError(rawLocal + " is a folder; use -r")
	}
	if err := checkWriteFlags(a, isDir); err != nil {
		return 0, err
	}
	api, err := spaceApi(c, a)
	if err != nil {
		return 0, err
	}
	ref := parseRemote(rawRemote)
	space, err := spaceOf(api, ref)
	if err != nil {
		return 0, err
	}
	put := []putFile{}
	var conflicts []putConflict

	one := func(file, path string, many bool) error {
		condition, implicit := writeConditionFor(c, a, space, path)
		w, err := upload(c, api, space, file, path, a.JSON, condition, implicit)
		if err != nil {
			var ce *CliError
			if !errors.As(err, &ce) || ce.Code != "changed" || !many {
				return err
			}
			conflicts = append(conflicts, putConflict{path, ce.Message})
			if !a.JSON {
				c.Err(fmt.Sprintf("refused %s:%s: %s", space, path, ce.Message))
			}
			return nil
		}
		// What it wrote is now the version this client knows.
		remembering(c, rememberVersion(c, c.Home, space, path, w.Etag, w.VersionID, "put"))
		put = append(put, putFile{Local: file, Path: path, Size: w.Size, Etag: w.Etag})
		if many && !a.JSON {
			c.Err(fmt.Sprintf("put %s:%s (%s)", space, path, formatBytes(w.Size)))
		}
		return nil
	}

	if isDir {
		prefix := ref.Path
		if prefix != "" && !strings.HasSuffix(prefix, "/") {
			prefix += "/"
		}
		files, err := walk(local)
		if err != nil {
			return 0, err
		}
		paths := make([]string, len(files))
		for i, f := range files {
			rel, _ := filepath.Rel(local, f)
			paths[i] = prefix + filepath.ToSlash(rel)
		}
		for i := range files {
			if err := refuseSecretMemory(files[i], paths[i]); err != nil {
				return 0, err
			}
		}
		for i := range files {
			if err := one(files[i], paths[i], true); err != nil {
				return 0, err
			}
		}
	} else {
		if !lst.Mode().IsRegular() {
			return 0, usageError(rawLocal + " is not a regular file")
		}
		path := ref.Path
		if path == "" || strings.HasSuffix(path, "/") {
			path += filepath.Base(local)
		}
		if err := refuseSecretMemory(local, path); err != nil {
			return 0, err
		}
		if err := one(local, path, false); err != nil {
			return 0, err
		}
	}
	switch {
	case a.JSON:
		o := newObject().Set("space", space).Set("files", put)
		if len(conflicts) > 0 {
			o.Set("conflicts", conflicts)
		}
		c.Out(JSONText(o))
	case !isDir:
		c.Out(fmt.Sprintf("%s:%s (%s)", space, put[0].Path, formatBytes(put[0].Size)))
	default:
		suffix := ""
		if len(conflicts) > 0 {
			ps := make([]string, len(conflicts))
			for i, cf := range conflicts {
				ps[i] = cf.Path
			}
			suffix = fmt.Sprintf("; %d refused, changed since you read them: %s (put them again with --force to overwrite)", len(conflicts), strings.Join(ps, ", "))
		}
		c.Out(fmt.Sprintf("%d files into %s:%s%s", len(put), space, ref.Path, suffix))
	}
	if len(conflicts) > 0 {
		return ExitChanged, nil
	}
	return ExitOK, nil
}

// ---- rm, mv ----

type changedFiles struct {
	OK      bool     `json:"ok"`
	Deleted float64  `json:"deleted"`
	Moved   float64  `json:"moved"`
	Failed  []string `json:"failed"`
}

func plural(n float64) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func cmdSpaceRm(c *Ctx, a *ParsedArgs) (int, error) {
	if projectFilesInPlay(c, a) {
		return 0, errFallback
	}
	if len(a.Args) == 0 || a.Args[0] == "" {
		return 0, spaceUsage("space rm")
	}
	api, err := spaceApi(c, a)
	if err != nil {
		return 0, err
	}
	ref := parseRemote(a.Args[0])
	space, err := spaceOf(api, ref)
	if err != nil {
		return 0, err
	}
	rec := a.Bool("recursive")
	if rec && ref.Path == "" {
		return 0, usageError("Refusing to empty a whole space; name a folder")
	}
	if !rec && (ref.Path == "" || strings.HasSuffix(ref.Path, "/")) {
		return 0, usageError("That is a folder; use -r")
	}
	// A file this client read is deleted only if it is still that version; a folder's files aren't checked.
	var read *readVersion
	if !rec && !a.Bool("force") {
		read = versionOf(c.Home, space, ref.Path)
	}
	q := "/spaces/" + enc(space) + "/files?path=" + enc(ref.Path)
	if rec {
		q += "&recursive=1"
	}
	if read != nil {
		q += "&ifMatch=" + enc(read.Etag)
	}
	raw, err := api.RequestRaw(context.Background(), "DELETE", q, nil)
	if err != nil {
		return 0, err
	}
	var r changedFiles
	_ = json.Unmarshal(raw, &r)
	forget := ref.Path
	if rec && !strings.HasSuffix(forget, "/") {
		forget += "/"
	}
	remembering(c, forgetVersions(c.Home, space, forget))
	if a.JSON {
		c.Out(JSONText(spreadInto(newObject().Set("space", space).Set("path", ref.Path), raw)))
	} else {
		failed := ""
		if len(r.Failed) > 0 {
			failed = "; failed: " + strings.Join(r.Failed, ", ")
		}
		c.Out(fmt.Sprintf("Deleted %s file%s from %s:%s%s", jsNumber(r.Deleted), plural(r.Deleted), space, ref.Path, failed))
	}
	if r.OK {
		return ExitOK, nil
	}
	return ExitFailed, nil
}

func cmdSpaceMv(c *Ctx, a *ParsedArgs) (int, error) {
	if projectFilesInPlay(c, a) {
		return 0, errFallback
	}
	if len(a.Args) < 2 || a.Args[0] == "" || a.Args[1] == "" {
		return 0, spaceUsage("space mv")
	}
	api, err := spaceApi(c, a)
	if err != nil {
		return 0, err
	}
	from := parseRemote(a.Args[0])
	to := parseRemote(a.Args[1])
	space, err := spaceOf(api, from)
	if err != nil {
		return 0, err
	}
	if to.Space != "" && to.Space != space {
		return 0, usageError("mv works inside one space; use get and put to copy between spaces")
	}
	toPath := to.Path
	if strings.HasSuffix(from.Path, "/") && to.Path != "" && !strings.HasSuffix(to.Path, "/") {
		toPath += "/"
	}
	// A file this client read moves only if it is still that version; a folder's files aren't checked.
	var read *readVersion
	if !strings.HasSuffix(from.Path, "/") && !a.Bool("force") {
		read = versionOf(c.Home, space, from.Path)
	}
	body := newObject().Set("from", from.Path).Set("to", toPath)
	if read != nil {
		body.Set("ifMatch", read.Etag)
	}
	raw, err := api.RequestRaw(context.Background(), "POST", "/spaces/"+enc(space)+"/files/move", body)
	if err != nil {
		return 0, err
	}
	var r changedFiles
	_ = json.Unmarshal(raw, &r)
	// The copy is a new version this client hasn't read.
	err = forgetVersions(c.Home, space, from.Path)
	if err == nil {
		err = forgetVersions(c.Home, space, toPath)
	}
	remembering(c, err)
	if a.JSON {
		c.Out(JSONText(spreadInto(newObject().Set("space", space).Set("from", from.Path).Set("to", toPath), raw)))
	} else {
		c.Out(fmt.Sprintf("Moved %s file%s: %s:%s -> %s:%s", jsNumber(r.Moved), plural(r.Moved), space, from.Path, space, toPath))
	}
	if r.OK {
		return ExitOK, nil
	}
	return ExitFailed, nil
}
