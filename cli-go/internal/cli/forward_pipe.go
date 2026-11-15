package cli

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// forward/pipe.ts: one accepted TCP connection relayed over an open forward socket, both ways.
//
// Who does what (the state machine; Node's pipe.ts behaves the same unless noted):
//   - upstream reads TCP and writes the WebSocket; the TCP side is read only once the previous
//     WebSocket write has returned, so upload backpressure is the box's (Node: bufferedAmount marks).
//   - downstream reads the WebSocket into fwdDownQueue; downWriter writes it to TCP. A slow or
//     stalled local reader fills the queue; at fwdDownHigh downstream stops reading the socket
//     (Node's ws.pause(), which pauses the socket, control frames included) until fwdDownLow.
//   - pinger pings every fwdPingEvery whatever the read side is doing: writes never wait for
//     reads, so the orchestrator's heartbeat hears this end while it is paused, as from Node.
//   - remote 1000: queued bytes are flushed, then FIN; a reader that takes nothing for
//     fwdFlushStall loses the rest and gets a reset (Node waits without a bound).
//   - remote other code, or a dropped socket (1006, a heartbeat's terminate): queue dropped and
//     the local socket reset at once, as resetAndDestroy; an untouched one goes to a redial.
//   - local EOF: {"t":"fin"}; local error or reset: close 1011 (1000 once both fins passed).
//   - Ctrl-C (Stop): close 1000, and after the grace the socket and TCP are cut.

const (
	fwdMaxFrame      = 64 * 1024
	fwdFirstFrame    = 4 * 1024
	fwdFrameRampIdle = 200 * time.Millisecond
	fwdFin           = `{"t":"fin"}`
	fwdPingEvery     = 10 * time.Second
)

type fwdPipeResult struct {
	Code     int
	Up, Down int64
	ClosedBy string // local or remote
	// Untouched: closed before a byte moved and keepIfUntouched said so: the TCP connection stays
	// open for another dial, with Pending, any bytes already read from it, to send first.
	Untouched bool
	Pending   []byte
}

type fwdPipeOpts struct {
	keepIfUntouched func(code int) bool
	onBytes         func(up, down int)
	pingEvery       time.Duration
	pending         []byte // bytes read from the TCP side by an earlier, untouched dial
}

type fwdPipe struct {
	tcp  *net.TCPConn
	ws   *websocket.Conn
	opts fwdPipeOpts

	mu            sync.Mutex
	up, down      int64
	sentFin       bool
	gotFin        bool
	wsClosed      int // 0: open
	closeSent     int // the code this end closed with, 0 if none
	closeOK       bool
	closing       bool
	remoteClosing bool // the read side has seen the socket close; wsClosed follows in onWsClose
	socketClosed  bool
	closedBy      string
	untouched     bool
	pending       []byte
	upDone        chan struct{}
	done          chan fwdPipeResult
	settled       bool
	stopPing      chan struct{}
	// heard closes once the read side has had its first message or close (see upstream).
	heard     chan struct{}
	heardOnce sync.Once
}

// fwdFirstSendHold: on a dial that may be redialed untouched, the first bytes wait this long for
// a close that came with the upgrade (a draining orchestrator's 1012). Node sees such a close
// before the socket's first data event, as both arrive in one read; here the reader is another
// goroutine, so the first send gives it this moment to see it.
const fwdFirstSendHold = 3 * time.Millisecond

func fwdStartPipe(tcp *net.TCPConn, ws *websocket.Conn, opts fwdPipeOpts) *fwdPipe {
	if opts.pingEvery == 0 {
		opts.pingEvery = fwdPingEvery
	}
	p := &fwdPipe{tcp: tcp, ws: ws, opts: opts, upDone: make(chan struct{}), done: make(chan fwdPipeResult, 1), stopPing: make(chan struct{}), heard: make(chan struct{})}
	go p.pinger()
	go p.downstream()
	go p.upstream()
	return p
}

