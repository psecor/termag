/**
 * The lines in a chat's timeline that are neither the person's nor the
 * agent's (services/chatNotices.ts): today a tool update's restart notice.
 *
 *   GET /api/projects/:id/chat/notices?workstream=<ws>  → { notices: [{ id, kind, pane, text, at }] }
 *
 * For the project's owner and anyone it is shared with, like the rest of the
 * chat (assertSessionAccess, 404 on any denial). Read only. No flag: a notice
 * exists only where a tool update restarted the session, which the tool
 * update flags already gate.
 */
import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { listChatNotices } from '../services/chatNotices';
import { assertSessionAccess, SessionAccessError } from '../services/sessionAccess';

interface Result { status: number; body: unknown }

const MAX_WORKSTREAM_CHARS = 200;

export async function chatNoticesFor(userId: string, projectId: string, query: Record<string, unknown>): Promise<Result> {
  const workstream = typeof query.workstream === 'string' && query.workstream ? query.workstream : 'main';
  if (workstream.length > MAX_WORKSTREAM_CHARS) return { status: 400, body: { error: 'workstream is too long' } };
  try {
    await assertSessionAccess(userId, projectId, 'agent', workstream);
  } catch (err) {
    if (err instanceof SessionAccessError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
  const ws = await prisma.workstream.findUnique({ where: { projectId_name: { projectId, name: workstream } }, select: { id: true } });
  return { status: 200, body: { notices: ws ? await listChatNotices(ws.id) : [] } };
}

export function chatNoticesRouter(): Router {
  const router = Router();
  router.get('/:id/chat/notices', requireAuth, asyncHandler(async (req, res) => {
    const r = await chatNoticesFor(req.user!.id, req.params.id, req.query);
    res.status(r.status).json(r.body);
  }));
  return router;
}
