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

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile: execFileCb } = require('child_process');
const { promisify } = require('util');
const { isMcpReloadReply, sessionIdFrom, turnStartEvent, userLine } = require('./chat-turn');
const chatImages = require('./chat-images');
const { historyTail, linesForward } = require('./transcript-lines');
const { sessionTitle } = require('./session-title');

const execFileAsync = promisify(execFileCb);

// chat-trust-v1: this runner accepts bypassPermissions. chat-auto-v1: it
// accepts auto (Claude Code's auto permission mode: a normal session whose
// classifier judges each tool call and denies rather than asks; what an
// automation run uses). chat-runner-v1 alone refuses
// any mode but dontAsk (mode-refused) and starts nothing.
// chat-live-v1: a turn started from a send with liveInput (the backend's
// chat-live-input-enabled) takes later messages in while it runs.
// chat-images-v1: a send may carry images (chat-images.js).
// chat-interrupt-v1: chat-interrupt takes scope 'turn', which stops only a
// live turn's current work (Claude's stream-json interrupt): its background
// commands keep running. Anything else, or no result in time, is SIGINT.
// chat-orchestrator-v1: a send may carry `orchestrator: true` (New session's
// "Act as an orchestrator"); its turns get ORCHESTRATOR_SYSTEM_PROMPT.
// chat-backend-v1: a send or resume claim may name a model backend (backendOf).
const CAPABILITIES = ['chat-runner-v1', 'chat-durable-v1', 'chat-trust-v1', 'chat-auto-v1', 'chat-live-v1', 'chat-interrupt-v1', 'chat-orchestrator-v1', 'chat-backend-v1', ...chatImages.CAPABILITIES];

/** A chat key the backend sends: letters, digits, `-`, `_`, `.`; no path. */
const CHAT_KEY_RE = /^[A-Za-z0-9_.-]{1,160}$/;
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,80}$/;
const MAX_TEXT = 100_000;
const HISTORY_MAX_ENTRIES = 600;
const HISTORY_MAX_BYTES = 8 * 1024 * 1024;
const INTERRUPT_GRACE_MS = 3000;
// How long a turn-only stop waits for Claude's result before it falls back to SIGINT.
const TURN_INTERRUPT_MS = 5000;
// Each queued message is a billed turn; cap the backlog so a stuck chat cannot
// pile up an unbounded (and expensive) queue.
const MAX_QUEUE = 20;
// One line per finished chat turn, beside the chat's state. The turn directory
// is pruned; these are what a reload's running total is read from.
const TURN_RECORDS_MAX = 2000;
const RECORD_PROMPT_CHARS = 200;
/** Claude's transcript user uuid, or a short test id of the same shape. */
const USER_UUID_RE = /^[A-Za-z0-9-]{1,80}$/;

function isChatKey(k) { return typeof k === 'string' && CHAT_KEY_RE.test(k) && !k.includes('..'); }
function isSessionId(s) { return typeof s === 'string' && SESSION_ID_RE.test(s); }

/**
 * The orchestrator decides each turn's mode from the project's trust
 * (backend services/chatTrust.ts): bypassPermissions for a trusted
 * repository, auto for a scheduled automation run on a trusted one
 * (backend services/automations/runner.ts), dontAsk for any other.
 * Anything else, or nothing (an orchestrator from before trust), is
 * dontAsk: a turn never runs tools unasked by default. bypass and auto are
 * both "open" modes in that every built-in tool exists and the checkout
 * must be the repository's own tree; they differ in what else loads. A
 * bypass turn is a normal Claude Code session: the checkout's settings,
 * hooks and MCP servers, with a person watching. An auto turn runs
 * unattended from whatever origin's default branch holds, so it gets the
 * same confinement as an untrusted turn apart from the tool list: no MCP
 * server, no hooks, no checkout settings, and the scratch config dir
 * (prepareChatConfigDir) in place of the owner's. Print mode runs a
 * checkout's .mcp.json commands, hooks and apiKeyHelper at start, before
 * the auto classifier sees a single tool call; whoever can push to that
 * branch would otherwise get a shell as the box user on the next run.
 */
const UNTRUSTED_MODE = 'dontAsk';
const TRUSTED_MODE = 'bypassPermissions';
const AUTO_MODE = 'auto';
const PERMISSION_MODES = [TRUSTED_MODE, AUTO_MODE, UNTRUSTED_MODE];
function permissionModeFor(requested) {
  return PERMISSION_MODES.includes(requested) ? requested : UNTRUSTED_MODE;
}
/** A mode with the normal tool surface, gated on the checkout being the repository's own tree. */
function isOpenMode(mode) {
  return mode === TRUSTED_MODE || mode === AUTO_MODE;
}
/** A mode that loads the checkout's settings, hooks and MCP servers: only a trusted, attended turn. */
function loadsCheckoutConfig(mode) {
  return mode === TRUSTED_MODE;
}

/**
 * How long a typed `claude --resume` keeps the runner off the session before
 * a shell probe may decide Claude never came up. Shorter than this, a shell
 * is the pane the command was typed into, not proof it exited. A failed or
 * empty probe never counts, at any age.
 */
const PANE_START_GRACE_MS = 60_000;

/**
 * The pane claim after one foreground probe.
 *   owns — resume was typed, Claude has not been seen
 *   seen — Claude was the foreground; it holds the session until a shell
 *   null — the runner may start a turn
 * `elapsedMs` is how long `owns` has stood. A shell clears `seen` at once
 * (Claude was there and is gone) and clears `owns` only after the grace.
 * `other` is a named program that is not Claude: past the grace it clears
 * `owns` the same way a shell does, because the launcher returned. It does
 * not clear `seen` — Claude was the foreground, and vim is not proof it
 * exited. `unknown` is a failed probe and never clears a claim.
 */
function nextPaneClaim(pane, probe, elapsedMs = 0) {
  const held = pane === 'owns' || pane === 'seen' ? pane : null;
  if (probe === 'claude') return 'seen';
  if (probe === 'shell' && held === 'seen') return null;
  if ((probe === 'shell' || probe === 'other') && held === 'owns' && elapsedMs >= PANE_START_GRACE_MS) return null;
  return held;
}

/**
 * The mode a turn runs in, from the orchestrator's request and what the
 * checkout is. An open mode needs the repository's own tree; anything else
 * drops to dontAsk. A tree that git-worktree-add made from origin's tip with
 * nobody watching (`branch.<b>.termagUnattended`, an automation run's
 * worktree) never loads its startup config: a trusted follow-up there runs
 * as auto (every tool, the classifier, no checkout settings), since whoever
 * can push the default branch wrote that tree's .mcp.json and hooks.
 */
function turnModeFor(requested, facts) {
  const mode = permissionModeFor(requested);
  if (!isOpenMode(mode)) return mode;
  if (!checkoutOwnTree(facts)) return UNTRUSTED_MODE;
  if (facts && facts.unattended && mode === TRUSTED_MODE) return AUTO_MODE;
  return mode;
}

/**
 * dontAsk alone still runs what the checkout or the box user's settings
 * already allow, so an untrusted turn is also closed down to reading:
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
 * The file `termag-credentials apply|remove mcp` rewrites after it changes
 * ~/.claude.json's mcpServers. A
 * live turn that loads them watches it and reloads (chat-turn.js); a confined
 * turn has none to reload.
 */
function mcpVersionFile(home, mode, live) {
  return live && loadsCheckoutConfig(mode) ? path.join(home, '.config/termag/mcp-connectors.version') : null;
}

/**
 * Claude Code keeps a session's transcript under
 * ~/.claude/projects/<cwd, every non-alphanumeric turned to '-'>/<id>.jsonl.
 * A rename moves the checkout, so the cwd (and this slug) change; the turn
 * re-homes the transcript to the new slug before --resume (rehomeTranscript).
 */
function slugForCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The permission surface of one Claude invocation, shared by a headless turn
 * and an interactive resume. Only bypassPermissions loads the checkout.
 * dontAsk also closes the tool list to the read-only built-ins. auto keeps
 * the normal tool list and still passes the closure above.
 */
function permissionArgs(permissionMode, settings = null) {
  const mode = permissionModeFor(permissionMode);
  const args = ['--permission-mode', mode];
  if (!isOpenMode(mode)) args.push('--tools', READ_ONLY_TOOLS.join(','));
  if (!loadsCheckoutConfig(mode)) {
    args.push(
      '--strict-mcp-config',
      '--mcp-config', EMPTY_MCP_CONFIG,
      '--setting-sources', SETTING_SOURCES,
      // A backend's settings and the hooks closure in one: Claude Code reads only the last --settings.
      '--settings', settings ? JSON.stringify({ ...settings, disableAllHooks: true }) : TURN_SETTINGS,
    );
  } else if (settings) {
    args.push('--settings', JSON.stringify(settings));
  }
  return args;
}

/**
 * A `--model` value the orchestrator may send: a Claude tier alias, or a US
 * Anthropic profile id (services/claudeChatModel.ts). Anything else is dropped
 * so it never reaches the CLI. Auto omits the flag.
 */
