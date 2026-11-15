package cli

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const loginTimeout = 5 * time.Minute

func randomB64URL(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func pkcePair() (verifier, challenge string) {
	verifier = randomB64URL(32)
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

var (
	deviceBadChars = regexp.MustCompile(`[^A-Za-z0-9._ -]`)
	deviceLeading  = regexp.MustCompile(`^[^A-Za-z0-9]+`)
)

// deviceNameFrom is login.ts's: os.hostname() made acceptable to the orchestrator. termag-desktop
// revokes on sign-out only a "<host> desktop" login, so the CLI's must stay the plain cleaned hostname.
func deviceNameFrom(hostname string) string {
	cleaned := deviceLeading.ReplaceAllString(deviceBadChars.ReplaceAllString(hostname, "-"), "")
	if u := []rune(cleaned); len(u) > 64 { // the cleaned name is ASCII, so runes are UTF-16 units
		cleaned = string(u[:64])
	}
	cleaned = strings.TrimSpace(cleaned)
	if cleaned == "" {
		return "device"
	}
	return cleaned
}

func authorizeURL(host string, port int, state, challenge, deviceName string) string {
	// URLSearchParams keeps insertion order and encodes a space as +.
	q := []string{
		"port=" + url.QueryEscape(fmt.Sprint(port)),
		"state=" + url.QueryEscape(state),
		"code_challenge=" + url.QueryEscape(challenge),
		"code_challenge_method=S256",
		"device_name=" + url.QueryEscape(deviceName),
	}
	return host + "/auth/cli/authorize?" + strings.Join(q, "&")
}

func loginPage(title, message string) string {
	return `<!doctype html><meta charset="utf-8"><title>` + title + `</title>` +
		`<body style="font-family:system-ui,sans-serif;background:#0b0e14;color:#e6e6e6;padding:12vh 2rem;text-align:center">` +
		`<h1 style="font-size:1.25rem">` + title + `</h1><p>` + message + `</p></body>`
}

type callbackResult struct {
	code string
	err  error
}

// listenForCallback listens on 127.0.0.1 for the browser's redirect; only a callback carrying our
// state settles it.
func listenForCallback(state string) (port int, result <-chan callbackResult, closeFn func(), err error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, nil, nil, err
	}
	ch := make(chan callbackResult, 1)
	settle := func(r callbackResult) {
		select {
		case ch <- r:
		default:
		}
	}
	write := func(w http.ResponseWriter, status int, title, msg string) {
		h := w.Header()
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
		h.Set("Cache-Control", "no-store")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(loginPage(title, msg)))
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		switch {
		case r.Method != "GET" || r.URL.Path != "/callback":
			write(w, 404, "Not found", "This is the termag CLI sign-in listener.")
		case q.Get("state") != state:
			write(w, 400, "Sign-in link mismatch", "This approval was for a different sign-in link than the one termag login is waiting for. Open the link termag login printed most recently, without editing it.")
		case q.Get("error") == "not_allowed":
			write(w, 200, "No access to termag yet", "This account doesn't have access to termag yet. Ask a termag admin to add it, then run termag login again.")
			settle(callbackResult{err: newErr("auth_required", "This account doesn't have access to termag yet. Ask a termag admin to add it, then run termag login again")})
		case q.Get("error") != "":
			write(w, 200, "Sign-in cancelled", "The termag CLI was not signed in. You can close this tab.")
			settle(callbackResult{err: newErr("auth_required", "Sign-in was cancelled in the browser")})
		case q.Get("code") == "":
			write(w, 400, "Missing code", "Run termag login again.")
		default:
			write(w, 200, "termag CLI signed in", "You can close this tab and return to your terminal.")
			settle(callbackResult{code: q.Get("code")})
		}
	})}
	go func() { _ = srv.Serve(ln) }()
	return ln.Addr().(*net.TCPAddr).Port, ch, func() { _ = srv.Close() }, nil
}

type tokenResponse struct {
	Token                string   `json:"token"`
	AccessToken          string   `json:"accessToken"`
	AccessTokenExpiresIn float64  `json:"accessTokenExpiresIn"`
	DeviceName           string   `json:"deviceName"`
	User                 userView `json:"user"`
	ExpiresAt            string   `json:"expiresAt"`
	MaxExpiresAt         string   `json:"maxExpiresAt"`
}

