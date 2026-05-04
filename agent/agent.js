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
const net = require('net');

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

// ── Wiki init ─────────────────────────────────────────────────────────────
const { readFile: readFileAsync, writeFile } = require('fs/promises');

// Bundled template ships next to this file. Override with TERMAG_WIKI_TEMPLATE_PATH
// to point at a different one (e.g. an agent-wiki checkout that gets curated centrally).
const WIKI_TEMPLATE_PATH = process.env.TERMAG_WIKI_TEMPLATE_PATH
  || path.join(__dirname, 'initial-AGENTS.md');

async function initWikiFiles(dir, slug, username) {
  const agentsPath = path.join(dir, 'AGENTS.md');
  const claudePath = path.join(dir, 'CLAUDE.md');

  // Idempotent: skip if AGENTS.md already exists
  if (fs.existsSync(agentsPath)) {
    return { ok: true, skipped: true };
  }

  let templateRaw;
  try {
    templateRaw = await readFileAsync(WIKI_TEMPLATE_PATH, 'utf8');
  } catch (err) {
    console.error(
      `[INIT-WIKI] Cannot read template at ${WIKI_TEMPLATE_PATH}: ${err.message}. ` +
      `Set TERMAG_WIKI_TEMPLATE_PATH to override, or restore the bundled file at agent/initial-AGENTS.md. ` +
      `Project ${slug} will be created without AGENTS.md/CLAUDE.md.`
    );
    return { ok: false, error: 'Template not found', path: WIKI_TEMPLATE_PATH };
  }

  const today = new Date().toISOString().slice(0, 10);
  const content = templateRaw
    .replace(/<slug>/g, slug)
    .replace(/<project name>/g, slug)
    .replace(/YYYY-MM-DD/g, today)
    .replace(/<handle>/g, username);

  const created = [];

  await writeFile(agentsPath, content, 'utf8');
  created.push('AGENTS.md');

  if (!fs.existsSync(claudePath)) {
    await writeFile(claudePath, '@AGENTS.md\n', 'utf8');
    created.push('CLAUDE.md');
  }

  console.log(`[INIT-WIKI] Initialized ${created.join(', ')} for ${slug}`);
  return { ok: true, created };
}

// ── Usage scanner ──────────────────────────────────────────────────────────
const { readdir, readFile, stat } = require('fs/promises');

function ensureDay(days, date) {
  if (!days[date]) {
    days[date] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, calls: 0 };
  }
  return days[date];
}

async function scanClaudeUsage(days) {
  const claudeDir = path.join(process.env.HOME || '/home', '.claude', 'projects');

  let projectDirs;
  try {
    projectDirs = await readdir(claudeDir);
  } catch {
    return;
  }

  for (const dir of projectDirs) {
    const projectPath = path.join(claudeDir, dir);
    let files;
    try {
      const s = await stat(projectPath);
      if (!s.isDirectory()) continue;
      files = await readdir(projectPath);
    } catch { continue; }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      try {
        const content = await readFile(path.join(projectPath, file), 'utf8');
        for (const line of content.split('\n')) {
          if (!line) continue;
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }
          const msg = entry.message;
          if (!msg || typeof msg !== 'object' || !msg.usage) continue;

          const ts = entry.timestamp;
          if (!ts) continue;
          const date = new Date(ts).toISOString().slice(0, 10);

          const u = msg.usage;
          const d = ensureDay(days, date);
          d.input += u.input_tokens || 0;
          d.output += u.output_tokens || 0;
          d.cacheRead += u.cache_read_input_tokens || 0;
          d.cacheCreate += u.cache_creation_input_tokens || 0;
          d.calls += 1;
        }
      } catch { continue; }
    }
  }
}

