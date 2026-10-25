/**
 * The simple UI's chat runner, orchestrator side (agent/chat-runner.js is the
 * box side). A chat is one project workstream whose provider runs in the
 * runner (`chatRunner` in the provider registry). Messages go to the box as
 * `chat-send`; every event Claude prints comes back as a `chat-event` frame,
 * which this module checks against the box it came from, turns into the
 * agent session's status (so the sidebar, inbox and working time see chat
 * turns like pane turns) and hands to index.ts for the status WebSocket.
 */
import { prisma } from '../db';
import { onBoxAgentFrame } from './agentRegistry';
import { classifyForeground } from './foregroundProbe';
import { getAllStatuses, getStatus, notifyStatusChange, setStatus } from './status';
import { parseStatusKey, statusKey } from './statusKey';
import { settleTurnPost } from './sessionTurns';
import { TRUSTED_MODE, UNTRUSTED_MODE } from './chatTrust';
import { pushOnChatTurn } from './chatTurnPush';
import * as tmux from './tmux';

export const CHAT_RUNNER_CAPABILITY = 'chat-runner-v1';
/** The runner understands a trusted turn. chat-runner-v1 alone refuses any mode but dontAsk. */
export const CHAT_TRUST_CAPABILITY = 'chat-trust-v1';
/** The runner takes a message into the turn running (agent/chat-turn.js); without it a send queues. */
export const CHAT_LIVE_CAPABILITY = 'chat-live-v1';
export const CHAT_LIVE_INPUT_FLAG = 'chat-live-input-enabled';
/** A send asks the runner for Claude's title for the session on each turn-end. */
export const SESSION_TITLES_FLAG = 'simple-ui-session-titles-enabled';
/** chat-interrupt takes scope 'turn': a live turn's Stop ends only Claude's current work and its background commands keep running. */
export const CHAT_INTERRUPT_CAPABILITY = 'chat-interrupt-v1';
export const CHAT_STATUS_SOURCE = 'chat-runner';
/**
 * The runner accepts `auto` (Claude Code's auto permission mode): a normal
 * session whose classifier judges each tool call and denies instead of
 * asking. Scheduled automation runs need it; an older runner answers mode-refused, which the scheduler reads as
 * runner_outdated rather than quietly downgrading.
 */
export const CHAT_AUTO_CAPABILITY = 'chat-auto-v1';
/** The runner appends the orchestrator system prompt to a send marked `orchestrator` (agent/chat-runner.js). */
export const CHAT_ORCHESTRATOR_CAPABILITY = 'chat-orchestrator-v1';
/**
 * The runner starts a turn, and a resume, on the model backend a send or claim
 * names (`backend`, with `fastModel` and `context`). An
 * older runner would drop the backend and run the model on the default, so a
 * chat on another backend is refused there instead.
 */
export const CHAT_BACKEND_CAPABILITY = 'chat-backend-v1';

/** Where a chat's turns run (Workflow.backend), and Fireworks' fast model and window. Absent = the default backend. */
export interface ChatBackend {
  backend?: string | null;
  fastModel?: string;
  context?: number;
}

function backendFields(t: ChatBackend): Record<string, unknown> {
  if (!t.backend) return {};
  return { backend: t.backend, ...(t.fastModel ? { fastModel: t.fastModel } : {}), ...(t.context ? { context: t.context } : {}) };
}
export const AUTO_MODE = 'auto';
export const MAX_CHAT_TEXT = 100_000;

const WORKSTREAM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WORKSTREAM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The box-side name of a chat: a flat file name (agent/chat-runner.js
 * isChatKey). Keyed by the workstream id, not its name, so the chat (its
 * session id and history) survives a workstream rename.
 */
export function chatKeyFor(projectId: string, workstreamId: string): string {
  return `${projectId}--${workstreamId}`;
}

