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
const claudePlanUsage = require('./claude-plan-usage');
const { historyTail, linesForward, wholeLinesFrom } = require('./transcript-lines');
const { generateTitle, sessionTitle, titlePrompt } = require('./session-title');
const { findPiSession, piHistoryEntries, piUserEntryId, rehomePiSession } = require('./pi-session');
const boxNotice = require('./box-notice');
const spaceMemory = require('./space-memory');
const toolGroupHeadings = require('./tool-group-headings');
const { codexResourceEnv } = require('./codex-resource-env');

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
// chat-effort-v1: a send may carry `effort`, which its turn runs at (`--effort`).
// chat-pi-v1: a send may carry `engine: 'pi'` (engineOf): its turn runs pi
// through `termag-pi-headless --headless` (piTurnArgs), and
// chat-engine-check runs that launcher's pre-flight (checkEngine).
// chat-genui-v1: a send may carry `genUiPrompt`, generative UI's system prompt,
// which its turn appends (not a pi turn's).
// chat-genui-v2: it may carry `genUiHint` too, a few hundred tokens: the turn
// appends only the hint, and the prompt is a file the hint tells Claude to
// read before its first UI (genUiReference).
// chat-context-v1: the context popover's actions.
// chat-reset clears the chat's context (resetContext): the next turn starts a
// new session, and history keeps the earlier ones above a `context-cleared`
// line. chat-resume puts the cleared session back until a turn has started a
// new one (resumePrevious). chat-compact runs `/compact` as a turn of its own
// (compact), Claude Code's own compaction in the same session.
// chat-transcript-v1: chat-transcript-read hands the orchestrator the chat's
// session file from an offset, which it stores.
// chat-subagents-v1: chat-subagent-read hands out a subagent's own
// transcript, which Claude Code keeps beside the session's
// (<session>/subagents/agent-<id>.jsonl), as history entries
// (subagentHistory).
// chat-box-notice-v1: a send may carry `boxNotices` (tell the turn the box
// restarted since the session's last one) and a `notice` of the
// orchestrator's; chat-restore-v1: chat-session-restore writes a stored
// session onto this box (box-notice.js).
const CAPABILITIES = ['chat-runner-v1', 'chat-durable-v1', 'chat-trust-v1', 'chat-auto-v1', 'chat-live-v1', 'chat-interrupt-v1', 'chat-orchestrator-v1', 'chat-backend-v1', 'chat-effort-v1', 'chat-pi-v1', 'chat-context-v1', 'chat-genui-v1', 'chat-genui-v2', 'chat-transcript-v1', 'chat-subagents-v1', 'chat-t3-hold-v1', ...chatImages.CAPABILITIES, ...boxNotice.CAPABILITIES];

/** A chat key the backend sends: letters, digits, `-`, `_`, `.`; no path. */
const CHAT_KEY_RE = /^[A-Za-z0-9_.-]{1,160}$/;
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,80}$/;
// A T3 thread id: a uuid, or an imported session's `import:<instance>:<session>`.
const T3_THREAD_RE = /^[A-Za-z0-9._:-]{1,200}$/;
// What a claim answers when t3 won't adopt the session for the thread.
const T3_ADOPT_REFUSALS = { busy: 't3-busy', unknown: 't3-unknown', forked: 'forked', unsupported: 't3-unsupported', offline: 't3-offline' };
const MAX_TEXT = 100_000;
const HISTORY_MAX_ENTRIES = 600;
const HISTORY_MAX_BYTES = 8 * 1024 * 1024;
// One chat-transcript-read's bytes at most (a longer single line is read whole).
const TRANSCRIPT_READ_MAX = 4 * 1024 * 1024;
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
// Sessions a chat left behind with a context reset, which its history still shows.
const EARLIER_SESSIONS_MAX = 20;
// Clears that Resume undid, kept so the history can still say where they were.
const UNDONE_MAX = 50;
/** The prompt of a compact turn: Claude Code runs it headless as its own compaction (verified on 2.1.310). */
const COMPACT_PROMPT = '/compact';
// The box's own session titles (session-title.js generateTitle), where Claude
// names no session: at most this many calls at once across the box's chats,
// this many tries per session, each from its own empty directory and its own
// gateway-only scratch config, so it shares nothing with a turn.
const MAX_TITLE_CALLS = 2;
const TITLE_TRIES = 3;
const TITLE_CONFIG_DIR = '.termag/chat-title-config';
const TITLE_CWD = '.termag/chat-title';
// Tool-group headings (tool-group-headings.js), the same way: one call at a
// time per chat, so each knows the heading before it, and this many across
// the box. Their own scratch config and directory.
const MAX_HEADING_CALLS = 2;
const HEADING_CONFIG_DIR = '.termag/chat-heading-config';
const HEADING_CWD = '.termag/chat-heading';
// How far into a transcript the session's opening message is looked for.
const FIRST_MESSAGE_SCAN_LINES = 200;

/** Claude's transcript user uuid, or a short test id of the same shape. */
const USER_UUID_RE = /^[A-Za-z0-9-]{1,80}$/;

function isChatKey(k) { return typeof k === 'string' && CHAT_KEY_RE.test(k) && !k.includes('..'); }
function isSessionId(s) { return typeof s === 'string' && SESSION_ID_RE.test(s); }
/** A subagent's id as Claude Code names its file (`agent-<id>.jsonl`): a name, never a path. */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function isAgentId(s) { return typeof s === 'string' && AGENT_ID_RE.test(s); }

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
 * Whether a turn runs in its ask thread's own clone, the one
 * deploy/termag-subagent-run made (~/.termag/subagent/threads/<id>/repo).
 * `ask` only ever comes from ask-chat.js, never from a chat-send frame.
 */
function inAskClone(home, job) {
  const threadId = job && job.ask && job.ask.threadId;
  if (!ASK_ID_RE.test(String(threadId || '')) || typeof job.cwd !== 'string') return false;
  return path.resolve(job.cwd) === path.join(home, '.termag/subagent/threads', threadId, 'repo');
}

/**
 * Why an ask clone that a run gave an origin `ask` does not track is
 * refused, and the way back ({ why, fix }), or null. Such a clone starts with no origin (its own tree); once a
 * run adds one (to merge origin/main, say) every later turn on the thread is
 * read-only, and stays so: the tree may hold a fetched PR head, so neither
 * bypassPermissions (its startup config) nor auto (a shell, unattended) is
 * safe there (Security Agent, #940). The ask's system prompt says not to add
 * remotes; this tells the owner what to undo when one was.
 */
