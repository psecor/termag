'use strict';
// The simple UI's chat runner (docs: simple-ui plan, "How the chat drives
// Claude"). One chat is one project workstream whose Claude runs headless:
// each turn is one `claude -p` process in stream-json mode with the message
// on stdin, resuming the chat's session after the first turn. The turn runs
// in its own tmux session under chat-turn.js, writing its events to a log
// the agent tails, so it outlives an agent restart (a box update); every line
// goes to the backend as a numbered `chat-event` frame. The session id is
// kept in ~/.termag/chats/<chat>.json, and Claude's own session file is the
// history (`chat-history`).

const fs = require('fs');
const path = require('path');
const { sessionIdFrom } = require('./chat-turn');

const CAPABILITIES = ['chat-runner-v1', 'chat-durable-v1'];

/** A chat key the backend sends: letters, digits, `-`, `_`, `.`; no path. */
const CHAT_KEY_RE = /^[A-Za-z0-9_.-]{1,160}$/;
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,80}$/;
const MAX_TEXT = 100_000;
const HISTORY_MAX_ENTRIES = 600;
const HISTORY_MAX_BYTES = 8 * 1024 * 1024;
const INTERRUPT_GRACE_MS = 3000;
// Each queued message is a billed turn; cap the backlog so a stuck chat cannot
// pile up an unbounded (and expensive) queue.
const MAX_QUEUE = 20;

function isChatKey(k) { return typeof k === 'string' && CHAT_KEY_RE.test(k) && !k.includes('..'); }
function isSessionId(s) { return typeof s === 'string' && SESSION_ID_RE.test(s); }

/**
 * Every turn runs in dontAsk: tools that are not pre-approved are refused,
 * never run, so a checkout's instructions cannot make Claude run commands as
 * the box user. Running a trusted repository's turns without asking is a
 * later change; until then a request for any other mode is refused.
 */
const PERMISSION_MODE = 'dontAsk';
const BYPASS_REFUSED = 'mode-refused: the chat runner only runs dontAsk';

/**
 * dontAsk alone still runs what the checkout or the box user's settings
 * already allow, so every turn is also closed down to reading:
 * - `--tools` leaves only the read-only built-ins: no Bash, Edit, Write or
 *   Skill tool exists for the turn, whatever an allow rule says;
 * - `--strict-mcp-config` with an empty config starts no MCP server, the
 *   checkout's .mcp.json included;
 * - `--setting-sources user` loads only the box user's settings, never the
 *   checkout's .claude/settings.json or settings.local.json: print mode would
 *   otherwise run their apiKeyHelper (a shell command) and apply their env at
 *   start, before --tools or dontAsk see anything;
 * - the user settings are read from a scratch CLAUDE_CONFIG_DIR that holds
 *   only the gateway credential (chatConfigDir below), so the box owner's own
 *   permission `allow` rules do not load either. Without this a sharee could
 *   ask Claude to Read `~/.ssh` or `~/.config/gh` whenever the owner had
 *   allowed those paths, since allow lists union across sources and dontAsk
 *   only refuses a path that no rule allows;
 * - `--settings` with disableAllHooks keeps the user's hooks from running.
 */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });
const SETTING_SOURCES = 'user';
const TURN_SETTINGS = JSON.stringify({ disableAllHooks: true });

/**
 * Claude Code keeps a session's transcript under
 * ~/.claude/projects/<cwd, every non-alphanumeric turned to '-'>/<id>.jsonl.
 * A rename moves the checkout, so the cwd (and this slug) change; the turn
 * re-homes the transcript to the new slug before --resume (rehomeTranscript).
 */
function slugForCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** The argv for one turn. The message goes on stdin, never in argv. */
function turnArgs(sessionId) {
  const args = [
    '-p',
    '--input-format', 'text',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', PERMISSION_MODE,
    '--tools', READ_ONLY_TOOLS.join(','),
    '--strict-mcp-config',
    '--mcp-config', EMPTY_MCP_CONFIG,
    '--setting-sources', SETTING_SOURCES,
    '--settings', TURN_SETTINGS,
  ];
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

/** Split a stdout chunk into complete lines, carrying the unfinished tail. */
function splitLines(carry, chunk) {
  const text = carry + chunk;
  const parts = text.split('\n');
  const rest = parts.pop();
  return { lines: parts.filter(l => l.trim() !== ''), rest };
}

/** One stream-json line as an event, or null for anything that is not one. */
function parseEvent(line) {
  try {
    const ev = JSON.parse(line);
    return ev && typeof ev === 'object' && typeof ev.type === 'string' ? ev : null;
  } catch { return null; }
}

/**
 * The Claude Code CLI to run: the native install (~/.local/bin), else one on
 * PATH, else the newest nvm global. The agent runs under systemd, whose PATH
 * has no nvm, which is where boxes install Claude Code with npm.
 */
function resolveClaude({ home, env = process.env, exists = fs.existsSync, readdir = fs.readdirSync }) {
  if (env.TERMAG_CHAT_CLAUDE) return env.TERMAG_CHAT_CLAUDE;
  const native = path.join(home, '.local/bin/claude');
  if (exists(native)) return native;
  for (const dir of (env.PATH || '').split(':')) {
    if (dir && exists(path.join(dir, 'claude'))) return path.join(dir, 'claude');
  }
  const nvm = path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions/node');
  let versions = [];
  try { versions = readdir(nvm); } catch { /* no nvm */ }
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    const bin = path.join(nvm, v, 'bin/claude');
    if (exists(bin)) return bin;
  }
  return 'claude';
}

