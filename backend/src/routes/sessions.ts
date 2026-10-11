import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { requireAuthOrAgentToken } from '../middleware/auth';
import { sendForProject, isProjectAgentConnected } from '../services/agentRegistry';
import { assertSessionAccess, SessionAccessError } from '../services/sessionAccess';
import { collectSessionRows, inventoryInclude } from '../services/sessionInventory';

// Permissioned, token-friendly session surface for non-browser callers — built
// for the MetaTerm MCP server, usable by anything holding a Bearer agent token.
// Everything goes through assertSessionAccess (owner-OR-share + rebuild the
// legal session name) and is routed to the OWNER's per-user agent via
// sendForProject, because tmux is per-unix-user and the backend can't touch
// another user's sessions in-process.

const SEND_MIN_INTERVAL_MS = 500;
const sendRateLimits = new Map<string, number>();

export function sessionsRouter(): Router {
  const router = Router();

  // GET /api/sessions — every session the caller may reach: own + shared
  // projects × live workstreams × roles, with agent connectivity, tmux
  // liveness (one tmux-list per distinct host) and the current status.
  const list: RequestHandler = async (req, res) => {
    res.json(await listSessionRowsFor(req.user!.id, req.agentInstanceId));
  };

  // POST /api/projects/:id/sessions/:role/send-keys { workstream?, keys, enter?, literal? }
  // The missing "drive" primitive. Same guard + failure modes as capture.
  const sendKeys: RequestHandler = async (req, res) => {
    const result = await sendKeysFor(req.user!.id, req.params.id, req.params.role, req.body, req.agentInstanceId ?? 'browser');
    res.status(result.status).json(result.body);
  };

  router.get('/sessions', requireAuthOrAgentToken, list);
  router.post('/projects/:id/sessions/:role/send-keys', requireAuthOrAgentToken, sendKeys);
  return router;
}

/**
 * Every session the user may reach: own + shared projects × live workstreams
 * × roles, with agent connectivity, tmux liveness (one tmux-list per distinct
 * host) and the current status. `callerInstanceId` is the box a box token
 * belongs to, which marks that box's rows.
 */
export async function listSessionRowsFor(userId: string, callerInstanceId?: string | null) {
  const owned = await prisma.project.findMany({ where: { userId, archived: false }, include: inventoryInclude });
  const shares = await prisma.projectShare.findMany({
    where: { userId },
    include: { project: { include: inventoryInclude } },
  });
  const rows = await collectSessionRows([
    ...owned.map(p => ({ p, access: 'owner' })),
    ...shares.filter(s => !s.project.archived).map(s => ({ p: s.project, access: 'collaborator' })),
  ], callerInstanceId);
  // ownerUserId is an admin-view field; the per-user payload stays as before.
  return rows.map(({ ownerUserId: _omit, ...r }) => r);
}

/** Type into a project session the user may reach (send-keys route, cookie or agent token). */
export async function sendKeysFor(
  userId: string, projectId: string, role: string, body: unknown,
  /** Who is sending, for the rate-limit key (see captureFor). */
  callerId: string = 'browser',
): Promise<{ status: number; body: unknown }> {
  const { workstream, keys, enter, literal } = (body ?? {}) as {
    workstream?: string; keys?: string; enter?: boolean; literal?: boolean;
  };
  if (typeof keys !== 'string' || keys.length === 0) {
    return { status: 400, body: { error: 'keys (non-empty string) required' } };
  }
  if (keys.length > 4000) {
    return { status: 400, body: { error: 'keys too long (max 4000 chars)' } };
  }
  let access;
  try {
    access = await assertSessionAccess(userId, projectId, role, workstream || 'main');
  } catch (err) {
    if (err instanceof SessionAccessError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
  if (!isProjectAgentConnected(access.host)) {
    return { status: 503, body: { error: "Owner's agent is offline" } };
  }
  // Per caller (see the capture route): token callers by box, browsers as one.
  const rateKey = `${userId}:${callerId}:${access.session}`;
  const now = Date.now();
  if (now - (sendRateLimits.get(rateKey) ?? 0) < SEND_MIN_INTERVAL_MS) {
    return { status: 429, body: { error: 'Rate limited (max 2 sends/sec per caller and session)' } };
  }
  sendRateLimits.set(rateKey, now);
  try {
    // literal (default true): type `keys` verbatim. literal:false sends tmux
    // KEY NAMES (C-c, Escape, Up…) — deliberate control-tower use only. Old
    // agents ignore the flag and keep their historical key-name behavior.
    await sendForProject(access.host, 'tmux-send-keys', {
      sessionName: access.session, keys, withEnter: enter !== false, literal: literal !== false,
    });
    return { status: 200, body: { ok: true, session: access.session } };
  } catch (err) {
    return { status: 503, body: { error: `send-keys failed: ${(err as Error).message}` } };
  }
}
