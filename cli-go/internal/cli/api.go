package cli

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"
)

const apiPrefix = "/api/cli/v1"
const defaultTimeout = 15 * time.Second

// RequestCancelled is the message of a request its caller's context ended (a Ctrl-C).
const RequestCancelled = "Cancelled"

// Version is the CLI's version, stamped at build time (-ldflags "-X …/cli.Version=…"; see the README).
var Version = "0.1.0+unknown"

// BearerSource is asked for the bearer before every request; rejected is the one the orchestrator
// just answered 401 to (a source that can refresh returns a new one).
type BearerSource func(ctx context.Context, rejected string, validFor time.Duration) (string, error)

// Api is the client for the orchestrator's /api/cli/v1 (api.ts).
type Api struct {
	Host    string
	Token   string       // a fixed bearer, or ""
	Source  BearerSource // asked before every request when set
	Client  *http.Client
	Timeout time.Duration
}

// cliRequest is the URL, headers and body of a request to the CLI API.
type cliRequest struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Body    *string           `json:"body,omitempty"`
}

func newCLIRequest(host, method, path string, body any, token string) (cliRequest, error) {
	h := map[string]string{"Accept": "application/json", "User-Agent": "termag-cli/" + Version}
	if token != "" {
		h["Authorization"] = "Bearer " + token
	}
	r := cliRequest{URL: host + apiPrefix + path, Method: method, Headers: h}
	if body != nil {
		h["Content-Type"] = "application/json"
		s := CompactJSON(body)
		r.Body = &s
	}
	return r, nil
}

type rawResponse struct {
	status  int
	headers http.Header
	text    []byte
}

// Request sends one request and decodes a JSON answer into out (which may be nil). ctx ends it at
// once with RequestCancelled, on top of the client's own timeout, which covers the body too.
func (a *Api) Request(ctx context.Context, method, path string, body any, out any) error {
	raw, err := a.RequestRaw(ctx, method, path, body)
	if err != nil {
		return err
	}
	if out != nil && raw != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return newErr("failed", fmt.Sprintf("%s answered something unexpected: %v", a.Host, err))
		}
	}
	return nil
}

// RequestRaw is Request returning the answer's JSON as sent (nil for a 204).
func (a *Api) RequestRaw(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	token := a.Token
	if a.Source != nil {
		t, err := a.Source(ctx, "", 0)
		if err != nil {
			return nil, err
		}
		token = t
	}
	res, err := a.send(ctx, method, path, body, token)
	if err != nil {
		return nil, err
	}
	// A 401 to an access token whose clock says it's good (its key was retired): one refresh, one retry.
	if res.status == 401 && a.Source != nil && token != "" {
		again, err := a.Source(ctx, token, 0)
		if err != nil {
			return nil, err
		}
		if again != "" && again != token {
			if res, err = a.send(ctx, method, path, body, again); err != nil {
				return nil, err
			}
		}
	}
	return a.decode(res)
}

func (a *Api) client() *http.Client {
	if a.Client != nil {
		return a.Client
	}
	return newHTTPClient(nil)
}

func (a *Api) send(parent context.Context, method, path string, body any, token string) (*rawResponse, error) {
	if parent.Err() != nil {
		return nil, newErr("failed", RequestCancelled)
	}
	req, _ := newCLIRequest(a.Host, method, path, body, token)
	timeout := a.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	var rd io.Reader
	if req.Body != nil {
		rd = strings.NewReader(*req.Body)
	}
	hr, err := http.NewRequestWithContext(ctx, method, req.URL, rd)
	if err != nil {
		return nil, newErr("unreachable", fmt.Sprintf("Can't reach the orchestrator at %s (%s)", a.Host, err.Error()))
	}
	for k, v := range req.Headers {
		hr.Header.Set(k, v)
	}
	res, err := a.client().Do(hr)
	if err == nil {
		defer res.Body.Close()
		var text []byte
		// A 204's body, and a redirect's, is never read.
		if res.StatusCode != 204 && !(res.StatusCode >= 300 && res.StatusCode < 400) {
			text, err = io.ReadAll(res.Body)
		}
		if err == nil {
			return &rawResponse{status: res.StatusCode, headers: res.Header, text: text}, nil
		}
	}
	if parent.Err() != nil {
		return nil, newErr("failed", RequestCancelled)
	}
	if ctx.Err() != nil {
		return nil, newErr("timeout", "Timed out waiting for the orchestrator at "+a.Host)
	}
	return nil, newErr("unreachable", fmt.Sprintf("Can't reach the orchestrator at %s (%s)", a.Host, netErrorCode(err)))
}

