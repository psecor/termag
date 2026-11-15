#!/usr/bin/env node
'use strict';
// One simple-UI chat turn on the Devin CLI (chat-engines.js `devin`,
// chat-devin-v1): the process chat-turn.js runs for the turn. Devin has no
// print mode with a stream, so this is the turn's client of `devin acp`, the
// Agent Client Protocol (JSON-RPC 2.0, one message per line, over stdio):
// initialize, then session/load (the chat's session) or session/new, the
// tier's mode (session/set_mode), and one session/prompt with the message from
// stdin. It answers Devin's requests (permissions, terminals) by the tier, and
// writes one JSON line per thing to stdout, which devin-events.js makes the
// Claude stream-json the chat reads:
//   {"termag":"ready","sessionId":"devin-<tag>-<name>","devinSession","cwd","mode","loaded","model"?}
//   Devin's own session/update notifications, as it wrote them, from the ready line on (a load's replay of the
//     earlier conversation is dropped: the chat already has it)
//   {"termag":"permission","toolCallId","kind","title","allowed","toolCall"}  each permission request and the answer
//   {"termag":"refused","method","command"?}   a request a read-only turn refuses (a terminal)
//   {"termag":"left-mode","mode","want"}       Devin left the read tier's mode: the turn is stopped
//   {"termag":"result","stopReason","usage"?}  session/prompt's answer: the turn is over
// A failure is one line on stderr (the last, so the turn's runner-error names it) and exit 1.
//
// What Devin CLI 3000.12.57 does that this relies on (agent/fixtures/devin/3000.12.57/, recorded on macOS, signed
// out: a turn's own updates need a signed-in Devin and are built from the ACP spec and termag-desktop's Devin quirks):
// - initialize answers protocolVersion 1 with loadSession; session/new answers a session id (two words, "vanilla-
//   afternoon") and its modes: accept-edits (Code, the default, which runs edits unasked), smart, ask (read-only),
//   plan, bypass. A loaded session comes back in accept-edits: every turn sets its mode.
// - a message whose first block starts with a slash command switches mode (`/bypass` from ask: seen), so the
//   message never starts with one here (safeText);
// - hooks come from the session's cwd (its git root's `.claude/settings.json`, `.devin/hooks.v1.json`, …), from
//   every additionalDirectories entry, and from HOME (`~/.claude/settings.json`, ~/.config/devin/config.json):
//   a project's SessionStart and UserPromptSubmit hooks ran there, signed out, before any model call. So every
//   turn's cwd is the chat's own folder, emptied before it (with an empty .git, so a git repo above it isn't its
//   root), it adds no directory, and a confined turn's HOME is a scratch one holding only Devin's login
//   (chat-runner.js devinChatDirs);
// - DEVIN_SESSIONS_DIR moves the session store (sessions.db), and a session made under one HOME loads under
//   another; the login is $XDG_DATA_HOME/devin/credentials.toml (~/.local/share/devin/credentials.toml).
//
// Tiers (chat-runner.js devinTurnArgs):
//   read  (dontAsk: anything not an owner-trusted own tree): mode `ask`. A permission request is allowed only for
//         a look (ACP kinds read, search, think) and refused otherwise; the turn offers Devin terminals and refuses
//         every one, so no command runs; if Devin reports any mode but ask, the turn is cancelled and stopped.
//   full  (bypassPermissions: an owner-trusted own tree): mode `bypass`, as the box user (its HOME), and anything
//         Devin still asks is allowed. Its cwd is the chat's folder too, so none of the checkout's own config (hooks,
//         rules, MCP servers, for Devin and the seven tools it imports from) loads: the own-tree check vouches only
//         for Claude's and pi's (chat-runner.js STARTUP_CONFIG_PATHS). It works on the checkout by its path.

const { spawn } = require('child_process');
const { randomBytes } = require('crypto');
const fs = require('fs');

const TIER_MODES = Object.freeze({ read: 'ask', full: 'bypass' });
/** What a read-only turn lets Devin do when it asks (ACP tool kinds): look, never change, run or fetch. */
const READ_KINDS = new Set(['read', 'search', 'think']);
/**
 * termag's id for a Devin session: `devin-<tag>-<Devin's name>` ("devin-1f3a9c0e-vanilla-afternoon"). Devin names a
 * session with two words, so two chats (each with its own store) can get the same name, and the runner files a
 * session's transcript by its id alone: the tag, random when the session is made, keeps every id its own. The prefix
 * also makes a short name a session id the runner takes.
 */