// Done delivers the result once both ends are closed (or the TCP side is handed back).
func (p *fwdPipe) Done() <-chan fwdPipeResult { return p.done }

func (p *fwdPipe) pinger() {
	t := time.NewTicker(p.opts.pingEvery)
	defer t.Stop()
	for {
		select {
		case <-p.stopPing:
			return
		case <-t.C:
			// In a goroutine: a ping waits for its pong, which the downstream reader takes in. The
			// ping itself goes out at once even while that reader is paused at fwdDownHigh, and it
			// is the ping, not the pong, that keeps the orchestrator's heartbeat satisfied.
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), p.opts.pingEvery)
				defer cancel()
				_ = p.ws.Ping(ctx)
			}()
		}
	}
}

func (p *fwdPipe) wsOpen() bool { return p.wsClosed == 0 && !p.closing && !p.remoteClosing }

// closeWs starts this end's close (once); the read side then sees the close and settles.
func (p *fwdPipe) closeWs(code int) {
	p.mu.Lock()
	if p.closing || p.wsClosed != 0 {
		p.mu.Unlock()
		return
	}
	p.closing = true
	p.closeSent = code
	p.mu.Unlock()
	go func() {
		err := p.ws.Close(websocket.StatusCode(code), "")
		p.mu.Lock()
		p.closeOK = err == nil
		p.mu.Unlock()
	}()
}

// Downstream bytes queue between the WebSocket and the local TCP side, so the socket keeps being
// read (and its pings answered, our pings' pongs taken) while a slow local reader holds up a TCP
// write. Like Node's pause and resume on the socket, reading stops once fwdDownHigh is queued and
// starts again at fwdDownLow: backpressure still reaches the box, only later and in step with Node.
const (
	fwdDownHigh = 1 << 20
	fwdDownLow  = 256 << 10
)

type fwdDownItem struct {
	data []byte
	fin  bool
}

type fwdDownQueue struct {
	mu       sync.Mutex
	cond     *sync.Cond
	items    []fwdDownItem
	bytes    int
	paused   bool
	closed   bool // no more items: the socket closed with 1000 and what is queued is flushed
	dead     bool // drop everything: the TCP side is gone, or the socket closed with another code
	draining bool // closed or dead: the socket's close is being acted on, so a write error ends the flush, not the connection
}

func newFwdDownQueue() *fwdDownQueue {
	q := &fwdDownQueue{}
	q.cond = sync.NewCond(&q.mu)
	return q
}

// put waits while the queue is over its high-water mark (until it drains to the low one). While it
// waits nothing reads the socket, as with Node's ws.pause(), which pauses the socket itself; the
// connection stays alive on the pings this end sends (pinger), which the orchestrator's heartbeat
// counts whatever its own pings wait behind (backend agentTunnels.ts tunnelHeartbeat).
func (q *fwdDownQueue) put(it fwdDownItem) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for q.paused && !q.dead {
		q.cond.Wait()
	}
	if q.dead {
		return
	}
	q.items = append(q.items, it)
	q.bytes += len(it.data)
	if q.bytes >= fwdDownHigh {
		q.paused = true
	}
	q.cond.Broadcast()
}

// take returns the next item, or false once the queue is closed and empty (or dead).
func (q *fwdDownQueue) take() (fwdDownItem, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.items) == 0 && !q.closed && !q.dead {
		q.cond.Wait()
	}
	if q.dead || len(q.items) == 0 {
		return fwdDownItem{}, false
	}
	it := q.items[0]
	q.items = q.items[1:]
	return it, true
}

// written: an item's bytes reached the TCP side.
func (q *fwdDownQueue) written(n int) {
	q.mu.Lock()
	q.bytes -= n
	if q.paused && q.bytes <= fwdDownLow {
		q.paused = false
	}
	q.cond.Broadcast()
	q.mu.Unlock()
}

func (q *fwdDownQueue) isDraining() bool { q.mu.Lock(); defer q.mu.Unlock(); return q.draining }
func (q *fwdDownQueue) isDead() bool     { q.mu.Lock(); defer q.mu.Unlock(); return q.dead }

