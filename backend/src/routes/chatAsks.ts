/**
 * The asks a chat sent, for its browser:
 *
 *   GET /api/projects/:id/chat/asks?workstream=<ws>&threads=<id,…>
 *
 * The caller's own ask threads that this chat (project and workstream) sent,
 * as the thread recorded (AgentThread.parentProjectId / parentWorkstream),
 * plus any of the caller's threads named in `threads`: the ids the chat's
 * `termag ask` calls printed, which covers a thread from before the parent
 * link or from a session whose sender wasn't recorded. The newest
 * MAX_CHAT_ASK_THREADS of them, and past those every one still going, every
 * one named and those that ended in the last hour (pastThreads). Each with its
 * messages' state (services/chatAsks.ts). Asks are owner-only
 * (docs/agents/gotchas.md, ask-owner-only), so this only ever answers
 * threads the caller started; a sharee reading the chat gets none. Behind
 * chat-subagents-enabled (404 `subagents-off`), like the subagent route.
 */
import type { Prisma } from '@prisma/client';
import { Router, type Request } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { boolVariation } from '../services/featureFlags';
import type { FlagUser } from '../services/featureFlags';
import { CHAT_SUBAGENTS_FLAG } from '../services/chatRunner';
import { ASK_NOTICE_FLAG } from '../services/askNotice';
import { ASK_KEPT_AFTER_END_MS, MAX_CHAT_ASK_MESSAGES, MAX_CHAT_ASK_THREADS, chatAskThreadView, parseThreadIds, type NoticeReader } from '../services/chatAsks';
import { ACTIVE_STATES, MAX_ACTIVE_ASKS } from '../services/agentMessages';
import { withoutSurface } from '../services/requestSurface';

interface Result { status: number; body: unknown }

const MAX_WORKSTREAM_CHARS = 200;

export async function chatAsksFor(userId: string, projectId: string, query: Request['query'], ldUser?: FlagUser): Promise<Result> {
  if (!ldUser || !await boolVariation(CHAT_SUBAGENTS_FLAG, ldUser, false)) return { status: 404, body: { error: 'Not found', code: 'subagents-off' } };
  const workstream = typeof query.workstream === 'string' && query.workstream ? query.workstream : 'main';
  if (workstream.length > MAX_WORKSTREAM_CHARS) return { status: 400, body: { error: 'workstream is too long' } };
  const ids = parseThreadIds(query.threads);
  if (!ids) return { status: 400, body: { error: `threads must be at most ${MAX_CHAT_ASK_THREADS} comma-separated thread ids` } };
  return {
    status: 200,
    body: {
      threads: await askThreadsOf(userId, ldUser, { projectId, workstream }, [
        { parentProjectId: projectId, parentWorkstream: workstream },
        ...(ids.length ? [{ id: { in: ids } }] : []),
      ], ids),
    },
  };
}

const CLAUDE_SESSION_RE = /^[A-Za-z0-9-]{8,80}$/;

/**
 * The asks a desktop app thread sent (GET /api/cli/v1/chat/asks, routes/cliChats.ts):
 * the caller's own threads its `termag ask` calls named, plus those that
 * recorded its Claude session as their parent. A desktop thread's T3 run sets
 * no TERMAG_PROJECT_ID, so its asks name no parent chat, only that session.
 * Read only, like the web route: nothing here marks a message read.
 */
export async function desktopChatAsksFor(userId: string, query: Request['query'], ldUser?: FlagUser): Promise<Result> {
  if (!ldUser || !await boolVariation(CHAT_SUBAGENTS_FLAG, ldUser, false)) return { status: 404, body: { error: 'Not found', code: 'subagents-off' } };
  const ids = parseThreadIds(query.threads);
  if (!ids) return { status: 400, body: { error: `threads must be at most ${MAX_CHAT_ASK_THREADS} comma-separated thread ids` } };
  const raw = query.claudeSession;
  const session = typeof raw === 'string' && raw ? raw : null;
  if (raw !== undefined && raw !== '' && (!session || !CLAUDE_SESSION_RE.test(session))) return { status: 400, body: { error: 'claudeSession is not a Claude session id' } };
  if (!ids.length && !session) return { status: 400, body: { error: 'threads or claudeSession is required' } };
  return {
    status: 200,
    body: {
      // A desktop thread is no termag chat, so no finish notice tells it (services/chatAsks.ts noticeState).
      threads: await askThreadsOf(userId, ldUser, null, [
        ...(ids.length ? [{ id: { in: ids } }] : []),
        ...(session ? [{ parentClaudeSession: session }] : []),
      ], ids),
    },
  };
}