const ID_PREFIX = 'devin-';
const ID_RE = /^devin-([0-9a-f]{8})-([A-Za-z0-9][A-Za-z0-9-]{0,62})$/;
const DEVIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const PROTOCOL_VERSION = 1;
/** How long the turn waits for Devin to go once the prompt is answered, or stopped, before it kills it. */
const EXIT_GRACE_MS = 3000;
/** Devin's stderr is its whole log (INFO and up); only its warnings and errors reach the turn's stderr.log. */
const STDERR_KEEP = /\b(WARN|ERROR)\b|panicked|fatal/;

function sessionIdOf(devinId, tag = randomBytes(4).toString('hex')) {
  return typeof devinId === 'string' && DEVIN_ID_RE.test(devinId) && /^[0-9a-f]{8}$/.test(tag) ? `${ID_PREFIX}${tag}-${devinId}` : null;
}

/** Devin's own name for a session termag's id names, or null. */
function devinIdOf(sessionId) {
  const m = typeof sessionId === 'string' ? ID_RE.exec(sessionId) : null;
  return m ? m[2] : null;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!/^--(devin|tier|cwd|sessions|home|session)$/.test(k) || typeof v !== 'string') throw new Error(`devin-acp: bad argument ${String(k).slice(0, 40)}`);
    out[k.slice(2)] = v;
  }
  if (!out.devin || !out.cwd || !out.sessions) throw new Error('devin-acp: needs --devin, --cwd and --sessions');
  if (!Object.prototype.hasOwnProperty.call(TIER_MODES, out.tier)) throw new Error('devin-acp: --tier is read or full');
  if (out.tier === 'read' && !out.home) throw new Error('devin-acp: a read-only turn needs its own --home');
  if (out.session != null && !devinIdOf(out.session)) throw new Error('devin-acp: --session is a devin- session id');
  return out;
}

/**
 * Devin's environment. A full-access turn is the box user's Devin, its sessions in the chat's store. A read-only
 * one has a HOME of its own and none of the box's XDG folders or Devin settings (a DEVIN_PERMISSION_MODE, a
 * DEVIN_SESSION_STORE), so it reads none of the box user's hooks, MCP servers or config.
 */
function devinEnv(env, { tier, home, sessions }) {
  const next = { ...env, DEVIN_SESSIONS_DIR: sessions };
  if (tier !== 'read') return next;
  for (const k of Object.keys(next)) {
    if (/^(DEVIN_|CHISEL_|WINDSURF_|CODEIUM_)/.test(k) || /^XDG_(CONFIG|DATA|CACHE|STATE)_HOME$/.test(k)) delete next[k];
  }
  next.HOME = home;
  next.DEVIN_SESSIONS_DIR = sessions;
  return next;
}

/** The message as Devin should take it: never a slash command (which would switch the mode), always text. */
function safeText(text) {
  return /^\s*\//.test(text) ? `The message below is the person's, as text (not a command):\n\n${text}` : text;
}

/** The option of a permission request that allows (once, else always) or refuses it; null when it offers none. */
function optionFor(options, allow) {
  const list = Array.isArray(options) ? options.filter(o => o && typeof o.optionId === 'string') : [];
  const kinds = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of kinds) {
    const o = list.find(x => x.kind === kind);
    if (o) return o.optionId;
  }
  return null;
}

/** Whether a tier lets Devin go ahead with a tool it asks about. */
function allows(tier, toolCall) {
  if (tier === 'full') return true;
  return Boolean(toolCall && READ_KINDS.has(toolCall.kind));
}

/** The modes a session/new or session/load answer offers, and the model it runs. */
function sessionFacts(result) {
  const modes = result && result.modes && Array.isArray(result.modes.availableModes) ? result.modes.availableModes.map(m => m && m.id).filter(Boolean) : [];
  const opts = result && Array.isArray(result.configOptions) ? result.configOptions : [];
  const model = opts.find(o => o && o.id === 'model');
  return { modes, model: model && typeof model.currentValue === 'string' && model.currentValue ? model.currentValue : null };
}

