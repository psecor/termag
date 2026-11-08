import type { ServerResponse } from 'node:http';

/**
 * The orchestrator's environment routes on /api/cli/v1 (backend
 * routes/cliEnvironments.ts), in memory: an environment by name, its events,
 * and the refusals the CLI must pass on as they come (an invalid
 * definition's schema path and message, a taken name, no such environment,
 * and a share the shared rules refuse: here, anything but a pointer with no
 * branch named).
 */
interface Env {
  id: string; name: string; kind: 'inline' | 'pointer'; definition?: unknown; file?: { repo: string; branch: string | null; path: string };
  updatedAt: string; createdBy: unknown; updatedBy: unknown; visibility: 'personal' | 'shared'; owner: unknown;
}
export interface FakeEnvironmentsState {
  envs: Env[];
  events: Array<{ id: string; at: string; action: string; actor: unknown; environmentId: string; before: unknown; after: unknown }>;
  calls: Array<{ route: string; body: Record<string, unknown>; isBox: boolean }>;
  /** What GET /:ref/resolved answers, by name. */
  resolved: Record<string, { repos: Array<{ repo: string; branch?: string; path?: string }>; size: unknown; warnings: string[] }>;
}

export function newEnvironmentsState(): FakeEnvironmentsState {
  return { envs: [], events: [], calls: [], resolved: {} };
}

const PERSON = { id: 'u1', email: 'ada@example.com', name: 'Ada' };

/** The orchestrator's sharedRuleError, for what the tests use: a pointer on its default branch (none named) shares. */
function notShareable(e: Pick<Env, 'kind' | 'file'>): string | null {
  if (e.kind !== 'pointer') return "a shared environment runs from a file on a repository's default branch, not inline JSON; point it at .termag/environment.json on its repository's default branch";
  return e.file?.branch && e.file.branch !== 'main' ? `a shared environment runs from a file on ${e.file.repo}'s default branch; point it at ${e.file.path} on main` : null;
}
function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

/** As the orchestrator's parseDefinition says it, for the two cases the tests use. */
function definitionError(def: unknown): string | null {
  let d = def;
  if (typeof def === 'string') { try { d = JSON.parse(def); } catch { return 'the definition is not valid JSON'; } }
  const o = d as { repos?: unknown[]; resources?: { vcpu?: number } };
  if (o?.resources && typeof o.resources === 'object' && (o.resources.vcpu ?? 0) > 8) return 'the definition: resources.vcpu must be <= 8 (docs/environment.schema.json)';
  if (!Array.isArray(o?.repos) || !o.repos.length) return 'the definition names at least one repository, in "repos": [{ "repo": "owner/name" }]';
  return null;
}

function fields(body: Record<string, unknown>): Omit<Env, 'id' | 'updatedAt' | 'createdBy' | 'updatedBy' | 'visibility' | 'owner'> | { error: string } {
  if (body.kind === 'inline') {
    const why = definitionError(body.definition);
    if (why) return { error: why };
    const def = typeof body.definition === 'string' ? JSON.parse(body.definition) : body.definition;
    return { name: String(body.name), kind: 'inline', definition: def };
  }
  const f = body.file as { repo: string; branch?: string; path?: string };
  return { name: String(body.name), kind: 'pointer', file: { repo: f.repo, branch: f.branch ?? null, path: f.path ?? '.termag/environment.json' } };
}

export function handleEnvironments(s: FakeEnvironmentsState, route: string, body: Record<string, unknown>, isBox: boolean, res: ServerResponse): boolean {
  const m = /^(GET|POST|PUT|DELETE) \/environments(?:\/([^/]+))?(?:\/(events|resolved|visibility))?$/.exec(route);
  if (!m) return false;
  s.calls.push({ route, body, isBox });
  const [, method, rawRef, sub] = m;
  const ref = rawRef ? decodeURIComponent(rawRef) : undefined;
  const env = ref ? s.envs.find(e => e.name === ref || e.id === ref) : undefined;
  const now = new Date(Date.UTC(2026, 9, 30, 9, s.events.length)).toISOString();
  const event = (action: string, environmentId: string, before: unknown, after: unknown) =>
    s.events.push({ id: `ev${s.events.length + 1}`, at: now, action, actor: PERSON, environmentId, before, after });
  const view = (e: Env) => ({ ...e });
  // A box's own credential reads only, as the orchestrator's routes/cliEnvironments.ts says.
  if (isBox && method !== 'GET' && !(method === 'POST' && ref === 'validate')) {
    send(res, 403, { error: "A box can't create, edit or delete environments: change them from the web UI, or with `termag login` on your own machine", code: 'environment_box_read_only' });
    return true;
  }
  if (method === 'GET' && !ref) { send(res, 200, { environments: s.envs.map(view) }); return true; }
  if (method === 'POST' && !ref) {
    const f = fields(body);
    if ('error' in f) { send(res, 400, { error: f.error, code: 'invalid_environment' }); return true; }
    if (s.envs.some(e => e.name === f.name)) { send(res, 409, { error: `An environment named "${f.name}" already exists`, code: 'environment_name_taken' }); return true; }
    const visibility = body.visibility === 'shared' ? 'shared' : 'personal';
    const broken = visibility === 'shared' ? notShareable(f) : null;
    if (broken) { send(res, 400, { error: broken, code: 'environment_not_shareable' }); return true; }
    const e: Env = { ...f, id: `env${s.envs.length + 1}`, updatedAt: now, createdBy: PERSON, updatedBy: PERSON, visibility, owner: PERSON };
    s.envs.push(e);
    event('environment.create', e.id, null, f);
    send(res, 201, { environment: view(e), changed: true });
    return true;
  }
  if (!env) { send(res, 404, { error: 'No such environment', code: 'environment_not_found' }); return true; }
  if (method === 'GET' && sub === 'events') { send(res, 200, { events: s.events.filter(e => e.environmentId === env.id).reverse() }); return true; }
  if (method === 'GET' && sub === 'resolved') { send(res, 200, s.resolved[env.name] ?? { repos: [], size: null, warnings: [] }); return true; }
  if (method === 'GET') { send(res, 200, { environment: view(env) }); return true; }
  if (method === 'POST' && sub === 'visibility') {
    const to = body.visibility === 'shared' ? 'shared' : 'personal';
    const broken = to === 'shared' ? notShareable(env) : null;
    if (broken) { send(res, 400, { error: broken, code: 'environment_not_shareable' }); return true; }
    if (env.visibility === to) { send(res, 200, { environment: view(env), changed: false }); return true; }
    const before = { ...env };
    env.visibility = to;
    event('environment.visibility', env.id, before, { ...env });
    send(res, 200, { environment: view(env), changed: true });
    return true;
  }
  if (method === 'PUT') {
    const f = fields(body);
    if ('error' in f) { send(res, 400, { error: f.error, code: 'invalid_environment' }); return true; }
    const before = { ...env };
    delete env.definition; delete env.file;
    Object.assign(env, f, { updatedAt: now });
    event('environment.update', env.id, before, f);
    send(res, 200, { environment: view(env), changed: true });
    return true;
  }
  if (method === 'DELETE') {
    s.envs = s.envs.filter(e => e !== env);
    event('environment.delete', env.id, env, null);
    send(res, 200, { environment: view(env), changed: true });
    return true;
  }
  return false;
}
