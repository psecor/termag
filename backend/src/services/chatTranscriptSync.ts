/**
 * Keeps the orchestrator's copy of each chat's transcript up to date.
 * The box never pushes: at each turn end, and
 * once for every chat when a box connects (the backfill), the orchestrator
 * asks the box's runner for the chat's session file from the offset it has
 * stored (`chat-transcript-read`) and stores what comes back
 * (chatTranscriptStore.ts). A box that has moved on to a new session (a
 * cleared chat) answers from 0, and that session becomes the live one.
 *
 * Only for the box the project lives on, only for chat-runner chats (an
 * ask's thread is one too, agent/ask-chat.js: its tab shows the stored copy
 * while its box is down, like any chat's), only where the agent
 * advertises chat-transcript-v1, and only while chat-transcripts-enabled is
 * on for the project's owner. A failure is logged and the next turn end or
 * connect tries again; it never touches the turn.
 */

import { prisma } from '../db';
import { isChatRunnerProvider } from '../providers/registry';
import { instanceAgentTransport, onBoxAgentHello, sendToInstanceAgent } from './agentRegistry';
import { chatKeyFor, onChatEvent } from './chatRunner';
import { coalescePulls, forEachBounded, pullTranscript, type PullDeps } from './chatTranscriptPull';
import { appendChunk, getTranscriptStoreConfig, resetSession, transcriptHead, type TranscriptStoreConfig } from './chatTranscriptStore';
import { recordChatGitState } from './chatGitState';
import { boolVariation } from './featureFlags';
import type { FlagUser } from './featureFlags';

export const CHAT_TRANSCRIPTS_FLAG = 'chat-transcripts-enabled';
export const TRANSCRIPT_CAPABILITY = 'chat-transcript-v1';
const READ_BYTES = 4 * 1024 * 1024;
const READ_TIMEOUT_MS = 60_000;
// The connect backfill shares the box's socket and runner with the chat the
// person is opening (chat-history, send), so it reads a few chats at a time in
// smaller reads: a request from the live chat waits behind at most
// BACKFILL_CONCURRENCY × BACKFILL_READ_BYTES of it.
const BACKFILL_CONCURRENCY = 2;
const BACKFILL_READ_BYTES = 1024 * 1024;

interface Chat {
  instanceId: string;
  projectId: string;
  workstreamId: string;
}

/** Whether this chat's transcript is stored from this box: see the header. */
async function mayStore(chat: Chat): Promise<boolean> {
  const transport = instanceAgentTransport(chat.instanceId);
  if (!transport?.capabilities.includes(TRANSCRIPT_CAPABILITY)) return false;
  const ws = await prisma.workstream.findUnique({
    where: { id: chat.workstreamId },
    select: {
      projectId: true,
      workflows: { where: { type: 'agent' }, select: { provider: true } },
      project: {
        select: {
          instanceId: true,
          user: { select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true } },
        },
      },
    },
  });
  if (!ws || ws.projectId !== chat.projectId || ws.project.instanceId !== chat.instanceId) return false;
  if (!ws.workflows.some(w => isChatRunnerProvider(w.provider))) return false;
  return boolVariation(CHAT_TRANSCRIPTS_FLAG, ws.project.user, false);
}

function pullDeps(cfg: TranscriptStoreConfig, chat: Chat, readBytes: number): PullDeps {
  const { projectId, workstreamId, instanceId } = chat;
  const chatKey = chatKeyFor(projectId, workstreamId);
  return {
    head: () => transcriptHead(projectId, workstreamId),
    read: (sessionId, from) => sendToInstanceAgent(instanceId, 'chat-transcript-read', { chatKey, sessionId, from, maxBytes: readBytes }, READ_TIMEOUT_MS),
    // Only a runner that inserts notices (and defuses sender text that opens with the tag) has its leading notices stripped.
    append: (k, data, skipped) => appendChunk(cfg, { projectId, workstreamId, ...k }, data, skipped, {
      boxNotices: instanceAgentTransport(instanceId)?.capabilities.includes('chat-box-notice-v1') === true,
    }),
    reset: sessionId => resetSession(projectId, workstreamId, sessionId),
  };
}

