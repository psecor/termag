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
const { exec, execFile } = require('child_process');
const { mkdir } = require('fs/promises');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { sendKeysArgv, enterArgv, captureArgv, tailLines, newSessionArgv, newSessionOptionArgvs, tmuxSessionTarget, CAPABILITIES: TMUX_CAPABILITIES } = require('./tmux-args');
const hostSample = require('./host-sample');
const runnerSessions = require('./runner-sessions');
const { renameProject } = require('./project-rename');
const { gitBranchState } = require('./git-branch-state');
const { dialArgs, refusedForWantOfQueryToken, redialDelayMs, DRAIN_CLOSE_CODE } = require('./agent-dial');
const credentials = require('./credentials');
const { planOnClaim, renderOnClaimEnv, createStatusForwarder } = require('./on-claim');
const boxUpdate = require('./box-update');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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
// Lives in usage-scanner.js (deduped, incrementally cached; schema 2 with
// per-directory buckets so the backend can attribute tokens to projects).
const { readdir, readFile, stat } = require('fs/promises');
const { createScanner } = require('./usage-scanner');
const usageScanner = createScanner({ home: process.env.HOME || '/home', pathRemap: path_remap });

// ── Background scan plumbing ──────────────────────────────────────────────
// Every call a periodic scan makes is bounded, and the next run is armed only
// once the previous one settles, so a wedged tmux server or an unresponsive
// backend delays scans instead of stacking child processes and sockets.
const TMUX_QUERY_TIMEOUT_MS = 10_000;
const STATUS_HTTP_TIMEOUT_MS = 10_000;

function tmuxQuery(args) {
  return execFileAsync('tmux', args, { timeout: TMUX_QUERY_TIMEOUT_MS, killSignal: 'SIGKILL' });
}

