import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { requireAuthOrAgentToken } from '../middleware/auth';
import { sendForProject, isProjectAgentConnected } from '../services/agentRegistry';
import { noteBoxActivity } from '../services/boxActivity';
import { assertSessionAccess, SessionAccessError } from '../services/sessionAccess';
import { collectSessionRows, inventoryInclude } from '../services/sessionInventory';
import {
  liveSearchDeps, parseRoles, searchSessions, SEARCH_DEFAULT_LINES, SEARCH_MAX_QUERY, SEARCH_MIN_QUERY,
  type SearchDeps, type SearchResult,
} from '../services/sessionSearch';

// Permissioned, token-friendly session surface for non-browser callers — built
// for the MetaTerm MCP server, usable by anything holding a Bearer agent token.
// Everything goes through assertSessionAccess (owner-OR-share + rebuild the
// legal session name) and is routed to the OWNER's per-user agent via
// sendForProject, because tmux is per-unix-user and the backend can't touch
// another user's sessions in-process.

const SEND_MIN_INTERVAL_MS = 500;
const sendRateLimits = new Map<string, number>();

// Pane-text search fans out one capture per live pane, so it gets its own
// budget per caller instead of riding the 1/s per-pane capture limit; a
// repeat of the same search inside the cache window costs nothing.
const SEARCH_MIN_INTERVAL_MS = 3_000;
const SEARCH_CACHE_MS = 15_000;
const searchRateLimits = new Map<string, number>();
const searchCache = new Map<string, { at: number; result: SearchResult }>();

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

  // GET /api/sessions/search?q=&lines=&roles=agent,ctrl — pane text across
  // every reachable live session. Backs the phone's
  // Search tab and MetaTerm's search_sessions tool.
  const search: RequestHandler = async (req, res) => {
    const result = await searchFor(req.user!.id, req.query, req.agentInstanceId ?? 'browser');
    res.status(result.status).json(result.body);
  };

  router.get('/sessions/search', requireAuthOrAgentToken, search);
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
  noteBoxActivity(access.host.instanceId);
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

/** Search pane text across the user's reachable sessions (search route, cookie or agent token). */
export async function searchFor(
  userId: string, query: Record<string, unknown>,
  /** Who is searching, for the rate-limit key (see captureFor). */
  callerId: string = 'browser',
  deps: SearchDeps = liveSearchDeps(id => listSessionRowsFor(id)),
  now: number = Date.now(),
): Promise<{ status: number; body: unknown }> {
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  if (q.length < SEARCH_MIN_QUERY) return { status: 400, body: { error: `q must be at least ${SEARCH_MIN_QUERY} characters` } };
  if (q.length > SEARCH_MAX_QUERY) return { status: 400, body: { error: `q too long (max ${SEARCH_MAX_QUERY} chars)` } };
  const requested = parseInt(query.lines as string, 10);
  const lines = Number.isFinite(requested) ? Math.max(1, Math.min(1000, requested)) : SEARCH_DEFAULT_LINES;
  const roles = parseRoles(query.roles);

  const cacheKey = `${userId}:${q.toLowerCase()}:${lines}:${roles.join(',')}`;
  const cached = searchCache.get(cacheKey);
  if (cached && now - cached.at < SEARCH_CACHE_MS) return { status: 200, body: { ...cached.result, cached: true } };

  const rateKey = `${userId}:${callerId}`;
  const previous = searchRateLimits.get(rateKey);
  if (now - (previous ?? 0) < SEARCH_MIN_INTERVAL_MS) {
    return { status: 429, body: { error: `Rate limited (one pane search per ${SEARCH_MIN_INTERVAL_MS / 1000}s per caller)` } };
  }
  // Stamped before the fan-out so concurrent requests cannot both run; a
  // search that fails outright hands the budget back.
  searchRateLimits.set(rateKey, now);
  let result: SearchResult;
  try {
    result = await searchSessions(userId, q, { lines, roles }, deps);
  } catch (err) {
    if (previous === undefined) searchRateLimits.delete(rateKey); else searchRateLimits.set(rateKey, previous);
    throw err;
  }
  for (const [k, v] of searchCache) if (now - v.at >= SEARCH_CACHE_MS) searchCache.delete(k);
  searchCache.set(cacheKey, { at: now, result });
  return { status: 200, body: result };
}