const LAUNCH_MODEL = /^(opus|sonnet|haiku|us\.anthropic\.claude-[A-Za-z0-9._:-]{1,80})$/;

function claudeModelArg(model) {
  return typeof model === 'string' && LAUNCH_MODEL.test(model) ? model : null;
}

/**
 * A model backend other than the default: a send or
 * resume claim names it with its model, and the orchestrator's fast model and
 * context window for it. The turn starts with the settings
 * `termag-credentials launch-settings` prints for it, which fails where the
 * box is not set up for that backend rather than running on the default.
 */
const BACKENDS = ['fireworks'];
const BACKEND_MODEL = /^accounts\/[a-z0-9-]+\/(?:models|routers)\/[A-Za-z0-9._-]{1,120}$/;

/** The backend a send or claim names, checked; null for none; throws for one this runner cannot start. */
function backendOf({ backend, model, fastModel, context }) {
  if (backend == null || backend === '') return null;
  if (!BACKENDS.includes(backend) || typeof model !== 'string' || !BACKEND_MODEL.test(model)) {
    throw new Error('bad backend: not a model backend and model this runner can start');
  }
  return {
    backend, model,
    ...(typeof fastModel === 'string' && BACKEND_MODEL.test(fastModel) ? { fastModel } : {}),
    ...(Number.isInteger(context) && context > 0 ? { context } : {}),
  };
}

const CREDENTIALS_SCRIPT = path.join(__dirname, '..', 'deploy', 'termag-credentials');

