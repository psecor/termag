#!/usr/bin/env node
/**
 * termag user-agent
 *
 * Runs as the unix user. Connects to the termag server via WebSocket and
 * handles all per-user operations: tmux sessions, directories, PTY streams.
 *
 * Setup:
 *   1. Log into termag web UI and generate an agent token
 *   2. cp agent.config.example.json agent.config.json
 *   3. Paste the token
 *   4. npm install && node agent.js
 */

const WebSocket = require('ws');
const pty = require('node-pty');
const { exec } = require('child_process');
const { mkdir } = require('fs/promises');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

// Load config
const configPath = path.join(__dirname, 'agent.config.json');
if (!fs.existsSync(configPath)) {
  // Also check ~/.termag/agent.config.json
  const homeConfig = path.join(process.env.HOME || '/home', '.termag', 'agent.config.json');
  if (fs.existsSync(homeConfig)) {
    Object.assign(module, { configPath: homeConfig });
  } else {
    console.error('agent.config.json not found. Copy agent.config.example.json and fill it in.');
    process.exit(1);
  }
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const { termag_url, token, reconnect_interval_seconds = 5 } = config;

if (!termag_url || !token) {
  console.error('termag_url and token are required in agent.config.json');
  process.exit(1);
}

// Active PTY streams: streamId → { pty, tmuxSessionName }
const streams = new Map();

function shellEscape(str) {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

function connect() {
  const url = `${termag_url}?token=${encodeURIComponent(token)}`;
  console.log(`[AGENT] Connecting to ${termag_url.replace(/\?.*/, '')}...`);

  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('[AGENT] Connected to termag');
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { requestId, type } = msg;

    try {
      switch (type) {
        case 'tmux-create': {
          const { sessionName, cwd } = msg;
          await mkdir(cwd, { recursive: true });
          // git init if not already a repo
          try {
            await execAsync(`git -C ${shellEscape(cwd)} rev-parse --git-dir 2>/dev/null`);
          } catch {
            await execAsync(`git init ${shellEscape(cwd)}`);
          }
          // Create tmux session
          try {
            await execAsync(`tmux has-session -t ${shellEscape(sessionName)} 2>/dev/null`);
            // Already exists
          } catch {
            await execAsync(`tmux new-session -d -s ${shellEscape(sessionName)} -c ${shellEscape(cwd)} -x 120 -y 30`);
            await execAsync(`tmux set-option -t ${shellEscape(sessionName)} -w window-size largest`);
            await execAsync(`tmux set-option -t ${shellEscape(sessionName)} history-limit 10000`);
          }
          respond(ws, requestId, { ok: true });
          break;
        }

        case 'tmux-kill': {
          const { sessionName } = msg;
          try {
            await execAsync(`tmux kill-session -t ${shellEscape(sessionName)}`);
          } catch { /* may not exist */ }
          respond(ws, requestId, { ok: true });
          break;
        }

        case 'tmux-send-keys': {
          const { sessionName, keys, withEnter } = msg;
          const enter = withEnter ? ' Enter' : '';
          const escaped = shellEscape(keys.replace(/'/g, "'\\''"));
          await execAsync(`tmux send-keys -t ${shellEscape(sessionName)} ${escaped}${enter}`);
          respond(ws, requestId, { ok: true });
          break;
        }

        case 'tmux-has-session': {
          const { sessionName } = msg;
          try {
            await execAsync(`tmux has-session -t ${shellEscape(sessionName)} 2>/dev/null`);
            respond(ws, requestId, { exists: true });
          } catch {
            respond(ws, requestId, { exists: false });
          }
          break;
        }

        case 'mkdir': {
          const { dir } = msg;
          await mkdir(dir, { recursive: true });
          respond(ws, requestId, { ok: true });
          break;
        }

        case 'terminal-attach': {
          const { tmuxSessionName, streamId } = msg;
          const term = pty.spawn('tmux', ['attach-session', '-t', tmuxSessionName], {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: process.env.HOME || '/home',
            env: {
              HOME: process.env.HOME || '/home',
              USER: process.env.USER || 'unknown',
              SHELL: process.env.SHELL || '/bin/bash',
              TERM: 'xterm-256color',
              PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
              LANG: process.env.LANG || 'en_US.UTF-8',
            },
          });

          streams.set(streamId, { pty: term, tmuxSessionName });

          term.onData((data) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'terminal-data', streamId, data }));
            }
          });

          term.onExit(() => {
            streams.delete(streamId);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'terminal-exit', streamId }));
            }
          });

          respond(ws, requestId, { ok: true, streamId });
          break;
        }

        case 'terminal-input': {
          const stream = streams.get(msg.streamId);
          if (stream) stream.pty.write(msg.data);
          break;
        }

        case 'terminal-resize': {
          const stream = streams.get(msg.streamId);
          if (stream && msg.cols && msg.rows) {
            stream.pty.resize(msg.cols, msg.rows);
          }
          break;
        }

        case 'terminal-mouse': {
          const stream = streams.get(msg.streamId);
          if (stream) {
            const setting = msg.enabled ? 'on' : 'off';
            exec(`tmux set-option -t ${shellEscape(stream.tmuxSessionName)} mouse ${setting}`, () => {});
          }
          break;
        }

        case 'terminal-close': {
          const stream = streams.get(msg.streamId);
          if (stream) {
            stream.pty.kill();
            streams.delete(msg.streamId);
          }
          break;
        }

        default:
          if (requestId) {
            respond(ws, requestId, null, `Unknown command: ${type}`);
          }
      }
    } catch (err) {
      console.error(`[AGENT] Error handling ${type}:`, err.message);
      if (requestId) {
        respond(ws, requestId, null, err.message);
      }
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[AGENT] Disconnected (${code}). Reconnecting in ${reconnect_interval_seconds}s...`);
    // Kill all active PTY streams
    for (const [id, stream] of streams) {
      stream.pty.kill();
    }
    streams.clear();
    setTimeout(connect, reconnect_interval_seconds * 1000);
  });

  ws.on('error', (err) => {
    console.error('[AGENT] WebSocket error:', err.message);
  });
}

function respond(ws, requestId, data, error) {
  if (!requestId) return;
  const msg = error
    ? { requestId, error }
    : { requestId, data };
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

console.log(`[AGENT] termag user-agent starting as ${process.env.USER || 'unknown'}`);
connect();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[AGENT] Shutting down...');
  for (const [, stream] of streams) {
    stream.pty.kill();
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[AGENT] Shutting down...');
  for (const [, stream] of streams) {
    stream.pty.kill();
  }
  process.exit(0);
});
