import React, { useEffect, useRef } from 'react';
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

export function Terminal({ sessionName, active, autoFocus, onActivity }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

  // Focus the terminal whenever autoFocus or sessionName changes
  useEffect(() => {
    if (autoFocus && termRef.current) {
      termRef.current.focus();
    }
  }, [autoFocus, sessionName]);

  useEffect(() => {
    if (!active || !containerRef.current) return;

    const container = containerRef.current;

    const term = new XTerm({
      allowTransparency: true,
      theme: {
        background: '#0d1117c0', // ~75% opaque — stars show through
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: '#264f7880',
      },
      fontSize: 13,
      fontFamily: 'JetBrains Mono, Fira Code, monospace',
      cursorBlink: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    termRef.current = term;

    // Wait a frame for the container to have dimensions before fitting
    let ws: WebSocket | null = null;
    let disposed = false;

    const initTimer = requestAnimationFrame(() => {
      if (disposed) return;

      fitAddon.fit();

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(
        `${protocol}//${window.location.host}/termag/ws/terminal?session=${encodeURIComponent(sessionName)}`
      );

      ws.onopen = () => {
        if (disposed) { ws?.close(); return; }
        fitAddon.fit();
        ws!.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        if (autoFocus) term.focus();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as { type: string; data?: string };
          if (msg.type === 'output' && msg.data) {
            term.write(msg.data);
          } else if (msg.type === 'exit') {
            term.write('\r\n[session ended]\r\n');
          }
        } catch { /* ignore */ }
      };

      ws.onclose = () => {
        if (!disposed) term.write('\r\n[disconnected]\r\n');
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

      // Resize observer
      const observer = new ResizeObserver(() => {
        if (disposed) return;
        fitAddon.fit();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      });
      observer.observe(container);

      // Store cleanup refs on the term object for the outer cleanup
      (term as any)._termag = { dataDisposable, observer };
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(initTimer);
      const extras = (term as any)._termag;
      if (extras) {
        extras.dataDisposable.dispose();
        extras.observer.disconnect();
      }
      if (ws) ws.close();
      term.dispose();
      termRef.current = null;
    };
  }, [active, sessionName]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