/** The Claude Code settings for a backend, from the box's credentials script; its reason when it refuses. */
async function backendSettings(b, { env = process.env, execFile = execFileAsync, script = CREDENTIALS_SCRIPT } = {}) {
  const args = ['launch-settings', '--backend', b.backend, '--model', b.model,
    ...(b.fastModel ? ['--fast', b.fastModel] : []), ...(b.context ? ['--context', String(b.context)] : []), '-'];
  let stdout;
  try {
    ({ stdout } = await execFile(script, args, { env, timeout: 15_000 }));
  } catch (err) {
    const why = String(err.stderr || '').trim().split('\n').pop().replace(/^termag-credentials: /, '');
    throw new Error(`${b.backend} is not ready on this box: ${why || err.message}`);
  }
  const settings = JSON.parse(stdout);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${b.backend} settings are not an object`);
  return gatewaySettings(settings);
}

/**
 * Only what prepareChatConfigDir carries from the owner's settings: the
 * credential helper and string env. The file launch-settings reads is the
 * box user's to write, and anything else in it (permission allow rules, a
 * status line command, hooks) would undo a confined turn's closure, since
 * --settings outranks the scratch settings.
 */
function gatewaySettings(settings) {
  const out = {};
  if (typeof settings.apiKeyHelper === 'string') out.apiKeyHelper = settings.apiKeyHelper;
  if (settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)) {
    out.env = Object.fromEntries(Object.entries(settings.env).filter(([, v]) => typeof v === 'string'));
  }
  return out;
}

/**
 * The argv for one turn. The message goes on stdin, never in argv. The
 * permission flags are permissionArgs, the same list an interactive resume
 * uses. A live turn (chat-turn.js) reads stream-json messages for as long as
 * it runs, and replays each one on stdout when Claude takes it in, which is
 * where the chat shows it. A turn whose message carries images reads
 * stream-json too (one line, its images as content blocks), with nothing to
 * replay. A chosen model is `--model` ahead of `--resume`, so the session
 * stays last; Auto passes no model. On a backend (backendOf) the model is
 * that backend's and `settings` its launch settings.
 */
function turnArgs(sessionId, permissionMode, { live = false, images = false, model = null, backend = null, settings = null, ask = null, orchestrator = false } = {}) {
  const args = [
    '-p',
    ...(live ? ['--input-format', 'stream-json', '--replay-user-messages']
      : images ? ['--input-format', 'stream-json'] : ['--input-format', 'text']),
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    ...permissionArgs(permissionMode, settings),
  ];
  const chosen = backend ? backend.model : claudeModelArg(model);
  if (chosen) args.push('--model', chosen);
  if (ask) {
    // An ask's turn (agent/ask-chat.js) runs with nobody watching: a wakeup or
    // cron left pending would keep claude -p up, and the reply with it.
    args.push('--disallowedTools', ASK_DISALLOWED_TOOLS);
    if (ask.systemPrompt) args.push('--append-system-prompt', ask.systemPrompt);
  } else if (orchestrator) {
    args.push('--append-system-prompt', ORCHESTRATOR_SYSTEM_PROMPT);
  }
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

const ASK_DISALLOWED_TOOLS = 'ScheduleWakeup CronCreate';

/**
 * Appended to the system prompt of every turn of a chat started with "Act as
 * an orchestrator". It stays out of the conversation, and the opt-in
 * agent-orchestrator skill (deploy/claude-skills) waits for exactly this
 * explicit request.
 */
const ORCHESTRATOR_SYSTEM_PROMPT = 'The user started this session with "Act as an orchestrator". If you have not already done so in this conversation, invoke the agent-orchestrator skill before anything else, and follow it until the user tells you to stop orchestrating.';
const ASK_ID_RE = /^[a-z0-9]{8,40}$/;

/**
 * The ask a turn belongs to (agent/ask-chat.js): the thread, the run when
 * the turn answers an ask (none for a person's message in that chat), the
 * orchestrator's system prompt and the asker's git identity. null when the
 * job carries none; a thrown Error when it carries a bad one.
 */
function askOfJob(ask) {
  if (ask == null) return null;
  if (typeof ask !== 'object') throw new Error('ask must be an object');
  if (!ASK_ID_RE.test(String(ask.threadId || ''))) throw new Error('ask.threadId is not a thread id');
  if (ask.runId != null && !ASK_ID_RE.test(String(ask.runId))) throw new Error('ask.runId is not a message id');
  const str = v => (typeof v === 'string' ? v : '');
  return {
    threadId: ask.threadId,
    ...(ask.runId ? { runId: ask.runId } : {}),
    systemPrompt: str(ask.systemPrompt),
    gitName: str(ask.gitName).replace(/[\r\n<>]/g, ' ').trim(),
    gitEmail: str(ask.gitEmail).replace(/[\r\n<>\s]/g, ''),
    ...(askPath(ask.prBodyFile) ? { prBodyFile: ask.prBodyFile } : {}),
    ...(askPath(ask.prDir) ? { prDir: ask.prDir } : {}),
  };
}

const askPath = p => typeof p === 'string' && path.isAbsolute(p) && p.length <= 4096 && !/[\0\r\n]/.test(p);

/**
 * What an ask's turn adds to Claude's environment: commits in the clone are
 * the asker's, and the PR descriptions go where termag-subagent-run --report
 * reads them (TERMAG_ASK_PR_BODY_FILE, TERMAG_ASK_PR_DIR/<name>.md).
 */
function askEnv(ask) {
  if (!ask) return {};
  const env = {};
  if (ask.gitEmail) {
    const name = ask.gitName || ask.gitEmail;
    Object.assign(env, { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: ask.gitEmail, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: ask.gitEmail });
  }
  if (ask.prBodyFile) env.TERMAG_ASK_PR_BODY_FILE = ask.prBodyFile;
  if (ask.prDir) env.TERMAG_ASK_PR_DIR = ask.prDir;
  return env;
}

/** Single-quote a shell word. Resume never puts these words on a typed line. */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * What Open in full UI types for a confined resume: a fixed path under
 * $HOME whose name is the chat key. The flags and CLAUDE_CONFIG_DIR live in
 * the script that path names, written by writeResumeLauncher, so a pane shell
 * never parses the JSON settings or anything the user can influence.
 * Not `exec` of that path: the script already `exec`s Claude, and an outer
 * `exec` would replace the pane's shell, so `/exit` kills the pane.
 */
function confinedResumeLine(chatKey) {
  if (!isChatKey(chatKey)) return null;
  return `"$HOME/.termag/chat-resume/${chatKey}"`;
}

/** A directory a trusted resume may cd to: absolute, one line, the path just inspected. */
function isResumeCwd(cwd) {
  return typeof cwd === 'string' && path.isAbsolute(cwd) && cwd.length > 1 && cwd.length <= 4096
    && !cwd.includes('\0') && !cwd.includes('\n') && !cwd.includes('\r');
}

/** A claude binary a trusted resume may exec. Absolute, so the pane's PATH is not searched after cd. */
function isAbsoluteCommand(bin) {
  return typeof bin === 'string' && path.isAbsolute(bin) && !bin.includes('\0') && !bin.includes('\n') && !bin.includes('\r');
}

/**
 * Write the launcher and return the line to type.
 * `argv` is permissionArgs plus `--resume <id>`: the same flags a turn uses,
 * without the headless `-p` surface.
 * A confined resume (`configDir` set) exports the scratch config dir and
 * execs that argv. A trusted resume requires an absolute binary and a cwd,
 * and does not set the scratch dir. Either one cds when `cwd` is a directory
 * this runner may name: Claude looks the session up under that directory's
 * slug, and the confinement is the flags, not which directory the process
 * starts in. A confined resume with no such directory (the checkout could
 * not be shown) launches without a cd. The typed line is only the script
 * path. The script execs Claude, so the pane's shell stays the parent and
 * `/exit` returns to it.
 */
function writeResumeLauncher({ home, chatKey, bin, argv, configDir, cwd, fsImpl = fs }) {
  const line = confinedResumeLine(chatKey);
  if (!line || typeof bin !== 'string' || !bin) return null;
  const confined = typeof configDir === 'string' && configDir.length > 0;
  const cdTo = isResumeCwd(cwd) ? cwd : null;
  if (confined) {
    // An unusable cwd is left out. The flags still confine the turn.
  } else if (!cdTo || !isAbsoluteCommand(bin) || configDir) {
    return null;
  }
  const dir = path.join(home, '.termag/chat-resume');
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, chatKey);
  const body = ['#!/bin/sh'];
  if (confined) body.push(`export CLAUDE_CONFIG_DIR=${shQuote(configDir)}`);
  if (cdTo) body.push(`cd ${shQuote(cdTo)} || exit 1`);
  body.push(`exec ${[bin, ...argv].map(shQuote).join(' ')}`);
  body.push('');
  fsImpl.writeFileSync(file, body.join('\n'), { mode: 0o700 });
  if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(file, 0o700);
  return line;
}

/**
 * The interactive resume for a mode turnModeFor already decided.
 * bypassPermissions (an owner-ticked own attended tree) is a launcher that
 * cds to `cwd` — the directory that mode was decided on — and execs `bin`
 * with `--permission-mode bypassPermissions --resume <id>`. Nothing is typed
 * as a bare `claude`: the pane shell's cwd is not that directory.
 * Every other mode is the confined launcher: dontAsk or auto, the read-only
 * tool closure when the mode is dontAsk, empty strict MCP, disabled hooks,
 * user-only setting sources, and the scratch config dir. It cds to the same
 * directory when that directory is one this runner may name, so `--resume`
 * looks the session up there. Without one, it launches in the pane's cwd
 * and the caller does not move the transcript.
 * Returns null when the session id is not one this runner would resume, or
 * when a trusted resume has no absolute cwd or binary.
 */
function resumeLaunch({ home, chatKey, sessionId, mode, bin = 'claude', cwd, backend = null, settings = null, fsImpl = fs }) {
  if (!isSessionId(sessionId)) return null;
  // On a backend, the pane continues there, on the chat's model.
  const argv = [...permissionArgs(mode, settings), ...(backend ? ['--model', backend.model] : []), '--resume', sessionId];
  const resumeCwd = isResumeCwd(cwd) ? cwd : undefined;
  if (loadsCheckoutConfig(permissionModeFor(mode))) {
    const line = writeResumeLauncher({ home, chatKey, bin, argv, cwd: resumeCwd, fsImpl });
    if (!line) return null;
    return { confined: false, configDir: null, cwd: resumeCwd, argv, line };
  }
  const configDir = prepareChatConfigDir(home, fsImpl);
  const line = writeResumeLauncher({ home, chatKey, bin, argv, configDir, cwd: resumeCwd, fsImpl });
  if (!line) return null;
  return { confined: true, configDir, cwd: resumeCwd || null, argv, line };
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
 * Claude Code's meta entries, except those a tool call added (a skill's
 * SKILL.md after its Skill call), which keep `isMeta` and the call's id so
 * the browser folds them into that call. Each entry keeps the stream-json
 * shape ({type, message, uuid}), so history and live events share one reducer.
 */
function messagePrompt(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text);
  return texts.length ? texts.join('\n') : null;
}

/**
 * What identifies a user message as a prompt: its text and its own images'
 * ids (a stored reference's, or the sha256 of inline bytes, as the image
 * store names them). A message may be images alone, so its text may be ''.
 * Null for a line that is only tool results: it is no prompt, and an
 * image-only prompt's '' must not match it.
 */
function messageIdentity(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return null;
  const text = messagePrompt(content);
  const images = content.filter(p => p && p.type === 'image' && p.source).map(p => imageId(p.source));
  if (text == null && !images.length) return null;
  return { text: text ?? '', images };
}

function imageId(source) {
  if (source.type === 'termag' && typeof source.id === 'string') return source.id;
  if (source.type === 'base64' && typeof source.data === 'string') {
    return crypto.createHash('sha256').update(Buffer.from(source.data, 'base64')).digest('hex');
  }
  return '';
}

/**
 * The uuid of the first user prompt in a transcript slice. A user line that
 * is only tool results is not a prompt, and a terminal turn is a different
 * uuid from the runner turn that happens to say the same words.
 */
function userPromptUuid(lines) {
  for (const raw of typeof lines === 'string' || lines == null ? String(lines || '').split('\n') : lines) {
    const line = String(raw);
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || e.type !== 'user' || e.isMeta || e.isSidechain || !e.message) continue;
    if (messageIdentity(e.message.content) == null) continue;
    if (typeof e.uuid === 'string' && USER_UUID_RE.test(e.uuid)) return e.uuid;
  }
  return null;
}

function historyEntries(jsonl, max = HISTORY_MAX_ENTRIES) {
  const out = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || (e.type !== 'user' && e.type !== 'assistant')) continue;
    if (e.isSidechain || !e.message) continue;
    const toolMeta = e.isMeta && e.type === 'user' && typeof e.sourceToolUseID === 'string';
    if (e.isMeta && !toolMeta) continue;
    out.push({
      type: e.type,
      uuid: typeof e.uuid === 'string' ? e.uuid : undefined,
      timestamp: typeof e.timestamp === 'string' ? e.timestamp : undefined,
      ...(toolMeta && { isMeta: true, sourceToolUseID: e.sourceToolUseID }),
      message: {
        id: typeof e.message.id === 'string' ? e.message.id : undefined,
        role: e.message.role,
        // `<synthetic>` marks a message Claude Code wrote itself (a refused command), not the model.
        ...(typeof e.message.model === 'string' && { model: e.message.model }),
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

/**
 * `owner/name` for a GitHub https or ssh remote, lowercased; null otherwise.
 * An optional userinfo (`https://user:secret@github.com/...`) is ignored:
 * `url.insteadOf` rewrites a remote that way, and the rewrite must not hide
 * which repository the URL names.
 */
function githubSlug(url) {
  if (typeof url !== 'string') return null;
  const m = /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/**
 * A pull-request head: GitHub's refs/pull/<n>/head, the runner's fetch of it
 * (refs/remotes/<remote>/pr/<n> or the abbrev <remote>/pr/<n>), or the same
 * fetch spelled pull/<n>/head.
 */
function isPullRef(name) {
  return /^refs\/pull\/\d+\/head$/.test(name)
    || /^refs\/remotes\/[^/]+\/pr\/\d+$/.test(name)
    || /^refs\/remotes\/[^/]+\/pull\/\d+\/head$/.test(name)
    || /^[^/]+\/pr\/\d+$/.test(name)
    || /^[^/]+\/pull\/\d+\/head$/.test(name);
}

/** True when both URLs name one repository. A GitHub slug wins over the raw string. */
function sameRepository(originUrl, upstreamUrl) {
  if (typeof originUrl !== 'string' || typeof upstreamUrl !== 'string') return false;
  const origin = githubSlug(originUrl);
  const upstream = githubSlug(upstreamUrl);
  if (origin || upstream) return origin != null && origin === upstream;
  const norm = (u) => u.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  return norm(originUrl) !== '' && norm(originUrl) === norm(upstreamUrl);
}

/** The branch's upstream is a pull-request ref, by its tracking name or its configured merge ref. */
function upstreamIsPull(facts) {
  return isPullRef(facts.upstreamRef || '') || isPullRef(facts.upstreamMerge || '');
}

/**
 * Whether this checkout is the repository's own tree. A pull-request or fork
 * workstream is not, including after a later commit: bypassPermissions would
 * run its apiKeyHelper, hooks and .mcp.json as the box user.
 *
 * The project's own tree is an attached branch whose upstream is this
 * repository and a `refs/heads/*` ref. The main worktree is not that by
 * itself: `git fetch origin pull/<n>/head:<local>` then checkout leaves no
 * marker and no upstream, and that chat stays read-only. A branch-off also
 * needs `termagCheckout` `own`. A `pr` or `fork` marker stays refused.
 * Another ref that merely points at the same commit does not count, and is
 * not consulted: a pull ref sharing main's commit must not lock the main
 * chat. Not a git checkout, and a git checkout with no origin: nothing was
 * checked out from a pull request, so the owner's tick stands. A
 * pull-request or fork marker, and a pull upstream, still refuse. A git
 * checkout whose branch cannot be read is not its own tree.
 */
function sameRepoHeadsUpstream(facts) {
  const merge = facts.upstreamMerge;
  if (typeof merge !== 'string' || !/^refs\/heads\/.+/.test(merge)) return false;
  if (isPullRef(merge)) return false;
  return sameRepository(facts.originUrl, facts.upstreamUrl);
}

function checkoutOwnTree(facts) {
  if (!facts || facts.repo === false) return true;
  if (facts.unreadable) return false;
  if (!facts.branch) return false;
  if (facts.checkout === 'pr' || facts.checkout === 'fork') return false;
  if (facts.fork) return false;
  if (upstreamIsPull(facts)) return false;
  // No origin: a project with no repository. It is a git init, often with a
  // commit, so the missing-directory case above does not cover it. The
  // owner's tick is enough. A pull-request or fork workstream, and a pull
  // upstream, were already refused.
  if (!facts.originUrl) return true;
  const origin = githubSlug(facts.originUrl);
  const upstream = githubSlug(facts.upstreamUrl);
  if (origin && upstream && upstream !== origin) return false;
  if (!sameRepoHeadsUpstream(facts)) return false;
  if (facts.mainWorktree === true) return true;
  return facts.checkout === 'own';
}

async function gitOut(execFile, cwd, args) {
  const { stdout } = await execFile('git', ['-C', cwd, ...args], { timeout: 5000 });
  return String(stdout || '');
}

/**
 * This worktree's branch, as startTurn decides the checkout. `execFile` is
 * promisified, as checkoutReady's is. The main worktree is `--git-dir` and
 * `--git-common-dir` being the same directory. A branch-off is the `own`
 * marker plus this branch's upstream (`@{upstream}`, or the configured
 * remote and merge when that ref is not fetched yet). Only this branch's
 * marker and its own upstream count: `for-each-ref --points-at HEAD` is
 * repo-global, so a fetched `origin/pr/N` that shares main's commit would
 * lock the main chat down too.
 */
async function readCheckoutFacts(cwd, execFile = execFileAsync) {
  let inside = false;
  try {
    inside = (await gitOut(execFile, cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch { return { repo: false }; }
  if (!inside) return { repo: false };
  try {
    const gitDir = (await gitOut(execFile, cwd, ['rev-parse', '--path-format=absolute', '--git-dir'])).trim().replace(/\/+$/, '');
    const commonDir = (await gitOut(execFile, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim().replace(/\/+$/, '');
    const mainWorktree = gitDir !== '' && gitDir === commonDir;
    const head = (await gitOut(execFile, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const branch = head && head !== 'HEAD' ? head : null;
    let checkout = null;
    let unattended = false;
    if (branch) {
      try {
        const marked = (await gitOut(execFile, cwd, ['config', '--local', '--get', `branch.${branch}.termagCheckout`])).trim();
        if (marked === 'pr' || marked === 'fork' || marked === 'own') checkout = marked;
      } catch { /* this branch was not checked out from a pull request */ }
      try {
        unattended = (await gitOut(execFile, cwd, ['config', '--local', '--get', `branch.${branch}.termagUnattended`])).trim() === 'true';
      } catch { /* made by a person, or before the marker */ }
    }
    let originUrl = null;
    try { originUrl = (await gitOut(execFile, cwd, ['remote', 'get-url', 'origin'])).trim() || null; } catch { /* no origin */ }
    let upstreamUrl = null;
    let upstreamRef = null;
    let upstreamMerge = null;
    try {
      const up = (await gitOut(execFile, cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim();
      const remote = up.split('/')[0];
      if (remote && up !== '@{upstream}') {
        upstreamRef = up;
        upstreamUrl = (await gitOut(execFile, cwd, ['remote', 'get-url', remote])).trim() || null;
      }
    } catch { /* the tracking ref is not fetched yet, or there is no upstream */ }
    if (branch) {
      try {
        const remote = (await gitOut(execFile, cwd, ['config', '--local', '--get', `branch.${branch}.remote`])).trim();
        const merge = (await gitOut(execFile, cwd, ['config', '--local', '--get', `branch.${branch}.merge`])).trim();
        if (remote && merge && !remote.startsWith('-') && !merge.startsWith('-')) {
          if (!upstreamMerge) upstreamMerge = merge;
          if (!upstreamRef) {
            upstreamRef = merge.startsWith('refs/heads/') ? `${remote}/${merge.slice('refs/heads/'.length)}` : merge;
            try { upstreamUrl = (await gitOut(execFile, cwd, ['remote', 'get-url', remote])).trim() || null; } catch { /* that remote has no url */ }
          }
        }
      } catch { /* this branch has no configured upstream */ }
    }
    // Only this branch's own upstream. A colleague fork, a backup, or any
    // other remote that happens to have a same-named ref is not this checkout.
    let fork = checkout === 'fork';
    const origin = githubSlug(originUrl);
    const upstream = githubSlug(upstreamUrl);
    if (origin && upstream && upstream !== origin) fork = true;
    return { repo: true, branch, checkout, originUrl, upstreamUrl, upstreamRef, upstreamMerge, fork, mainWorktree, unattended };
  } catch {
    return { repo: true, unreadable: true };
  }
}

/** Refused by chat-send while the checkout is not there yet; the backend answers 409 checkout-pending. */
const CHECKOUT_PENDING = 'checkout-pending: the repository is still being checked out';

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
 * The prompt is its text and its images (messageIdentity): an image-only
 * prompt's '' text alone would also match a line of tool results.
 */
function entriesBeforeTurn(entries, text, imageIds = []) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'user' || e.isMeta) continue;
    const id = messageIdentity(e.message?.content);
    if (id && id.text === text && id.images.length === imageIds.length && id.images.every((x, k) => x === imageIds[k])) {
      return entries.slice(0, i);
    }
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
 * The backend's mode is a ceiling (services/chatTrust.ts). bypassPermissions
 * is applied only when this checkout is shown to be the project's own tree:
 * the main worktree, or a branch-off marked `own` whose upstream is this
 * repository and not a pull ref. Recomputed when the turn starts, so a mode
 * persisted on a queued job is not reused after an agent restart. A missing
 * marker, a detached HEAD, or a branch checked out from a pull request or a
 * fork stays read-only in the scratch config dir, including after a later
 * commit. chat-clear drops the queue and stops a running turn the same way
 * for either mode. The transcript still follows a renamed checkout.
 */
function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code !== 'ESRCH'; }
}

/**
 * One turn's record: what it cost and how long it took, from Claude's result
 * event (total_cost_usd, duration_ms) and the runner's own clock when Claude
 * printed no result. Claude's transcript keeps neither, so the runner keeps
 * these next to the chat's state (~/.termag/chats/<chat>.turns.jsonl). Only
 * turns this runner started are recorded, so a turn continued in the terminal
 * pane never lands in the chat's total. `userUuid` is the transcript entry
 * Claude wrote for this turn, which is how a reload finds that bubble when
 * the same words were said again.
 */
function turnRecord({ turnId, prompt, sessionId, userUuid, result, startedAt, endedAt, exitCode }) {
  const cost = result && typeof result.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null;
  const duration = result && typeof result.duration_ms === 'number' && Number.isFinite(result.duration_ms)
    ? result.duration_ms
    : Math.max(0, endedAt - startedAt);
  return {
    turnId,
    at: new Date(endedAt).toISOString(),
    prompt: String(prompt || '').trim().slice(0, RECORD_PROMPT_CHARS),
    sessionId: sessionId || null,
    userUuid: typeof userUuid === 'string' && USER_UUID_RE.test(userUuid) ? userUuid : null,
    costUsd: cost,
    durationMs: Math.round(duration),
    isError: result ? result.is_error === true : exitCode !== 0,
  };
}

/** The turn records in a turns file, oldest first; lines that are not one are skipped. */
function parseTurnRecords(text, max = TURN_RECORDS_MAX) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.turnId !== 'string') continue;
    out.push({
      turnId: r.turnId,
      at: typeof r.at === 'string' ? r.at : null,
      prompt: typeof r.prompt === 'string' ? r.prompt : '',
      userUuid: typeof r.userUuid === 'string' && USER_UUID_RE.test(r.userUuid) ? r.userUuid : null,
      costUsd: typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) ? r.costUsd : null,
      durationMs: typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) ? r.durationMs : null,
      isError: r.isError === true,
    });
  }
  return out.slice(-max);
}

function createChatRunner({
  home, send, isOpen = () => true, startProcess, sessionAlive, signalPid, stopSession = async () => {},
  pidAlive = pidIsAlive, interruptGraceMs = INTERRUPT_GRACE_MS, turnInterruptMs = TURN_INTERRUPT_MS,
  env = process.env, claudeBin, username = 'user', log = () => {}, now = Date.now,
  readCheckout = null,
  // A backend's launch settings (backendSettings); tests give their own.
  launchSettings = null,
  // An ask's turn is over (exit written, every line forwarded), before it is
  // marked done; and ask jobs a queue dropped without running. agent/ask-chat.js.
  onTurnDone = async () => {}, onDropped = () => {},
}) {
  const inspectCheckout = readCheckout || (cwd => readCheckoutFacts(cwd));
  const settingsFor = launchSettings || (b => backendSettings(b, { env }));
  const images = chatImages.createImageStore(home);
  /** A message's content line for stdin: its images as blocks (the ones still on disk), then its text. */
  const messageBlocks = job => (Array.isArray(job.images) ? job.images.map(ref => images.block(job.chatKey, ref)).filter(Boolean) : []);
  const root = path.join(home, '.termag/chats');
  const turnsDir = path.join(root, 'turns');
  const active = new Map();
  const parked = new Set();
  // Chats a chat-clear is stopping. A send is refused and nothing queued
  // starts, so no turn runs after the revoke was told the chat is stopped.
  const clearing = new Set();
  // A startTurn that has begun but not yet reached active.set. The checkout
  // inspect awaits before that, and history has to say running through it:
  // otherwise Open in full UI types claude --resume into the same session.
  const starting = new Set();
  // Chats Open in full UI has claimed. A queued job stays queued until the
  // claim is released, so it cannot start in the gap before the resume is typed.
  const resumeHolds = new Set();
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
    const pane = s.pane === 'owns' || s.pane === 'seen' ? s.pane : null;
    const paneAt = typeof s.paneAt === 'number' && Number.isFinite(s.paneAt) ? s.paneAt : null;
    return { sessionId: isSessionId(s.sessionId) ? s.sessionId : null, cwd: typeof s.cwd === 'string' ? s.cwd : null, pane, paneAt };
  }
  function writeState(chatKey, patch) {
    ensureRoot();
    const prev = readJson(stateFile(chatKey), {});
    const next = { ...prev, ...patch, updatedAt: new Date(now()).toISOString() };
    // A null claim is "no claim", not a value the next merge should revive.
    if (patch.pane === null) delete next.pane;
    if (patch.paneAt === null) delete next.paneAt;
    writeJson(stateFile(chatKey), next);
  }
  const paneBlocks = chatKey => readState(chatKey).pane !== null;
  const readQueue = chatKey => { const q = readJson(queueFile(chatKey), []); return Array.isArray(q) ? q : []; };
  function writeQueue(chatKey, queue) {
    ensureRoot();
    if (queue.length) writeJson(queueFile(chatKey), queue);
    else fs.rmSync(queueFile(chatKey), { force: true });
  }
  const activeFor = chatKey => [...active.values()].find(t => t.meta.chatKey === chatKey) || null;
  function dropped(jobs) {
    const asks = jobs.filter(j => j && j.ask && j.ask.runId);
    if (!asks.length) return;
    try { onDropped(asks); } catch (err) { log(`[CHAT] dropped-ask hook failed: ${err.message}`); }
  }
  async function turnDone(t) {
    if (!t.meta.ask || !t.meta.ask.runId || t.reported) return;
    t.reported = true;
    try { await onTurnDone(t.meta, t.dir); } catch (err) { log(`[CHAT] ask hook failed for ${t.meta.turnId}: ${err.message}`); }
  }
  const stillRunning = t => Boolean(t) && !fs.existsSync(path.join(t.dir, 'exit'));
  const turnsFile = chatKey => path.join(root, `${chatKey}.turns.jsonl`);
  function readTurns(chatKey) {
    try { return parseTurnRecords(fs.readFileSync(turnsFile(chatKey), 'utf8')); } catch { return []; }
  }
  function appendTurn(chatKey, record) {
    if (!record || readTurns(chatKey).some(r => r.turnId === record.turnId)) return;
    try {
      ensureRoot();
      fs.appendFileSync(turnsFile(chatKey), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch (err) { log(`[CHAT] ${chatKey}: could not record turn ${record.turnId}: ${err.message}`); }
  }
  function resultFromLog(text) {
    let result = null;
    for (const line of text.split('\n')) {
      if (!line.includes('"result"')) continue;
      try { const ev = JSON.parse(line); if (ev && ev.type === 'result') result = ev; } catch { /* skip */ }
    }
    return result;
  }
  /** Cost of a turn from its log. The exit file's mtime is when it ended; a recover can be much later. */
  function costOfTurn(t) {
    let log = '';
    try { log = fs.readFileSync(path.join(t.dir, 'events.jsonl'), 'utf8'); } catch { return null; }
    const result = resultFromLog(log);
    const exit = readJson(path.join(t.dir, 'exit'), {});
    const startedAt = Date.parse(t.meta.startedAt);
    let endedAt = now();
    try { endedAt = fs.statSync(path.join(t.dir, 'exit')).mtimeMs; } catch { /* not written yet */ }
    const sessionId = (result && result.session_id) || sessionIdFrom(log) || readState(t.meta.chatKey).sessionId;
    const file = sessionId ? findTranscript(home, sessionId) : null;
    // The first prompt Claude wrote after this turn started. An earlier
    // terminal turn is before that offset; a later one is a later uuid.
    const userUuid = file
      ? userPromptUuid(linesForward(file, { start: Number.isInteger(t.meta.transcriptBytes) ? t.meta.transcriptBytes : 0 }))
      : null;
    return turnRecord({
      turnId: t.meta.turnId,
      prompt: t.meta.text,
      sessionId,
      userUuid,
      result,
      startedAt: Number.isFinite(startedAt) ? startedAt : endedAt,
      endedAt,
      exitCode: exit && typeof exit.code === 'number' ? exit.code : null,
    });
  }
  /**
   * Claude's title for the turn's session (session-title.js), from what the
   * turn added to the transcript. The init line has already been forwarded by
   * the turn-end, so the chat's state names the session.
   */
  function titleOfTurn(t) {
    const sessionId = readState(t.meta.chatKey).sessionId;
    const file = sessionId ? findTranscript(home, sessionId) : null;
    if (!file) return null;
    try {
      return sessionTitle(file, { start: Number.isInteger(t.meta.transcriptBytes) ? t.meta.transcriptBytes : 0 });
    } catch (err) {
      log(`[CHAT] ${t.meta.chatKey}: could not read the session title: ${err.message}`);
      return null;
    }
  }
  function recordTurn(t) {
    if (!fs.existsSync(path.join(t.dir, 'exit'))) return null;
    const record = costOfTurn(t);
    if (record) appendTurn(t.meta.chatKey, record);
    return record;
  }

  // A live turn's inbox (chat-turn.js): <n>.json waiting, <n>.sent delivered.
  const inboxDir = t => path.join(t.dir, 'inbox');
  function waitingInbox(t) {
    let names = [];
    try { names = fs.readdirSync(inboxDir(t)); } catch { return []; }
    return names.map(n => /^(\d+)\.json$/.exec(n)).filter(Boolean)
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map(m => ({ file: path.join(inboxDir(t), m[0]), job: readJson(path.join(inboxDir(t), m[0]), null) }))
      .filter(e => e.job && typeof e.job.text === 'string');
  }
  /**
   * Whether a message can go into the running turn rather than wait for it:
   * a live turn still running, for the same checkout, asked for under the
   * same mode (the turn's own mode was settled from it when it started).
   */
  const takesLive = (t, job) => job.liveInput === true && stillRunning(t) && t.meta.live === true && !t.cancelled
    && t.meta.cwd === job.cwd && t.meta.requestedMode === job.permissionMode
    // A message on another model waits for its own turn: `--model` is fixed for a running claude -p.
    && (t.meta.model ?? null) === (job.model ?? null)
    && (t.meta.backend ?? null) === (job.backend ? job.backend.backend : null);
  /**
   * The mode a turn for this job runs in, settled from the checkout as it is
   * now. A live send settles it again: the tree can stop being the
   * repository's own while a turn runs, and a message written into that
   * turn would keep the surface it started with.
   */
  async function settleTurnMode(job) {
    const requested = permissionModeFor(job.permissionMode);
    let facts = null;
    if (isOpenMode(requested)) {
      try {
        facts = await inspectCheckout(job.cwd);
      } catch {
        // A checkout that cannot be read is not the repository's own tree.
        facts = { repo: true, unreadable: true };
      }
    }
    return { requested, mode: turnModeFor(requested, facts) };
  }
  // One send at a time per chat: a live send awaits the checkout before it
  // picks its inbox file, and a queued one rewrites the queue file.
  const sendChains = new Map();
  // Bumped by clear and interrupt: a send waiting its turn behind another
  // must not land after one of them drained the chat.
  const stops = new Map();
  const stopCount = chatKey => stops.get(chatKey) || 0;
  const bumpStops = chatKey => { stops.set(chatKey, stopCount(chatKey) + 1); };
  function oneSendAtATime(chatKey, fn) {
    const run = (sendChains.get(chatKey) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    sendChains.set(chatKey, tail);
    tail.then(() => { if (sendChains.get(chatKey) === tail) sendChains.delete(chatKey); });
    return run;
  }
  function deliverLive(t, job) {
    const dir = inboxDir(t);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let n = 0;
    try {
      for (const name of fs.readdirSync(dir)) n = Math.max(n, Number(/^(\d+)\./.exec(name)?.[1] ?? 0));
    } catch { /* empty */ }
    const file = path.join(dir, `${String(n + 1).padStart(6, '0')}.json`);
    const blocks = messageBlocks(job);
    writeJson(file, blocks.length ? { ...job, line: userLine(chatImages.userContent(job.text, blocks)) } : job);
  }
  /** Take a turn's undelivered messages out of its inbox, oldest first. */
  function drainInbox(t) {
    const jobs = [];
    for (const { file, job } of waitingInbox(t)) {
      // The built line holds the images' bytes; the references are enough to queue it.
      const { line: _line, ...queued } = job;
      try { fs.rmSync(file, { force: true }); jobs.push(queued); } catch { /* the wrapper took it */ }
    }
    return jobs;
  }

  /** A result line in the turn's log past this byte offset. */
  function resultSince(t, offset) {
    let buf;
    try {
      const fd = fs.openSync(path.join(t.dir, 'events.jsonl'), 'r');
      try {
        const size = fs.fstatSync(fd).size;
        if (size <= offset) return false;
        buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
      } finally { fs.closeSync(fd); }
    } catch { return false; }
    return completeLines(buf).lines.some(line => parseEvent(line)?.type === 'result');
  }

  /**
   * Whether Claude has answered and only waits on background work: its last
   * result is newer than anything it said or took in since.
   */
  function claudeIdle(t) {
    let text;
    try { text = fs.readFileSync(path.join(t.dir, 'events.jsonl'), 'utf8'); } catch { return false; }
    let idle = false;
    for (const line of completeLines(Buffer.from(text)).lines) {
      const ev = parseEvent(line);
      if (ev?.type === 'result') idle = true;
      else if (ev?.type === 'assistant' || ev?.type === 'stream_event' || (ev?.type === 'user' && ev.isReplay === true)) idle = false;
    }
    return idle;
  }

  /**
   * Ask a live turn's wrapper to stop Claude's current work (chat-turn.js
   * writes the stream-json interrupt). Claude answers with a result and
   * keeps its background commands; the turn ends once none is left. No
   * result within turnInterruptMs (an older wrapper, stdin already closed)
   * and the turn is stopped as a whole. 'idle' when Claude has already
   * answered: an interrupt would do nothing, and the fallback would end the
   * background work this stop leaves running. False when the request could
   * not be written.
   */
  function interruptTurn(t) {
    let offset;
    try { offset = fs.statSync(path.join(t.dir, 'events.jsonl')).size; } catch { return false; }
    if (claudeIdle(t)) return 'idle';
    try {
      fs.mkdirSync(inboxDir(t), { recursive: true, mode: 0o700 });
      writeJson(path.join(inboxDir(t), `interrupt-${now()}.json`), {});
    } catch { return false; }
    emit(t.meta, t.meta.turnId, null, { type: 'user-stop', scope: 'turn' });
    const timer = setTimeout(() => {
      if (t.cancelled || !stillRunning(t) || resultSince(t, offset)) return;
      log(`chat ${t.meta.chatKey}: no result ${turnInterruptMs}ms after a turn stop; stopping the turn`);
      signalStop(t).catch(() => {});
    }, turnInterruptMs);
    timer.unref?.();
    return 'sent';
  }

  function emit(meta, turnId, seq, event) {
    return send({
      type: 'chat-event', chatKey: meta.chatKey, projectId: meta.projectId, workstream: meta.workstream,
      workstreamId: meta.workstreamId, turnId, seq, event: images.stripEvent(meta.chatKey, event),
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
    starting.add(job.chatKey);
    try {
    ensureRoot();
    const state = readState(job.chatKey);
    if (state.sessionId && state.cwd && state.cwd !== job.cwd) {
      rehomeTranscript(home, state.sessionId, job.cwd);
      writeState(job.chatKey, { sessionId: state.sessionId, cwd: job.cwd });
    }
    // The mode stored on a queued job is the backend's ceiling. Re-read this
    // checkout now, including after an agent restart. bypassPermissions is
    // kept for the project's main worktree and for a branch-off marked own
    // whose upstream is this repository and not a pull ref, and for a project
    // with no origin: the owner's tick is enough there. A missing marker on a
    // checkout that has an origin, a detached HEAD, and a pull-request or
    // fork checkout stay read-only even once HEAD has moved off the fetched
    // pull ref. A trusted own-tree turn is a normal Claude Code session and
    // loads the checkout's settings. Anything else runs from the scratch
    // config dir, which strips permission rules.
    const { requested, mode } = await settleTurnMode(job);
    const live = job.liveInput === true;
    const configDir = loadsCheckoutConfig(mode) ? undefined : prepareChatConfigDir(home);
    const mcpFile = mcpVersionFile(home, mode, live);
    const turnId = `${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = path.join(turnsDir, turnId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const claude = bin();
    const turnEnvironment = turnEnv(env, claude, configDir);
    if (job.ask) {
      // The termag tools an ask's prompt may name (termag-pr-create, ...).
      const local = path.join(home, '.local/bin');
      if (!(turnEnvironment.PATH || '').split(':').includes(local)) turnEnvironment.PATH = `${turnEnvironment.PATH || ''}:${local}`;
    }
    const blocks = messageBlocks(job);
    // A backend's settings are read as the turn starts: the box may have been
    // set up, or had it removed, since the send queued.
    let settings = null;
    let backendError = null;
    if (job.backend) {
      try { settings = await settingsFor(job.backend); } catch (err) { backendError = err; }
    }
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
      bin: claude, args: turnArgs(state.sessionId, mode, { live, images: blocks.length > 0, model: job.model, backend: job.backend, settings, ask: job.ask, orchestrator: job.orchestrator === true }), path: turnEnvironment.PATH, configDir, stateFile: stateFile(job.chatKey),
      startedAt: new Date(now()).toISOString(), transcriptBytes, live, requestedMode: requested, mode,
      model: job.model ?? null,
      ...(job.titles === true ? { titles: true } : {}),
      ...(job.backend ? { backend: job.backend.backend } : {}),
      ...(blocks.length && { images: job.images }),
      ...(job.ask ? { ask: job.ask, env: askEnv(job.ask) } : {}),
      ...(mcpFile && { mcpVersionFile: mcpFile }),
    };
    fs.writeFileSync(path.join(dir, 'prompt.txt'), job.text, { mode: 0o600 });
    if (blocks.length) fs.writeFileSync(path.join(dir, 'prompt.jsonl'), userLine(chatImages.userContent(job.text, blocks)), { mode: 0o600 });
    writeJson(path.join(dir, 'meta.json'), meta);
    writeJson(path.join(dir, 'forwarded.json'), { offset: 0, seq: 0 });
    const t = { dir, meta, offset: 0, seq: 0, starting: true, cancelled: false, started: null };
    // In the map before the session exists, so a second send waits. The
    // liveness check skips `starting`: has-session is false until tmux is up.
    active.set(turnId, t);
    // A backend that is not ready ends the turn with its reason, as a failed create does.
    const started = backendError ? Promise.reject(backendError) : startProcess(meta, dir);
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
          fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(turnStartEvent(meta))}\n`);
        }
        // Create failed: no wrapper is running, so the turn is already dead.
        closeTurn(t, t.cancelled ? null : `could not start the turn: ${err.message}`);
      }
    } finally {
      t.starting = false;
    }
    return turnId;
    } finally {
      starting.delete(job.chatKey);
    }
  }

  async function startNext(chatKey) {
    // A turn still in the map, even one whose exit is written, has not been
    // swept yet: the next message waits for that sweep so two turns never start.
    // paneBlocks: Open in full UI typed claude --resume and a probe has not
    // yet shown that Claude came up and then left. A shell, a miss, or vim
    // is not that proof, so a parked queue stays parked.
    if (activeFor(chatKey) || starting.has(chatKey) || resumeHolds.has(chatKey) || paneBlocks(chatKey) || parked.has(chatKey) || clearing.has(chatKey)) return;
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
          // A reload's answer lists every command and agent: nothing the chat shows.
          if (event && !isMcpReloadReply(event)) {
            if (event.type === 'system' && event.subtype === 'init' && isSessionId(event.session_id)) {
              writeState(t.meta.chatKey, { sessionId: event.session_id, cwd: t.meta.cwd });
            }
            // The wrapper's turn-end has no cost. Attach this turn's record
            // for the open view; the log itself stays the replay source.
            let outgoing = event;
            if (event.type === 'turn-end' && event.costUsd === undefined) {
              const record = recordTurn(t) || costOfTurn(t);
              if (record) outgoing = { ...event, costUsd: record.costUsd, durationMs: record.durationMs };
              const title = t.meta.titles === true ? titleOfTurn(t) : null;
              if (title) outgoing = { ...outgoing, title };
            }
            const ok = emit(t.meta, t.meta.turnId, t.seq + 1, outgoing);
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
        recordTurn(t);
        // What came in after Claude's last answer never went into the turn:
        // it is the next turn, ahead of anything queued behind this one.
        const left = t.cancelled ? [] : drainInbox(t);
        if (left.length) writeQueue(t.meta.chatKey, [...left, ...readQueue(t.meta.chatKey)]);
        // Before `done`: an agent that stops in between reports again on recovery, never not at all.
        await turnDone(t);
        fs.writeFileSync(path.join(t.dir, 'done'), new Date(now()).toISOString());
        active.delete(t.meta.turnId);
        log(`[CHAT] ${t.meta.chatKey} turn ${t.meta.turnId} done${left.length ? ` (${left.length} message(s) carried to the next turn)` : ''}`);
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
    recordTurn({ dir, meta });
    await turnDone(active.get(meta.turnId) || { meta, dir });
    try { fs.writeFileSync(path.join(dir, 'done'), new Date(now()).toISOString()); } catch { /* raced */ }
    dropped(readQueue(meta.chatKey));
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
        dropped(readQueue(m[1]));
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

  /**
   * Record the agent pane's foreground and whether a parked queue may start.
   * The claim is remembered on the chat's state file, so an agent restart
   * does not treat a missed probe as Claude having exited.
   */
  function applyPane(chatKey, probe) {
    if (!isChatKey(chatKey)) throw new Error('bad chatKey');
    const prev = readState(chatKey);
    const elapsed = prev.paneAt == null ? 0 : Math.max(0, now() - prev.paneAt);
    const pane = nextPaneClaim(prev.pane, probe, elapsed);
    if (pane !== prev.pane) {
      writeState(chatKey, pane === 'seen' && prev.pane !== 'seen'
        ? { pane, paneAt: null }
        : pane === 'owns'
          ? { pane, paneAt: prev.paneAt ?? now() }
          : { pane: null, paneAt: null });
    }
    return { resume: pane === null };
  }

  /** The backend speaks for a live chat: start what was parked. A pane that still owns the session keeps the park. */
  async function resumeQueue(chatKey) {
    await gate;
    if (!isChatKey(chatKey)) throw new Error('bad chatKey');
    if (paneBlocks(chatKey)) return { resumed: false };
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

  function eventsFromLog(dir, turnId, chatKey) {
    let log = '';
    try { log = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'); } catch { /* not started */ }
    const events = [];
    completeLines(Buffer.from(log)).lines.forEach((line, i) => {
      const event = parseEvent(line);
      if (event) events.push({ seq: i + 1, event: images.stripEvent(chatKey, event) });
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

  /** Where an ask's run is: `running` (its turn), `queued` (behind another), or null. */
  function findAsk(runId) {
    for (const t of active.values()) {
      if (t.meta.ask?.runId === runId && !fs.existsSync(path.join(t.dir, 'done'))) return { state: 'running', chatKey: t.meta.chatKey, turnId: t.meta.turnId };
    }
    let files = [];
    try { files = fs.readdirSync(root); } catch { files = []; }
    for (const f of files) {
      const m = /^(.+)\.queue\.json$/.exec(f);
      if (m && isChatKey(m[1]) && readQueue(m[1]).some(j => j.ask?.runId === runId)) return { state: 'queued', chatKey: m[1] };
    }
    return null;
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
    async notePane(chatKey, probe) {
      await gate;
      return applyPane(chatKey, probe);
    },

    /** The chat's session as the next turn will resume it. */
    readSession(chatKey) {
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      return readState(chatKey);
    },
    /**
     * Point the chat at a session (or none) in `cwd`, for the next turn: an
     * ask's thread whose clone was made again starts a new session, and one
     * that ran under termag-subagent-run before goes on with that session.
     */
    setSession(chatKey, { sessionId, cwd }) {
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      writeState(chatKey, { sessionId: isSessionId(sessionId) ? sessionId : null, cwd: typeof cwd === 'string' ? cwd : null });
    },

    findAsk,

    /**
     * Stop one ask's run and nothing else: out of its queue, or its turn
     * stopped as chat-interrupt would, keeping what is queued behind it
     * (another ask, or a person's message). Nothing is reported for it.
     */
    async cancelAsk(runId) {
      await gate;
      const where = findAsk(runId);
      if (!where) return { stopped: false };
      if (where.state === 'queued') {
        writeQueue(where.chatKey, readQueue(where.chatKey).filter(j => j.ask?.runId !== runId));
        return { stopped: true, queued: true };
      }
      const t = active.get(where.turnId);
      if (!t || !stillRunning(t)) return { stopped: false };
      t.reported = true;
      try { await signalStop(t); } catch { /* the pid escalation still runs */ }
      return { stopped: true, turnId: t.meta.turnId };
    },

    /**
     * Start a turn, queue it behind the one running, or hand it to a live
     * turn. One send at a time: the pane probe, the live-or-queue decision,
     * and a resume claim all share that chain, so one send's probe cannot
     * move the pane while another send is still settling, and a resume
     * cannot land between them.
     */
    async sendMessage({ chatKey, cwd, text, projectId, workstream, workstreamId, permissionMode, paneProbe, liveInput, model, backend, fastModel, context, images: sent, ask, orchestrator, titles }) {
      await gate;
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      if (clearing.has(chatKey)) throw new Error('chat-clearing: this chat is being stopped');
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be absolute');
      const decoded = chatImages.decodeImages(sent);
      // A message may be images alone, as in Claude Code.
      if (typeof text !== 'string' || (!text.trim() && !decoded.length)) throw new Error('text is required');
      if (text.length > MAX_TEXT) throw new Error('text is too long');
      const askJob = askOfJob(ask);
      const onBackend = askJob ? null : backendOf({ backend, model, fastModel, context });
      ensureRoot();
      const refs = decoded.map(img => images.save(chatKey, img.buf, img.mediaType));
      const job = {
        chatKey, cwd, text, projectId: String(projectId || ''), workstream: String(workstream || 'main'),
        workstreamId: workstreamId != null ? String(workstreamId) : null,
        permissionMode: permissionModeFor(permissionMode),
        // An ask's chat never takes messages into a running turn: each ask is its own turn and its own reply.
        ...(liveInput === true && !askJob ? { liveInput: true } : {}),
        ...(askJob ? { ask: askJob } : {}),
        ...(orchestrator === true && !askJob ? { orchestrator: true } : {}),
        // simple-ui-session-titles-enabled: the turn-end carries Claude's title for the session.
        ...(titles === true && !askJob ? { titles: true } : {}),
        model: onBackend ? onBackend.model : claudeModelArg(model),
        ...(onBackend ? { backend: onBackend } : {}),
        ...(refs.length ? { images: refs } : {}),
      };
      const stopsAtSend = stopCount(chatKey);
      return oneSendAtATime(chatKey, async () => {
        if (clearing.has(chatKey)) throw new Error('chat-clearing: this chat is being stopped');
        if (stopCount(chatKey) !== stopsAtSend) throw new Error('chat-stopped: the chat was stopped before this message went in');
        // The probe the send just took, inside the chain. A shell while the
        // pane still owns the session queues instead of starting a second
        // writer. A miss does too. Another send cannot apply its own probe
        // until this one has finished settling.
        if (paneProbe === 'claude' || paneProbe === 'shell' || paneProbe === 'other' || paneProbe === 'unknown') {
          applyPane(chatKey, paneProbe);
        }
        let queue = readQueue(chatKey);
        let live = null;
        const running = activeFor(chatKey);
        // A resume hold, a turn whose start has begun, or a pane that still
        // owns the session is not a turn that can take a live message. The
        // send queues, the same as a send during resume.
        const resumeBlocks = () => resumeHolds.has(chatKey) || starting.has(chatKey) || paneBlocks(chatKey);
        if (running && !queue.length && !resumeBlocks() && takesLive(running, job)) {
          // Only into a turn whose settled mode this send would get too; otherwise it queues, and the next turn settles its own.
          const { mode } = await settleTurnMode(job);
          if (clearing.has(chatKey)) throw new Error('chat-clearing: this chat is being stopped');
          if (stopCount(chatKey) !== stopsAtSend) throw new Error('chat-stopped: the chat was stopped before this message went in');
          queue = readQueue(chatKey);
          if (!resumeBlocks() && mode === running.meta.mode && activeFor(chatKey) === running && !queue.length && takesLive(running, job)) live = running;
        }
        if (live) {
          if (waitingInbox(live).length >= MAX_QUEUE) throw new Error('queue-full: too many messages are already waiting');
          deliverLive(live, job);
          // The backend is speaking for this chat, as for a queued send.
          live.recovered = false;
          return { queued: false, live: true, turnId: live.meta.turnId };
        }
        const paneHeld = paneBlocks(chatKey);
        if (paneHeld || activeFor(chatKey) || starting.has(chatKey) || resumeHolds.has(chatKey) || queue.length) {
          if (queue.length >= MAX_QUEUE) throw new Error('queue-full: too many messages are already waiting');
          queue.push(job);
          writeQueue(chatKey, queue);
          // A send is the backend speaking for a live chat: a parked queue goes
          // on, oldest first. Not while the pane owns the session — that park
          // is what keeps the queued turn off the session the pane is resuming.
          if (!paneHeld) {
            parked.delete(chatKey);
            const current = activeFor(chatKey);
            if (current) current.recovered = false;
            await startNext(chatKey);
          }
          return { queued: true, position: readQueue(chatKey).length };
        }
        return { queued: false, turnId: await startTurn(job) };
      });
    },

    /**
     * Drop a chat's queue and stop its running turn: for a chat being
     * archived or deleted, so nothing it left behind ever runs.
     */
    async clear(chatKey) {
      await gate;
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      clearing.add(chatKey);
      bumpStops(chatKey);
      // A hold that the orchestrator never released (its claim RPC died)
      // would otherwise keep every later turn queued until this process
      // restarts. Clearing the chat is that chat going away.
      resumeHolds.delete(chatKey);
      try {
        const t = activeFor(chatKey);
        const drop = [...readQueue(chatKey), ...(t ? drainInbox(t) : [])];
        const cleared = drop.length;
        dropped(drop);
        writeQueue(chatKey, []);
        parked.delete(chatKey);
        writeState(chatKey, { pane: null, paneAt: null });
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
     * scope 'turn' on a live turn stops only Claude's current work instead
     * (interruptTurn); the answer's scope says which stop was made.
     */
    async interrupt(chatKey, { scope } = {}) {
      await gate;
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      const t = activeFor(chatKey);
      // The pane holds the session and no runner turn is going. Claude in
      // the terminal keeps working; the parked queue stays for when it leaves.
      if (paneBlocks(chatKey) && !stillRunning(t)) {
        return { interrupted: false, held: true, dropped: [] };
      }
      bumpStops(chatKey);
      const queued = [...(t ? drainInbox(t) : []), ...readQueue(chatKey)];
      const texts = queued.map(job => job.text);
      dropped(queued);
      if (!stillRunning(t)) {
        if (texts.length) { writeQueue(chatKey, []); parked.delete(chatKey); }
        return { interrupted: false, dropped: texts.length ? texts : [] };
      }
      writeQueue(chatKey, []);
      parked.delete(chatKey);
      if (texts.length) emit(t.meta, t.meta.turnId, null, { type: 'queue-dropped', texts });
      const turnStop = scope === 'turn' && t.meta.live === true && !t.cancelled && !t.starting ? interruptTurn(t) : false;
      if (turnStop === 'idle') return { interrupted: false, scope: 'turn', dropped: texts };
      if (turnStop) return { interrupted: true, scope: 'turn', dropped: texts };
      try { await signalStop(t); } catch { /* the pid escalation still runs; the wrapper writes the exit */ }
      return { interrupted: true, scope: 'all', dropped: texts };
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
      const live = stillRunning(runningTurn) ? runningTurn : null;
      // A turn that died still has to be replayed after exit is written, or a
      // reload replaces the error with the transcript and the notice is gone.
      // A turn that finished normally is the transcript alone.
      const replay = live || lostTurn(chatKey, runningTurn);
      const queued = readQueue(chatKey).length + (live ? waitingInbox(live).length : 0);
      const file = sessionId ? findTranscript(home, sessionId) : null;
      // The tail is whole lines, a line with large images shrunk to references before it counts.
      const prefix = Boolean(replay && file && Number.isInteger(replay.meta.transcriptBytes));
      const jsonl = file ? historyTail(file, {
        end: prefix ? replay.meta.transcriptBytes : Infinity,
        maxBytes: HISTORY_MAX_BYTES,
        shrink: e => images.stripEvent(chatKey, e),
      }) : '';
      let entries = historyEntries(jsonl).map(e => images.stripEvent(chatKey, e));
      let turn = null;
      if (replay) {
        if (!prefix) {
          const ids = Array.isArray(replay.meta.images) ? replay.meta.images.map(r => r && r.id) : [];
          entries = entriesBeforeTurn(entries, replay.meta.text, ids);
        }
        turn = eventsFromLog(replay.dir, replay.meta.turnId, chatKey);
      }
      // liveInput: a message sent while the running turn runs goes into it (chat-live-v1).
      // starting: a turn whose checkout inspect has begun is running for a resume.
      return {
        sessionId, running: Boolean(live) || starting.has(chatKey), liveInput: live?.meta.live === true,
        queued, parked: parked.has(chatKey), entries, turn, turns: readTurns(chatKey),
      };
    },

    /**
     * Open in full UI claims the chat before typing the resume. A turn that
     * is running, or whose start has begun (including the checkout inspect
     * before the process exists), is not claimed: that turn owns the session.
     * A pane already marked `owns` is not claimed again: the first resume was
     * typed and Claude has not been seen yet, so a second line would land in
     * it. `seen` is not that refusal — a shell probe with `seen` means Claude
     * already left. Otherwise a queued job stays queued until releaseResume.
     *
     * The claim runs on the same chain as sendMessage, so a send cannot start
     * or deliver while this inspects, and this cannot take the pane between
     * a send's probe and its settle. The hold is still taken only after the
     * inspect: several git calls can outlast the 15s claim RPC, and a hold
     * taken first would leak if that RPC died before release.
     *
     * `line` is the only thing to type: the launcher path. The script is the
     * same permission surface a turn would use. It cds to this cwd when the
     * cwd is one this runner may name, trusted or confined, and the transcript
     * is rehomed there first when the recorded one differs. Without a cwd the
     * script does not cd and the transcript stays put. The line never
     * contains the flags.
     */
    async claimResume(chatKey, opts = {}) {
      await gate;
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      // Answer at once while a turn is already coming up. Waiting out that
      // turn on the send chain would hold the claim RPC for the whole start.
      if (starting.has(chatKey) || stillRunning(activeFor(chatKey))) return { claimed: false, running: true };
      return oneSendAtATime(chatKey, async () => {
        if (starting.has(chatKey) || stillRunning(activeFor(chatKey))) return { claimed: false, running: true };
        // The previous resume typed and Claude has not been seen. A second
        // claim would type the launcher into that Claude.
        if (readState(chatKey).pane === 'owns') return { claimed: false, running: true };
        const { sessionId } = readState(chatKey);
        let line = null;
        // Set only when the launcher will cd there. Claude looks the session
        // up under that cwd's slug, so a rename has to move the transcript
        // first, the same way startTurn does. A launcher with no cwd does
        // not cd, and must not move the file.
        let rehomeTo = null;
        const onBackend = backendOf(opts);
        if (sessionId) {
          const cwd = typeof opts.cwd === 'string' && opts.cwd.trim() ? opts.cwd : null;
          let mode = UNTRUSTED_MODE;
          if (cwd) {
            let facts;
            try { facts = await inspectCheckout(cwd); }
            catch { facts = { repo: true, unreadable: true }; }
            mode = turnModeFor(opts.permissionMode, facts);
          }
          // A backend that is not ready refuses the claim with its reason, before anything is held.
          const settings = onBackend ? await settingsFor(onBackend) : null;
          try {
            const launch = resumeLaunch({ home, chatKey, sessionId, mode, bin: bin(), cwd: cwd || undefined, backend: onBackend, settings });
            line = launch ? launch.line : null;
            if (launch && launch.cwd) rehomeTo = launch.cwd;
          } catch { line = null; }
        }
        // A turn may have started while we inspected. Refuse without holding,
        // and without moving a transcript that turn may be resuming.
        if (starting.has(chatKey) || stillRunning(activeFor(chatKey))) return { claimed: false, running: true };
        if (readState(chatKey).pane === 'owns') return { claimed: false, running: true };
        resumeHolds.add(chatKey);
        try {
          if (rehomeTo && readState(chatKey).cwd !== rehomeTo) {
            rehomeTranscript(home, sessionId, rehomeTo);
            writeState(chatKey, { sessionId, cwd: rehomeTo });
          }
          // From here the pane owns the session, even before the keys land: a
          // shell probe is the line's destination, not Claude having exited.
          writeState(chatKey, { pane: 'owns', paneAt: now() });
        } catch (err) {
          resumeHolds.delete(chatKey);
          throw err;
        }
        return { claimed: true, running: false, sessionId, line, queued: readQueue(chatKey).length, parked: parked.has(chatKey) };
      });
    },

    /**
     * Drop the claim. park keeps a queue from starting on its own after the
     * pane took the session. seen means waitForClaude found Claude: the claim
     * becomes `seen`, so a shell is Claude having left (/exit) and the start
     * grace does not keep the chat parked. On the send chain, so it cannot
     * flip the pane while a send is still settling.
     */
    async releaseResume(chatKey, opts = {}) {
      await gate;
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      return oneSendAtATime(chatKey, async () => {
        resumeHolds.delete(chatKey);
        const pane = readState(chatKey).pane;
        if (opts.seen && (pane === 'owns' || pane === 'seen')) {
          writeState(chatKey, { pane: 'seen', paneAt: now() });
        } else if (!opts.park && pane === 'owns') {
          // The keys never went out. Drop the claim taken above unless a probe
          // already saw Claude (that one still holds the session).
          writeState(chatKey, { pane: null, paneAt: null });
        }
        if (opts.park && readQueue(chatKey).length) parked.add(chatKey);
        return { released: true, parked: parked.has(chatKey) };
      });
    },
  };
}

module.exports = {
  CAPABILITIES,
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
  mcpVersionFile,
  parseEvent,
  permissionModeFor,
  checkoutOwnTree,
  githubSlug,
  isPullRef,
  readCheckoutFacts,
  prepareChatConfigDir,
  rehomeTranscript,
  resolveClaude,
  slugForCwd,
  splitLines,
  turnArgs,
  permissionArgs,
  backendOf,
  backendSettings,
  resumeLaunch,
  confinedResumeLine,
  parseTurnRecords,
  turnEnv,
  askEnv,
  askOfJob,
  turnRecord,
  turnSessionName, AUTO_MODE, isOpenMode, loadsCheckoutConfig, turnModeFor,
  userPromptUuid,
  PANE_START_GRACE_MS, nextPaneClaim,
};