// close: the socket closed with 1000, flush what is queued. kill: drop it (a reset follows).
func (q *fwdDownQueue) close() {
	q.mu.Lock()
	q.closed, q.draining = true, true
	q.cond.Broadcast()
	q.mu.Unlock()
}
func (q *fwdDownQueue) kill() { q.mu.Lock(); q.dead = true; q.cond.Broadcast(); q.mu.Unlock() }
func (q *fwdDownQueue) killForClose() {
	q.mu.Lock()
	q.dead, q.draining = true, true
	q.cond.Broadcast()
	q.mu.Unlock()
}

// fwdFlushStall bounds the flush after a 1000 close by progress, not by time: it ends only once the
// local reader has taken no byte for this long. Node's flush has no bound at all (socket.end, then
// destroy on finish), so a reader that never reads would hold the connection until Ctrl-C; one that
// reads, however slowly, gets every byte here as in Node. A var so the tests can shorten it.
var fwdFlushStall = 30 * time.Second

// downWriter writes queued bytes to the TCP side in order; a fin half-closes it after them.
func (p *fwdPipe) downWriter(q *fwdDownQueue, done chan struct{}) {
	defer close(done)
	for {
		it, ok := q.take()
		if !ok {
			return
		}
		if it.fin {
			_ = p.tcp.CloseWrite()
			p.finishIfDone()
			continue
		}
		for data := it.data; len(data) > 0; {
			if q.isDraining() {
				// Flushing after a 1000 close: each stretch may take fwdFlushStall, and any byte the
				// reader takes starts a new one (a deadline cuts a write short, with n written).
				_ = p.tcp.SetWriteDeadline(time.Now().Add(fwdFlushStall))
			}
			n, err := p.tcp.Write(data)
			data = data[n:]
			if err == nil {
				break
			}
			if errors.Is(err, os.ErrDeadlineExceeded) && n > 0 && !q.isDead() {
				continue // a slow reader, still reading
			}
			q.kill()
			if q.isDraining() {
				// The socket's close is being acted on (downstream): a stalled flush drops what is
				// left, so the close that follows resets the local socket rather than ending it
				// cleanly; any other error is the local side going, which that close handles too.
				_ = p.tcp.SetLinger(0)
				return
			}
			p.onSocketClose()
			return
		}
		q.written(len(it.data))
	}
}

func (p *fwdPipe) downstream() {
	q := newFwdDownQueue()
	writerDone := make(chan struct{})
	go p.downWriter(q, writerDone)
	for {
		typ, data, err := p.ws.Read(context.Background())
		if err != nil {
			// Marked before heard lets upstream's first send go, so that send sees the socket
			// closing and keeps its bytes for a redial. (coder/websocket refuses a write after
			// a close it has read anyway, as it has answered it: this does not rest on that.)
			p.mu.Lock()
			p.remoteClosing = true
			p.mu.Unlock()
		}
		p.heardOnce.Do(func() { close(p.heard) })
		if err != nil {
			code := int(websocket.CloseStatus(err))
			p.mu.Lock()
			if code == -1 && p.closeSent != 0 {
				code = p.closeSent // our close, completed: the peer answered it
			}
			if code == -1 {
				code = 1006
			}
			p.mu.Unlock()
			if code == fwdCloseNormal {
				// As Node's socket.end() on a 1000: everything queued reaches the local reader
				// first, for as long as it keeps reading (fwdFlushStall bounds a reader that
				// stops). The deadline also cuts short a write already blocked when the close came.
				q.close()
				_ = p.tcp.SetWriteDeadline(time.Now().Add(fwdFlushStall))
				<-writerDone
				p.onWsClose(code)
				return
			}
			// Any other close resets the local socket at once, as Node's resetAndDestroy, which
			// discards what the socket has not written: a flush before a reset would be thrown
			// away by the reader's ECONNRESET anyway. A write in flight is cut short first, so
			// the reset closes a socket nothing is writing (closed under a blocked write, macOS
			// never sent the reader the reset).
			q.killForClose()
			_ = p.tcp.SetWriteDeadline(time.Now())
			<-writerDone
			p.onWsClose(code)
			return
		}
		if typ == websocket.MessageText {
			p.mu.Lock()
			fin := string(data) == fwdFin && !p.gotFin
			if fin {
				p.gotFin = true
			}
			p.mu.Unlock()
			if fin {
				q.put(fwdDownItem{fin: true})
			}
			continue
		}
		p.mu.Lock()
		gone := p.socketClosed || p.gotFin
		if !gone {
			p.down += int64(len(data))
		}
		p.mu.Unlock()
		if gone {
			continue
		}
		if p.opts.onBytes != nil {
			p.opts.onBytes(0, len(data))
		}
		q.put(fwdDownItem{data: data})
	}
}

