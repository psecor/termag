import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import 'xterm/css/xterm.css';

interface TerminalProps {
  sessionName: string;
  active: boolean;
  autoFocus?: boolean;
  onActivity?: () => void;
}

// Regex to match mouse tracking enable/disable escape sequences
const MOUSE_TRACKING_RE = /\x1b\[\?(9|1000|1002|1003|1004|1005|1006|1015|1016)[hl]/g;

// Sequences to disable all mouse tracking modes in xterm.js
const DISABLE_MOUSE = '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l';

export function Terminal({ sessionName, active, autoFocus, onActivity }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const selectModeRef = useRef(false);
  const [focused, setFocused] = useState(false);

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

    let ws: WebSocket | null = null;
    let disposed = false;
    let textarea: HTMLElement | null = null;

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
      ws = new WebSocket(
        `${protocol}//${window.location.host}/termag/ws/terminal?session=${encodeURIComponent(sessionName)}&cols=${initCols}&rows=${initRows}`
      );
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) { ws?.close(); return; }
        fitAddon.fit();
        // Send resize in case fit changed dimensions after the URL was built
        if (term.cols !== initCols || term.rows !== initRows) {
          ws!.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
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
        if (!disposed) term.write('\r\n[disconnected]\r\n');
        wsRef.current = null;
      };

      ws.onerror = () => {
        if (!disposed) term.write('\r\n[connection error]\r\n');
      };

      const dataDisposable = term.onData((data) => {
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
    </div>
  );
}
