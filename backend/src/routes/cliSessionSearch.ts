/**
 * Pane text search under /api/cli/v1, for the termag desktop app's "Search terminal output":
 *
 *   GET /sessions/search?q=&lines=&roles=agent,ctrl   matches in the live panes of every session
 *                                                     the person may reach
 *
 * The body is /api/sessions/search's (routes/sessions.ts searchFor), from the same search: its
 * query checks, its short cache, and its rate limit, keyed per device sign-in so two of the
 * person's computers don't share one budget. A device sign-in's only (a box's own token gets 403:
 * anything on the box could read every pane).
 */
import type { RequestHandler, Response, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import type { CliUser } from '../services/cliStore';
import type { CliAuth } from './cliApi';
import type { RouteResult } from './routeResult';

export interface CliSessionSearch {
  /** `query` as the request had it; `callerId` keys the rate limit. */
  search(user: CliUser, query: Record<string, unknown>, callerId: string): Promise<RouteResult>;
}

const NOT_FOUND = { error: 'No such CLI endpoint; this termag CLI may be newer than the orchestrator', code: 'not_found' };
const DEVICE_ONLY = {
  error: "A box's own credentials can't search panes; sign in with `termag login`",
  code: 'forbidden',
};

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

export function mountCliSessionSearchRoutes(router: Router, deps: CliSessionSearch, bearer: RequestHandler): void {
  const gate: RequestHandler = asyncHandler(async (_req, res, next) => {
    const { user, credential } = cliAuth(res);
    if (credential.kind !== 'device') { res.status(403).json(DEVICE_ONLY); return; }
    next();
  });

  router.get('/sessions/search', bearer, gate, asyncHandler(async (req, res) => {
    const { user, credential } = cliAuth(res);
    const callerId = credential.kind === 'device' ? `cli:${credential.sessionId}` : 'cli';
    const out = await deps.search(user, req.query as Record<string, unknown>, callerId);
    res.status(out.status).json(out.status >= 400 ? { ...(out.body as object), code: out.status === 429 ? 'rate_limited' : 'failed' } : out.body);
  }));
}
