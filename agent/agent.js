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
const { exec, execFile, spawn } = require('child_process');
const { mkdir } = require('fs/promises');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { sendKeysArgv, enterArgv, captureArgv, tailLines, parseForeground, newSessionArgv, newSessionOptionArgvs, windowSizeOptionArgv, attachSessionArgv, mouseOptionArgv, tmuxSessionTarget, CAPABILITIES: TMUX_CAPABILITIES } = require('./tmux-args');
const worktreeFetch = require('./worktree-fetch');
const hostSample = require('./host-sample');
const unsavedWork = require('./unsaved-work');
const diskGrow = require('./disk-grow');
const softwareInventory = require('./software-inventory');
const runnerSessions = require('./runner-sessions');
const { renameProject } = require('./project-rename');
const { writeFileRpc } = require('./write-file');
const { gitBranchState, gitCheckoutFacts } = require('./git-branch-state');
const gitChanges = require('./git-changes');
const paneSubagents = require('./pane-subagents');
const gitWorktreePr = require('./git-worktree-pr');
const gitWorktreeOwn = require('./git-worktree-own');
const briefing = require('./briefing-digest');
const { dialArgs, refusedForWantOfQueryToken, redialDelayMs, DRAIN_CLOSE_CODE } = require('./agent-dial');
const credentials = require('./credentials');
const { planOnClaim, planOnClaimRetry, onClaimRetryKey, renderOnClaimEnv, createStatusForwarder } = require('./on-claim');
const boxUpdate = require('./box-update');
const toolUpdate = require('./tool-update');
const { codexPaneCommand } = require('./codex-launch');
const askRun = require('./ask-run');
const askChat = require('./ask-chat');
const projectClone = require('./project-clone');
const environmentPrepare = require('./environment-prepare');
const environmentRun = require('./environment-run');
const workspace = require('./workspace');
const chatRunner = require('./chat-runner');
const chatFiles = require('./chat-files');
const boxNotice = require('./box-notice');
const spaceMemory = require('./space-memory');
const spaceSyncRpc = require('./space-sync');
const browserPane = require('./browser-pane');
const browserGuest = require('./browser-guest');
const { codexResourceEnv, codexBridgeEnv } = require('./codex-resource-env');
const { CLIPBOARD_MAX_BYTES, writeClipboardMailbox, clipboardPasteImage } = require('./clipboard-mailbox');
const readImage = require('./read-image');
const paneHistory = require('./pane-history');
const claudeTrust = require('./claude-trust');
const runnerWrapper = require('./claude-runner-wrapper');
const claudeLogin = require('./claude-login');
const t3Bridge = require('./t3-bridge');
const portTunnel = require('./port-tunnel');
const previewListenersRpc = require('./preview-listeners');

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

function remapGuides(guides) {
  return Array.isArray(guides) ? guides.map(g => ({ ...g, dir: remapPath(g?.dir) })) : [];
}

// ── Wiki init ─────────────────────────────────────────────────────────────
const { readFile: readFileAsync, writeFile } = require('fs/promises');
const { ensureProjectRepo, gitInit } = require('./git-repo');
const { setupOff } = require('./box-setup');

// Bundled template ships next to this file. Override with TERMAG_WIKI_TEMPLATE_PATH
// to point at a different one (e.g. an agent-wiki checkout that gets curated centrally).
const WIKI_TEMPLATE_PATH = process.env.TERMAG_WIKI_TEMPLATE_PATH
  || path.join(__dirname, 'initial-AGENTS.md');

async function initWikiFiles(dir, slug, username) {
  const agentsPath = path.join(dir, 'AGENTS.md');
  const claudePath = path.join(dir, 'CLAUDE.md');

  // With termag setup off, a box's projects start with no termag-written
  // instructions; the repo and its first commit still come below.
  if (setupOff()) {
    return { ok: true, skipped: true, reason: 'setup-off' };
  }

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

// The simple UI's chat runner (chat-runner.js): one headless Claude turn at a
// time per chat, each in its own tmux session under chat-turn.js so it
// outlives this process; the agent tails the turns' logs and sends their
// events on whichever socket is up, and takes them up again after a restart.
let liveSocket = null;
const CHAT_TURN_SCRIPT = path.join(__dirname, 'chat-turn.js');
const CHAT_POLL_MS = 200;
// A pane Claude's subagents for the simple UI's pane chat (pane-subagents.js): read only, found afresh on every call.
const panes = paneSubagents.createPaneSubagents({ home: process.env.HOME || os.homedir() });
const chats = chatRunner.createChatRunner({
  home: process.env.HOME || os.homedir(),
  // The box token a confined turn's broker connectors send (broker-mcp.js), read by termag-mcp-headers.
  agentConfig: path.resolve(configPath),
  username: process.env.USER || os.userInfo().username,
  isOpen: () => Boolean(liveSocket && liveSocket.readyState === WebSocket.OPEN),
  send: (frame) => {
    if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN) return false;
    liveSocket.send(JSON.stringify(frame));
    return true;
  },
  // TERMAG_SPACE_MEMORY_MANAGED: the runner gives the turn its space memory, so the Claude Code hooks don't (space-memory.js).
  startProcess: (meta, dir) => execFileAsync('tmux', newSessionArgv(meta.session, meta.cwd, spaceMemory.managedCommand([process.execPath, CHAT_TURN_SCRIPT, dir]), process.env)),
  sessionAlive: (name) => execFileAsync('tmux', ['has-session', '-t', tmuxSessionTarget(name, true)]).then(() => true, () => false),
  signalPid: (pid, signal) => { try { process.kill(pid, signal); } catch { /* already gone */ } },
  // The desktop app's threads on this box's t3 server (t3-bridge.js), which
  // may hold a chat's session (claimT3). The bridge is made below, once its
  // command is known, and before any chat RPC can arrive.
  t3Sessions: {
    session: (a) => (t3 ? t3.threadSession(a) : { result: 'unsupported' }),
    release: (a) => (t3 ? t3.threadRelease(a) : { result: 'unsupported' }),
    adopt: (a) => (t3 ? t3.threadAdopt(a) : { result: 'unsupported' }),
  },
  // A failed kill-session must reach chat-clear. Swallowing it made a turn
  // that was only marked cancelled look stopped while Claude was still alive.
  stopSession: (name) => execFileAsync('tmux', ['kill-session', '-t', tmuxSessionTarget(name, true)]),
  log: (line) => console.log(line),
  onTurnDone: (meta, dir) => askChats.onTurnDone(meta, dir),
  onDropped: (jobs) => askChats.onDropped(jobs),
  // TERMAG_BOOT_ID_FILE: the e2e stand-in boxes share their host's kernel, so each start writes its own boot id.
  bootNow: () => boxNotice.bootIdentity(process.env.TERMAG_BOOT_ID_FILE ? { file: process.env.TERMAG_BOOT_ID_FILE } : {}),
});
// An ask's thread as a chat of its target project (ask-chat.js).
const askChats = askChat.createAskChat({
  home: process.env.HOME || os.homedir(),
  chats,
  spawn,
  log: (line) => console.log(line),
});
// One Claude Enterprise sign-in for this box (claude-login.js). The one-time
// code is written to that CLI's stdin and is not logged.
const claudeSignIn = claudeLogin.createClaudeLogin({
  home: process.env.HOME || os.homedir(),
  execFile: execFileAsync,
});
// Shut until the backend's chat-recover names which chats are archived or
// gone. Recovering at import would reattach a turn whose project was deleted
// while this process was down. A disconnect arms the gate again: the socket
// coming back is not a reason to resume those turns.
chats.holdRecover();
let chatPolling = false;
setInterval(() => {
  if (chatPolling) return;
  chatPolling = true;
  chats.poll().catch(err => console.error(`[CHAT] poll failed: ${err.message}`)).finally(() => { chatPolling = false; });
}, CHAT_POLL_MS);

const CLONE_POLL_INTERVAL_MS = 2000;
let cloneTimer = null;
let cloneForwarder = null;