function postStatus(statusEndpoint, body) {
  const payload = JSON.stringify(body);
  const url = new URL(statusEndpoint);
  const http = require(url.protocol === 'https:' ? 'https' : 'http');
  const req = http.request(url, {
    method: 'POST',
    timeout: STATUS_HTTP_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Authorization': `Bearer ${token}` },
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => {});
  req.end(payload);
}

// Resolves to the session's status record, or null on any failure.
function getStatus(statusEndpoint, session) {
  return new Promise((resolve) => {
    const url = new URL(`${statusEndpoint}/${encodeURIComponent(session)}`);
    const http = require(url.protocol === 'https:' ? 'https' : 'http');
    const req = http.get(url, {
      timeout: STATUS_HTTP_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// Returns a stop function. A run in flight when stopped finishes but does not re-arm.
function startScanLoop(scan, firstDelayMs, intervalMs) {
  let stopped = false;
  let timer = null;
  const tick = async () => {
    try { await scan(); } catch { /* next run retries */ }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, firstDelayMs);
  return () => { stopped = true; clearTimeout(timer); };
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
let stopContextScan = null;
// Last contextTokens value POSTed per session (number or null), so we only POST
// on change instead of re-broadcasting an unchanged reading every scan.
const lastContextTokens = new Map();

async function scanContextTokens() {
  const username = process.env.USER || require('os').userInfo().username;
  const claudeDir = path.join(process.env.HOME || '/home', '.claude', 'projects');

  // Discover active agent sessions from tmux: project panes (`-agent`) and
  // Claude Code cloud sessions' runner sessions (runner-sessions.js), whose
  // transcripts live in the session's own config dir, not ~/.claude.
  let sessions;
  try {
    const { stdout } = await tmuxQuery(['list-sessions', '-F', '#{session_name}']);
    sessions = stdout.trim().split('\n')
      .filter(s => (s.startsWith(`${username.replace(/[.:]/g, '_')}-`) && s.endsWith('-agent')) || runnerSessions.isRunnerSessionName(s, username));
  } catch { return; }

  if (sessions.length === 0) return;

  // Map each session to the Claude project-log dir(s) for its working
  // directory. Claude encodes a cwd into its projects dir name by replacing
  // both '/' and '.' with '-', so we reproduce that here. Keying on the actual
  // cwd (not a name parsed out of the session string) is what makes non-main
  // workstreams work: a worktree session lives in <project>/.worktrees/<ws>,
  // whose dir bears no relation to the session name. A runner session's dir
  // is under its base dir's _sessions/<id>.claude-config/projects/, and its
  // base dir is named by the order id in the session name.
  const targets = [];
  const home = process.env.HOME || '/home';
  for (const s of sessions) {
    if (runnerSessions.isRunnerSessionName(s, username)) {
      // The pane's cwd is the runner state dir (the backend starts it there),
      // so the base dir comes from the order id in the name.
      const base = runnerSessions.runnerBaseDir(home, runnerSessions.orderFromRunnerSession(s, username), process.env.CLAUDE_RUNNER_ROOT);
      for (const dirPath of await runnerSessions.runnerProjectDirs(base)) targets.push({ session: s, dirPath });
      continue;
    }
    let cwd;
    try {
      const { stdout } = await tmuxQuery(['display-message', '-p', '-t', s, '#{pane_current_path}']);
      cwd = stdout.trim();
    } catch { continue; }
    if (!cwd) continue;
    targets.push({ session: s, dirPath: path.join(claudeDir, runnerSessions.encodeClaudeDir(cwd)) });
  }

  const statusEndpoint = getStatusEndpoint();

  for (const { session: matchedSession, dirPath } of targets) {
    // A dir exists only once the session has written a transcript there.
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
      try {
        fs.readSync(fd, buf, 0, readSize, Math.max(0, fileSize - readSize));
      } finally {
        fs.closeSync(fd);
      }

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
    postStatus(statusEndpoint, { session: matchedSession, contextTokens });
  }
}

function startContextScanner() {
  if (stopContextScan) return;
  stopContextScan = startScanLoop(scanContextTokens, 5000, CONTEXT_SCAN_INTERVAL_MS);
}

function stopContextScanner() {
  if (stopContextScan) { stopContextScan(); stopContextScan = null; }
}

// ── On-warm status poller ─────────────────────────────────────────────────
// termag-on-warm.service has no way to talk to the backend itself, so it
// publishes progress to a file (the contract is in deploy/termag-hook-run) and
// this forwards every change. Only ever started by the backend's on-warm-start
// RPC, because an owned box has no warm run to report.

const ON_WARM_POLL_INTERVAL_MS = 2000;
const ON_WARM_STATUS_FILE = path.join(process.env.HOME || '/home', '.termag', 'on-warm.status.json');
let onWarmPollTimer = null;
// The exact bytes last forwarded. The runner rewrites the file only at script
// boundaries, so comparing raw text is both the cheapest change detector and
// an exact one.
let onWarmLastSent = null;

function pollOnWarmStatus(ws) {
  let raw;
  // Absent until the unit's first write, which is normal for the first tick or
  // two after the start job is queued.
  try { raw = fs.readFileSync(ON_WARM_STATUS_FILE, 'utf8'); } catch { return; }
  if (raw === onWarmLastSent) return;

  let report;
  try { report = JSON.parse(raw); } catch { return; }
  if (ws.readyState !== WebSocket.OPEN) return;

  onWarmLastSent = raw;
  // `type` goes after the spread. A status file that carried its own `type`
  // would otherwise redirect this frame at another backend handler.
  ws.send(JSON.stringify({ ...report, type: 'on-warm-status' }));

  if (report.state !== 'running') {
    console.log(`[ON-WARM] run ${report.state}, stopping the poller`);
    stopOnWarmPoller();
  }
}

function startOnWarmPoller(ws) {
  if (onWarmPollTimer) return;
  // Cleared rather than kept across runs, because after a reconnect the file
  // is usually byte-identical to what the previous socket forwarded and the
  // new backend connection has not seen any of it.
  onWarmLastSent = null;
  // Interval armed before the first read, so a file that is already terminal
  // (the reconnect case) gets forwarded once and then stops the poller instead
  // of leaving it running against a finished run.
  onWarmPollTimer = setInterval(() => pollOnWarmStatus(ws), ON_WARM_POLL_INTERVAL_MS);
  pollOnWarmStatus(ws);
}

function stopOnWarmPoller() {
  if (onWarmPollTimer) { clearInterval(onWarmPollTimer); onWarmPollTimer = null; }
}

// ── On-claim status poller ────────────────────────────────────────────────
// Same file contract as the warm run, for the optional dotfiles oneshot.
const ON_CLAIM_POLL_INTERVAL_MS = 2000;
const TERMAG_STATE_DIR = path.join(process.env.HOME || '/home', '.termag');
const ON_CLAIM_STATUS_FILE = path.join(TERMAG_STATE_DIR, 'on-claim.status.json');
const ON_CLAIM_ENV_FILE = path.join(TERMAG_STATE_DIR, 'on-claim.env');
const ON_CLAIM_URL_FILE = path.join(TERMAG_STATE_DIR, 'dotfiles-repo-url');
const ON_CLAIM_UNIT = 'termag-on-claim.service';
let onClaimTimer = null;
let onClaimForwarder = null;

// One forwarder per socket, armed on open and disarmed on close. It watches
// the status file for as long as the socket is up, so a run that ends while
// disconnected, and a later rerun of the claim hook, are forwarded too. A box
// that never had a claim run has no status file and sends nothing.
function startOnClaimForwarder(ws) {
  stopOnClaimForwarder();
  onClaimForwarder = createStatusForwarder({
    read: () => fs.readFileSync(ON_CLAIM_STATUS_FILE, 'utf8'),
    send: (frame) => ws.send(JSON.stringify(frame)),
    isOpen: () => ws.readyState === WebSocket.OPEN,
  });
  const forwarder = onClaimForwarder;
  onClaimTimer = setInterval(() => forwarder.tick(), ON_CLAIM_POLL_INTERVAL_MS);
  forwarder.tick();
}

function stopOnClaimForwarder() {
  if (onClaimTimer) { clearInterval(onClaimTimer); onClaimTimer = null; }
  onClaimForwarder = null;
}

async function onClaimUnitState() {
  try {
    const { stdout } = await execFileAsync('systemctl', ['--user', 'is-active', ON_CLAIM_UNIT]);
    return String(stdout).trim();
  } catch (err) {
    const stdout = err && err.stdout ? String(err.stdout) : '';
    return stdout.trim() || 'unknown';
  }
}

async function prepareOnClaim(payload) {
  const unitState = await onClaimUnitState();
  let existingState = null;
  try {
    existingState = JSON.parse(fs.readFileSync(ON_CLAIM_STATUS_FILE, 'utf8')).state;
  } catch { /* first run */ }
  const plan = planOnClaim({
    unitState,
    hasWork: Boolean(payload.dotfilesRepoUrl),
    existingState,
  });
  fs.mkdirSync(TERMAG_STATE_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(TERMAG_STATE_DIR, 0o700); } catch { /* already tightened */ }
  if (payload.dotfilesRepoUrl) {
    fs.writeFileSync(ON_CLAIM_URL_FILE, `${payload.dotfilesRepoUrl}\n`, { mode: 0o644 });
  }
  if (!plan.write) return plan;
  const tmp = `${ON_CLAIM_ENV_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, renderOnClaimEnv(payload), { mode: 0o600 });
  fs.renameSync(tmp, ON_CLAIM_ENV_FILE);
  try { fs.unlinkSync(ON_CLAIM_STATUS_FILE); } catch { /* none yet */ }
  return plan;
}

// ── Rate limit scanner ────────────────────────────────────────────────────
// Periodically captures the last lines of agent tmux panes and checks for
// rate limit messages like "You've hit your ... limit · resets ..."

const RATE_LIMIT_SCAN_INTERVAL_MS = 30_000;
// Non-blank lines above the bottom of the pane that are inspected. Claude's
// prompt box and status line take ~5 of them; the error sits just above.
const RATE_LIMIT_SCAN_LINES = 15;
let stopRateLimitScan = null;
// Track which sessions are currently flagged so we only POST on transitions
const rateLimitedSessions = new Map(); // session → message

async function scanRateLimits() {
  const username = process.env.USER || require('os').userInfo().username;

  let sessions;
  try {
    const { stdout } = await tmuxQuery(['list-sessions', '-F', '#{session_name}']);
    sessions = stdout.trim().split('\n')
      .filter(s => s.startsWith(`${username.replace(/[.:]/g, '_')}-`) && s.endsWith('-agent'));
  } catch { return; }

  if (sessions.length === 0) return;

  const statusEndpoint = getStatusEndpoint();

  for (const session of sessions) {
    try {
      // Get pane ID for reliable capture
      const { stdout: paneId } = await tmuxQuery(['list-panes', '-t', session, '-F', '#{pane_id}']);
      const pid = paneId.trim().split('\n')[0];
      if (!pid) continue;

      // Only the lines next to the prompt: provider errors are printed right
      // above it, while anything higher up is conversation that may merely
      // *mention* a rate-limit message (an assistant quoting one flagged a
      // session for as long as the text stayed on a tall screen).
      // `captureArgv(..., { lines })` is "scrollback + whole visible pane",
      // so take the tail here instead.
      const { stdout: visible } = await tmuxQuery(captureArgv(pid, { lines: 0 }));
      const paneContent = tailLines(visible, RATE_LIMIT_SCAN_LINES);

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
        const statusRes = await getStatus(statusEndpoint, session);
        if (statusRes && statusRes.status === 'waiting') {
          postStatus(statusEndpoint, { session, status: 'working' });
          console.log(`[STATUS-FIX] Corrected ${session} from waiting → working (pane shows active execution)`);
        }
      }

      const wasLimited = rateLimitedSessions.get(session);

      if (limitMessage && !wasLimited) {
        // Newly rate-limited — POST to status
        rateLimitedSessions.set(session, limitMessage);
        postStatus(statusEndpoint, { session, rateLimited: limitMessage });
        console.log(`[RATE-LIMIT] Detected for ${session}: ${limitMessage}`);
      } else if (!limitMessage && wasLimited) {
        // No longer rate-limited (user cleared or limit reset) — clear it
        rateLimitedSessions.delete(session);
        postStatus(statusEndpoint, { session, rateLimited: null });
        console.log(`[RATE-LIMIT] Cleared for ${session}`);
      }
    } catch { continue; }
  }
}

function startRateLimitScanner() {
  if (stopRateLimitScan) return;
  stopRateLimitScan = startScanLoop(scanRateLimits, 10000, RATE_LIMIT_SCAN_INTERVAL_MS);
}

function stopRateLimitScanner() {
  if (stopRateLimitScan) { stopRateLimitScan(); stopRateLimitScan = null; }
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

credentials.configure({ agentConfig: path.resolve(configPath) });

// The commit this process runs, read once at startup from the checkout agent/
// is part of (agent/box-update.js). The orchestrator compares it with what a
// current box runs and asks a box that is behind to update. A
// checkout pulled since the agent started still runs the old code, and that
// is what this reports, which is the point. Null outside a git checkout.
const CHECKOUT_DIR = path.resolve(__dirname, '..');
let agentCommit = null;
// When that commit was made (ISO 8601), beside it in the hello: the admin
// Fleet table sorts boxes by it.
let agentCommitAt = null;
// Whether termag-box-update.service is installed here; the box-update
// capability is announced only then (agent/box-update.js).
let boxUpdateCapable = false;

// Tell the backend which host this agent is on, so it stops guessing
// /home/<user> for the project directories it sends back.
function sendHello(ws) {
  try {
    // os.userInfo() throws when the uid has no passwd entry (unnamed uid in a
    // container), so the env fallback has to survive that.
    let unixUser;
    try { unixUser = os.userInfo().username; } catch {}
    ws.send(JSON.stringify({
      type: 'hello',
      unixUser: unixUser || process.env.USER,
      // Deliberately NOT remapPath(home): path_remap rewrites the backend's
      // paths into local ones, and hello travels the other way.
      home: os.homedir() || process.env.HOME,
      hostname: os.hostname(),
      agentVersion: require('./package.json').version,
      agentCommit,
      agentCommitAt,
      warm: config.warm === true,
      // Disk, memory, load and kept runner checkouts (host-sample.js); the
      // backend writes them on the box row and refreshes them over the
      // `host-sample` RPC.
      host: hostSample.sampleHostSync(os.homedir() || process.env.HOME || '/'),
      // "credentials": false in the config advertises no credential
      // capability, so the orchestrator never sends credentials-apply/remove:
      // for a second agent on a box whose first agent already owns the box's
      // Claude and GitHub setup (docs/stage.md). The tmux capability
      // is announced either way: any agent of this version runs tmux-create's
      // `command`. box-update only where the unit it starts is installed.
      capabilities: [
        ...(config.credentials === false ? [] : credentials.CAPABILITIES),
        ...TMUX_CAPABILITIES,
        ...(boxUpdateCapable ? boxUpdate.CAPABILITIES : []),
        ...hostSample.CAPABILITIES,
      ],
    }));
  } catch (err) {
    console.error('[AGENT] Failed to send hello:', err.message);
  }
}

let tokenInQuery = false;
// Drain closes in a row (agent-dial.js redialDelayMs); a connection that lasts
// resets it.
let drainCloses = 0;
const DRAIN_STREAK_RESET_MS = 10_000;

function connect() {
  const { url, options } = dialArgs(termag_url, token, { tokenInQuery });
  console.log(`[AGENT] Connecting to ${termag_url.replace(/\?.*/, '')}${tokenInQuery ? ' (token in query, for an older orchestrator)' : ''}...`);

  const ws = new WebSocket(url, options);

  let openedAt = 0;
  ws.on('open', () => {
    openedAt = Date.now();
    console.log('[AGENT] Connected to termag');
    sendHello(ws);
    startOnClaimForwarder(ws);
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
          // gitInit: false opts out (the Claude runner session lives in a
          // state directory that must not become a repository).
          if (!alreadyRepo && msg.gitInit !== false) {
            await execAsync(`git init ${shellEscape(cwd)}`);
          }
          // `command` (argv, tmux-create-command-v1): the pane runs that
          // program instead of a shell, and the session ends when it exits.
          // Checked up front: tmux reports success even when the exec fails.
          const command = Array.isArray(msg.command) && msg.command.length >= 2 && msg.command.every(a => typeof a === 'string')
            ? [remapPath(msg.command[0]), ...msg.command.slice(1)]
            : null;
          if (command) await fs.promises.access(command[0], fs.constants.X_OK);
          // Create tmux session. The name is complete, so match it exactly:
          // `-t x-1` would also match an existing `x-10` and skip the create.
          let created = false;
          try {
            await execAsync(`tmux has-session -t ${shellEscape(tmuxSessionTarget(sessionName, true))} 2>/dev/null`);
            // Already exists
          } catch {
            await execFileAsync('tmux', newSessionArgv(sessionName, cwd, command, process.env));
            created = true;
            // A command that exits at once takes its session with it, so for
            // those the pane options are best effort.
            for (const argv of newSessionOptionArgvs(sessionName)) {
              const set = execFileAsync('tmux', argv);
              await (command ? set.catch(() => {}) : set);
            }
            // Let tmux copy operations (copy-mode y/M-w, mouse drag-end) emit
            // OSC 52 so selections reach the browser clipboard via xterm.js.
            // set-clipboard is a server option; -g applies it to all sessions.
            await execAsync(`tmux set-option -g set-clipboard on`);
            await execAsync(`tmux set-option -ga terminal-features ',xterm-256color:clipboard'`);
          }
          respond(ws, requestId, { ok: true, created });
          break;
        }

        case 'tmux-kill': {
          const { sessionName } = msg;
          stopCodexBridge(sessionName);
          try {
            await execAsync(`tmux kill-session -t ${shellEscape(tmuxSessionTarget(sessionName, msg.exact === true))}`);
          } catch { /* may not exist */ }
          respond(ws, requestId, { ok: true });
          break;
        }

        case 'tmux-send-keys': {
          // `literal` (opt-in) types `keys` VERBATIM via `-l`, so a string like
          // "C-c" is text, not Ctrl-C. Without it — the historical default that
          // Slack /t and the Claude launch rely on — tmux parses key names.
          // `-l` applies to every argument in an invocation, so Enter must be a
          // separate send (matches backend/src/services/tmux.ts sendKeys).
          //
          // argv via execFile, never a shell string: the shell version escaped
          // `'` twice and typed `'\''` for every apostrophe.
          const { sessionName, keys, withEnter, literal } = msg;
          await execFileAsync('tmux', sendKeysArgv(sessionName, keys, { literal: !!literal, withEnter: !!withEnter }));
          if (literal && withEnter) await execFileAsync('tmux', enterArgv(sessionName));
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
          // styled (opt-in) keeps SGR escapes (`-e`) so dimmed ghost-text can be
          // told from typed input; default stays plain for every existing caller.
          const styled = msg.styled === true;
          try {
            const { stdout } = await execFileAsync(
              'tmux', captureArgv(sessionName, { lines, styled }),
              { maxBuffer: 4 * 1024 * 1024 }
            );
            respond(ws, requestId, { content: stdout, styled });
          } catch (err) {
            respond(ws, requestId, null, err.message);
          }
          break;
        }

        case 'project-rename': {
          for (const { from } of msg.sessions ?? []) stopCodexBridge(from);
          const result = await renameProject(
            { sessions: msg.sessions, fromDir: remapPath(msg.fromDir), toDir: remapPath(msg.toDir) },
            { execFile: execFileAsync },
          );
          respond(ws, requestId, result);
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

        // Small text-file primitives for orchestrator-driven seeding inside
        // the user's home (MetaTerm's .mcp.json / CLAUDE.md / .claude/settings.json).
        // The backend runs as its own service user and can't write into
        // /home/<user>; this agent runs AS the user, so it does the write.
        // Not a permission boundary — the backend gates who asks for what.
        case 'read-file': {
          const p = remapPath(msg.path);
          try {
            respond(ws, requestId, { ok: true, content: await readFileAsync(p, 'utf8') });
          } catch (err) {
            if (err.code !== 'ENOENT') throw err;
            respond(ws, requestId, { ok: true, content: null });
          }
          break;
        }

        case 'write-file': {
          const p = remapPath(msg.path);
          if (typeof msg.content !== 'string') throw new Error('write-file: content must be a string');
          // `mode` (optional): the file's permissions, applied before any
          // content lands (the Claude runner's work order is written 0600).
          const mode = Number.isInteger(msg.mode) && msg.mode >= 0 && msg.mode <= 0o777 ? msg.mode : null;
          await mkdir(path.dirname(p), { recursive: true });
          if (mode !== null) {
            await writeFile(p, '', { flag: 'a', mode });
            await fs.promises.chmod(p, mode);
          }
          await writeFile(p, msg.content, 'utf8');
          respond(ws, requestId, { ok: true });
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
          // Idempotent, like tmux-create: a worktree already at that path on
          // that branch is reused rather than failed on. That is what lets a
          // second orchestrator (docs/stage.md) adopt a workstream the first
          // one created; a path holding anything else still fails below.
          if (fs.existsSync(worktreePath)) {
            try {
              const { stdout } = await execAsync(`git -C ${shellEscape(worktreePath)} rev-parse --abbrev-ref HEAD`);
              if (stdout.trim() === branch) {
                respond(ws, requestId, { ok: true, path: worktreePath, existing: true });
                break;
              }
            } catch { /* not a worktree: let git worktree add report it */ }
          }
          await execAsync(
            `git -C ${shellEscape(projectDir)} worktree add -b ${shellEscape(branch)} ${shellEscape(worktreePath)} ${shellEscape(ref)}`
          );
          respond(ws, requestId, { ok: true, path: worktreePath });
          break;
        }

        case 'git-worktree-move': {
          // Rename a workstream: move its worktree from .worktrees/<from> to
          // .worktrees/<to>. `git worktree move` updates git's bookkeeping
          // (.git/worktrees/<id>/gitdir) as well as the directory, which a plain
          // mv would not. The branch is untouched — the caller decides whether
          // the git branch follows the workstream name.
          const projectDir = remapPath(msg.projectDir);
          const { from, to } = msg;
          if (!projectDir || !from || !to) throw new Error('projectDir, from and to are required');
          const fromPath = `${projectDir}/.worktrees/${from}`;
          const toPath = `${projectDir}/.worktrees/${to}`;
          await execAsync(
            `git -C ${shellEscape(projectDir)} worktree move ${shellEscape(fromPath)} ${shellEscape(toPath)}`
          );
          respond(ws, requestId, { ok: true, path: toPath });
          break;
        }

        case 'tmux-rename-session': {
          // Rename a tmux session in place; whatever runs inside keeps running.
          // Idempotent-ish: a missing source is reported as renamed=false rather
          // than an error, since a workstream pair may be only partly alive.
          const { from, to } = msg;
          if (!from || !to) throw new Error('from and to are required');
          // `=name` is an exact match: without it tmux prefix-matches, so a
          // missing `foo` would silently rename `foo-bar` (same trap as #220).
          try {
            await execAsync(`tmux has-session -t ${shellEscape(`=${from}`)} 2>/dev/null`);
          } catch {
            respond(ws, requestId, { ok: true, renamed: false });
            break;
          }
          await execAsync(`tmux rename-session -t ${shellEscape(`=${from}`)} ${shellEscape(to)}`);
          respond(ws, requestId, { ok: true, renamed: true });
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
          // The directory may already be gone: removed by hand, or by a
          // `git worktree remove` run outside termag. `worktree remove` then
          // fails with "is not a working tree", and the backend turns any
          // failure here into a 409 *before* deleting the Workstream row, so
          // the UI could never remove the orphan. Treat "already gone" as
          // done: drop git's stale bookkeeping and carry on to the branch.
          let alreadyRemoved = false;
          if (!fs.existsSync(worktreePath)) {
            await execAsync(`git -C ${shellEscape(projectDir)} worktree prune`);
            alreadyRemoved = true;
          } else {
            const forceFlag = force ? ' --force' : '';
            await execAsync(
              `git -C ${shellEscape(projectDir)} worktree remove${forceFlag} ${shellEscape(worktreePath)}`
            );
          }
          let branchDeleteWarning = null;
          if (branch) {
            const flag = force ? '-D' : '-d';
            try {
              await execAsync(
                `git -C ${shellEscape(projectDir)} branch ${flag} ${shellEscape(branch)}`
              );
            } catch (err) {
              // The reason, not git's advice: the last `error:`/`fatal:` line
              // when there is one, else the last non-`hint:` line. git follows
              // "not fully merged" with "If you are sure…" (2.43) or `hint:`
              // lines (newer), and the UI should show the reason.
              const lines = err.message.trim().split('\n').map(l => l.trim())
                .filter(l => l && !l.startsWith('hint:'));
              const errors = lines.filter(l => /^(error|fatal):/.test(l));
              branchDeleteWarning = (errors.length ? errors : lines).pop() || null;
              console.error(`[AGENT] branch ${flag} ${branch} failed: ${branchDeleteWarning}`);
            }
          }
          respond(ws, requestId, { ok: true, branchDeleteWarning, alreadyRemoved });
          break;
        }

        case 'tmux-set-user-option':
        case 'tmux-get-user-option': {
          // termag metadata on a tmux session, as a tmux "user option"
          // (`@termag-…`), so it lives exactly as long as the session does and
          // survives a backend restart: the review pane records which PR it is
          // reviewing this way (backend/src/routes/review.ts). Only `@termag-`
          // names are accepted, so this cannot flip real tmux options.
          const { sessionName, name } = msg;
          if (typeof name !== 'string' || !/^@termag-[\w-]+$/.test(name)) throw new Error('name must be @termag-…');
          if (type === 'tmux-set-user-option') {
            const value = typeof msg.value === 'string' ? msg.value : '';
            await execFileAsync('tmux', ['set-option', '-t', sessionName, name, value]);
            respond(ws, requestId, { ok: true });
          } else {
            try {
              const { stdout } = await execFileAsync('tmux', ['show-options', '-t', sessionName, '-v', name]);
              respond(ws, requestId, { value: stdout.replace(/\n$/, '') });
            } catch {
              respond(ws, requestId, { value: null }); // unset, or no such session
            }
          }
          break;
        }

        case 'git-pr-info': {
          // Which PR is the checkout in <cwd> working on? Current branch plus
          // `gh pr view` for that branch (gh picks the PR by branch; the box
          // owner's gh auth applies). `pr` is gh's raw JSON or null when the
          // branch has no PR; the backend parses and validates it
          // (services/review.ts). Never throws for "no PR" -- only for a
          // missing/unusable cwd.
          const cwd = remapPath(msg.cwd);
          if (!cwd) throw new Error('cwd is required');
          let branch = null;
          try {
            const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 });
            branch = stdout.trim() || null;
          } catch { /* not a git checkout */ }
          let pr = null;
          let error = null;
          try {
            const { stdout } = await execFileAsync(
              'gh', ['pr', 'view', '--json', 'number,url,title,state,headRefName'],
              { cwd, timeout: 12000, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }
            );
            pr = stdout;
          } catch (err) {
            // "no pull requests found for branch" is the normal miss; anything
            // else (gh missing, not logged in) is reported so the UI can say why.
            const text = `${err.stderr || err.message || ''}`.trim();
            if (!/no pull requests found/i.test(text)) error = text.split('\n')[0] || 'gh pr view failed';
          }
          respond(ws, requestId, { branch, pr, error });
          break;
        }

        case 'git-branch-state': {
          // Where a workstream's checkout stands, for the PR pipeline's
          // pre-PR lanes (git-branch-state.js). Local refs only, no fetch.
          const cwd = remapPath(msg.cwd);
          if (!cwd) throw new Error('cwd is required');
          respond(ws, requestId, await gitBranchState(cwd, { execFile: execFileAsync }));
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
            // No socket cleanup here: node-pty only emits exit after its socket
            // has closed. The leaked ptmx/kqueue/revoked fds on macOS were in
            // node-pty 1.1.0's native spawn, fixed in the pinned 1.2.0 beta.
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

        case 'on-warm-start': {
          // The on-warm scripts assume an unclaimed box. On an owned one they
          // would run first-boot setup against a developer's live checkout, so a
          // misrouted RPC is refused here as well as at the backend.
          if (config.warm !== true) {
            respond(ws, requestId, null, 'not a warm-pool agent');
            break;
          }
          // --no-block because the unit is Type=oneshot, so a blocking start
          // would not return until the whole warm run finished, tens of minutes
          // past the backend's RPC timeout. Repeating it is safe either way, since
          // systemd merges the start job into a run already in flight and
          // RemainAfterExit makes a start after success a no-op, so neither
          // repeat can produce a second writer of the status file.
          await execAsync('systemctl --user start --no-block termag-on-warm.service');
          console.log('[ON-WARM] started termag-on-warm.service, polling for status');
          respond(ws, requestId, { ok: true });
          startOnWarmPoller(ws);
          break;
        }

        // Payloads go to deploy/termag-credentials on stdin and are never logged.
        case 'credentials-apply': {
          await credentials.applyCredential(msg.provider, msg.payload);
          console.log(`[CRED] applied ${msg.provider}`);
          respond(ws, requestId, { ok: true });
          break;
        }

        case 'credentials-remove': {
          await credentials.removeCredential(msg.provider, undefined, msg.reason);
          respond(ws, requestId, { ok: true });
          break;
        }

        case 'box-claim': {
          // Git identity is synchronous. Optional dotfiles start in the
          // background and never receive a GitHub token.
          const { ownerName, ownerEmail, dotfilesRepoUrl } = msg;
          if (!ownerName || !ownerEmail) {
            respond(ws, requestId, null, 'box-claim: ownerName and ownerEmail are required');
            break;
          }
          if (dotfilesRepoUrl != null && dotfilesRepoUrl !== '') {
            let repo;
            try { repo = new URL(dotfilesRepoUrl); } catch {
              respond(ws, requestId, null, 'box-claim: invalid dotfilesRepoUrl');
              break;
            }
            if (repo.protocol !== 'https:' || repo.hostname !== 'github.com') {
              respond(ws, requestId, null, 'box-claim: dotfilesRepoUrl must use https://github.com');
              break;
            }
          }
          await execAsync(`git config --global user.name ${shellEscape(ownerName)}`);
          await execAsync(`git config --global user.email ${shellEscape(ownerEmail)}`);
          console.log(`[CLAIM] git identity set to ${ownerName} <${ownerEmail}>`);
          const plan = await prepareOnClaim({
            dotfilesRepoUrl: dotfilesRepoUrl || null,
            ownerName,
            ownerEmail,
          });
          if (plan.start) {
            await execFileAsync('systemctl', ['--user', 'start', '--no-block', ON_CLAIM_UNIT]);
            console.log('[CLAIM] started termag-on-claim.service');
            if (onClaimForwarder) onClaimForwarder.tick();
          }
          // reportsOnClaim: with a repo to apply, this agent forwards the run's
          // status, so the backend waits for it instead of settling the claim.
          respond(ws, requestId, { ok: true, reportsOnClaim: Boolean(dotfilesRepoUrl) });
          break;
        }

        case 'box-update': {
          // Hands over to termag-box-update.service and answers at once: the
          // update restarts this agent, so it cannot run in this process, and
          // the unit is a oneshot systemd serializes (agent/box-update.js).
          // `target` is the commit the orchestrator wants the box on, for the
          // log only; the script pulls main whatever the target says.
          const target = typeof msg.target === 'string' ? msg.target.slice(0, 12) : null;
          const result = await boxUpdate.startBoxUpdate(execFileAsync);
          console.log(`[BOX-UPDATE] started ${result.unit}${target ? ` (target ${target})` : ''}; this agent runs ${agentCommit ? agentCommit.slice(0, 12) : 'unknown'}`);
          respond(ws, requestId, { ...result, agentCommit });
          break;
        }

        case 'host-sample': {
          respond(ws, requestId, hostSample.sampleHostSync(os.homedir() || process.env.HOME || '/'));
          break;
        }

        case 'usage-scan': {
          // `since` (YYYY-MM-DD) trims the response, never the cache. Older
          // backends send {} and get everything, as before.
          const result = await usageScanner.scan({ since: msg.since });
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
    const retryWithQueryToken = !tokenInQuery && refusedForWantOfQueryToken(code, reason);
    tokenInQuery = retryWithQueryToken;
    if (openedAt && Date.now() - openedAt > DRAIN_STREAK_RESET_MS) drainCloses = 0;
    drainCloses = code === DRAIN_CLOSE_CODE ? drainCloses + 1 : 0;
    const delayMs = retryWithQueryToken ? 0 : redialDelayMs(code, drainCloses, reconnect_interval_seconds);
    if (retryWithQueryToken) {
      console.log('[AGENT] Orchestrator wants the token in the query string; redialling that way');
    } else {
      console.log(`[AGENT] Disconnected (${code}). Reconnecting in ${(delayMs / 1000).toFixed(1)}s...`);
    }
    stopContextScanner();
    stopRateLimitScanner();
    // The backend re-sends on-warm-start on the next hello, which is what
    // restarts this; leaving the old socket's interval armed would double it.
    stopOnWarmPoller();
    stopOnClaimForwarder();
    // Kill all active PTY streams. The socket destroy closes the master fd
    // now rather than after node-pty's 1s grace timer.
    for (const [id, stream] of streams) {
      try { stream.pty.kill(); } catch {}
      try { stream.pty._socket && stream.pty._socket.destroy(); } catch {}
    }
    streams.clear();
    for (const sessionName of codexBridges.keys()) {
      stopCodexBridge(sessionName);
    }
    setTimeout(connect, delayMs);
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
// The commit and the capability go into the first hello, so both are read
// before the first dial. Bounded inside box-update.js, and null or false
// rather than a failure to start.
Promise.all([
  boxUpdate.readCheckoutCommit(execFileAsync, CHECKOUT_DIR),
  boxUpdate.boxUpdateUnitLoaded(execFileAsync),
  boxUpdate.readCheckoutCommitDate(execFileAsync, CHECKOUT_DIR),
]).then(([sha, unitLoaded, at]) => {
  agentCommit = sha;
  agentCommitAt = sha ? at : null;
  boxUpdateCapable = unitLoaded;
  console.log(`[AGENT] running commit ${sha ? sha.slice(0, 12) : 'unknown (not a git checkout)'}; ${boxUpdate.BOX_UPDATE_UNIT} ${unitLoaded ? 'installed' : 'not installed'}`);
  connect();
});

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
