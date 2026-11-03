/**
 * Who drives a chat's Claude session, termag's chat runner or the desktop
 * app's thread. The box
 * decides: agent/chat-runner.js claimT3 holds it for a thread, and a runner
 * turn takes it back. termag records the outcome on the workstream for the
 * desktop's sidebar (GET /api/cli/v1/chats); the workspace write middleware
 * pushes it to everyone who lists the chat.
 */
import { prisma } from '../db';

export type ChatHolder = 'runner' | 't3';

export interface ChatHolderChange {
  holder: ChatHolder;
  /** The desktop's thread: the one that took the session, or the one that gave it back. */
  threadId: string | null;
  /** The chat's Claude session, when the box named it. */
  sessionId: string | null;
}

const THREAD_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,80}$/;

export const isT3ThreadId = (v: unknown): v is string => typeof v === 'string' && THREAD_ID_RE.test(v);
export const isChatSessionId = (v: unknown): v is string => typeof v === 'string' && SESSION_ID_RE.test(v);

/** A box's `chat-holder` notice (agent/chat-runner.js emitHolder), or null for any other event. */
export function chatHolderOf(event: unknown): ChatHolderChange | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as { type?: unknown; holder?: unknown; threadId?: unknown; sessionId?: unknown };
  if (e.type !== 'chat-holder' || (e.holder !== 'runner' && e.holder !== 't3')) return null;
  const threadId = isT3ThreadId(e.threadId) ? e.threadId : null;
  if (e.holder === 't3' && !threadId) return null;
  return { holder: e.holder, threadId, sessionId: isChatSessionId(e.sessionId) ? e.sessionId : null };
}

/**
 * Record a change of hands, and the session it leaves the chat on, on the project's workstream, as of `at`. A change
 * older than the one recorded is dropped: the claim route writes what the box
 * answered as of when it asked, and the box's own notices (which run in its
 * order) may already have recorded a later release.
 */
export async function saveChatHolder(projectId: string, workstreamId: string, change: ChatHolderChange, at: Date): Promise<void> {
  await prisma.workstream.updateMany({
    where: { id: workstreamId, projectId, OR: [{ chatHolderAt: null }, { chatHolderAt: { lt: at } }] },
    data: {
      chatHolder: change.holder,
      chatHolderAt: at,
      ...(change.holder === 't3' ? { t3ThreadId: change.threadId } : {}),
      // The session the box named, or none: a chat the desktop made has none until its thread's first turn.
      chatSessionId: change.sessionId,
    },
  });
}

/**
 * The Claude session a desktop-held chat now has (the box took it from the
 * thread), read as of `askedAt`: dropped when a hand-over recorded since then
 * may name a newer one.
 */
export async function saveChatSession(projectId: string, workstreamId: string, sessionId: string, askedAt: Date): Promise<void> {
  await prisma.workstream.updateMany({
    where: {
      id: workstreamId, projectId,
      AND: [
        { OR: [{ chatSessionId: null }, { chatSessionId: { not: sessionId } }] },
        { OR: [{ chatHolderAt: null }, { chatHolderAt: { lt: askedAt } }] },
      ],
    },
    data: { chatSessionId: sessionId },
  });
}
