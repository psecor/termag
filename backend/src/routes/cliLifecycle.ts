/**
 * The CLI's lifecycle routes under /api/cli/v1 (milestone 2): box create,
 * start, stop and terminate; project create, rename and archive.
 *
 * Each route is a thin shell over a CliLifecycle, whose Prisma implementation
 * (routes/cliLifecyclePrisma.ts) calls the same functions the cookie routes
 * use. What lives here is what the CLI surface adds: input checks and which
 * credential may do what. A box's own token may do everything a device
 * sign-in can except terminate a box.
 */
import type { RequestHandler, Response, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import type { CliUser } from '../services/cliStore';
import type { CliAuth } from './cliApi';
import type { RouteResult } from './routeResult';

export interface CliLifecycle {
  createBox(user: CliUser, name: string): Promise<RouteResult>;
  powerBox(user: CliUser, boxId: string, action: 'start' | 'stop'): Promise<RouteResult>;
  removeBox(user: CliUser, boxId: string, confirmed: boolean): Promise<RouteResult>;
  createProject(user: CliUser, input: { boxId: string; name: string; agent: string }): Promise<RouteResult>;
  renameProject(user: CliUser, projectId: string, name: string): Promise<RouteResult>;
  archiveProject(user: CliUser, projectId: string): Promise<RouteResult>;
}

/**
 * A shared handler's failure, as the CLI sees it: its error message, a code
 * the CLI can branch on, and a box's live projects when that is the reason.
 * Everything else in the body is dropped.
 */
export function cliErrorResult(result: RouteResult): RouteResult {
  const body = (result.body ?? {}) as { error?: unknown; code?: unknown; projects?: unknown };
  const out: Record<string, unknown> = {
    error: typeof body.error === 'string' ? body.error : 'Request failed',
  };
  if (typeof body.code === 'string') out.code = body.code;
  else if (result.status === 409 && Array.isArray(body.projects)) out.code = 'has_projects';
  else if (result.status === 409) out.code = 'conflict';
  if (Array.isArray(body.projects)) {
    out.projects = (body.projects as Array<{ id: string; name: string }>).map(p => ({ id: p.id, name: p.name }));
  }
  return { status: result.status, body: out };
}

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

function send(res: Response, result: RouteResult): void {
  res.status(result.status).json(result.body);
}

function badRequest(res: Response, error: string): void {
  res.status(400).json({ error, code: 'invalid_request' });
}

function stringField(body: unknown, key: string): string | null {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function mountCliLifecycleRoutes(router: Router, lifecycle: CliLifecycle, bearer: RequestHandler): void {
  router.post('/boxes', bearer, asyncHandler(async (req, res) => {
    const name = stringField(req.body, 'name');
    if (!name) { badRequest(res, 'name required'); return; }
    send(res, await lifecycle.createBox(cliAuth(res).user, name));
  }));

  for (const action of ['start', 'stop'] as const) {
    router.post(`/boxes/:id/${action}`, bearer, asyncHandler(async (req, res) => {
      send(res, await lifecycle.powerBox(cliAuth(res).user, req.params.id, action));
    }));
  }

  router.delete('/boxes/:id', bearer, asyncHandler(async (req, res) => {
    const { user, credential } = cliAuth(res);
    if (credential.kind === 'box') {
      res.status(403).json({
        error: "A box's own credentials can't terminate boxes; run `termag box rm` where you've run `termag login`",
        code: 'forbidden',
      });
      return;
    }
    const confirmed = (req.body as { confirmed?: unknown } | undefined)?.confirmed === true;
    send(res, await lifecycle.removeBox(user, req.params.id, confirmed));
  }));

  router.post('/projects', bearer, asyncHandler(async (req, res) => {
    const boxId = stringField(req.body, 'boxId');
    const name = stringField(req.body, 'name');
    const agent = stringField(req.body, 'agent');
    if (!boxId || !name) { badRequest(res, 'boxId and name required'); return; }
    if (!agent) { badRequest(res, 'agent required'); return; }
    send(res, await lifecycle.createProject(cliAuth(res).user, { boxId, name, agent }));
  }));

  router.post('/projects/:id/rename', bearer, asyncHandler(async (req, res) => {
    const name = stringField(req.body, 'name');
    if (!name) { badRequest(res, 'name required'); return; }
    send(res, await lifecycle.renameProject(cliAuth(res).user, req.params.id, name));
  }));

  router.post('/projects/:id/archive', bearer, asyncHandler(async (req, res) => {
    send(res, await lifecycle.archiveProject(cliAuth(res).user, req.params.id));
  }));
}
