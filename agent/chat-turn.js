#!/usr/bin/env node
'use strict';
// One simple-UI chat turn, run as the only process of its own tmux session
// (`<user>-chat-<turn>-r`, started by chat-runner.js) so it outlives a box
// agent restart. The agent prepares the turn directory and tails it; this
// wrapper runs `claude -p` with the prompt on stdin and its stream-json going
// straight to events.jsonl, framed by a turn-start line and, when Claude is
// done, a runner-error (if it failed without a result) and a turn-end. Then
// it records the session id for the next turn's --resume and writes `exit`,
// which tells the agent the turn is over even if it was down for all of it.
//
// A live turn (meta.live) keeps Claude's stdin open in stream-json mode: the
// agent drops messages the user sends meanwhile into inbox/, and they go in
// as they arrive, so the chat answers while a background task (a `termag ask`,
// a subagent) runs. claude -p stays up for those tasks anyway; stdin closes,
// and Claude exits, only once it has answered the last message and has no
// background task left. What the inbox still holds then, the agent sends as
// the next turn.
//
// A turn whose message carries images (agent/chat-images.js) reads stream-json
// too: prompt.jsonl holds the message as one input line, its images as
// content blocks, and is stdin (or a live turn's first line).
//
// A live turn that loads the box's MCP servers (meta.mcpVersionFile) picks up
// a connector linked or unlinked while it runs: when termag-credentials bumps that file, a reload_plugins
// control request goes in on stdin, which connects added servers and drops
// removed ones without a line in the transcript. Any other turn is its own
// `claude -p` process and reads ~/.claude.json when it starts.
//
//   <turn dir>/meta.json     { chatKey, bin, args, cwd, path, text, resumed, stateFile, live, images }
//   <turn dir>/prompt.txt    the message (stdin, or the first input line of a live turn)
//   <turn dir>/prompt.jsonl  the message as a stream-json line, when it carries images
//   <turn dir>/inbox/        a live turn's later messages, <n>.json { text, line? }; <n>.sent once delivered;
//                            interrupt-<n>.json asks Claude to stop the current turn (its
//                            stream-json interrupt: background commands keep running)
//   <turn dir>/events.jsonl  one event per line: the turn's whole log
//   <turn dir>/stderr.log    Claude's stderr
//   <turn dir>/claude.pid    for chat-interrupt
//   <turn dir>/exit          { code, signal } once the turn is over

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SESSION_ID_RE = /^[A-Za-z0-9-]{8,80}$/;
const INBOX_POLL_MS = 250;
const INBOX_RE = /^(\d+)\.json$/;
const INTERRUPT_RE = /^interrupt-(\d+)\.json$/;
// Claude Code re-reads ~/.claude.json about once a second, and a reload uses
// what it last read: the version must hold still this long before one.
const MCP_SETTLE_MS = 3000;
const MCP_RELOAD_ID = 'termag-mcp-reload-';

/** The session id Claude announced in its init event, or null. */
function sessionIdFrom(jsonl) {
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"init"')) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'system' && ev.subtype === 'init' && SESSION_ID_RE.test(ev.session_id || '')) return ev.session_id;
    } catch { /* not a whole line */ }
  }
  return null;
}

/** Whether the log holds Claude's result event. */
function sawResult(jsonl) {
  return jsonl.split('\n').some(line => line.includes('"result"') && (() => {
    try { return JSON.parse(line).type === 'result'; } catch { return false; }
  })());
}

/** The lines a turn ends with: why it failed, if it did without a result, then turn-end. A deliberate stop (the runner's `interrupted` marker) is not a failure. */
function closingEvents({ code, signal, result, stderrTail, interrupted }) {
  const out = [];
  if (!result && code !== 0 && !interrupted) {
    const last = (stderrTail || '').trim().split('\n').pop() || '';
    out.push({ type: 'runner-error', message: `Claude exited ${signal || code}${last ? `: ${last.slice(0, 300)}` : ''}` });
  }
  out.push({ type: 'turn-end', exitCode: code, signal: signal || null });
  return out;
}

/**
 * The environment of the Claude child: no tmux variables (the box's status
 * hooks key on the pane), the agent's PATH, the scratch config dir when the
 * runner set one, and the turn's own variables (an ask's git identity and
 * where it writes PR descriptions).
 */
function childEnv(env, pathValue, configDir, extra) {
  const next = { ...env };
  delete next.TMUX;
  delete next.TMUX_PANE;
  if (pathValue) next.PATH = pathValue;
  if (configDir) next.CLAUDE_CONFIG_DIR = configDir;
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) if (/^(GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)|TERMAG_ASK_PR_(BODY_FILE|DIR))$/.test(k) && typeof v === 'string') next[k] = v;
  }
  return next;
}