function startCloneForwarder(ws) {
  stopCloneForwarder();
  const dir = projectClone.clonesDir(process.env.HOME || '/home');
  cloneForwarder = projectClone.createCloneForwarder({
    readNames: () => fs.readdirSync(dir),
    readFile: (name) => fs.readFileSync(path.join(dir, name), 'utf8'),
    send: (frame) => ws.send(JSON.stringify(frame)),
    isOpen: () => ws.readyState === WebSocket.OPEN,
  });
  const forwarder = cloneForwarder;
  cloneTimer = setInterval(() => forwarder.tick(), CLONE_POLL_INTERVAL_MS);
  forwarder.tick();
}

function stopCloneForwarder() {
  if (cloneTimer) { clearInterval(cloneTimer); cloneTimer = null; }
  cloneForwarder = null;
}

// A project's environment state (environment-run.js): setup's time, the run,
// the ports' health, forwarded as the clone state is.
let envTimer = null;

function startEnvForwarder(ws) {
  stopEnvForwarder();
  const dir = environmentRun.stateDir(process.env.HOME || '/home');
  const forwarder = environmentRun.createEnvForwarder({
    readNames: () => fs.readdirSync(dir),
    readFile: (name) => fs.readFileSync(path.join(dir, name), 'utf8'),
    send: (frame) => ws.send(JSON.stringify(frame)),
    isOpen: () => ws.readyState === WebSocket.OPEN,
  });
  envTimer = setInterval(() => forwarder.tick(), CLONE_POLL_INTERVAL_MS);
  // A chain whose window went with a reboot or a Ctrl-C is interrupted, not in progress for ever (Bugbot, #998).
  environmentRun.reconcileInterrupted(process.env.HOME || '/home')
    .catch(err => console.warn(`[ENV] reconcile: ${err.message}`))
    .finally(() => forwarder.tick());
}