/**
 * Why a chat request cannot be served, as the route's answer, or null when it
 * can. A null `instanceId` is refused: the simple UI always runs a chat on its
 * own box, and the status fan-out only dispatches a box's `chat-event` frames,
 * so a box-less chat would accept a send and then drop every event.
 */
export function chatTargetError(target: {
  isChatProvider: boolean;
  instanceId: string | null;
  setupStatus: string;
  connected: boolean;
  capabilities: readonly string[];
}): { status: number; body: { error: string; code?: string } } | null {
  if (!target.isChatProvider) {
    return { status: 409, body: { error: 'This project runs its agent in a terminal, not in the chat runner', code: 'not-a-chat' } };
  }
  if (target.instanceId == null) {
    return { status: 409, body: { error: 'A chat needs its own box; this project has none', code: 'no-box' } };
  }
  if (target.setupStatus !== 'none' && target.setupStatus !== 'ready') {
    return { status: 409, body: { error: 'The project is still being set up', code: 'setup' } };
  }
  if (!target.connected) return { status: 503, body: { error: "The box's agent is offline", code: 'offline' } };
  if (!target.capabilities.includes(CHAT_RUNNER_CAPABILITY)) {
    return { status: 409, body: { error: "The box's agent predates the chat runner; it needs an update and a restart", code: 'runner-missing' } };
  }
  return null;
}

/**
 * Whether a chat's first turn must wait for a checkout. Keyed off the repo
 * still being set: start-empty clears `repoUrl` (services/projectClone.ts), so
 * a chat that was started without its repository is not gated forever on a
 * commit that will never land.
 */
export function chatRequireCheckout(project: { repoUrl: string | null }): boolean {
  return project.repoUrl != null;
}

/** The message a chat may send, or the reason it may not. With images, the text may be empty (services/chatImages.ts). */
export function chatTextError(text: unknown, hasImages = false): string | null {
  if (typeof text !== 'string' || (!text.trim() && !hasImages)) return 'text is required';
  if (text.length > MAX_CHAT_TEXT) return `text is longer than ${MAX_CHAT_TEXT} characters`;
  return null;
}

/**
 * A chat RPC's error as the route's answer: an agent without the runner, a
 * first turn refused because the repository is still being checked out (a
 * pane clone runs after setup reports done), or anything else as a 502.
 */
export function chatRpcFailure(message: string): { status: number; body: { error: string; code?: string } } {
  if (/Unknown command/.test(message)) return { status: 409, body: { error: "The box's agent predates the chat runner; restart it", code: 'runner-missing' } };
  if (/^checkout-pending\b/.test(message)) return { status: 409, body: { error: 'The repository is still being checked out; the message is sent when it is there', code: 'checkout-pending' } };
  if (/^queue-full\b/.test(message)) return { status: 429, body: { error: 'Too many messages are already waiting; let the current ones finish', code: 'queue-full' } };
  if (/^chat-stopped\b/.test(message)) return { status: 409, body: { error: 'The chat was stopped before this message went in; send it again', code: 'chat-stopped' } };
  if (/^chat-clearing\b/.test(message)) return { status: 409, body: { error: 'This chat is being stopped; nothing more can be sent to it', code: 'chat-clearing' } };
  if (/^image-refused\b/.test(message)) return { status: 400, body: { error: message.replace(/^image-refused:\s*/, ''), code: 'bad-image' } };
  if (/^mode-refused\b/.test(message)) {
    return { status: 409, body: { error: "This box's chat runner cannot run a trusted turn yet; it needs an update and a restart", code: 'mode-refused' } };
  }
  return { status: 502, body: { error: message } };
}

const SESSION_ID_RE = /^[A-Za-z0-9-]{8,80}$/;

/** What Open in full UI types into the agent pane to continue a chat's session, or null for no valid id. */
export function resumeCommandFor(sessionId: unknown): string | null {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) ? `claude --resume ${sessionId}` : null;
}

