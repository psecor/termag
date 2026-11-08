/**
 * /api/environments: list, read, create, edit and
 * delete; `GET /events` is the audit log (every environment's changes, newest
 * first, `?environment=<id>` for one), `POST /validate` checks an inline
 * definition without saving it, and `GET /:id/resolved` what an
 * environment resolves to now for the caller (its repositories and size, a
 * pointer's file read from GitHub), and `GET /:id/pool` its environment pool. `POST /:id/visibility` makes one personal
 * or shared. A personal environment is its owner's alone: anyone else gets 404
 * for it everywhere, history included. A shared one is everyone's to use and
 * edit, and keeps to the shared rules (services/environments.ts
 * sharedRuleError) on every save; only its owner switches it. The store
 * writes the audit event with every change.
 *
 * An edit or delete may send the `updatedAt` it was made from; when the
 * environment has changed since, it answers 409 `environment_changed` rather
 * than overwrite someone else's edit.
 */
import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import {
  fieldsOf, legacyVisibility, MAX_EVENTS, parseDefinition, parseEnvironmentInput, prismaEnvironmentStore, resolveStoredEnvironment, sharedRuleError, visibleTo,
  type DefaultBranchReader, type EnvironmentEventRecord, type EnvironmentRecord, type EnvironmentResolver, type EnvironmentStore,
  type EnvironmentVisibility, type EnvironmentWrite,
} from '../services/environments';
import { repoEnvironment } from '../services/repoEnvironment';
import type { EnvPoolView } from '../services/envPool';
import { sendResult, type RouteResult } from './routeResult';

export interface EnvironmentPerson { id: string; email: string; name: string }

export interface EnvironmentsDeps {
  store: EnvironmentStore;
  /** The people named by these ids, for "who"; an id with no user left is absent. */
  people(ids: string[]): Promise<EnvironmentPerson[]>;
  /** What an environment resolves to for a user (services/environments.ts). */
  resolve?: EnvironmentResolver;
  /** The default branches and files the shared rules read (services/repoEnvironment.ts). */
  github?: DefaultBranchReader;
  /** An environment's pool (services/envPool.ts envPoolView): null when it has none. */
  pool?: (environmentId: string, name: string) => Promise<EnvPoolView | null>;
}

const prismaPeople = async (ids: string[]): Promise<EnvironmentPerson[]> => {
  if (!ids.length) return [];
  const rows = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, googleEmail: true, displayName: true } });
  return rows.map(r => ({ id: r.id, email: r.googleEmail, name: r.displayName }));
};

function view(e: EnvironmentRecord, who: Map<string, EnvironmentPerson>) {
  return {
    id: e.id, ...fieldsOf(e), visibility: e.visibility,
    owner: (e.ownerUserId && who.get(e.ownerUserId)) || null,
    createdAt: e.createdAt.toISOString(), updatedAt: e.updatedAt.toISOString(),
    createdBy: (e.createdByUserId && who.get(e.createdByUserId)) || null,
    updatedBy: (e.updatedByUserId && who.get(e.updatedByUserId)) || null,
  };
}

function eventView(e: EnvironmentEventRecord, who: Map<string, EnvironmentPerson>) {
  return {
    id: e.id, at: e.at.toISOString(), action: e.action, actor: who.get(e.actorUserId) ?? null,
    environmentId: e.environmentId, environmentName: e.after?.name ?? e.before?.name ?? null, before: e.before, after: e.after,
  };
}

async function peopleMap(deps: EnvironmentsDeps, ids: Array<string | null>): Promise<Map<string, EnvironmentPerson>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  return new Map((await deps.people(unique)).map(p => [p.id, p]));
}