async function scanCodexUsage(days) {
  const sessionsDir = path.join(process.env.HOME || '/home', '.codex', 'sessions');

  let years;
  try {
    years = await readdir(sessionsDir);
  } catch {
    return;
  }

  for (const year of years) {
    const yearPath = path.join(sessionsDir, year);
    let months;
    try { months = await readdir(yearPath); } catch { continue; }

    for (const month of months) {
      const monthPath = path.join(yearPath, month);
      let dayDirs;
      try { dayDirs = await readdir(monthPath); } catch { continue; }

      for (const dayDir of dayDirs) {
        const dayPath = path.join(monthPath, dayDir);
        let files;
        try {
          const s = await stat(dayPath);
          if (!s.isDirectory()) continue;
          files = await readdir(dayPath);
        } catch { continue; }

        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          try {
            const content = await readFile(path.join(dayPath, file), 'utf8');
            for (const line of content.split('\n')) {
              if (!line) continue;
              let entry;
              try { entry = JSON.parse(line); } catch { continue; }
              if (entry.type !== 'event_msg') continue;
              const payload = entry.payload;
              if (!payload || payload.type !== 'token_count') continue;
              const u = payload.info?.last_token_usage;
              if (!u) continue;

              const ts = entry.timestamp;
              if (!ts) continue;
              const date = new Date(ts).toISOString().slice(0, 10);

              const d = ensureDay(days, date);
              d.input += u.input_tokens || 0;
              d.output += u.output_tokens || 0;
              d.cacheRead += u.cached_input_tokens || 0;
              d.calls += 1;
            }
          } catch { continue; }
        }
      }
    }
  }
}

async function scanVibeUsage(days) {
  const sessionDir = path.join(process.env.HOME || '/home', '.vibe', 'logs', 'session');

  let sessionDirs;
  try {
    sessionDirs = await readdir(sessionDir);
  } catch {
    return;
  }

  for (const dir of sessionDirs) {
    // Directory name format: session_YYYYMMDD_HHMMSS_<id>
    const dateMatch = dir.match(/^session_(\d{4})(\d{2})(\d{2})_/);
    if (!dateMatch) continue;
    const date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;

    const metaPath = path.join(sessionDir, dir, 'meta.json');
    try {
      const content = await readFile(metaPath, 'utf8');
      const meta = JSON.parse(content);
      const s = meta.stats;
      if (!s) continue;

      const d = ensureDay(days, date);
      d.input += s.session_prompt_tokens || 0;
      d.output += s.session_completion_tokens || 0;
      d.calls += s.steps || 1;
    } catch { continue; }
  }
}

async function scanUsage() {
  const claude = {};
  const codex = {};
  const mistral = {};
  await Promise.all([
    scanClaudeUsage(claude),
    scanCodexUsage(codex),
    scanVibeUsage(mistral),
  ]);
  // Merge into combined totals
  const days = {};
  for (const src of [claude, codex, mistral]) {
    for (const [date, d] of Object.entries(src)) {
      const t = ensureDay(days, date);
      t.input += d.input;
      t.output += d.output;
      t.cacheRead += d.cacheRead;
      t.cacheCreate += d.cacheCreate;
      t.calls += d.calls;
    }
  }
  return { days, providers: { claude, codex, mistral } };
}

// ── Context token scanner ─────────────────────────────────────────────────
// Periodically reads the most recent JSONL entry per active Claude conversation
// and POSTs contextTokens to the status endpoint so the UI can warn about bloated contexts.

const CONTEXT_SCAN_INTERVAL_MS = 60_000;
let contextScanTimer = null;