// netErrorCode names a network failure as undici's cause.code would.
func netErrorCode(err error) string {
	var dns *net.DNSError
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return "ECONNREFUSED"
	case errors.Is(err, syscall.ECONNRESET):
		return "ECONNRESET"
	case errors.Is(err, syscall.EHOSTUNREACH):
		return "EHOSTUNREACH"
	case errors.Is(err, syscall.ENETUNREACH):
		return "ENETUNREACH"
	case errors.Is(err, syscall.ETIMEDOUT):
		return "ETIMEDOUT"
	case errors.As(err, &dns):
		if dns.IsNotFound {
			return "ENOTFOUND"
		}
		return "EAI_AGAIN"
	}
	var unknownCA x509.UnknownAuthorityError
	var hostErr x509.HostnameError
	var invalid x509.CertificateInvalidError
	switch {
	case errors.As(err, &unknownCA):
		return "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
	case errors.As(err, &hostErr):
		return "ERR_TLS_CERT_ALTNAME_INVALID"
	case errors.As(err, &invalid):
		if invalid.Reason == x509.Expired {
			return "CERT_HAS_EXPIRED"
		}
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err.Error()
	}
	return err.Error()
}

func (a *Api) decode(res *rawResponse) (json.RawMessage, error) {
	st := res.status
	if st >= 300 && st < 400 {
		where := ""
		if u, err := url.Parse(res.headers.Get("Location")); err == nil && u.Host != "" {
			_, h, _, _, ok := whatwgOrigin(u.String())
			if ok {
				where = " to " + h
			}
		}
		return nil, &CliError{Code: "edge_auth", Status: st,
			Message: fmt.Sprintf("%s redirected the CLI%s for a browser sign-in: its edge does not let the CLI API through yet", a.Host, where)}
	}
	if st == 204 {
		return nil, nil
	}
	isJSON := strings.Contains(res.headers.Get("Content-Type"), "application/json")
	var data map[string]any
	var raw json.RawMessage
	if isJSON && len(res.text) > 0 {
		trimmed := bytes.TrimSpace(res.text)
		if json.Valid(trimmed) {
			raw = trimmed
			if err := json.Unmarshal(trimmed, &data); err != nil {
				data = nil
				// A JSON array or scalar is still an answer (JS: data is truthy).
				if !bytes.Equal(trimmed, []byte("null")) && !bytes.Equal(trimmed, []byte("false")) && !bytes.Equal(trimmed, []byte("0")) && !bytes.Equal(trimmed, []byte(`""`)) {
					data = map[string]any{}
				}
			}
		}
	}
	if data == nil && st == 401 {
		return nil, &CliError{Code: "auth_required", Status: st, Message: fmt.Sprintf("%s refused the CLI's credential; run `termag login`", a.Host)}
	}
	if data == nil && (st == 502 || st == 503 || st == 504) {
		return nil, &CliError{Code: "unreachable", Status: st, Message: fmt.Sprintf("%s is not answering right now (HTTP %d); the orchestrator may be restarting", a.Host, st)}
	}
	if data == nil {
		return nil, &CliError{Code: "not_cli_enabled", Status: st, Message: fmt.Sprintf("%s did not answer as a termag orchestrator with the CLI API (HTTP %d); it may predate the CLI", a.Host, st)}
	}
	if st >= 200 && st < 300 {
		return raw, nil
	}
	msg, ok := data["error"].(string)
	if !ok {
		msg = fmt.Sprintf("HTTP %d", st)
	}
	code, _ := data["code"].(string)
	e := &CliError{Status: st, Message: msg, Body: data, RawBody: raw}
	switch {
	case st == 401 || code == "invalid_grant":
		e.Code = "auth_required"
	case st == 404:
		e.Code = "not_found"
	case st == 400:
		e.Code = "usage"
	case st == 403:
		e.Code = "forbidden"
	case code == "github-required":
		e.Code = "precondition"
	case st == 409:
		e.Code = "conflict"
	case st == 412:
		e.Code = "changed"
	default:
		e.Code = "failed"
	}
	return nil, e
}