/** An edit's or delete's `updatedAt`: undefined without one, null for one that isn't a time. */
function expected(body: unknown): Date | undefined | null {
  const raw = (body as Record<string, unknown> | undefined)?.updatedAt;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const d = typeof raw === 'string' ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

async function written(deps: EnvironmentsDeps, w: EnvironmentWrite, status: number, name?: string): Promise<RouteResult> {
  if (w.ok) {
    const who = await peopleMap(deps, [w.environment.createdByUserId, w.environment.updatedByUserId, w.environment.ownerUserId]);
    return { status, body: { environment: view(w.environment, who), changed: w.changed } };
  }
  if (w.reason === 'not_found') return { status: 404, body: { error: 'No such environment', code: 'environment_not_found' } };
  if (w.reason === 'name_taken') return { status: 409, body: { error: `An environment named "${name}" already exists`, code: 'environment_name_taken' } };
  return { status: 409, body: { error: 'Someone changed this environment since you opened it; reload to see their change', code: 'environment_changed' } };
}

/** What an environment is named by: its id, or (the CLI's) its name. */
async function findEnvironment(store: EnvironmentStore, ref: string): Promise<EnvironmentRecord | null> {
  return (await store.get(ref)) ?? (await store.byName(ref));
}

const NOT_FOUND: RouteResult = { status: 404, body: { error: 'No such environment', code: 'environment_not_found' } };

/** An environment `userId` may see: a shared one, or their own personal one; null for none, or someone else's. */
async function findVisible(store: EnvironmentStore, ref: string, userId: string): Promise<EnvironmentRecord | null> {
  const env = await findEnvironment(store, ref);
  return env && visibleTo(env, userId) ? env : null;
}

/** A body's `visibility`: personal or shared, `undefined` when it names none, null for anything else. */
function visibilityOf(body: unknown): EnvironmentVisibility | undefined | null {
  const v = (body as Record<string, unknown> | undefined)?.visibility;
  if (v === undefined || v === null || v === '') return undefined;
  return v === 'personal' || v === 'shared' ? v : null;
}

const BAD_VISIBILITY: RouteResult = { status: 400, body: { error: 'visibility is personal or shared', code: 'invalid_request' } };
const notShareable = (error: string): RouteResult => ({ status: 400, body: { error, code: 'environment_not_shareable' } });

/**
 * Every environment route as a function of who asks and what they sent,
 * shared by the browser's /api/environments (environmentsRouter) and the
 * CLI's /api/cli/v1/environments (routes/cliEnvironments.ts), so both
 * validate, refuse and record the same. A `ref` is an id or a name.
 */
export function environmentActions(deps: EnvironmentsDeps = { store: prismaEnvironmentStore, people: prismaPeople }) {
  const { store } = deps;
  const resolve = deps.resolve ?? resolveStoredEnvironment;
  const github = deps.github ?? repoEnvironment;
  return {
    /** The caller's personal environments, then the shared ones, each by name; nobody else's personal ones. */
    async list(userId: string): Promise<RouteResult> {
      const byName = (a: EnvironmentRecord, b: EnvironmentRecord) => a.name.localeCompare(b.name);
      const all = (await store.list()).filter(e => visibleTo(e, userId));
      const list = [...all.filter(e => e.visibility === 'personal').sort(byName), ...all.filter(e => e.visibility === 'shared').sort(byName)];
      const who = await peopleMap(deps, list.flatMap(e => [e.createdByUserId, e.updatedByUserId, e.ownerUserId]));
      return { status: 200, body: { environments: list.map(e => view(e, who)) } };
    },
    /** An inline definition checked as a save would check it, nothing stored: the editor's check on blur. */
    validate(body: unknown): RouteResult {
      const d = parseDefinition((body as { definition?: unknown } | undefined)?.definition);
      return { status: 200, body: { errors: d.ok ? [] : d.error.split('; ') } };
    },
    /**
     * Newest first, at most MAX_EVENTS: one environment's (by id or name, a deleted one's by id), else every one's.
     * Never an event of someone else's personal environment. An environment there is says whose its events are; a
     * deleted one's event says it itself, and one written with no visibility is read as legacyVisibility reads its
     * fields, a personal one its actor's. Read page by page until MAX_EVENTS are shown, so other people's personal
     * events never crowd the shared ones out.
     */
    async events(userId: string, ref: string | null): Promise<RouteResult> {
      const id = ref ? (await findEnvironment(store, ref))?.id ?? ref : null;
      const current = new Map((await store.list()).map(e => [e.id, e]));
      const shown = (e: EnvironmentEventRecord): boolean => {
        const env = current.get(e.environmentId);
        if (env) return visibleTo(env, userId);
        const snap = e.after ?? e.before;
        if (!snap) return false;
        if (snap.visibility) return snap.visibility === 'shared' || snap.ownerUserId === userId;
        const file = snap.kind === 'pointer' ? snap.file : null;
        return legacyVisibility({ kind: snap.kind, fileBranch: file?.branch ?? null }) === 'shared' || e.actorUserId === userId;
      };
      const events: EnvironmentEventRecord[] = [];
      for (let skip = 0; events.length < MAX_EVENTS; skip += MAX_EVENTS) {
        const page = await store.events(id, MAX_EVENTS, skip);
        events.push(...page.filter(shown));
        if (page.length < MAX_EVENTS) break;
      }
      events.splice(MAX_EVENTS);
      const who = await peopleMap(deps, events.map(e => e.actorUserId));
      return { status: 200, body: { events: events.map(e => eventView(e, who)) } };
    },
    async get(userId: string, ref: string): Promise<RouteResult> {
      const env = await findVisible(store, ref, userId);
      if (!env) return NOT_FOUND;
      const who = await peopleMap(deps, [env.createdByUserId, env.updatedByUserId, env.ownerUserId]);
      return { status: 200, body: { environment: view(env, who) } };
    },
    /**
     * Its environment pool: how many boxes are ready, when the newest
     * was prepared and at which commits, and the last prepare failure with its log. `pool: null` when it has none.
     */
    async pool(userId: string, ref: string): Promise<RouteResult> {
      const env = await findVisible(store, ref, userId);
      if (!env) return NOT_FOUND;
      if (env.visibility !== 'shared') return { status: 200, body: { pool: null } };
      // Loaded on use: the pool's module reaches the warm pool, AWS and the agent registry.
      const view = deps.pool ?? (await import('../services/envPool')).envPoolView;
      return { status: 200, body: { pool: await view(env.id, env.name) } };
    },
    async resolved(userId: string, ref: string): Promise<RouteResult> {
      const env = await findVisible(store, ref, userId);
      if (!env) return NOT_FOUND;
      if (env.visibility === 'shared') {
        const broken = await sharedRuleError(userId, env, github);
        if (broken) return notShareable(`${env.name}: ${broken}`);
      }
      const r = await resolve(userId, env);
      return { status: 200, body: { repos: r.repos, size: r.sizes?.size ?? null, warnings: r.warnings } };
    },
    /** Personal unless the body says `visibility: 'shared'`, which the shared rules must allow. */
    async create(userId: string, body: unknown): Promise<RouteResult> {
      const parsed = parseEnvironmentInput(body);
      if (!parsed.ok) return { status: 400, body: { error: parsed.error, code: 'invalid_environment' } };
      const visibility = visibilityOf(body);
      if (visibility === null) return BAD_VISIBILITY;
      if (visibility === 'shared') {
        const broken = await sharedRuleError(userId, parsed.fields, github);
        if (broken) return notShareable(broken);
      }
      return written(deps, await store.create(userId, parsed.fields, visibility ?? 'personal'), 201, parsed.fields.name);
    },
    async update(userId: string, ref: string, body: unknown): Promise<RouteResult> {
      const parsed = parseEnvironmentInput(body);
      if (!parsed.ok) return { status: 400, body: { error: parsed.error, code: 'invalid_environment' } };
      const since = expected(body);
      if (since === null) return { status: 400, body: { error: 'updatedAt must be a time', code: 'invalid_request' } };
      const env = await findVisible(store, ref, userId);
      if (!env) return NOT_FOUND;
      // Anyone may edit a shared one, but its file pointer keeps to the shared rules.
      if (env.visibility === 'shared') {
        const broken = await sharedRuleError(userId, parsed.fields, github);
        if (broken) return notShareable(broken);
      }
      return written(deps, await store.update(userId, env.id, parsed.fields, since), 200, parsed.fields.name);
    },
    /** Personal or shared: the owner's switch, checked against the shared rules to share. */
    async setVisibility(userId: string, ref: string, visibility: unknown, updatedAt?: unknown): Promise<RouteResult> {
      const v = visibilityOf({ visibility });
      if (!v) return BAD_VISIBILITY;
      const since = expected({ updatedAt });
      if (since === null) return { status: 400, body: { error: 'updatedAt must be a time', code: 'invalid_request' } };
      const env = await findVisible(store, ref, userId);
      if (!env) return NOT_FOUND;
      if (env.ownerUserId !== userId) return { status: 403, body: { error: `Only ${env.name}'s owner makes it personal or shared`, code: 'environment_not_owner' } };
      if (v === 'shared') {
        const broken = await sharedRuleError(userId, env, github);
        if (broken) return notShareable(broken);
      }
      return written(deps, await store.setVisibility(userId, env.id, v, since), 200);
    },
    async remove(userId: string, ref: string, updatedAt: unknown): Promise<RouteResult> {
      const since = expected({ updatedAt });
      if (since === null) return { status: 400, body: { error: 'updatedAt must be a time', code: 'invalid_request' } };
      const env = await findVisible(store, ref, userId);
      if (!env) return NOT_FOUND;
      return written(deps, await store.remove(userId, env.id, since), 200);
    },
  };
}

export function environmentsRouter(deps: EnvironmentsDeps = { store: prismaEnvironmentStore, people: prismaPeople }): Router {
  const router = Router();
  const act = environmentActions(deps);
  router.get('/', requireAuth, asyncHandler(async (req, res) => { sendResult(res, await act.list(req.user!.id)); }));
  router.post('/validate', requireAuth, asyncHandler(async (req, res) => { sendResult(res, act.validate(req.body)); }));
  // The audit log: before /:id so it isn't taken as one.
  router.get('/events', requireAuth, asyncHandler(async (req, res) => {
    sendResult(res, await act.events(req.user!.id, typeof req.query.environment === 'string' && req.query.environment ? req.query.environment : null));
  }));
  router.get('/:id', requireAuth, asyncHandler(async (req, res) => { sendResult(res, await act.get(req.user!.id, req.params.id)); }));
  router.post('/:id/visibility', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body as { visibility?: unknown; updatedAt?: unknown } | undefined;
    sendResult(res, await act.setVisibility(req.user!.id, req.params.id, body?.visibility, body?.updatedAt));
  }));
  router.get('/:id/pool', requireAuth, asyncHandler(async (req, res) => { sendResult(res, await act.pool(req.user!.id, req.params.id)); }));
  router.get('/:id/resolved', requireAuth, asyncHandler(async (req, res) => { sendResult(res, await act.resolved(req.user!.id, req.params.id)); }));
  router.post('/', requireAuth, asyncHandler(async (req, res) => { sendResult(res, await act.create(req.user!.id, req.body)); }));
  router.put('/:id', requireAuth, asyncHandler(async (req, res) => { sendResult(res, await act.update(req.user!.id, req.params.id, req.body)); }));
  router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
    // In the body (the UI's), or ?updatedAt= for a client that sends no body with a DELETE.
    sendResult(res, await act.remove(req.user!.id, req.params.id, (req.body as { updatedAt?: unknown } | undefined)?.updatedAt ?? req.query.updatedAt));
  }));
  return router;
}