/**
 * Whether the agent pane's foreground command is a Claude, which then holds
 * the chat's session: a message from the chat would start a second writer.
 * Other foreground programs (a dev server, an editor) do not hold it.
 */
export function terminalHoldsChat(cmd: unknown): boolean {
  if (typeof cmd !== 'string' || !cmd.trim()) return false;
  return /(^|[\s/])claude(\s|$)/.test(cmd.trim());
}

/**
 * What a foreground probe means for a parked queue (agent/chat-runner.js
 * nextPaneClaim). `unknown` is a miss: failed, timed out, or still empty.
 * Only `shell` is Claude having left a pane that was seen holding it.
 */
export type PaneProbe = 'claude' | 'shell' | 'other' | 'unknown';

export function paneProbeKind(cmd: string | null): PaneProbe {
  if (typeof cmd !== 'string' || !cmd.trim()) return 'unknown';
  if (terminalHoldsChat(cmd)) return 'claude';
  if (isIdleShell(cmd)) return 'shell';
  return 'other';
}

/**
 * A foreground probe. `dead` is tmux's pane_dead: the process has exited and
 * the command name can still be the program that left (a stale `claude`).
 */
export interface PaneForeground {
  cmd: string | null;
  dead: boolean;
}

/** Whether this probe is a live Claude. A dead pane's leftover command name is not. */
export function paneStillHolds(fg: PaneForeground | string | null | undefined): boolean {
  if (fg != null && typeof fg === 'object') {
    if (fg.dead) return false;
    return terminalHoldsChat(fg.cmd);
  }
  return terminalHoldsChat(fg);
}

/**
 * The probe kind to record. A dead pane is a shell for the claim: Claude has
 * left, so a stale `seen` clears and a send may start. It is not a miss.
 */
export function probeFromForeground(fg: PaneForeground | string | null | undefined): PaneProbe {
  if (fg != null && typeof fg === 'object' && fg.dead) return 'shell';
  const cmd = fg == null || typeof fg === 'string' ? (fg ?? null) : fg.cmd;
  return paneProbeKind(cmd);
}

/**
 * What GET /chat reports for the simple UI's hold notice. `true` when a live
 * Claude is the foreground. `false` only when a shell (or a dead pane) proves
 * Claude has left, so the notice and a stuck refusal can clear. A miss
 * (`unknown`) or another program is omitted: a failed probe is not proof
 * Claude left, and clearing the notice would make Send look free while the
 * claim still queues the message.
 */
export function historyTerminalHolds(fg: PaneForeground | string | null | undefined): boolean | undefined {
  if (paneStillHolds(fg)) return true;
  if (probeFromForeground(fg) === 'shell') return false;
  return undefined;
}

/**
 * Foreground names tmux reports for an idle shell (`pane_current_command` is
 * the process name; a login shell is `-zsh`). Anything else — vim, ssh, npm —
 * is a program the keys would land in, so Open in full UI leaves it alone.
 */
const IDLE_SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'ash']);

function foregroundBase(cmd: string): string {
  const token = cmd.trim().split(/\s+/)[0] ?? '';
  const base = (token.split('/').pop() ?? token).replace(/^-+/, '');
  return base.toLowerCase();
}

/** Whether the pane's foreground is an idle shell, the only place a resume may be typed. */
export function isIdleShell(cmd: string): boolean {
  return IDLE_SHELLS.has(foregroundBase(cmd));
}

/**
 * Whether Open in full UI may type `claude --resume` into the agent pane,
 * given its foreground command (`tmux-foreground-cmd`). Only an idle shell
 * gets the keys. A running agent, a busy pane, any other program, or an
 * unreadable probe (null/empty — unknown, not idle) is left alone, so a
 * keystroke never lands in vim, node, another agent, or a Claude the user is in.
 */
