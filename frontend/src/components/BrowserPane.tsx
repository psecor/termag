import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  browserPaneCloseMessage,
  keyEvent,
  pointerEvent,
  shouldCaptureKey,
  wheelEvent,
  type BrowserInputEvent,
  type FrameSize,
} from '../utils/browserPaneInput';
import {
  browserSocketParams, isBlankUrl, isFinalClose, reconnectDelayMs, suggestionLabel, suggestionToOpen,
  type BrowserPaneTarget, type BrowserShareHandoff, type Suggestion,
} from '../utils/browserPaneConnection';

/** The workstream checkout a guest pane shows (agent browser-checkout). */
export interface PaneCheckout { branch: string; head: string; dirty: number | null }

interface Props {
  projectId?: string;
  workstream?: string;
  /**
   * A reviewer's pane: the share, not the project,
   * opens it. No suggestions (they would list the box's ports); the box
   * reports what it refused and the checkout it shows.
   */
  share?: { shareId: string; at?: string | null; asGuest?: boolean };
  /** The URL the browser opens with; `about:blank` for an empty pane. */
  url: string;
  /** The page navigated (the dock remembers the URL for next time). */
  onUrlChange: (url: string) => void;
  /** The owner's share link (`browserShare`, `browserAt`): the first dial opens that share's app at its path. */
  openShare?: BrowserShareHandoff | null;
  /** A dial that carried `openShare` is ready: its owner drops the handoff, so a remount doesn't carry it again. */
  onOpenShareUsed?: () => void;
  /** "Reset browser": sign out of everything this pane's kept profile holds (browser-pane-persistent-profiles-enabled). */
  showReset?: boolean;
  onCheckout?: (checkout: PaneCheckout) => void;
  /** A final close, for a page that shows its own state (the guest page: a box asleep). */
  onClosed?: (code: number, reason: string, message: string) => void;
}

type Status =
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'reconnecting'; message: string; attempt: number }
  | { kind: 'closed'; message: string };

interface Nav { url: string; title: string; canGoBack: boolean; canGoForward: boolean }

interface ServerMessage {
  type?: string;
  data?: string;
  width?: number;
  height?: number;
  url?: string;
  title?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  reason?: string;
  items?: Suggestion[];
  origin?: string;
  local?: boolean;
  branch?: string;
  head?: string;
  dirty?: number | null;
  id?: number;
  kind?: string;
  message?: string;
  defaultPrompt?: string;
}

/** A page's alert, confirm or prompt the box asks the viewer to answer. */
interface PageDialog { id: number; kind: 'alert' | 'confirm' | 'prompt'; message: string; defaultPrompt: string }

/** A refused address a guest's page asked for, for the notice under the toolbar. */
interface Blocked { origin: string; local: boolean }
const MAX_BLOCKED = 4;

const RESIZE_DEBOUNCE_MS = 150;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;
const MAX_CHIPS = 5;

/**
 * A headless Chromium on the project's box, painted into a canvas.
 * The pane dials once per mount, follows its own
 * size, and redials with backoff when the socket drops: the agent keeps the
 * browser parked for a minute, so a reconnect lands on the same page. Nothing
 * of the page runs here: frames come in, pointer and keyboard events go out.
 * A blank pane asks the box which web apps are listening and opens the best.
 */
// The backend's "redial, your share changed" close (routes/browserWs.ts).
const SHARE_UPDATED_CLOSE_CODE = 1012;