// sendUp sends one chunk read from TCP as frames. Progress counts per frame, as each is written, so a
// close in the middle of a chunk (a 1012 after the first frame) never leaves the connection looking
// untouched. If the socket closes before any frame of the chunk went out, the whole chunk, and rest
// (what is left of an earlier dial's pending bytes), is kept in p.pending for the redial.
// fwdAfterFrame, nil outside tests, runs after each frame sendUp writes (a test widens the window
// for a close to land mid-chunk).
var fwdAfterFrame atomic.Pointer[func()] // atomic: an earlier test's pipe may still be sending

func (p *fwdPipe) sendUp(chunk, rest []byte, frameNext *int, lastData *time.Time) bool {
	now := time.Now()
	if now.Sub(*lastData) >= fwdFrameRampIdle {
		*frameNext = fwdFirstFrame
	}
	*lastData = now
	for i := 0; i < len(chunk); {
		end := i + *frameNext
		if end > len(chunk) {
			end = len(chunk)
		}
		if err := p.ws.Write(context.Background(), websocket.MessageBinary, chunk[i:end]); err != nil {
			if i == 0 {
				p.mu.Lock()
				if p.up == 0 {
					p.pending = append(append([]byte(nil), chunk...), rest...)
				}
				p.mu.Unlock()
			}
			return false
		}
		p.mu.Lock()
		p.up += int64(end - i)
		p.mu.Unlock()
		if p.opts.onBytes != nil {
			p.opts.onBytes(end-i, 0)
		}
		if hook := fwdAfterFrame.Load(); hook != nil {
			(*hook)()
		}
		i = end
		if *frameNext*2 <= fwdMaxFrame {
			*frameNext *= 2
		} else {
			*frameNext = fwdMaxFrame
		}
	}
	return true
}

func (p *fwdPipe) upstream() {
	defer close(p.upDone)
	frameNext := fwdFirstFrame
	lastData := time.Time{}
	held := p.opts.keepIfUntouched != nil
	hold := func() {
		if held {
			held = false
			select {
			case <-p.heard:
			case <-time.After(fwdFirstSendHold):
			}
		}
	}
	buf := make([]byte, fwdMaxFrame)
	first := p.opts.pending
	for {
		var n int
		var err error
		if first != nil {
			n = copy(buf, first)
			if n < len(first) {
				first = first[n:]
			} else {
				first = nil
			}
		} else {
			n, err = p.tcp.Read(buf)
		}
		if n > 0 {
			hold()
			p.mu.Lock()
			open, firstUp := p.wsOpen(), p.up == 0
			if !open && firstUp {
				// Closing before a byte went over: keep what was read for a redial to send.
				p.pending = append(append([]byte(nil), buf[:n]...), first...)
			}
			p.mu.Unlock()
			if !open {
				if firstUp {
					return
				}
				continue
			}
			if !p.sendUp(append([]byte(nil), buf[:n]...), first, &frameNext, &lastData) {
				p.mu.Lock()
				kept := p.up == 0 // nothing went out: the chunk (and first) are in p.pending
				p.mu.Unlock()
				if kept {
					return
				}
				continue // the read side sees the close
			}
		}
		if err == nil {
			continue
		}
		if errors.Is(err, io.EOF) {
			p.mu.Lock()
			p.sentFin = true
			open := p.wsOpen()
			p.mu.Unlock()
			if open {
				_ = p.ws.Write(context.Background(), websocket.MessageText, []byte(fwdFin))
			}
			p.finishIfDone()
			return
		}
		if errors.Is(err, os.ErrDeadlineExceeded) {
			return // handed back untouched
		}
		p.onSocketClose()
		return
	}
}

