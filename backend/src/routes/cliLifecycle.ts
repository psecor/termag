/**
 * The CLI's lifecycle routes under /api/cli/v1 (milestone 2): box create,
 * start, stop, rename, terminate and auto-park settings; project create, rename,
 * archive and clone retry; workstream create and remove.
 *
 * Each route is a thin shell over a CliLifecycle, whose Prisma implementation
 * (routes/cliLifecyclePrisma.ts) calls the same functions the cookie routes
 * use. What lives here is what the CLI surface adds: input checks and which
 * credential may do what. A box's own token may do everything a device
 * sign-in can except terminate a box, and the one box it may terminate is one
 * it created: a box made with a box's credentials records that box as its
 * parent (Instance.parentInstanceId), so an agent can clean up the box it made
 * for an ask.
 */
import type { RequestHandler, Response, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import type { CliUser } from '../services/cliStore';
import { parseAskRef } from '../services/agentMessages';
import { resolveStartFrom } from '../services/projectTemplates';
import { CHAT_PROVIDER_ID, SELECTABLE_PROVIDER_IDS, isSelectableProvider } from '../providers/registry';
import type { CliWorkstreamRequest } from '../services/cliWorkstreams';
import type { CliAuth } from './cliApi';
import type { RouteResult } from './routeResult';

export interface CliLifecycle {
  /** parentInstanceId: the box whose credentials ask for it, null for a device sign-in. */
  createBox(user: CliUser, name: string, parentInstanceId: string | null): Promise<RouteResult>;
  /** The user's box's parent: undefined when the user has no such box. */
  boxParent(user: CliUser, boxId: string): Promise<string | null | undefined>;
  /**
   * The GitHub repository a project the user owns or shares is a checkout of,
   * for `from: <box>/<project>`: its recorded repoUrl, else its checkout's
   * origin, asked of the box.
   */
  projectRepoUrl(user: CliUser, box: string, project: string): Promise<{ repoUrl: string } | RouteResult>;
  powerBox(user: CliUser, boxId: string, action: 'start' | 'stop' | 'hibernate'): Promise<RouteResult>;
  /** The settings body of PATCH /api/instances/:id/lifecycle, passed through for the shared parser. */
  setBoxLifecycle(user: CliUser, boxId: string, settings: unknown): Promise<RouteResult>;
  removeBox(user: CliUser, boxId: string, confirmed: boolean): Promise<RouteResult>;
  renameBox(user: CliUser, boxId: string, name: string): Promise<RouteResult>;
  createProject(user: CliUser, input: { boxId: string; name: string; agent: string; repoUrl?: string }): Promise<RouteResult>;
  renameProject(user: CliUser, projectId: string, name: string): Promise<RouteResult>;
  archiveProject(user: CliUser, projectId: string): Promise<RouteResult>;
  /** A workstream in one of the user's own projects, as the web UI's Branch off… makes it. */
  createWorkstream(user: CliUser, projectId: string, input: CliWorkstreamRequest): Promise<RouteResult>;
  /**
   * force: remove a worktree with changes in it (git refuses otherwise), and
   * its branch unmerged; keepBranch: leave the branch whatever force says.
   */
  removeWorkstream(user: CliUser, projectId: string, name: string, opts: { force: boolean; keepBranch: boolean }): Promise<RouteResult>;
  /** The web UI's Retry on a failed clone (POST /api/projects/:id/clone/retry): 202 with the project, its `clone` restarted. */
  retryClone(user: CliUser, projectId: string): Promise<RouteResult>;
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
    const { user, credential } = cliAuth(res);
    send(res, await lifecycle.createBox(user, name, credential.kind === 'box' ? credential.boxId : null));
  }));

  // hibernate: the same rules as the web UI's (powerRequestError: a box
  // launched hibernation-capable; otherwise 409 with the reason).
  for (const action of ['start', 'stop', 'hibernate'] as const) {
    router.post(`/boxes/:id/${action}`, bearer, asyncHandler(async (req, res) => {
      send(res, await lifecycle.powerBox(cliAuth(res).user, req.params.id, action));
    }));
  }

  router.patch('/boxes/:id/lifecycle', bearer, asyncHandler(async (req, res) => {
    send(res, await lifecycle.setBoxLifecycle(cliAuth(res).user, req.params.id, req.body));
  }));

  router.post('/boxes/:id/rename', bearer, asyncHandler(async (req, res) => {
    const name = stringField(req.body, 'name');
    if (!name) { badRequest(res, 'name required'); return; }
    send(res, await lifecycle.renameBox(cliAuth(res).user, req.params.id, name));
  }));

  router.delete('/boxes/:id', bearer, asyncHandler(async (req, res) => {
    const { user, credential } = cliAuth(res);
    if (credential.kind === 'box' && (!credential.boxId || await lifecycle.boxParent(user, req.params.id) !== credential.boxId)) {
      res.status(403).json({
        error: "A box's own credentials can only terminate a box they created; run `termag box rm` where you've run `termag login`",
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
    const from = stringField(req.body, 'from');
    if (!from) { send(res, await lifecycle.createProject(cliAuth(res).user, { boxId, name, agent })); return; }
    const user = cliAuth(res).user;
    const start = resolveStartFrom(from);
    if (start.ok) { send(res, await lifecycle.createProject(user, { boxId, name, agent, repoUrl: start.repoUrl })); return; }
    // Template ids have no slash and repository URLs carry a scheme or `git@`,
    // so `<box>/<project>` can only mean another project to start from.
    const ref = parseAskRef(from);
    if (!ref || ref.workstream) { badRequest(res, `${start.error}, or <box>/<project>`); return; }
    const source = await lifecycle.projectRepoUrl(user, ref.box, ref.project);
    if (!('repoUrl' in source)) { send(res, source); return; }
    send(res, await lifecycle.createProject(user, { boxId, name, agent, repoUrl: source.repoUrl }));
  }));

  router.post('/projects/:id/rename', bearer, asyncHandler(async (req, res) => {
    const name = stringField(req.body, 'name');
    if (!name) { badRequest(res, 'name required'); return; }
    send(res, await lifecycle.renameProject(cliAuth(res).user, req.params.id, name));
  }));

  router.post('/projects/:id/archive', bearer, asyncHandler(async (req, res) => {
    send(res, await lifecycle.archiveProject(cliAuth(res).user, req.params.id));
  }));

  // `agent` replaces main's agent on the new workstream, as an agent spawn's
  // does (routes/workstreams.ts); the desktop sends claude-chat, the provider
  // its projects get, so nothing runs in the workstream's pane beside its
  // threads. The name rules are createWorkstreamFor's.
  router.post('/projects/:id/workstreams', bearer, asyncHandler(async (req, res) => {
    const name = stringField(req.body, 'name');
    if (!name) { badRequest(res, 'name required'); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.base !== undefined && typeof body.base !== 'string') { badRequest(res, 'base must be a string'); return; }
    const base = stringField(body, 'base');
    const agent = stringField(body, 'agent');
    if (body.agent !== undefined && (!agent || (!isSelectableProvider(agent) && agent !== CHAT_PROVIDER_ID))) {
      badRequest(res, `agent must be one of: ${[...SELECTABLE_PROVIDER_IDS, CHAT_PROVIDER_ID].join(', ')}`);
      return;
    }
    if (body.startFromOrigin !== undefined && typeof body.startFromOrigin !== 'boolean') {
      badRequest(res, 'startFromOrigin must be true or false');
      return;
    }
    send(res, await lifecycle.createWorkstream(cliAuth(res).user, req.params.id, {
      name,
      ...(base ? { base } : {}),
      ...(agent ? { agent } : {}),
      ...(body.startFromOrigin === true ? { startFromOrigin: true } : {}),
    }));
  }));

  router.delete('/projects/:id/workstreams/:name', bearer, asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { force?: unknown; keepBranch?: unknown };
    send(res, await lifecycle.removeWorkstream(cliAuth(res).user, req.params.id, req.params.name, {
      force: body.force === true,
      keepBranch: body.keepBranch === true,
    }));
  }));

  router.post('/projects/:id/clone/retry', bearer, asyncHandler(async (req, res) => {
    send(res, await lifecycle.retryClone(cliAuth(res).user, req.params.id));
  }));
}