func browserLogin(c *Ctx, host, deviceName, boxToken string) (*tokenResponse, error) {
	state := randomB64URL(16)
	verifier, challenge := pkcePair()
	port, result, closeFn, err := listenForCallback(state)
	if err != nil {
		return nil, newErr("failed", err.Error())
	}
	defer closeFn()
	u := authorizeURL(host, port, state, challenge, deviceName)
	c.Err("Opening your browser to sign in. If it does not open, visit:")
	c.Err("  " + u)
	c.OpenBrowser(u)
	timeout := c.LoginTimeout
	if timeout == 0 {
		timeout = loginTimeout
	}
	var code string
	select {
	case r := <-result:
		if r.err != nil {
			return nil, r.err
		}
		code = r.code
	case <-time.After(timeout):
		// An ALB/identity-provider failure never reaches the loopback listener.
		// A timeout alone cannot tell us what the browser showed.
		c.Err(fmt.Sprintf("Open %s and check that web sign-in works.", host))
		return nil, newErr("timeout", "Timed out waiting for the browser sign-in. Once web sign-in works, run `termag login` again and approve the new link.")
	}
	body := newObject().Set("grant_type", "authorization_code").Set("code", code).Set("code_verifier", verifier)
	if boxToken != "" {
		body.Set("box_token", boxToken)
	}
	var tok tokenResponse
	if err := (&Api{Host: host, Client: c.HTTP}).Request(context.Background(), "POST", "/token", body, &tok); err != nil {
		return nil, err
	}
	return &tok, nil
}

// runDoctor runs the Node CLI's doctor after a sign-in, as login.ts does (doctor is not ported
// yet). With --json it returns doctor's JSON for login's own; without, doctor prints and offers fixes.
func runDoctor(c *Ctx, a *ParsedArgs) json.RawMessage {
	args := []string{"doctor"}
	if a.Host != nil {
		args = append(args, "--host", *a.Host)
	}
	if a.JSON {
		args = append(args, "--json")
	} else if a.Yes {
		args = append(args, "--yes")
	}
	if c.Node == nil {
		return json.RawMessage("null")
	}
	_, out, err := c.Node(args, a.JSON)
	if err != nil {
		c.Err("termag: " + err.Error())
		return json.RawMessage("null")
	}
	if a.JSON {
		out = strings.TrimSpace(out)
		if json.Valid([]byte(out)) {
			return json.RawMessage(out)
		}
		return json.RawMessage("null")
	}
	return nil
}

func cmdLogin(c *Ctx, a *ParsedArgs) (int, error) {
	s, err := newSession(c, a)
	if err != nil {
		return 0, err
	}
	device, hasDevice := a.Str("device")
	if s.Target.Box != nil && !hasDevice {
		w, err := getWhoami(&Api{Host: s.Target.Host, Token: s.Target.Box.Token, Client: c.HTTP})
		if err != nil {
			return 0, err
		}
		if !a.JSON {
			c.Out(fmt.Sprintf("On this box termag uses the box's own credentials: signed in to %s as %s.", s.Target.Host, w.User.Email))
			c.Out("")
		}
		doctor := runDoctor(c, a)
		if a.JSON {
			o := withHost(s.Target.Host, w.raw)
			o.Set("doctor", doctor)
			c.Out(JSONText(o))
		}
		return ExitOK, nil
	}
	if !c.Interactive {
		return 0, newErr("auth_required", fmt.Sprintf("Not signed in to %s; `termag login` needs a person at a terminal", s.Target.Host))
	}
	name := c.Hostname
	if hasDevice {
		name = device
	}
	boxToken := ""
	if s.Target.Box != nil {
		boxToken = s.Target.Box.Token
	}
	tok, err := browserLogin(c, s.Target.Host, deviceNameFrom(name), boxToken)
	if err != nil {
		return 0, err
	}
	login := newStoredLogin(tok.Token, tok.AccessToken, expiresAtFrom(c.now(), tok.AccessTokenExpiresIn), tok.DeviceName,
		tok.User.Email, tok.User.UnixUsername, tok.ExpiresAt, tok.MaxExpiresAt)
	if err := SaveLogin(s.CredsPath, s.Target.Host, login); err != nil {
		return 0, newErr("failed", err.Error())
	}
	if !a.JSON {
		c.Out(fmt.Sprintf("Signed in to %s as %s on \"%s\".", s.Target.Host, tok.User.Email, tok.DeviceName))
		c.Out(fmt.Sprintf("Stays signed in while used at least weekly, until %s at the latest.", FormatDate(tok.MaxExpiresAt)))
		c.Out("")
	}
	doctor := runDoctor(c, a)
	if a.JSON {
		c.Out(JSONText(newObject().Set("host", s.Target.Host).Set("user", tok.User).Set("deviceName", tok.DeviceName).
			Set("expiresAt", tok.ExpiresAt).Set("maxExpiresAt", tok.MaxExpiresAt).Set("doctor", doctor)))
	}
	return ExitOK, nil
}