/** The mode a session/update reports, if it reports one. */
function modeOfUpdate(update) {
  if (!update || typeof update !== 'object') return null;
  if (update.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') return update.currentModeId;
  if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
    const mode = update.configOptions.find(o => o && o.id === 'mode');
    if (mode && typeof mode.currentValue === 'string') return mode.currentValue;
  }
  return null;
}

/**
 * The turn, against an `acp` already spawned ({ stdin, stdout, kill, onExit }). `write` takes stdout's lines,
 * `warn` stderr's. Resolves to the exit code.
 */
function runTurn({ args, text, acp, write, warn, setTimer = setTimeout }) {
  const tier = args.tier;
  const want = TIER_MODES[tier];
  let nextId = 0;
  const pending = new Map();
  let sessionId = null;
  let ready = false;
  let finished = false;
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });
  const line = obj => write(`${JSON.stringify(obj)}\n`);
  const send = obj => { try { acp.stdin.write(`${JSON.stringify(obj)}\n`); } catch { /* Devin is gone; its exit ends the turn */ } };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
  const finish = (code, message) => {
    if (finished) return;
    finished = true;
    for (const p of pending.values()) p.reject(new Error('Devin is gone'));
    pending.clear();
    // An answered turn closes Devin's stdin, which ends it; a failed or stopped one stops it at once.
    try { acp.stdin.end(); } catch { /* gone */ }
    if (code !== 0) acp.kill('SIGTERM');
    const unref = t => { if (t && t.unref) t.unref(); };
    unref(setTimer(() => {
      acp.kill('SIGTERM');
      unref(setTimer(() => acp.kill('SIGKILL'), EXIT_GRACE_MS));
    }, EXIT_GRACE_MS));
    // The message is the turn's last stderr line, so it is what the chat shows.
    acp.onExit(() => { if (message) warn(`${message}\n`); resolveDone(code); });
  };
  const answer = (id, result) => send({ jsonrpc: '2.0', id, result });
  const refuse = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  const onRequest = (m) => {
    const p = m.params && typeof m.params === 'object' ? m.params : {};
    if (m.method === 'session/request_permission') {
      const toolCall = p.toolCall && typeof p.toolCall === 'object' ? p.toolCall : {};
      const ok = ready && allows(tier, toolCall);
      const optionId = optionFor(p.options, ok);
      line({ termag: 'permission', toolCallId: typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : null, kind: toolCall.kind ?? null, title: toolCall.title ?? null, allowed: Boolean(ok && optionId), toolCall });
      answer(m.id, { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } });
      return;
    }
    if (m.method === 'terminal/create' && tier === 'read') {
      line({ termag: 'refused', method: m.method, ...(typeof p.command === 'string' && { command: p.command.slice(0, 500) }) });
      refuse(m.id, -32000, 'termag runs this turn read-only: it runs no commands');
      return;
    }
    line({ termag: 'refused', method: String(m.method).slice(0, 80) });
    refuse(m.id, -32601, `termag does not offer ${String(m.method).slice(0, 80)}`);
  };

  const onMessage = (raw, m) => {
    if (m.id != null && !m.method) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(typeof m.error.message === 'string' ? m.error.message : 'Devin refused'), { rpc: m.error }));
      else p.resolve(m.result);
      return;
    }
    if (m.id != null && typeof m.method === 'string') { onRequest(m); return; }
    if (m.method !== 'session/update' || !ready) return;
    const p = m.params || {};
    if (p.sessionId !== sessionId) return;
    const mode = modeOfUpdate(p.update);
    if (tier === 'read' && mode && mode !== want) {
      line({ termag: 'left-mode', mode, want });
      send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
      finish(1, `Devin left ${want} mode for ${mode}; termag stopped this read-only turn`);
      return;
    }
    write(`${raw}\n`);
  };

  let carry = '';
  acp.stdout.setEncoding('utf8');
  acp.stdout.on('data', (chunk) => {
    const parts = (carry + chunk).split('\n');
    carry = parts.pop();
    for (const raw of parts) {
      if (!raw.trim()) continue;
      let m;
      try { m = JSON.parse(raw); } catch { continue; }
      if (m && typeof m === 'object' && !finished) onMessage(raw, m);
    }
  });
  acp.onExit((code, signal) => {
    if (!finished) {
      finished = true;
      for (const p of pending.values()) p.reject(new Error('Devin is gone'));
      pending.clear();
      warn(`devin acp exited ${signal || code} before the turn was over\n`);
      resolveDone(1);
    }
  });

  (async () => {
    const init = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      // A read-only turn offers terminals only to refuse them: Devin then runs no command of its own.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: tier === 'read' },
    });
    if (!init || init.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Devin speaks ACP ${init && init.protocolVersion}, not ${PROTOCOL_VERSION}`);
    const canLoad = Boolean(init.agentCapabilities && init.agentCapabilities.loadSession);
    const base = { cwd: args.cwd, mcpServers: [] };
    let opened = null;
    let loaded = false;
    let lostSession = false;
    const resume = args.session ? devinIdOf(args.session) : null;
    if (resume && canLoad) {
      try {
        opened = await request('session/load', { ...base, sessionId: resume });
        sessionId = resume;
        loaded = true;
      } catch (e) {
        warn(`devin: session ${resume} did not load (${e.message}); starting a new one\n`);
        lostSession = true;
      }
    } else if (resume) {
      lostSession = true;
    }
    if (!loaded) {
      opened = await request('session/new', base);
      sessionId = opened && typeof opened.sessionId === 'string' ? opened.sessionId : null;
    }
    // A loaded session keeps the id it was given; a new one (the first turn, or a load that failed) gets its own tag.
    const sid = loaded ? args.session : sessionIdOf(sessionId);
    if (!sid) throw new Error(`Devin named its session ${String(sessionId).slice(0, 80)}, which termag can't keep`);
    const facts = sessionFacts(opened);
    if (!facts.modes.includes(want)) throw new Error(`Devin offers no ${want} mode here (it has ${facts.modes.join(', ') || 'none'})`);
    await request('session/set_mode', { sessionId, modeId: want });
    ready = true;
    line({ termag: 'ready', sessionId: sid, devinSession: sessionId, cwd: args.cwd, mode: want, loaded, ...(facts.model && { model: facts.model }) });
    const said = lostSession
      ? `termag couldn't load this chat's earlier Devin session, so this one starts without the conversation before this message.\n\n${text}`
      : text;
    const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: safeText(said) }] });
    const stopReason = result && typeof result.stopReason === 'string' ? result.stopReason : 'end_turn';
    line({ termag: 'result', stopReason, ...(result && result.usage && typeof result.usage === 'object' && { usage: result.usage }) });
    finish(0, null);
  })().catch((e) => {
    if (!finished) finish(1, `Devin: ${e.message}`);
  });

  return { done, cancel: () => {
    if (finished) return;
    if (sessionId) send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    finish(1, null);
  } };
}

