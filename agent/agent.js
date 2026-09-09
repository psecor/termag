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

// Load config. Resolution order:
//   1. process.argv[2] (explicit path, useful for systemd unit per-user configs)
//   2. <agent dir>/agent.config.json (default colocated config)
//   3. ~/.termag/agent.config.json (per-user fallback for shared-binary installs)
let configPath = process.argv[2] || path.join(__dirname, 'agent.config.json');
if (!fs.existsSync(configPath)) {
  const homeConfig = path.join(process.env.HOME || '/home', '.termag', 'agent.config.json');
  if (fs.existsSync(homeConfig)) {
    configPath = homeConfig;
  } else {
    console.error('agent.config.json not found. Copy agent.config.example.json and fill it in.');
    process.exit(1);
  }
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const { termag_url, token, reconnect_interval_seconds = 5, path_remap = {} } = config;

if (!termag_url || !token) {
  console.error('termag_url and token are required in agent.config.json');
  process.exit(1);
}

// Optional path remap: rewrite incoming paths (cwd/dir) so the agent can run
// on a host where the backend's hardcoded /home/<user>/... layout doesn't
// exist (e.g. macOS, where home dirs live under /Users/).
//
// Config example:
//   "path_remap": { "/home/psecor": "/Users/psecor" }
function remapPath(p) {
  if (!p || typeof p !== 'string') return p;
  for (const [from, to] of Object.entries(path_remap)) {
    if (p === from || p.startsWith(from + '/')) {
      return to + p.slice(from.length);
    }
  }
  return p;
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
// Read this many bytes from the END of the JSONL when hunting for the last
// message.usage entry. The tail of a log can be a long run of non-assistant
// lines (tool results, user messages, resume metadata) that push the real
// usage entry far back — an 8KB window was missing entries ~100KB deep.
const CONTEXT_READ_BYTES = 512 * 1024;
// A usage entry only reflects the CURRENT context if it's recent. Past this we
// treat context as unknown and clear the badge, so a stale reading (old
// conversation, post-/clear or /compact, or an idle resume that only bumps the
// file mtime) is expired rather than frozen on the UI.
const CONTEXT_FRESH_MS = 10 * 60 * 1000;
let contextScanTimer = null;
// Last contextTokens value POSTed per session (number or null), so we only POST
// on change instead of re-broadcasting an unchanged reading every scan.
const lastContextTokens = new Map();

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

  // Map each agent session to the Claude project-log dir for its working
  // directory. Claude encodes a cwd into its ~/.claude/projects dir name by
  // replacing both '/' and '.' with '-', so we reproduce that here. Keying on
  // the actual cwd (not a name parsed out of the session string) is what makes
  // non-main workstreams work: a worktree session lives in
  // <project>/.worktrees/<ws>, whose dir bears no relation to the session name.
  const dirToSession = new Map();
  for (const s of sessions) {
    let cwd;
    try {
      const { stdout } = await execAsync(`tmux display-message -p -t ${shellEscape(s)} '#{pane_current_path}'`);
      cwd = stdout.trim();
    } catch { continue; }
    if (!cwd) continue;
    dirToSession.set(cwd.replace(/[/.]/g, '-'), s);
  }

  // Read JSONL dirs and match to projects
  let projectDirs;
  try { projectDirs = await readdir(claudeDir); } catch { return; }

  const statusEndpoint = getStatusEndpoint();

  for (const dir of projectDirs) {
    // Dir names are cwds with '/' and '.' replaced by '-', e.g.
    // "-home-alice-termag-projects-foo" (main) or
    // "-home-alice-termag-projects-foo--worktrees-bar" (worktree "bar").
    // Exact-match the dir to the session whose cwd encodes to it.
    const matchedSession = dirToSession.get(dir);
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

    // Find the most recent usage entry by reading a large chunk from the END of
    // the file. The tail can be a long run of non-assistant lines (tool results,
    // user messages, resume metadata), so a small window misses the real entry.
    // We deliberately do NOT gate on the file's mtime: an idle resume can bump
    // mtime with no new turn. Instead we judge recency from the usage entry's
    // own timestamp and expire (null) anything stale so it isn't frozen on the UI.
    const filePath = path.join(dirPath, newest);
    let contextTokens = null;
    try {
      const fileSize = (await stat(filePath)).size;
      const readSize = Math.min(CONTEXT_READ_BYTES, fileSize);
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, readSize, Math.max(0, fileSize - readSize));
      fs.closeSync(fd);

      const lines = buf.toString('utf8').split('\n').reverse();
      for (const line of lines) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          const u = entry.message?.usage;
          if (!u) continue;
          // Only report if this turn is recent; otherwise leave contextTokens
          // null so the badge expires instead of showing a stale reading.
          const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
          if (Number.isFinite(ts) && Date.now() - ts <= CONTEXT_FRESH_MS) {
            contextTokens = (u.input_tokens || 0)
              + (u.cache_read_input_tokens || 0)
              + (u.cache_creation_input_tokens || 0);
          }
          break; // most recent usage entry found — stop regardless of recency
        } catch { continue; }
      }
    } catch { continue; }

    // Only POST when the value changed (including a change to null), so we don't
    // re-broadcast an unchanged reading every scan. A null POST clears a
    // previously-reported value on the badge.
    if (lastContextTokens.get(matchedSession) === contextTokens) continue;
    lastContextTokens.set(matchedSession, contextTokens);

    // POST to the status endpoint (metadata-only, no status change).
    const payload = JSON.stringify({ session: matchedSession, contextTokens });
    const url = new URL(statusEndpoint);
    const http = require(url.protocol === 'https:' ? 'https' : 'http');
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Authorization': `Bearer ${token}` },
    });
    req.on('error', () => {});
    req.end(payload);
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
        const trimmed = line.trim();
        // Skip lines that are clearly inside tool output, JSON, quotes, or curl commands
        if (!trimmed) continue;
        if (trimmed.startsWith('⎿') || trimmed.startsWith('"') || trimmed.startsWith('{')
            || trimmed.startsWith('…') || trimmed.startsWith('●') || trimmed.startsWith('-d')
            || /^\s*curl\s/.test(line)) continue;
        for (const pattern of rateLimitPatterns) {
          const match = trimmed.match(pattern);
          if (match) {
            limitMessage = trimmed.slice(0, 100);
            break;
          }
        }
        if (limitMessage) break;
      }

      // ── Stale "waiting" correction ──
      // If the status API says this session is "waiting" but the pane shows
      // signs of active execution (elapsed time, spinner), correct it to "working".
      // This covers the gap where no hook fires between permission approval and
      // tool completion.
      const activePatterns = [
        /\(\d+[ms]\s+\d+s\s+·/,       // e.g. "(2m 49s · ↓ 653 tokens)"
        /\(\d+s\s+·/,                   // e.g. "(15s · timeout 10m)"
        /✢\s+\S/,                       // ✢ spinner with text
        /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,       // braille spinner chars
      ];
      const looksActive = paneContent.split('\n').some(line =>
        activePatterns.some(p => p.test(line))
      );
      if (looksActive) {
        try {
          const statusUrl = `${statusEndpoint}/${encodeURIComponent(session)}`;
          const statusRes = await new Promise((resolve, reject) => {
            const url = new URL(statusUrl);
            const http = require(url.protocol === 'https:' ? 'https' : 'http');
            const req = http.get(url, (res) => {
              let body = '';
              res.on('data', (c) => body += c);
              res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
            });
            req.on('error', () => resolve(null));
          });
          if (statusRes && statusRes.status === 'waiting') {
            const payload = JSON.stringify({ session, status: 'working' });
            const url = new URL(statusEndpoint);
            const http = require(url.protocol === 'https:' ? 'https' : 'http');
            const req = http.request(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Authorization': `Bearer ${token}` },
            });
            req.on('error', () => {});
            req.end(payload);
            console.log(`[STATUS-FIX] Corrected ${session} from waiting → working (pane shows active execution)`);
          }
        } catch { /* ignore */ }
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
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Authorization': `Bearer ${token}` },
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
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Authorization': `Bearer ${token}` },
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

// ── Browser clipboard mailbox ─────────────────────────────────────────────
// One-shot drop point for an image pasted in the browser. Written here, read
// (and deleted) by agent/xclip-shim.sh on Claude Code's behalf.
const CLIPBOARD_DIR = path.join(process.env.HOME || '/home', '.cache', 'termag');
const CLIPBOARD_SLOT = path.join(CLIPBOARD_DIR, 'clipboard.png');
const CLIPBOARD_MAX_BYTES = 20 * 1024 * 1024;

function ensureClipboardShim() {
  const shim = fs.readFileSync(path.join(__dirname, 'xclip-shim.sh'), 'utf8');
  const binDir = path.join(process.env.HOME || '/home', '.local', 'bin');
  const dest = path.join(binDir, 'xclip');
  let installed = null;
  try {
    installed = fs.readFileSync(dest, 'utf8');
  } catch { /* not installed yet */ }
  if (installed === shim) return;
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(dest, shim, { mode: 0o755 });
  // writeFileSync's mode only applies when it creates the file.
  fs.chmodSync(dest, 0o755);
  console.log(`[CLIPBOARD] installed xclip shim at ${dest}`);
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
    // Pass the bearer token via env, NOT argv: process command lines are
    // world-readable (/proc/<pid>/cmdline, ps) on shared hosts, but environ is
    // readable only by the owner + root. The bridge reads TERMAG_STATUS_BEARER_TOKEN.
    { cwd, env: { ...process.env, TERMAG_STATUS_BEARER_TOKEN: token } },
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
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const hb = setInterval(() => {
      if (!alive) {
        console.log('[AGENT] Heartbeat lost, terminating socket');
        ws.terminate();
        return;
      }
      alive = false;
      try { ws.ping(); } catch {}
    }, 30_000);
    ws.once('close', () => clearInterval(hb));
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
          const { sessionName } = msg;
          const cwd = remapPath(msg.cwd);
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
            // Let tmux copy operations (copy-mode y/M-w, mouse drag-end) emit
            // OSC 52 so selections reach the browser clipboard via xterm.js.
            // set-clipboard is a server option; -g applies it to all sessions.
            await execAsync(`tmux set-option -g set-clipboard on`);
            await execAsync(`tmux set-option -ga terminal-features ',xterm-256color:clipboard'`);
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

        case 'tmux-list': {
          try {
            const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}" 2>/dev/null');
            const sessions = stdout.split('\n').map(s => s.trim()).filter(Boolean);
            respond(ws, requestId, { sessions });
          } catch {
            respond(ws, requestId, { sessions: [] });
          }
          break;
        }

        case 'tmux-foreground-cmd': {
          const { sessionName } = msg;
          try {
            const { stdout } = await execAsync(
              `tmux list-panes -t ${shellEscape(sessionName)} -F '#{pane_current_command}'`
            );
            const cmd = stdout.trim().split('\n')[0] ?? null;
            respond(ws, requestId, { cmd });
          } catch {
            // Session doesn't exist or tmux not available
            respond(ws, requestId, { cmd: null });
          }
          break;
        }

        case 'tmux-capture': {
          const { sessionName } = msg;
          const requestedLines = parseInt(msg.lines, 10);
          const lines = Number.isFinite(requestedLines)
            ? Math.max(1, Math.min(1000, requestedLines))
            : 200;
          try {
            const { stdout } = await execAsync(
              `tmux capture-pane -t ${shellEscape(sessionName)} -p -S -${lines}`,
              { maxBuffer: 4 * 1024 * 1024 }
            );
            respond(ws, requestId, { content: stdout });
          } catch (err) {
            respond(ws, requestId, null, err.message);
          }
          break;
        }

        case 'mkdir': {
          const dir = remapPath(msg.dir);
          await mkdir(dir, { recursive: true });
          respond(ws, requestId, { ok: true });
          break;
        }

        case 'init-wiki': {
          const { slug, username } = msg;
          const dir = remapPath(msg.dir);
          const result = await initWikiFiles(dir, slug, username);
          respond(ws, requestId, result);
          break;
        }

        case 'git-worktree-add': {
          // Create a git worktree at <projectDir>/.worktrees/<worktreeName>,
          // checked out on a new branch <branch> based at <baseRef> (defaults
          // to HEAD). The worktree lives inside the main project dir so it
          // travels along on rename and stays grouped with its parent.
          const projectDir = remapPath(msg.projectDir);
          const { worktreeName, branch, baseRef } = msg;
          if (!projectDir || !worktreeName || !branch) {
            throw new Error('projectDir, worktreeName, and branch are required');
          }
          const worktreePath = `${projectDir}/.worktrees/${worktreeName}`;
          const ref = baseRef || 'HEAD';
          await execAsync(
            `git -C ${shellEscape(projectDir)} worktree add -b ${shellEscape(branch)} ${shellEscape(worktreePath)} ${shellEscape(ref)}`
          );
          respond(ws, requestId, { ok: true, path: worktreePath });
          break;
        }

        case 'git-worktree-remove': {
          // Remove the worktree at <projectDir>/.worktrees/<worktreeName>,
          // then drop the branch we created alongside it (when caller supplies
          // a `branch`). force=true maps to `worktree remove --force` *and*
          // `branch -D`; without it, git refuses on dirty/unmerged state.
          //
          // The branch delete is best-effort: worktree removal is the
          // load-bearing step. A leftover branch is surfaced as a warning so
          // the caller can decide whether to clean up.
          const projectDir = remapPath(msg.projectDir);
          const { worktreeName, branch, force } = msg;
          if (!projectDir || !worktreeName) {
            throw new Error('projectDir and worktreeName are required');
          }
          const worktreePath = `${projectDir}/.worktrees/${worktreeName}`;
          const forceFlag = force ? ' --force' : '';
          await execAsync(
            `git -C ${shellEscape(projectDir)} worktree remove${forceFlag} ${shellEscape(worktreePath)}`
          );
          let branchDeleteWarning = null;
          if (branch) {
            const flag = force ? '-D' : '-d';
            try {
              await execAsync(
                `git -C ${shellEscape(projectDir)} branch ${flag} ${shellEscape(branch)}`
              );
            } catch (err) {
              branchDeleteWarning = err.message.trim().split('\n').pop();
              console.error(`[AGENT] branch ${flag} ${branch} failed: ${branchDeleteWarning}`);
            }
          }
          respond(ws, requestId, { ok: true, branchDeleteWarning });
          break;
        }

        case 'codex-session-start': {
          const { sessionName } = msg;
          const cwd = remapPath(msg.cwd);
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
          // Ensure OSC 52 clipboard passthrough is on for THIS attach. These are
          // server-global options, but tmux only picks up the create-time values
          // for freshly created sessions — a long-lived tmux server whose session
          // predates the clipboard change never gets them. Setting them here (on
          // every attach) is idempotent and guarantees copy-selection emits
          // OSC 52 to the client we're about to spawn, regardless of session age.
          try {
            await execAsync(`tmux set-option -g set-clipboard on`);
            await execAsync(`tmux set-option -ga terminal-features ',xterm-256color:clipboard'`);
          } catch { /* tmux may not support the option; harmless */ }
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
            // node-pty doesn't expose a public destroy(); reach for the
            // internal socket so the master PTY fd releases as soon as the
            // child exits, instead of after the library's 1s grace timer
            // (which races with bulk-kills on WS-close and leaves the fd
            // in REVOKED state — the original cause of the posix_spawnp
            // exhaustion). _socket is stable across all of node-pty v1.x;
            // re-audit on any major bump.
            try { term._socket && term._socket.destroy(); } catch {}
          });

          respond(ws, requestId, { ok: true, streamId });
          break;
        }

        case 'terminal-input': {
          const stream = streams.get(msg.streamId);
          if (stream) stream.pty.write(msg.data);
          break;
        }

        case 'terminal-paste-image': {
          const stream = streams.get(msg.streamId);
          if (!stream) break;
          const image = Buffer.from(msg.data || '', 'base64');
          if (image.length === 0) break;
          if (image.length > CLIPBOARD_MAX_BYTES) {
            console.error(`[CLIPBOARD] dropping ${image.length}-byte paste (limit ${CLIPBOARD_MAX_BYTES})`);
            break;
          }
          await mkdir(CLIPBOARD_DIR, { recursive: true });
          const tmpSlot = `${CLIPBOARD_SLOT}.tmp-${process.pid}`;
          await writeFile(tmpSlot, image);
          await fs.promises.rename(tmpSlot, CLIPBOARD_SLOT);
          // Ctrl+V makes Claude Code read the mailbox immediately, so the
          // keystroke only goes out once the file is fully in place.
          stream.pty.write('\x16');
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
            try { stream.pty.kill(); } catch {}
            try { stream.pty._socket && stream.pty._socket.destroy(); } catch {}
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
    // Kill all active PTY streams. Without the explicit socket destroy
    // here, node-pty's internal 1s setTimeout races with the WS reconnect
    // and the master fds end up pinned to the process in REVOKED state.
    for (const [id, stream] of streams) {
      try { stream.pty.kill(); } catch {}
      try { stream.pty._socket && stream.pty._socket.destroy(); } catch {}
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
if (process.platform === 'linux') {
  try {
    ensureClipboardShim();
  } catch (err) {
    console.error(`[CLIPBOARD] could not install xclip shim: ${err.message}`);
  }
}
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