/** One message as a stream-json input line: its text, or a content array (images and text). */
function userLine(content) {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

/** The turn's first message as stdin takes it: prompt.jsonl when it carries images, else the prompt as a line. */
function firstLine(dir) {
  try { return fs.readFileSync(path.join(dir, 'prompt.jsonl'), 'utf8'); } catch { /* text only */ }
  return userLine(fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8'));
}

/**
 * What a live turn's log says about Claude, line by line: whether it has
 * answered the last message it was given (a `result` since the last
 * delivery), and how many background tasks it still has.
 */
function createLiveTracker() {
  let carry = '';
  let answered = false;
  let tasks = 0;
  return {
    feed(chunk) {
      const lines = (carry + chunk).split('\n');
      carry = lines.pop();
      for (const line of lines) {
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'result') answered = true;
        else if (ev.type === 'system' && ev.subtype === 'background_tasks_changed' && Array.isArray(ev.tasks)) tasks = ev.tasks.length;
      }
    },
    delivered() { answered = false; },
    idle() { return answered && tasks === 0; },
  };
}

/** The stream-json control request that stops Claude's current turn (what the Agent SDK's interrupt() sends). */
function interruptLine(n) {
  return `${JSON.stringify({ type: 'control_request', request_id: `termag-interrupt-${n}`, request: { subtype: 'interrupt' } })}\n`;
}

/** The stream-json control request that reconnects Claude's MCP servers to what ~/.claude.json now lists (the Agent SDK's reloadPlugins()). */
function mcpReloadLine(n) {
  return `${JSON.stringify({ type: 'control_request', request_id: `${MCP_RELOAD_ID}${n}`, request: { subtype: 'reload_plugins' } })}\n`;
}

/** Whether a log line is Claude's answer to an mcpReloadLine: the runner keeps it out of the chat. */
function isMcpReloadReply(ev) {
  return ev?.type === 'control_response' && String(ev.response?.request_id || '').startsWith(MCP_RELOAD_ID);
}

/**
 * When a live turn reloads its MCP servers: `check()` is true once the
 * version file (`read()`, '' when missing) differs from the one the turn
 * started with or last reloaded on, and has held still for `settleMs`. One
 * save can bump it several times; that is one reload.
 */
function createMcpReloader(read, now, settleMs = MCP_SETTLE_MS) {
  let seen = read();
  let last = seen;
  let since = now();
  return {
    check() {
      const version = read();
      if (version !== last) {
        last = version;
        since = now();
        return false;
      }
      if (version === seen || now() - since < settleMs) return false;
      seen = version;
      return true;
    },
  };
}

function readVersion(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

/** The inbox's waiting interrupt requests, oldest first. */
function pendingInterrupts(inbox) {
  let names = [];
  try { names = fs.readdirSync(inbox); } catch { return []; }
  return names.filter(n => INTERRUPT_RE.test(n)).sort((a, b) => Number(INTERRUPT_RE.exec(a)[1]) - Number(INTERRUPT_RE.exec(b)[1]));
}

/** The inbox's waiting messages, oldest first. */
function pendingInbox(inbox) {
  let names = [];
  try { names = fs.readdirSync(inbox); } catch { return []; }
  return names.filter(n => INBOX_RE.test(n)).sort((a, b) => Number(INBOX_RE.exec(a)[1]) - Number(INBOX_RE.exec(b)[1]));
}

/**
 * Feed a live turn: the first message, then the inbox as it fills. Each
 * message is claimed by renaming it to .sent before it is written, so the
 * agent can tell what went in. stdin is ended when Claude is idle; the
 * inbox is read in the same tick first, so only a message that lands in the
 * moment before stdin ends is left there, for the agent to send next turn.
 * With `mcpVersionFile`, a change to it reloads Claude's MCP servers.
 */
function runLive(dir, child, eventsFile, startOffset, { mcpVersionFile = null, now = Date.now } = {}) {
  const inbox = path.join(dir, 'inbox');
  const tracker = createLiveTracker();
  // Lines before Claude started are this wrapper's (turn-start), not Claude's.
  let offset = startOffset;
  let ended = false;
  child.stdin.on('error', () => { /* EPIPE once Claude is gone; its exit ends the turn */ });
  const write = (line) => {
    tracker.delivered();
    try { child.stdin.write(line); } catch { /* gone */ }
  };
  const deliverInbox = () => {
    for (const name of pendingInbox(inbox)) {
      const file = path.join(inbox, name);
      let job;
      try { job = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      try { fs.renameSync(file, file.replace(/\.json$/, '.sent')); } catch { continue; }
      // `line`: the runner built the message with its images (chat-images.js).
      if (typeof job?.line === 'string' && job.line) write(job.line.endsWith('\n') ? job.line : `${job.line}\n`);
      else if (typeof job?.text === 'string' && job.text) write(userLine(job.text));
    }
  };
  let interrupts = 0;
  const deliverInterrupts = () => {
    for (const name of pendingInterrupts(inbox)) {
      const file = path.join(inbox, name);
      try { fs.renameSync(file, file.replace(/\.json$/, '.sent')); } catch { continue; }
      interrupts += 1;
      try { child.stdin.write(interruptLine(interrupts)); } catch { /* gone */ }
    }
  };
  const readNew = () => {
    try {
      const size = fs.statSync(eventsFile).size;
      if (size <= offset) return;
      const fd = fs.openSync(eventsFile, 'r');
      try {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        offset = size;
        tracker.feed(buf.toString('utf8'));
      } finally { fs.closeSync(fd); }
    } catch { /* not written yet */ }
  };
  const mcp = mcpVersionFile ? createMcpReloader(() => readVersion(mcpVersionFile), now) : null;
  let reloads = 0;
  const tick = () => {
    if (ended) return;
    readNew();
    deliverInterrupts();
    // Not a message: no result answers it, so the tracker is not told.
    if (mcp?.check()) {
      reloads += 1;
      try { child.stdin.write(mcpReloadLine(reloads)); } catch { /* gone */ }
    }
    deliverInbox();
    if (!tracker.idle()) return;
    ended = true;
    clearInterval(timer);
    try { child.stdin.end(); } catch { /* gone */ }
  };
  write(firstLine(dir));
  const timer = setInterval(tick, INBOX_POLL_MS);
  child.once('exit', () => { ended = true; clearInterval(timer); });
}

/** The line a turn's log starts with: the message, and the images it carries (references, never their bytes). */
function turnStartEvent(meta) {
  const images = Array.isArray(meta.images) && meta.images.length ? meta.images : null;
  return { type: 'turn-start', text: meta.text, resumed: Boolean(meta.resumed), live: meta.live === true, ...(images && { images }) };
}

function appendLine(file, ev) {
  fs.appendFileSync(file, `${JSON.stringify(ev)}\n`);
}

function tail(file, bytes = 4000) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(bytes, st.size));
    fs.readSync(fd, buf, 0, buf.length, st.size - buf.length);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function main(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const events = path.join(dir, 'events.jsonl');
  const stderrFile = path.join(dir, 'stderr.log');
  appendLine(events, turnStartEvent(meta));

  let finished = false;
  const finish = (code, signal) => {
    if (finished) return;
    finished = true;
    let log = '';
    try { log = fs.readFileSync(events, 'utf8'); } catch { /* nothing written */ }
    // A wrapper that never gets here (reboot, OOM) leaves the init line in
    // the log; chat-runner closeTurn reads it and records the same id.
    const sessionId = sessionIdFrom(log);
    if (sessionId && meta.stateFile) {
      try { writeAtomic(meta.stateFile, JSON.stringify({ sessionId, cwd: meta.cwd, updatedAt: new Date().toISOString() })); } catch { /* next turn starts fresh */ }
    }
    const interrupted = fs.existsSync(path.join(dir, 'interrupted'));
    for (const ev of closingEvents({ code, signal, result: sawResult(log), stderrTail: tail(stderrFile), interrupted })) appendLine(events, ev);
    writeAtomic(path.join(dir, 'exit'), JSON.stringify({ code, signal: signal || null }));
    process.exit(0);
  };

  const out = fs.openSync(events, 'a');
  const err = fs.openSync(stderrFile, 'a');
  const live = meta.live === true;
  const input = live ? 'pipe' : fs.openSync(path.join(dir, fs.existsSync(path.join(dir, 'prompt.jsonl')) ? 'prompt.jsonl' : 'prompt.txt'), 'r');
  const startOffset = fs.statSync(events).size;
  let child;
  try {
    child = spawn(meta.bin, meta.args, { cwd: meta.cwd, env: childEnv(process.env, meta.path, meta.configDir, meta.env), stdio: [input, out, err] });
    if (live) runLive(dir, child, events, startOffset, { mcpVersionFile: meta.mcpVersionFile || null });
  } catch (e) {
    appendLine(events, { type: 'runner-error', message: `could not start Claude: ${e.message}` });
    finish(127, null);
    return;
  }
  if (child.pid) fs.writeFileSync(path.join(dir, 'claude.pid'), String(child.pid));
  child.on('error', e => {
    appendLine(events, { type: 'runner-error', message: `could not start Claude: ${e.message}` });
    finish(127, null);
  });
  child.on('exit', (code, signal) => finish(code, signal));
  // tmux kill-session delivers SIGHUP. Signaling the child and staying up
  // left the wrapper alive after the session was gone, so chat-clear could
  // not tell a stopped turn from a live one. Kill the child, escalate, exit.
  let stopping = false;
  const onHangup = () => {
    if (stopping) return;
    stopping = true;
    const kill = (sig) => { try { return child.kill(sig); } catch { return false; } };
    if (!kill('SIGTERM') || child.exitCode != null || child.signalCode != null) { finish(null, 'SIGTERM'); return; }
    const timer = setTimeout(() => { kill('SIGKILL'); finish(null, 'SIGKILL'); }, 3000);
    timer.unref?.();
    child.once('exit', () => clearTimeout(timer));
  };
  for (const sig of ['SIGHUP', 'SIGTERM']) process.on(sig, onHangup);
  process.on('SIGINT', () => { try { child.kill('SIGINT'); } catch { /* gone */ } });
}

module.exports = { childEnv, closingEvents, createLiveTracker, createMcpReloader, firstLine, interruptLine, isMcpReloadReply, mcpReloadLine, pendingInbox, pendingInterrupts, runLive, sawResult, sessionIdFrom, turnStartEvent, userLine };

if (require.main === module) main(process.argv[2]);