/**
 * The environment of a turn: the agent's, without the tmux variables (so the
 * box's status hooks, which key on the pane, post nothing for it) and with
 * the claude binary's own directory on PATH (an nvm install finds its node).
 */
function turnEnv(env, claudeBin, configDir) {
  const next = { ...env };
  delete next.TMUX;
  delete next.TMUX_PANE;
  const dir = path.dirname(claudeBin);
  if (dir && dir !== '.' && !(next.PATH || '').split(':').includes(dir)) next.PATH = `${dir}:${next.PATH || ''}`;
  if (configDir) next.CLAUDE_CONFIG_DIR = configDir;
  return next;
}

/**
 * A scratch config dir for the turn's `--setting-sources user`: it carries
 * only the gateway credential, never the owner's permission `allow` rules.
 *   settings.json     the owner's apiKeyHelper + env, nothing else
 *   projects          a symlink to ~/.claude/projects, so transcripts stay in
 *                     the usual place (history and resume read them there)
 *   .credentials.json a symlink to the owner's, for an OAuth login
 * Rebuilt each turn so a rotated credential is picked up. Returns the dir.
 */
function prepareChatConfigDir(home, fsImpl = fs) {
  const real = path.join(home, '.claude');
  const dir = path.join(home, '.termag/chat-config');
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fsImpl.mkdirSync(path.join(real, 'projects'), { recursive: true });
  linkInto(fsImpl, path.join(dir, 'projects'), path.join(real, 'projects'));
  const creds = path.join(real, '.credentials.json');
  if (fsImpl.existsSync(creds)) linkInto(fsImpl, path.join(dir, '.credentials.json'), creds);
  let gateway = {};
  try {
    const owner = JSON.parse(fsImpl.readFileSync(path.join(real, 'settings.json'), 'utf8'));
    for (const k of ['apiKeyHelper', 'env']) if (owner[k] != null) gateway[k] = owner[k];
  } catch { /* no owner settings: an empty scratch settings still confines reads */ }
  fsImpl.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(gateway), { mode: 0o600 });
  return dir;
}

/** Point `link` at `target` (a symlink), replacing anything already there. */
function linkInto(fsImpl, link, target) {
  try {
    if (fsImpl.readlinkSync(link) === target) return;
    fsImpl.rmSync(link, { recursive: true, force: true });
  } catch { /* not a symlink or absent */ try { fsImpl.rmSync(link, { recursive: true, force: true }); } catch { /* absent */ } }
  fsImpl.symlinkSync(target, link);
}

/**
 * Move a session's transcript to the slug dir of `newCwd` so `--resume` finds
 * it after a rename moved the checkout. A no-op when it is already there or
 * there is no transcript yet.
 */
function rehomeTranscript(home, sessionId, newCwd, fsImpl = fs) {
  const file = findTranscript(home, sessionId, { readdir: fsImpl.readdirSync, exists: fsImpl.existsSync });
  if (!file) return;
  const newDir = path.join(home, '.claude/projects', slugForCwd(newCwd));
  if (path.dirname(file) === newDir) return;
  try {
    fsImpl.mkdirSync(newDir, { recursive: true });
    fsImpl.renameSync(file, path.join(newDir, `${sessionId}.jsonl`));
  } catch { /* leave it; --resume may miss, but the turn still runs */ }
}

/**
 * The conversation in a session's JSONL transcript, as the entries the
 * browser renders: user and assistant messages of the main thread, without
 * Claude Code's meta entries. Each entry keeps the stream-json shape
 * ({type, message, uuid}), so history and live events share one reducer.
 */
function historyEntries(jsonl, max = HISTORY_MAX_ENTRIES) {
  const out = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || (e.type !== 'user' && e.type !== 'assistant')) continue;
    if (e.isMeta || e.isSidechain || !e.message) continue;
    out.push({
      type: e.type,
      uuid: typeof e.uuid === 'string' ? e.uuid : undefined,
      timestamp: typeof e.timestamp === 'string' ? e.timestamp : undefined,
      message: {
        id: typeof e.message.id === 'string' ? e.message.id : undefined,
        role: e.message.role,
        content: e.message.content,
      },
    });
  }
  return out.slice(-max);
}

/**
 * Whether a repo chat's checkout is there: HEAD resolves to a commit. A box
 * that clones in the pane types the checkout ahead of everything else and
 * the project is set up at once, so a first turn must wait for this; an
 * empty project's dir is a fresh `git init` with no commit and asks for no
 * checkout.
 */
async function checkoutReady(cwd, execFile) {
  try {
    await execFile('git', ['-C', cwd, 'rev-parse', '--verify', '-q', 'HEAD^{commit}'], { timeout: 5000 });
    return true;
  } catch { return false; }
}

/** Refused by chat-send while the checkout is not there yet; the backend answers 409 checkout-pending. */
const CHECKOUT_PENDING = 'checkout-pending: the repository is still being checked out';

