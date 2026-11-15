package cli

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/net/http/httpproxy"
)

// Ctx is everything a command touches outside its own logic, so tests can swap it (context.ts).
type Ctx struct {
	Env      map[string]string
	Home     string
	Hostname string
	// A person at a terminal: stdin is a TTY and CI is unset. Never prompt or open a browser otherwise.
	Interactive bool
	StderrIsTTY bool
	Platform    string
	Out         func(text string)
	Err         func(text string)
	HTTP        *http.Client
	// ReadFile returns nil, false for a file that can't be read.
	ReadFile    func(path string) ([]byte, bool)
	Stdin       io.Reader
	OpenBrowser func(url string)
	Now         func() time.Time
	// PostInBackground sends a request from a detached process and returns at once; nil: the caller sends it.
	PostInBackground func(req BackgroundRequest)
	// Confirm asks a yes/no question on the terminal; only called when Interactive.
	Confirm func(question string) bool
	// Node runs the Node CLI with these arguments as a child with this terminal (login's doctor).
	// It returns the exit code and, when capture is set, stdout.
	Node func(args []string, capture bool) (int, string, error)
	// Sleep waits (tests make it instant).
	Sleep        func(d time.Duration)
	LoginTimeout time.Duration
	PollInterval time.Duration
	AskRetryFor  time.Duration
	NewMessageID func() string
	Cwd          func() string
	// OutGone is closed once stdout's reader has gone (EPIPE); nil when unknown.
	OutGone  <-chan struct{}
	requests *int64Counter
}

// Getenv is process.env[k] ?? "".
func (c *Ctx) Getenv(k string) string { return c.Env[k] }

type int64Counter struct {
	mu sync.Mutex
	n  int
}

func (c *int64Counter) add() { c.mu.Lock(); c.n++; c.mu.Unlock() }
func (c *int64Counter) get() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

// countingTransport counts the requests a run makes (usage.ts countRequests).
type countingTransport struct {
	inner   http.RoundTripper
	counter *int64Counter
}

func (t *countingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	t.counter.add()
	return t.inner.RoundTrip(r)
}

// LineWriter is context.ts's lineWriter: lines that survive the reader going away (`| head -1`).
// After an EPIPE it stops writing, and the command carries on to its own exit code.
func LineWriter(w io.Writer) func(string) {
	write, _ := lineWriterGone(w)
	return write
}

// lineWriterGone is LineWriter, and a channel closed once its reader has gone (`termag events` ends then).
func lineWriterGone(w io.Writer) (func(string), <-chan struct{}) {
	var mu sync.Mutex
	gone := false
	goneCh := make(chan struct{})
	return func(text string) {
		mu.Lock()
		defer mu.Unlock()
		if gone {
			return
		}
		if !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		if _, err := io.WriteString(w, text); err != nil {
			if errors.Is(err, syscall.EPIPE) {
				gone = true
				close(goneCh)
				return
			}
			panic(err)
		}
	}, goneCh
}

func environMap() map[string]string {
	env := os.Environ()
	m := make(map[string]string, len(env))
	for _, kv := range env {
		if i := strings.IndexByte(kv, '='); i > 0 {
			if _, dup := m[kv[:i]]; !dup {
				m[kv[:i]] = kv[i+1:]
			}
		}
	}
	return m
}

// newHTTPClient: no redirects followed (a 3xx is the edge asking for a browser sign-in), as fetch's
// redirect: 'manual'. HTTP_PROXY, HTTPS_PROXY and NO_PROXY are honoured (read when the client is made;
// loopback is never proxied). That is a deliberate change from the Node CLI, whose fetch ignores
// them (rollout decision 2026-11-12). The WebSocket dials (wsdial.go) use this transport too.
func newHTTPClient(counter *int64Counter) *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	proxy := httpproxy.FromEnvironment().ProxyFunc()
	tr.Proxy = func(r *http.Request) (*url.URL, error) { return proxy(r.URL) }
	var rt http.RoundTripper = tr
	if counter != nil {
		rt = &countingTransport{inner: tr, counter: counter}
	}
	return &http.Client{
		Transport:     rt,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func openBrowser(url string) {
	var cmd string
	switch runtime.GOOS {
	case "darwin":
		cmd = "open"
	case "linux":
		cmd = "xdg-open"
	default:
		return
	}
	c := exec.Command(cmd, url)
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if c.Start() == nil {
		_ = c.Process.Release()
	}
}

// DefaultCtx is context.ts's defaultCtx.
func DefaultCtx() *Ctx {
	env := environMap()
	home, _ := os.UserHomeDir()
	if h := env["HOME"]; h != "" {
		home = h
	}
	host, _ := os.Hostname()
	counter := &int64Counter{}
	ctx := &Ctx{
		Env:         env,
		Home:        home,
		Hostname:    host,
		Interactive: isatty(os.Stdin.Fd()) && env["CI"] == "",
		StderrIsTTY: isatty(os.Stderr.Fd()) && env["CI"] == "",
		Platform:    runtime.GOOS,
		Out:         nil, // below, with OutGone
		Err:         LineWriter(os.Stderr),
		HTTP:        newHTTPClient(counter),
		ReadFile: func(p string) ([]byte, bool) {
			b, err := os.ReadFile(p)
			return b, err == nil
		},
		Stdin:            os.Stdin,
		OpenBrowser:      openBrowser,
		Now:              time.Now,
		PostInBackground: postInBackground,
		Confirm:          confirmOnTerminal,
		Node:             runNodeChild,
		Sleep:            time.Sleep,
		Cwd: func() string {
			d, _ := os.Getwd()
			return d
		},
		requests: counter,
	}
	ctx.Out, ctx.OutGone = lineWriterGone(os.Stdout)
	return ctx
}

// confirmOnTerminal asks on stderr and reads one line from stdin.
func confirmOnTerminal(question string) bool {
	os.Stderr.WriteString(question)
	var line []byte
	buf := make([]byte, 1)
	for {
		n, err := os.Stdin.Read(buf)
		if n > 0 {
			if buf[0] == '\n' {
				break
			}
			line = append(line, buf[0])
		}
		if err != nil {
			break
		}
	}
	a := strings.ToLower(strings.TrimSpace(string(line)))
	return a == "y" || a == "yes"
}

func (c *Ctx) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *Ctx) sleep(d time.Duration) {
	if c.Sleep != nil {
		c.Sleep(d)
		return
	}
	time.Sleep(d)
}

func (c *Ctx) requestCount() int {
	if c.requests == nil {
		return -1
	}
	return c.requests.get()
}
