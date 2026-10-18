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
import { getAllStatuses, getStatus, notifyStatusChange, setStatus } from './status';
import { parseStatusKey } from './statusKey';
import * as tmux from './tmux';

export const CHAT_RUNNER_CAPABILITY = 'chat-runner-v1';
export const CHAT_STATUS_SOURCE = 'chat-runner';
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

/** The message a chat may send, or the reason it may not. */
export function chatTextError(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim()) return 'text is required';
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
  if (/^chat-clearing\b/.test(message)) return { status: 409, body: { error: 'This chat is being stopped; nothing more can be sent to it', code: 'chat-clearing' } };
  return { status: 502, body: { error: message } };
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

/** "Bash(npm test)", "Read(src/app.ts)": a tool call in a few words, for the status message. */
export function toolCallLabel(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const arg = [i.command, i.file_path, i.path, i.pattern, i.url, i.description]
    .find((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (!arg) return name;
  const short = arg.replace(/\s+/g, ' ').trim();
  return `${name}(${short.length > 60 ? `${short.slice(0, 59)}…` : short})`;
}

/**
 * The status the agent session takes for one chat event, or null for an
 * event that does not move it: a turn is `working` from its start (naming
 * the tool it runs, as the hooks do) until it ends.
 */
export function statusForChatEvent(event: unknown): { status: 'working' | 'idle'; message?: string } | null {
  if (!event || typeof event !== 'object') return null;
  const ev = event as { type?: unknown; message?: { content?: unknown } };
  switch (ev.type) {
    case 'turn-start':
      return { status: 'working', message: 'Thinking' };
    case 'assistant': {
      const blocks = Array.isArray(ev.message?.content) ? ev.message!.content as Block[] : [];
      const tool = blocks.find(b => b?.type === 'tool_use' && typeof b.name === 'string');
      return tool ? { status: 'working', message: toolCallLabel(tool.name as string, tool.input) } : null;
    }
    case 'turn-end':
      return { status: 'idle' };
    default:
      return null;
  }
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

/** Return a `chat-runner` session that is stuck `working` to idle. */
export function reconcileChatStatus(sessionName: string, instanceId: string | null): void {
  const st = getStatus(sessionName, instanceId);
  if (st.source === CHAT_STATUS_SOURCE && st.status === 'working') {
    setStatus(sessionName, 'idle', { source: CHAT_STATUS_SOURCE }, undefined, instanceId);
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
    setStatus(session, 'idle', { source: CHAT_STATUS_SOURCE }, undefined, instanceId);
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
  const next = statusForChatEvent(msg.event);
  if (next) {
    setStatus(sessionName, next.status, { source: CHAT_STATUS_SOURCE, message: next.message }, undefined, instance.id);
    notifyStatusChange(sessionName, instance.id);
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
