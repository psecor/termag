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
//   <turn dir>/meta.json     { chatKey, bin, args, cwd, path, text, resumed, stateFile }
//   <turn dir>/prompt.txt    the message (stdin)
//   <turn dir>/events.jsonl  one event per line: the turn's whole log
//   <turn dir>/stderr.log    Claude's stderr
//   <turn dir>/claude.pid    for chat-interrupt
//   <turn dir>/exit          { code, signal } once the turn is over

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SESSION_ID_RE = /^[A-Za-z0-9-]{8,80}$/;

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

/** The environment of the Claude child: no tmux variables (the box's status hooks key on the pane), the agent's PATH, and the scratch config dir when the runner set one. */
function childEnv(env, pathValue, configDir) {
  const next = { ...env };
  delete next.TMUX;
  delete next.TMUX_PANE;
  if (pathValue) next.PATH = pathValue;
  if (configDir) next.CLAUDE_CONFIG_DIR = configDir;
  return next;
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
  appendLine(events, { type: 'turn-start', text: meta.text, resumed: Boolean(meta.resumed) });

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
  const input = fs.openSync(path.join(dir, 'prompt.txt'), 'r');
  let child;
  try {
    child = spawn(meta.bin, meta.args, { cwd: meta.cwd, env: childEnv(process.env, meta.path, meta.configDir), stdio: [input, out, err] });
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

module.exports = { childEnv, closingEvents, sawResult, sessionIdFrom };

if (require.main === module) main(process.argv[2]);