async function scanContextTokens() {
  const username = process.env.USER || require('os').userInfo().username;
  const claudeDir = path.join(process.env.HOME || '/home', '.claude', 'projects');

  // Discover active agent sessions from tmux
  let sessions;
  try {
    const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}" 2>/dev/null');
    sessions = stdout.trim().split('\n')
      .filter(s => s.startsWith(`${username}-`) && s.endsWith('-agent'));
  } catch { return; }

  if (sessions.length === 0) return;

  // Build project name → session name map
  const projectSessions = new Map();
  for (const s of sessions) {
    // Session format: username-projectName-agent
    const afterUser = s.substring(username.length + 1);
    const projectName = afterUser.replace(/-agent$/, '');
    if (projectName) projectSessions.set(projectName, s);
  }

  // Read JSONL dirs and match to projects
  let projectDirs;
  try { projectDirs = await readdir(claudeDir); } catch { return; }

  const statusEndpoint = getStatusEndpoint();

  for (const dir of projectDirs) {
    // Dir names are paths with / replaced by -, e.g. "-home-secorp-termag-projects-card-depot"
    // Match against known project names
    let matchedSession = null;
    for (const [projName, sessName] of projectSessions) {
      if (dir.endsWith('-' + projName) || dir.endsWith(projName)) {
        matchedSession = sessName;
        break;
      }
    }
    if (!matchedSession) continue;

    const dirPath = path.join(claudeDir, dir);
    let files;
    try { files = await readdir(dirPath); } catch { continue; }

    // Find most recently modified .jsonl
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) continue;

    let newest = null, newestMtime = 0;
    for (const f of jsonlFiles) {
      try {
        const s = await stat(path.join(dirPath, f));
        if (s.mtimeMs > newestMtime) { newestMtime = s.mtimeMs; newest = f; }
      } catch { continue; }
    }
    if (!newest) continue;

    // Only scan if modified in last 10 minutes (active conversation)
    if (Date.now() - newestMtime > 10 * 60 * 1000) continue;

    // Read last ~8KB to find the last usage entry
    const filePath = path.join(dirPath, newest);
    try {
      const fileSize = (await stat(filePath)).size;
      const readSize = Math.min(8192, fileSize);
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, readSize, Math.max(0, fileSize - readSize));
      fs.closeSync(fd);

      const lines = buf.toString('utf8').split('\n').reverse();
      let contextTokens = null;
      for (const line of lines) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          const u = entry.message?.usage;
          if (u) {
            contextTokens = (u.input_tokens || 0)
              + (u.cache_read_input_tokens || 0)
              + (u.cache_creation_input_tokens || 0);
            break;
          }
        } catch { continue; }
      }

      if (contextTokens === null) continue;

      // POST context tokens to status endpoint (metadata-only, no status change)
      const payload = JSON.stringify({
        session: matchedSession,
        contextTokens,
      });
      const url = new URL(statusEndpoint);
      const http = require(url.protocol === 'https:' ? 'https' : 'http');
      const req = http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      });
      req.on('error', () => {});
      req.end(payload);
    } catch { continue; }
  }
}

function startContextScanner() {
  if (contextScanTimer) return;
  // Initial scan after 5s, then every 60s
  setTimeout(() => {
    scanContextTokens().catch(() => {});
    contextScanTimer = setInterval(() => scanContextTokens().catch(() => {}), CONTEXT_SCAN_INTERVAL_MS);
  }, 5000);
}

function stopContextScanner() {
  if (contextScanTimer) { clearInterval(contextScanTimer); contextScanTimer = null; }
}

// ── Rate limit scanner ────────────────────────────────────────────────────
// Periodically captures the last lines of agent tmux panes and checks for
// rate limit messages like "You've hit your ... limit · resets ..."

const RATE_LIMIT_SCAN_INTERVAL_MS = 30_000;
let rateLimitScanTimer = null;
// Track which sessions are currently flagged so we only POST on transitions
const rateLimitedSessions = new Map(); // session → message