function stopEnvForwarder() {
  if (envTimer) { clearInterval(envTimer); envTimer = null; }
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

// A private dotfiles repo cannot clone at claim time: the orchestrator sends
// box-claim, which starts the run, and only then delivers GitHub through the
// broker (warmPoolClaim.ts: configureBox, then welcomeOwner), so the clone
// runs seconds before /etc/gitconfig could have sent it through the broker and
// the run ends skipped/needs-auth. Once a GitHub delivery has landed, run the
// claim again; the runner reads the saved URL and skips a checkout it already
// applied. The claim's own run may still be in flight when the delivery
// arrives, so wait for it to end first, up to its 10-minute budget. A
// delivery is repeated on every reconnect, and a repo the token still cannot
// read must not be cloned at each one, so each delivered connection gets one
// rerun per cooldown, counted from the rerun it started, not from the
// delivery. The key (onClaimRetryKey) carries the credential's updatedAt, so
// the delivery that follows a token the owner replaced on the Credentials
// page (routes/credentials.ts) is a new connection and reruns at once. Two
// reruns cannot clone over each other: the runner holds one lock for the run.
const ON_CLAIM_RETRY_POLL_MS = 2000;
const ON_CLAIM_RETRY_WAIT_MS = 12 * 60 * 1000;
const ON_CLAIM_RETRY_COOLDOWN_MS = 30 * 60 * 1000;
const onClaimRetriedAt = new Map();
let onClaimRetry = null;

function readOnClaimStatus() {
  try { return JSON.parse(fs.readFileSync(ON_CLAIM_STATUS_FILE, 'utf8')); } catch { return null; }
}

function retryOnClaimAfterGithub(payload) {
  if (onClaimRetry) return onClaimRetry;
  if (!fs.existsSync(ON_CLAIM_URL_FILE)) return Promise.resolve();
  const key = onClaimRetryKey(payload);
  const last = onClaimRetriedAt.get(key);
  if (last !== undefined && Date.now() - last < ON_CLAIM_RETRY_COOLDOWN_MS) return Promise.resolve();
  onClaimRetry = (async () => {
    const deadline = Date.now() + ON_CLAIM_RETRY_WAIT_MS;
    for (;;) {
      const plan = planOnClaimRetry({ hasUrl: true, unitState: await onClaimUnitState(), status: readOnClaimStatus() });
      if (plan === 'none') return;
      if (plan === 'start') {
        onClaimRetriedAt.set(key, Date.now());
        await execFileAsync('systemctl', ['--user', 'start', '--no-block', ON_CLAIM_UNIT]);
        console.log('[CLAIM] GitHub through termag is in place; running the deferred dotfiles claim again');
        if (onClaimForwarder) onClaimForwarder.tick();
        return;
      }
      if (Date.now() >= deadline) return;
      await new Promise(resolve => setTimeout(resolve, ON_CLAIM_RETRY_POLL_MS));
    }
  })()
    .catch(err => console.error('[CLAIM] rerunning the dotfiles claim after the GitHub delivery failed:', err && err.message))
    .finally(() => { onClaimRetry = null; });
  return onClaimRetry;
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
// One-shot drop point for an image pasted in the browser. Written here
// (agent/clipboard-mailbox.js), read (and deleted) by agent/xclip-shim.sh on
// Claude Code's behalf.
const CLIPBOARD_SLOT = path.join(process.env.HOME || '/home', '.cache', 'termag', 'clipboard.png');

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

async function startCodexSession(sessionName, cwd, resourceEnv = {}, resumeSessionId = null, notice = null) {
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
    // TERMAG_PROJECT / TERMAG_WORKSTREAM (resourceEnv, both or neither) reach
    // the app server the bridge starts through termag-agent-otel, which puts
    // them on its resource as termag.project / termag.workstream;
    // the agent's own environment never carries them.
    // TERMAG_SESSION_KIND=interactive, as the resource says: the app server is
    // where Codex's commands run, so the tools it starts inherit it.
    { cwd, env: { ...codexBridgeEnv(process.env, resourceEnv), TERMAG_STATUS_BEARER_TOKEN: token } },
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
  // `codex resume <id>` when a tool update's relaunch names the pane's
  // conversation (agent/codex-launch.js); otherwise a fresh client.
  // A tool update's notice prints first, after the clear (codex-launch.js checks it).
  const codexCmd = codexPaneCommand({ remoteUrl, cwd, resumeSessionId, notice });
  await execAsync(`tmux send-keys -t ${shellEscape(sessionName)} ${shellEscape(codexCmd)} Enter`);
  return { ok: true, remoteUrl, port };
}

credentials.configure({ agentConfig: path.resolve(configPath) });

// The desktop app's box bridge (agent/t3-bridge.js):
// a t3 server on loopback, reached only through tunnels the orchestrator asks
// for. Advertised where a t3 command resolves, or, read before the first
// hello, where the checkout pins a server this box can still install.
const t3Command = t3Bridge.resolveT3Command({ env: process.env, config });
console.log(`[AGENT] t3 bridge: ${t3Command ? `using ${t3Command}` : 'no t3 command found'}`);
const t3Installer = path.resolve(__dirname, '..', 'deploy', 'termag-t3-install');
const t3Dropin = path.join(os.homedir() || process.env.HOME || '/', '.config', 'systemd', 'user', 'termag-agent.service.d', 't3.conf');
const t3Pinned = t3Command
  ? null
  : t3Bridge.createPinnedInstall({ installer: t3Installer, dropin: t3Dropin, execFile: execFileAsync, log: (m) => console.log(m) });
const t3Release = t3Bridge.createReleaseInstall({ installer: t3Installer, dropin: t3Dropin, execFile: execFileAsync });
// t3-update moves only the installer's launcher: the pinned install's, or a
// command that is the one its drop-in names (not an owner's own t3).
const t3Updatable = t3Pinned !== null || (t3Command !== null && t3Command === t3Release.launcher());
function makeT3Bridge(pinned) {
  return t3Bridge.createT3Bridge({
    command: t3Command, pinned, release: t3Release, home: os.homedir() || process.env.HOME || '/', execFile: execFileAsync, remapPath,
    termagUrl: termag_url, token, WebSocket, log: (m) => console.log(m),
    claudeCommand: t3Bridge.resolveT3ClaudeCommand({ env: process.env, config }),
    piCommand: t3Bridge.resolveOnPath('pi', process.env.PATH),
  });
}
let t3 = t3Command ? makeT3Bridge(null) : null;
// The desktop's Space: the box copies its spaces with its own CLI (agent/space-sync.js).
const spaceSync = spaceSyncRpc.createSpaceSync({ home: os.homedir() || process.env.HOME || '/' });
// The port forward (agent/port-tunnel.js): tunnels to the user's own box
// ports, checked by agent/port-guard.js. Needs no t3. Advertised only where
// the guard has /proc/net/tcp to read (Linux), and used only once the
// orchestrator's box-port-forward-enabled flag is on. The same tunnels carry
// preview links' relays (`preview` targets, preview-link-v1), behind
// preview-links-enabled, with the guard's SR6 refusals on top.
const portForwardCapabilities = portTunnel.capabilities();
const portTunnels = portTunnel.createPortTunnels({ termagUrl: termag_url, token, WebSocket, log: (m) => console.log(m) });

/** The host sample, with the open tunnels the orchestrator's idle sweep counts as busy. */
function hostSampleNow() {
  return hostSample.sampleHostSync(os.homedir() || process.env.HOME || '/', {
    tunnels: { t3: t3 ? t3.openTunnels() : 0, port: portTunnels.openTunnels() },
  });
}

// The commit this process runs, read once at startup from the checkout agent/
// is part of (agent/box-update.js). The orchestrator compares it with what a
// current box runs and asks a box that is behind to update. A
// checkout pulled since the agent started still runs the old code, and that
// is what this reports, which is the point. Null outside a git checkout.
const CHECKOUT_DIR = path.resolve(__dirname, '..');
// The browser pane runs the box's Chromium; found once
// here, and the capability is advertised only when there is one.
const browserBinary = browserPane.findChromium();
console.log(`[AGENT] browser pane: ${browserBinary ? browserBinary : 'no Chromium found, capability not advertised'}`);
// A reviewer's pane runs its Chromium as termag-guest
// through the box's launcher: asked once whether that works here (the box
// image or termag-reconcile installs it), and the guest capability is
// advertised only when it does.
const guestBrowser = browserBinary ? browserGuest.guestEnvironment() : { ok: false, reason: 'no Chromium' };
console.log(`[AGENT] browser pane guests: ${guestBrowser.ok ? `available (${guestBrowser.profilesRoot})` : `unavailable: ${guestBrowser.reason}`}`);
// One manager for the process: a pane's browser is parked across a socket
// drop or a closed pane and reclaimed by the next attach with its key.
// Kept profiles are indexed
// in the agent's own state dir; the backend asks for one per attach.
const browserProfiles = new browserPane.ProfileIndex(path.join(os.homedir() || process.env.HOME || '/', '.local', 'state', 'termag', 'browser-profiles.json'));
const browsers = browserPane.createManager({ binary: browserBinary, home: os.homedir() || process.env.HOME || '/', guestEnv: guestBrowser, index: browserProfiles });
let agentCommit = null;
// When that commit was made (ISO 8601), beside it in the hello: the admin
// Fleet table sorts boxes by it.
let agentCommitAt = null;
// Whether termag-box-update.service is installed here; the box-update
// capability is announced only then (agent/box-update.js).
let boxUpdateCapable = false;
// The tools whose update unit (termag-claude-update@.service for claude,
// termag-codex-update@.service for codex) is installed here; each one's
// capability is announced only for those (agent/tool-update.js).
let toolUpdateComponents = [];
let projectCloneCapable = false;
// What the installed termag-claude-runner understands: v2 for the git flags,
// v3 for --claude-floor (agent/claude-runner-wrapper.js). Nothing without a
// wrapper.
let wrapperCapabilities = [];

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
      // `host-sample` RPC (S5).
      host: hostSampleNow(),
      // "credentials": false in the config advertises no credential
      // capability, so the orchestrator never sends credentials-apply/remove:
      // for a second agent on a box whose first agent already owns the box's
      // Claude and GitHub setup (docs/stage.md). The tmux capability
      // is announced either way: any agent of this version runs tmux-create's
      // `command`. box-update only where the unit it starts is installed.
      capabilities: [
        ...(config.credentials === false ? [] : credentials.CAPABILITIES),
        ...TMUX_CAPABILITIES,
        ...paneHistory.CAPABILITIES,
        ...(boxUpdateCapable ? boxUpdate.CAPABILITIES : []),
        ...toolUpdate.capabilities(toolUpdateComponents),
        // ask-v1 only where termag-reconcile installed termag-subagent-run.
        ...(askRun.askRunnerInstalled(os.homedir() || process.env.HOME || '/') ? askRun.CAPABILITIES : []),
        ...(askChats.capable() ? askChat.CAPABILITIES : []),
        ...(askRun.askPushCapable(os.homedir() || process.env.HOME || '/') ? [askRun.PUSH_CAPABILITY] : []),
        // ask-mode-cap-v1: this agent and its runner run a capped ask (a shared environment's project) below bypassPermissions.
        ...(askRun.askModeCapable(os.homedir() || process.env.HOME || '/') ? [askRun.MODE_CAP_CAPABILITY] : []),
        ...(projectCloneCapable ? projectClone.CAPABILITIES : []),
        ...(projectCloneCapable ? workspace.CAPABILITIES : []),
        ...environmentRun.CAPABILITIES,
        // A pool box's prepare; refused unless this agent is a warm one.
        ...(config.warm === true ? environmentPrepare.CAPABILITIES : []),
        ...hostSample.CAPABILITIES,
        ...unsavedWork.CAPABILITIES,
        ...gitChanges.CAPABILITIES,
        ...paneSubagents.CAPABILITIES,
        ...(process.platform === 'linux' ? diskGrow.CAPABILITIES : []),
        ...softwareInventory.CAPABILITIES,
        ...briefing.CAPABILITIES,
        ...chatRunner.CAPABILITIES,
        ...chatFiles.CAPABILITIES,
        ...claudeLogin.CAPABILITIES,
        ...gitWorktreePr.CAPABILITIES,
        ...worktreeFetch.CAPABILITIES,
        ...readImage.CAPABILITIES,
        ...spaceMemory.CAPABILITIES,
        ...spaceSyncRpc.CAPABILITIES,
        ...claudeTrust.CAPABILITIES,
        ...(browserBinary ? browserPane.CAPABILITIES : []),
        ...(guestBrowser.ok ? [browserPane.GUEST_CAPABILITY] : []),
        // Reads Docker and the checkout only, so it needs no guest browser.
        ...browserGuest.CHECK_CAPABILITIES,
        ...(browserBinary ? [browserPane.PROFILES_CAPABILITY] : []),
        ...wrapperCapabilities,
        ...(t3 ? t3Bridge.CAPABILITIES : []),
        ...(t3 && t3Updatable ? t3Bridge.UPDATE_CAPABILITIES : []),
        ...portForwardCapabilities,
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

/**
 * Mark a worktree made from origin's tip with nobody watching (an automation
 * run) so the chat runner never loads its startup config, even for a later
 * trusted follow-up (chat-runner.js turnModeFor). The write is read back and
 * a miss is fatal: an unmarked tree would be taken for an attended one. The
 * orchestrator caps such turns on its side too (routes/chat.ts followUpMode);
 * this marker is the box's own half of that.
 */
async function markUnattended(worktreePath, branch) {
  const key = `branch.${branch}.termagUnattended`;
  await execFileAsync('git', ['-C', worktreePath, 'config', '--local', key, 'true'], { timeout: 5000 });
  const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'config', '--local', '--get', key], { timeout: 5000 });
  if (String(stdout || '').trim() !== 'true') throw new Error(`could not mark ${worktreePath} unattended`);
}

function connect() {
  const { url, options } = dialArgs(termag_url, token, { tokenInQuery });
  console.log(`[AGENT] Connecting to ${termag_url.replace(/\?.*/, '')}${tokenInQuery ? ' (token in query, for an older orchestrator)' : ''}...`);

  const ws = new WebSocket(url, options);

  let openedAt = 0;
  ws.on('open', () => {
    openedAt = Date.now();
    console.log('[AGENT] Connected to termag');
    liveSocket = ws;
    // Browser panes ride this socket: frames go out on
    // it and the acks that pace Chromium read its buffer.
    browsers.bindSocket({
      send: (frame) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)); },
      bufferedAmount: () => ws.bufferedAmount,
    });
    sendHello(ws);
    startOnClaimForwarder(ws);
    startCloneForwarder(ws);
    startEnvForwarder(ws);
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
          // state directory that must not become a repository), and so does a
          // multi-repo project's workspace root or workstream root, which
          // holds repositories but is not one (agent/workspace.js).
          if (workspace.shouldGitInit(cwd, { alreadyRepo, gitInit: msg.gitInit })) {
            await gitInit(cwd);
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
          // Pane output history for the phone's "Load earlier" (pane-history-v1):
          // an agent pane's TUI runs on tmux's alternate screen, which keeps no
          // scrollback, so capture alone cannot reach the pane's past. Armed on
          // the created and already-exists paths alike (`-o` makes a second arm
          // a no-op), so an agent restart re-arms every session the backend
          // reconstructs. Best effort: a pipe that will not start costs nothing
          // today.
          try {
            await paneHistory.arm(process.env.HOME || '/home', sessionName, { execFile: execFileAsync });
          } catch (err) {
            console.warn(`[AGENT] pane-history arm failed for ${sessionName}: ${err.message}`);
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
            // pane_dead first, so a pane whose process has exited is not
            // reported as a live Claude just because the name stuck.
            const { stdout } = await execAsync(
              `tmux list-panes -t ${shellEscape(sessionName)} -F '#{pane_dead} #{pane_current_command}'`
            );
            respond(ws, requestId, parseForeground(stdout));
          } catch {
            // Session doesn't exist or tmux not available
            respond(ws, requestId, { cmd: null, dead: false });
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

        case 'pane-history-read': {
          // Tail of the pane's output log (pane-history-v1, agent/pane-history.js),
          // for the phone's "Load earlier". The backend's sessionAccess gate has
          // already decided the caller may see this pane; the log is the same
          // bytes the pane emitted. Agents from before this case answer
          // "Unknown command", which the backend turns into a 501.
          try {
            respond(ws, requestId, await paneHistory.readTail(
              process.env.HOME || '/home', msg.sessionName,
              { beforeBytes: msg.beforeBytes, maxBytes: msg.maxBytes },
            ));
          } catch (err) {
            respond(ws, requestId, null, err.message);
          }
          break;
        }

        case 'project-rename': {
          for (const { from } of msg.sessions ?? []) stopCodexBridge(from);
          const result = await renameProject(
            {
              sessions: msg.sessions,
              fromDir: remapPath(msg.fromDir),
              toDir: remapPath(msg.toDir),
              ...(msg.workspace ? { workspace: { repos: msg.workspace.repos, guides: remapGuides(msg.workspace.guides) } } : {}),
            },
            { execFile: execFileAsync },
          );
          respond(ws, requestId, result);
          break;
        }

        case 'mkdir': {
          const dir = remapPath(msg.dir);
          // Start empty on a project in the static layout: its directory stops being a link into the abandoned checkout.
          if (typeof msg.dropLinkTo === 'string') projectClone.dropStaticLink(dir, remapPath(msg.dropLinkTo));
          await mkdir(dir, { recursive: true });
          respond(ws, requestId, { ok: true });
          break;
        }

        case 'init-wiki': {
          const { slug, username } = msg;
          const dir = remapPath(msg.dir);
          const result = await initWikiFiles(dir, slug, username);
          // Make the new project dir a repo with a first commit carrying the
          // seeded files. A project created without an agent workflow never
          // reaches tmux-create, so this is its only chance to become a repo
          // — and worktrees need one with a resolvable HEAD. Never sent for a
          // repo project, whose checkout must find the branch name free.
          // MetaTerm opts out with initRepo: false; it never branches off.
          if (msg.initRepo !== false) {
            await ensureProjectRepo(dir).catch(err => {
              console.error(`[INIT-WIKI] Repo setup for ${dir} failed: ${err.message}`);
            });
          }
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

        case 'read-image': {
          // The web terminal's hover preview of an image path in a pane
          // (agent/read-image.js). Agents from before this case answer
          // "Unknown command", which the backend turns into a 501.
          respond(ws, requestId, await readImage.readImageRpc(msg, { remapPath }));
          break;
        }

        case 'claude-trust-folder': {
          // Accept Claude Code's folder-trust prompt for a spawned agent's
          // folder before its launch, once the folder passes the check the
          // backend names (agent/claude-trust.js). Agents from before this
          // case answer "Unknown command"; the backend only sends it to one
          // announcing claude-trust-folder-v1.
          const changed = await claudeTrust.trustFolder(remapPath(msg.path), {
            check: msg.check,
            ownTree: async (dir) => chatRunner.checkoutOwnTree(await chatRunner.readCheckoutFacts(dir)),
          });
          respond(ws, requestId, { ok: true, changed });
          break;
        }

        case 'write-file': {
          await writeFileRpc(remapPath(msg.path), msg.content, { mode: msg.mode, dirMode: msg.dirMode });
          respond(ws, requestId, { ok: true });
          break;
        }

        case 'git-worktree-add': {
          // Create a git worktree at <projectDir>/.worktrees/<worktreeName>,
          // checked out on a new branch <branch> based at <baseRef> (defaults
          // to HEAD). The worktree lives inside the main project dir so it
          // travels along on rename and stays grouped with its parent.
          const projectDir = remapPath(msg.projectDir);
          const { worktreeName, branch, baseRef, initRepo, fetch, attended, readOnly } = msg;
          if (!projectDir || !worktreeName || !branch) {
            throw new Error('projectDir, worktreeName, and branch are required');
          }
          // An automation run starts from the default branch as origin has
          // it now (agent/worktree-fetch.js): fetch it first, and say whether
          // that worked. A failed fetch is not fatal; the add below uses the
          // remote-tracking ref the box already had.
          let fetched = null;
          if (fetch !== undefined) {
            if (!worktreeFetch.isFetchBranchName(fetch)) throw new Error('fetch must name a branch');
            fetched = await worktreeFetch.fetchOriginBranch(execFileAsync, projectDir, fetch);
          }
          // Projects created before repo setup was automatic can still have an
          // unborn HEAD (or no repo at all), which `worktree add` can't work
          // with. Give them one before branching off — only when the backend
          // says no repository is still to be checked out (initRepo: true): a
          // local first commit would own the branch a pane checkout creates.
          // An older backend never sends it, which keeps the old behaviour.
          if (initRepo === true) await ensureProjectRepo(projectDir);
          // worktreePath (workspace-clone-v1): a multi-repo project's
          // repository gets its worktree at <wsRoot>/<repo>, not under its own
          // checkout. Only sent to an agent advertising it.
          const worktreePath = typeof msg.worktreePath === 'string' && path.isAbsolute(msg.worktreePath)
            ? remapPath(msg.worktreePath)
            : `${projectDir}/.worktrees/${worktreeName}`;
          const ref = baseRef || 'HEAD';
          // A person's start from the ref this fetch refreshed (worktree-fetch.js startsFromFetch):
          // the only one their Full access leaves unmarked or records as origin's default.
          const fresh = worktreeFetch.startsFromFetch(fetched, fetch, ref);
          // Idempotent, like tmux-create: a worktree already at that path on
          // that branch is reused rather than failed on. That is what lets a
          // second orchestrator (docs/stage.md) adopt a workstream the first
          // one created; a path holding anything else still fails below.
          if (fs.existsSync(worktreePath)) {
            try {
              const { stdout } = await execAsync(`git -C ${shellEscape(worktreePath)} rev-parse --abbrev-ref HEAD`);
              if (stdout.trim() === branch) {
                // A reused run worktree is as unattended as a new one (below).
                if (worktreeFetch.marksUnattended(fetched, attended, fresh)) await markUnattended(worktreePath, branch);
                // A Read only pick never keeps an own mark an earlier create left on this tree.
                if (!worktreeFetch.marksOwn(readOnly)) await worktreeFetch.clearOwn(execFileAsync, worktreePath, branch);
                // The fetch above ran all the same; say so, and where this tree is.
                respond(ws, requestId, {
                  ok: true, path: worktreePath, existing: true,
                  ...(fetched === null ? {} : { fetched, baseSha: await worktreeFetch.headSha(execFileAsync, worktreePath) }),
                });
                break;
              }
            } catch { /* not a worktree: let git worktree add report it */ }
          }
          await execAsync(
            `git -C ${shellEscape(projectDir)} worktree add -b ${shellEscape(branch)} ${shellEscape(worktreePath)} ${shellEscape(ref)}`
          );
          // The chat runner trusts a branch-off only once this proof is written,
          // and only when `ref` is already marked own or is the main worktree's
          // current same-repo branch, or is origin's default branch fetched
          // for a person (attended: a fresh clone's footing, whatever branch
          // the project's checkout is on). A raw commit, a pull ref, any other
          // unmarked origin/<name>, or another remote is left unmarked. An
          // existing worktree reused above is not marked either: a missing
          // marker stays read-only, including a pull-request checkout from
          // before it.
          // A person's Read only pick (readOnly) is never marked own, so it stays read-only.
          if (worktreeFetch.marksOwn(readOnly)) {
            await gitWorktreeOwn.markOwnCheckout({
              worktreePath, branch, repoPath: projectDir, startPoint: ref,
              // Only a start from the ref this fetch refreshed: a failed fetch leaves the box's
              // older origin/<default>, and another start was not fetched at all.
              fetchedDefault: attended === true && fresh,
            }, { execFile: execFileAsync });
          } else {
            await worktreeFetch.clearOwn(execFileAsync, worktreePath, branch);
          }
          // A tree made from origin's tip with nobody watching (an automation
          // run) keeps that fact: the chat runner never loads such a
          // checkout's startup config, even for a later trusted follow-up
          // (chat-runner.js turnModeFor). One a person asked for (attended,
          // worktree-fetch.js) is left as a fresh clone is, but only when it
          // starts from the ref this fetch refreshed (fresh): after a failed
          // fetch, or from any other start, it is marked as a run's is.
          if (worktreeFetch.marksUnattended(fetched, attended, fresh)) await markUnattended(worktreePath, branch);
          respond(ws, requestId, {
            ok: true, path: worktreePath,
            ...(fetched === null ? {} : { fetched, baseSha: await worktreeFetch.headSha(execFileAsync, worktreePath) }),
          });
          break;
        }

        case 'git-worktree-add-pr': {
          // A worktree on a pull request's own branch (git-worktree-pr.js):
          // fetched from pull/<n>/head, or an agent-made worktree adopted.
          const projectDir = remapPath(msg.projectDir);
          // worktreePath (worktree-pr-path-v1): a multi-repo project's <wsRoot>/<repo>, as for git-worktree-add.
          const worktreePath = typeof msg.worktreePath === 'string' && path.isAbsolute(msg.worktreePath) ? remapPath(msg.worktreePath) : undefined;
          respond(ws, requestId, await gitWorktreePr.addPrWorktree({
            projectDir, worktreeName: msg.worktreeName, ...(worktreePath ? { worktreePath } : {}),
            branch: msg.branch, number: msg.number, sameRepo: msg.sameRepo === true, headOid: msg.headOid,
          }, { execFile: execFileAsync }));
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
          // The pane history log rides the rename. The pipe's `cat >>` holds
          // the file open, and an open fd follows the inode across a rename —
          // so moving the path moves the writer with it; without this, reads
          // under the new name 404 while `cat` keeps the old path alive.
          try {
            await fs.promises.rename(
              paneHistory.historyFilePath(process.env.HOME || '/home', from),
              paneHistory.historyFilePath(process.env.HOME || '/home', to),
            );
          } catch (err) {
            if (err.code !== 'ENOENT') {
              console.warn(`[AGENT] pane-history rename ${from} -> ${to} failed: ${err.message}`);
            }
          }
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
          const worktreePath = typeof msg.worktreePath === 'string' && path.isAbsolute(msg.worktreePath)
            ? remapPath(msg.worktreePath)
            : `${projectDir}/.worktrees/${worktreeName}`;
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
          // light: only repository, branch, HEAD and top level, without `git status`, so the
          // backend can find a PR's checkout among several directories (4d).
          if (msg.light === true) {
            respond(ws, requestId, await gitCheckoutFacts(cwd, { execFile: execFileAsync }, { worktrees: msg.worktrees === true }));
            break;
          }
          // verifyRemote: also ask origin whether it holds HEAD (the spawn lifecycle's retire check).
          // base: the commit a spawned checkout was made from, counted against when there is no origin (#453).
          respond(ws, requestId, await gitBranchState(cwd, { execFile: execFileAsync }, { verifyRemote: msg.verifyRemote === true, base: msg.base }));
          break;
        }

        case 'git-changes': {
          // The files a checkout has changed that its upstream lacks, for the
          // simple UI's context card (git-changes.js). Names and line counts only.
          const cwd = remapPath(msg.cwd);
          if (!cwd) throw new Error('cwd is required');
          // branch: the session's PR's head, read from the repository's worktree on it (git-changes.js).
          respond(ws, requestId, await gitChanges.gitChanges(cwd, { execFile: execFileAsync }, { branch: msg.branch }));
          break;
        }

        case 'briefing-digest': {
          // One checkout's transcript extracts and commits in a window, for
          // the daily briefing's ledger (briefing-digest.js). Extracts only.
          const cwd = remapPath(msg.cwd);
          if (!cwd) throw new Error('cwd is required');
          respond(ws, requestId, await briefing.briefingDigest(
            { cwd, since: msg.since, until: msg.until },
            { home: os.homedir() || process.env.HOME || '/', execFile: execFileAsync },
          ));
          break;
        }

        case 'codex-session-start': {
          const { sessionName } = msg;
          const cwd = remapPath(msg.cwd);
          if (!sessionName || !cwd) throw new Error('sessionName and cwd are required');
          // The pane's project and workstream, for the app server's telemetry
          // resource (codex-resource-env.js); an older orchestrator sends none.
          // resumeSessionId: the conversation a tool update stopped in this
          // pane; checked as a Codex thread id there.
          // notice: the line that says why (a tool update's relaunch); an older
          // orchestrator sends none.
          const result = await startCodexSession(sessionName, cwd, codexResourceEnv(msg), msg.resumeSessionId, msg.notice);
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
          try { await execFileAsync('tmux', windowSizeOptionArgv(tmuxSessionName)); } catch { /* the attach reports a missing session */ }
          const term = pty.spawn('tmux', attachSessionArgv(tmuxSessionName), {
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
          await writeClipboardMailbox(CLIPBOARD_SLOT, image);
          // Ctrl+V makes Claude Code read the mailbox immediately, so the
          // keystroke only goes out once the file is fully in place.
          stream.pty.write('\x16');
          break;
        }

        case 'clipboard-paste-image': {
          // The phone's "attach a photo": no PTY stream,
          // so the mailbox is written the same way and Ctrl+V goes in with
          // tmux send-keys (argv, exact session). Validates size and PNG magic
          // and answers an error rather than dropping the image silently.
          // Agents from before this case answer "Unknown command", which the
          // backend turns into a 501.
          respond(ws, requestId, await clipboardPasteImage(msg, { slot: CLIPBOARD_SLOT, execFile: execFileAsync }));
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
            execFile('tmux', mouseOptionArgv(stream.tmuxSessionName, msg.enabled), () => {});
          }
          break;
        }

        // Browser pane. Only the attach answers; the
        // rest are fire-and-forget like the terminal's input and resize.
        case 'browser-attach': {
          respond(ws, requestId, await browsers.attach(msg));
          break;
        }

        case 'browser-input': {
          browsers.input(msg);
          break;
        }

        case 'browser-navigate': {
          browsers.navigate(msg);
          break;
        }

        case 'browser-dialog-answer': {
          browsers.dialog(msg);
          break;
        }

        case 'browser-history': {
          browsers.history(msg);
          break;
        }

        case 'browser-resize': {
          browsers.resize(msg);
          break;
        }

        case 'browser-close': {
          browsers.close(msg.streamId);
          break;
        }

        case 'browser-frame-ack': {
          browsers.frameAck(msg);
          break;
        }

        case 'browser-suggest': {
          respond(ws, requestId, { items: await browsers.suggest(msg) });
          break;
        }

        // The share dialog's look at a workstream's dev stack, for its owner:
        // what a guest's attach would find, and whose stack is in the way.
        case 'browser-guest-check': {
          respond(ws, requestId, await browserGuest.checkRecipe(msg));
          break;
        }

        // A kept profile forgotten (a share revoked or expired) or reset by
        // its viewer: its browser is closed and the profile deleted.
        case 'browser-profile-forget': {
          respond(ws, requestId, await browsers.forgetProfile(msg));
          break;
        }

        case 'browser-profile-reset': {
          respond(ws, requestId, await browsers.resetProfile(msg));
          break;
        }

        // A share was extended: its guests' kept profiles are kept until the new expiry.
        case 'browser-profile-expiry': {
          respond(ws, requestId, browsers.profileExpiry(msg));
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
          // After the ack: a dotfiles claim that waited for GitHub can run now.
          if (msg.provider === 'github') void retryOnClaimAfterGithub(msg.payload);
          // And the pinned t3 server, whose gh:// fetch needed this login, so
          // it is in place before the desktop asks: again, if an install ran
          // (or still runs) without it.
          if (msg.provider === 'github' && t3 && t3Pinned) t3Pinned.retry();
          break;
        }

        case 'credentials-remove': {
          // A bazel-cache remove also carries flushGeneration and seq: a flush
          // reaches a box whose block is off, and a stale remove is refused.
          await credentials.removeCredential(msg.provider, undefined, msg.reason, credentials.removeExtras(msg));
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

        case 'claude-login-status': {
          const view = await claudeSignIn.status();
          console.log(`[CLAUDE-LOGIN] status -> ${view.phase}${view.loggedIn ? ' logged-in' : ''}`);
          respond(ws, requestId, view);
          break;
        }

        case 'claude-login-start': {
          const view = await claudeSignIn.start(msg.email, { reauth: msg.reauth === true });
          console.log(`[CLAUDE-LOGIN] start -> ${view.phase}${view.loggedIn ? ' logged-in' : ''}`);
          respond(ws, requestId, view);
          break;
        }

        case 'claude-login-submit': {
          const code = msg.code;
          msg.code = undefined;
          const view = await claudeSignIn.submit(code);
          console.log(`[CLAUDE-LOGIN] submit -> ${view.phase}${view.loggedIn ? ' logged-in' : ''}`);
          respond(ws, requestId, view);
          break;
        }

        case 'claude-login-cancel': {
          const view = claudeSignIn.cancel();
          console.log('[CLAUDE-LOGIN] cancel');
          respond(ws, requestId, view);
          break;
        }

        case 'chat-send': {
          // A message for a simple-UI chat: start a headless Claude turn in
          // the checkout, or queue it behind the one running. Events follow
          // as chat-event frames.
          const cwd = remapPath(msg.cwd);
          // A repo chat's first turn waits for its checkout (a pane clone runs
          // after the project is already set up).
          if (msg.requireCheckout && cwd && !(await chatRunner.checkoutReady(cwd, execFileAsync))) {
            throw new Error(chatRunner.CHECKOUT_PENDING);
          }
          // A person's message in an ask's chat runs in the thread's clone, not in `cwd` (ask-chat.js).
          if (msg.ask) {
            respond(ws, requestId, await askChats.sendMessage(msg, cwd));
            break;
          }
          respond(ws, requestId, await chats.sendMessage({
            chatKey: msg.chatKey, cwd, text: msg.text, projectId: msg.projectId, project: msg.project, workstream: msg.workstream,
            workstreamId: msg.workstreamId, permissionMode: msg.permissionMode, paneProbe: msg.paneProbe,
            liveInput: msg.liveInput === true, model: msg.model, images: msg.images, orchestrator: msg.orchestrator === true,
            backend: msg.backend, fastModel: msg.fastModel, context: msg.context, models: msg.models, titles: msg.titles === true, headings: msg.headings === true, effort: msg.effort,
            engine: msg.engine,
            genUiPrompt: msg.genUiPrompt,
            genUiHint: msg.genUiHint,
            boxNotices: msg.boxNotices === true, notice: msg.notice,
            spaceMemory: msg.spaceMemory,
            planSpend: msg.planSpend === true,
            // The browser's id for a message it may send again: a repeat is answered as the first send was (chat-send-ids.js).
            sendId: msg.sendId,
            // chat-confined-mcp-v1: which broker connectors the turn may reach (broker-mcp.js).
            brokerMcp: msg.brokerMcp,
          }));
          break;
        }

        case 'chat-file-put': {
          // A file for a simple-UI chat message that doesn't go in its text
          // (chat-files-v1): kept in the chat's checkout, and its path
          // answered for the message to name (chat-files.js). Nothing runs it.
          const cwd = remapPath(msg.cwd);
          respond(ws, requestId, await chatFiles.putFile({ cwd, name: msg.name, data: msg.data }, { execFile: execFileAsync }));
          break;
        }

        case 'chat-engine-check': {
          // Whether a turn on this engine could start now (chat-pi-v1): for
          // pi, termag-pi-headless --check (the owner's AWS SSO session,
          // the broker). Runs no model; at most about 10 s.
          respond(ws, requestId, await chatRunner.checkEngine({ engine: msg.engine }, { home: process.env.HOME || os.homedir() }));
          break;
        }

        case 'chat-session-restore': {
          // A chat continued from a terminated box: its stored session, written
          // here in pieces so the next turn resumes it.
          const cwd = remapPath(msg.cwd);
          respond(ws, requestId, await chats.restoreSession(msg.chatKey, { sessionId: msg.sessionId, cwd, from: msg.from, data: msg.data, done: msg.done === true }));
          break;
        }

        case 'chat-history': {
          // paneProbe: whether the agent pane is Claude, a shell, something
          // else, or unreadable. A claim from Open in full UI stays until a
          // probe has seen Claude and then a shell, so a miss does not start
          // the parked queue. Without a probe (an older backend) the boolean
          // stands: a live chat resumes a queue parked across an agent restart.
          const paneProbe = msg.paneProbe;
          const noted = paneProbe === 'claude' || paneProbe === 'shell' || paneProbe === 'other' || paneProbe === 'unknown'
            ? await chats.notePane(msg.chatKey, paneProbe)
            : null;
          if (noted ? noted.resume : msg.resumeQueue) await chats.resumeQueue(msg.chatKey);
          const cwd = remapPath(msg.cwd);
          const history = await chats.history(msg.chatKey);
          const checkout = msg.requireCheckout && cwd ? await chatRunner.checkoutReady(cwd, execFileAsync) : true;
          respond(ws, requestId, { ...history, checkoutReady: checkout });
          break;
        }

        case 'chat-history-before': {
          // Older history than the page the browser has (chat-history-pages-v1).
          respond(ws, requestId, await chats.historyBefore(msg.chatKey, msg.before, msg.cursor));
          break;
        }

        case 'chat-transcript-read': {
          respond(ws, requestId, await chats.transcriptRead(msg.chatKey, { sessionId: msg.sessionId, from: msg.from, maxBytes: msg.maxBytes }));
          break;
        }

        case 'chat-subagent-read': {
          // A subagent's own transcript, beside the chat's session (chat-subagents-v1).
          respond(ws, requestId, await chats.subagentHistory(msg.chatKey, msg.agentId));
          break;
        }

        // A pane Claude's subagents, and the sessions running alongside it (pane-subagents-v1).
        case 'pane-subagents': {
          respond(ws, requestId, await panes.list(msg.session));
          break;
        }

        case 'pane-subagent-read': {
          respond(ws, requestId, await panes.readSubagent(msg.session, msg.agentId));
          break;
        }

        case 'pane-session-read': {
          respond(ws, requestId, await panes.readSession(msg.session, msg.sessionId));
          break;
        }

        case 'chat-note-pane': {
          // Simple UI reclaim. A shell after Claude was seen clears the claim
          // and a parked queue may start: that Claude is gone, so this is not
          // a second writer on it. A miss never clears a claim.
          const paneProbe = msg.paneProbe;
          if (paneProbe !== 'claude' && paneProbe !== 'shell' && paneProbe !== 'other' && paneProbe !== 'unknown') {
            throw new Error('bad paneProbe');
          }
          const noted = await chats.notePane(msg.chatKey, paneProbe);
          if (noted.resume) await chats.resumeQueue(msg.chatKey);
          respond(ws, requestId, noted);
          break;
        }

        case 'chat-resume-claim': {
          // Open in full UI, before it types the resume. Refused while a turn
          // owns the session; otherwise a queued job cannot start until
          // chat-resume-release. The reply's `line` is what to type: the same
          // permission surface a turn would use for this checkout, never a
          // bare `claude --resume`. cwd is remapped; the mode is the
          // orchestrator's ceiling, and turnModeFor applies the tree.
          respond(ws, requestId, await chats.claimResume(msg.chatKey, {
            cwd: remapPath(msg.cwd),
            permissionMode: msg.permissionMode,
            backend: msg.backend, model: msg.model, fastModel: msg.fastModel, context: msg.context, models: msg.models,
            // The pane's telemetry resource names them (chat-runner.js chatTelemetryEnv); an older orchestrator sends neither.
            project: msg.project, workstream: msg.workstream,
            brokerMcp: msg.brokerMcp,
          }));
          break;
        }

        case 'chat-t3-claim': {
          // The desktop app's thread takes the session (chat-t3-hold-v1): refused
          // while a runner turn or the pane has it; a runner send takes it back.
          respond(ws, requestId, await chats.claimT3(msg.chatKey, { threadId: msg.threadId, workstream: msg.workstream }));
          break;
        }

        case 'chat-resume-release': {
          respond(ws, requestId, await chats.releaseResume(msg.chatKey, { park: msg.park === true, seen: msg.seen === true }));
          break;
        }

        case 'chat-clear': {
          // A chat being archived or deleted: drop its queue, stop its turn.
          respond(ws, requestId, await chats.clear(msg.chatKey));
          break;
        }

        case 'chat-interrupt': {
          respond(ws, requestId, await chats.interrupt(msg.chatKey, { scope: msg.scope === 'turn' ? 'turn' : 'all' }));
          break;
        }

        case 'chat-reset': {
          // Clear context: the chat's next turn starts a new session (chat-context-v1).
          respond(ws, requestId, await chats.resetContext(msg.chatKey, {
            projectId: msg.projectId, workstream: msg.workstream, workstreamId: msg.workstreamId,
          }));
          break;
        }

        case 'chat-resume': {
          // Undo the last clear while no turn has started a new session (chat-context-v1).
          respond(ws, requestId, await chats.resumePrevious(msg.chatKey, {
            projectId: msg.projectId, workstream: msg.workstream, workstreamId: msg.workstreamId,
          }));
          break;
        }

        case 'chat-compact': {
          // A /compact turn on the chat's session (chat-context-v1); events follow as chat-event frames.
          respond(ws, requestId, await chats.compact({
            chatKey: msg.chatKey, cwd: remapPath(msg.cwd), projectId: msg.projectId, project: msg.project, workstream: msg.workstream,
            workstreamId: msg.workstreamId, permissionMode: msg.permissionMode, paneProbe: msg.paneProbe,
            model: msg.model, backend: msg.backend, fastModel: msg.fastModel, context: msg.context, models: msg.models,
          }));
          break;
        }

        case 'chat-sweep': {
          // What this process would take up, so the backend can say which of
          // them belong to an archived project or a deleted workstream.
          respond(ws, requestId, { keys: chats.keysOnDisk() });
          break;
        }

        case 'chat-recover': {
          const deadKeys = Array.isArray(msg.deadKeys) ? msg.deadKeys.filter(k => typeof k === 'string') : [];
          await chats.recover({ deadKeys });
          await askChats.reconcile().catch(err => console.error(`[ASK] reconcile failed: ${err.message}`));
          respond(ws, requestId, { ok: true });
          break;
        }

        case 'init-workspace': {
          // A multi-repo project's workspace or workstream root: the marker
          // and the generated guide, never git (agent/workspace.js).
          // With staticRoot (~/code, a box made from an environment), the root is a link to it.
          respond(ws, requestId, workspace.initWorkspace({
            dir: remapPath(msg.dir), guide: msg.guide, ...(typeof msg.staticRoot === 'string' ? { staticRoot: remapPath(msg.staticRoot), projectId: msg.projectId } : {}),
          }));
          break;
        }

        case 'workspace-root-state': {
          // Which worktrees and which other files a workstream root holds, checked before removing it.
          respond(ws, requestId, workspace.workstreamRootState({ wsRoot: remapPath(msg.wsRoot), repos: msg.repos }));
          break;
        }

        case 'workspace-root-remove': {
          // A workstream root once its worktrees are removed: its guide goes with it, and with force anything else.
          respond(ws, requestId, workspace.removeWorkstreamRoot({ wsRoot: remapPath(msg.wsRoot), force: msg.force === true }));
          break;
        }

        case 'workspace-move': {
          // A multi-repo workstream's rename: its root moves, each worktree in it is repaired, all or nothing.
          respond(ws, requestId, await workspace.moveWorkstreamRoot({
            root: remapPath(msg.root),
            fromDir: remapPath(msg.fromDir),
            toDir: remapPath(msg.toDir),
            repos: msg.repos,
            guides: remapGuides(msg.guides),
          }, { execFile: execFileAsync }));
          break;
        }

        case 'project-clone': {
          const result = await projectClone.handleProjectClone(msg, {
            execFile: execFileAsync,
            home: process.env.HOME || os.homedir(),
            remapPath,
          });
          console.log(`[CLONE] ${msg.projectId}${msg.repo ? `/${msg.repo}` : ''} attempt ${msg.attempt}: ${result.started ? 'started' : result.ignored}`);
          respond(ws, requestId, result);
          if (cloneForwarder) cloneForwarder.tick();
          break;
        }

        case 'environment-prepare': {
          // An environment pool box, before it has an owner: clone its environment's repositories to the static
          // layout and run setup (environment-prepare.js). Refused on any other box.
          const result = await environmentPrepare.handleEnvironmentPrepare(msg, { warm: config.warm === true, configPath });
          console.log(`[ENV-POOL] prepare for ${msg.environmentId}: ${result.error || (result.running ? 'already running' : 'started')}`);
          respond(ws, requestId, result);
          break;
        }

        case 'environment-up': {
          const result = await environmentRun.handleEnvironmentUp(msg, { remapPath });
          console.log(`[ENV] ${msg.projectId}: ${environmentRun.environmentUpLogLine(result)}`);
          respond(ws, requestId, result);
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

        case 'tool-update': {
          // Hands over to the component's unit for this run
          // (termag-claude-update@<run>.service) and answers once systemctl
          // has taken the start: the run stops and resumes sessions for up to
          // an hour, and fetches its own policy (agent/tool-update.js). An
          // error reply means nothing was started.
          const result = await toolUpdate.startToolUpdate(msg, execFileAsync);
          console.log(`[TOOL-UPDATE] started ${result.unit}`);
          respond(ws, requestId, result);
          break;
        }

        case 'ask-run': {
          // Starts deploy/termag-subagent-run detached and answers at once;
          // the runner posts the reply to the orchestrator itself
          // (agent/ask-run.js). With `chat`, the run
          // is a turn of the thread's chat instead (agent/ask-chat.js).
          if (msg.chat) {
            // steerOf (ask-steer-v1): a follow-up into the live turn that run is in, else the turn after it.
            const result = msg.steerOf ? await askChats.steerRun(msg, remapPath(msg.cwd)) : askChats.startRun(msg, remapPath(msg.cwd));
            console.log(`[ASK] run ${msg.runId} on thread ${msg.threadId} ${result.steered ? `steered into ${msg.steerOf}'s turn in` : result.started === false ? `not steered (${result.reason}), nothing started for` : 'going to'} chat ${result.chat}`);
            respond(ws, requestId, result);
            break;
          }
          const result = askRun.startAskRun(msg, remapPath(msg.cwd), { home: os.homedir(), spawn });
          console.log(`[ASK] run ${msg.runId} on thread ${msg.threadId} started (pid ${result.pid})`);
          respond(ws, requestId, result);
          break;
        }

        case 'ask-run-status': {
          respond(ws, requestId, askChats.status(msg));
          break;
        }

        case 'ask-run-cancel': {
          const result = await askChats.cancel(msg);
          console.log(`[ASK] run ${msg.runId} cancel: ${result.stopped ? (result.pid ? `sent TERM to ${result.pid}` : `stopped (${result.stage})`) : 'not running'}`);
          respond(ws, requestId, result);
          break;
        }

        case 'host-sample': {
          respond(ws, requestId, hostSampleNow());
          break;
        }

        case 'unsaved-work': {
          // Read-only git scan before an automatic hibernate (agent/unsaved-work.js).
          respond(ws, requestId, await unsavedWork.scanUnsavedWork(execFileAsync, os.homedir() || process.env.HOME || '/'));
          break;
        }

        case 'disk-grow': {
          // Fixed steps only (disk-grow.js): fill the root volume the orchestrator just grew.
          respond(ws, requestId, await diskGrow.growRootDisk(execFileAsync));
          break;
        }

        case 'software-inventory': {
          // Fixed probes only (software-inventory.js); the request carries no
          // command. The checkout commit is re-read so a pull without a
          // restart shows as "running X, checkout at Y".
          const [inventory, checkoutCommit] = await Promise.all([
            softwareInventory.getInventory(),
            boxUpdate.readCheckoutCommit(execFileAsync, CHECKOUT_DIR).catch(() => null),
          ]);
          respond(ws, requestId, { ...inventory, agentCommit, checkoutCommit });
          break;
        }

        case 'usage-scan': {
          // `since` (YYYY-MM-DD) trims the response, never the cache. Older
          // backends send {} and get everything, as before.
          const result = await usageScanner.scan({ since: msg.since });
          respond(ws, requestId, result);
          break;
        }

        case 't3-ensure':
        case 't3-update':
        case 't3-pair':
        case 't3-revoke':
        case 't3-paths': {
          if (!t3) { respond(ws, requestId, null, 'No t3 command on this box'); break; }
          if (type === 't3-ensure') respond(ws, requestId, await t3.ensure({ label: msg.label, fireworks: msg.fireworks }));
          else if (type === 't3-update') respond(ws, requestId, await t3.update({ version: msg.version, label: msg.label }));
          else if (type === 't3-pair') respond(ws, requestId, await t3.pair({ label: msg.label }));
          else if (type === 't3-revoke') respond(ws, requestId, await t3.revoke({ label: msg.label }));
          else respond(ws, requestId, t3.paths({ paths: msg.paths }));
          break;
        }

        case 'space-sync': {
          respond(ws, requestId, await spaceSync.sync({ space: msg.space }));
          break;
        }

        case 'tunnel-open': {
          // By target: 't3' to the desktop bridge, as before; { kind: 'port' }
          // to the port forward (agent/port-tunnel.js), which needs no t3;
          // { kind: 'preview' } to a preview link's relay, through the same guard and SR6's refusals.
          respond(ws, requestId, await portTunnel.openTunnelRpc(msg, { t3, portTunnels }));
          break;
        }

        // The preview links' publish dialog (agent/preview-listeners.js): the
        // box's listening ports, their processes and the preview guard's verdicts.
        case 'preview-listeners': {
          // `port`: the one a publish names, checked with the DevTools probe too (SR6); the rest by command line only.
          respond(ws, requestId, await previewListenersRpc.previewListeners({
            cwd: typeof msg.cwd === 'string' ? remapPath(msg.cwd) : undefined,
            port: Number.isInteger(msg.port) ? msg.port : undefined,
          }));
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
    if (liveSocket === ws) liveSocket = null;
    chats.holdRecover();
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
    stopCloneForwarder();
    stopEnvForwarder();
    // Kill all active PTY streams. The socket destroy closes the master fd
    // now rather than after node-pty's 1s grace timer.
    for (const [id, stream] of streams) {
      try { stream.pty.kill(); } catch {}
      try { stream.pty._socket && stream.pty._socket.destroy(); } catch {}
    }
    streams.clear();
    // The browsers' viewers are told by the backend when this socket drops;
    // the browsers themselves wait, parked, for the viewers to come back.
    browsers.unbindSocket();
    browsers.parkAll();
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
  projectClone.unitTemplateLoaded(execFileAsync),
  t3Pinned ? t3Pinned.check() : false,
  toolUpdate.loadedComponents(execFileAsync),
]).then(([sha, unitLoaded, at, cloneUnitLoaded, t3Installable, toolUnits]) => {
  agentCommit = sha;
  agentCommitAt = sha ? at : null;
  boxUpdateCapable = unitLoaded;
  toolUpdateComponents = toolUnits;
  console.log(`[AGENT] tool updates: ${toolUnits.length ? toolUnits.map((c) => toolUpdate.TOOL_UNITS[c]).join(', ') + ' installed' : 'no update unit installed, capability not advertised'}`);
  projectCloneCapable = cloneUnitLoaded;
  if (t3Installable) t3 = makeT3Bridge(t3Pinned);
  if (t3Pinned) console.log(`[AGENT] t3 bridge: ${t3Installable ? 'the pinned t3 server is not installed yet; installed when first asked' : 'nothing to install, capability not advertised'}`);
  console.log(`[AGENT] running commit ${sha ? sha.slice(0, 12) : 'unknown (not a git checkout)'}; ${boxUpdate.BOX_UPDATE_UNIT} ${unitLoaded ? 'installed' : 'not installed'}; ${projectClone.UNIT_TEMPLATE} ${cloneUnitLoaded ? 'installed' : 'not installed'}`);
  wrapperCapabilities = runnerWrapper.wrapperCapabilities();
  console.log(`[AGENT] running commit ${sha ? sha.slice(0, 12) : 'unknown (not a git checkout)'}; ${boxUpdate.BOX_UPDATE_UNIT} ${unitLoaded ? 'installed' : 'not installed'}; claude-runner wrapper ${wrapperCapabilities.length ? `announces ${wrapperCapabilities.join(', ')}` : 'predates the git flags or is absent'}`);
  connect();
  softwareInventory.warmInventory();
});

// Graceful shutdown
// The unit's KillMode=process signals only this process: the browsers the
// panes spawned would outlive it. They get up to
// BROWSER_SHUTDOWN_MS to quit, so a kept profile's cookies reach disk
// (Chromium writes them on a timer), and whatever is left is then killed: the
// unit's kill timers die with this process, so nothing else would.
// A kept owner browser's cookie-jar save (up to 4 s) and its quit, and a
// guest's kept profile's longer quit (up to 5 s, cookies flushed), both fit;
// a browser still there after is killed (an owner's dir is emptied before it
// is used again, and the last saved jar stays).
const BROWSER_SHUTDOWN_MS = 10_000;
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[AGENT] Shutting down...');
  claudeSignIn.cancel();
  await Promise.race([browsers.closeAll(), new Promise((r) => setTimeout(r, BROWSER_SHUTDOWN_MS))]);
  browsers.killAll();
  for (const [, stream] of streams) {
    stream.pty.kill();
  }
  for (const sessionName of codexBridges.keys()) {
    stopCodexBridge(sessionName);
  }
  process.exit(0);
}

process.on('SIGTERM', () => { shutdown(); });

process.on('SIGINT', () => { shutdown(); });
