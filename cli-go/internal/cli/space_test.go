package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// spaceFake is an orchestrator's spaces API plus the S3 it presigns for, in one server.
type spaceFake struct {
	t         *testing.T
	srv       *httptest.Server
	mu        sync.Mutex
	files     map[string][]byte
	etags     map[string]string
	pending   map[string][]byte
	parts     map[int][]byte
	partBytes int64 // > 0: uploads larger than this are multipart
	partReqs  [][]int
	aborted   int
	gen       int
	noCond    bool // an orchestrator that can't check versions
	lastQuery string
	lastBody  map[string]any
}

func newSpaceFake(t *testing.T) *spaceFake {
	f := &spaceFake{t: t, files: map[string][]byte{}, etags: map[string]string{}, pending: map[string][]byte{}, parts: map[int][]byte{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *spaceFake) put(path, data string) {
	f.gen++
	f.files[path] = []byte(data)
	f.etags[path] = fmt.Sprintf(`"e%d"`, f.gen)
}

func (f *spaceFake) reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (f *spaceFake) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	body := map[string]any{}
	if b, _ := io.ReadAll(r.Body); len(b) > 0 && strings.HasPrefix(r.URL.Path, "/termag") {
		_ = json.Unmarshal(b, &body)
		if !strings.HasSuffix(r.URL.Path, "/usage") {
			f.lastBody = body
		}
	} else if len(b) > 0 || r.Method == "PUT" {
		body["_raw"] = string(b)
	}
	p := strings.TrimPrefix(r.URL.Path, "/termag/api/cli/v1")
	q := r.URL.Query()
	str := func(k string) string { s, _ := body[k].(string); return s }
	changed := func(path string) bool {
		if f.noCond {
			return false
		}
		if m := str("ifMatch"); m != "" && f.etags[path] != m {
			return true
		}
		if str("ifNoneMatch") == "*" && f.files[path] != nil {
			return true
		}
		return false
	}
	switch {
	case p == "/usage":
		w.WriteHeader(204)
	case p == "/spaces":
		f.reply(w, 200, map[string]any{"spaces": []any{map[string]any{"id": "s1", "name": "team", "description": nil, "role": "editor", "readOnly": false, "usedBytes": 2048, "quotaBytes": 1 << 30}}})
	case p == "/spaces/team/tree":
		prefix := q.Get("prefix")
		var keys []string
		for k := range f.files {
			if strings.HasPrefix(k, prefix) {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		files := []any{}
		for _, k := range keys {
			files = append(files, map[string]any{"name": filepath.Base(k), "path": k, "size": len(f.files[k]), "modifiedAt": "2026-11-12T10:20:30.000Z", "etag": f.etags[k]})
		}
		f.reply(w, 200, map[string]any{"prefix": prefix, "dirs": []any{}, "files": files, "nextCursor": nil})
	case p == "/spaces/team/files/download":
		path := str("path")
		if f.files[path] == nil {
			f.reply(w, 404, map[string]any{"error": "No such file: " + path})
			return
		}
		f.reply(w, 200, map[string]any{"url": f.srv.URL + "/s3/get?p=" + path, "size": len(f.files[path]), "etag": f.etags[path], "versionId": "v-" + path})
	case p == "/s3/get":
		_, _ = w.Write(f.files[q.Get("p")])
	case p == "/spaces/team/files/upload":
		path := str("path")
		if changed(path) {
			f.reply(w, 412, map[string]any{"error": path + " changed since you read it"})
			return
		}
		size := int64(body["size"].(float64))
		cond := !f.noCond
		if f.partBytes > 0 && size > f.partBytes {
			count := (size + f.partBytes - 1) / f.partBytes
			f.reply(w, 200, map[string]any{"kind": "multipart", "path": path, "uploadId": "u 1", "partBytes": f.partBytes, "partCount": count, "conditional": cond})
			return
		}
		f.reply(w, 200, map[string]any{"kind": "single", "path": path, "url": f.srv.URL + "/s3/put?p=" + path, "method": "PUT", "headers": map[string]string{"Content-Type": str("contentType")}, "conditional": cond})
	case p == "/s3/put":
		f.pending[q.Get("p")] = []byte(body["_raw"].(string))
		w.Header().Set("ETag", `"s3etag"`)
		w.WriteHeader(200)
	case p == "/spaces/team/files/uploaded":
		path := str("path")
		f.put(path, string(f.pending[path]))
		f.reply(w, 200, map[string]any{"size": len(f.files[path]), "etag": f.etags[path], "versionId": "v2"})
	case p == "/spaces/team/uploads/u 1/parts":
		var nums []int
		var urls []any
		for _, n := range body["partNumbers"].([]any) {
			i := int(n.(float64))
			nums = append(nums, i)
			urls = append(urls, map[string]any{"partNumber": i, "url": f.srv.URL + "/s3/part?n=" + strconv.Itoa(i)})
		}
		f.partReqs = append(f.partReqs, nums)
		f.reply(w, 200, map[string]any{"parts": urls})
	case p == "/s3/part":
		n, _ := strconv.Atoi(q.Get("n"))
		f.parts[n] = []byte(body["_raw"].(string))
		w.Header().Set("ETag", fmt.Sprintf(`"p%d"`, n))
		w.WriteHeader(200)
	case p == "/spaces/team/uploads/u 1/complete":
		var data []byte
		for i, pt := range body["parts"].([]any) {
			m := pt.(map[string]any)
			if int(m["partNumber"].(float64)) != i+1 || m["etag"] != fmt.Sprintf(`"p%d"`, i+1) {
				f.t.Errorf("part %d: %v", i+1, m)
			}
			data = append(data, f.parts[i+1]...)
		}
		f.put(str("path"), string(data))
		f.reply(w, 200, map[string]any{"size": len(data), "etag": f.etags[str("path")]})
	case p == "/spaces/team/uploads/u 1" && r.Method == "DELETE":
		f.aborted++
		w.WriteHeader(204)
	case p == "/spaces/team/files" && r.Method == "DELETE":
		f.lastQuery = r.URL.RawQuery
		path := q.Get("path")
		if m := q.Get("ifMatch"); m != "" && f.etags[path] != m {
			f.reply(w, 412, map[string]any{"error": path + " changed since you read it; nothing deleted"})
			return
		}
		n := 0
		for k := range f.files {
			if k == path || (q.Get("recursive") == "1" && strings.HasPrefix(k, path)) {
				delete(f.files, k)
				n++
			}
		}
		f.reply(w, 200, json.RawMessage(fmt.Sprintf(`{"ok":true,"deleted":%d,"failed":[]}`, n)))
	case p == "/spaces/team/files/move":
		from, to := str("from"), str("to")
		if changed(from) {
			f.reply(w, 412, map[string]any{"error": from + " changed since you read it"})
			return
		}
		f.files[to] = f.files[from]
		delete(f.files, from)
		f.reply(w, 200, json.RawMessage(`{"ok":true,"moved":1,"failed":[]}`))
	default:
		f.reply(w, 404, map[string]any{"error": "no route " + r.Method + " " + p})
	}
}

type spaceRun struct {
	code     int
	out, err string
}

// spaceTestCtx is a box (its own credential) talking to the fake.
func spaceTestCtx(t *testing.T, f *spaceFake, home string) (*Ctx, *strings.Builder, *strings.Builder) {
	cfg := filepath.Join(home, "agent.config.json")
	ws := "ws" + strings.TrimPrefix(f.srv.URL, "http") + "/termag/ws/agent"
	if err := os.WriteFile(cfg, []byte(fmt.Sprintf(`{"termag_url":%q,"token":%q}`, ws, "tmag_"+strings.Repeat("t", 20))), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errb strings.Builder
	c := &Ctx{
		Env:      map[string]string{"TERMAG_AGENT_CONFIG": cfg},
		Home:     home,
		Hostname: "test",
		Out:      func(s string) { out.WriteString(strings.TrimSuffix(s, "\n") + "\n") },
		Err:      func(s string) { errb.WriteString(strings.TrimSuffix(s, "\n") + "\n") },
		HTTP:     newHTTPClient(nil),
		ReadFile: func(p string) ([]byte, bool) { b, err := os.ReadFile(p); return b, err == nil },
		Sleep:    func(time.Duration) {},
	}
	return c, &out, &errb
}

func spaceRunIn(t *testing.T, f *spaceFake, home string, argv ...string) spaceRun {
	t.Helper()
	c, out, errb := spaceTestCtx(t, f, home)
	code := Run(argv, c)
	return spaceRun{code, out.String(), errb.String()}
}