/**
 * The last `maxBytes` of a file as text, from the first whole line on; ''
 * when it cannot be read. The descriptor is closed whatever happens.
 */
function readTail(file, maxBytes, fsImpl = fs) {
  let fd = null;
  try {
    const st = fsImpl.statSync(file);
    fd = fsImpl.openSync(file, 'r');
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    fsImpl.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd != null) { try { fsImpl.closeSync(fd); } catch { /* already gone */ } }
  }
}

/** The transcript as it was when a turn started: the first `bytes`, through the last whole line. */
function transcriptPrefix(file, bytes) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const n = Math.min(Math.max(0, bytes), size);
    const buf = Buffer.alloc(n);
    if (n) fs.readSync(fd, buf, 0, n, 0);
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n');
    const whole = end === -1 ? '' : text.slice(0, end + 1);
    if (Buffer.byteLength(whole) <= HISTORY_MAX_BYTES) return whole;
    const tail = whole.slice(-HISTORY_MAX_BYTES);
    const nl = tail.indexOf('\n');
    return nl === -1 ? '' : tail.slice(nl + 1);
  } catch {
    return '';
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
}

/** The transcript of a session: Claude keeps it under ~/.claude/projects/<cwd, encoded>/<id>.jsonl. */
function findTranscript(home, sessionId, { readdir = fs.readdirSync, exists = fs.existsSync } = {}) {
  if (!isSessionId(sessionId)) return null;
  const root = path.join(home, '.claude/projects');
  let dirs = [];
  try { dirs = readdir(root); } catch { return null; }
  for (const d of dirs) {
    const file = path.join(root, d, `${sessionId}.jsonl`);
    if (exists(file)) return file;
  }
  return null;
}

/** The tmux-safe form of a unix user name, as runner sessions write it (runner-sessions.js). */
function tmuxSafe(s) { return String(s).replace(/_/g, '__').replace(/\./g, '_d'); }

/**
 * A turn's tmux session: `<user>-chat-<turn>-r`. The `-r` tail keeps it from
 * parsing as a project pane (as the briefing's and the cloud runner's), and
 * it is not a cloud runner session, so termag-box-update does not defer an
 * agent restart for it: the turn outlives the restart (KillMode=process).
 */
function turnSessionName(username, turnId) {
  return `${tmuxSafe(username)}-chat-${turnId}-r`;
}

/** Complete lines in a chunk of the event log: the lines and how many bytes they took. */
function completeLines(buf) {
  const text = buf.toString('utf8');
  const end = text.lastIndexOf('\n');
  if (end === -1) return { lines: [], bytes: 0 };
  const whole = text.slice(0, end + 1);
  return { lines: whole.split('\n').slice(0, -1), bytes: Buffer.byteLength(whole) };
}

/**
 * The transcript entries before the turn still running: Claude writes a
 * turn's messages to its session file as they happen, and the running turn
 * is replayed from its own event log instead, so its prompt and everything
 * after it are cut. Without that prompt in the transcript yet, nothing is cut.
 */
function entriesBeforeTurn(entries, text) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'user') continue;
    const c = e.message?.content;
    const prompt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(p => p?.type === 'text').map(p => p.text).join('\n') : null;
    if (prompt === text) return entries.slice(0, i);
  }
  return entries;
}

const DIED = 'This turn stopped before Claude finished: its process ended while nobody was watching (the box may have restarted). Send the message again to continue.';
const TURN_EVENTS_MAX = 5000;
const ALIVE_CHECK_MS = 10_000;
const DONE_KEEP_MS = 60 * 60 * 1000;

/**
 * The runner. Each turn runs in its own tmux session (startProcess runs
 * chat-turn.js there), so it outlives this agent: the agent only tails the
 * turn's event log and forwards each line as a `chat-event` frame numbered
 * `seq` (its line, from 1). How far it got is kept beside the log, so an
 * agent started again resumes there, and a turn whose session is gone with
 * no `exit` is closed as died. A message sent while a turn runs waits in a
 * per-chat queue file and starts when that turn is over. A queue this agent
 * did not see grow (one found after a restart, or behind a turn taken up
 * from a previous agent) is parked: it never starts on its own, because the
 * chat may have been archived or its box stopped meanwhile. It starts when
 * the backend speaks for the chat again (a chat-send, or chat-history with
 * resumeQueue, both only for a live project), or chat-clear drops it.
 *
 * The turn itself is still #404's: dontAsk, read-only tools, the scratch
 * config dir, and a transcript that follows a renamed checkout.
 */
function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code !== 'ESRCH'; }
}