const THREAD_SELECT = {
  id: true, title: true, hopCount: true, branch: true, prNumber: true, prUrl: true,
  projectId: true, workstream: true, repoName: true, instanceId: true, createdAt: true,
  prs: { select: { key: true, branch: true, prNumber: true, prUrl: true }, orderBy: { createdAt: 'asc' } },
  project: { select: { name: true, instance: { select: { name: true } } } },
  chatWorkstream: { select: { name: true } },
  messages: {
    select: {
      id: true, hop: true, status: true, error: true, replyBytes: true, publish: true, publishDetail: true,
      createdAt: true, startedAt: true, completedAt: true, readAt: true, queuedPrompt: true, supersededById: true,
      notifyVia: true, notifyProjectId: true, notifyWorkstream: true, notice: true,
      storedReply: { select: { bytes: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_CHAT_ASK_MESSAGES,
  },
} satisfies Prisma.AgentThreadSelect;

/**
 * The caller's own ask threads matching any of `match`, oldest first, each
 * with its newest messages (services/chatAsks.ts), their finish notices as
 * `chat` (the reading chat, or null) is told of them: the newest
 * MAX_CHAT_ASK_THREADS, and past those the ones pastThreads keeps. Asks are
 * owner-only, so the caller is every message's sender, and its
 * ask-completion-notify-enabled is the one the notice sweep reads. The sweep
 * reads it outside any request, so this reads it with no request surface
 * (requestSurface.ts), in the same context.
 */
async function askThreadsOf(userId: string, ldUser: FlagUser, chat: NoticeReader['chat'], match: Prisma.AgentThreadWhereInput[], named: string[]) {
  const flagOn = withoutSurface(() => boolVariation(ASK_NOTICE_FLAG, ldUser, false));
  const newest = await prisma.agentThread.findMany({
    where: { originUserId: userId, OR: match },
    select: THREAD_SELECT,
    orderBy: { createdAt: 'desc' },
    take: MAX_CHAT_ASK_THREADS,
  });
  // Fewer than a full page is every thread there is; only a full one can have left one out.
  const past = newest.length < MAX_CHAT_ASK_THREADS ? [] : await pastThreads(userId, match, named, newest.map(t => t.id));
  const reader: NoticeReader = { flagOn: await flagOn, chat };
  return [...newest, ...past]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map(t => chatAskThreadView(t, reader));
}

/**
 * Past the newest MAX_CHAT_ASK_THREADS (`seen`), so that a chat that has sent
 * more still sees the asks it is waiting on: every thread still going (a
 * message submitted or working; at most MAX_ACTIVE_ASKS can be), every one
 * its calls named (at most MAX_CHAT_ASK_THREADS, parseThreadIds), and then,
 * read after those and apart from them so they neither crowd those out nor
 * take a place of their own, the newest MAX_CHAT_ASK_THREADS others that
 * ended in the last ASK_KEPT_AFTER_END_MS, so one the chat watched shows how
 * it ended rather than leaving its drawer.
 */
async function pastThreads(userId: string, match: Prisma.AgentThreadWhereInput[], named: string[], seen: string[]) {
  const kept = await prisma.agentThread.findMany({
    where: {
      originUserId: userId,
      id: { notIn: seen },
      OR: [...(named.length ? [{ id: { in: named } }] : []), { OR: match, messages: { some: { status: { in: ACTIVE_STATES } } } }],
    },
    select: THREAD_SELECT,
    take: MAX_CHAT_ASK_THREADS + MAX_ACTIVE_ASKS,
  });
  const ended = await prisma.agentThread.findMany({
    where: {
      originUserId: userId,
      id: { notIn: [...seen, ...kept.map(t => t.id)] },
      OR: match,
      messages: { some: { completedAt: { gte: new Date(Date.now() - ASK_KEPT_AFTER_END_MS) } } },
    },
    select: THREAD_SELECT,
    orderBy: { createdAt: 'desc' },
    take: MAX_CHAT_ASK_THREADS,
  });
  return [...kept, ...ended];
}

export function chatAsksRouter(): Router {
  const router = Router();
  router.get('/:id/chat/asks', requireAuth, asyncHandler(async (req, res) => {
    const r = await chatAsksFor(req.user!.id, req.params.id, req.query, req.user!);
    res.status(r.status).json(r.body);
  }));
  return router;
}
