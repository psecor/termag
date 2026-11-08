/**
 * Environments under /api/cli/v1, for
 * `termag environment`: the browser's own actions (routes/environments.ts
 * environmentActions), so the same validation, refusals and audit events.
 * An environment is named by its name (or id). A device sign-in acts as its
 * person, who the event records. A box's own credential reads only: anything
 * an agent on a box runs could otherwise rewrite a shared environment that
 * other people's asks clone, so create, edit and delete answer 403 to it.
 *
 *   GET    /environments                 every environment
 *   POST   /environments                 create (not with a box's credential)
 *   POST   /environments/validate        check an inline definition, nothing stored
 *   GET    /environments/:ref            one
 *   GET    /environments/:ref/events     its history, newest first
 *   GET    /environments/:ref/resolved   what it resolves to now (repositories, size, warnings)
 *   PUT    /environments/:ref            edit (not with a box's credential)
 *   DELETE /environments/:ref            delete (not with a box's credential)
 */
import type { RequestHandler, Response, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import type { CliAuth } from './cliApi';
import { environmentActions, type EnvironmentsDeps } from './environments';
import { sendResult } from './routeResult';

function userId(res: Response): string {
  return (res.locals.cliAuth as CliAuth).user.id;
}

/** A write's guard: a box's own credential is refused, a device sign-in passes. */
const notFromBox: RequestHandler = (_req, res, next) => {
  if ((res.locals.cliAuth as CliAuth).credential.kind !== 'box') { next(); return; }
  res.status(403).json({
    error: "A box can't create, edit or delete environments: change them from the web UI, or with `termag login` on your own machine",
    code: 'environment_box_read_only',
  });
};

export function mountCliEnvironmentRoutes(router: Router, deps: EnvironmentsDeps | undefined, bearer: RequestHandler): void {
  const act = environmentActions(deps);
  router.get('/environments', bearer, asyncHandler(async (_req, res) => { sendResult(res, await act.list(userId(res))); }));
  router.post('/environments', bearer, notFromBox, asyncHandler(async (req, res) => { sendResult(res, await act.create(userId(res), req.body)); }));
  router.post('/environments/validate', bearer, asyncHandler(async (req, res) => { sendResult(res, act.validate(req.body)); }));
  router.get('/environments/:ref', bearer, asyncHandler(async (req, res) => { sendResult(res, await act.get(userId(res), req.params.ref)); }));
  router.get('/environments/:ref/events', bearer, asyncHandler(async (req, res) => { sendResult(res, await act.events(userId(res), req.params.ref)); }));
  router.post('/environments/:ref/visibility', bearer, notFromBox, asyncHandler(async (req, res) => {
    const body = req.body as { visibility?: unknown; updatedAt?: unknown } | undefined;
    sendResult(res, await act.setVisibility(userId(res), req.params.ref, body?.visibility, body?.updatedAt));
  }));
  router.get('/environments/:ref/resolved', bearer, asyncHandler(async (req, res) => { sendResult(res, await act.resolved(userId(res), req.params.ref)); }));
  router.put('/environments/:ref', bearer, notFromBox, asyncHandler(async (req, res) => { sendResult(res, await act.update(userId(res), req.params.ref, req.body)); }));
  router.delete('/environments/:ref', bearer, notFromBox, asyncHandler(async (req, res) => {
    sendResult(res, await act.remove(userId(res), req.params.ref, (req.body as { updatedAt?: unknown } | undefined)?.updatedAt ?? req.query.updatedAt));
  }));
}