func (p *fwdPipe) finishIfDone() {
	p.mu.Lock()
	both := p.sentFin && p.gotFin
	p.mu.Unlock()
	if both {
		p.closeWs(fwdCloseNormal)
	}
}

// onSocketClose: the local side went away (a reset, a failed write).
func (p *fwdPipe) onSocketClose() {
	p.mu.Lock()
	if p.socketClosed {
		p.mu.Unlock()
		return
	}
	p.socketClosed = true
	if p.closedBy == "" {
		if p.wsClosed == 0 {
			p.closedBy = "local"
		} else {
			p.closedBy = "remote"
		}
	}
	code := fwdCloseError
	if p.sentFin && p.gotFin {
		code = fwdCloseNormal
	}
	p.mu.Unlock()
	_ = p.tcp.Close()
	p.closeWs(code)
	p.settle()
}

func (p *fwdPipe) onWsClose(code int) {
	p.mu.Lock()
	p.wsClosed = code
	if p.closedBy == "" {
		p.closedBy = "remote"
	}
	keep := p.up == 0 && p.down == 0 && !p.sentFin && !p.gotFin && !p.socketClosed && p.opts.keepIfUntouched != nil && p.opts.keepIfUntouched(code)
	alreadyClosed := p.socketClosed
	p.mu.Unlock()
	switch {
	case keep:
		// Stop reading without closing: the connection goes to the next dial.
		_ = p.tcp.SetReadDeadline(time.Now())
		<-p.upDone
		_ = p.tcp.SetReadDeadline(time.Time{})
		_ = p.tcp.SetWriteDeadline(time.Time{}) // never set on this path; cleared for the next dial all the same
		p.mu.Lock()
		// A frame may have gone out between the check above and the read side stopping: then the
		// box has some of the bytes, and a redial would send them again, so the connection is reset.
		touched := p.up != 0
		if !touched {
			p.untouched = true
		}
		p.mu.Unlock()
		if touched {
			_ = p.tcp.SetLinger(0)
			_ = p.tcp.Close()
			p.mu.Lock()
			p.socketClosed = true
			p.pending = nil
			p.mu.Unlock()
		}
	case !alreadyClosed:
		if code == fwdCloseNormal {
			// Both directions are done (or this end stopped): what was written is flushed, then let go.
			_ = p.tcp.CloseWrite()
		} else {
			_ = p.tcp.SetLinger(0) // a reset, as resetAndDestroy
		}
		_ = p.tcp.Close()
		p.mu.Lock()
		p.socketClosed = true
		p.mu.Unlock()
	}
	p.settle()
}

func (p *fwdPipe) settle() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.settled || p.wsClosed == 0 || (!p.socketClosed && !p.untouched) {
		return
	}
	p.settled = true
	close(p.stopPing)
	p.done <- fwdPipeResult{Code: p.wsClosed, Up: p.up, Down: p.down, ClosedBy: p.closedBy, Untouched: p.untouched, Pending: p.pending}
}

// Stop is Ctrl-C: close with 1000, and drop whatever is left after grace.
func (p *fwdPipe) Stop(grace time.Duration) {
	p.closeWs(fwdCloseNormal)
	time.AfterFunc(grace, func() {
		p.mu.Lock()
		settled := p.settled
		p.mu.Unlock()
		if settled {
			return
		}
		_ = p.ws.CloseNow()
		_ = p.tcp.Close()
	})
}
