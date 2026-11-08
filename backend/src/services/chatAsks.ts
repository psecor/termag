/**
 * The asks a chat sent, as its browser
 * reads them: each thread with its target, its own chat and its PRs, and each
 * of its messages' state. Claude sends an ask from Bash (`termag ask`), so the
 * chat itself only has the command and what it printed; everything after
 * that is here. Never a prompt or a reply: neither is stored. Pure, for the
 * tests; routes/chatAsks.ts reads the rows.
 */
import { askTarget, isMessageId, isTerminal, threadPrs, type PrView, type ThreadRow } from './agentMessages';

/**
 * At most this many thread ids in one read, and this many of the newest
 * threads answered; past those, a read still answers every thread still
 * going, every one it named, and those that ended in the last
 * ASK_KEPT_AFTER_END_MS (routes/chatAsks.ts pastThreads).
 */
export const MAX_CHAT_ASK_THREADS = 50;
/** How long after it ends a thread past the newest MAX_CHAT_ASK_THREADS is still answered: as long as a pane chat's drawer keeps an ask that ended (frontend chat/asks.ts PANE_ASK_KEEP_MS). */
export const ASK_KEPT_AFTER_END_MS = 60 * 60 * 1000;
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

/**
 * Whether the chat reading a message is told when it finishes, by the notice
 * askNoticeSweep.ts types into the message's sender session, its chat or
 * agent pane (askNotice.ts). Each message records its own sender, so a
 * follow-up another session sent tells that session, not the reader.
 * `due`: it will be, once the message finishes and the notice's grace has
 * passed (the reader is the recorded sender, the notice not settled, and
 * ask-completion-notify-enabled on for the sender). `sent`: the reader was
 * told. `none`: nothing tells the reader: no checked sender, `--no-notify`, a
 * ctrl shell, another session's notice, the flag off, or a poll got the
 * finish (`waiter`). `unsent`: one was due and did not go (the session gone,
 * a day passed, or delivery failed); the finish is in `termag ask --inbox`.
 */
export type ChatAskNotice = 'due' | 'sent' | 'none' | 'unsent';

/**
 * Who reads the notice states: `chat`, the project and workstream of the chat
 * reading them (null for a reader that is no termag chat, the desktop, which
 * no notice tells), and `flagOn`, ask-completion-notify-enabled for the
 * caller, read as the sweep reads it (askThreadsOf).
 */
export interface NoticeReader {
  flagOn: boolean;
  chat: { projectId: string; workstream: string } | null;
}

export interface NoticeRow {
  notifyVia?: string | null;
  notifyProjectId?: string | null;
  notifyWorkstream?: string | null;
  notice?: string | null;
  supersededById?: string | null;
}

/** A chain of follow-ups answered together is at most this long (a thread's messages answered). */
const MAX_TOGETHER_HOPS = 50;

/**
 * A message's notice state for `reader`. A superseded message settled
 * `together` (its follow-up tells the same session) takes the state of the
 * follow-up that answered it, found by `followUp`; none when it isn't found.
 */
export function noticeState(m: NoticeRow, reader: NoticeReader, followUp?: (id: string) => NoticeRow | undefined, hops = 0): ChatAskNotice {
  if (!m.notifyVia || !reader.chat) return 'none';
  if (m.notifyProjectId !== reader.chat.projectId || m.notifyWorkstream !== reader.chat.workstream) return 'none';
  switch (m.notice) {
    case 'chat': case 'pane': return 'sent';
    case 'together': {
      const next = m.supersededById && hops < MAX_TOGETHER_HOPS ? followUp?.(m.supersededById) : undefined;
      return next ? noticeState(next, reader, followUp, hops + 1) : 'none';
    }
    case 'waiter': case 'off': return 'none';
    case null: case undefined: return reader.flagOn ? 'due' : 'none';
    default: return 'unsent';
  }
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
  notifyVia?: string | null;
  notifyProjectId?: string | null;
  notifyWorkstream?: string | null;
  notice?: string | null;
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
  /** Whether its sender is told when it finishes (noticeState). */
  notice: ChatAskNotice;
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

const NO_READER: NoticeReader = { flagOn: false, chat: null };

/** A message as the browser reads it, its notice for `reader`; `followUp` finds the message that superseded one (noticeState). */
export function chatAskMessageView(m: ChatAskMessageRow, reader: NoticeReader = NO_READER, followUp?: (id: string) => NoticeRow | undefined): ChatAskMessage {
  return {
    id: m.id,
    hop: m.hop,
    status: m.status,
    queued: m.queuedPrompt != null,
    error: m.error,
    reply: replyState(m),
    notice: noticeState(m, reader, followUp),
    supersededBy: m.supersededById,
    publish: m.publish ? { status: m.publish, detail: m.publishDetail } : null,
    createdAt: m.createdAt.toISOString(),
    startedAt: iso(m.startedAt),
    completedAt: iso(m.completedAt),
  };
}

export function chatAskThreadView(t: ChatAskThreadRow, reader: NoticeReader = NO_READER): ChatAskThread {
  const messages = [...t.messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(-MAX_CHAT_ASK_MESSAGES);
  const byId = new Map(t.messages.map(m => [m.id, m]));
  return {
    id: t.id,
    title: t.title ?? null,
    target: askTarget(t.project.instance?.name ?? t.instanceId, t.project.name, t.workstream, t.repoName),
    chat: t.chatWorkstream ? { projectId: t.projectId, workstream: t.chatWorkstream.name } : null,
    prs: threadPrs(t),
    createdAt: t.createdAt.toISOString(),
    messages: messages.map(m => chatAskMessageView(m, reader, id => byId.get(id))),
  };
}
