/**
 * The CLI's lifecycle routes under /api/cli/v1 (milestone 2): box create,
 * start, stop, rename, resize, terminate and auto-park settings; project create, rename,
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
import { parseClaudeChatModel, type ClaudeChatTier } from '../services/claudeChatModel';
import { isClaudeCode } from '../services/modelChoices';
import type { CliWorkstreamRequest } from '../services/cliWorkstreams';
import type { CliAuth } from './cliApi';
import type { RouteResult } from './routeResult';

/** What a box or project was made for, when its creator says: only asks so far. */
export type CreatedFor = 'ask';

/**
 * `model` in a project create body (`termag project create --model`, `termag
 * ask --new-box --model`): the Claude tier the project's main workstream
 * starts on (Workflow.model), its agent pane and its chat alike. Absent is
 * none (Sonnet in the chat, Claude Code's default in a pane); only for
 * Claude Code's agents.
 */
export function parseProjectModel(body: unknown, agent: string): { model: ClaudeChatTier | null } | { error: string } {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).model : undefined;
  const parsed = parseClaudeChatModel(raw);
  if (!parsed.ok) return { error: parsed.error };
  if (parsed.model && !isClaudeCode(agent)) return { error: `model is a Claude model; ${agent} is not Claude Code` };
  return { model: parsed.model };
}

/** `createdFor` in a create body: absent is null; anything but a known purpose is an error. */
export function parseCreatedFor(body: unknown): { createdFor: CreatedFor | null } | { error: string } {
  const v = body && typeof body === 'object' ? (body as Record<string, unknown>).createdFor : undefined;
  if (v === undefined || v === null || v === '') return { createdFor: null };
  return v === 'ask' ? { createdFor: 'ask' } : { error: 'createdFor must be "ask"' };
}

/**
 * The CLI's create-body fields, as the routes (and the CLI test's fake)
 * pass them. Each optional field rides only when the request carried it, so
 * a 1.x CLI's request shapes a 2.x createBox call exactly as its own did.
 * `flavor` round-trips as typed: services/boxFlavor's `flavorOf` is what
 * decides a 'minimal' from anything fuzzed.
 */
export interface CliCreateBoxInput {
  name: string;
  size?: string;
  diskGiB?: number;
  repoUrls?: string[];
  flavor?: unknown;
  /** An environment's name instead of repoUrls: its one file sizes the box. */
  environment?: string;
  /** termag setup (services/boxSetup.ts): false turns it off. */
  setupEnabled?: unknown;
  /** The CLI states the repos' environment.json setupEnabled, so createBox may apply it. */
  useRepoSetup?: boolean;
}

export interface CliLifecycle {
  /**
   * parentInstanceId: the box whose credentials ask for it, null for a device
   * sign-in. size: as sent, validated by createBox (services/boxSize.ts);
   * repoUrls: the repositories a project made with it starts from, for its size.
   * diskGiB: as sent, a number createBox checks the range of (services/boxDiskSize.ts).
   * setupEnabled: services/boxSetup.ts, passed through unchecked; useRepoSetup:
   * the CLI states the repos' setupEnabled, so createBox may apply it.
   * The fields are CliCreateBoxInput (below) — the body their POST carries,
   * one field per concept.
   */
  createBox(user: CliUser, input: CliCreateBoxInput, parentInstanceId: string | null, createdFor?: CreatedFor | null): Promise<RouteResult>;
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
  /** Keep running: restart the box's idle clock. Never for a box's own credential (the route refuses those). */
  keepBoxRunning(user: CliUser, boxId: string): Promise<RouteResult>;
  /** What the user's boxes cost today (services/boxCost/owner.ts). Never for a box's own credential. */
  boxCosts(user: CliUser): Promise<RouteResult>;
  removeBox(user: CliUser, boxId: string, confirmed: boolean): Promise<RouteResult>;
  renameBox(user: CliUser, boxId: string, name: string): Promise<RouteResult>;
  /** GET /api/instances/:id/resize's answer: the sizes, the current or last resize, a refusal and what runs on the box. */
  resizeInfo(user: CliUser, boxId: string): Promise<RouteResult>;
  /** GET /api/instances/sizes's answer for a new box: the sizes and the one to preselect; `repo` is the query's, as sent. */
  boxSizes(user: CliUser, repo: unknown): Promise<RouteResult>;
  /** POST /api/instances/:id/resize's checks and job (services/boxResize.ts): 202 with the box and its resize. */
  resizeBox(user: CliUser, boxId: string, input: { size: string; force: boolean }): Promise<RouteResult>;
  /** POST /api/instances/:id/disk's checks and grow (services/boxDisk.ts): 202 with the box and its grow. */
  growBoxDisk(user: CliUser, boxId: string, input: { sizeGb: number }): Promise<RouteResult>;
  /**
   * createdFor: what the project was made for ('ask'), recorded on it; marks a
   * project that already existed too. repoUrls: two or more, a multi-repo
   * project (instead of repoUrl). environment: an environment's name, whose
   * repositories the project holds (instead of either).
   */
  createProject(user: CliUser, input: { boxId: string; name: string; agent: string; repoUrl?: string; repoUrls?: string[]; environment?: string; environmentRepos?: unknown; createdFor?: CreatedFor | null; chatSpace?: string | null; model?: ClaudeChatTier }): Promise<RouteResult>;
  renameProject(user: CliUser, projectId: string, name: string): Promise<RouteResult>;
  archiveProject(user: CliUser, projectId: string): Promise<RouteResult>;
  /** A workstream in one of the user's own projects, as the web UI's Branch off… makes it. */
  createWorkstream(user: CliUser, projectId: string, input: CliWorkstreamRequest): Promise<RouteResult>;
  /**
   * force: remove a worktree with changes in it (git refuses otherwise), and
   * its branch unmerged; keepBranch: leave the branch whatever force says.
   */
  removeWorkstream(user: CliUser, projectId: string, name: string, opts: { force: boolean; keepBranch: boolean }): Promise<RouteResult>;
  /**
   * The web UI's Retry on a failed clone (POST /api/projects/:id/clone/retry): 202 with the project, its `clone` restarted.
   * opts.setupEnabled: a relaunched box's termag setup, over the failed box's.
   */
  retryClone(user: CliUser, projectId: string, opts?: { setupEnabled?: boolean }): Promise<RouteResult>;
}