export function BrowserPane({ projectId = '', workstream = 'main', share, url, onUrlChange, openShare, onOpenShareUsed, showReset, onCheckout, onClosed }: Props) {
  const guest = !!share;
  const shareId = share?.shareId ?? '';
  const shareAt = share?.at ?? null;
  const asGuest = !!share?.asGuest;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const frameRef = useRef<FrameSize>({ width: 1024, height: 768 });
  // The URL to dial with: the mount's, then wherever the page went.
  const urlRef = useRef(url);
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;
  const [status, setStatus] = useState<Status>({ kind: 'connecting' });
  const [nav, setNav] = useState<Nav>({ url: urlRef.current, title: '', canGoBack: false, canGoForward: false });
  const [urlInput, setUrlInput] = useState('');
  const [editing, setEditing] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [chipsOpen, setChipsOpen] = useState(false);
  const [blocked, setBlocked] = useState<Blocked[]>([]);
  const [externalBlocked, setExternalBlocked] = useState(0);
  // A user's "Reconnect here" (after another tab took a kept browser over) redials from scratch.
  const [dialNonce, setDialNonce] = useState(0);
  const [takenOver, setTakenOver] = useState(false);
  const [dialog, setDialog] = useState<PageDialog | null>(null);
  const [promptText, setPromptText] = useState('');
  // A link's page (an owner's share link, a reviewer's `at`) rides the dials
  // until one is ready: a redial after that, to a parked or reclaimed
  // browser, stays where the page went.
  const openShareRef = useRef(openShare ?? null);
  const shareAtRef = useRef(shareAt);
  // A new link while mounted (the reviewer page's `at` changing in-app, a
  // handoff consumed) replaces what the next dial carries; declared ahead of
  // the dial effect, so a redial for a new `at` already sees it.
  useEffect(() => { shareAtRef.current = shareAt; }, [shareAt]);
  useEffect(() => { openShareRef.current = openShare ?? null; }, [openShare]);
  const onOpenShareUsedRef = useRef(onOpenShareUsed);
  onOpenShareUsedRef.current = onOpenShareUsed;
  const onCheckoutRef = useRef(onCheckout);
  onCheckoutRef.current = onCheckout;
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  const send = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // While the page's dialog is up it is modal, as it would be natively: the
  // canvas's input (keys and paste included, if it keeps focus) goes nowhere.
  // A release that pairs with a press the page already has is held, not
  // dropped, and sent when the dialog goes, or the key or button would stay
  // down in Chromium (auto-repeat, a drag).
  const dialogOpenRef = useRef(false);
  dialogOpenRef.current = dialog !== null;
  const held = useRef(new Set<string>());
  const heldReleases = useRef<BrowserInputEvent[]>([]);
  const sendInput = useCallback((event: BrowserInputEvent) => {
    const id = event.kind === 'key' ? `key:${event.code || event.key}` : event.kind === 'mouse' ? `button:${event.button}` : null;
    const release = id !== null && ((event.kind === 'key' && event.type === 'keyUp') || (event.kind === 'mouse' && event.type === 'mouseReleased'));
    if (dialogOpenRef.current) {
      if (release && held.current.delete(id)) heldReleases.current.push(event);
      return;
    }
    if (id !== null && ((event.kind === 'key' && event.type === 'keyDown') || (event.kind === 'mouse' && event.type === 'mousePressed'))) held.current.add(id);
    else if (release) held.current.delete(id);
    send({ type: 'input', event });
  }, [send]);
  useEffect(() => {
    if (dialog || heldReleases.current.length === 0) return;
    for (const event of heldReleases.current.splice(0)) send({ type: 'input', event });
  }, [dialog, send]);
  // The viewer's answer to the page's dialog; the box closes it and says so.
  const answerDialog = useCallback((accept: boolean) => {
    if (!dialog) return;
    send({ type: 'dialog', id: dialog.id, accept, ...(dialog.kind === 'prompt' && accept ? { text: promptText } : {}) });
    setDialog(null);
  }, [send, dialog, promptText]);

  // Frames are decoded one at a time and only the newest waits: a burst of
  // repaints never queues decodes behind each other.
  const latestFrame = useRef<string | null>(null);
  const decoding = useRef(false);
  const paint = useCallback(() => {
    if (decoding.current) return;
    const data = latestFrame.current;
    if (!data) return;
    latestFrame.current = null;
    decoding.current = true;
    const img = new Image();
    const done = () => {
      decoding.current = false;
      if (latestFrame.current) paint();
    };
    img.onload = () => {
      const c = canvasRef.current;
      if (c) {
        if (c.width !== img.width || c.height !== img.height) {
          c.width = img.width;
          c.height = img.height;
        }
        frameRef.current = { width: img.width, height: img.height };
        c.getContext('2d')?.drawImage(img, 0, 0);
      }
      done();
    };
    img.onerror = done;
    img.src = `data:image/jpeg;base64,${data}`;
  }, []);

  useEffect(() => {
    const body = bodyRef.current;
    const canvas = canvasRef.current;
    if (!body || !canvas) return;
    let disposed = false;
    let attempt = 0;
    let redial: ReturnType<typeof setTimeout> | null = null;
    let current: WebSocket | null = null;

    const measure = () => {
      const rect = body.getBoundingClientRect();
      return { width: Math.max(MIN_WIDTH, Math.round(rect.width)), height: Math.max(MIN_HEIGHT, Math.round(rect.height)) };
    };

    const connect = () => {
      if (disposed) return;
      redial = null;
      const size = measure();
      frameRef.current = size;
      if (canvas.width !== size.width || canvas.height !== size.height) {
        canvas.width = size.width;
        canvas.height = size.height;
      }
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const target: BrowserPaneTarget = guest
        ? { mode: 'guest', shareId, at: shareAtRef.current, asGuest }
        : { mode: 'owner', projectId, workstream, openShare: openShareRef.current };
      const opensShare = !guest && !!openShareRef.current;
      // An owner's share link: the box opens the share's app itself, so the
      // pane waits for its first page before asking what is listening; a
      // recipe the box could not resolve leaves it blank, and then it asks.
      let suggestIfStillBlank = false;
      const ws = new WebSocket(`${protocol}//${window.location.host}/termag/ws/browser?${browserSocketParams(target, urlRef.current, size)}`);
      let exitReason: string | null = null;
      current = ws;
      wsRef.current = ws;
      // A new socket is a new page state: nothing it has is held down.
      held.current.clear();
      heldReleases.current = [];
      const isCurrent = () => wsRef.current === ws && !disposed;

      // Open is not live: the backend is still starting (or reclaiming) the
      // browser on the box and reads nothing until it has. `ready` is the moment.
      ws.onmessage = (ev) => {
        if (!isCurrent()) return;
        let msg: ServerMessage;
        try { msg = JSON.parse(ev.data as string); } catch { return; }
        switch (msg.type) {
          case 'ready':
            attempt = 0;
            setStatus({ kind: 'live' });
            setTakenOver(false);
            openShareRef.current = null;
            shareAtRef.current = null;
            if (opensShare) onOpenShareUsedRef.current?.();
            // Nothing to show yet: ask the box what is listening, and open the best.
            // A guest's box answers no such question: its page opens the share's app itself.
            if (isBlankUrl(urlRef.current) && !guest) {
              if (opensShare) suggestIfStillBlank = true;
              else send({ type: 'suggest' });
            }
            break;
          case 'frame':
            if (typeof msg.data === 'string') {
              setStatus(prev => (prev.kind === 'live' ? prev : { kind: 'live' }));
              latestFrame.current = msg.data;
              paint();
            }
            break;
          case 'nav': {
            const next = { url: msg.url ?? '', title: msg.title ?? '', canGoBack: !!msg.canGoBack, canGoForward: !!msg.canGoForward };
            setNav(next);
            if (suggestIfStillBlank) {
              suggestIfStillBlank = false;
              if (isBlankUrl(next.url)) send({ type: 'suggest' });
            }
            if (!isBlankUrl(next.url)) {
              urlRef.current = next.url;
              onUrlChangeRef.current(next.url);
              setChipsOpen(false);
            }
            break;
          }
          case 'blocked': {
            if (typeof msg.origin !== 'string') break;
            const item = { origin: msg.origin, local: msg.local === true };
            if (item.local) setBlocked(prev => (prev.some(b => b.origin === item.origin) ? prev : [item, ...prev].slice(0, MAX_BLOCKED)));
            else setExternalBlocked(n => n + 1);
            break;
          }
          case 'dialog':
            if (typeof msg.id !== 'number') break;
            setDialog({
              id: msg.id,
              kind: msg.kind === 'confirm' || msg.kind === 'prompt' ? msg.kind : 'alert',
              message: typeof msg.message === 'string' ? msg.message : '',
              defaultPrompt: typeof msg.defaultPrompt === 'string' ? msg.defaultPrompt : '',
            });
            setPromptText(typeof msg.defaultPrompt === 'string' ? msg.defaultPrompt : '');
            break;
          case 'dialog-closed':
            setDialog(d => (d && d.id === msg.id ? null : d));
            break;
          case 'checkout':
            if (typeof msg.head === 'string') onCheckoutRef.current?.({ branch: msg.branch ?? '', head: msg.head, dirty: typeof msg.dirty === 'number' ? msg.dirty : null });
            break;
          case 'suggestions': {
            const items = Array.isArray(msg.items) ? msg.items : [];
            setSuggestions(items);
            // Open even when empty: "nothing is listening" is the answer then.
            setChipsOpen(true);
            const open = isBlankUrl(urlRef.current) ? suggestionToOpen(items) : null;
            if (open) {
              setUrlInput(open.url);
              send({ type: 'navigate', url: open.url });
            }
            break;
          }
          case 'exit':
            // The browser went away under us; the redial below asks for a fresh one.
            // A refusal's own words ride this frame ahead of a final close.
            exitReason = typeof msg.reason === 'string' ? msg.reason : null;
            setStatus({ kind: 'reconnecting', message: exitReason ?? 'The browser closed.', attempt });
            break;
          default:
            break;
        }
      };
      ws.onclose = (ev) => {
        if (!isCurrent()) return;
        wsRef.current = null;
        current = null;
        // A dialog belongs to the page this socket showed: the box answers it.
        setDialog(null);
        if (isFinalClose(ev.code)) {
          const message = exitReason ?? browserPaneCloseMessage(ev.code, ev.reason);
          setStatus({ kind: 'closed', message });
          setTakenOver(ev.reason === 'taken over');
          onClosedRef.current?.(ev.code, ev.reason, message);
          return;
        }
        // The share itself changed (renewed with another recipe): the page it
        // showed may not be part of it any more, so the redial opens the
        // share's own first page rather than asking for that one.
        if (guest && ev.code === SHARE_UPDATED_CLOSE_CODE) urlRef.current = 'about:blank';
        const delay = reconnectDelayMs(attempt);
        setStatus(prev => ({
          kind: 'reconnecting',
          message: prev.kind === 'reconnecting' ? prev.message : browserPaneCloseMessage(ev.code, ev.reason),
          attempt,
        }));
        attempt += 1;
        redial = setTimeout(connect, delay);
      };
    };

    // A page that comes back to the foreground redials at once rather than
    // waiting out the backoff; the browser is still parked on the box.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || disposed || current) return;
      if (redial) { clearTimeout(redial); redial = null; connect(); }
    };
    document.addEventListener('visibilitychange', onVisible);

    // The browser follows the pane's size, debounced so a drag is one resize.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const size = measure();
        if (size.width !== frameRef.current.width || size.height !== frameRef.current.height) {
          send({ type: 'resize', width: size.width, height: size.height });
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(body);

    // Wheel needs a non-passive listener to keep the workspace from scrolling under the pane.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = canvasRef.current;
      if (!c) return;
      sendInput(wheelEvent(e, c.getBoundingClientRect(), frameRef.current));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    // Dial on the next tick: React's development double-mount cleans up
    // before this fires, so one pane opens one browser.
    const dial = setTimeout(connect, 0);

    return () => {
      disposed = true;
      clearTimeout(dial);
      if (redial) clearTimeout(redial);
      if (resizeTimer) clearTimeout(resizeTimer);
      document.removeEventListener('visibilitychange', onVisible);
      observer.disconnect();
      canvas.removeEventListener('wheel', onWheel);
      wsRef.current = null;
      try { current?.close(); } catch { /* already closed */ }
    };
  }, [projectId, workstream, guest, shareId, shareAt, asGuest, dialNonce, send, sendInput, paint]);

  // Moves are coalesced to one per animation frame; presses and releases go at once.
  const pendingMove = useRef<BrowserInputEvent | null>(null);
  const moveFrame = useRef<number | null>(null);
  const queueMove = useCallback((event: BrowserInputEvent) => {
    pendingMove.current = event;
    if (moveFrame.current != null) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = null;
      if (pendingMove.current) sendInput(pendingMove.current);
      pendingMove.current = null;
    });
  }, [sendInput]);
  // A press or release sends the move it would otherwise overtake first, so
  // a drag finished inside one animation frame still reads press, move,
  // release to the page.
  const flushMove = useCallback(() => {
    if (moveFrame.current != null) {
      cancelAnimationFrame(moveFrame.current);
      moveFrame.current = null;
    }
    const move = pendingMove.current;
    pendingMove.current = null;
    if (move) sendInput(move);
  }, [sendInput]);
  useEffect(() => () => { if (moveFrame.current != null) cancelAnimationFrame(moveFrame.current); }, []);

  // The release is listened for on the window, not the canvas: a button let
  // go outside the pane must still release in the page, or every later move
  // is a drag. One listener per press; the canvas's own mouseup bubbles there.
  const windowRelease = useRef<((e: MouseEvent) => void) | null>(null);
  const releaseAtWindow = useCallback((e: MouseEvent) => {
    windowRelease.current = null;
    const c = canvasRef.current;
    if (!c) return;
    flushMove();
    sendInput(pointerEvent('mouseReleased', e, c.getBoundingClientRect(), frameRef.current, e.detail || 1));
  }, [flushMove, sendInput]);
  useEffect(() => () => { if (windowRelease.current) window.removeEventListener('mouseup', windowRelease.current); }, []);

  const onMouse = (type: 'mousePressed' | 'mouseMoved') => (e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current;
    if (!c) return;
    e.preventDefault();
    const event = pointerEvent(type, e.nativeEvent, c.getBoundingClientRect(), frameRef.current, type === 'mouseMoved' ? 0 : e.detail || 1);
    if (type === 'mouseMoved') {
      queueMove(event);
      return;
    }
    c.focus();
    flushMove();
    sendInput(event);
    if (!windowRelease.current) {
      windowRelease.current = releaseAtWindow;
      window.addEventListener('mouseup', releaseAtWindow, { once: true });
    }
  };

  const onKey = (type: 'keyDown' | 'keyUp') => (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!shouldCaptureKey(e.nativeEvent)) return;
    e.preventDefault();
    sendInput(keyEvent(type, e.nativeEvent));
  };

  const onPaste = (e: React.ClipboardEvent<HTMLCanvasElement>) => {
    const text = e.clipboardData.getData('text');
    if (!text) return;
    e.preventDefault();
    sendInput({ kind: 'text', text });
  };

  const navigateTo = (target: string) => {
    const t = target.trim();
    if (!t) return;
    send({ type: 'navigate', url: t });
    setEditing(false);
    setChipsOpen(false);
    canvasRef.current?.focus();
  };

  const live = status.kind === 'live';
  const shownUrl = isBlankUrl(nav.url) ? '' : nav.url;
  const overlay = status.kind === 'connecting'
    ? 'Starting a browser on the box…'
    : status.kind === 'reconnecting'
      ? `${status.message} Reconnecting…`
      : status.kind === 'closed'
        ? status.message
        : null;

  return (
    <div className="browser-pane">
      <form className="browser-pane-toolbar" onSubmit={(e) => { e.preventDefault(); navigateTo(urlInput); }}>
        <button type="button" className="browser-pane-btn" title="Back" aria-label="Back" disabled={!live || !nav.canGoBack} onClick={() => send({ type: 'history', action: 'back' })}>‹</button>
        <button type="button" className="browser-pane-btn" title="Forward" aria-label="Forward" disabled={!live || !nav.canGoForward} onClick={() => send({ type: 'history', action: 'forward' })}>›</button>
        <button type="button" className="browser-pane-btn" title="Reload" aria-label="Reload" disabled={!live} onClick={() => send({ type: 'history', action: 'reload' })}>↻</button>
        <input
          className="browser-pane-url"
          type="text"
          aria-label="URL"
          placeholder="http://127.0.0.1:3000/"
          spellCheck={false}
          autoComplete="off"
          disabled={!live}
          value={editing ? urlInput : shownUrl}
          onFocus={() => { setEditing(true); setUrlInput(shownUrl); }}
          onBlur={() => setEditing(false)}
          onChange={e => setUrlInput(e.target.value)}
        />
        {!guest && (
          <button
            type="button"
            className="browser-pane-btn"
            title="Apps listening on the box"
            aria-label="Apps listening on the box"
            disabled={!live}
            onClick={() => { if (chipsOpen) setChipsOpen(false); else send({ type: 'suggest' }); }}
          >
            ⌕
          </button>
        )}
        {showReset && (
          <button
            type="button"
            className="browser-pane-btn"
            title="Reset browser: sign out of everything this pane remembers"
            aria-label="Reset browser"
            disabled={!live}
            onClick={() => { if (window.confirm('Reset this browser? It forgets every sign-in and cookie it kept, and starts fresh.')) send({ type: 'reset-profile' }); }}
          >
            ⟲
          </button>
        )}
        {nav.title && <span className="browser-pane-title" title={nav.title}>{nav.title}</span>}
      </form>
      {chipsOpen && (
        <div className="browser-pane-chips" role="list" aria-label="Apps listening on the box">
          {suggestions.length === 0 && <span className="browser-pane-chips-empty">Nothing is listening on the box's web ports.</span>}
          {suggestions.slice(0, MAX_CHIPS).map(item => (
            <button
              key={item.url}
              type="button"
              role="listitem"
              className="browser-pane-chip"
              title={item.url}
              onClick={() => navigateTo(item.url)}
            >
              {suggestionLabel(item)}
            </button>
          ))}
        </div>
      )}
      {(blocked.length > 0 || externalBlocked > 0) && (
        <div className="browser-pane-blocked" role="status">
          {blocked.map(b => (
            <span key={b.origin} className="browser-pane-blocked-item" title="Ask the preview's owner to add it to the share">
              {b.origin} isn't part of this preview
            </span>
          ))}
          {externalBlocked > 0 && <span className="browser-pane-blocked-dim">{externalBlocked} request{externalBlocked === 1 ? '' : 's'} to other sites blocked</span>}
          <button type="button" className="browser-pane-blocked-close" aria-label="Dismiss" onClick={() => { setBlocked([]); setExternalBlocked(0); }}>×</button>
        </div>
      )}
      <div className="browser-pane-body" ref={bodyRef}>
        <canvas
          ref={canvasRef}
          className="browser-pane-canvas"
          tabIndex={0}
          aria-label="Browser on the box"
          onMouseDown={onMouse('mousePressed')}
          onMouseMove={onMouse('mouseMoved')}
          onContextMenu={e => e.preventDefault()}
          onKeyDown={onKey('keyDown')}
          onKeyUp={onKey('keyUp')}
          onPaste={onPaste}
        />
        {dialog && <div className="browser-pane-dialog-shield" aria-hidden="true" />}
        {dialog && (
          <form
            className="browser-pane-dialog"
            role="dialog"
            aria-label={`The page asks: ${dialog.kind}`}
            onSubmit={e => { e.preventDefault(); answerDialog(true); }}
            onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); answerDialog(false); } e.stopPropagation(); }}
          >
            <div className="browser-pane-dialog-message">{dialog.message || (dialog.kind === 'alert' ? 'The page shows an alert.' : 'The page asks.')}</div>
            {dialog.kind === 'prompt' && (
              <input aria-label="Answer" autoFocus value={promptText} onChange={e => setPromptText(e.target.value)} />
            )}
            <div className="browser-pane-dialog-actions">
              {dialog.kind !== 'alert' && <button type="button" onClick={() => answerDialog(false)}>Cancel</button>}
              <button type="submit" className="btn-primary" autoFocus={dialog.kind !== 'prompt'}>OK</button>
            </div>
          </form>
        )}
        {overlay && (
          <div className={`browser-pane-status ${status.kind === 'reconnecting' ? 'is-reconnecting' : ''}`} role="status">
            {overlay}
            {status.kind === 'closed' && takenOver && (
              <button type="button" className="browser-pane-status-btn" onClick={() => { setStatus({ kind: 'connecting' }); setDialNonce(n => n + 1); }}>
                Reconnect here
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
