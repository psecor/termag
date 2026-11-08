/**
 * Working time under /api/cli/v1, for the termag desktop app's sidebar foot
 * (today's agents beside you) and its usage page:
 *
 *   GET /worktime?days=N&tz=Zone            banked time per day and provider; `human` is yours
 *   GET /worktime/projects?days=N&tz=Zone   the same rows per project and workstream
 *
 * The bodies are /api/worktime's (routes/worktime.ts), from the same reads:
 * days are the person's, in the zone the desktop sends as `tz` (recorded for
 * banking, services/userTimeZone.ts), and each answer says which is `today`.
 * N is 1 to 90 (30 when absent).
 * Each is a device sign-in's (a box's own token gets 403: anything on the box
 * can read it).
 */
import type { RequestHandler, Response, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import type { CliUser } from '../services/cliStore';
import type { CliAuth } from './cliApi';
import type { RouteResult } from './routeResult';

export interface CliWorktime {
  /** `tz`: the zone the desktop sends, as the request had it. */
  days(user: CliUser, days: number, tz: unknown): Promise<RouteResult>;
  projects(user: CliUser, days: number, tz: unknown): Promise<RouteResult>;
}

export const CLI_WORKTIME_MAX_DAYS = 90;

const NOT_FOUND = { error: 'No such CLI endpoint; this termag CLI may be newer than the orchestrator', code: 'not_found' };
const DEVICE_ONLY = {
  error: "A box's own credentials can't read working time; sign in with `termag login`",
  code: 'forbidden',
};

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

/** ?days= as 1..90, 30 when absent or not a number. */
export function cliWorktimeDays(raw: unknown): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? Math.min(CLI_WORKTIME_MAX_DAYS, Math.max(1, n)) : 30;
}

export function mountCliWorktimeRoutes(router: Router, deps: CliWorktime, bearer: RequestHandler): void {
  const gate: RequestHandler = asyncHandler(async (_req, res, next) => {
    const { user, credential } = cliAuth(res);
    if (credential.kind !== 'device') { res.status(403).json(DEVICE_ONLY); return; }
    next();
  });

  const send = (res: Response, out: RouteResult) => {
    res.status(out.status).json(out.status >= 400 ? { ...(out.body as object), code: 'failed' } : out.body);
  };

  router.get('/worktime', bearer, gate, asyncHandler(async (req, res) => {
    send(res, await deps.days(cliAuth(res).user, cliWorktimeDays(req.query.days), req.query.tz));
  }));

  router.get('/worktime/projects', bearer, gate, asyncHandler(async (req, res) => {
    send(res, await deps.projects(cliAuth(res).user, cliWorktimeDays(req.query.days), req.query.tz));
  }));
}