function askCloneRecovery(facts, cwd) {
  if (!facts || !facts.originUrl || facts.upstreamRef || facts.upstreamMerge) return null;
  return {
    why: 'a run added a git remote to the thread\'s clone',
    fix: `remove that remote (\`git -C ${cwd} remote remove origin\`)`,
  };
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
 * Whether this box's Claude Code goes through termag's Claude gateway: the
 * owner's ~/.claude/settings.json carries the gateway's CLAUDE_CODE_USE_BEDROCK
 * (termag-credentials apply claude-gateway merges it in, and remove or
 * `skip claude-gateway` take it out), or, where the settings name none, the
 * runner's own environment does. Read at each turn: the owner may turn the
 * gateway off, or log in to Claude by hand, between two turns.
 */
function claudeOnGateway(home, env = process.env, fsImpl = fs) {
  let settingsEnv = {};
  try {
    const owner = JSON.parse(fsImpl.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    if (owner && typeof owner.env === 'object' && owner.env !== null) settingsEnv = owner.env;
  } catch { /* no owner settings */ }
  const v = Object.prototype.hasOwnProperty.call(settingsEnv, 'CLAUDE_CODE_USE_BEDROCK') ? settingsEnv.CLAUDE_CODE_USE_BEDROCK : env.CLAUDE_CODE_USE_BEDROCK;
  return v === true || v === 1 || /^(1|true)$/i.test(String(v ?? ''));
}

/**
 * The `--model` a turn launches with on this box. The orchestrator sends the
 * gateway's pinned profile id while the owner has the gateway on, but a box
 * can be off it all the same (`termag-credentials skip claude-gateway`, or
 * an orchestrator older than its owner's opt-out), and there Claude Code
 * talks to Anthropic's own API, which refuses every `us.anthropic.*` id. So
 * off the gateway a profile becomes its tier alias, and one of no tier is no
 * `--model` at all (Claude Code's default) rather than a turn that fails.
 */
function claudeLaunchArg(model, onGateway) {
  const chosen = claudeModelArg(model);
  if (!chosen || onGateway || !chosen.startsWith('us.anthropic.')) return chosen;
  const tier = /^us\.anthropic\.claude-(opus|sonnet|haiku)-/.exec(chosen);
  return tier ? tier[1] : null;
}

/**
 * Claude Code's `--effort` levels. Anything else, Default included, is no
 * flag, so the turn runs at what Claude Code picks for the model.
 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

function claudeEffortArg(effort) {
  return typeof effort === 'string' && EFFORT_LEVELS.includes(effort) ? effort : null;
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
// The flag's model list for Claude Code's model names and /model menu, as the
// orchestrator encodes it (fireworksMenuArg); the credentials script reads it.
const BACKEND_MODELS = /^[A-Za-z0-9+/=]{1,12000}$/;

/** The backend a send or claim names, checked; null for none; throws for one this runner cannot start. */
function backendOf({ backend, model, fastModel, context, models }) {
  if (backend == null || backend === '') return null;
  if (!BACKENDS.includes(backend) || typeof model !== 'string' || !BACKEND_MODEL.test(model)) {
    throw new Error('bad backend: not a model backend and model this runner can start');
  }
  return {
    backend, model,
    ...(typeof fastModel === 'string' && BACKEND_MODEL.test(fastModel) ? { fastModel } : {}),
    ...(Number.isInteger(context) && context > 0 ? { context } : {}),
    ...(typeof models === 'string' && BACKEND_MODELS.test(models) ? { models } : {}),
  };
}

/**
 * The agent a turn runs: Claude Code (the default, and what a send without
 * `engine` gets) or pi. A send naming anything else is refused rather than
 * run on Claude.
 */
const ENGINES = ['claude', 'pi'];

/** The engine a send or queued job names, checked; throws for one this runner cannot start. */
function engineOf({ engine } = {}) {
  if (engine == null || engine === '') return 'claude';
  if (!ENGINES.includes(engine)) throw new Error(`engine-refused: this runner cannot start the ${String(engine).slice(0, 40)} engine`);
  return engine;
}

/**
 * A `--model` value for pi: a provider-qualified model id as pi and the
 * model broker name them (`fireworks/glm-5.3-flash`, `bedrock/glm-5`),
 * or a bare one. Anything else is dropped, so pi runs the launcher's default.
 */
const PI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}(?:\/[A-Za-z0-9][A-Za-z0-9._:-]{0,120})?$/;

function piModelArg(model) {
  return typeof model === 'string' && PI_MODEL.test(model) ? model : null;
}

/** pi's `--thinking` takes the effort levels as they are (and off/minimal); Default is no flag. */
const PI_THINKING = ['off', 'minimal', ...EFFORT_LEVELS];

function piThinkingArg(effort) {
  return typeof effort === 'string' && PI_THINKING.includes(effort) ? effort : null;
}

/** pi's read-only built-ins: no bash, edit or write tool exists for the turn (decision 2 of the automations plan). */
const PI_READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'];

/**
 * The argv for one pi turn, after the launcher's `--headless`. The message
 * goes on stdin, never in argv: pi hangs on a prompt in argv while stdin is
 * open. The session is the runner's own uuid (`--session-id` creates it on
 * the first turn and continues it after). Every turn passes `--no-approve`,
 * so the checkout's `.pi/` settings, extensions and MCP servers never load.
 * The mode maps onto what Claude's permissionArgs gives each one:
 * - bypassPermissions (an owner-trusted own tree, someone watching): pi's
 *   full tools and the owner's own pi setup, MCP servers and skills
 *   included, as a bypass Claude turn loads the owner's;
 * - auto (an automation run on a trusted repository): full tools, but
 *   `--no-extensions` (pi's MCP support is a built-in extension, so no MCP
 *   server starts) and `--no-skills`, as an auto Claude turn has no MCP
 *   server and only the scratch config dir. pi has no classifier: auto is
 *   every tool unprompted;
 * - dontAsk (anything else): the same closure, and only the read-only tools.
 * The launcher adds its own telemetry extension with `-e`, which
 * `--no-extensions` keeps; it never loads termag-status.ts, since a turn's
 * status comes from the runner. A chosen model is `--model`, a chosen
 * effort `--thinking`.
 */
function piTurnArgs(sessionId, permissionMode, { model = null, effort = null } = {}) {
  if (!isSessionId(sessionId)) throw new Error('a pi turn needs a session id');
  const mode = permissionModeFor(permissionMode);
  const args = ['-p', '--mode', 'json', '--session-id', sessionId, '--no-approve'];
  if (!loadsCheckoutConfig(mode)) args.push('--no-extensions', '--no-skills');
  if (!isOpenMode(mode)) args.push('--tools', PI_READ_ONLY_TOOLS.join(','));
  const chosen = piModelArg(model);
  if (chosen) args.push('--model', chosen);
  const level = piThinkingArg(effort);
  if (level) args.push('--thinking', level);
  return args;
}

/**
 * The launcher a pi turn runs (deploy/termag-pi-headless, installed by
 * termag-reconcile): `--headless` for a turn, `--check` for the pre-flight.
 * Always an absolute path when the launcher exists, the override or one on
 * PATH included, so piLauncherReady can read it; a bare name means none.
 */
function resolvePi({ home, env = process.env, exists = fs.existsSync }) {
  const name = env.TERMAG_CHAT_PI || 'termag-pi-headless';
  if (!env.TERMAG_CHAT_PI) {
    const installed = path.join(home, '.local/bin/termag-pi-headless');
    if (exists(installed)) return installed;
  }
  if (path.isAbsolute(name)) return name;
  if (name.includes('/')) return path.resolve(name);
  for (const dir of (env.PATH || '').split(':')) {
    if (dir && exists(path.join(dir, name))) return path.resolve(dir, name);
  }
  return name;
}

/**
 * Whether the launcher knows `--headless` and `--check`. One from before
 * them passes either flag on to pi, which would start an interactive pi that
 * loads the status extension; a box whose termag-reconcile has not run since
 * is refused instead.
 */
function piLauncherReady(bin, { readFile = fs.readFileSync } = {}) {
  let text;
  try { text = readFile(bin, 'utf8'); } catch { return false; }
  return text.includes('--headless') && text.includes('--check');
}

const PI_CHECK_MS = 10_000;
const PI_LAUNCHER_MISSING = 'termag-pi-headless is not installed on this box (run termag-reconcile)';
const PI_LAUNCHER_OUTDATED = 'termag-pi-headless on this box has no --headless or --check (update the box)';

/**
 * chat-engine-check: whether a pi turn could start on this box now. The
 * launcher's `--check` runs no model (contract: exit 0 ready, 127 pi,
 * pi-headless or the AWS CLI missing, 75 the owner's AWS SSO session missing or lapsed,
 * 69 the broker down) and says why on one stderr line, which is the remedy.
 * Claude needs no check here.
 */
async function checkEngine({ engine } = {}, { home, env = process.env, execFile = execFileAsync, exists = fs.existsSync, readFile = fs.readFileSync, timeoutMs = PI_CHECK_MS } = {}) {
  const which = engineOf({ engine });
  if (which !== 'pi') return { ok: true, engine: which };
  const bin = resolvePi({ home, env, exists });
  const missing = { ok: false, engine: which, code: 'launcher-missing', remedy: PI_LAUNCHER_MISSING };
  // Not absolute: no launcher on this box, not even on PATH (resolvePi).
  if (!path.isAbsolute(bin) || !exists(bin)) return missing;
  if (!piLauncherReady(bin, { readFile })) return { ok: false, engine: which, code: 'launcher-outdated', remedy: PI_LAUNCHER_OUTDATED };
  try {
    await execFile(bin, ['--check'], { env, timeout: timeoutMs });
    return { ok: true, engine: which };
  } catch (err) {
    const remedy = String(err.stderr || '').trim().split('\n').pop() || err.message;
    if (err.code === 'ENOENT') return missing;
    if (err.killed || err.signal) return { ok: false, engine: which, code: 'check-timeout', remedy: `the pi check did not finish in ${Math.round(timeoutMs / 1000)}s` };
    const exitCode = typeof err.code === 'number' ? err.code : null;
    // The AWS CLI's line names pi-headless too ("pi-headless needs it"): match it first.
    const code = exitCode === 127 ? (/AWS CLI/.test(remedy) ? 'aws-missing' : /pi-headless/.test(remedy) ? 'launcher-missing' : 'pi-missing')
      : exitCode === 75 ? 'broker-auth'
        : exitCode === 69 ? 'broker-down'
          : 'check-failed';
    return { ok: false, engine: which, code, exitCode, remedy };
  }
}

const CREDENTIALS_SCRIPT = path.join(__dirname, '..', 'deploy', 'termag-credentials');

/** The Claude Code settings for a backend, from the box's credentials script; its reason when it refuses. */
async function backendSettings(b, { env = process.env, execFile = execFileAsync, script = CREDENTIALS_SCRIPT } = {}) {
  const args = ['launch-settings', '--backend', b.backend, '--model', b.model,
    ...(b.fastModel ? ['--fast', b.fastModel] : []), ...(b.context ? ['--context', String(b.context)] : []),
    ...(b.models ? ['--models', b.models] : []), '-'];
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
 * The telemetry resource for one of the chat's Claude runs, as `--settings`
 * env (docs/agents/gotchas.md, the agent telemetry resource): the owner's
 * (`termag-credentials apply telemetry`) with the chat's project and
 * workstream, as a pane of the same workstream sends them, and its kind in
 * place of `interactive`: `chat` for a turn, `oneshot` (with `oneshot` its
 * task, title or heading) for a Haiku call off one; an Open in full UI resume
 * names none, since it is a pane. The box script decides, as it does for a
 * pane's launch (telemetry-launch), so a box without termag's telemetry gets
 * nothing. null on any failure or a bad value: the run goes ahead with the
 * settings' resource, never fails for this.
 */
async function chatTelemetryEnv({ project, workstream, kind = null, oneshot = null, ask = null }, { home, env = process.env, execFile = execFileAsync, script = CREDENTIALS_SCRIPT } = {}) {
  const pair = codexResourceEnv({ project, workstream });
  const extra = {
    TERMAG_PROJECT: pair.TERMAG_PROJECT || '', TERMAG_WORKSTREAM: pair.TERMAG_WORKSTREAM || '',
    TERMAG_SESSION_KIND: kind || '', TERMAG_ONESHOT: oneshot || '',
    ...askTelemetryEnv(ask),
  };
  try {
    const { stdout } = await execFile(script, ['telemetry-launch', '-'], { env: { ...env, ...(home ? { HOME: home } : {}), ...extra }, timeout: 10_000 });
    const resource = JSON.parse(stdout)?.env?.OTEL_RESOURCE_ATTRIBUTES;
    return typeof resource === 'string' && resource ? { OTEL_RESOURCE_ATTRIBUTES: resource } : null;
  } catch { return null; }
}

const ASK_TELEMETRY_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ASK_TELEMETRY_SESSION_RE = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Who asked, from an ask job's `telemetry` (backend services/askTelemetry.ts):
 * the thread, the message's hop, and the parent's box, project, workstream and
 * Claude Code session. Each value that does not pass is left out (the project
 * and workstream together), never the turn; null without a thread.
 */
function askTelemetryOf(raw, threadId = null) {
  if (!raw || typeof raw !== 'object') return threadId && ASK_ID_RE.test(threadId) ? { thread: threadId } : null;
  const thread = typeof raw.thread === 'string' && ASK_ID_RE.test(raw.thread) ? raw.thread : threadId;
  if (!thread || !ASK_ID_RE.test(thread)) return null;
  const out = { thread };
  if (Number.isSafeInteger(raw.hop) && raw.hop > 0 && raw.hop < 1e6) out.hop = raw.hop;
  const p = raw.parent && typeof raw.parent === 'object' ? raw.parent : {};
  const name = v => (typeof v === 'string' && ASK_TELEMETRY_NAME_RE.test(v) ? v : null);
  const parent = {};
  if (name(p.box)) parent.box = p.box;
  if (name(p.project) && name(p.workstream)) Object.assign(parent, { project: p.project, workstream: p.workstream });
  if (typeof p.session === 'string' && ASK_TELEMETRY_SESSION_RE.test(p.session)) parent.session = p.session;
  if (Object.keys(parent).length) out.parent = parent;
  return out;
}

/** askTelemetryOf as the TERMAG_ASK_* telemetry-launch reads (deploy/termag-credentials); {} for none. */
function askTelemetryEnv(ask) {
  if (!ask) return {};
  const p = ask.parent || {};
  return {
    TERMAG_ASK_THREAD: ask.thread, TERMAG_ASK_HOP: ask.hop ? String(ask.hop) : '',
    TERMAG_ASK_PARENT_BOX: p.box || '', TERMAG_ASK_PARENT_PROJECT: p.project || '',
    TERMAG_ASK_PARENT_WORKSTREAM: p.workstream || '', TERMAG_ASK_PARENT_SESSION: p.session || '',
  };
}

/** `settings` (a backend's, or none) with the telemetry env on top; `settings` itself without any. */
function withTelemetry(settings, telemetry) {
  if (!telemetry) return settings;
  return { ...(settings || {}), env: { ...((settings && settings.env) || {}), ...telemetry } };
}

/**
 * `settings` with `model: ""` (Claude Code's default) when the box owner's
 * settings save a Fireworks id as `model`, else as is; for a run off a backend
 * (termag-credentials claude_launch does the same for a pane). Claude Code's
 * /model menu lists the Fireworks models on a box set up for them, and Enter
 * there saves the pick; a run
 * on the backend sets its own model, but one on the owner's own login would
 * start on the saved id and fail. The owner's file is never written.
 */
function withDefaultModel(settings, home, fsImpl = fs) {
  let saved;
  try { saved = JSON.parse(fsImpl.readFileSync(path.join(home, '.claude/settings.json'), 'utf8')).model; } catch { return settings; }
  return typeof saved === 'string' && BACKEND_MODEL.test(saved) ? { ...(settings || {}), model: '' } : settings;
}

/**
 * Only what prepareChatConfigDir carries from the owner's settings: the
 * credential helper and string env, and the backend's /model menu
 * (modelPicker, which grants nothing). The file launch-settings reads is the
 * box user's to write, and anything else in it (permission allow rules, a
 * status line command, hooks) would undo a confined turn's closure, since
 * --settings outranks the scratch settings.
 */
function gatewaySettings(settings) {
  const out = {};
  if (typeof settings.apiKeyHelper === 'string') out.apiKeyHelper = settings.apiKeyHelper;
  const picker = settings.modelPicker;
  if (picker && typeof picker === 'object' && Array.isArray(picker.options)) {
    out.modelPicker = {
      ...(typeof picker.replaceBuiltInOptions === 'boolean' ? { replaceBuiltInOptions: picker.replaceBuiltInOptions } : {}),
      options: picker.options
        .filter(o => o && typeof o.model === 'string')
        .map(o => ({ model: o.model, ...(typeof o.label === 'string' ? { label: o.label } : {}), ...(typeof o.description === 'string' ? { description: o.description } : {}) })),
    };
  }
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
 * stays last; Auto passes no model. Off the gateway (`onGateway` false,
 * claudeOnGateway) a profile id goes in as its alias (claudeLaunchArg). On a backend (backendOf) the model is
 * that backend's and `settings` its launch settings. A chosen effort is
 * `--effort`; Default passes none. A turn with generative UI's prompt reads
 * what it appends from `appendPromptFile` (appendedSystemPrompt, written
 * into the turn's directory), not argv: that prompt is about 32 KB, and its
 * hint carries a path. With the prompt filed (genUiReference), `readDir` is
 * the file's directory, added so even a confined turn may Read it.
 */
function turnArgs(sessionId, permissionMode, { live = false, images = false, model = null, backend = null, settings = null, ask = null, orchestrator = false, effort = null, appendPromptFile = null, readDir = null, onGateway = true } = {}) {
  const args = [
    '-p',
    ...(live ? ['--input-format', 'stream-json', '--replay-user-messages']
      : images ? ['--input-format', 'stream-json'] : ['--input-format', 'text']),
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    ...permissionArgs(permissionMode, settings),
  ];
  const chosen = backend ? backend.model : claudeLaunchArg(model, onGateway);
  if (chosen) args.push('--model', chosen);
  const level = claudeEffortArg(effort);
  if (level) args.push('--effort', level);
  if (ask) {
    // An ask's turn (agent/ask-chat.js) runs with nobody watching: a wakeup or
    // cron left pending would keep claude -p up, and the reply with it.
    args.push('--disallowedTools', ASK_DISALLOWED_TOOLS);
    if (ask.systemPrompt) args.push('--append-system-prompt', ask.systemPrompt);
  } else if (appendPromptFile) {
    args.push('--append-system-prompt-file', appendPromptFile);
    // The directory of generative UI's reference (genUiReference): a confined turn may Read only its working directories.
    if (readDir) args.push('--add-dir', readDir);
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
/** The most a generative UI prompt from the orchestrator may weigh (it is about 32 KB). */
const GENUI_PROMPT_MAX = 64 * 1024;
/** A generative UI prompt a turn may append: text the orchestrator sent, bounded, or null. */
function genUiPromptOf(prompt) {
  return typeof prompt === 'string' && prompt.trim() && prompt.length <= GENUI_PROMPT_MAX && !prompt.includes('\0') ? prompt : null;
}

/** Where the hint names the reference's file (frontend chat/genui/prompt.ts GEN_UI_REFERENCE_PLACEHOLDER). */
const GENUI_REFERENCE_PLACEHOLDER = '{{GEN_UI_REFERENCE}}';
/** The most the hint may weigh: it is about 1.5 KB. */
const GENUI_HINT_MAX = 8 * 1024;
/** A hint a turn may append in place of the prompt: bounded, naming the reference exactly once, or null. */
function genUiHintOf(hint) {
  return typeof hint === 'string' && hint.trim() && hint.length <= GENUI_HINT_MAX && !hint.includes('\0')
    && hint.split(GENUI_REFERENCE_PLACEHOLDER).length === 2 ? hint : null;
}

/**
 * The file generative UI's prompt is read from when the turn carries only the
 * hint (chat-genui-v2): ~/.termag/genui/<the prompt's sha256, 16 hex>/reference.md,
 * written once, then left for every chat and turn with that catalog. The path
 * is in the hint, so it is the same bytes on every turn of a session (the
 * prompt cache) until the catalog changes; the turn gets its directory as
 * `--add-dir`, so even a confined turn may Read it. null when the job carries
 * no hint (an older orchestrator, an ask), or the file can't be written: the
 * turn then appends the whole prompt, as before.
 */
function genUiReference(home, job, fsImpl = fs) {
  if (job.ask) return null;
  const prompt = genUiPromptOf(job.genUiPrompt);
  const hint = genUiHintOf(job.genUiHint);
  if (!prompt || !hint) return null;
  const dir = path.join(home, '.termag/genui', crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16));
  const file = path.join(dir, 'reference.md');
  try {
    if (!fsImpl.existsSync(file)) {
      fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Whole or not at all: a turn starting beside this one never reads half a reference.
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
      fsImpl.writeFileSync(tmp, prompt, { mode: 0o600 });
      fsImpl.renameSync(tmp, file);
    }
  } catch {
    return null;
  }
  return { dir, file, hint: hint.replace(GENUI_REFERENCE_PLACEHOLDER, file) };
}

/**
 * What a turn with generative UI's prompt appends to Claude's system prompt,
 * through --append-system-prompt-file: the orchestrator's prompt first when
 * the chat is one, then generative UI's (the hint when the prompt is filed,
 * `reference`, genUiReference, else the whole prompt), then the branch
 * upstream prompt when `branches`. null when the job carries neither (an ask
 * never does), and the turn keeps the plain --append-system-prompt.
 */
function appendedSystemPrompt(job, reference = null, { branches = false } = {}) {
  const ui = job.ask ? null : reference ? reference.hint : genUiPromptOf(job.genUiPrompt);
  const parts = ui ? [ui] : [];
  if (branches && !job.ask) parts.push(BRANCH_UPSTREAM_PROMPT);
  if (parts.length === 0) return null;
  // The file replaces turnArgs' plain --append-system-prompt, so an
  // orchestrator chat's prompt goes first in it whatever else filed it.
  if (job.orchestrator === true) parts.unshift(ORCHESTRATOR_SYSTEM_PROMPT);
  return parts.join('\n\n');
}

/**
 * For a Claude chat turn that asked for an open mode in a checkout with an
 * origin. A branch the session makes that tracks nothing, off origin's
 * branches, fails ownTreeRefusal, and every later turn is read-only. It
 * hangs on the mode asked for and the origin, not on whether this turn was
 * refused, so the bytes stay the same across a session's turns (the prompt
 * cache). Why a turn is read-only goes in its message (readOnlyNotice).
 */
const BRANCH_UPSTREAM_PROMPT = 'Branches in this checkout: termag gives a turn its full tools (shell, edits, MCP servers) only while the checked-out branch tracks a branch of origin, or was started on one in the project\'s own clone. Otherwise every later turn is read-only. So start a new branch from origin\'s branch (`git switch -c <branch> origin/<base>`, which tracks it), not from a fetched pull request or a detached HEAD, and publish it with `git push -u origin <branch>` when you first push. If you must leave a branch that tracks nothing, say so to the person.';

const ORCHESTRATOR_SYSTEM_PROMPT = 'The user started this session with "Act as an orchestrator". If you have not already done so in this conversation, invoke the agent-orchestrator skill before anything else, and follow it until the user tells you to stop orchestrating. If a termag command or feature misbehaves, even if you find a workaround, file it with `termag bug report` (the termag-bug-report skill).';
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
    // Who asked, for the turn's telemetry resource (chatTelemetryEnv); the thread alone from an older orchestrator.
    telemetry: askTelemetryOf(ask.telemetry, ask.threadId),
  };
}

const askPath = p => typeof p === 'string' && path.isAbsolute(p) && p.length <= 4096 && !/[\0\r\n]/.test(p);

/**
 * What an ask's turn adds to Claude's environment: commits in the clone are
 * the asker's, and the PR descriptions go where termag-subagent-run --report
 * reads them (TERMAG_ASK_PR_BODY_FILE, TERMAG_ASK_PR_DIR/<name>.md).
 */
/**
 * Which session the turn is: its project id and workstream, for `termag ask`
 * run inside it to say who asks (a turn has no tmux pane to name).
 */
function turnSessionEnv(job) {
  const env = {};
  if (typeof job.projectId === 'string' && job.projectId) env.TERMAG_PROJECT_ID = job.projectId;
  if (typeof job.workstream === 'string' && job.workstream) env.TERMAG_WORKSTREAM = job.workstream;
  return env;
}

function askEnv(ask) {
  if (!ask) return {};
  const env = {};
  if (ask.gitEmail) {
    const name = ask.gitName || ask.gitEmail;
    Object.assign(env, { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: ask.gitEmail, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: ask.gitEmail });
  }
  // The thread, for the marker termag-pr-body puts in a PR the run opens itself.
  env.TERMAG_ASK_THREAD = ask.threadId;
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
  // The chat runner owns this session's space memory (space-memory.js): the box's hooks must not add it
  // again in the pane, as they don't in its headless turns.
  body.push('export TERMAG_SPACE_MEMORY_MANAGED=1');
  // A pane, as its resource says (telemetry-launch keeps the settings' kind), for the tools it runs.
  body.push('export TERMAG_SESSION_KIND=interactive');
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
function resumeLaunch({ home, chatKey, sessionId, mode, bin = 'claude', cwd, backend = null, settings = null, appendPrompt = null, fsImpl = fs }) {
  if (!isSessionId(sessionId)) return null;
  // On a backend, the pane continues there, on the chat's model. The
  // session's frozen space-memory index (space-memory.js frozenPromptFor)
  // goes in as its turns pass it, byte for byte: `--resume` keeps no
  // appended system prompt, and the pane's hooks stay quiet (MANAGED_ENV).
  const argv = spaceMemory.withSpaceMemory(
    [...permissionArgs(mode, settings), ...(backend ? ['--model', backend.model] : []), '--resume', sessionId],
    appendPrompt ? { appendPrompt } : null,
  );
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
 * The toolchain dirs ~/.zshrc puts on PATH, which a turn never gets: it starts
 * from the agent, not a login shell, and Claude Code's Bash tool resets PATH to
 * claude's own before every command, so `go`, `gofmt` and `cargo` were
 * "command not found" in chat and ask turns on boxes that have them. The same
 * dirs deploy/termag-claude-runner adds, in its order, each only where it
 * exists. Returns [dirs, the *_ROOT variables to set].
 */
function toolchainDirs(env, exists = fs.existsSync) {
  const home = env.HOME;
  if (!home) return [[], {}];
  const goenv = env.GOENV_ROOT || path.join(home, '.goenv');
  const pyenv = env.PYENV_ROOT || path.join(home, '.pyenv');
  const roots = {};
  if (exists(goenv)) roots.GOENV_ROOT = goenv;
  if (exists(pyenv)) roots.PYENV_ROOT = pyenv;
  const dirs = [path.join(home, '.cargo/bin'), path.join(pyenv, 'bin'), path.join(pyenv, 'shims'), path.join(goenv, 'bin'), path.join(goenv, 'shims')];
  return [dirs.filter(d => exists(d)), roots];
}

/**
 * The environment of a turn: the agent's, without the tmux variables (so the
 * box's status hooks, which key on the pane, post nothing for it), with the
 * box's toolchains on PATH (toolchainDirs) and the claude binary's own
 * directory first (an nvm install finds its node).
 */
function turnEnv(env, claudeBin, configDir, exists = fs.existsSync) {
  const next = { ...env };
  delete next.TMUX;
  delete next.TMUX_PANE;
  const [tools, roots] = toolchainDirs(env, exists);
  for (const [k, v] of Object.entries(roots)) if (!next[k]) next[k] = v;
  for (const d of tools) if (!(next.PATH || '').split(':').includes(d)) next.PATH = next.PATH ? `${d}:${next.PATH}` : d;
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
function prepareChatConfigDir(home, fsImpl = fs, { dir: name = '.termag/chat-config', linkProjects = true } = {}) {
  const real = path.join(home, '.claude');
  const dir = path.join(home, name);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (linkProjects) {
    fsImpl.mkdirSync(path.join(real, 'projects'), { recursive: true });
    linkInto(fsImpl, path.join(dir, 'projects'), path.join(real, 'projects'));
  }
  const creds = path.join(real, '.credentials.json');
  if (fsImpl.existsSync(creds)) linkInto(fsImpl, path.join(dir, '.credentials.json'), creds);
  let gateway = {};
  try {
    const owner = JSON.parse(fsImpl.readFileSync(path.join(real, 'settings.json'), 'utf8'));
    for (const k of ['apiKeyHelper', 'env']) if (owner[k] != null) gateway[k] = owner[k];
  } catch { /* no owner settings: an empty scratch settings still confines reads */ }
  // Beside it and renamed over it: a turn starting meanwhile reads the old file or the new one, never half of one.
  const settings = path.join(dir, 'settings.json');
  fsImpl.writeFileSync(`${settings}.tmp`, JSON.stringify(gateway), { mode: 0o600 });
  fsImpl.renameSync(`${settings}.tmp`, settings);
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
 * A subagent's own transcript, `<projects>/<slug>/<session>/subagents/agent-<id>.jsonl`,
 * under any slug: a rename moves the session's file (rehomeTranscript) and
 * leaves its folder where Claude Code wrote it. Null when none has it.
 */
function findSubagentTranscript(home, sessionId, agentId, { readdir = fs.readdirSync, exists = fs.existsSync } = {}) {
  if (!isSessionId(sessionId) || !isAgentId(agentId)) return null;
  const root = path.join(home, '.claude/projects');
  let dirs = [];
  try { dirs = readdir(root); } catch { return null; }
  for (const d of dirs) {
    const file = path.join(root, d, sessionId, 'subagents', `agent-${agentId}.jsonl`);
    if (exists(file)) return file;
  }
  return null;
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
  content = spaceMemory.stripNotice(boxNotice.stripNotice(content));
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
  content = spaceMemory.stripNotice(boxNotice.stripNotice(content));
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return null;
  const text = messagePrompt(content);
  const images = content.filter(p => p && (p.type === 'image' || p.type === 'document') && p.source).map(p => imageId(p.source));
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

/**
 * An assistant message's prompt size, as its API call reported it: the
 * composer's context ring (frontend chat/contextUsage.ts) reads it from a
 * reopened chat's history as from a live turn. Only the input counts, and
 * only numbers; nothing when the transcript has none.
 */
function promptUsage(usage) {
  if (!usage || typeof usage !== 'object') return {};
  const out = {};
  for (const k of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (Number.isFinite(usage[k])) out[k] = usage[k];
  }
  return Object.keys(out).length ? { usage: out } : {};
}

/**
 * The newest `max` entries, with every divider marker from before the cut
 * kept ahead of them (a `context-cleared` or `context-compacted`, a few bytes
 * each). They are where the context changed: without them a long session
 * after a clear reloads as one continuous conversation, and the browser's
 * since-cleared cost has no clear to count from.
 */
function capHistory(entries, max = HISTORY_MAX_ENTRIES) {
  if (entries.length <= max) return entries;
  const cut = entries.length - max;
  const markers = entries.slice(0, cut).filter(e => e && (e.type === 'context-cleared' || e.type === 'context-compacted'));
  return [...markers, ...entries.slice(cut)];
}

/**
 * A message Claude took in while it worked, as the transcript keeps it: no
 * user line, only a `queued_command` attachment (the person's mid-turn
 * message from a live turn, or a background task's notification). As a user
 * entry under the uuid its live replay had, or null for anything else.
 */
function queuedCommandEntry(e) {
  const a = e && e.type === 'attachment' && !e.isSidechain ? e.attachment : null;
  if (!a || a.type !== 'queued_command' || a.commandMode !== 'prompt' || typeof a.prompt !== 'string' || !a.prompt) return null;
  return {
    type: 'user',
    uuid: typeof a.source_uuid === 'string' ? a.source_uuid : (typeof e.uuid === 'string' ? e.uuid : undefined),
    timestamp: typeof e.timestamp === 'string' ? e.timestamp : undefined,
    ...(/^\s*<task-notification>/.test(a.prompt) && { origin: { kind: 'task-notification' } }),
    // Taken in while a turn ran, so never a turn's own prompt (entriesBeforeTurn).
    queued: true,
    message: { role: 'user', content: a.prompt },
  };
}

/**
 * A session file's lines as the browser's history entries. `sidechain`: a
 * subagent's own file, whose every line is a sidechain's (subagentHistory);
 * a session's sidechain lines (an older Claude Code's) stay out of its own.
 */
function historyEntries(jsonl, max = HISTORY_MAX_ENTRIES, { sidechain = false } = {}) {
  const out = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    // A /compact's boundary is where the context was compacted: the browser draws it as a divider.
    if (e && e.type === 'system' && e.subtype === 'compact_boundary') {
      const pre = e.compactMetadata && Number.isFinite(e.compactMetadata.preTokens) ? e.compactMetadata.preTokens : null;
      const at = typeof e.timestamp === 'string' ? e.timestamp : null;
      out.push({ type: 'context-compacted', uuid: typeof e.uuid === 'string' ? e.uuid : undefined, at, timestamp: at || undefined, preTokens: pre });
      continue;
    }
    const queued = queuedCommandEntry(e);
    if (queued) { out.push(queued); continue; }
    if (!e || (e.type !== 'user' && e.type !== 'assistant')) continue;
    if ((e.isSidechain && !sidechain) || !e.message) continue;
    // The summary a compaction leaves is Claude's next context, not something anyone said.
    // Its uuid is what the compact turn's record names (userPromptUuid), so the
    // boundary carries it: the browser pins that turn's cost to the divider.
    if (e.isCompactSummary) {
      const boundary = out[out.length - 1];
      if (boundary && boundary.type === 'context-compacted' && !boundary.summaryUuid && typeof e.uuid === 'string') boundary.summaryUuid = e.uuid;
      continue;
    }
    const toolMeta = e.isMeta && e.type === 'user' && typeof e.sourceToolUseID === 'string';
    if (e.isMeta && !toolMeta) continue;
    out.push({
      type: e.type,
      uuid: typeof e.uuid === 'string' ? e.uuid : undefined,
      timestamp: typeof e.timestamp === 'string' ? e.timestamp : undefined,
      ...(toolMeta && { isMeta: true, sourceToolUseID: e.sourceToolUseID }),
      // A user-role line Claude Code wrote itself (a background task's notification): never the person's bubble.
      ...(typeof e.origin?.kind === 'string' && { origin: { kind: e.origin.kind } }),
      message: {
        id: typeof e.message.id === 'string' ? e.message.id : undefined,
        role: e.message.role,
        // `<synthetic>` marks a message Claude Code wrote itself (a refused command), not the model.
        ...(typeof e.message.model === 'string' && { model: e.message.model }),
        content: e.type === 'user' ? spaceMemory.stripNotice(boxNotice.stripNotice(e.message.content)) : e.message.content,
        ...(e.type === 'assistant' && promptUsage(e.message.usage)),
      },
    });
  }
  return capHistory(out, max);
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
 * checkout whose branch cannot be read is not its own tree. A branch with
 * no upstream counts in the main worktree when git's reflog says it was
 * created on a branch of origin and its startup config is still that
 * branch's (originStartOf): what the check guards is .claude/, .mcp.json
 * and .pi/ from someone else loading under bypassPermissions, and a missing
 * upstream was only a proxy for that. A worktree, an ask's clone, a pull
 * head fetched into a local branch, a branch started off origin's branches,
 * and one that changed its startup config still need an upstream.
 */
function sameRepoHeadsUpstream(facts) {
  const merge = facts.upstreamMerge;
  if (typeof merge !== 'string' || !/^refs\/heads\/.+/.test(merge)) return false;
  if (isPullRef(merge)) return false;
  return sameRepository(facts.originUrl, facts.upstreamUrl);
}

function checkoutOwnTree(facts) {
  return ownTreeRefusal(facts) === null;
}

/**
 * Why a checkout is not the repository's own tree (checkoutOwnTree), in
 * words for the person, or null when it is. A turn that asked for an open
 * mode and drops to dontAsk says this (turn-start's `readOnly`, and an ask's
 * reply), so a read-only turn is never silent.
 */
function ownTreeRefusal(facts) {
  if (!facts) return null;
  if (facts.repo === false) return memberRefusal(facts.members);
  if (facts.unreadable) return 'the checkout could not be read';
  if (!facts.branch) return 'HEAD is detached';
  const foreign = foreignSourceRefusal(facts);
  if (foreign) return foreign;
  // No origin: a project with no repository. It is a git init, often with a
  // commit, so the missing-directory case above does not cover it. The
  // owner's tick is enough. A pull-request or fork workstream, and a pull
  // upstream, were already refused.
  if (!facts.originUrl) return null;
  // A branch that tracks nothing, started on a branch of origin in the
  // project's own clone (`git switch -c <b>` off main), whose startup config
  // is still origin's: the session's own working branch.
  if (!facts.upstreamRef && !facts.upstreamMerge && facts.mainWorktree === true && facts.startedOnOrigin) return null;
  if (!facts.upstreamRef && !facts.upstreamMerge && facts.configChanged) {
    return `branch ${plain(facts.branch)} tracks none of origin's branches, and its startup config differs from ${plain(facts.configChanged.ref)} (${changedList(facts.configChanged.files)})`;
  }
  if (!sameRepoHeadsUpstream(facts)) {
    return facts.upstreamRef || facts.upstreamMerge
      ? `branch ${plain(facts.branch)} tracks ${plain(facts.upstreamRef || facts.upstreamMerge)}, not a branch of origin`
      : `the checkout has an origin but branch ${plain(facts.branch)} tracks none of its branches`;
  }
  if (facts.mainWorktree === true || facts.checkout === 'own') return null;
  return 'it is a worktree not marked as the project\'s own';
}

/**
 * A path, ref or branch name with its backticks and angle brackets dropped:
 * git allows both in ref names, and a backtick would open a command span in
 * the fix while `</termag-box-notice>` would close the notice early.
 */
function plain(s) {
  return String(s).replace(/[`<>]/g, '');
}

/**
 * A branch or ref name as one shell word for a fix's command: git allows
 * ; | & $ ( ) and quotes in ref names, so anything past a plain charset is
 * single-quoted. Backticks are dropped first (plain) so the chip stays one span.
 */
function shellRef(s) {
  const p = plain(s);
  return /^[A-Za-z0-9._\/@+-]+$/.test(p) ? p : shQuote(p);
}

/** Startup-config files for a reason or a fix: the first three, and how many more. */

function changedList(files) {
  const list = Array.isArray(files) ? files.map(plain) : [];
  return list.length > 3 ? `${list.slice(0, 3).join(', ')} and ${list.length - 3} more` : list.join(', ');
}

/**
 * What gives a read-only checkout its tools back, run by the person in a
 * terminal on the box (the turn itself has no shell), or null where the
 * refusal is the point: a pull-request or fork checkout, another repository,
 * a worktree not marked as the project's own.
 */
function readOnlyFix(facts) {
  if (!facts || facts.repo === false || facts.unreadable || !facts.originUrl) return null;
  if (!facts.branch) return 'switch the checkout back to a branch (`git switch <branch>`)';
  if (facts.checkout === 'pr' || facts.checkout === 'fork' || facts.fork || upstreamIsPull(facts)) return null;
  const origin = githubSlug(facts.originUrl);
  const upstream = githubSlug(facts.upstreamUrl);
  if (origin && upstream && upstream !== origin) return null;
  // A linked worktree not marked as the project's own stays refused whatever
  // its upstream (ownTreeRefusal), so no push or set-upstream would help.
  if (facts.mainWorktree !== true && facts.checkout !== 'own') return null;
  if (sameRepoHeadsUpstream(facts)) return null;
  const b = plain(facts.branch);
  const qb = shellRef(facts.branch);
  const set = `\`git branch --set-upstream-to=origin/<base> ${qb}\``;
  if (facts.configChanged && !facts.upstreamRef && !facts.upstreamMerge) {
    return `put ${changedList(facts.configChanged.files)} back as ${plain(facts.configChanged.ref)} has them (\`git restore --source=${shellRef(facts.configChanged.ref)} --staged --worktree -- <file>\`, deleting a new one), or, if those changes are yours, push branch ${b} with \`git push -u origin ${qb}\``;
  }
  return facts.upstreamRef || facts.upstreamMerge
    ? `point branch ${b} at a branch of origin: ${set}`
    : `give branch ${b} an upstream on origin: push it with \`git push -u origin ${qb}\`, or ${set}`;
}

/**
 * What a read-only turn's message tells the model (box-notice.js puts it
 * ahead of the person's text, never in the system prompt): which tools are
 * gone, and that termag took them, so it says why instead of reporting
 * ToolSearch, MCP or Bash as broken.
 */
function readOnlyNotice(readOnly, fix, tools) {
  return [
    `termag runs this turn read-only: only ${tools.join(', ')} exist (no shell, no edits, no MCP servers, no ToolSearch), because ${readOnly}.`,
    'This is termag\'s checkout check, not a broken tool, so don\'t retry the missing ones.',
    fix
      ? `If the person asked for more than reading, tell them that first, and the fix: ${fix}. The turn after that gets every tool again.`
      : 'If the person asked for more than reading, tell them that first, and why.',
  ].join(' ');
}

/**
 * Why a branch came from someone other than the project (a pull request, a
 * fork, a pull ref, another repository), or null.
 */
function foreignSourceRefusal(facts) {
  if (facts.checkout === 'pr' || facts.checkout === 'fork') return `branch ${plain(facts.branch)} was checked out from a ${facts.checkout === 'pr' ? 'pull request' : 'fork'}`;
  if (facts.fork) return `branch ${plain(facts.branch)} tracks a fork`;
  if (upstreamIsPull(facts)) return `branch ${plain(facts.branch)} tracks a pull-request ref`;
  const origin = githubSlug(facts.originUrl);
  const upstream = githubSlug(facts.upstreamUrl);
  if (origin && upstream && upstream !== origin) return `branch ${plain(facts.branch)} tracks another repository`;
  return null;
}

/**
 * A directory that is no checkout, such as a multi-repo workstream's root:
 * the owner's tick stands unless a repository
 * under it came from a pull request or a fork, or could not be read. The
 * turn runs in the root, but its agent works in each repository, the PR's
 * tree included. Only that is refused: before multi-repo PR checkouts, a
 * member on a detached HEAD or with no upstream kept the tick, and still does.
 */
function memberRefusal(members) {
  for (const m of members || []) {
    const why = m.unreadable ? 'the checkout could not be read' : foreignSourceRefusal(m);
    if (why) return `${m.name}: ${why}`;
  }
  return null;
}

async function gitOut(execFile, cwd, args) {
  const { stdout } = await execFile('git', ['-C', cwd, ...args], { timeout: 5000 });
  return String(stdout || '');
}

/**
 * A remote's URL: its first configured one when that names a GitHub
 * repository, else as `git remote get-url` expands insteadOf; throws when it
 * has none. A box's GitHub broker rewrite (insteadOf, in /etc/gitconfig)
 * turns every GitHub remote into the broker's, where githubSlug reads no
 * repository and a fork's upstream would not count as a fork. An alias such
 * as `gh:owner/name` names its repository only once expanded.
 */
async function remoteUrl(execFile, cwd, remote) {
  let configured = '';
  try {
    configured = (await gitOut(execFile, cwd, ['config', '--get-all', `remote.${remote}.url`])).split('\n')[0].trim();
  } catch { /* no url configured: get-url says what git uses */ }
  if (githubSlug(configured)) return configured;
  return (await gitOut(execFile, cwd, ['remote', 'get-url', remote])).trim() || null;
}

/**
 * An ask thread's clone (inAskClone): its `ask` branch is created from the
 * base it was seeded with, and a run may add an origin whose main contains
 * that base. #940 keeps such a clone read-only (askCloneRecovery), so a
 * start on origin never counts there.
 */
const ASK_CLONE_GIT_DIR = /\/\.termag\/subagent\/threads\/[^/]+\/repo\/\.git$/;

/**
 * What Claude Code and pi load from a checkout as they start, before any
 * permission check sees a tool call: Claude's .claude/ (settings.json and
 * settings.local.json with their apiKeyHelper, env, hooks and allow rules,
 * and the hook scripts, agents, commands and skills kept beside them),
 * .mcp.json's server commands, and pi's .pi/ (settings, extensions, MCP).
 * Any directory's, since a turn may start below the repository's top. The
 * bare .claude and .pi entries name the directory itself, so a symlink or
 * gitlink put in its place (which the /** globs never list) counts too.
 */
const STARTUP_CONFIG_PATHS = [':(top,glob)**/.claude/**', ':(top,glob)**/.claude', ':(top,glob)**/.mcp.json', ':(top,glob)**/.pi/**', ':(top,glob)**/.pi'];

/** A branch of origin by its fetched ref (`origin/<b>`, not a pull ref), or null. */
function originBranchRef(name) {
  const m = /^(?:refs\/remotes\/)?origin\/(.+)$/.exec(name);
  // Any pull ref under origin (pr/<n>, pr/<n>/head, pull/<n>/head, pull/<n>/merge), not just isPullRef's heads.
  if (!m || m[1] === 'HEAD' || /^(?:pr|pull)\/\d+(?:\/|$)/.test(m[1])) return null;
  return `refs/remotes/origin/${m[1]}`;
}

/** The origin branch a local branch tracks (`branch.<b>.remote` origin, a refs/heads merge, no pr/fork marker), or null. */
async function trackedOriginRef(execFile, cwd, name) {
  const local = name.replace(/^refs\/heads\//, '');
  if (!local || local.startsWith('-') || local === 'HEAD') return null;
  const get = async key => { try { return (await gitOut(execFile, cwd, ['config', '--local', '--get', key])).trim(); } catch { return ''; } };
  const marker = await get(`branch.${local}.termagCheckout`);
  if (marker === 'pr' || marker === 'fork') return null;
  const merge = await get(`branch.${local}.merge`);
  if ((await get(`branch.${local}.remote`)) !== 'origin' || !/^refs\/heads\/.+/.test(merge) || isPullRef(merge)) return null;
  // refs/heads/pr/<n> on origin is the runner's PR fetch: originBranchRef refuses it as it does origin/pr/<n>.
  return originBranchRef(`origin/${merge.slice('refs/heads/'.length)}`);
}

/**
 * The origin branch a branch with no upstream was started from, or null,
 * for the main worktree's own-tree check (ownTreeRefusal). Two things must
 * hold. The oldest entry of its reflog is git's own `branch: Created from
 * <ref>` (a rename keeps it; `git fetch origin pull/<n>/head:<b>` writes
 * `fetch …` instead), and <ref> is a branch of origin, a local branch that
 * tracks one, or HEAD while on such a branch (HEAD's reflog says which).
 * FETCH_HEAD, a pull ref, a commit id or a tag is none of those. And
 * nothing that loads at start (STARTUP_CONFIG_PATHS) differs from the
 * merge-base with that origin branch, in HEAD, the working tree, as an
 * untracked file, or as an ignored one written since the branch was made
 * (ignoredSince): the startup config is origin's, which is what an upstream
 * on origin vouches for. `{ ref }` when both hold, `{ ref, changed }` (the
 * startup-config files that differ) when only the first does, and null
 * otherwise, an expired or unreadable reflog included.
 */
/**
 * Gitignored untracked startup-config files (a .claude/settings.local.json,
 * a hook script, an .mcp.json) written at or after the branch was made,
 * `createdAt` in unix seconds. git cannot tell a person's own ignored
 * settings from ones a patch brought in, so only files that predate the
 * branch (by ctime, which a patch or `touch` cannot set back) are taken as
 * the person's: one the branch's work wrote (or touched)
 * counts as changed startup config, as an untracked one does.
 */
async function ignoredSince(execFile, cwd, createdAt) {
  const files = (await gitOut(execFile, cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '--', ...STARTUP_CONFIG_PATHS])).split('\n').map(f => f.trim()).filter(Boolean);
  return files.filter(f => {
    try { const st = fs.lstatSync(path.resolve(cwd, f)); return Math.max(st.mtimeMs, st.ctimeMs) >= createdAt * 1000; } catch { return true; }
  });
}

async function originStartOf(execFile, cwd, branch) {
  try {
    const lines = (await gitOut(execFile, cwd, ['log', '-g', '--date=unix', '--format=%H%x09%gd%x09%gs', `refs/heads/${branch}`, '--'])).trim().split('\n');
    const [start, selector, subject] = lines[lines.length - 1].split('\t');
    const from = /^branch: Created from (\S+)$/.exec(subject || '');
    if (!/^[0-9a-f]{40,64}$/.test(start || '') || !from) return null;
    const createdAt = Number((/@\{(\d+)\}$/.exec(selector || '') || [])[1]);
    if (!Number.isFinite(createdAt)) return null;
    let ref = null;
    if (from[1] === 'HEAD') {
      // `git switch -c <b>` moves HEAD from the branch it was on to <b> at the start commit. A later
      // `git branch -m` leaves that line naming <b>'s first name, so any name the branch has had counts.
      const names = new Set([branch]);
      for (const l of lines) {
        const m = /^Branch: renamed refs\/heads\/(\S+) to refs\/heads\/\S+$/.exec(l.split('\t')[2] || '');
        if (m) names.add(m[1]);
      }
      const moves = (await gitOut(execFile, cwd, ['log', '-g', '--format=%H%x09%gs', 'HEAD', '--'])).trim().split('\n')
        .map(l => l.split('\t'))
        .map(([h, gs]) => {
          const m = h === start && typeof gs === 'string' ? /^checkout: moving from (\S+) to (\S+)$/.exec(gs) : null;
          return m && names.has(m[2]) ? m[1] : null;
        })
        .filter(Boolean);
      const prev = moves.length ? moves[moves.length - 1] : '';
      ref = prev ? originBranchRef(prev) || await trackedOriginRef(execFile, cwd, prev) : null;
    } else {
      ref = originBranchRef(from[1]) || await trackedOriginRef(execFile, cwd, from[1]);
    }
    if (!ref) return null;
    const base = (await gitOut(execFile, cwd, ['merge-base', 'HEAD', ref])).trim();
    if (!/^[0-9a-f]{40,64}$/.test(base)) return null;
    const name = ref.slice('refs/remotes/'.length);
    const changed = [
      ...(await gitOut(execFile, cwd, ['diff', '--name-only', '--no-ext-diff', base, 'HEAD', '--', ...STARTUP_CONFIG_PATHS])).split('\n'),
      ...(await gitOut(execFile, cwd, ['diff', '--name-only', '--no-ext-diff', base, '--', ...STARTUP_CONFIG_PATHS])).split('\n'),
      ...(await gitOut(execFile, cwd, ['ls-files', '--others', '--exclude-standard', '--', ...STARTUP_CONFIG_PATHS])).split('\n'),
      ...(await ignoredSince(execFile, cwd, createdAt)),
    ].map(f => f.trim()).filter(Boolean);
    return changed.length ? { ref: name, changed: [...new Set(changed)].sort() } : { ref: name };
  } catch { return null; }
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
async function readCheckoutFacts(cwd, execFile = execFileAsync, { members = true } = {}) {
  let inside = false;
  try {
    inside = (await gitOut(execFile, cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch { inside = false; }
  if (!inside) return members ? { repo: false, members: await memberCheckouts(cwd, execFile) } : { repo: false };
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
    try { originUrl = await remoteUrl(execFile, cwd, 'origin'); } catch { /* no origin */ }
    let upstreamUrl = null;
    let upstreamRef = null;
    let upstreamMerge = null;
    try {
      const up = (await gitOut(execFile, cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim();
      const remote = up.split('/')[0];
      if (remote && up !== '@{upstream}') {
        upstreamRef = up;
        upstreamUrl = await remoteUrl(execFile, cwd, remote);
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
            try { upstreamUrl = await remoteUrl(execFile, cwd, remote); } catch { /* that remote has no url */ }
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
    const start = branch && originUrl && !upstreamRef && !upstreamMerge && mainWorktree && !ASK_CLONE_GIT_DIR.test(gitDir)
      ? await originStartOf(execFile, cwd, branch)
      : null;
    // startedOnOrigin: the origin branch it started on, startup config unchanged; configChanged: the files that are not.
    const started = !start ? {} : start.changed ? { configChanged: { ref: start.ref, files: start.changed } } : { startedOnOrigin: start.ref };
    return { repo: true, branch, checkout, originUrl, upstreamUrl, upstreamRef, upstreamMerge, fork, mainWorktree, unattended, ...started };
  } catch {
    return { repo: true, unreadable: true };
  }
}

// More than a multi-repo project holds (MULTI_REPO_MAX, 8): past it the rest is not read, and refuses.
const MEMBER_MAX = 16;

/**
 * The checkouts directly under a directory that is none (memberRefusal):
 * each subdirectory with a `.git`, its facts and its name. A `.git` git
 * cannot read is unreadable, as is anything past MEMBER_MAX.
 */
async function memberCheckouts(cwd, execFile) {
  let names;
  try { names = fs.readdirSync(cwd).filter(n => !n.startsWith('.')).sort(); } catch { return []; }
  const dirs = names.filter(n => fs.existsSync(path.join(cwd, n, '.git')));
  const out = [];
  for (const name of dirs.slice(0, MEMBER_MAX)) {
    const facts = await readCheckoutFacts(path.join(cwd, name), execFile, { members: false });
    out.push({ name, ...(facts.repo ? facts : { repo: true, unreadable: true }) });
  }
  if (dirs.length > MEMBER_MAX) out.push({ name: dirs[MEMBER_MAX], repo: true, unreadable: true });
  return out;
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
    // A message taken in mid-turn may repeat the prompt's words; it is never the prompt.
    if (e.type !== 'user' || e.isMeta || e.queued || e.origin) continue;
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
 *
 * `total_cost_usd` is the session's, not the turn's: `claude -p --resume`
 * restores what the session has cost so far (verified on 2.1.310). The record
 * keeps that as `sessionCostUsd`, and the turn's own cost, what the total grew
 * by since `previousTotal` (the session's last record), as `costUsd`.
 */
function turnRecord({ turnId, prompt, sessionId, userUuid, result, startedAt, endedAt, exitCode, previousTotal = null }) {
  const total = result && typeof result.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null;
  const duration = result && typeof result.duration_ms === 'number' && Number.isFinite(result.duration_ms)
    ? result.duration_ms
    : Math.max(0, endedAt - startedAt);
  return {
    turnId,
    at: new Date(endedAt).toISOString(),
    prompt: String(prompt || '').trim().slice(0, RECORD_PROMPT_CHARS),
    sessionId: sessionId || null,
    userUuid: typeof userUuid === 'string' && USER_UUID_RE.test(userUuid) ? userUuid : null,
    costUsd: turnCost(total, previousTotal),
    sessionCostUsd: total,
    durationMs: Math.round(duration),
    isError: result ? result.is_error === true : exitCode !== 0,
  };
}

/**
 * A turn's own cost from its session's total and the total the session's turn
 * before it reported. A total lower than that one is a counter that started
 * again (a session that did not restore it, another config dir or box): all
 * of it is this turn's.
 */
function turnCost(total, previousTotal) {
  if (total == null) return null;
  // Rounded past Claude's own precision, so a difference of totals is no float noise.
  return previousTotal == null || total < previousTotal ? total : Math.round((total - previousTotal) * 1e10) / 1e10;
}

const finiteOrNull = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The turn records in a turns file, oldest first; lines that are not one are
 * skipped. Each turn's cost is taken again from the session totals (turnCost),
 * across the whole file before the cut: a record from before `sessionCostUsd`
 * was kept has the session's total in `costUsd`, which every chat summed.
 */
function parseTurnRecords(text, max = TURN_RECORDS_MAX) {
  const out = [];
  const totals = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.turnId !== 'string') continue;
    const sessionId = typeof r.sessionId === 'string' && r.sessionId ? r.sessionId : null;
    const total = 'sessionCostUsd' in r ? finiteOrNull(r.sessionCostUsd) : finiteOrNull(r.costUsd);
    // A record with no session has no turn before it to take from.
    const previous = sessionId ? totals.get(sessionId) ?? null : null;
    if (sessionId && total != null) totals.set(sessionId, total);
    out.push({
      turnId: r.turnId,
      at: typeof r.at === 'string' ? r.at : null,
      prompt: typeof r.prompt === 'string' ? r.prompt : '',
      sessionId,
      userUuid: typeof r.userUuid === 'string' && USER_UUID_RE.test(r.userUuid) ? r.userUuid : null,
      costUsd: turnCost(total, previous),
      sessionCostUsd: total,
      durationMs: typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) ? r.durationMs : null,
      isError: r.isError === true,
    });
  }
  return out.slice(-max);
}

function createChatRunner({
  home, send, isOpen = () => true, startProcess, sessionAlive, signalPid, stopSession = async () => {},
  pidAlive = pidIsAlive, interruptGraceMs = INTERRUPT_GRACE_MS, turnInterruptMs = TURN_INTERRUPT_MS,
  env = process.env, claudeBin, piBin, username = 'user', log = () => {}, now = Date.now,
  readCheckout = null,
  // A pi session id for a chat's first pi turn; tests give their own.
  newSessionId = () => crypto.randomUUID(),
  // A backend's launch settings (backendSettings); tests give their own.
  launchSettings = null,
  // The telemetry env of one Claude run (chatTelemetryEnv); tests give their own.
  telemetrySettings = null,
  // Asks Haiku for a session's title (session-title.js generateTitle); tests give their own.
  titleGenerator = generateTitle,
  // Asks Haiku for a tool group's heading (tool-group-headings.js generateHeading); tests give their own.
  headingGenerator = toolGroupHeadings.generateHeading,
  // An ask's turn is over (exit written, every line forwarded), before it is
  // marked done; and ask jobs a queue dropped without running. agent/ask-chat.js.
  onTurnDone = async () => {}, onDropped = () => {},
  // This boot (box-notice.js bootIdentity); tests give their own.
  bootNow = () => boxNotice.bootIdentity(),
  // The session's space memory (space-memory.js); tests give their own.
  memory = null,
  // The box's Claude Enterprise spend (claude-plan-usage.js); tests give their own.
  planUsage = null,
  // The box's t3 server's threads (t3-bridge.js threadSession, threadRelease,
  // threadAdopt): who else may be running this chat's session. Each answers
  // { result, … }; none means no t3 server on this box.
  t3Sessions = null,
}) {
  const t3s = t3Sessions || {
    session: async () => ({ result: 'unsupported' }),
    release: async () => ({ result: 'unsupported' }),
    adopt: async () => ({ result: 'unsupported' }),
  };
  const plan = planUsage || claudePlanUsage.createPlanUsage({ home, env });
  const inspectCheckout = readCheckout || (cwd => readCheckoutFacts(cwd));
  const settingsFor = launchSettings || (b => backendSettings(b, { env }));
  const telemetryFor = telemetrySettings || (o => chatTelemetryEnv(o, { home, env }));
  const images = chatImages.createImageStore(home);
  const memoryFor = memory || spaceMemory.createSpaceMemory({ home, env, log });
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
  const piLauncher = () => piBin || resolvePi({ home, env });
  /** A session's own file: Claude's transcript, or pi's session file. */
  const transcriptOf = (engine, sessionId) => (engine === 'pi' ? findPiSession(home, sessionId) : findTranscript(home, sessionId));
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
  // The sessions a context reset left behind, oldest first. Not in the state
  // file: chat-turn.js rewrites that whole file when a turn ends.
  const earlierFile = chatKey => path.join(root, `${chatKey}.earlier.json`);
  // Clears Resume undid: { sessionId, clearedAt, resumedAt }, oldest first.
  const undoneFile = chatKey => path.join(root, `${chatKey}.undone.json`);
  function readUndone(chatKey) {
    const list = readJson(undoneFile(chatKey), []);
    return Array.isArray(list)
      ? list.filter(e => e && isSessionId(e.sessionId) && typeof e.clearedAt === 'string' && typeof e.resumedAt === 'string').slice(-UNDONE_MAX)
      : [];
  }
  /**
   * A session's entries with its undone clears put back where they were: a
   * `context-cleared` line with `resumedAt`, after the last entry written
   * before the clear.
   */
  function withUndone(entries, sessionId, undone) {
    const marks = undone.filter(u => u.sessionId === sessionId);
    if (!marks.length) return entries;
    const out = entries.slice();
    for (const u of marks) {
      let i = out.length;
      while (i > 0 && !(typeof out[i - 1].timestamp === 'string' && out[i - 1].timestamp <= u.clearedAt)) i--;
      out.splice(i, 0, { type: 'context-cleared', at: u.clearedAt, resumedAt: u.resumedAt });
    }
    return out;
  }
  function readEarlier(chatKey) {
    const list = readJson(earlierFile(chatKey), []);
    return Array.isArray(list)
      ? list.filter(e => e && isSessionId(e.sessionId) && typeof e.clearedAt === 'string').slice(-EARLIER_SESSIONS_MAX)
      : [];
  }
  // The boot the chat's last turn started in (box-notice.js). Beside the
  // state file, which chat-turn.js rewrites whole at each turn end.
  const bootFile = chatKey => path.join(root, `${chatKey}.boot.json`);
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
    // t3: the desktop app's thread that holds the session (claimT3), or null.
    const t3 = s.t3 && typeof s.t3.threadId === 'string' && T3_THREAD_RE.test(s.t3.threadId) ? { threadId: s.t3.threadId } : null;
    // engine: which agent made the session. A state from before engines is Claude's.
    return { sessionId: isSessionId(s.sessionId) ? s.sessionId : null, cwd: typeof s.cwd === 'string' ? s.cwd : null, engine: s.engine === 'pi' ? 'pi' : 'claude', pane, paneAt, t3 };
  }
  function writeState(chatKey, patch) {
    ensureRoot();
    const prev = readJson(stateFile(chatKey), {});
    const next = { ...prev, ...patch, updatedAt: new Date(now()).toISOString() };
    // A null claim is "no claim", not a value the next merge should revive.
    if (patch.pane === null) delete next.pane;
    if (patch.paneAt === null) delete next.paneAt;
    if (patch.t3 === null) delete next.t3;
    writeJson(stateFile(chatKey), next);
  }
  const paneBlocks = chatKey => readState(chatKey).pane !== null;

  /**
   * A chat the desktop's thread holds with no session yet (one the desktop
   * made, before the thread's first turn) takes the session t3 has for the
   * thread once it has one, so web reads the thread's turns and a release
   * resumes the same session. Never over a session the chat already names.
   */
  async function fillT3Session(chatKey) {
    const state = readState(chatKey);
    if (!state.t3 || state.sessionId) return state;
    let found;
    try { found = await t3s.session({ threadId: state.t3.threadId }); } catch { return state; }
    const latest = readState(chatKey);
    if (found && found.result === 'ok' && isSessionId(found.sessionId) && !latest.sessionId && latest.t3 && latest.t3.threadId === state.t3.threadId) {
      writeState(chatKey, { sessionId: found.sessionId });
      log(`[CHAT] ${chatKey} takes session ${found.sessionId.slice(0, 8)} from its desktop thread`);
    }
    return readState(chatKey);
  }

  /**
   * Before a runner turn on a chat the desktop's thread holds: t3 closes the
   * thread's live Claude query, and the hold goes, so the turn is the one
   * writer. Refused while the thread runs a turn, when the thread has no
   * session yet (a runner turn would start a second one beside it), or when
   * t3 can't be asked. A t3 server that isn't running holds nothing live, and
   * the prompt guard (deploy/termag-status) refuses the thread's next prompt
   * once the hold is gone. On the send chain.
   */
  async function releaseT3(chatKey, workstream) {
    const state = await fillT3Session(chatKey);
    if (!state.t3) return;
    if (!state.sessionId) throw new Error('t3-busy: the desktop app has this session, and its first turn has not started');
    let r;
    try { r = await t3s.release({ threadId: state.t3.threadId }); } catch (err) {
      throw new Error(`t3-busy: the desktop app has this session, and its server did not answer (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!r || r.result === 'busy') throw new Error('t3-busy: Claude is working on this in the desktop app');
    writeState(chatKey, { t3: null });
    log(`[CHAT] ${chatKey} released from desktop thread ${state.t3.threadId} (${r.result})`);
    emitHolder(chatKey, workstream, { holder: 'runner', threadId: state.t3.threadId, sessionId: state.sessionId });
  }

  /**
   * Who drives the chat's session now, for the orchestrator's record
   * (Workstream.chatHolder, the desktop's sidebar): a notice outside any turn,
   * routed by the chat key, which is `<projectId>--<workstreamId>`.
   */
  function emitHolder(chatKey, workstream, event) {
    const at = chatKey.indexOf('--');
    if (at <= 0) return;
    emit({ chatKey, projectId: chatKey.slice(0, at), workstream: String(workstream || 'main'), workstreamId: chatKey.slice(at + 2) }, null, null, { type: 'chat-holder', ...event });
  }
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
  /** A live turn whose wrapper still reads its inbox: not once it closed Claude's stdin (chat-turn.js `stdin-ended`), though Claude may run on. */
  const readsInput = t => stillRunning(t) && t.meta.live === true && !fs.existsSync(path.join(t.dir, 'stdin-ended'));
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
    const pi = t.meta.engine === 'pi';
    const file = sessionId ? transcriptOf(t.meta.engine, sessionId) : null;
    // The first prompt Claude wrote after this turn started. An earlier
    // terminal turn is before that offset; a later one is a later uuid.
    const slice = file ? linesForward(file, { start: Number.isInteger(t.meta.transcriptBytes) ? t.meta.transcriptBytes : 0 }) : null;
    const userUuid = slice ? (pi ? piUserEntryId(slice) : userPromptUuid(slice)) : null;
    return turnRecord({
      turnId: t.meta.turnId,
      prompt: t.meta.text,
      sessionId,
      userUuid,
      result,
      startedAt: Number.isFinite(startedAt) ? startedAt : endedAt,
      endedAt,
      exitCode: exit && typeof exit.code === 'number' ? exit.code : null,
      previousTotal: sessionTotalBefore(t.meta.chatKey, sessionId, t.meta.turnId),
    });
  }
  /** The session's total as its last record before this turn's reported it. */
  function sessionTotalBefore(chatKey, sessionId, turnId) {
    if (!sessionId) return null;
    let total = null;
    for (const r of readTurns(chatKey)) {
      if (r.turnId === turnId) break;
      if (r.sessionId === sessionId && r.sessionCostUsd != null) total = r.sessionCostUsd;
    }
    return total;
  }
  /**
   * Claude's title for the turn's session (session-title.js), from what the
   * turn added to the transcript. The init line has already been forwarded by
   * the turn-end, so the chat's state names the session.
   */
  function titleOfTurn(t) {
    // pi's session files carry no title.
    if (t.meta.engine === 'pi') return null;
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
  // Chats with a title call out, so a chat has one at a time.
  const titling = new Set();
  // When clear() last ran for a chat (archived, deleted). A turn that started
  // before it gets no title, whenever its init or its title call lands; a
  // turn started after it is the chat in use again. An interrupt keeps the
  // chat and is not counted here.
  const lastClearAt = new Map();
  function clearedSince(chatKey, startedAt) {
    const at = lastClearAt.get(chatKey);
    if (at == null) return false;
    const started = Date.parse(startedAt);
    return !Number.isFinite(started) || at >= started;
  }
  // Beside the chat's state, not in it: chat-turn.js rewrites that file whole at every turn's exit.
  // titled: the session whose title reached the backend, Claude's or the box's; tries: title calls that session has had.
  const titleFile = chatKey => path.join(root, `${chatKey}.title.json`);
  function readTitleState(chatKey) {
    const s = readJson(titleFile(chatKey), {});
    return {
      titled: isSessionId(s.titled) ? s.titled : null,
      tries: s.tries && isSessionId(s.tries.sessionId) && Number.isInteger(s.tries.count) ? s.tries : null,
    };
  }
  function writeTitleState(chatKey, patch) {
    ensureRoot();
    writeJson(titleFile(chatKey), { ...readTitleState(chatKey), ...patch });
  }

  /** The first thing a person wrote in the session: what its title is made from. */
  function firstMessageOf(sessionId) {
    const file = findTranscript(home, sessionId);
    if (!file) return null;
    let n = 0;
    for (const buf of linesForward(file)) {
      if (++n > FIRST_MESSAGE_SCAN_LINES) break;
      let e;
      try { e = JSON.parse(buf.toString('utf8')); } catch { continue; }
      if (!e || e.type !== 'user' || e.isMeta || e.isSidechain || !e.message) continue;
      const text = messagePrompt(e.message.content);
      if (typeof text === 'string' && text.trim()) return text;
    }
    return null;
  }

  /**
   * Start the box's title call for a session Claude has not named, when the
   * send asked for titles: off the turn (nothing here awaits it), one per
   * chat, MAX_TITLE_CALLS across the box, TITLE_TRIES per session. It is
   * started at the turn's init, so the title shows while Claude works.
   */
  function maybeTitle(t, sessionId) {
    const chatKey = t.meta.chatKey;
    if (t.meta.ask || t.cancelled || titling.has(chatKey) || titling.size >= MAX_TITLE_CALLS) return;
    if (clearing.has(chatKey) || clearedSince(chatKey, t.meta.startedAt)) return;
    const s = readTitleState(chatKey);
    if (s.titled === sessionId) return;
    const tries = s.tries && s.tries.sessionId === sessionId ? s.tries.count : 0;
    if (tries >= TITLE_TRIES) return;
    writeTitleState(chatKey, { tries: { sessionId, count: tries + 1 } });
    titling.add(chatKey);
    // After this pass of poll(): reading the transcript's opening is not the turn's to wait for.
    new Promise(resolve => setImmediate(resolve))
      .then(() => titleSession(t, sessionId))
      .catch(err => log(`[CHAT] ${chatKey}: session title failed: ${err.message}`))
      .finally(() => titling.delete(chatKey));
  }

  async function titleSession(t, sessionId) {
    const chatKey = t.meta.chatKey;
    const message = firstMessageOf(sessionId) || t.meta.text;
    if (typeof message !== 'string' || !message.trim()) return;
    const claude = bin();
    const configDir = prepareChatConfigDir(home, fs, { dir: TITLE_CONFIG_DIR, linkProjects: false });
    const cwd = path.join(home, TITLE_CWD);
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const telemetry = await telemetryFor({ project: t.meta.project, workstream: t.meta.workstream, kind: 'oneshot', oneshot: 'title' });
    const title = await titleGenerator({ bin: claude, env: { ...turnEnv(env, claude, configDir), TERMAG_SESSION_KIND: 'oneshot' }, cwd, prompt: titlePrompt(message), settingsEnv: telemetry });
    if (!title) {
      log(`[CHAT] ${chatKey}: no session title from Haiku this time`);
      return;
    }
    // Claude named the session meanwhile (a first-party box); the chat was
    // cleared (archived, deleted) or is being; or it has moved on to another
    // session. Any of those, and the title is not this chat's to send.
    if (readTitleState(chatKey).titled === sessionId || readState(chatKey).sessionId !== sessionId) return;
    if (clearing.has(chatKey) || clearedSince(chatKey, t.meta.startedAt) || !isOpen()) return;
    const ok = emit(t.meta, t.meta.turnId, null, { type: 'session-title', title, source: 'generated' });
    if (ok !== false) writeTitleState(chatKey, { titled: sessionId });
  }

  // Tool-group headings, kept beside the chat's turn records.
  const headingsFile = chatKey => path.join(root, `${chatKey}.headings.jsonl`);
  // chatKey -> the chat's heading calls, one after another.
  const headingChains = new Map();
  let headingCalls = 0;
  const headingWaiters = [];
  async function headingSlot() {
    if (headingCalls < MAX_HEADING_CALLS) { headingCalls++; return; }
    await new Promise(resolve => { headingWaiters.push(resolve); });
  }
  function releaseHeadingSlot() {
    const next = headingWaiters.shift();
    if (next) next(); else headingCalls--;
  }

  /** Follow the turn's event for runs of tool calls that start, and ask for their headings. */
  function trackGroups(t, event) {
    if (t.meta.headings !== true || t.meta.ask) return;
    if (!t.groups) t.groups = toolGroupHeadings.createGroupTracker({ request: t.meta.text });
    for (const group of t.groups.feed(event)) queueHeading(t, group);
  }

  /**
   * Ask for a run's heading as soon as it starts, off the turn: after the
   * chat's earlier heading calls (so `previous` is the one before), at most
   * MAX_HEADING_CALLS across the box. The answer is kept and sent at once and
   * never replaced; a run with a kept answer is never asked again. A failure
   * is kept and sent as well, with the run's calls so far, for the browser's
   * fallback (Claude's lead-in, else those calls' labels); it is not retried.
   */
  function queueHeading(t, group) {
    const chatKey = t.meta.chatKey;
    const prev = headingChains.get(chatKey) || Promise.resolve();
    const job = prev.then(() => headGroup(t, group)).catch(err => log(`[CHAT] ${chatKey}: tool-group heading failed: ${err.message}`));
    headingChains.set(chatKey, job);
    void job.finally(() => { if (headingChains.get(chatKey) === job) headingChains.delete(chatKey); });
  }

  async function headGroup(t, group) {
    const chatKey = t.meta.chatKey;
    const gone = () => clearing.has(chatKey) || clearedSince(chatKey, t.meta.startedAt);
    if (gone()) return;
    const file = headingsFile(chatKey);
    if (Object.prototype.hasOwnProperty.call(toolGroupHeadings.readHeadings(file), group.runKey)) return;
    await headingSlot();
    let heading = null;
    try {
      if (gone()) return;
      const claude = bin();
      const configDir = prepareChatConfigDir(home, fs, { dir: HEADING_CONFIG_DIR, linkProjects: false });
      const cwd = path.join(home, HEADING_CWD);
      fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const input = toolGroupHeadings.headingPrompt({ ...group, previous: toolGroupHeadings.lastHeading(file) });
      const telemetry = await telemetryFor({ project: t.meta.project, workstream: t.meta.workstream, kind: 'oneshot', oneshot: 'heading' });
      heading = await headingGenerator({ bin: claude, env: { ...turnEnv(env, claude, configDir), TERMAG_SESSION_KIND: 'oneshot' }, cwd, input, settingsEnv: telemetry });
    } catch (err) {
      log(`[CHAT] ${chatKey}: tool-group heading call failed: ${err.message}`);
    } finally {
      releaseHeadingSlot();
    }
    // Archived or deleted meanwhile: not this chat's to keep or send.
    if (gone()) return;
    if (!heading) log(`[CHAT] ${chatKey}: no tool-group heading from Haiku for ${group.runKey}; the run gets its fallback`);
    const answer = heading ? { heading } : { failed: true, calls: group.size() };
    ensureRoot();
    toolGroupHeadings.appendHeading(file, { runKey: group.runKey, ...answer, turnId: t.meta.turnId, at: new Date(now()).toISOString() });
    // Kept either way: a view that missed the frame reads it from history.
    if (isOpen()) emit(t.meta, t.meta.turnId, null, { type: 'tool-group-heading', runKey: group.runKey, ...answer });
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
   * a live turn still reading its inbox, for the same checkout, asked for
   * under the same mode (the turn's own mode was settled from it when it
   * started). Once the wrapper closed stdin the message queues, and goes in
   * when the next turn starts.
   */
  const takesLive = (t, job) => job.liveInput === true && readsInput(t) && !t.cancelled
    // An ask goes into a running turn only as a follow-up of the ask it runs (steerAsk), never as a send.
    && !job.ask
    // A notice is for the turn that starts with it (box-notice.js), so that send waits for its own.
    && !job.notice
    && t.meta.cwd === job.cwd && t.meta.requestedMode === job.permissionMode
    // A message on another model or effort waits for its own turn: `--model` and `--effort` are fixed for a running claude -p.
    && (t.meta.model ?? null) === (job.model ?? null)
    && (t.meta.effort ?? null) === (job.effort ?? null)
    // Nor one asking for generative UI's prompt (or not) other than the turn's: a running turn's system prompt is fixed too.
    && (t.meta.genUi === true) === (job.genUiPrompt != null)
    && (t.meta.backend ?? null) === (job.backend ? job.backend.backend : null)
    && (t.meta.engine ?? 'claude') === (job.engine ?? 'claude');
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
    const mode = turnModeFor(requested, facts);
    // An open mode refused: the turn runs read-only, and says why (and, in an ask's clone, how to undo it).
    let readOnly = null;
    let fix = null;
    if (mode === UNTRUSTED_MODE && requested !== UNTRUSTED_MODE) {
      readOnly = ownTreeRefusal(facts) || 'the checkout is not the project\'s own tree';
      const recovery = inAskClone(home, job) ? askCloneRecovery(facts, path.resolve(job.cwd)) : null;
      // The way back goes out as the fix, so the turn's notice offers it rather than calling the refusal permanent.
      if (recovery) { readOnly = `${readOnly} (${recovery.why})`; fix = recovery.fix; } else fix = readOnlyFix(facts);
    }
    return { requested, mode, readOnly, fix, facts };
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
    return path.basename(file);
  }
  /**
   * The asks steered into a turn after the one it started with
   * (`meta.ask.runId`), oldest first: { runId, inbox, text }, on disk so an
   * agent restart keeps them (ask-chat.js reads them when the turn ends).
   */
  const asksFile = t => path.join(t.dir, 'asks.json');
  function turnAsks(t) {
    const list = readJson(asksFile(t), []);
    return Array.isArray(list) ? list.filter(e => e && ASK_ID_RE.test(String(e.runId || ''))) : [];
  }
  /** The ask a turn answers now: the newest one steered into it, else the one it started with. */
  function currentAsk(t) {
    const steered = turnAsks(t);
    return steered.length ? steered[steered.length - 1].runId : (t.meta.ask?.runId || null);
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

  /**
   * A turn's event as it leaves the box, live (emit) or replayed from its log
   * (eventsFromLog): images as references, and without the notices the runner
   * put ahead of the person's text, or a reload shows them as a second bubble.
   */
  function outboundEvent(chatKey, event) {
    return spaceMemory.stripNoticeEvent(boxNotice.stripNoticeEvent(images.stripEvent(chatKey, event)));
  }

  /**
   * After an answer, the seat's monthly spend for the composer's ring, as a
   * live notice outside the turn's log (no seq): claude-plan-usage.js asks at
   * most once a minute, and sends nothing without a claude.ai login. Only for
   * a turn whose send asked (`planSpend`, chat-plan-spend-enabled for the
   * project's owner): without it the endpoint is never called.
   */
  // A notice the socket drops under backpressure is not retried: the next
  // result sends the spend again, from the minute's cache (claude-plan-usage.js).
  function reportPlanUsage(meta) {
    plan.current()
      .then(spend => { if (spend) emit(meta, meta.turnId, null, { type: 'plan-usage', spend }); })
      .catch(() => {});
  }

  function emit(meta, turnId, seq, event) {
    return send({
      type: 'chat-event', chatKey: meta.chatKey, projectId: meta.projectId, workstream: meta.workstream,
      workstreamId: meta.workstreamId, turnId, seq, event: outboundEvent(meta.chatKey, event),
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
    const engine = t.meta.engine === 'pi' ? 'pi' : 'claude';
    if (prev.sessionId === sessionId && prev.cwd === cwd && prev.engine === engine) return;
    writeState(t.meta.chatKey, { sessionId, cwd, engine });
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
      if (state.engine === 'pi') rehomePiSession(home, state.sessionId, job.cwd);
      else rehomeTranscript(home, state.sessionId, job.cwd);
      writeState(job.chatKey, { sessionId: state.sessionId, cwd: job.cwd });
    }
    // A session goes on only on the engine that made it. A pi chat's first
    // turn names its session itself; pi creates it under that id.
    const pi = job.engine === 'pi';
    const resumeId = state.engine === (pi ? 'pi' : 'claude') ? state.sessionId : null;
    const piSession = pi ? (resumeId || newSessionId()) : null;
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
    const { requested, mode, readOnly, fix, facts } = await settleTurnMode(job);
    const readOnlyTools = pi ? PI_READ_ONLY_TOOLS : READ_ONLY_TOOLS;
    if (readOnly) log(`[CHAT] ${job.chatKey}: ${requested} asked, the turn runs read-only (${readOnlyTools.join(', ')}): ${readOnly}${fix ? `; to fix, ${fix}` : ''}`);
    const live = job.liveInput === true && !pi;
    // pi reads no Claude config: its closure is in piTurnArgs.
    const configDir = pi || loadsCheckoutConfig(mode) ? undefined : prepareChatConfigDir(home);
    const mcpFile = pi ? null : mcpVersionFile(home, mode, live);
    const turnId = `${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = path.join(turnsDir, turnId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const reference = genUiReference(home, job);
    const appended = appendedSystemPrompt(job, reference, { branches: !pi && isOpenMode(requested) && Boolean(facts && facts.originUrl) });
    const appendPromptFile = appended ? path.join(dir, 'system-prompt.md') : null;
    if (appendPromptFile) fs.writeFileSync(appendPromptFile, appended, { mode: 0o600 });
    const agentBin = pi ? piLauncher() : bin();
    const turnEnvironment = turnEnv(env, agentBin, configDir);
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
    } else if (!pi) settings = withDefaultModel(settings, home);
    // A launcher from before --headless would start an interactive pi with the status extension.
    // resolvePi gives a bare name only when no launcher is found, PATH included.
    if (pi && (!path.isAbsolute(agentBin) || !piLauncherReady(agentBin))) {
      backendError = new Error(path.isAbsolute(agentBin) && fs.existsSync(agentBin) ? PI_LAUNCHER_OUTDATED : PI_LAUNCHER_MISSING);
    }
    // The turn's resource: the chat's project and workstream, kind `chat` (chatTelemetryEnv); an ask's
    // chat is kind `ask`, with who asked (termag.ask.*), its person's turns too, since they are the same session.
    // A pi turn takes no Claude --settings, so it has nothing to carry it.
    // The same kind goes in the turn's environment (TERMAG_SESSION_KIND), pi's too, for the tools it runs.
    const askTelemetry = job.ask ? askTelemetryOf(job.ask.telemetry, job.ask.threadId) : null;
    const kind = askTelemetry ? 'ask' : 'chat';
    if (!pi) {
      settings = withTelemetry(settings, await telemetryFor({
        project: job.project, workstream: job.workstream, kind, ...(askTelemetry ? { ask: askTelemetry } : {}),
      }));
    }
    // The session's space memory: the same system-prompt bytes on every turn of
    // a session (the prompt cache), and any change since as a notice in the message.
    // A pi turn loads none: pi's session is not the one the memory was frozen for, and its argv takes no
    // --append-system-prompt from here (piTurnArgs), so the index would land in pi's argv as a stray flag.
    let memoryTurn = null;
    try {
      // A compact turn's prompt must stay a bare `/compact`, or Claude Code doesn't compact: it gets the
      // session's frozen index and no notice, and asks the CLI nothing. A change shows on the next turn.
      memoryTurn = pi ? null : job.compact === true
        ? { appendPrompt: memoryFor.frozenPromptFor(job.chatKey, resumeId), notice: null }
        : await memoryFor.forTurn({
          chatKey: job.chatKey, sessionId: resumeId, space: job.spaceMemory && job.spaceMemory.space, none: !!job.spaceMemory && job.spaceMemory.space === null,
        });
    } catch (err) { log(`[CHAT] ${job.chatKey}: space memory: ${err.message}`); }
    // Claude Code takes --append-system-prompt or its -file, not both: with
    // generative UI's prompt in a file, the index follows it there.
    if (appendPromptFile && memoryTurn && memoryTurn.appendPrompt) {
      fs.appendFileSync(appendPromptFile, `\n\n${memoryTurn.appendPrompt}`, { mode: 0o600 });
      memoryTurn = { ...memoryTurn, appendPrompt: null };
    }
    // What happened to the box since the session's last turn, told in the
    // message (never the system prompt, which must stay the same bytes):
    // the orchestrator's notice (a new box), else a restart this runner saw.
    // The boot is recorded once the turn's process has started, so a restart
    // is told once, and a turn that never starts leaves it to the next one.
    const boot = bootNow();
    const lastBoot = boxNotice.parseBoot(readJson(bootFile(job.chatKey), {}).boot);
    const notices = [];
    if (job.notice) notices.push(job.notice);
    else if (job.boxNotices && resumeId && boxNotice.restartedSince(lastBoot, boot)) notices.push(boxNotice.RESTART_NOTICE);
    // A read-only turn tells the model why, or it reports its missing tools as broken.
    if (readOnly && job.compact !== true) notices.push(readOnlyNotice(readOnly, fix, readOnlyTools));
    // Where the transcript ended before this turn. History cuts there, not on
    // the prompt text: an earlier turn that said the same thing ("go", "yes")
    // would otherwise take everything after it out of the view.
    let transcriptBytes = null;
    if (resumeId) {
      const existing = transcriptOf(pi ? 'pi' : 'claude', resumeId);
      transcriptBytes = 0;
      if (existing) { try { transcriptBytes = fs.statSync(existing).size; } catch { transcriptBytes = 0; } }
    }
    const meta = {
      chatKey: job.chatKey, projectId: job.projectId, ...(job.project ? { project: job.project } : {}), workstream: job.workstream, workstreamId: job.workstreamId, turnId,
      session: turnSessionName(username, turnId), cwd: job.cwd, text: job.text, resumed: Boolean(resumeId),
      bin: agentBin,
      args: pi
        ? ['--headless', ...piTurnArgs(piSession, mode, { model: job.model, effort: job.effort })]
        : turnArgs(resumeId, mode, { live, images: blocks.length > 0, model: job.model, backend: job.backend, settings, ask: job.ask, orchestrator: job.orchestrator === true, effort: job.effort, appendPromptFile, readDir: reference && reference.dir, onGateway: claudeOnGateway(home, turnEnvironment) }),
      path: turnEnvironment.PATH, configDir, stateFile: stateFile(job.chatKey),
      startedAt: new Date(now()).toISOString(), transcriptBytes, live, requestedMode: requested, mode,
      // Why an open mode was refused: turn-start shows it, and an ask's reply leads with it (ask-chat.js).
      ...(readOnly ? { readOnly } : {}),
      ...(readOnly && fix ? { readOnlyFix: fix } : {}),
      model: job.model ?? null,
      effort: job.effort ?? null,
      ...(job.titles === true ? { titles: true } : {}),
      ...(pi ? { engine: 'pi' } : {}),
      ...(job.headings === true ? { headings: true } : {}),
      ...(job.genUiPrompt != null ? { genUi: true } : {}),
      ...(job.compact === true ? { compact: true } : {}),
      // The orchestrator's notice (a new box) is in this turn's message: turn-start says so (chat-turn.js).
      ...(job.notice ? { newBoxNotice: true } : {}),
      ...(job.planSpend === true ? { planSpend: true } : {}),
      ...(job.backend ? { backend: job.backend.backend } : {}),
      ...(blocks.length && { images: job.images }),
      ...(job.ask ? { ask: job.ask } : {}),
      env: { ...askEnv(job.ask), ...turnSessionEnv(job), TERMAG_SESSION_KIND: kind },
      ...(mcpFile && { mcpVersionFile: mcpFile }),
    };
    // Memories only, as attributed data: nothing from the space's .termag/skills/ is loaded (space-memory.js).
    meta.args = spaceMemory.withSpaceMemory(meta.args, memoryTurn);
    // The box notice leads, then space memory's, then the person's text; each strip takes off its own (box-notice.js first).
    const promptText = boxNotice.withNotice(notices, spaceMemory.withNotice(memoryTurn && memoryTurn.notice, job.text));
    fs.writeFileSync(path.join(dir, 'prompt.txt'), promptText, { mode: 0o600 });
    if (blocks.length) fs.writeFileSync(path.join(dir, 'prompt.jsonl'), userLine(chatImages.userContent(promptText, blocks)), { mode: 0o600 });
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
      if (boot && !boxNotice.sameBoot(lastBoot, boot)) writeJson(bootFile(job.chatKey), { boot });
      if (!t.cancelled) {
        log(`[CHAT] ${job.chatKey} turn ${turnId} started in ${meta.session}${pi ? ' on pi' : ''}${resumeId ? ` (resume ${resumeId.slice(0, 8)})` : ''}`);
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
        // exit comes when Claude is gone. A turn recover took up in that state
        // (draining) is the same stop, from before this agent.
        const stopping = (t.cancelled || t.draining) && childAlive(t);
        // A pi left running by its dead wrapper is stopped first, a stop under
        // way or not (pi alone keeps childAlive true); the turn closes once it is gone.
        if (reapOrphanedPi(t)) t.draining = true;
        else if (!stopping && !t.starting && !fs.existsSync(path.join(t.dir, 'exit'))) closeTurn(t, DIED);
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
              writeState(t.meta.chatKey, { sessionId: event.session_id, cwd: t.meta.cwd, engine: t.meta.engine === 'pi' ? 'pi' : 'claude' });
              if (t.meta.titles === true) maybeTitle(t, event.session_id);
            }
            // The wrapper's turn-end has no cost. Attach this turn's record
            // for the open view; the log itself stays the replay source.
            let outgoing = event;
            if (event.type === 'turn-end' && event.costUsd === undefined) {
              const record = recordTurn(t) || costOfTurn(t);
              // sessionCostUsd says costUsd is the turn's own, not the session's total (the browser's sdkChat.ts).
              // `at` is when it ended, which the reply's footnote shows (frontend chat/chatTimes.ts).
              if (record) outgoing = { ...event, costUsd: record.costUsd, sessionCostUsd: record.sessionCostUsd, durationMs: record.durationMs, at: record.at };
              const title = t.meta.titles === true ? titleOfTurn(t) : null;
              if (title) {
                outgoing = { ...outgoing, title };
                // Claude's own title: a box's title call still out is dropped when it answers.
                const sessionId = readState(t.meta.chatKey).sessionId;
                if (sessionId) writeTitleState(t.meta.chatKey, { titled: sessionId });
              }
            }
            const ok = emit(t.meta, t.meta.turnId, t.seq + 1, outgoing);
            if (ok === false) { sentAll = false; break; }
            // After the send, so a line sent again after a failed send is followed once.
            trackGroups(t, event);
            if (event.type === 'result' && t.meta.planSpend === true) reportPlanUsage(t.meta);
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
        reapOrphanedPi(t);
        if (childAlive(t)) {
          // A stop's kill-session ended the session, and the wrapper is still
          // up writing the turn's end (a pi wrapper drains pi's stdout first).
          // poll closes it as died only once that wrapper is gone too.
          t.draining = true;
          log(`[CHAT] ${meta.chatKey} turn ${meta.turnId} taken up while its wrapper finishes`);
        } else {
          log(`[CHAT] ${meta.chatKey} turn ${meta.turnId} died while the agent was away`);
          closeTurn(t, DIED);
        }
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

  function readPid(dir, file = 'claude.pid') {
    try {
      const pid = Number(fs.readFileSync(path.join(dir, file), 'utf8').trim());
      return Number.isInteger(pid) && pid > 0 ? pid : 0;
    } catch { return 0; }
  }

  /**
   * The agent or its wrapper is still up. A pi wrapper outlives its agent:
   * it drains pi's stdout and writes the state file and `exit` after the
   * group SIGTERM has ended the launcher (chat-turn.js turn.pid).
   */
  function childAlive(t) {
    return [readPid(t.dir), readPid(t.dir, 'turn.pid')].some(pid => pid !== 0 && pidAlive(pid));
  }

  /**
   * A pi agent whose wrapper is gone without writing `exit` (it crashed or
   * was killed). pi was spawned detached, so no hangup reaches it, and it
   * would go on writing the session: SIGTERM its group, then SIGKILL
   * (armEscalation), once. True when one was found.
   */
  function reapOrphanedPi(t) {
    if (t.meta.engine !== 'pi' || t.orphanReaped) return false;
    const wrapper = readPid(t.dir, 'turn.pid');
    const agent = readPid(t.dir);
    if (!wrapper || pidAlive(wrapper) || !agent || !pidAlive(agent)) return false;
    t.orphanReaped = true;
    log(`[CHAT] ${t.meta.chatKey} turn ${t.meta.turnId}: its wrapper is gone and pi is not; stopping pi`);
    armEscalation(t, agent);
    return true;
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

  /**
   * SIGINT now, SIGTERM then SIGKILL on the same grace a running turn uses. The timers are not the answer to chat-clear.
   * A pi turn's agent leads its own process group (chat-turn.js): SIGTERM to
   * that group now, which ends pi's tools too, then SIGKILL. SIGINT would
   * leave a tool running.
   */
  function armEscalation(t, pid) {
    if (!pid) return;
    const grace = interruptGraceMs;
    const over = () => fs.existsSync(path.join(t.dir, 'exit'));
    if (t.meta.engine === 'pi') {
      signalPid(-pid, 'SIGTERM');
      setTimeout(() => { if (!over()) signalPid(-pid, 'SIGKILL'); }, grace).unref?.();
      return;
    }
    signalPid(pid, 'SIGINT');
    setTimeout(() => { if (!over()) signalPid(pid, 'SIGTERM'); }, grace).unref?.();
    setTimeout(() => { if (!over()) signalPid(pid, 'SIGKILL'); }, grace * 2).unref?.();
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

  /**
   * The sessions a context reset left behind, oldest first, each followed by
   * the `context-cleared` line the browser draws as a divider. The newest get
   * the byte budget the current session left; an older one past it shows
   * only its divider.
   */
  function earlierEntries(chatKey, earlier, budget, undone = []) {
    const out = [];
    let left = Math.max(0, budget);
    for (let i = earlier.length - 1; i >= 0; i--) {
      const { sessionId, clearedAt } = earlier[i];
      const file = left > 0 ? findTranscript(home, sessionId) : null;
      const jsonl = file ? historyTail(file, { maxBytes: left, shrink: e => images.stripEvent(chatKey, e) }) : '';
      left -= Buffer.byteLength(jsonl);
      out.unshift(...withUndone(historyEntries(jsonl).map(e => images.stripEvent(chatKey, e)), sessionId, undone), { type: 'context-cleared', at: clearedAt });
    }
    return out;
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
      if (event) events.push({ seq: i + 1, event: outboundEvent(chatKey, event) });
    });
    if (events.length <= TURN_EVENTS_MAX) return { turnId, events };
    // Only the newest lines: the head says what the cut hides that the view
    // needs, the turn-start (its prompt, that it runs, that it is live) and
    // the background tasks as of the cut (frontend chat/sdkChat.ts fromHistory).
    const kept = events.slice(-TURN_EVENTS_MAX);
    const cut = events.slice(0, -TURN_EVENTS_MAX).map(e => e.event);
    const start = cut.find(ev => ev.type === 'turn-start');
    const tasks = cut.filter(ev => ev.type === 'system' && ev.subtype === 'background_tasks_changed').pop();
    return { turnId, events: kept, head: [start, tasks].filter(Boolean) };
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
      if (fs.existsSync(path.join(t.dir, 'done'))) continue;
      if (t.meta.ask?.runId === runId || turnAsks(t).some(e => e.runId === runId)) return { state: 'running', chatKey: t.meta.chatKey, turnId: t.meta.turnId };
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
    /** The sessions context resets left behind, oldest first. */
    readEarlier(chatKey) {
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      return readEarlier(chatKey);
    },
    /**
     * Point the chat at a session (or none) in `cwd`, for the next turn: an
     * ask's thread whose clone was made again starts a new session, and one
     * that ran under termag-subagent-run before goes on with that session.
     */
    setSession(chatKey, { sessionId, cwd }) {
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      writeState(chatKey, { sessionId: isSessionId(sessionId) ? sessionId : null, cwd: typeof cwd === 'string' ? cwd : null, engine: 'claude' });
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
      // A turn that went on with a follow-up is that follow-up's to stop.
      if (currentAsk(t) !== runId) return { stopped: false, supersededBy: currentAsk(t) };
      t.reported = true;
      try { await signalStop(t); } catch { /* the pid escalation still runs */ }
      return { stopped: true, turnId: t.meta.turnId };
    },

    /**
     * A follow-up on an ask's thread, into the live turn that ask runs in
     * (ask-chat.js steerRun). It goes in through the turn's inbox like a live message, as the
     * ask `newRunId` with the turn's own ask settings, and joins the turn's
     * chain (asks.json), so the turn's end reports it rather than `runId`.
     * Refused, with a reason, when `runId` is not the ask the turn answers
     * now, or the turn can't take it: queued, not live, stopping, over
     * (`exit` is there, so its inbox may already have been drained), or no
     * longer reading its inbox (`input_closed`), which the orchestrator
     * then holds as the thread's next turn, as it does a chat message.
     */
    async steerAsk({ runId, newRunId, text }) {
      await gate;
      if (!ASK_ID_RE.test(String(runId || '')) || !ASK_ID_RE.test(String(newRunId || ''))) throw new Error('steerAsk needs two run ids');
      if (typeof text !== 'string' || !text.trim()) throw new Error('text is required');
      if (text.length > MAX_TEXT) throw new Error('text is too long');
      const where = findAsk(runId);
      if (!where) return { steered: false, reason: 'gone' };
      if (where.state !== 'running') return { steered: false, reason: 'queued' };
      return oneSendAtATime(where.chatKey, async () => {
        const t = active.get(where.turnId);
        // From here to the inbox write nothing awaits, so the turn's end cannot slip in between.
        if (!t || !stillRunning(t)) return { steered: false, reason: 'finished' };
        if (t.cancelled || t.reported || clearing.has(t.meta.chatKey)) return { steered: false, reason: 'stopping' };
        if (t.starting) return { steered: false, reason: 'starting' };
        // Each engine steers its own way: Claude through live stream-json stdin. One with no live
        // input (pi in JSON mode: one prompt on stdin) takes it as the next turn.
        if (t.meta.engine && t.meta.engine !== 'claude') return { steered: false, reason: `engine_no_live_input:${t.meta.engine}` };
        if (t.meta.live !== true) return { steered: false, reason: 'not_live' };
        // The wrapper closed Claude's stdin (chat-turn.js `stdin-ended`): its inbox is no longer read, though Claude may run on.
        if (!readsInput(t)) return { steered: false, reason: 'input_closed' };
        if (currentAsk(t) !== runId) return { steered: false, reason: 'superseded' };
        if (waitingInbox(t).length >= MAX_QUEUE) return { steered: false, reason: 'queue-full' };
        const m = t.meta;
        const job = {
          chatKey: m.chatKey, cwd: m.cwd, text: boxNotice.defuseSent(text), projectId: m.projectId, workstream: m.workstream, workstreamId: m.workstreamId,
          permissionMode: m.requestedMode, liveInput: true, ask: { ...m.ask, runId: newRunId }, model: m.model ?? null,
        };
        const inbox = deliverLive(t, job);
        writeJson(asksFile(t), [...turnAsks(t), { runId: newRunId, inbox, text: job.text }]);
        t.recovered = false;
        log(`[CHAT] ${m.chatKey} turn ${m.turnId}: ask ${newRunId} steered in after ${runId}`);
        return { steered: true, turnId: m.turnId };
      });
    },

    /**
     * Start a turn, queue it behind the one running, or hand it to a live
     * turn. One send at a time: the pane probe, the live-or-queue decision,
     * and a resume claim all share that chain, so one send's probe cannot
     * move the pane while another send is still settling, and a resume
     * cannot land between them.
     */
    async sendMessage({ chatKey, cwd, text, projectId, project, workstream, workstreamId, permissionMode, paneProbe, liveInput, model, backend, fastModel, context, models, images: sent, ask, orchestrator, titles, headings, effort, engine, genUiPrompt, genUiHint, spaceMemory: memorySpace , boxNotices, notice, planSpend }) {
      await gate;
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      if (clearing.has(chatKey)) throw new Error('chat-clearing: this chat is being stopped');
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be absolute');
      const decoded = chatImages.decodeImages(sent);
      // A message may be images alone, as in Claude Code.
      if (typeof text !== 'string' || (!text.trim() && !decoded.length)) throw new Error('text is required');
      if (text.length > MAX_TEXT) throw new Error('text is too long');
      const askJob = askOfJob(ask);
      const onEngine = engineOf({ engine });
      if (onEngine === 'pi') {
        // pi v1 is text turns on its own model list: no Claude ask, backend or images.
        if (askJob) throw new Error('engine-refused: an ask runs on Claude');
        if (backend != null && backend !== '') throw new Error('engine-refused: a pi turn takes no model backend');
        if (decoded.length) throw new Error('engine-refused: a pi turn takes no images');
      }
      const onBackend = askJob || onEngine === 'pi' ? null : backendOf({ backend, model, fastModel, context, models });
      // PDFs go to Claude's own models only: another backend may not take document blocks.
      if (onBackend && decoded.some(img => img.mediaType === chatImages.PDF)) throw new Error(`image-refused: PDFs go to Claude's own models, not ${onBackend.backend}`);
      ensureRoot();
      const refs = decoded.map(img => images.save(chatKey, img.buf, img.mediaType, img.name));
      const sentNotice = askJob ? null : boxNotice.sentNotice(notice);
      // A pi turn: never live, no orchestrator prompt, title, headings, space memory or box notice (all Claude's), pi's model and thinking level.
      const job = onEngine === 'pi' ? {
        chatKey, cwd, text: boxNotice.defuseSent(text), projectId: String(projectId || ''), workstream: String(workstream || 'main'),
        workstreamId: workstreamId != null ? String(workstreamId) : null,
        permissionMode: permissionModeFor(permissionMode),
        engine: 'pi',
        model: piModelArg(model),
        ...(piThinkingArg(effort) ? { effort: piThinkingArg(effort) } : {}),
      } : {
        // Sender text that opens with <termag-box-notice> is defused, so only a notice this runner inserts is ever stripped (box-notice.js).
        chatKey, cwd, text: boxNotice.defuseSent(text), projectId: String(projectId || ''), workstream: String(workstream || 'main'),
        workstreamId: workstreamId != null ? String(workstreamId) : null,
        // The project's name, for the turn's telemetry resource (chatTelemetryEnv); an older orchestrator sends none.
        ...(typeof project === 'string' && project ? { project } : {}),
        permissionMode: permissionModeFor(permissionMode),
        // An ask's run may be a live turn (ask-steer-v1), which takes later asks on its thread through
        // steerAsk; a person's message in an ask's chat never goes live, and nothing enters a running ask turn as a send.
        ...(liveInput === true && (!askJob || askJob.runId) ? { liveInput: true } : {}),
        ...(askJob ? { ask: askJob } : {}),
        ...(orchestrator === true && !askJob ? { orchestrator: true } : {}),
        // simple-ui-session-titles-enabled: the turn-end carries Claude's title for the session.
        ...(titles === true && !askJob ? { titles: true } : {}),
        // The send's `headings` (the orchestrator sets it on every person's message): each run of tool calls gets Haiku's heading, asked as it starts (tool-group-headings.js).
        ...(headings === true && !askJob ? { headings: true } : {}),
        // chat-plan-spend-enabled: after the answer, the seat's monthly spend (claude-plan-usage.js).
        // Not on another backend: that turn's usage never moves the claude.ai seat's spend.
        ...(planSpend === true && !askJob && !onBackend ? { planSpend: true } : {}),
        model: onBackend ? onBackend.model : claudeModelArg(model),
        ...(onBackend ? { backend: onBackend } : {}),
        // An ask's turn and a turn on another backend run at Claude Code's default effort.
        ...(!askJob && !onBackend && claudeEffortArg(effort) ? { effort: claudeEffortArg(effort) } : {}),
        // Generative UI's prompt, for a person's chat on Claude's own models (the orchestrator checked its flag).
        ...(!askJob && !onBackend && genUiPromptOf(genUiPrompt) ? { genUiPrompt: genUiPromptOf(genUiPrompt) } : {}),
        ...(!askJob && !onBackend && genUiPromptOf(genUiPrompt) && genUiHintOf(genUiHint) ? { genUiHint: genUiHintOf(genUiHint) } : {}),
        ...(refs.length ? { images: refs } : {}),
        // chat-resume-new-box-enabled (box-notice.js): tell this turn what happened to the box.
        ...(boxNotices === true && !askJob ? { boxNotices: true } : {}),
        ...(sentNotice ? { notice: sentNotice } : {}),
        // The chat's own space, whose memory the turn loads, or null for none (backend services/chatSpace.ts);
        // nothing named (an older backend), the box's default.
        ...(memorySpace && (typeof memorySpace.space === 'string' || memorySpace.space === null) ? { spaceMemory: { space: memorySpace.space } } : {}),
      };
      const stopsAtSend = stopCount(chatKey);
      return oneSendAtATime(chatKey, async () => {
        if (clearing.has(chatKey)) throw new Error('chat-clearing: this chat is being stopped');
        if (stopCount(chatKey) !== stopsAtSend) throw new Error('chat-stopped: the chat was stopped before this message went in');
        await releaseT3(chatKey, job.workstream);
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
      lastClearAt.set(chatKey, now());
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
     * Clear the chat's context: the next turn starts a new Claude session
     * instead of resuming this one. The session is kept in `earlier`, so the
     * history still shows it, above a `context-cleared` line; the same line
     * goes out as a chat-event for every open view. Refused while anything
     * else owns the session: a turn running or starting, messages queued
     * (they were written for this context), or Open in full UI's claim. On
     * the send chain, so a send cannot start a turn on the old session
     * halfway through.
     */
    async resetContext(chatKey, { projectId, workstream, workstreamId } = {}) {
      await gate;
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      if (clearing.has(chatKey)) throw new Error('chat-clearing: this chat is being stopped');
      return oneSendAtATime(chatKey, async () => {
        await releaseT3(chatKey, workstream);
        if (starting.has(chatKey) || stillRunning(activeFor(chatKey))) throw new Error('chat-busy: a turn is running');
        if (readQueue(chatKey).length) throw new Error('chat-busy: messages are waiting to be sent');
        if (resumeHolds.has(chatKey) || paneBlocks(chatKey)) throw new Error('terminal-holds: the agent pane has this session');
        const state = readState(chatKey);
        if (!state.sessionId) return { reset: false };
        // The earlier sessions' history is read as Claude's; the backend offers no context actions on pi.
        if (state.engine === 'pi') throw new Error('engine-refused: a pi chat cannot clear its context yet');
        const at = new Date(now()).toISOString();
        ensureRoot();
        writeJson(earlierFile(chatKey), [...readEarlier(chatKey), { sessionId: state.sessionId, clearedAt: at }].slice(-EARLIER_SESSIONS_MAX));
        writeState(chatKey, { sessionId: null });
        log(`[CHAT] ${chatKey} context cleared (left ${state.sessionId.slice(0, 8)})`);
        emit({ chatKey, projectId: String(projectId || ''), workstream: String(workstream || 'main'), workstreamId: workstreamId != null ? String(workstreamId) : null }, null, null, { type: 'context-cleared', at });
        return { reset: true, at };
      });
    },

    /**
     * Undo the last clear: the session it left goes back as the chat's, so the
     * next turn resumes it, and the clear is kept in `<chat>.undone.json` so
     * the history marks its divider undone. Only until a turn has started a
     * new session (resume-gone): two sessions are never merged. Refused while
     * anything else owns the chat, as a clear is.
     */
    async resumePrevious(chatKey, { projectId, workstream, workstreamId } = {}) {
      await gate;
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      if (clearing.has(chatKey)) throw new Error('chat-clearing: this chat is being stopped');
      return oneSendAtATime(chatKey, async () => {
        await releaseT3(chatKey, workstream);
        if (starting.has(chatKey) || stillRunning(activeFor(chatKey))) throw new Error('chat-busy: a turn is running');
        if (readQueue(chatKey).length) throw new Error('chat-busy: messages are waiting to be sent');
        if (resumeHolds.has(chatKey) || paneBlocks(chatKey)) throw new Error('terminal-holds: the agent pane has this session');
        const earlier = readEarlier(chatKey);
        const last = earlier[earlier.length - 1];
        if (readState(chatKey).sessionId || !last) throw new Error('resume-gone: a message since the clear started a new session');
        const resumedAt = new Date(now()).toISOString();
        ensureRoot();
        writeJson(undoneFile(chatKey), [...readUndone(chatKey), { sessionId: last.sessionId, clearedAt: last.clearedAt, resumedAt }].slice(-UNDONE_MAX));
        writeJson(earlierFile(chatKey), earlier.slice(0, -1));
        writeState(chatKey, { sessionId: last.sessionId });
        log(`[CHAT] ${chatKey} context resumed (${last.sessionId.slice(0, 8)})`);
        emit({ chatKey, projectId: String(projectId || ''), workstream: String(workstream || 'main'), workstreamId: workstreamId != null ? String(workstreamId) : null }, null, null,
          { type: 'context-resumed', at: last.clearedAt, resumedAt, sessionId: last.sessionId });
        return { resumed: true, at: last.clearedAt, resumedAt, sessionId: last.sessionId };
      });
    },

    /**
     * Compact the chat's context: a turn of its own whose prompt is `/compact`,
     * which Claude Code runs headless as its own compaction of the resumed
     * session (a `compact_boundary` event, then a summary as the session's
     * next context). Never queued and never live: refused unless the chat is
     * idle with a session. Its turn-start says `compact`, so the browser
     * draws a divider instead of a bubble.
     */
    async compact({ chatKey, cwd, projectId, project, workstream, workstreamId, permissionMode, paneProbe, model, backend, fastModel, context, models }) {
      await gate;
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      if (clearing.has(chatKey)) throw new Error('chat-clearing: this chat is being stopped');
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be absolute');
      const onBackend = backendOf({ backend, model, fastModel, context, models });
      return oneSendAtATime(chatKey, async () => {
        await releaseT3(chatKey, workstream);
        if (paneProbe === 'claude' || paneProbe === 'shell' || paneProbe === 'other' || paneProbe === 'unknown') applyPane(chatKey, paneProbe);
        if (starting.has(chatKey) || stillRunning(activeFor(chatKey))) throw new Error('chat-busy: a turn is running');
        if (readQueue(chatKey).length) throw new Error('chat-busy: messages are waiting to be sent');
        if (resumeHolds.has(chatKey) || paneBlocks(chatKey)) throw new Error('terminal-holds: the agent pane has this session');
        const { sessionId, engine } = readState(chatKey);
        if (!sessionId) throw new Error('nothing-to-compact: this chat has no context yet');
        // `/compact` is Claude Code's: on a pi session it would start a new Claude session instead.
        if (engine === 'pi') throw new Error('engine-refused: a pi chat cannot compact');
        const job = {
          chatKey, cwd, text: COMPACT_PROMPT, compact: true,
          projectId: String(projectId || ''), workstream: String(workstream || 'main'),
          workstreamId: workstreamId != null ? String(workstreamId) : null,
          ...(typeof project === 'string' && project ? { project } : {}),
          permissionMode: permissionModeFor(permissionMode),
          model: onBackend ? onBackend.model : claudeModelArg(model),
          ...(onBackend ? { backend: onBackend } : {}),
        };
        return { compacting: true, turnId: await startTurn(job) };
      });
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
      const { sessionId, engine, t3 } = await fillT3Session(chatKey);
      const earlier = readEarlier(chatKey);
      const runningTurn = activeFor(chatKey);
      const live = stillRunning(runningTurn) ? runningTurn : null;
      // A turn that died still has to be replayed after exit is written, or a
      // reload replaces the error with the transcript and the notice is gone.
      // A turn that finished normally is the transcript alone.
      const replay = live || lostTurn(chatKey, runningTurn);
      const queued = readQueue(chatKey).length + (live ? waitingInbox(live).length : 0);
      const file = sessionId ? transcriptOf(engine, sessionId) : null;
      // The tail is whole lines, a line with large images shrunk to references before it counts.
      const prefix = Boolean(replay && file && Number.isInteger(replay.meta.transcriptBytes));
      const jsonl = file ? historyTail(file, {
        end: prefix ? replay.meta.transcriptBytes : Infinity,
        maxBytes: HISTORY_MAX_BYTES,
        shrink: e => images.stripEvent(chatKey, e),
      }) : '';
      let entries = (engine === 'pi' ? piHistoryEntries(jsonl, HISTORY_MAX_ENTRIES) : historyEntries(jsonl)).map(e => images.stripEvent(chatKey, e));
      let turn = null;
      if (replay) {
        if (!prefix && replay.meta.transcriptBytes === null && replay.meta.resumed === false) {
          // A session's first turn: Claude made the transcript for it, so
          // nothing in it is before the turn. Matching the prompt's words
          // could pick a later message that repeats them.
          entries = [];
        } else if (!prefix) {
          // An older agent's turn, with no offset: its prompt by its words, the last one.
          const ids = Array.isArray(replay.meta.images) ? replay.meta.images.map(r => r && r.id) : [];
          entries = entriesBeforeTurn(entries, replay.meta.text, ids);
        }
        turn = eventsFromLog(replay.dir, replay.meta.turnId, chatKey);
      }
      const undone = readUndone(chatKey);
      if (sessionId) entries = withUndone(entries, sessionId, undone);
      if (earlier.length) entries = [...earlierEntries(chatKey, earlier, HISTORY_MAX_BYTES - Buffer.byteLength(jsonl), undone), ...entries];
      entries = capHistory(entries);
      // liveInput: a message sent while the running turn runs goes into it (chat-live-v1).
      // starting: a turn whose checkout inspect has begun is running for a resume.
      return {
        sessionId, ...(engine === 'pi' ? { engine } : {}), running: Boolean(live) || starting.has(chatKey), liveInput: Boolean(live) && readsInput(live),
        queued, parked: parked.has(chatKey), entries, turn, turns: readTurns(chatKey),
        headings: toolGroupHeadings.readHeadings(headingsFile(chatKey)),
        // The desktop app's thread holds the session (claimT3): a send here takes it back first.
        ...(t3 ? { t3: { threadId: t3.threadId } } : {}),
      };
    },

    /**
     * The chat's session file from byte `from`, whole lines only, for the
     * orchestrator's copy. `from` counts only when
     * `sessionId` is still the chat's session; otherwise the read starts the
     * current session at 0. `shrunk` when the file is now shorter than `from`;
     * `missing` when it can't be found, which must not read as shrunk: the
     * orchestrator drops its copy of a shrunk session.
     */
    async transcriptRead(chatKey, { sessionId: asked = null, from = 0, maxBytes = TRANSCRIPT_READ_MAX } = {}) {
      await gate;
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      const { sessionId } = readState(chatKey);
      if (!isSessionId(sessionId)) return { sessionId: null };
      const start = asked === sessionId && Number.isSafeInteger(from) && from > 0 ? from : 0;
      const file = findTranscript(home, sessionId);
      if (!file) return { sessionId, from: start, size: 0, data: '', missing: true };
      const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, TRANSCRIPT_READ_MAX) : TRANSCRIPT_READ_MAX;
      const size = fs.statSync(file).size;
      if (start > size) return { sessionId, from: start, size, data: '', shrunk: true };
      const read = wholeLinesFrom(file, { start, maxBytes: limit });
      return { sessionId, from: start, size: read.size, data: read.data.toString('base64'), ...(read.skipped && { skipped: read.skipped }) };
    },

    /**
     * A subagent's own transcript (chat-subagents-v1): Claude Code's
     * `<session>/subagents/agent-<id>.jsonl` for one of this chat's sessions
     * (its current one, or one a clear left), under any slug
     * (findSubagentTranscript: a rename moves only the session's file), as history
     * entries, with what its `.meta.json` says. Only this chat's sessions,
     * and an id that is a name. `found: false` when none of them has it.
     */
    async subagentHistory(chatKey, agentId) {
      await gate;
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      if (!isAgentId(agentId)) throw new Error('bad agentId');
      const { sessionId } = readState(chatKey);
      const sessions = [sessionId, ...readEarlier(chatKey).map(e => e.sessionId).reverse()].filter(isSessionId);
      for (const sid of new Set(sessions)) {
        const sub = findSubagentTranscript(home, sid, agentId);
        if (!sub) continue;
        const dir = path.dirname(sub);
        const jsonl = historyTail(sub, { maxBytes: HISTORY_MAX_BYTES, shrink: e => images.stripEvent(chatKey, e) });
        const entries = historyEntries(jsonl, HISTORY_MAX_ENTRIES, { sidechain: true }).map(e => images.stripEvent(chatKey, e));
        const meta = readJson(path.join(dir, `agent-${agentId}.meta.json`), null);
        return {
          found: true, sessionId: sid, entries,
          ...(meta && typeof meta === 'object' && {
            meta: {
              ...(typeof meta.agentType === 'string' && { agentType: meta.agentType }),
              ...(typeof meta.description === 'string' && { description: meta.description }),
              ...(typeof meta.toolUseId === 'string' && { toolUseId: meta.toolUseId }),
              ...(typeof meta.finished === 'boolean' && { finished: meta.finished }),
            },
          }),
        };
      }
      return { found: false, entries: [] };
    },

    /**
     * Write a session the orchestrator stored onto this box
     * (chat-session-restore), so the chat's next turn
     * resumes it here. The JSONL comes in pieces from 0 into a partial file
     * beside where Claude Code keeps sessions for this cwd; the last piece
     * (`done`) moves it into place and makes it the chat's session, at this
     * boot. Only for a chat with no session of its own on this box and
     * nothing running or queued, on the same chain as sends. A restore asked
     * again once done answers done. A piece that is not where the partial
     * file ends is refused with the size it has (`expected`).
     */
    async restoreSession(chatKey, { sessionId, cwd, from, data, done } = {}) {
      await gate;
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      if (!isSessionId(sessionId)) throw new Error('bad sessionId');
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be absolute');
      if (!Number.isSafeInteger(from) || from < 0) throw new Error('bad offset');
      if (typeof data !== 'string') throw new Error('data must be base64');
      return oneSendAtATime(chatKey, async () => {
        const state = readState(chatKey);
        const placed = findTranscript(home, sessionId);
        if (state.sessionId === sessionId && placed) return { restored: true, sessionId, size: fs.statSync(placed).size };
        // The same session recorded but not in place is this restore cut off after recording it (below): it carries on.
        if (state.sessionId && state.sessionId !== sessionId) throw new Error('chat-has-session: this chat already has a session on this box');
        if (activeFor(chatKey) || starting.has(chatKey) || readQueue(chatKey).length) throw new Error('chat-busy: a turn is running or queued');
        if (placed) throw new Error('session-exists: that session is already on this box');
        const dir = path.join(home, '.claude/projects', slugForCwd(cwd));
        const part = path.join(dir, `.${sessionId}.jsonl.restore`);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        let size = 0;
        try { size = fs.statSync(part).size; } catch { /* nothing written yet */ }
        if (from !== 0 && from !== size) return { restored: false, expected: size };
        const piece = Buffer.from(data, 'base64');
        if (from === 0) fs.writeFileSync(part, piece, { mode: 0o600 });
        else fs.appendFileSync(part, piece);
        size = from + piece.length;
        if (done !== true) return { restored: false, size };
        // Recorded before it moves into place: a file in place with no chat recording it is another
        // chat's (session-exists above), so the other order would leave a restore cut off between the two
        // refused for good.
        // A stored session is Claude's transcript (findTranscript above).
        writeState(chatKey, { sessionId, cwd, engine: 'claude' });
        fs.renameSync(part, path.join(dir, `${sessionId}.jsonl`));
        const boot = bootNow();
        if (boot) writeJson(bootFile(chatKey), { boot });
        log(`[CHAT] ${chatKey}: restored session ${sessionId.slice(0, 8)} (${size} bytes)`);
        return { restored: true, sessionId, size };
      });
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
        // The desktop's thread gives the session up first, as for a send; while it runs a turn, so does this.
        try { await releaseT3(chatKey, opts.workstream); } catch { return { claimed: false, running: true }; }
        const { sessionId } = readState(chatKey);
        let line = null;
        // Set only when the launcher will cd there. Claude looks the session
        // up under that cwd's slug, so a rename has to move the transcript
        // first, the same way startTurn does. A launcher with no cwd does
        // not cd, and must not move the file.
        let rehomeTo = null;
        const onBackend = backendOf(opts);
        // A pi session has no resume in the pane yet: no line, so nothing is typed.
        if (sessionId && readState(chatKey).engine !== 'pi') {
          const cwd = typeof opts.cwd === 'string' && opts.cwd.trim() ? opts.cwd : null;
          let mode = UNTRUSTED_MODE;
          if (cwd) {
            let facts;
            try { facts = await inspectCheckout(cwd); }
            catch { facts = { repo: true, unreadable: true }; }
            mode = turnModeFor(opts.permissionMode, facts);
          }
          // A backend that is not ready refuses the claim with its reason, before anything is held.
          // The pane's resource: the chat's project and workstream, its kind left as the settings say (a pane).
          const settings = withTelemetry(onBackend ? await settingsFor(onBackend) : withDefaultModel(null, home), await telemetryFor({ project: opts.project, workstream: opts.workstream }));
          try {
            const launch = resumeLaunch({ home, chatKey, sessionId, mode, bin: bin(), cwd: cwd || undefined, backend: onBackend, settings, appendPrompt: memoryFor.frozenPromptFor(chatKey, sessionId) });
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

    /**
     * The desktop app's thread takes the session (POST /api/cli/v1/projects/:id/chat/claim):
     * refused while a runner turn runs, starts or waits in the queue, or the
     * agent pane holds it; otherwise held for the thread, and t3 adopts the
     * chat's session for it, importing the turns the thread doesn't have, so
     * its next turn resumes this session instead of forking it. A chat with
     * no session yet (one the desktop made) is only held: there is nothing to
     * adopt, and the thread's first turn makes the session (fillT3Session).
     * A refused adopt leaves the hold as it was. On the send chain, so no
     * runner turn starts between the checks and the hold.
     */
    async claimT3(chatKey, { threadId, workstream } = {}) {
      await gate;
      if (!isChatKey(chatKey)) throw new Error('bad chatKey');
      if (typeof threadId !== 'string' || !T3_THREAD_RE.test(threadId)) throw new Error('bad threadId');
      if (clearing.has(chatKey)) throw new Error('chat-clearing: this chat is being stopped');
      return oneSendAtATime(chatKey, async () => {
        const state = readState(chatKey);
        if (state.t3 && state.t3.threadId === threadId) return { claimed: true, sessionId: state.sessionId };
        if (starting.has(chatKey) || stillRunning(activeFor(chatKey)) || readQueue(chatKey).length) return { claimed: false, reason: 'chat-running' };
        if (resumeHolds.has(chatKey) || paneBlocks(chatKey)) return { claimed: false, reason: 'terminal-holds' };
        writeState(chatKey, { t3: { threadId, at: now() } });
        if (!state.sessionId) {
          emitHolder(chatKey, workstream, { holder: 't3', threadId, sessionId: null });
          return { claimed: true, sessionId: null };
        }
        let r;
        try { r = await t3s.adopt({ threadId, sessionId: state.sessionId }); } catch { r = { result: 'offline' }; }
        if (r && r.result === 'adopted') {
          log(`[CHAT] ${chatKey} held by desktop thread ${threadId}`);
          emitHolder(chatKey, workstream, { holder: 't3', threadId, sessionId: state.sessionId });
          return { claimed: true, sessionId: state.sessionId };
        }
        writeState(chatKey, { t3: state.t3 ? { threadId: state.t3.threadId, at: now() } : null });
        return { claimed: false, reason: (r && T3_ADOPT_REFUSALS[r.result]) || 't3-offline' };
      });
    },
  };
}

module.exports = {
  CAPABILITIES,
  READ_ONLY_TOOLS,
  capHistory,
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
  ownTreeRefusal,
  STARTUP_CONFIG_PATHS,
  readOnlyFix,
  readOnlyNotice,
  githubSlug,
  isPullRef,
  readCheckoutFacts,
  prepareChatConfigDir,
  claudeOnGateway,
  claudeLaunchArg,
  rehomeTranscript,
  resolveClaude,
  slugForCwd,
  splitLines,
  turnArgs,
  turnSessionEnv,
  appendedSystemPrompt,
  genUiReference,
  permissionArgs,
  backendOf,
  backendSettings,
  checkEngine,
  engineOf,
  piLauncherReady,
  piModelArg,
  piThinkingArg,
  piTurnArgs,
  resolvePi,
  PI_READ_ONLY_TOOLS,
  chatTelemetryEnv,
  askTelemetryOf,
  withTelemetry,
  withDefaultModel,
  resumeLaunch,
  confinedResumeLine,
  parseTurnRecords,
  turnCost,
  turnEnv,
  toolchainDirs,
  EMPTY_MCP_CONFIG,
  askEnv,
  askOfJob,
  turnRecord,
  turnSessionName, AUTO_MODE, isOpenMode, loadsCheckoutConfig, turnModeFor,
  userPromptUuid,
  PANE_START_GRACE_MS, nextPaneClaim,
};
