/**
 * The one place a write to the rows behind the project list tells the people
 * who can see them (services/workspaceEvents.ts). A Prisma middleware, so a
 * project, workstream, workflow or share made, renamed, moved to another box,
 * archived or deleted by any path (the web routes, the CLI, an ask's chat
 * workstream, a spawn, an automation run, a sweep, Slack) reaches the owner's
 * tabs and every collaborator's without each caller remembering to say so.
 *
 * Only writes that touch a field the list shows count, so the status
 * pipeline's lastActiveAt touches (several a second) push nothing. Bursts are
 * coalesced downstream (coalesceWorkspaceChanges in index.ts). The audience
 * of a delete is read before it runs, since the cascade takes the shares with
 * it; everyone else's after. Nothing here can fail or slow a write beyond that
 * read: lookups after the write run detached and only log.
 */
import type { Prisma } from '@prisma/client';
import { notifyWorkspaceChange } from './workspaceEvents';

type Row = Record<string, unknown>;

/** Per model: the fields of the list's rows (routes/projects.ts listProjectsFor), and relations a nested write can change them through. */
const WATCHED: Record<string, ReadonlySet<string>> = {
  Project: new Set([
    'name', 'description', 'color', 'archived', 'pinned', 'kind', 'userId', 'user', 'instanceId', 'instance',
    'repoUrl', 'repoDefaultBranch', 'setupStatus', 'setupError', 'workstreams', 'workflows', 'shares',
  ]),
  Workstream: new Set(['name', 'branch', 'archived', 'sessionTitle', 'projectId', 'project', 'workflows']),
  Workflow: new Set(['type', 'provider', 'projectId', 'project', 'workstreamId', 'workstream']),
  ProjectShare: new Set(['projectId', 'project', 'userId', 'user']),
};

/** Writes Prisma middleware sees; reads and anything else pass straight through. */
const WRITES = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);

/** What this module reads to find who can see a row. Prisma's client in production. */
export interface AudienceReader {
  /** The owner and collaborators of these projects. */
  projectAudience(projectIds: string[]): Promise<string[]>;
  /** The rows a bulk write or delete is about to touch (read before it runs). */
  rowsMatching(model: string, where: unknown, unique: boolean): Promise<Row[]>;
  /** One row by id, when a write's result left out the fields we need. */
  rowById(model: string, id: string): Promise<Row | null>;
}

const SELECT: Record<string, Row> = {
  Project: { id: true, userId: true },
  Workstream: { projectId: true },
  Workflow: { projectId: true },
  ProjectShare: { projectId: true, userId: true },
};

function delegate(client: PrismaLike, model: string): DelegateLike {
  const key = model.charAt(0).toLowerCase() + model.slice(1);
  return (client as unknown as Record<string, DelegateLike>)[key];
}

interface DelegateLike {
  findMany(args: unknown): Promise<Row[]>;
  findUnique(args: unknown): Promise<Row | null>;
}
interface PrismaLike {
  project: DelegateLike;
  $use(mw: Prisma.Middleware): void;
}

export function prismaAudienceReader(client: PrismaLike): AudienceReader {
  return {
    async projectAudience(projectIds) {
      const rows = await client.project.findMany({
        where: { id: { in: projectIds } },
        select: { userId: true, shares: { select: { userId: true } } },
      }) as Array<{ userId: string; shares: Array<{ userId: string }> }>;
      return rows.flatMap(r => [r.userId, ...r.shares.map(s => s.userId)]);
    },
    async rowsMatching(model, where, unique) {
      const d = delegate(client, model);
      if (unique) {
        const row = await d.findUnique({ where, select: SELECT[model] });
        return row ? [row] : [];
      }
      return d.findMany({ where, select: SELECT[model] });
    },
    rowById(model, id) {
      return delegate(client, model).findUnique({ where: { id }, select: SELECT[model] });
    },
  };
}

