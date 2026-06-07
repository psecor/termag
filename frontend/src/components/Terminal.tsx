import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import 'xterm/css/xterm.css';

interface TerminalProps {
  sessionName: string;
  // Authoritative project routing: when provided, the backend resolves the
  // project (owner, instanceId/box) by id instead of parsing the session
  // string, so same-named projects on different boxes route correctly.
  projectId?: string;
  workstream?: string;
  active: boolean;
  autoFocus?: boolean;
  onActivity?: () => void;
}

// Regex to match mouse tracking enable/disable escape sequences
const MOUSE_TRACKING_RE = /\x1b\[\?(9|1000|1002|1003|1004|1005|1006|1015|1016)[hl]/g;

// Sequences to disable all mouse tracking modes in xterm.js
const DISABLE_MOUSE = '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l';

// Reconnect schedule. Five attempts with exponential-ish backoff covers
// most transient blips (agent restart ~10s, server restart, network hiccup)
// before we ask the user to intervene.
const RECONNECT_DELAYS_MS = [0, 500, 1000, 2000, 4000];
const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;

type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'failed';

export function Terminal({ sessionName, projectId, workstream, active, autoFocus, onActivity }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const selectModeRef = useRef(false);
  const [focused, setFocused] = useState(false);

  // Reconnect lifecycle
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [retryAttempt, setRetryAttempt] = useState(0);
  // Stable reference the modal "Try again" button can invoke. Set inside the
  // useEffect that owns the connection lifecycle.
  const retryRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (autoFocus && termRef.current) {
      termRef.current.focus();
    }
  }, [autoFocus, sessionName]);

  // Toggle select mode: strip mouse tracking so xterm.js allows native selection
  useEffect(() => {
    selectModeRef.current = selectMode;
    const term = termRef.current;
    if (!term) return;

    if (selectMode) {
      // Disable mouse tracking in xterm.js so clicks trigger text selection
      term.write(DISABLE_MOUSE);
    }

    // Also toggle tmux mouse as before
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'mouse', enabled: !selectMode }));
    }
  }, [selectMode]);

  useEffect(() => {
    if (!active || !containerRef.current) return;

    const container = containerRef.current;

    const term = new XTerm({
      allowTransparency: true,
      theme: {
        background: '#0d1117c0',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: '#264f7880',
      },
      fontSize: 13,
      fontFamily: 'JetBrains Mono, Fira Code, monospace',
      cursorBlink: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    termRef.current = term;

    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);

    let disposed = false;
    let textarea: HTMLElement | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const initTimer = requestAnimationFrame(() => {
      if (disposed) return;

      fitAddon.fit();

      // Attach focus listeners now that xterm.js has rendered its DOM
      textarea = container.querySelector('.xterm-helper-textarea') as HTMLElement | null;
      if (textarea) {
        textarea.addEventListener('focus', onFocus);
        textarea.addEventListener('blur', onBlur);
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const initCols = term.cols;
      const initRows = term.rows;

      // (Re)open the WebSocket. Called once at startup and again from the
      // backoff loop and the modal's Try-again button. The xterm.js Terminal
      // itself is created once and reused — only the underlying WS churns.
      const connect = () => {
        if (disposed) return;
        // Clean up any prior socket reference (defensive — onclose would
        // already have nulled it, but a Try-again click while the existing
        // socket is mid-close could land here first).
        if (wsRef.current) {
          try { wsRef.current.close(); } catch { /* ignore */ }
          wsRef.current = null;
        }
        setConnectionState(attempt === 0 ? 'connecting' : 'reconnecting');
        setRetryAttempt(attempt);

        const routing = projectId
          ? `&projectId=${encodeURIComponent(projectId)}&workstream=${encodeURIComponent(workstream ?? 'main')}`
          : '';
        const ws = new WebSocket(
          `${protocol}//${window.location.host}/termag/ws/terminal?session=${encodeURIComponent(sessionName)}${routing}&cols=${initCols}&rows=${initRows}`,
        );
        wsRef.current = ws;

        ws.onopen = () => {
          if (disposed) { ws.close(); return; }
          // A successful (re)open resets the retry budget so a fresh
          // disconnect later gets the full backoff schedule again.
          if (attempt > 0) {
            term.write('\r\n[reconnected]\r\n');
          }
          attempt = 0;
          setRetryAttempt(0);
          setConnectionState('connected');
          fitAddon.fit();
          if (term.cols !== initCols || term.rows !== initRows) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
          if (autoFocus) term.focus();
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string) as { type: string; data?: string };
            if (msg.type === 'output' && msg.data) {
              if (selectModeRef.current) {
                // Strip mouse tracking sequences so xterm.js stays in selection mode
                const filtered = msg.data.replace(MOUSE_TRACKING_RE, '');
                term.write(filtered);
              } else {
                term.write(msg.data);
              }
            } else if (msg.type === 'exit') {
              term.write('\r\n[session ended]\r\n');
            }
          } catch { /* ignore */ }
        };

        ws.onclose = () => {
          wsRef.current = null;
          if (disposed) return;
          if (attempt + 1 < MAX_RECONNECT_ATTEMPTS) {
            attempt += 1;
            setRetryAttempt(attempt);
            setConnectionState('reconnecting');
            const delay = RECONNECT_DELAYS_MS[attempt] ?? RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1];
            retryTimer = setTimeout(() => {
              retryTimer = null;
              connect();
            }, delay);
          } else {
            // Exhausted automatic retries — surface the modal so the user
            // can hit "Try again" rather than staring at a dead terminal.
            setConnectionState('failed');
          }
        };

        ws.onerror = () => {
          // onerror is always followed by onclose; the retry/modal logic
          // lives there. Don't double-handle here.
        };
      };

      // Expose a manual retry the modal can invoke. Resets the retry
      // budget so the user gets a fresh backoff schedule.
      retryRef.current = () => {
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        attempt = 0;
        setRetryAttempt(0);
        connect();
      };

      connect();

      const dataDisposable = term.onData((data) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
        if (onActivity) onActivity();
      });

      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const observer = new ResizeObserver(() => {
        if (disposed) return;
        // Debounce resize to avoid flooding PTY during window drag
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (disposed) return;
          fitAddon.fit();
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
        }, 150);
      });
      observer.observe(container);

      // Mobile: re-fit when virtual keyboard opens/closes
      let vvHandler: (() => void) | null = null;
      const vv = window.visualViewport;
      if (vv) {
        vvHandler = () => {
          if (disposed) return;
          fitAddon.fit();
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
        };
        vv.addEventListener('resize', vvHandler);
      }

      (term as any)._termag = { dataDisposable, observer, resizeTimer, vvHandler };
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(initTimer);
      if (retryTimer) clearTimeout(retryTimer);
      retryRef.current = null;
      const extras = (term as any)._termag;
      if (extras) {
        extras.dataDisposable.dispose();
        extras.observer.disconnect();
        if (extras.resizeTimer) clearTimeout(extras.resizeTimer);
        if (extras.vvHandler && window.visualViewport) {
          window.visualViewport.removeEventListener('resize', extras.vvHandler);
        }
      }
      if (textarea) { textarea.removeEventListener('focus', onFocus); textarea.removeEventListener('blur', onBlur); }
      const ws = wsRef.current;
      // Restore tmux mouse before closing
      if (ws && ws.readyState === WebSocket.OPEN && selectModeRef.current) {
        ws.send(JSON.stringify({ type: 'mouse', enabled: true }));
      }
      if (ws) ws.close();
      wsRef.current = null;
      term.dispose();
      setFocused(false);
      termRef.current = null;
      setSelectMode(false);
      setConnectionState('connecting');
      setRetryAttempt(0);
    };
  }, [active, sessionName]);

  return (
    <div
      ref={containerRef}
      className={focused ? undefined : 'terminal-dimmed'}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      <button
        onClick={() => setSelectMode(m => !m)}
        title={selectMode ? 'Switch to scroll mode' : 'Switch to select mode (Cmd+C to copy)'}
        style={{
          position: 'absolute',
          top: 4,
          right: 4,
          zIndex: 10,
          background: selectMode ? 'rgba(88, 166, 255, 0.25)' : 'rgba(13, 17, 23, 0.7)',
          border: `1px solid ${selectMode ? 'rgba(88, 166, 255, 0.6)' : 'rgba(48, 54, 61, 0.8)'}`,
          borderRadius: 4,
          color: selectMode ? '#58a6ff' : '#8b949e',
          padding: '2px 6px',
          fontSize: 11,
          fontFamily: 'inherit',
          cursor: 'pointer',
          transition: 'all 0.15s',
        }}
      >
        {selectMode ? '✂ select' : '⇕ scroll'}
      </button>
      {connectionState === 'reconnecting' && (
        <div className="terminal-reconnect-pill" aria-live="polite">
          Reconnecting… ({retryAttempt}/{MAX_RECONNECT_ATTEMPTS - 1})
        </div>
      )}
      {connectionState === 'failed' && (
        <div className="terminal-reconnect-overlay" role="alertdialog" aria-modal="true">
          <div className="terminal-reconnect-panel">
            <div className="terminal-reconnect-title">Terminal disconnected</div>
            <div className="terminal-reconnect-message">
              Couldn't reach the agent for <code>{sessionName}</code> after {MAX_RECONNECT_ATTEMPTS - 1} retries.
              The tmux session is probably still alive — try again, or check that the box agent is connected.
            </div>
            <button
              className="terminal-reconnect-button"
              autoFocus
              onClick={() => retryRef.current?.()}
            >
              Try again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