async function scanRateLimits() {
  const username = process.env.USER || require('os').userInfo().username;

  let sessions;
  try {
    const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}" 2>/dev/null');
    sessions = stdout.trim().split('\n')
      .filter(s => s.startsWith(`${username}-`) && s.endsWith('-agent'));
  } catch { return; }

  if (sessions.length === 0) return;

  const statusEndpoint = getStatusEndpoint();

  for (const session of sessions) {
    try {
      // Get pane ID for reliable capture
      const { stdout: paneId } = await execAsync(
        `tmux list-panes -t ${shellEscape(session)} -F '#{pane_id}' 2>/dev/null`
      );
      const pid = paneId.trim().split('\n')[0];
      if (!pid) continue;

      // Capture last 10 visible lines — rate limit messages appear near the prompt,
      // not buried in scrollback output which could contain false positives
      const { stdout: paneContent } = await execAsync(
        `tmux capture-pane -t ${shellEscape(pid)} -p -S -10 2>/dev/null`
      );

      // Check for rate limit patterns — must match actual CLI error messages,
      // not arbitrary content that mentions "rate limit" as a concept
      const rateLimitPatterns = [
        /(?:hit your|reached your).*?limit.*?resets?\s+(.+)/i,
        /usage limit.*?resets?\s+(.+)/i,
        /Credit balance is too low/i,
        /temporarily limiting requests/i,
        /Now using extra usage/i,
      ];

      let limitMessage = null;
      for (const line of paneContent.split('\n').reverse()) {
        for (const pattern of rateLimitPatterns) {
          const match = line.match(pattern);
          if (match) {
            limitMessage = line.trim().slice(0, 100);
            break;
          }
        }
        if (limitMessage) break;
      }

      const wasLimited = rateLimitedSessions.get(session);

      if (limitMessage && !wasLimited) {
        // Newly rate-limited — POST to status
        rateLimitedSessions.set(session, limitMessage);
        const payload = JSON.stringify({ session, rateLimited: limitMessage });
        const url = new URL(statusEndpoint);
        const http = require(url.protocol === 'https:' ? 'https' : 'http');
        const req = http.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        });
        req.on('error', () => {});
        req.end(payload);
        console.log(`[RATE-LIMIT] Detected for ${session}: ${limitMessage}`);
      } else if (!limitMessage && wasLimited) {
        // No longer rate-limited (user cleared or limit reset) — clear it
        rateLimitedSessions.delete(session);
        const payload = JSON.stringify({ session, rateLimited: null });
        const url = new URL(statusEndpoint);
        const http = require(url.protocol === 'https:' ? 'https' : 'http');
        const req = http.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        });
        req.on('error', () => {});
        req.end(payload);
        console.log(`[RATE-LIMIT] Cleared for ${session}`);
      }
    } catch { continue; }
  }
}

function startRateLimitScanner() {
  if (rateLimitScanTimer) return;
  setTimeout(() => {
    scanRateLimits().catch(() => {});
    rateLimitScanTimer = setInterval(() => scanRateLimits().catch(() => {}), RATE_LIMIT_SCAN_INTERVAL_MS);
  }, 10000);
}

function stopRateLimitScanner() {
  if (rateLimitScanTimer) { clearInterval(rateLimitScanTimer); rateLimitScanTimer = null; }
}

// Active PTY streams: streamId → { pty, tmuxSessionName }
const streams = new Map();
const codexBridges = new Map();

function shellEscape(str) {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStatusEndpoint() {
  try {
    const wsUrl = new URL(termag_url);
    wsUrl.protocol = wsUrl.protocol === 'wss:' ? 'https:' : 'http:';
    wsUrl.pathname = wsUrl.pathname.replace(/\/ws\/agent$/, '/api/status');
    wsUrl.search = '';
    return wsUrl.toString();
  } catch {
    return 'http://127.0.0.1:3040/termag/api/status';
  }
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close((err) => {
        if (err) reject(err);
        else if (!port) reject(new Error('Failed to allocate a free port'));
        else resolve(port);
      });
    });
  });
}

function stopCodexBridge(sessionName) {
  const bridge = codexBridges.get(sessionName);
  if (!bridge) return;
  codexBridges.delete(sessionName);
  try { bridge.child.kill('SIGTERM'); } catch { /* ignore */ }
}