/** Whether a write's args touch a watched field. Deletes and creates always do. */
export function touchesList(model: string, action: string, args: Row | undefined): boolean {
  const watched = WATCHED[model];
  if (!watched || !WRITES.has(action)) return false;
  if (action !== 'update' && action !== 'updateMany') return true;
  const data = (args?.data ?? {}) as Row;
  return Object.keys(data).some(k => watched.has(k));
}

/** Project ids and directly named users (a share's collaborator, a project's owner) in these rows. */
function idsOf(model: string, rows: Row[]): { projectIds: string[]; userIds: string[] } {
  const projectIds: string[] = [];
  const userIds: string[] = [];
  for (const r of rows) {
    const pid = model === 'Project' ? r.id : r.projectId;
    if (typeof pid === 'string') projectIds.push(pid);
    if ((model === 'Project' || model === 'ProjectShare') && typeof r.userId === 'string') userIds.push(r.userId);
  }
  return { projectIds, userIds };
}

/** The rows a single-row write's result stands for, reading by id when its select left out what we need. */
async function rowsAfter(model: string, result: unknown, args: Row | undefined, reader: AudienceReader): Promise<Row[]> {
  if (Array.isArray(result)) return result as Row[]; // createManyAndReturn
  if (result && typeof result === 'object' && !('count' in result)) {
    const row = result as Row;
    const need = model === 'Project' ? 'userId' : 'projectId';
    if (typeof row[need] === 'string') return [row];
    if (typeof row.id === 'string') {
      const full = await reader.rowById(model, row.id);
      return full ? [full] : [];
    }
  }
  // createMany answers a count: its data names the projects.
  const data = args?.data;
  return Array.isArray(data) ? data as Row[] : data && typeof data === 'object' ? [data as Row] : [];
}

async function audienceOf(model: string, rows: Row[], reader: AudienceReader): Promise<Set<string>> {
  const { projectIds, userIds } = idsOf(model, rows);
  const audience = new Set(userIds);
  if (projectIds.length) for (const u of await reader.projectAudience([...new Set(projectIds)])) audience.add(u);
  return audience;
}

function tell(audience: Iterable<string>): void {
  for (const u of audience) notifyWorkspaceChange(u, 'projects');
}

function logged(err: unknown): void {
  console.error('[WORKSPACE] project list audience lookup failed:', err instanceof Error ? err.message : String(err));
}

/** The middleware. `reader` reads with the same client; its own reads pass through untouched. */
export function workspaceWriteMiddleware(reader: AudienceReader): Prisma.Middleware {
  return async (params, next) => {
    const model = params.model;
    const args = params.args as Row | undefined;
    if (!model || !touchesList(model, params.action, args)) return next(params);

    const bulk = params.action === 'updateMany' || params.action === 'deleteMany';
    const deleting = params.action === 'delete' || params.action === 'deleteMany';
    if (bulk || deleting) {
      // Read first: the rows may stop matching (or exist) once the write runs,
      // and a delete's audience (a project's shares) goes with the row.
      let before: Row[] = [];
      let audience: Set<string> | null = null;
      try {
        before = await reader.rowsMatching(model, args?.where ?? {}, params.action === 'delete');
        if (deleting) audience = await audienceOf(model, before, reader);
      } catch (err) { logged(err); }
      const result = await next(params);
      if ((result as { count?: number } | null)?.count === 0) return result;
      if (audience) tell(audience);
      else if (before.length) void audienceOf(model, before, reader).then(tell).catch(logged);
      return result;
    }

    const result = await next(params);
    void rowsAfter(model, result, args, reader).then(rows => audienceOf(model, rows, reader)).then(tell).catch(logged);
    return result;
  };
}

/** Wires the middleware onto the shared client (index.ts, at startup). */
export function installWorkspaceWriteNotifier(client: PrismaLike): void {
  client.$use(workspaceWriteMiddleware(prismaAudienceReader(client)));
}
