/**
 * The asks a chat sent, as its browser
 * reads them: each thread with its target, its own chat and its PRs, and each
 * of its messages' state. Claude sends an ask from Bash (`termag ask`), so the
 * chat itself only has the command and what it printed; everything after
 * that is here. Never a prompt or a reply: neither is stored. Pure, for the
 * tests; routes/chatAsks.ts reads the rows.
 */
import { askTarget, isMessageId, isTerminal, threadPrs, type PrView, type ThreadRow } from './agentMessages';

/** At most this many thread ids in one read, and this many threads answered. */
export const MAX_CHAT_ASK_THREADS = 50;
/** A thread's messages answered, oldest first: a long thread keeps its newest. */
export const MAX_CHAT_ASK_MESSAGES = 50;

/**
 * `?threads=` as thread ids: comma-separated cuids, at most
 * MAX_CHAT_ASK_THREADS, repeats dropped. Absent or empty is none; anything
 * that isn't an id makes the whole list null (a 400).
 */
export function parseThreadIds(raw: unknown): string[] | null {
  if (raw === undefined || raw === '') return [];
  if (typeof raw !== 'string') return null;
  const ids = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
  if (ids.length > MAX_CHAT_ASK_THREADS || !ids.every(isMessageId)) return null;
  return ids;
}

/**
 * What became of a message's reply: not finished yet, a poll got it, nobody
 * has read it yet but it is stored (`termag ask --reply` reads it), nobody
 * was waiting for it and it was not stored (a message from before stored
 * replies, or one past their 14 days), the run left none, or a follow-up
 * joined its turn and the follow-up's reply answers both.
 */
export type ChatAskReply = 'pending' | 'delivered' | 'stored' | 'dropped' | 'none' | 'follow-up';

export function replyState(m: { status: string; replyBytes: number | null; readAt: Date | null; storedReply?: { bytes: number } | null }): ChatAskReply {
  if (m.status === 'superseded') return 'follow-up';
  if (!isTerminal(m.status)) return 'pending';
  if (m.replyBytes === null) return 'none';
  if (m.readAt) return 'delivered';
  return m.storedReply ? 'stored' : 'dropped';
}

export interface ChatAskMessageRow {
  id: string;
  hop: number;
  status: string;
  error: string | null;
  replyBytes: number | null;
  publish: string | null;
  publishDetail: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  readAt: Date | null;
  queuedPrompt: string | null;
  supersededById: string | null;
  storedReply?: { bytes: number } | null;
}

export interface ChatAskThreadRow extends ThreadRow {
  projectId: string;
  workstream: string;
  repoName: string | null;
  instanceId: string;
  createdAt: Date;
  project: { name: string; instance: { name: string } | null };
  chatWorkstream: { name: string } | null;
  messages: ChatAskMessageRow[];
}

export interface ChatAskMessage {
  id: string;
  hop: number;
  status: string;
  /** Held at the orchestrator until its box is up, its project is set up, or the thread's turn before it ends. */
  queued: boolean;
  error: string | null;
  reply: ChatAskReply;
  supersededBy: string | null;
  publish: { status: string; detail: string | null } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ChatAskThread {
  id: string;
  title: string | null;
  /** What a follow-up names: `box/project[@workstream][:repo]`. */
  target: string;
  /** The thread's own chat on its target project (ask-chat-v1), which the agent tab reads; null on a box that runs asks headless. */
  chat: { projectId: string; workstream: string } | null;
  prs: PrView[];
  createdAt: string;
  messages: ChatAskMessage[];
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export function chatAskMessageView(m: ChatAskMessageRow): ChatAskMessage {
  return {
    id: m.id,
    hop: m.hop,
    status: m.status,
    queued: m.queuedPrompt != null,
    error: m.error,
    reply: replyState(m),
    supersededBy: m.supersededById,
    publish: m.publish ? { status: m.publish, detail: m.publishDetail } : null,
    createdAt: m.createdAt.toISOString(),
    startedAt: iso(m.startedAt),
    completedAt: iso(m.completedAt),
  };
}

export function chatAskThreadView(t: ChatAskThreadRow): ChatAskThread {
  const messages = [...t.messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(-MAX_CHAT_ASK_MESSAGES);
  return {
    id: t.id,
    title: t.title ?? null,
    target: askTarget(t.project.instance?.name ?? t.instanceId, t.project.name, t.workstream, t.repoName),
    chat: t.chatWorkstream ? { projectId: t.projectId, workstream: t.chatWorkstream.name } : null,
    prs: threadPrs(t),
    createdAt: t.createdAt.toISOString(),
    messages: messages.map(chatAskMessageView),
  };
}