export function resumeDecision(fg: string | null): 'type' | 'claude-open' | 'pane-busy' | 'pane-unknown' {
  if (typeof fg !== 'string' || !fg.trim()) return 'pane-unknown';
  if (terminalHoldsChat(fg)) return 'claude-open';
  const cls = classifyForeground(fg);
  if (cls === 'running' || cls === 'busy') return 'pane-busy';
  return isIdleShell(fg) ? 'type' : 'pane-busy';
}

/**
 * The mode chat-send may name. bypassPermissions only when the agent
 * advertises chat-trust-v1. A runner that only has chat-runner-v1 treats
 * any other mode as mode-refused and starts nothing, so a trusted project
 * on that box stays dontAsk and the send still goes through.
 */
export function permissionModeForAgent(mode: string, capabilities: readonly string[]): string {
  if (mode === TRUSTED_MODE && !capabilities.includes(CHAT_TRUST_CAPABILITY)) return UNTRUSTED_MODE;
  if (mode === AUTO_MODE && !capabilities.includes(CHAT_AUTO_CAPABILITY)) return UNTRUSTED_MODE;
  return mode;
}

/** One chat event as the relay saw it, for listeners that follow a chat's turns (services/automations/complete.ts). */
export interface ChatEventSeen {
  projectId: string;
  workstream: string;
  workstreamId: string;
  instanceId: string;
  turnId: string | null;
  event: unknown;
}

type ChatEventListener = (seen: ChatEventSeen) => void;
const eventListeners = new Set<ChatEventListener>();

/**
 * Hear every chat event the relay accepts (after its box check), in arrival
 * order per project. A listener that throws is logged and dropped for that
 * event only. Returns the unsubscribe.
 */
export function onChatEvent(listener: ChatEventListener): () => void {
  eventListeners.add(listener);
  return () => { eventListeners.delete(listener); };
}

/**
 * What chat-send carries to the box. The permission mode is the backend's
 * decision from the project's trust (services/chatTrust.ts), held back to
 * dontAsk unless this agent advertises chat-trust-v1. Nothing in the
 * request body reaches it.
 */
/**
 * What chat-resume-claim carries. The permission mode is the same ceiling
 * chat-send uses (held back without chat-trust-v1 / chat-auto-v1). The box
 * applies turnModeFor to it. The browser does not choose the mode, and the
 * session id stays on the box.
 */
export function chatResumeClaimPayload(
  target: { chatKey: string; cwd: string; permissionMode: string; model?: string | null } & ChatBackend,
  capabilities: readonly string[] = [],
): Record<string, unknown> {
  return {
    chatKey: target.chatKey,
    cwd: target.cwd,
    permissionMode: permissionModeForAgent(target.permissionMode, capabilities),
    // The chat's backend, so Open in full UI continues there; its model with it.
    ...(target.backend && target.model ? { model: target.model, ...backendFields(target) } : {}),
  };
}

export function chatSendRpcPayload(
  target: { chatKey: string; cwd: string; projectId: string; workstream: string; workstreamId: string; requireCheckout: boolean; permissionMode: string; model?: string | null; orchestrator?: boolean } & ChatBackend,
  text: string,
  capabilities: readonly string[] = [],
  opts: { liveInput?: boolean; images?: ReadonlyArray<{ mediaType: string; data: string }>; titles?: boolean } = {},
): Record<string, unknown> {
  return {
    chatKey: target.chatKey, cwd: target.cwd, text, projectId: target.projectId,
    workstream: target.workstream, workstreamId: target.workstreamId,
    requireCheckout: target.requireCheckout,
    permissionMode: permissionModeForAgent(target.permissionMode, capabilities),
    // chat-live-input-enabled, to an agent that can take it: the turn this
    // send starts, or the live one running, takes the message in as it runs.
    ...(chatSendsLive(capabilities, opts.liveInput) ? { liveInput: true } : {}),
    // Always a concrete tier (or its pinned profile id), already the launch
    // string (services/claudeChatModel.ts); the runner drops anything else.
    ...(target.model ? { model: target.model } : {}),
    // Another backend's model is only that backend's; the caller checked chat-backend-v1.
    ...backendFields(target),
    // New session's "Act as an orchestrator". An older runner would drop it anyway.
    ...(target.orchestrator && capabilities.includes(CHAT_ORCHESTRATOR_CAPABILITY) ? { orchestrator: true } : {}),
    // Already checked against chat-image-input-enabled and chat-images-v1 (services/chatImages.ts).
    ...(opts.images?.length ? { images: opts.images } : {}),
    // simple-ui-session-titles-enabled. An older runner drops it, and its turn-ends carry no title.
    ...(opts.titles ? { titles: true } : {}),
  };
}