// One pull per chat at a time. A turn end during a pull runs one more after it.
const running = new Map<string, { again: boolean }>();

/** Resolves when this pull is done, or at once when one for the chat is already running (it runs again). */
export function syncChatTranscript(chat: Chat, readBytes = READ_BYTES): Promise<void> {
  const cfg = getTranscriptStoreConfig();
  if (!cfg) return Promise.resolve();
  const key = chatKeyFor(chat.projectId, chat.workstreamId);
  return coalescePulls(running, key, async () => {
    if (!await mayStore(chat)) return false;
    await pullTranscript(pullDeps(cfg, chat, readBytes));
    return true;
  }, err => {
    console.error('[TRANSCRIPT] %s: storing failed, the next turn end retries: %s', key, err instanceof Error ? err.message : String(err));
  });
}

/**
 * Of one owner's projects, those whose chat has a stored transcript that can
 * be read now: the store is configured and the flag is on for the owner. An
 * archived chat whose box is gone reopens from it (routes/chats.ts).
 */
export async function projectsWithStoredHistory(owner: FlagUser, projectIds: readonly string[]): Promise<Set<string>> {
  if (projectIds.length === 0 || !getTranscriptStoreConfig()) return new Set();
  if (!await boolVariation(CHAT_TRANSCRIPTS_FLAG, owner, false)) return new Set();
  const rows = await prisma.chatTranscript.findMany({
    // Not an ask thread's: an archived chat reopens on its own conversation, which an ask's copy is not.
    where: { projectId: { in: [...projectIds] }, current: true, chunks: { some: {} }, workstream: { askThread: null } },
    select: { projectId: true },
    distinct: ['projectId'],
  });
  return new Set(rows.map(r => r.projectId));
}

// One backfill per box at a time. A reconnect during one runs it once more after.
const backfills = new Map<string, { again: boolean }>();

/** Every chat on a box that just connected, BACKFILL_CONCURRENCY at a time. */
function backfillBox(instanceId: string, onError: (err: unknown) => void): Promise<void> {
  return coalescePulls(backfills, instanceId, async () => {
    const workstreams = await prisma.workstream.findMany({
      where: { project: { instanceId }, workflows: { some: { type: 'agent' } } },
      select: { id: true, projectId: true },
    });
    await forEachBounded(workstreams, BACKFILL_CONCURRENCY, ws =>
      syncChatTranscript({ instanceId, projectId: ws.projectId, workstreamId: ws.id }, BACKFILL_READ_BYTES));
    return true;
  }, onError);
}

/** Store at every turn end and backfill on every connect. Returns the unsubscribe. */
export function startChatTranscriptSync(): () => void {
  const offEvent = onChatEvent(seen => {
    const ev = seen.event as { type?: unknown } | null;
    if (ev?.type !== 'turn-end' || !seen.workstreamId) return;
    const chat = { instanceId: seen.instanceId, projectId: seen.projectId, workstreamId: seen.workstreamId };
    // The checkout's git state goes on the session the pull just stored (chatGitState.ts).
    void syncChatTranscript(chat).then(() => recordChatGitState(chat));
  });
  const offHello = onBoxAgentHello(ev => {
    if (!ev.capabilities.includes(TRANSCRIPT_CAPABILITY) || !getTranscriptStoreConfig()) return;
    const onError = (err: unknown) => {
      console.error('[TRANSCRIPT] backfill for %s failed: %s', ev.instance.name, err instanceof Error ? err.message : String(err));
    };
    void ev.settled.then(() => backfillBox(ev.instance.id, onError)).catch(onError);
  });
  return () => { offEvent(); offHello(); };
}