function createChatRunner({
  home, send, isOpen = () => true, startProcess, sessionAlive, signalPid, stopSession = async () => {},
  pidAlive = pidIsAlive, interruptGraceMs = INTERRUPT_GRACE_MS,
  env = process.env, claudeBin, username = 'user', log = () => {}, now = Date.now,
}) {
  const root = path.join(home, '.termag/chats');
  const turnsDir = path.join(root, 'turns');
  const active = new Map();
  const parked = new Set();
  // Chats a chat-clear is stopping. A send is refused and nothing queued
  // starts, so no turn runs after the revoke was told the chat is stopped.
  const clearing = new Set();
  const bin = () => claudeBin || resolveClaude({ home, env });
  let lastAliveCheck = 0;
  // poll/send/history/clear wait out an in-flight recover, so a chat-send
  // cannot start a second turn on a session recover has not taken up yet.
  // holdRecover() arms it at process start; until recover() finishes it stays
  // shut. Tests that never hold it see an already-open gate.
  let gate = Promise.resolve();
  let releaseGate = null;
  // A close during recover() cannot arm a gate while releaseGate is already
  // set. Remember it and re-arm in the finally, before the old gate resolves,
  // so the next connection waits for its own chat-recover.
  let recovering = 0;
  let holdAgain = false;

  const stateFile = chatKey => path.join(root, `${chatKey}.json`);
  const queueFile = chatKey => path.join(root, `${chatKey}.queue.json`);
  const ensureRoot = () => fs.mkdirSync(turnsDir, { recursive: true, mode: 0o700 });

  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }
  function writeJson(file, value) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  function readState(chatKey) {
    const s = readJson(stateFile(chatKey), {});
    return { sessionId: isSessionId(s.sessionId) ? s.sessionId : null, cwd: typeof s.cwd === 'string' ? s.cwd : null };
  }
  function writeState(chatKey, state) {
    ensureRoot();
    writeJson(stateFile(chatKey), { ...state, updatedAt: new Date(now()).toISOString() });
  }
  const readQueue = chatKey => { const q = readJson(queueFile(chatKey), []); return Array.isArray(q) ? q : []; };
  function writeQueue(chatKey, queue) {
    ensureRoot();
    if (queue.length) writeJson(queueFile(chatKey), queue);
    else fs.rmSync(queueFile(chatKey), { force: true });
  }
  const activeFor = chatKey => [...active.values()].find(t => t.meta.chatKey === chatKey) || null;
  const stillRunning = t => Boolean(t) && !fs.existsSync(path.join(t.dir, 'exit'));

  function emit(meta, turnId, seq, event) {
    return send({
      type: 'chat-event', chatKey: meta.chatKey, projectId: meta.projectId, workstream: meta.workstream,
      workstreamId: meta.workstreamId, turnId, seq, event,
    });
  }

  /**
   * The session id Claude already announced, kept even when the wrapper never
   * finishes: a reboot or an OOM leaves the init line in the log and no write
   * from chat-turn.js. An id that is not there does not wipe one we have.
   */
  function rememberSession(t) {
    let log = '';
    try { log = fs.readFileSync(path.join(t.dir, 'events.jsonl'), 'utf8'); } catch { return; }
    const sessionId = sessionIdFrom(log);
    if (!sessionId) return;
    const prev = readState(t.meta.chatKey);
    const cwd = typeof t.meta.cwd === 'string' ? t.meta.cwd : prev.cwd;
    if (prev.sessionId === sessionId && prev.cwd === cwd) return;
    writeState(t.meta.chatKey, { sessionId, cwd });
  }

  /** Close a turn the agent can no longer finish. A deliberate interrupt is not a failure. */
  function closeTurn(t, message) {
    rememberSession(t);
    const interrupted = fs.existsSync(path.join(t.dir, 'interrupted'));
    const lines = [];
    if (!interrupted && message) lines.push(JSON.stringify({ type: 'runner-error', message }));
    lines.push(JSON.stringify({
      type: 'turn-end', exitCode: null, signal: interrupted ? 'SIGINT' : null, lost: !interrupted,
    }));
    fs.appendFileSync(path.join(t.dir, 'events.jsonl'), `${lines.join('\n')}\n`);
    writeJson(path.join(t.dir, 'exit'), { code: null, signal: interrupted ? 'SIGINT' : null, lost: !interrupted });
  }

  function markInterrupted(t) {
    try { fs.writeFileSync(path.join(t.dir, 'interrupted'), ''); } catch { /* the wrapper then reports the exit as an error */ }
  }

  async function startTurn(job) {
    ensureRoot();
    const state = readState(job.chatKey);
    if (state.sessionId && state.cwd && state.cwd !== job.cwd) {
      rehomeTranscript(home, state.sessionId, job.cwd);
      writeState(job.chatKey, { sessionId: state.sessionId, cwd: job.cwd });
    }
    const configDir = prepareChatConfigDir(home);
    const turnId = `${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = path.join(turnsDir, turnId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const claude = bin();
    const turnEnvironment = turnEnv(env, claude, configDir);
    // Where the transcript ended before this turn. History cuts there, not on
    // the prompt text: an earlier turn that said the same thing ("go", "yes")
    // would otherwise take everything after it out of the view.
    let transcriptBytes = null;
    if (state.sessionId) {
      const existing = findTranscript(home, state.sessionId);
      transcriptBytes = 0;
      if (existing) { try { transcriptBytes = fs.statSync(existing).size; } catch { transcriptBytes = 0; } }
    }
    const meta = {
      chatKey: job.chatKey, projectId: job.projectId, workstream: job.workstream, workstreamId: job.workstreamId, turnId,
      session: turnSessionName(username, turnId), cwd: job.cwd, text: job.text, resumed: Boolean(state.sessionId),
      bin: claude, args: turnArgs(state.sessionId), path: turnEnvironment.PATH, configDir, stateFile: stateFile(job.chatKey),
      startedAt: new Date(now()).toISOString(), transcriptBytes,
    };
    fs.writeFileSync(path.join(dir, 'prompt.txt'), job.text, { mode: 0o600 });
    writeJson(path.join(dir, 'meta.json'), meta);
    writeJson(path.join(dir, 'forwarded.json'), { offset: 0, seq: 0 });
    const t = { dir, meta, offset: 0, seq: 0, starting: true, cancelled: false, started: null };
    // In the map before the session exists, so a second send waits. The
    // liveness check skips `starting`: has-session is false until tmux is up.
    active.set(turnId, t);
    const started = startProcess(meta, dir);
    t.started = started;
    try {
      await started;
      if (!t.cancelled) {
        log(`[CHAT] ${job.chatKey} turn ${turnId} started in ${meta.session}${state.sessionId ? ` (resume ${state.sessionId.slice(0, 8)})` : ''}`);
      }
      // A cancelled turn returns the id either way. The clear that set the
      // flag is waiting on signalStop and must not see an exit file this
      // function writes: the wrapper has not exited.
    } catch (err) {
      if (!fs.existsSync(path.join(dir, 'exit'))) {
        if (!t.cancelled) {
          fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn-start', text: job.text, resumed: Boolean(state.sessionId) })}\n`);
        }
        // Create failed: no wrapper is running, so the turn is already dead.
        closeTurn(t, t.cancelled ? null : `could not start the turn: ${err.message}`);
      }
    } finally {
      t.starting = false;
    }
    return turnId;
  }

  async function startNext(chatKey) {
    // A turn still in the map, even one whose exit is written, has not been
    // swept yet: the next message waits for that sweep so two turns never start.
    if (activeFor(chatKey) || parked.has(chatKey) || clearing.has(chatKey)) return;
    const queue = readQueue(chatKey);
    const job = queue.shift();
    if (!job) return;
    writeQueue(chatKey, queue);
    await startTurn(job);
  }

  /** Forward what each turn's log gained since the last look; finish turns that are over. */
  function pruneFinished() {
    let names = [];
    try { names = fs.readdirSync(turnsDir); } catch { return; }
    for (const name of names) {
      const dir = path.join(turnsDir, name);
      const done = path.join(dir, 'done');
      if (!fs.existsSync(done)) continue;
      try { if (now() - fs.statSync(done).mtimeMs > DONE_KEEP_MS) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* raced */ }
    }
  }

  async function poll() {
    await gate;
    if (!isOpen()) return;
    const checkAlive = now() - lastAliveCheck >= ALIVE_CHECK_MS;
    if (checkAlive) {
      lastAliveCheck = now();
      pruneFinished();
    }
    for (const t of [...active.values()]) {
      const file = path.join(t.dir, 'events.jsonl');
      // A session that has not been created yet must not be closed as died.
      if (checkAlive && !t.starting && !fs.existsSync(path.join(t.dir, 'exit')) && !(await sessionAlive(t.meta.session))) {
        // A wrapper always writes `exit` last; no session and no exit means it
        // died. Except while a stop is under way: kill-session removes the
        // session at once, and the wrapper is still killing Claude. Its own
        // exit comes when Claude is gone.
        const stopping = t.cancelled && childAlive(t);
        if (!stopping && !t.starting && !fs.existsSync(path.join(t.dir, 'exit'))) closeTurn(t, DIED);
      }
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* not started yet */ }
      if (size > t.offset) {
        const fd = fs.openSync(file, 'r');
        let buf;
        try {
          buf = Buffer.alloc(size - t.offset);
          fs.readSync(fd, buf, 0, buf.length, t.offset);
        } finally {
          fs.closeSync(fd);
        }
        const { lines, bytes } = completeLines(buf);
        let sentBytes = 0;
        let sentAll = true;
        for (const line of lines) {
          const lineBytes = Buffer.byteLength(line) + 1;
          const event = parseEvent(line);
          if (event) {
            if (event.type === 'system' && event.subtype === 'init' && isSessionId(event.session_id)) {
              writeState(t.meta.chatKey, { sessionId: event.session_id, cwd: t.meta.cwd });
            }
            const ok = emit(t.meta, t.meta.turnId, t.seq + 1, event);
            if (ok === false) { sentAll = false; break; }
          }
          t.seq++;
          sentBytes += lineBytes;
        }
        if (sentBytes) {
          t.offset += sentBytes;
          writeJson(path.join(t.dir, 'forwarded.json'), { offset: t.offset, seq: t.seq });
        }
        if (!sentAll || sentBytes < bytes) continue;
      }
      // turn-end and exit land together, often while the lines above were
      // being forwarded. The size from the top of the loop is already stale
      // then; stat again or the turn is marked done without those lines.
      if (fs.existsSync(path.join(t.dir, 'exit'))) {
        let endSize = size;
        try { endSize = fs.statSync(file).size; } catch { /* gone */ }
        if (t.offset < endSize) continue;
      }
      if (fs.existsSync(path.join(t.dir, 'exit')) && t.offset >= size) {
        fs.writeFileSync(path.join(t.dir, 'done'), new Date(now()).toISOString());
        active.delete(t.meta.turnId);
        log(`[CHAT] ${t.meta.chatKey} turn ${t.meta.turnId} done`);
        const waiting = readQueue(t.meta.chatKey).length;
        if (t.recovered && waiting) {
          // A previous agent's turn, and this process has not accepted the queue.
          // What queued behind it waits for the backend.
          parked.add(t.meta.chatKey);
          emit(t.meta, t.meta.turnId, null, { type: 'queue-parked', queued: waiting });
          log(`[CHAT] ${t.meta.chatKey} parked ${waiting} queued message(s) until the backend resumes the chat`);
        }
        await startNext(t.meta.chatKey);
      }
    }
  }

  /** Stop a turn whose project was archived or whose workstream is gone, and do not take it up. */
  async function abandon(meta, dir) {
    try { await stopSession(meta.session); } catch { /* already gone */ }
    if (!fs.existsSync(path.join(dir, 'exit'))) {
      try {
        fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn-end', exitCode: null, signal: null, lost: true })}\n`);
      } catch { /* the log may not exist yet */ }
      writeJson(path.join(dir, 'exit'), { code: null, signal: null, lost: true, refused: true });
    }
    try { fs.writeFileSync(path.join(dir, 'done'), new Date(now()).toISOString()); } catch { /* raced */ }
    writeQueue(meta.chatKey, []);
    parked.delete(meta.chatKey);
    if (meta.turnId) active.delete(meta.turnId);
    log(`[CHAT] ${meta.chatKey} refused: the project is archived or the workstream is gone`);
  }

  async function doRecover(deadKeys) {
    let names = [];
    try { names = fs.readdirSync(turnsDir); } catch { names = []; }
    for (const name of names) {
      const dir = path.join(turnsDir, name);
      const meta = readJson(path.join(dir, 'meta.json'), null);
      if (!meta || !isChatKey(meta.chatKey)) continue;
      const done = path.join(dir, 'done');
      if (fs.existsSync(done)) continue;
      if (deadKeys.has(meta.chatKey)) {
        await abandon(meta, dir);
        continue;
      }
      // A turn this process already runs keeps its recovered flag. Marking it
      // again would park a queue this process accepted when the turn ends.
      if (active.has(meta.turnId)) continue;
      const fwd = readJson(path.join(dir, 'forwarded.json'), { offset: 0, seq: 0 });
      const t = { dir, meta, offset: Number(fwd.offset) || 0, seq: Number(fwd.seq) || 0, recovered: true, starting: false, cancelled: false };
      active.set(meta.turnId, t);
      if (!fs.existsSync(path.join(dir, 'exit')) && !(await sessionAlive(meta.session))) {
        log(`[CHAT] ${meta.chatKey} turn ${meta.turnId} died while the agent was away`);
        closeTurn(t, DIED);
      } else {
        log(`[CHAT] ${meta.chatKey} turn ${meta.turnId} taken up at line ${t.seq}`);
      }
    }
    pruneFinished();
    let files = [];
    try { files = fs.readdirSync(root); } catch { files = []; }
    for (const f of files) {
      const m = /^(.+)\.queue\.json$/.exec(f);
      if (!m || !isChatKey(m[1])) continue;
      if (deadKeys.has(m[1])) {
        writeQueue(m[1], []);
        parked.delete(m[1]);
        log(`[CHAT] ${m[1]} queue dropped: the project is archived or the workstream is gone`);
        continue;
      }
      // A turn this process already has in hand keeps its queue. Parking it
      // again would stall messages the user sent after the agent was up.
      if (readQueue(m[1]).length && !activeFor(m[1])) {
        parked.add(m[1]);
        log(`[CHAT] ${m[1]} has queued messages from before this agent; parked until the backend resumes the chat`);
      }
    }
  }

  /** The backend speaks for a live chat: start what was parked. */
  async function resumeQueue(chatKey) {
    await gate;
    if (!isChatKey(chatKey)) throw new Error('bad chatKey');
    const was = parked.delete(chatKey);
    if (was) log(`[CHAT] ${chatKey} queue resumed`);
    // The backend is speaking. A turn taken up from a previous process should
    // start what is queued when it ends, instead of parking it again.
    const running = activeFor(chatKey);
    if (running) running.recovered = false;
    await startNext(chatKey);
    return { resumed: was };
  }

  function readPid(dir) {
    try {
      const pid = Number(fs.readFileSync(path.join(dir, 'claude.pid'), 'utf8').trim());
      return Number.isInteger(pid) && pid > 0 ? pid : 0;
    } catch { return 0; }
  }

  function childAlive(t) {
    const pid = readPid(t.dir);
    return pid !== 0 && pidAlive(pid);
  }

  /**
   * Claude is gone and so is the tmux session. A live recorded pid is never
   * dead, whatever the exit file says: closeTurn can write one while the
   * wrapper is still in its hangup path. A reused pid reads as alive, which
   * fails the revoke rather than passing it.
   */
  async function turnDead(t) {
    if (childAlive(t)) return false;
    return !(await sessionAlive(t.meta.session));
  }

  function delay(ms) { return new Promise(resolve => { setTimeout(resolve, ms); }); }

  /** SIGINT now, SIGTERM then SIGKILL on the same grace a running turn uses. The timers are not the answer to chat-clear. */
  function armEscalation(t, pid) {
    if (!pid) return;
    signalPid(pid, 'SIGINT');
    const grace = interruptGraceMs;
    setTimeout(() => { if (!fs.existsSync(path.join(t.dir, 'exit'))) signalPid(pid, 'SIGTERM'); }, grace).unref?.();
    setTimeout(() => { if (!fs.existsSync(path.join(t.dir, 'exit'))) signalPid(pid, 'SIGKILL'); }, grace * 2).unref?.();
  }

  /**
   * Stop the turn's session. A turn that is still being created is killed
   * after tmux create returns, with the same escalation as a running one.
   * kill-session's failure propagates: a swallowed error is not a stopped turn.
   */
  async function signalStop(t) {
    markInterrupted(t);
    t.cancelled = true;
    if (t.starting && t.started) {
      try { await t.started; } catch { /* create failed; startTurn records that the wrapper never ran */ }
    }
    armEscalation(t, readPid(t.dir));
    await stopSession(t.meta.session);
  }

  /** chat-clear waits until the wrapper is dead, including the SIGKILL grace. */
  async function awaitDead(t) {
    const step = Math.min(50, Math.max(5, interruptGraceMs || 5));
    // Past the SIGKILL timer, so a last look sees the escalation and not the moment it is armed.
    const deadline = Date.now() + interruptGraceMs * 2 + step * 3;
    while (true) {
      if (await turnDead(t)) return true;
      if (Date.now() >= deadline) return false;
      await delay(step);
    }
  }

  function keyRow(chatKey, projectId, workstreamId) {
    const split = chatKey.indexOf('--');
    const fromKey = split > 0
      ? { projectId: chatKey.slice(0, split), workstreamId: chatKey.slice(split + 2) }
      : { projectId: '', workstreamId: '' };
    return {
      chatKey,
      projectId: typeof projectId === 'string' && projectId ? projectId : fromKey.projectId,
      workstreamId: typeof workstreamId === 'string' && workstreamId ? workstreamId : fromKey.workstreamId,
    };
  }

  function keysOnDisk() {
    const out = [];
    const seen = new Set();
    let names = [];
    try { names = fs.readdirSync(turnsDir); } catch { names = []; }
    for (const name of names) {
      const dir = path.join(turnsDir, name);
      if (fs.existsSync(path.join(dir, 'done'))) continue;
      const meta = readJson(path.join(dir, 'meta.json'), null);
      if (!meta || !isChatKey(meta.chatKey) || seen.has(meta.chatKey)) continue;
      seen.add(meta.chatKey);
      out.push(keyRow(meta.chatKey, meta.projectId, meta.workstreamId));
    }
    let files = [];
    try { files = fs.readdirSync(root); } catch { files = []; }
    for (const f of files) {
      const m = /^(.+)\.queue\.json$/.exec(f);
      if (!m || !isChatKey(m[1]) || seen.has(m[1]) || !readQueue(m[1]).length) continue;
      seen.add(m[1]);
      const job = readQueue(m[1])[0] || {};
      out.push(keyRow(m[1], job.projectId, job.workstreamId));
    }
    return out;
  }

  function eventsFromLog(dir, turnId) {
    let log = '';
    try { log = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'); } catch { /* not started */ }
    const events = [];
    completeLines(Buffer.from(log)).lines.forEach((line, i) => {
      const event = parseEvent(line);
      if (event) events.push({ seq: i + 1, event });
    });
    return { turnId, events: events.slice(-TURN_EVENTS_MAX) };
  }

  /** The newest turn of a chat that died, so a reload still shows its error after exit is written. */
  function lostTurn(chatKey, live) {
    const candidate = live || newestStoredTurn(chatKey);
    if (!candidate || stillRunning(candidate)) return null;
    const exit = readJson(path.join(candidate.dir, 'exit'), null);
    return exit && exit.lost === true ? candidate : null;
  }

  function newestStoredTurn(chatKey) {
    let names = [];
    try { names = fs.readdirSync(turnsDir); } catch { return null; }
    let best = null;
    for (const name of names) {
      const dir = path.join(turnsDir, name);
      const meta = readJson(path.join(dir, 'meta.json'), null);
      if (!meta || meta.chatKey !== chatKey || typeof meta.startedAt !== 'string') continue;
      if (!best || meta.startedAt > best.meta.startedAt) best = { dir, meta };
    }
    return best;
  }

  return {
    poll,
    holdRecover() {
      // recover() is in flight and will clear releaseGate in its finally.
      // Arming here is a no-op; the finally re-arms before it lets waiters go.
      if (recovering > 0) { holdAgain = true; return; }
      if (releaseGate) return;
      holdAgain = false;
      gate = new Promise((resolve, reject) => { releaseGate = { resolve, reject }; });
    },
    keysOnDisk,
    async recover(opts = {}) {
      const deadKeys = new Set(Array.isArray(opts.deadKeys) ? opts.deadKeys : []);
      recovering += 1;
      try {
        await doRecover(deadKeys);
      } finally {
        recovering -= 1;
        const release = releaseGate;
        releaseGate = null;
        if (holdAgain) {
          holdAgain = false;
          gate = new Promise((resolve, reject) => { releaseGate = { resolve, reject }; });
        }
        release?.resolve();
      }
    },
    resumeQueue,

    /** Start a turn, or queue it behind the one running. */
    async sendMessage({ chatKey, cwd, text, projectId, workstream, workstreamId, permissionMode }) {
      await gate;
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      if (clearing.has(chatKey)) throw new Error('chat-clearing: this chat is being stopped');
      if (permissionMode != null && permissionMode !== PERMISSION_MODE) throw new Error(BYPASS_REFUSED);
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be absolute');
      if (typeof text !== 'string' || !text.trim()) throw new Error('text is required');
      if (text.length > MAX_TEXT) throw new Error('text is too long');
      ensureRoot();
      const job = {
        chatKey, cwd, text, projectId: String(projectId || ''), workstream: String(workstream || 'main'),
        workstreamId: workstreamId != null ? String(workstreamId) : null,
      };
      const queue = readQueue(chatKey);
      if (activeFor(chatKey) || queue.length) {
        if (queue.length >= MAX_QUEUE) throw new Error('queue-full: too many messages are already waiting');
        queue.push(job);
        writeQueue(chatKey, queue);
        // A send is the backend speaking for a live chat: a parked queue goes on, oldest first.
        parked.delete(chatKey);
        const running = activeFor(chatKey);
        if (running) running.recovered = false;
        await startNext(chatKey);
        return { queued: true, position: readQueue(chatKey).length };
      }
      return { queued: false, turnId: await startTurn(job) };
    },

    /**
     * Drop a chat's queue and stop its running turn: for a chat being
     * archived or deleted, so nothing it left behind ever runs.
     */
    async clear(chatKey) {
      await gate;
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      clearing.add(chatKey);
      try {
        const cleared = readQueue(chatKey).length;
        writeQueue(chatKey, []);
        parked.delete(chatKey);
        const t = activeFor(chatKey);
        // Idle, or its exit is written and Claude is gone. stopped is true only
        // once nothing is left alive, so a revoke can refuse a turn still going.
        if (!stillRunning(t) && !(t && childAlive(t))) return { cleared, stopped: true };
        try {
          await signalStop(t);
        } catch { /* kill-session failed; awaitDead is what decides */ }
        return { cleared, stopped: await awaitDead(t) };
      } finally {
        clearing.delete(chatKey);
      }
    },

    /**
     * Stop the running turn (SIGINT, then SIGTERM, then SIGKILL) and drop the
     * queue. The dropped messages are answered and sent as a `queue-dropped`
     * event, so every open view takes their queued bubbles down. The wrapper
     * sees `interrupted` and does not report that stop as a runner error.
     */
    async interrupt(chatKey) {
      await gate;
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      const queued = readQueue(chatKey);
      const dropped = queued.map(job => job.text);
      const t = activeFor(chatKey);
      if (!stillRunning(t)) {
        if (dropped.length) { writeQueue(chatKey, []); parked.delete(chatKey); }
        return { interrupted: false, dropped: dropped.length ? dropped : [] };
      }
      writeQueue(chatKey, []);
      parked.delete(chatKey);
      if (dropped.length) emit(t.meta, t.meta.turnId, null, { type: 'queue-dropped', texts: dropped });
      try { await signalStop(t); } catch { /* the pid escalation still runs; the wrapper writes the exit */ }
      return { interrupted: true, dropped };
    },

    /**
     * The chat's session id, its finished turns from Claude's session file,
     * and the turn still running replayed from its own log (every line with
     * its seq), so a browser that missed frames catches up exactly.
     */
    async history(chatKey) {
      await gate;
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      const { sessionId } = readState(chatKey);
      const runningTurn = activeFor(chatKey);
      const running = stillRunning(runningTurn) ? runningTurn : null;
      // A turn that died still has to be replayed after exit is written, or a
      // reload replaces the error with the transcript and the notice is gone.
      // A turn that finished normally is the transcript alone.
      const replay = running || lostTurn(chatKey, runningTurn);
      const queued = readQueue(chatKey).length;
      const file = sessionId ? findTranscript(home, sessionId) : null;
      let entries = file ? historyEntries(readTail(file, HISTORY_MAX_BYTES)) : [];
      let turn = null;
      if (replay) {
        if (Number.isInteger(replay.meta.transcriptBytes) && file) {
          entries = historyEntries(transcriptPrefix(file, replay.meta.transcriptBytes));
        } else {
          entries = entriesBeforeTurn(entries, replay.meta.text);
        }
        turn = eventsFromLog(replay.dir, replay.meta.turnId);
      }
      return { sessionId, running: Boolean(running), queued, parked: parked.has(chatKey), entries, turn };
    },
  };
}

module.exports = {
  CAPABILITIES,
  PERMISSION_MODE,
  READ_ONLY_TOOLS,
  CHECKOUT_PENDING,
  checkoutReady,
  completeLines,
  createChatRunner,
  entriesBeforeTurn,
  findTranscript,
  historyEntries,
  isChatKey,
  isSessionId,
  parseEvent,
  prepareChatConfigDir,
  readTail,
  rehomeTranscript,
  resolveClaude,
  slugForCwd,
  splitLines,
  turnArgs,
  turnEnv,
  turnSessionName,
};