export type ChatStopScope = 'turn' | 'all';

/** The stop a request asks for: only `turn` stops less than everything. */
export function chatStopScope(raw: unknown): ChatStopScope {
  return raw === 'turn' ? 'turn' : 'all';
}

/** Whether this agent can stop only a live turn's current work. */
export function chatStopsTurn(capabilities: readonly string[]): boolean {
  return capabilities.includes(CHAT_INTERRUPT_CAPABILITY);
}

/** The chat-interrupt RPC: a turn-only stop goes only to an agent that knows it; any other is the whole stop. */
export function chatInterruptRpcPayload(chatKey: string, capabilities: readonly string[], scope: ChatStopScope): { chatKey: string; scope?: 'turn' } {
  return { chatKey, ...(scope === 'turn' && chatStopsTurn(capabilities) ? { scope: 'turn' as const } : {}) };
}

/** Whether a send from this person can go into a running live turn: their chat-live-input-enabled, on an agent with chat-live-v1. */
export function chatSendsLive(capabilities: readonly string[], liveInputFlag: boolean | undefined): boolean {
  return liveInputFlag === true && capabilities.includes(CHAT_LIVE_CAPABILITY);
}

export type ChatClearResult =
  | { workstream: string; cleared: number; stopped: boolean }
  | { workstream: string; skipped: 'runner-missing' | 'offline' }
  | { workstream: string; error: string };

/**
 * Drop every queued message and stop the running turn of a project's chats
 * on its box (the agent's chat-clear), for a chat being archived or deleted:
 * nothing it left behind may run later. `send` is sendForProject bound to
 * the project's host. An agent without the RPC, or one offline, is reported,
 * not thrown: its box parks any queue it finds after a restart anyway, and
 * only a live chat resumes one.
 */
