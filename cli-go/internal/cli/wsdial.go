package cli

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// The WebSocket dialer events and forward share (Node: the `ws` package). Like the API client it
// follows no redirects (a 3xx is the edge asking for a browser sign-in) and, unlike Node, it
// honours HTTP(S)_PROXY / NO_PROXY (rollout decision 2026-11-12): the dial goes through
// newHTTPClient's transport.

const wsHandshakeTimeout = 30 * time.Second
const wsMaxRefusalBody = 16 * 1024

// wsURL turns `<host><API_PREFIX><path>` into its ws:// or wss:// URL.
func wsURL(host, path string) string {
	u, err := url.Parse(host + apiPrefix + path)
	if err != nil {
		return host + apiPrefix + path
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	return u.String()
}

// wsDialResult is an open socket, or the HTTP answer that came instead of the upgrade, or no answer.
type wsDialResult struct {
	Conn *websocket.Conn
	// Status and Body are set when the server answered without upgrading.
	Status int
	Body   []byte
	Header http.Header
	// Err is set when there was no answer at all (unreachable, timed out, aborted).
	Err error
}

// wsDial opens one socket with the bearer in the Authorization header, offering subprotocols in order.
func wsDial(ctx context.Context, c *Ctx, rawURL, token string, subprotocols []string) wsDialResult {
	dctx, cancel := context.WithTimeout(ctx, wsHandshakeTimeout)
	defer cancel()
	h := http.Header{}
	h.Set("User-Agent", "termag-cli/"+Version)
	if token != "" {
		h.Set("Authorization", "Bearer "+token)
	}
	client := c.HTTP
	if client == nil {
		client = newHTTPClient(nil)
	}
	conn, res, err := websocket.Dial(dctx, rawURL, &websocket.DialOptions{
		HTTPClient:      client,
		HTTPHeader:      h,
		Subprotocols:    subprotocols,
		CompressionMode: websocket.CompressionDisabled,
	})
	if err == nil {
		conn.SetReadLimit(1024 * 1024)
		return wsDialResult{Conn: conn}
	}
	if res != nil && res.StatusCode != http.StatusSwitchingProtocols && res.StatusCode != 0 {
		var body []byte
		if res.Body != nil {
			body, _ = io.ReadAll(io.LimitReader(res.Body, wsMaxRefusalBody))
			res.Body.Close()
		}
		return wsDialResult{Status: res.StatusCode, Body: body, Header: res.Header}
	}
	return wsDialResult{Err: err}
}

// wsErrorReason names a dial that got no answer, as `ws`'s error code would (ECONNREFUSED, …).
func wsErrorReason(err error) string {
	if err == nil {
		return "closed"
	}
	if strings.Contains(err.Error(), "context deadline exceeded") {
		return "ETIMEDOUT"
	}
	if strings.Contains(err.Error(), "context canceled") {
		return "aborted"
	}
	return netErrorCode(err)
}