function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
  const text = fs.readFileSync(0, 'utf8');
  const child = spawn(args.devin, ['acp'], {
    cwd: args.cwd,
    env: devinEnv(process.env, args),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let exited = null;
  const waiters = [];
  child.on('exit', (code, signal) => { exited = { code, signal }; for (const w of waiters.splice(0)) w(code, signal); });
  child.on('error', (e) => { process.stderr.write(`could not start devin: ${e.message}\n`); process.exit(127); });
  child.stdin.on('error', () => { /* EPIPE once Devin is gone; its exit ends the turn */ });
  child.stderr.setEncoding('utf8');
  let errCarry = '';
  child.stderr.on('data', (chunk) => {
    const parts = (errCarry + chunk).split('\n');
    errCarry = parts.pop();
    for (const l of parts) if (STDERR_KEEP.test(l)) process.stderr.write(`${l.slice(0, 2000)}\n`);
  });
  const acp = {
    stdin: child.stdin,
    stdout: child.stdout,
    kill: (sig) => { try { child.kill(sig); } catch { /* gone */ } },
    onExit: (fn) => { if (exited) fn(exited.code, exited.signal); else waiters.push(fn); },
  };
  const turn = runTurn({ args, text, acp, write: s => process.stdout.write(s), warn: s => process.stderr.write(s) });
  // A stop (chat-turn.js signals the turn's process group: Devin gets it too) cancels the prompt and ends the turn.
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => turn.cancel());
  turn.done.then(code => process.exit(code));
}

module.exports = { runTurn, parseArgs, devinEnv, safeText, optionFor, allows, sessionIdOf, devinIdOf, modeOfUpdate, TIER_MODES, READ_KINDS, ID_PREFIX };

if (require.main === module) main(process.argv.slice(2));
