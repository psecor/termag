/**
 * The daily briefing under /api/cli/v1, for the
 * desktop app's briefing:
 *
 *   GET    /briefings/latest           the newest done briefing, a newer unfinished one, and the Done/Defer marks
 *   GET    /briefings?limit=           earlier ones, newest first (20 unless asked, at most 100)
 *   GET    /briefings/:id              one of them
 *   GET    /briefings/schedule         the opt-in schedule (time, days, zone, Slack DM)
 *   PUT    /briefings/schedule         set it: 200 with what was stored, 400 with why not
 *   PUT    /briefings/dismissals       Done or Defer a day on an item ({ key, action })
 *   DELETE /briefings/dismissals?key=  bring it back
 *   POST   /briefings/run              start one now ({ tz? }): 202, or 200 with the one already running
 *
 * The bodies are /api/briefings' (routes/briefings.ts), from the same
 * services. Each is a device sign-in's (a box's own token gets 403: anything
 * on the box can read it). Nothing here wakes a box: a run takes one that is already up, or is
 * stored as skipped (services/briefing/runner.ts).
 */
import type { RequestHandler, Response, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import { DismissInputError, parseDismissInput } from '../services/briefing/dismissals';
import { parseScheduleBody } from '../services/briefing/schedule';
import type { BriefingDismissal, BriefingSchedule } from '../services/briefing/types';
import type { CliUser } from '../services/cliStore';
import type { CliAuth } from './cliApi';
import type { RouteResult } from './routeResult';

export interface CliBriefings {
  /** GET /api/briefings/latest's body. */
  latest(user: CliUser): Promise<unknown>;
  dismiss(user: CliUser, input: { key: string; action: 'done' | 'defer' }): Promise<BriefingDismissal>;
  restore(user: CliUser, key: string): Promise<void>;
  /** POST /api/briefings/run's answer; `tz` is the body's, unchecked. */
  run(user: CliUser, tz: unknown): Promise<RouteResult>;
  /** GET /api/briefings' body: `{ briefings }`, newest first. */
  list(user: CliUser, limit: number): Promise<unknown>;
  /** GET /api/briefings/:id's body, or null when it isn't this person's. */
  one(user: CliUser, id: string): Promise<unknown | null>;
  /** GET /api/briefings/schedule's body. */
  schedule(user: CliUser): Promise<BriefingSchedule>;
  /** Store a schedule parseScheduleBody passed; answers with what was stored. */
  saveSchedule(user: CliUser, schedule: BriefingSchedule): Promise<BriefingSchedule>;
}

const NOT_FOUND = { error: 'No such CLI endpoint; this termag CLI may be newer than the orchestrator', code: 'not_found' };
const DEVICE_ONLY = {
  error: "A box's own credentials can't reach the briefing; sign in with `termag login`",
  code: 'forbidden',
};

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

export function mountCliBriefingRoutes(router: Router, deps: CliBriefings, bearer: RequestHandler): void {
  const gate: RequestHandler = asyncHandler(async (_req, res, next) => {
    const { user, credential } = cliAuth(res);
    if (credential.kind !== 'device') { res.status(403).json(DEVICE_ONLY); return; }
    next();
  });

  router.get('/briefings/latest', bearer, gate, asyncHandler(async (_req, res) => {
    res.json(await deps.latest(cliAuth(res).user));
  }));

  router.get('/briefings', bearer, gate, asyncHandler(async (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
    res.json(await deps.list(cliAuth(res).user, limit));
  }));

  router.put('/briefings/dismissals', bearer, gate, asyncHandler(async (req, res) => {
    let input;
    try { input = parseDismissInput(req.body); } catch (err) {
      if (err instanceof DismissInputError) { res.status(400).json({ error: err.message, code: 'invalid_request' }); return; }
      throw err;
    }
    res.json(await deps.dismiss(cliAuth(res).user, input));
  }));

  router.delete('/briefings/dismissals', bearer, gate, asyncHandler(async (req, res) => {
    const key = typeof req.query.key === 'string' ? req.query.key : '';
    if (!key || key.length > 300) { res.status(400).json({ error: 'key is required', code: 'invalid_request' }); return; }
    await deps.restore(cliAuth(res).user, key);
    res.status(204).end();
  }));

  router.post('/briefings/run', bearer, gate, asyncHandler(async (req, res) => {
    const out = await deps.run(cliAuth(res).user, (req.body as { tz?: unknown } | undefined)?.tz);
    res.status(out.status).json(out.body);
  }));

  router.get('/briefings/schedule', bearer, gate, asyncHandler(async (_req, res) => {
    res.json(await deps.schedule(cliAuth(res).user));
  }));

  router.put('/briefings/schedule', bearer, gate, asyncHandler(async (req, res) => {
    const parsed = parseScheduleBody(req.body);
    if ('error' in parsed) { res.status(400).json({ error: parsed.error, code: 'invalid_request' }); return; }
    res.json(await deps.saveSchedule(cliAuth(res).user, parsed));
  }));

  // After /briefings/latest and /briefings/schedule, so neither is read as an id.
  router.get('/briefings/:id', bearer, gate, asyncHandler(async (req, res) => {
    const view = await deps.one(cliAuth(res).user, req.params.id);
    if (!view) { res.status(404).json({ error: 'No such briefing', code: 'not_found' }); return; }
    res.json(view);
  }));
}
