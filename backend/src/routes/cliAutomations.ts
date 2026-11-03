/**
 * Automations under /api/cli/v1: the
 * same operations as the web UI's /api/automations (routes/automations.ts),
 * for `termag automation`.
 *
 *   GET    /automations                          mine and shared with me
 *   POST   /automations                          create; `from` may name a repository as `project create` does
 *   POST   /automations/preview                  a schedule's next occurrences
 *   GET    /automations/:id                      one, with its last 50 runs
 *   PATCH  /automations/:id                      schedule, prompt, tier, enabled, …
 *   POST   /automations/:id/run                  a manual occurrence now (202)
 *   POST   /automations/:id/runs/:runId/stop     interrupt a live run
 *   POST   /automations/:id/runs/:runId/retire   remove a finished run's worktree
 *   GET    /automations/:id/memory               the runs' notes file (owner)
 *   DELETE /automations/:id                      archive the automation's project
 *
 * Each route is a thin shell over a CliAutomations, whose Prisma
 * implementation (routes/cliAutomationsPrisma.ts) calls the cookie routes'
 * own handlers, so ownership, validation, limits and the automations-enabled
 * gate are theirs, word for word. What this surface adds is the box scope: a
 * device sign-in is its person, as the browser is; a box's own credential
 * acts only on automations whose project lives on that box, and creates them
 * only there. The browser has no box to scope by: its person may manage
 * every automation they own, on any box, and so may a device sign-in. A box
 * credential with no box (the orchestrator host's own agent token) has no
 * box to scope to and is refused.
 */
import type { RequestHandler, Response, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import type { CliUser } from '../services/cliStore';
import type { CliAuth } from './cliApi';
import type { RouteResult } from './routeResult';

/** null: a device sign-in, every box of the person's; a box id: that box's own credential. */
export type BoxScope = string | null;

export interface CliAutomations {
  list(user: CliUser, scope: BoxScope): Promise<RouteResult>;
  create(user: CliUser, scope: BoxScope, body: Record<string, unknown>): Promise<RouteResult>;
  preview(user: CliUser, body: Record<string, unknown>): Promise<RouteResult>;
  detail(user: CliUser, scope: BoxScope, id: string): Promise<RouteResult>;
  update(user: CliUser, scope: BoxScope, id: string, body: Record<string, unknown>): Promise<RouteResult>;
  runNow(user: CliUser, scope: BoxScope, id: string): Promise<RouteResult>;
  stopRun(user: CliUser, scope: BoxScope, id: string, runId: string): Promise<RouteResult>;
  retireRun(user: CliUser, scope: BoxScope, id: string, runId: string): Promise<RouteResult>;
  memory(user: CliUser, scope: BoxScope, id: string): Promise<RouteResult>;
  remove(user: CliUser, scope: BoxScope, id: string): Promise<RouteResult>;
}

/** An automation's, project's or run's id (cuid), or a run's workstream name for retire. */
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

function send(res: Response, result: RouteResult): void {
  res.status(result.status).json(result.body);
}

function badRequest(res: Response, error: string): void {
  res.status(400).json({ error, code: 'invalid_request' });
}

function bodyOf(req: { body?: unknown }): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
}

/** The caller's scope, or null with a 403 already sent for a box credential that names no box. */
function scopeOf(res: Response): { scope: BoxScope } | null {
  const { credential } = cliAuth(res);
  if (credential.kind === 'device') return { scope: null };
  if (credential.boxId) return { scope: credential.boxId };
  res.status(403).json({ error: 'This credential belongs to no box; run `termag login` to manage automations', code: 'box_scope' });
  return null;
}

export function mountCliAutomationRoutes(router: Router, automations: CliAutomations, bearer: RequestHandler): void {
  const ids = (res: Response, ...values: string[]): boolean => {
    if (values.every(v => ID_RE.test(v))) return true;
    badRequest(res, 'not an automation or run id');
    return false;
  };

  router.get('/automations', bearer, asyncHandler(async (_req, res) => {
    const s = scopeOf(res);
    if (s) send(res, await automations.list(cliAuth(res).user, s.scope));
  }));

  router.post('/automations', bearer, asyncHandler(async (req, res) => {
    const s = scopeOf(res);
    if (s) send(res, await automations.create(cliAuth(res).user, s.scope, bodyOf(req)));
  }));

  // Before /:id, which would otherwise take "preview" for an id. Reads nothing of anyone's.
  router.post('/automations/preview', bearer, asyncHandler(async (req, res) => {
    send(res, await automations.preview(cliAuth(res).user, bodyOf(req)));
  }));

  router.get('/automations/:id', bearer, asyncHandler(async (req, res) => {
    const s = scopeOf(res);
    if (s && ids(res, req.params.id)) send(res, await automations.detail(cliAuth(res).user, s.scope, req.params.id));
  }));

  router.patch('/automations/:id', bearer, asyncHandler(async (req, res) => {
    const s = scopeOf(res);
    if (s && ids(res, req.params.id)) send(res, await automations.update(cliAuth(res).user, s.scope, req.params.id, bodyOf(req)));
  }));

  router.post('/automations/:id/run', bearer, asyncHandler(async (req, res) => {
    const s = scopeOf(res);
    if (s && ids(res, req.params.id)) send(res, await automations.runNow(cliAuth(res).user, s.scope, req.params.id));
  }));

  router.post('/automations/:id/runs/:runId/stop', bearer, asyncHandler(async (req, res) => {
    const s = scopeOf(res);
    if (s && ids(res, req.params.id, req.params.runId)) {
      send(res, await automations.stopRun(cliAuth(res).user, s.scope, req.params.id, req.params.runId));
    }
  }));

  router.post('/automations/:id/runs/:runId/retire', bearer, asyncHandler(async (req, res) => {
    const s = scopeOf(res);
    if (s && ids(res, req.params.id, req.params.runId)) {
      send(res, await automations.retireRun(cliAuth(res).user, s.scope, req.params.id, req.params.runId));
    }
  }));

  router.get('/automations/:id/memory', bearer, asyncHandler(async (req, res) => {
    const s = scopeOf(res);
    if (s && ids(res, req.params.id)) send(res, await automations.memory(cliAuth(res).user, s.scope, req.params.id));
  }));

  router.delete('/automations/:id', bearer, asyncHandler(async (req, res) => {
    const s = scopeOf(res);
    if (s && ids(res, req.params.id)) send(res, await automations.remove(cliAuth(res).user, s.scope, req.params.id));
  }));
}
