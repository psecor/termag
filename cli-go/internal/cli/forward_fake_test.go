package cli

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A fake orchestrator with the forward surface and the box behind it, modelled on
// cli/src/test/fakeForward.ts: /boxes, the probe, refusals as plain HTTP answers before any
// upgrade, and an upgraded socket per connection that stands in for the agent's end.

type fwdFakeConn struct {
	port      int
	protocol  string
	tokens    []string
	stray     []string
	received  int
	gotFin    bool
	closeCode int
	sent      int
	ws        *websocket.Conn
}

type fwdFake struct {
	t     *testing.T
	srv   *httptest.Server
	mu    sync.Mutex
	probe struct {
		status int
		body   string
	}
	behave  map[int]string // echo (default), firehose
	queue   map[int][]string
	total   int
	v1Only  bool
	conns   []*fwdFakeConn
	dials   []string          // Authorization headers
	access  map[string]string // access token -> sign-in (device token)
	refresh int
	signIn  string
}

func fwdJWT(jti string, n int) string {
	payload := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"jti":%q,"n":%d}`, jti, n)))
	return "eyJhbGciOiJub25lIn0." + payload + ".sig"
}

func fwdNewFake(t *testing.T) *fwdFake {
	f := &fwdFake{t: t, behave: map[int]string{}, queue: map[int][]string{}, access: map[string]string{}, signIn: "dev1"}
	f.probe.status = 200
	f.probe.body = `{"ok":true,"capability":"port-forward-v1","maxConnections":128}`
	f.access[fwdJWT("dev1", 0)] = "dev1"
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(func() {
		f.mu.Lock()
		for _, c := range f.conns {
			c.ws.CloseNow()
		}
		f.mu.Unlock()
		f.srv.Close()
	})
	return f
}

func (f *fwdFake) host() string { return f.srv.URL + "/termag" }

var fwdFakePath = regexp.MustCompile(`^/termag/api/cli/v1/boxes/([^/]+)/forward/([^/?]+)$`)

func (f *fwdFake) json(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write([]byte(body))
}

func (f *fwdFake) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/termag/api/cli/v1/boxes":
		f.json(w, 200, `{"boxes":[{"id":"i1","name":"devbox","addressable":true,"kind":"ec2","state":"running","status":"idle","agentConnected":true,"error":null,"projects":[]}]}`)
		return
	case "/termag/api/cli/v1/boxes/i1/forward":
		f.mu.Lock()
		st, body := f.probe.status, f.probe.body
		f.mu.Unlock()
		f.json(w, st, body)
		return
	case "/termag/api/cli/v1/token":
		f.mu.Lock()
		f.refresh++
		tok := fwdJWT(f.signIn, f.refresh)
		f.access[tok] = f.signIn
		f.mu.Unlock()
		f.json(w, 200, fmt.Sprintf(`{"accessToken":%q,"accessTokenExpiresIn":3600,"expiresAt":"2099-01-01T00:00:00.000Z","maxExpiresAt":"2099-01-01T00:00:00.000Z"}`, tok))
		return
	case "/termag/api/cli/v1/usage":
		w.WriteHeader(204)
		return
	}
	m := fwdFakePath.FindStringSubmatch(r.URL.Path)
	if m == nil {
		f.json(w, 404, `{"error":"No such CLI endpoint","code":"not_found"}`)
		return
	}
	port, _ := strconv.Atoi(m[2])
	auth := r.Header.Get("Authorization")
	f.mu.Lock()
	f.dials = append(f.dials, auth)
	signIn, ok := f.access[strings.TrimPrefix(auth, "Bearer ")]
	var action string
	if q := f.queue[port]; len(q) > 0 {
		action, f.queue[port] = q[0], q[1:]
	}
	v1Only := f.v1Only
	behave := f.behave[port]
	f.mu.Unlock()
	if !ok || strings.Contains(r.URL.RawQuery, "token") {
		f.json(w, 401, `{"error":"Unknown token","code":"auth_required"}`)
		return
	}
	if strings.HasPrefix(action, "refuse:") {
		parts := strings.SplitN(action, ":", 4) // refuse:<status>:<code>:<error>
		st, _ := strconv.Atoi(parts[1])
		f.json(w, st, fmt.Sprintf(`{"error":%q,"code":%q}`, parts[3], parts[2]))
		return
	}
	protos := []string{fwdSubprotocolV2, fwdSubprotocolV1}
	if v1Only {
		protos = []string{fwdSubprotocolV1}
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: protos, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	ws.SetReadLimit(4 << 20)
	if strings.HasPrefix(action, "closeAfterOpen:") {
		code, _ := strconv.Atoi(strings.TrimPrefix(action, "closeAfterOpen:"))
		ws.Close(websocket.StatusCode(code), "")
		return
	}
	conn := &fwdFakeConn{port: port, protocol: ws.Subprotocol(), ws: ws}
	f.mu.Lock()
	f.conns = append(f.conns, conn)
	f.mu.Unlock()
	if strings.HasPrefix(action, "closeAfterFirstFrame:") {
		// The draining shape: one frame of the request reaches the box, then the orchestrator closes.
		code, _ := strconv.Atoi(strings.TrimPrefix(action, "closeAfterFirstFrame:"))
		if _, data, err := ws.Read(context.Background()); err == nil {
			f.mu.Lock()
			conn.received += len(data)
			f.mu.Unlock()
		}
		ws.Close(websocket.StatusCode(code), "")
		f.mu.Lock()
		conn.closeCode = code
		f.mu.Unlock()
		return
	}
	f.box(conn, signIn, behave)
}

func (f *fwdFake) box(conn *fwdFakeConn, signIn, behave string) {
	ws := conn.ws
	ctx := context.Background()
	if behave == "firehose" {
		go func() {
			chunk := make([]byte, 64*1024)
			for i := range chunk {
				chunk[i] = 7
			}
			for {
				f.mu.Lock()
				n := f.total - conn.sent
				f.mu.Unlock()
				if n <= 0 {
					break
				}
				if n > len(chunk) {
					n = len(chunk)
				}
				if ws.Write(ctx, websocket.MessageBinary, chunk[:n]) != nil {
					return
				}
				f.mu.Lock()
				conn.sent += n
				f.mu.Unlock()
			}
			ws.Write(ctx, websocket.MessageText, []byte(fwdFin))
		}()
	}
	for {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			f.mu.Lock()
			conn.closeCode = int(websocket.CloseStatus(err))
			f.mu.Unlock()
			return
		}
		if typ == websocket.MessageText {
			if string(data) != fwdFin {
				var msg struct {
					T     string `json:"t"`
					Token string `json:"token"`
				}
				_ = json.Unmarshal(data, &msg)
				f.mu.Lock()
				if conn.protocol == fwdSubprotocolV2 && msg.T == "token" {
					conn.tokens = append(conn.tokens, msg.Token)
					refuse := f.access[msg.Token] != signIn
					f.mu.Unlock()
					if refuse {
						ws.Close(4406, "Renewed access token refused")
						return
					}
				} else {
					conn.stray = append(conn.stray, string(data))
					f.mu.Unlock()
				}
				continue
			}
			f.mu.Lock()
			conn.gotFin = true
			f.mu.Unlock()
			if behave == "" || behave == "echo" {
				ws.Write(ctx, websocket.MessageText, []byte(fwdFin))
			}
			continue
		}
		f.mu.Lock()
		conn.received += len(data)
		f.mu.Unlock()
		if behave == "" || behave == "echo" {
			if ws.Write(ctx, websocket.MessageBinary, data) != nil {
				return
			}
		}
	}
}

// fwdLoginHome writes a device sign-in for the fake into a scratch XDG_CONFIG_HOME.
func fwdLoginHome(t *testing.T, f *fwdFake) (home, xdg string) {
	home = t.TempDir()
	xdg = filepath.Join(home, "xdg")
	l := newStoredLogin("tmcli_devicetokendevicetoken", fwdJWT("dev1", 0), isoString(time.Now().Add(time.Hour)), "laptop", "a@b.c", "ab", "2099-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z")
	path := CredentialsPath(map[string]string{"XDG_CONFIG_HOME": xdg}, home)
	if err := SaveLogin(path, f.host(), l); err != nil {
		t.Fatal(err)
	}
	fwdLoginPaths.Store(f, path)
	return home, xdg
}

func (f *fwdFake) snapshot() []fwdFakeConn {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]fwdFakeConn, len(f.conns))
	for i, c := range f.conns {
		out[i] = *c
	}
	return out
}

var _ = os.Getenv