/**
 * A shared handler's failure, as the CLI sees it: its error message, a code
 * the CLI can branch on, a box's live projects when that is the reason, and
 * a resize's blockers. Everything else in the body is dropped.
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
  // A busy box's resize refusal: what blocks it, and whether --force would go ahead.
  const busy = result.body as { blockers?: unknown; forceable?: unknown } | null;
  if (Array.isArray(busy?.blockers)) {
    out.blockers = (busy!.blockers as Array<{ check: string; reason: string; forceable: boolean }>)
      .map(b => ({ check: b.check, reason: b.reason, forceable: b.forceable }));
  }
  if (typeof busy?.forceable === 'boolean') out.forceable = busy.forceable;
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

/**
 * New session's space for the session a create starts (services/chatSpace.ts),
 * as the web form sends it: a space name, or null for No space. Absent, the
 * session gets its box's first grant at first use, as any other does.
 */
function chatSpaceField(body: unknown): { chatSpace?: string | null } | { error: string } {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>).chatSpace : undefined;
  if (value === undefined) return {};
  if (value === null) return { chatSpace: null };
  if (typeof value !== 'string' || !value.trim()) return { error: 'chatSpace must be a space name or null' };
  return { chatSpace: value.trim() };
}

function stringField(body: unknown, key: string): string | null {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A `from`'s repository: a template's, a GitHub URL, or another project's (`<box>/<project>`). */
async function repoUrlFrom(lifecycle: CliLifecycle, user: CliUser, from: string): Promise<{ repoUrl: string } | RouteResult> {
  const start = resolveStartFrom(from);
  if (start.ok) return { repoUrl: start.repoUrl };
  // Template ids have no slash and repository URLs carry a scheme or `git@`,
  // so `<box>/<project>` can only mean another project to start from.
  const ref = parseAskRef(from);
  if (!ref || ref.workstream) return { status: 400, body: { error: `${start.error}, or <box>/<project>`, code: 'invalid_request' } };
  return lifecycle.projectRepoUrl(user, ref.box, ref.project);
}

/**
 * `environment` in a body (`--environment <name>`): the name, or none. It
 * names the repositories itself, so it goes without `from`.
 */
function environmentField(body: unknown, froms: readonly string[]): { environment?: string } | { error: string } {
  const value = (body as Record<string, unknown> | undefined)?.environment;
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string' || !value.trim()) return { error: 'environment must be an environment name' };
  if (froms.length) return { error: 'environment names the repositories itself; leave out from' };
  return { environment: value.trim() };
}

/** The most repositories a project holds. */
const MAX_FROMS = 8;

/**
 * `from` in a body: one source, or a list of them for a multi-repo project
 * (`termag ask --new-box --from a --from b`); an empty list is none.
 */
function fromField(body: unknown): { froms: string[] } | { error: string } {
  const value = (body as Record<string, unknown> | undefined)?.from;
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return { froms: [] };
  const list = Array.isArray(value) ? value : [value];
  if (!list.every(v => typeof v === 'string' && v.trim())) return { error: 'from must be a source, or a list of them' };
  if (list.length > MAX_FROMS) return { error: `from takes at most ${MAX_FROMS} sources` };
  return { froms: (list as string[]).map(v => v.trim()) };
}

/** Each `from`'s repository, in order, or the first refusal. */
async function repoUrlsFrom(lifecycle: CliLifecycle, user: CliUser, froms: readonly string[]): Promise<{ repoUrls: string[] } | RouteResult> {
  const repoUrls: string[] = [];
  for (const from of froms) {
    const source = await repoUrlFrom(lifecycle, user, from);
    if (!('repoUrl' in source)) return source;
    repoUrls.push(source.repoUrl);
  }
  return { repoUrls };
}

export function mountCliLifecycleRoutes(router: Router, lifecycle: CliLifecycle, bearer: RequestHandler): void {
  // `size`: small, medium or large. `from`: what the project made on it will
  // start from (`project create --new-box --from`), resolved as POST
  // /projects does, so the box gets that repository's size; a list of them
  // for a multi-repo project, whose largest the box takes. `diskGiB`: the
  // root disk (`--disk`), else the repositories' or the default. `environment`: an
  // environment's name instead, whose one file sizes the box.
  router.post('/boxes', bearer, asyncHandler(async (req, res) => {
    const name = stringField(req.body, 'name');
    if (!name) { badRequest(res, 'name required'); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.size !== undefined && typeof body.size !== 'string') { badRequest(res, 'size must be a string'); return; }
    const size = stringField(body, 'size') ?? undefined;
    if (body.diskGiB !== undefined && typeof body.diskGiB !== 'number') { badRequest(res, 'diskGiB must be a number'); return; }
    const diskGiB = body.diskGiB as number | undefined;
    const purpose = parseCreatedFor(req.body);
    if ('error' in purpose) { badRequest(res, purpose.error); return; }
    const { user, credential } = cliAuth(res);
    const from = fromField(body);
    if ('error' in from) { badRequest(res, from.error); return; }
    const env = environmentField(body, from.froms);
    if ('error' in env) { badRequest(res, env.error); return; }
    const sources = await repoUrlsFrom(lifecycle, user, from.froms);
    if (!('repoUrls' in sources)) { send(res, sources); return; }

    // The request, restated as the create input — one named field per line,
    // each sent only when the CLI sent it, so a 1.x CLI's request makes
    // exactly the createBox call its own shape did (cliLifecycle.test pins
    // this shape field by field).
    const input: CliCreateBoxInput = { name };
    if (size !== undefined) input.size = size;
    if (diskGiB !== undefined) input.diskGiB = diskGiB;
    if (body.flavor !== undefined) input.flavor = body.flavor;
    if (sources.repoUrls.length > 0) input.repoUrls = sources.repoUrls;
    if (env.environment) input.environment = env.environment;
    // termag setup: as sent, and whether the CLI states the repos' setting.
    const { setupEnabled, useRepoSetup } = body as { setupEnabled?: unknown; useRepoSetup?: unknown };
    if (setupEnabled !== undefined) input.setupEnabled = setupEnabled;
    if (useRepoSetup === true) input.useRepoSetup = true;
    send(res, await lifecycle.createBox(user, input, credential.kind === 'box' ? credential.boxId : null, purpose.createdFor));
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

  // Keep running is a person saying they are using the box. A box's own
  // credential (an agent on a box) can't say that, or an agent could keep
  // every box of its owner up for good.
  router.post('/boxes/:id/keep-running', bearer, asyncHandler(async (req, res) => {
    const { user, credential } = cliAuth(res);
    if (credential.kind === 'box') {
      res.status(403).json({ error: 'Keep running needs your own sign-in (termag login), not a box credential', code: 'box_credential' });
      return;
    }
    send(res, await lifecycle.keepBoxRunning(user, req.params.id));
  }));

  // A box's cost is its owner's to see, not an agent's on one of their boxes.
  router.get('/boxes/cost', bearer, asyncHandler(async (_req, res) => {
    const { user, credential } = cliAuth(res);
    if (credential.kind === 'box') {
      res.status(403).json({ error: "A box's cost needs your own sign-in (termag login), not a box credential", code: 'box_credential' });
      return;
    }
    send(res, await lifecycle.boxCosts(user));
  }));

  router.post('/boxes/:id/rename', bearer, asyncHandler(async (req, res) => {
    const name = stringField(req.body, 'name');
    if (!name) { badRequest(res, 'name required'); return; }
    send(res, await lifecycle.renameBox(cliAuth(res).user, req.params.id, name));
  }));

  // The New box pickers' sizes; `?repo=` once per repository the box is for.
  router.get('/boxes/sizes', bearer, asyncHandler(async (req, res) => {
    send(res, await lifecycle.boxSizes(cliAuth(res).user, req.query.repo));
  }));

  // Reading is harmless, so any credential of the owner's may: what Resize… shows.
  router.get('/boxes/:id/resize', bearer, asyncHandler(async (req, res) => {
    send(res, await lifecycle.resizeInfo(cliAuth(res).user, req.params.id));
  }));

  // A box's own credential may resize only a box it created, as for terminate:
  // resizing stops the box, and an agent must not stop its own or another's.
  router.post('/boxes/:id/resize', bearer, asyncHandler(async (req, res) => {
    const size = stringField(req.body, 'size');
    if (!size) { badRequest(res, 'size required (small, medium or large)'); return; }
    const { user, credential } = cliAuth(res);
    if (credential.kind === 'box' && (!credential.boxId || await lifecycle.boxParent(user, req.params.id) !== credential.boxId)) {
      res.status(403).json({
        error: "A box's own credentials can only resize a box they created; run `termag box resize` where you've run `termag login`",
        code: 'forbidden',
      });
      return;
    }
    const force = (req.body as { force?: unknown } | undefined)?.force === true;
    send(res, await lifecycle.resizeBox(user, req.params.id, { size, force }));
  }));

  // Growing the disk doesn't stop the box, but it is the owner's to pay for: a
  // box's own credential grows only a box it created, as for resize.
  router.post('/boxes/:id/disk', bearer, asyncHandler(async (req, res) => {
    const sizeGb = (req.body as { sizeGb?: unknown } | undefined)?.sizeGb;
    if (typeof sizeGb !== 'number' || !Number.isInteger(sizeGb)) { badRequest(res, 'sizeGb required (a whole number of GB)'); return; }
    const { user, credential } = cliAuth(res);
    if (credential.kind === 'box' && (!credential.boxId || await lifecycle.boxParent(user, req.params.id) !== credential.boxId)) {
      res.status(403).json({
        error: "A box's own credentials can only grow the disk of a box they created; run `termag box resize --disk` where you've run `termag login`",
        code: 'forbidden',
      });
      return;
    }
    send(res, await lifecycle.growBoxDisk(user, req.params.id, { sizeGb }));
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
    const purpose = parseCreatedFor(req.body);
    if ('error' in purpose) { badRequest(res, purpose.error); return; }
    // Only named when given, so a plain create passes what it always did.
    const createdFor = purpose.createdFor ? { createdFor: purpose.createdFor } : {};
    const from = fromField(req.body);
    if ('error' in from) { badRequest(res, from.error); return; }
    const env = environmentField(req.body, from.froms);
    if ('error' in env) { badRequest(res, env.error); return; }
    const space = chatSpaceField(req.body);
    if ('error' in space) { badRequest(res, space.error); return; }
    const picked = parseProjectModel(req.body, agent);
    if ('error' in picked) { badRequest(res, picked.error); return; }
    const model = picked.model ? { model: picked.model } : {};
    const user = cliAuth(res).user;
    // An environment's checkouts as the caller read them (an ask's must be: services/environments.ts withEnvironmentRepos).
    const pin = 'environment' in env && env.environment && (req.body as Record<string, unknown>)?.environmentRepos !== undefined
      ? { environmentRepos: (req.body as Record<string, unknown>).environmentRepos } : {};
    if (!from.froms.length) { send(res, await lifecycle.createProject(user, { boxId, name, agent, ...env, ...pin, ...createdFor, ...space, ...model })); return; }
    const sources = await repoUrlsFrom(lifecycle, user, from.froms);
    if (!('repoUrls' in sources)) { send(res, sources); return; }
    // Several sources: a multi-repo project holding exactly those repositories.
    const repos = sources.repoUrls.length > 1 ? { repoUrls: sources.repoUrls } : { repoUrl: sources.repoUrls[0] };
    send(res, await lifecycle.createProject(user, { boxId, name, agent, ...repos, ...createdFor, ...space, ...model }));
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
    const space = chatSpaceField(body);
    if ('error' in space) { badRequest(res, space.error); return; }
    send(res, await lifecycle.createWorkstream(cliAuth(res).user, req.params.id, {
      name,
      ...(base ? { base } : {}),
      ...(agent ? { agent } : {}),
      ...(body.startFromOrigin === true ? { startFromOrigin: true } : {}),
      ...space,
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
    const setupEnabled = (req.body as { setupEnabled?: unknown } | undefined)?.setupEnabled;
    send(res, await lifecycle.retryClone(cliAuth(res).user, req.params.id, typeof setupEnabled === 'boolean' ? { setupEnabled } : {}));
  }));
}