export async function clearChatsOnBox(
  send: (type: string, payload: Record<string, unknown>) => Promise<unknown>,
  projectId: string,
  workstreams: readonly string[],
): Promise<ChatClearResult[]> {
  const out: ChatClearResult[] = [];
  for (const workstream of workstreams) {
    try {
      const r = (await send('chat-clear', { chatKey: chatKeyFor(projectId, workstream) })) as { cleared?: number; stopped?: boolean } | null;
      out.push({ workstream, cleared: Number(r?.cleared) || 0, stopped: Boolean(r?.stopped) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Unknown command/.test(message)) out.push({ workstream, skipped: 'runner-missing' });
      else if (/not connected|offline/i.test(message)) out.push({ workstream, skipped: 'offline' });
      else out.push({ workstream, error: message });
    }
  }
  return out;
}

type Block = { type?: unknown; name?: unknown; input?: unknown };

const THINKING = 'Thinking';
const PREVIEW_MAX = 120;

/** The first non-empty line of an assistant message's text, for a list preview. */
function assistantPreview(blocks: readonly Block[]): string | null {
  for (const b of blocks) {
    if (b?.type !== 'text' || typeof (b as { text?: unknown }).text !== 'string') continue;
    const line = ((b as { text: string }).text.split('\n').find(l => l.trim() !== '') ?? '').replace(/\s+/g, ' ').trim();
    if (line) return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX - 1)}…` : line;
  }
  return null;
}

/**
 * The status the agent session takes for one chat event, or null for an
 * event that does not move it: a turn is `working` from its start until
 * Claude answers (`result`) or the turn ends. A live turn (agent
 * chat-live-v1) stays open after an answer while a background task runs,
 * and is `working` again when it takes in another message (its replayed
 * `user` line) or a task's notification sets it going (`assistant`). The
 * message is what lists preview, so it is the last thing Claude said
 * (`prevMessage` carries it across tool calls and the turn end), never a
 * tool call's arguments.
 */
export function statusForChatEvent(event: unknown, prevMessage?: string): { status: 'working' | 'idle'; message?: string } | null {
  if (!event || typeof event !== 'object') return null;
  const ev = event as { type?: unknown; isReplay?: unknown; message?: { content?: unknown } };
  const kept = prevMessage && prevMessage !== THINKING ? prevMessage : undefined;
  switch (ev.type) {
    case 'turn-start':
      return { status: 'working', message: THINKING };
    case 'assistant': {
      const blocks = Array.isArray(ev.message?.content) ? ev.message!.content as Block[] : [];
      const text = assistantPreview(blocks);
      if (text) return { status: 'working', message: text };
      const tool = blocks.some(b => b?.type === 'tool_use' && typeof b.name === 'string');
      return tool ? { status: 'working', message: prevMessage || THINKING } : null;
    }
    case 'user':
      return ev.isReplay === true && typeof ev.message?.content === 'string' ? { status: 'working', message: THINKING } : null;
    case 'result':
    case 'turn-end':
      return kept ? { status: 'idle', message: kept } : { status: 'idle' };
    default:
      return null;
  }
}

/** The longest session title the sidebar keeps; Claude's own are a few words. */
export const SESSION_TITLE_MAX = 80;

/**
 * The title a chat event reports for its session: a turn-end's `title`
 * (agent/session-title.js), on one line, without control or direction
 * characters, cut to SESSION_TITLE_MAX. Null for any other event or a blank.
 */
export function sessionTitleOf(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const ev = event as { type?: unknown; title?: unknown };
  if (ev.type !== 'turn-end' || typeof ev.title !== 'string') return null;
  const line = ev.title
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!line) return null;
  const chars = Array.from(line);
  return chars.length > SESSION_TITLE_MAX ? `${chars.slice(0, SESSION_TITLE_MAX - 1).join('')}…` : line;
}

/**
 * Keep a chat's session title on its workstream, where the project list (and
 * so the sidebar) reads it. Only a change writes: Claude reports the same
 * title every turn, and an unchanged one costs no list push
 * (services/workspaceWrites.ts watches the field).
 */
export async function saveSessionTitle(projectId: string, workstreamId: string, title: string): Promise<void> {
  await prisma.workstream.updateMany({
    where: { id: workstreamId, projectId, OR: [{ sessionTitle: null }, { sessionTitle: { not: title } }] },
    data: { sessionTitle: title },
  });
}

export interface ChatPush {
  /** The agent session the chat belongs to. */
  sessionName: string;
  /** The project owner's unix username: the only identity chat delivery is authorized by. */
  owner: string;
  instanceId: string;
  /** `seq`: the event's line in its turn's log, from 1 (a durable runner); null from an older agent. */
  payload: { type: 'chat'; projectId: string; workstream: string; turnId: string | null; seq: number | null; event: unknown };
}

type Pusher = (push: ChatPush) => void;
let pusher: Pusher | null = null;

/**
 * Whether a status client may receive a chat's frames, which carry prompts
 * and file contents: the project's owner, or a user this very project is
 * shared with. A share of another project of the same owner's is not enough.
 *
 * Both `owner` and `unixUsername` are raw unix usernames, so they are compared
 * raw — never through `tmuxSafeName`, which folds `.` and `:` to `_` and would
 * let `jane_doe` receive `jane.doe`'s chats.
 */
export function mayReceiveChat(
  chat: { owner: string; projectId: string },
  viewer: { unixUsername: string; sharedProjectIds: ReadonlySet<string> },
): boolean {
  return viewer.unixUsername === chat.owner || viewer.sharedProjectIds.has(chat.projectId);
}

/** index.ts sets this to push `{type: 'chat'}` to the status WebSocket clients that may see the session. */
export function setChatPushCallback(fn: Pusher | null): void {
  pusher = fn;
}

// project id -> what a frame needs, briefly: a turn sends hundreds of frames.
const projectCache = new Map<string, { at: number; value: { name: string; owner: string; instanceId: string | null } | null }>();
const PROJECT_CACHE_MS = 30_000;

async function projectFor(projectId: string): Promise<{ name: string; owner: string; instanceId: string | null } | null> {
  const hit = projectCache.get(projectId);
  if (hit && Date.now() - hit.at < PROJECT_CACHE_MS) return hit.value;
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, instanceId: true, archived: true, user: { select: { unixUsername: true } } },
  });
  const value = row && !row.archived ? { name: row.name, owner: row.user.unixUsername, instanceId: row.instanceId } : null;
  projectCache.set(projectId, { at: Date.now(), value });
  return value;
}

/**
 * The project as `projectFor`, but a cached row whose box is not the one the
 * frame came from is re-read once: right after a project is re-pointed to a
 * new box the 30s cache would otherwise drop the new box's frames.
 */
async function projectForBox(projectId: string, instanceId: string): Promise<{ name: string; owner: string; instanceId: string | null } | null> {
  let project = await projectFor(projectId);
  if (project && project.instanceId !== instanceId) {
    projectCache.delete(projectId);
    project = await projectFor(projectId);
  }
  return project;
}

/**
 * Write the chat runner's own status for its session. A desktop thread in the
 * same checkout posts to the same key, so it goes through the turn rule like
 * any post (services/sessionTurns.ts); elsewhere it is written as it is.
 */
function writeChatStatus(sessionName: string, instanceId: string | null, status: 'working' | 'idle', message?: string): void {
  const effective = settleTurnPost(statusKey(instanceId, sessionName), { status, source: CHAT_STATUS_SOURCE, message });
  setStatus(sessionName, effective.status, {
    source: effective.source, message: effective.message,
    ...(effective.waitingReason !== undefined ? { waitingReason: effective.waitingReason } : {}),
  }, undefined, instanceId);
}

/** Return a `chat-runner` session that is stuck `working` to idle. */
export function reconcileChatStatus(sessionName: string, instanceId: string | null): void {
  const st = getStatus(sessionName, instanceId);
  if (st.source === CHAT_STATUS_SOURCE && st.status === 'working') {
    writeChatStatus(sessionName, instanceId, 'idle');
    notifyStatusChange(sessionName, instanceId);
  }
}

// A chat turn streams frames continuously (partial-message deltas, tool
// events), so this much silence from a `working` chat means the box dropped
// its socket or the agent died mid-turn, not a slow turn.
const CHAT_STALE_MS = 120_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Flip to idle any `chat-runner` session left `working` past CHAT_STALE_MS. */
export function sweepStaleChatStatus(now: number = Date.now()): number {
  let swept = 0;
  for (const [key, st] of getAllStatuses()) {
    if (st.source !== CHAT_STATUS_SOURCE || st.status !== 'working') continue;
    if (now - new Date(st.updatedAt).getTime() <= CHAT_STALE_MS) continue;
    const { instanceId, session } = parseStatusKey(key);
    writeChatStatus(session, instanceId, 'idle');
    notifyStatusChange(session, instanceId);
    swept++;
  }
  return swept;
}

/** Leader-only: the stale-chat-status sweep. The turn-end frame is the normal path. */
export function startChatStatusSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    try { sweepStaleChatStatus(); } catch (err) { console.error('[CHAT] status sweep failed:', err instanceof Error ? err.message : String(err)); }
  }, 30_000);
  sweepTimer.unref?.();
}

export function stopChatStatusSweep(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

// Per-project serialization of chat-event handling. Each frame's project
// lookup is async, and two cache misses can resolve out of order, so without
// this a content_block_delta could be pushed before its content_block_start,
// or a turn-end before the next turn-start — reordering the browser sees as
// dropped words or a session stuck idle. Chaining per project keeps frames
// leaving in arrival order; different projects do not block each other.
const relayChains = new Map<string, Promise<void>>();

async function handleChatFrame(instance: { id: string }, msg: Record<string, unknown>, projectId: string, workstream: string): Promise<void> {
  const project = await projectForBox(projectId, instance.id);
  // Only the box the project lives on speaks for its chat.
  if (!project || project.instanceId !== instance.id) return;
  const sessionName = tmux.sessionName(project.owner, project.name, 'agent', workstream);
  const prev = getStatus(sessionName, instance.id);
  const next = statusForChatEvent(msg.event, prev.message);
  if (next) {
    writeChatStatus(sessionName, instance.id, next.status, next.message);
    notifyStatusChange(sessionName, instance.id);
    pushOnChatTurn({ projectId, workstream, session: sessionName, prev: prev.status, next: next.status, event: msg.event });
  }
  // The relay checked the workstream id against the chat key; the write checks it is this project's.
  const title = sessionTitleOf(msg.event);
  if (title && typeof msg.workstreamId === 'string' && msg.workstreamId) {
    void saveSessionTitle(projectId, msg.workstreamId, title).catch(err => {
      console.error('[CHAT] session title not saved:', err instanceof Error ? err.message : String(err));
    });
  }
  pusher?.({
    sessionName,
    owner: project.owner,
    instanceId: instance.id,
    payload: {
      type: 'chat', projectId, workstream,
      turnId: typeof msg.turnId === 'string' ? msg.turnId : null,
      seq: Number.isInteger(msg.seq) && (msg.seq as number) > 0 ? msg.seq as number : null,
      event: msg.event,
    },
  });
  if (eventListeners.size) {
    const seen: ChatEventSeen = {
      projectId, workstream, workstreamId: typeof msg.workstreamId === 'string' ? msg.workstreamId : '',
      instanceId: instance.id, turnId: typeof msg.turnId === 'string' ? msg.turnId : null, event: msg.event,
    };
    for (const l of eventListeners) {
      try { l(seen); } catch (err) { console.error('[CHAT] event listener failed:', err instanceof Error ? err.message : String(err)); }
    }
  }
}

/** Relay `chat-event` frames from box agents. Returns the unsubscribe. */
export function startChatRelay(): () => void {
  return onBoxAgentFrame('chat-event', ({ instance, msg }) => {
    const projectId = typeof msg.projectId === 'string' ? msg.projectId : '';
    const workstream = typeof msg.workstream === 'string' ? msg.workstream : 'main';
    const workstreamId = typeof msg.workstreamId === 'string' ? msg.workstreamId : '';
    if (!PROJECT_ID_RE.test(projectId) || !WORKSTREAM_RE.test(workstream) || !WORKSTREAM_ID_RE.test(workstreamId)) return;
    if (msg.chatKey !== chatKeyFor(projectId, workstreamId)) return;
    const prev = relayChains.get(projectId) ?? Promise.resolve();
    const task = prev.then(() => handleChatFrame(instance, msg, projectId, workstream)).catch(err => {
      console.error('[CHAT] relay failed:', err instanceof Error ? err.message : String(err));
    });
    relayChains.set(projectId, task);
    // Drop the chain once it has drained, so an idle project does not leak an entry.
    void task.finally(() => { if (relayChains.get(projectId) === task) relayChains.delete(projectId); });
  });
}