async function startCodexSession(sessionName, cwd) {
  stopCodexBridge(sessionName);

  const port = await getFreePort();
  const remoteUrl = `ws://127.0.0.1:${port}`;
  const bridgePath = path.join(__dirname, 'codex-status-bridge.js');
  const child = exec(
    [
      'node',
      shellEscape(bridgePath),
      '--session',
      shellEscape(sessionName),
      '--cwd',
      shellEscape(cwd),
      '--listen-port',
      String(port),
      '--listen-only',
      '--status-endpoint',
      shellEscape(getStatusEndpoint()),
    ].join(' '),
    { cwd, env: process.env },
  );

  codexBridges.set(sessionName, { child, port, remoteUrl });
  child.on('exit', () => {
    const current = codexBridges.get(sessionName);
    if (current?.child === child) {
      codexBridges.delete(sessionName);
    }
  });

  await execAsync(`tmux send-keys -t ${shellEscape(sessionName)} C-c`);
  await wait(200);
  await execAsync(`tmux send-keys -t ${shellEscape(sessionName)} ${shellEscape('clear')} Enter`);
  await wait(200);
  const codexCmd = `codex --remote ${remoteUrl} --no-alt-screen -C ${shellEscape(cwd)} -a on-request`;
  await execAsync(`tmux send-keys -t ${shellEscape(sessionName)} ${shellEscape(codexCmd)} Enter`);
  return { ok: true, remoteUrl, port };
}

function connect() {
  const url = `${termag_url}?token=${encodeURIComponent(token)}`;
  console.log(`[AGENT] Connecting to ${termag_url.replace(/\?.*/, '')}...`);

  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('[AGENT] Connected to termag');
    startContextScanner();
    startRateLimitScanner();
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
          // git init unless cwd is itself the toplevel of a git repo. Using
          // --show-toplevel (and comparing) avoids the false positive where the
          // project dir is *nested inside* an existing repo (e.g. someone
          // cloned termag into ~/termag/ so projects under ~/termag/projects/
          // walk up and find termag's own .git).
          let alreadyRepo = false;
          try {
            const { stdout } = await execAsync(`git -C ${shellEscape(cwd)} rev-parse --show-toplevel 2>/dev/null`);
            const realCwd = await fs.promises.realpath(cwd);
            const realTop = await fs.promises.realpath(stdout.trim());
            alreadyRepo = realTop === realCwd;
          } catch { /* not in a repo */ }
          if (!alreadyRepo) {
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
          stopCodexBridge(sessionName);
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

        case 'init-wiki': {
          const { dir, slug, username } = msg;
          const result = await initWikiFiles(dir, slug, username);
          respond(ws, requestId, result);
          break;
        }

        case 'codex-session-start': {
          const { sessionName, cwd } = msg;
          if (!sessionName || !cwd) throw new Error('sessionName and cwd are required');
          const result = await startCodexSession(sessionName, cwd);
          respond(ws, requestId, result);
          break;
        }

        case 'codex-session-stop': {
          const { sessionName } = msg;
          if (!sessionName) throw new Error('sessionName is required');
          stopCodexBridge(sessionName);
          respond(ws, requestId, { ok: true });
          break;
        }

        case 'terminal-attach': {
          const { tmuxSessionName, streamId, cols: initCols, rows: initRows } = msg;
          const term = pty.spawn('tmux', ['attach-session', '-t', tmuxSessionName], {
            name: 'xterm-256color',
            cols: initCols || 80,
            rows: initRows || 24,
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

        case 'usage-scan': {
          const result = await scanUsage();
          respond(ws, requestId, result);
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
    stopContextScanner();
    stopRateLimitScanner();
    // Kill all active PTY streams
    for (const [id, stream] of streams) {
      stream.pty.kill();
    }
    streams.clear();
    for (const sessionName of codexBridges.keys()) {
      stopCodexBridge(sessionName);
    }
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
  for (const sessionName of codexBridges.keys()) {
    stopCodexBridge(sessionName);
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[AGENT] Shutting down...');
  for (const [, stream] of streams) {
    stream.pty.kill();
  }
  for (const sessionName of codexBridges.keys()) {
    stopCodexBridge(sessionName);
  }
  process.exit(0);
});
