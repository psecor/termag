import * as pty from 'node-pty';
import { exec } from 'child_process';
import { WebSocket } from 'ws';

interface TerminalSession {
  pty: pty.IPty;
  clients: Set<WebSocket>;
  cleanupTimer: NodeJS.Timeout | null;
}

// Active PTY sessions keyed by tmux session name
const sessions = new Map<string, TerminalSession>();

// Grace period before killing a PTY with no clients (allows reconnect without flicker)
const DETACH_GRACE_MS = 5000;

// Minimal env for the PTY — avoid leaking Claude Code or hook variables
function cleanEnv(): Record<string, string> {
  return {
    HOME: process.env.HOME ?? '/home',
    USER: process.env.USER ?? 'secorp',
    SHELL: process.env.SHELL ?? '/bin/bash',
    TERM: 'xterm-256color',
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
  };
}

export function attachTerminal(tmuxSessionName: string, ws: WebSocket): void {
  let session = sessions.get(tmuxSessionName);

  if (session) {
    // Cancel pending cleanup — a new client arrived
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
  } else {
    const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', tmuxSessionName], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.env.HOME ?? '/home',
      env: cleanEnv(),
    });

    session = { pty: ptyProcess, clients: new Set(), cleanupTimer: null };
    sessions.set(tmuxSessionName, session);

    ptyProcess.onData((data) => {
      const s = sessions.get(tmuxSessionName);
      if (!s) return;
      for (const client of s.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'output', data }));
        }
      }
    });

    ptyProcess.onExit(() => {
      const s = sessions.get(tmuxSessionName);
      if (s) {
        if (s.cleanupTimer) clearTimeout(s.cleanupTimer);
        for (const client of s.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'exit' }));
          }
        }
      }
      sessions.delete(tmuxSessionName);
    });
  }

  session.clients.add(ws);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string; data?: string; cols?: number; rows?: number; enabled?: boolean };
      const s = sessions.get(tmuxSessionName);
      if (!s) return;

      if (msg.type === 'input' && msg.data !== undefined) {
        s.pty.write(msg.data);
      } else if (msg.type === 'resize' && msg.cols && msg.rows) {
        s.pty.resize(msg.cols, msg.rows);
      } else if (msg.type === 'mouse' && msg.enabled !== undefined) {
        // Toggle tmux mouse mode for this session
        const setting = msg.enabled ? 'on' : 'off';
        exec(`tmux set-option -t ${tmuxSessionName.replace(/'/g, "'\\''")} mouse ${setting}`, () => {});
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('close', () => {
    const s = sessions.get(tmuxSessionName);
    if (!s) return;

    s.clients.delete(ws);

    // If no clients remain, kill the PTY after a grace period
    // This detaches from tmux cleanly — tmux session itself lives on
    if (s.clients.size === 0) {
      s.cleanupTimer = setTimeout(() => {
        const current = sessions.get(tmuxSessionName);
        if (current && current.clients.size === 0) {
          current.pty.kill();
          sessions.delete(tmuxSessionName);
        }
      }, DETACH_GRACE_MS);
    }
  });
}

export function getActiveSessionNames(): string[] {
  return Array.from(sessions.keys());
}
