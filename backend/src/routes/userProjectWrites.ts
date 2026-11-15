/**
 * PATCH /api/user-projects/:id and GET /api/user-projects/:id/archive-plan
 * ("Data and API" and "The
 * project's menu"): rename one of the person's projects, archive it, or bring
 * it back. routes/userProjects.ts mounts them, behind user-projects-enabled.
 *
 * - Rename changes the project's name only. Its checkouts and their directories
 *   keep theirs: moving a checkout moves its conversation folders (the gotcha
 *   `project-rename-conversations`), so a project rename never touches one.
 *   Names are unique per person, archived projects included, ignoring case.
 * - Archive takes each live checkout with all its sessions, the way each is
 *   archived today: a chat checkout (its agent runs in the chat runner) with the
 *   chat archive (routes/chats.ts archiveChatFor), its box rule unchanged; any
 *   other (made and run in Lab) with the project archive
 *   (routes/projects.ts archiveOwnedProject), which leaves its box alone, as
 *   Lab's own Archive does. Chats go first, so a box that also holds one of the
 *   project's Lab checkouts keeps running, as the plan says. The project is
 *   marked archived only once every checkout is; a checkout that won't archive
 *   (a turn that won't stop answers 409) leaves the others archived and the
 *   project live, and the answer says which and why.
 * - Unarchive brings the project back. Its checkouts stay archived and reopen
 *   one by one from Archived, as today.
 *
 * The archive plan is what the confirm dialog says before any of it runs: the
 * checkouts and sessions it takes, and per box whether it stops or keeps
 * running, worked out as the archive will do it.
 */
import { prisma } from '../db';
import { isChatRunnerProvider } from '../providers/registry';
import { archivePowerFor, type LifecycleBox } from '../services/chatLifecycle';
import { projectNameKey, USER_PROJECT_NAME_MAX } from '../services/userProjects';
import { userProjectViewFor } from '../services/userProjectViews';
import { projectFilesEnabled, useExistingSpace } from '../services/projectFiles';
import { notifyWorkspaceChange } from '../services/workspaceEvents';
import { archiveChatFor } from './chats';
import { archiveOwnedProject } from './projects';
import type { Prisma } from '@prisma/client';
import type { RouteResult } from './routeResult';

export const USER_PROJECT_NOT_FOUND = { error: 'No such project', code: 'user_project_not_found' } as const;

// ---------------------------------------------------------------------------
// The pure rules.

/** A PATCH body: a new name, archived or not, a space for its files, or any of them (the rename first). */
export type PatchPlan =
  | { ok: true; name?: { name: string; nameKey: string }; archived?: boolean; filesSpace?: string }
  | { ok: false; error: string; field?: 'name' | 'archived' | 'filesSpace' };

export function planPatch(body: unknown): PatchPlan {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const out: PatchPlan = { ok: true };
  if ('name' in b) {
    if (typeof b.name !== 'string') return { ok: false, error: 'A project name is text', field: 'name' };
    const name = b.name.trim();
    if (!name) return { ok: false, error: 'Give the project a name', field: 'name' };
    if (name.length > USER_PROJECT_NAME_MAX) return { ok: false, error: `Keep the name to ${USER_PROJECT_NAME_MAX} characters`, field: 'name' };
    out.name = { name, nameKey: projectNameKey(name) };
  }
  if ('archived' in b) {
    if (typeof b.archived !== 'boolean') return { ok: false, error: 'archived is true or false', field: 'archived' };
    out.archived = b.archived;
  }
  // "Use an existing space for files…": one of the caller's spaces, by name.
  // On its own: it commits under its own locks, so a rename or archive refused after it would leave half a PATCH.
  if ('filesSpace' in b) {
    if (typeof b.filesSpace !== 'string' || !b.filesSpace.trim()) return { ok: false, error: 'filesSpace is a space\'s name', field: 'filesSpace' };
    if (out.name || out.archived !== undefined) return { ok: false, error: 'Send filesSpace on its own, not with a name or archived', field: 'filesSpace' };
    out.filesSpace = b.filesSpace.trim();
  }
  if (!out.name && out.archived === undefined && out.filesSpace === undefined) return { ok: false, error: 'Nothing to change: send a name, archived or filesSpace' };
  return out;
}

/** How a checkout is archived: the chat archive (its agent runs in the chat runner), or Lab's project archive. */
export type CheckoutKind = 'chat' | 'lab';

export function checkoutKind(workflows: ReadonlyArray<{ type: string; provider: string | null }>): CheckoutKind {
  return workflows.some(w => w.type === 'agent' && isChatRunnerProvider(w.provider)) ? 'chat' : 'lab';
}

export interface PlanBox extends LifecycleBox { id: string; name: string }

export interface PlanCheckout {
  projectId: string;
  name: string;
  kind: CheckoutKind;
  /** Its live sessions (workstreams), worktrees included. */
  sessions: number;
  box: PlanBox | null;
}

/**
 * What the archive does to one box: `stops`, as the chat archive stops a box
 * nothing else runs on; or `keeps` running, because other sessions use it,
 * because one of the project's checkouts on it is a Lab session (the project
 * archive leaves a Lab box alone), or because the chat archive wouldn't power
 * it anyway (`detail` says why: already stopped, a self-managed host).
 */
export interface BoxFate {
  boxId: string;
  boxName: string;
  fate: 'stops' | 'keeps';
  why: 'nothing-else' | 'other-sessions' | 'lab-session' | 'not-powered';
  detail?: string;
}

/**
 * Each box's fate. `othersOn` is how many live checkouts on the box aren't the
 * project's (the chat archive counts every live project on the box but the one
 * it archives; once the project's own are archived, only these are left).
 */
export function boxFates(checkouts: readonly PlanCheckout[], othersOn: (boxId: string) => number): BoxFate[] {
  const byBox = new Map<string, { box: PlanBox; kinds: Set<CheckoutKind> }>();
  for (const c of checkouts) {
    if (!c.box) continue;
    const got = byBox.get(c.box.id);
    if (got) got.kinds.add(c.kind);
    else byBox.set(c.box.id, { box: c.box, kinds: new Set([c.kind]) });
  }
  return [...byBox.values()].map(({ box, kinds }): BoxFate => {
    const base = { boxId: box.id, boxName: box.name };
    // The chat archive runs first, while the Lab checkout is still live: it counts as another project on the box.
    if (kinds.has('lab')) return { ...base, fate: 'keeps', why: 'lab-session' };
    if (othersOn(box.id) > 0) return { ...base, fate: 'keeps', why: 'other-sessions' };
    const power = archivePowerFor(box, 0);
    return power.action === 'stop'
      ? { ...base, fate: 'stops', why: 'nothing-else' }
      : { ...base, fate: 'keeps', why: 'not-powered', detail: power.reason };
  }).sort((a, b) => a.boxName.localeCompare(b.boxName));
}

// ---------------------------------------------------------------------------
// The database half.

const BOX_SELECT = { id: true, name: true, kind: true, status: true } as const;

/** The project's live checkouts, chats first (the order the archive takes them). */
async function liveCheckouts(userId: string, userProjectId: string, db: Pick<Prisma.TransactionClient, 'project'> = prisma): Promise<PlanCheckout[]> {
  const rows = await db.project.findMany({
    where: { userId, userProjectId, archived: false },
    select: {
      id: true, name: true,
      instance: { select: BOX_SELECT },
      workflows: { select: { type: true, provider: true } },
      _count: { select: { workstreams: { where: { archived: false } } } },
    },
    orderBy: { name: 'asc' },
  });
  const checkouts = rows.map((r): PlanCheckout => ({
    projectId: r.id, name: r.name, kind: checkoutKind(r.workflows), sessions: r._count.workstreams, box: r.instance,
  }));
  return [...checkouts.filter(c => c.kind === 'chat'), ...checkouts.filter(c => c.kind === 'lab')];
}

async function othersOnBoxes(checkouts: readonly PlanCheckout[]): Promise<Map<string, number>> {
  const boxIds = [...new Set(checkouts.flatMap(c => (c.box ? [c.box.id] : [])))];
  if (boxIds.length === 0) return new Map();
  const totals = await prisma.project.groupBy({
    by: ['instanceId'],
    where: { instanceId: { in: boxIds }, archived: false, id: { notIn: checkouts.map(c => c.projectId) } },
    _count: true,
  });
  return new Map(totals.flatMap(t => (t.instanceId ? [[t.instanceId, t._count] as const] : [])));
}

async function ownProject(userId: string, id: string) {
  return prisma.userProject.findFirst({ where: { id, userId }, select: { id: true, name: true, nameKey: true, archivedAt: true } });
}

/** GET /api/user-projects/:id/archive-plan: what archiving would take, and each box's fate. */
export async function archivePlanFor(user: Express.User, id: string): Promise<RouteResult> {
  const project = await ownProject(user.id, id);
  if (!project) return { status: 404, body: USER_PROJECT_NOT_FOUND };
  const checkouts = await liveCheckouts(user.id, id);
  const others = await othersOnBoxes(checkouts);
  return {
    status: 200,
    body: {
      id: project.id,
      name: project.name,
      archived: project.archivedAt !== null,
      sessions: checkouts.reduce((n, c) => n + c.sessions, 0),
      checkouts: checkouts.map(c => ({ projectId: c.projectId, name: c.name, kind: c.kind, sessions: c.sessions, boxName: c.box?.name ?? null })),
      boxes: boxFates(checkouts, boxId => others.get(boxId) ?? 0),
    },
  };
}

/** A box the archive stopped, or tried to: the chat archive's own answer. */
interface BoxReport { boxId: string; boxName: string; action: 'stop'; status?: string | null; error?: string }

async function archiveCheckouts(user: Express.User, checkouts: readonly PlanCheckout[]) {
  const archived: Array<{ projectId: string; name: string }> = [];
  const failed: Array<{ projectId: string; name: string; status: number; error: string }> = [];
  const boxes: BoxReport[] = [];
  for (const c of checkouts) {
    const result = c.kind === 'chat' ? await archiveChatFor(user, c.projectId) : await archiveOwnedProject(user, c.projectId);
    if (result.status !== 200) {
      const error = (result.body as { error?: string } | null)?.error ?? 'It would not archive';
      failed.push({ projectId: c.projectId, name: c.name, status: result.status, error });
      continue;
    }
    archived.push({ projectId: c.projectId, name: c.name });
    const box = (result.body as { box?: { action?: string | null; status?: string | null; error?: string } } | null)?.box;
    if (c.box && box?.action === 'stop') {
      boxes.push({ boxId: c.box.id, boxName: c.box.name, action: 'stop', ...(box.error ? { error: box.error } : { status: box.status ?? null }) });
    }
  }
  return { archived, failed, boxes };
}

/**
 * PATCH /api/user-projects/:id: `{ name?, archived?, filesSpace? }` → 200 the
 * project's view (with `archive`, what an archive did); 400
 * user_project_invalid; 404 when it isn't the caller's; 409
 * user_project_name_taken (with the clash's `projectId` and `archived`); 409
 * user_project_archive_incomplete when a checkout wouldn't archive (the
 * project stays live; `archive.failed` says which and why). `filesSpace`
 * (under project-files-enabled, else 404 project_files_disabled) is a space
 * the caller owns to use as the project's files: 404 space_not_found, 403
 * space_not_owned, 409 space_in_use when it's already a project's files or
 * someone's My files (services/projectFiles.ts useExistingSpace). It comes on
 * its own (400 with a name or archived), so a refusal changes nothing.
 */
export async function patchUserProjectFor(user: Express.User, id: string, body: unknown): Promise<RouteResult> {
  const plan = planPatch(body);
  if (!plan.ok) {
    const { ok: _ok, ...why } = plan;
    return { status: 400, body: { ...why, code: 'user_project_invalid' } };
  }
  const project = await ownProject(user.id, id);
  if (!project) return { status: 404, body: USER_PROJECT_NOT_FOUND };

  if (plan.filesSpace !== undefined) {
    if (!await projectFilesEnabled(user)) return { status: 404, body: { error: 'Project files are not on for you', code: 'project_files_disabled' } };
    const used = await useExistingSpace(user, { kind: 'project', userProjectId: id }, plan.filesSpace);
    if (!used.ok) return { status: used.status, body: { error: used.error, code: used.code } };
  }

  if (plan.name && plan.name.name !== project.name) {
    const renamed = await renameUserProject(user.id, id, plan.name);
    if (renamed) return renamed;
  }

  let archive: Awaited<ReturnType<typeof archiveCheckouts>> | null = null;
  if (plan.archived === true && project.archivedAt === null) {
    archive = await archiveCheckouts(user, await liveCheckouts(user.id, id));
    // What's live now decides, not what this request managed: another archive running at the
    // same moment may have taken a checkout this one was refused (already archived), and a
    // session started meanwhile keeps the project live. Read and marked under the per-person
    // lock a new checkout attaches under (services/userProjects.ts attachCheckout), so none can
    // join between the read and the mark.
    // A create in flight for this project that attaches after the mark brings the project back
    // (services/userProjects.ts attachCheckout), so its session is never left in an archived one.
    let left: PlanCheckout[];
    try {
      left = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`user-projects:${user.id}`}))`;
        const live = await liveCheckouts(user.id, id, tx);
        if (live.length === 0) await tx.userProject.update({ where: { id }, data: { archivedAt: new Date() } });
        return live;
      }, LOCKED_TX);
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2028') throw err;
      // The checkouts are archived (and maybe their boxes stopped); only the project's mark waited
      // too long on the lock. It stays live: the same PATCH again marks it.
      notifyWorkspaceChange(user.id, 'projects');
      const view = await userProjectViewFor(user.id, id);
      return {
        status: 503,
        body: { ...(view ?? {}), archive, code: 'user_projects_unavailable', error: 'Its sessions are archived, but the project is busy; archive it again to finish' },
      };
    }
    const why = new Map(archive.failed.map(f => [f.projectId, f]));
    archive.failed = left.map(c => why.get(c.projectId) ?? { projectId: c.projectId, name: c.name, status: 409, error: 'It started while the project was archiving' });
  } else if (plan.archived === false && project.archivedAt !== null) {
    await prisma.userProject.update({ where: { id }, data: { archivedAt: null } });
  }
  // The person's other tabs re-read their projects (the sidebar's groups, the header's name, its files).
  if (plan.name || plan.archived !== undefined || plan.filesSpace !== undefined) notifyWorkspaceChange(user.id, 'projects');

  const view = await userProjectViewFor(user.id, id);
  if (!view) return { status: 404, body: USER_PROJECT_NOT_FOUND };
  if (archive && archive.failed.length > 0) {
    const left = archive.failed.map(f => f.name).join(', ');
    return {
      status: 409,
      body: { ...view, archive, code: 'user_project_archive_incomplete', error: `${left} didn't archive, so ${view.name} stays live` },
    };
  }
  return { status: 200, body: archive ? { ...view, archive } : view };
}

/** As services/userProjects.ts's own TX_OPTIONS: a write waits out a backfill holding the lock. */
const LOCKED_TX = { maxWait: 10_000, timeout: 30_000 };

/**
 * Rename under the project record's per-person lock (services/userProjects.ts
 * lockUser's key), so a backfill choosing a name at the same moment can't take
 * it. A clash answers 409; a lock held past the transaction's limit, 503; null
 * when renamed.
 */
async function renameUserProject(userId: string, id: string, next: { name: string; nameKey: string }): Promise<RouteResult | null> {
  const taken = (clash: { id: string; name: string; archivedAt: Date | null }): RouteResult => ({
    status: 409,
    body: {
      error: `You already have a project called ${clash.name}`, code: 'user_project_name_taken', field: 'name',
      projectId: clash.id, archived: clash.archivedAt !== null,
    },
  });
  try {
    return await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`user-projects:${userId}`}))`;
      // A change of case alone is its own name.
      const clash = await tx.userProject.findFirst({
        where: { userId, nameKey: next.nameKey, id: { not: id } },
        select: { id: true, name: true, archivedAt: true },
      });
      if (clash) return taken(clash);
      await tx.userProject.update({ where: { id }, data: { name: next.name, nameKey: next.nameKey } });
      return null;
    }, LOCKED_TX);
  } catch (err) {
    const code = (err as { code?: string }).code;
    // P2028: the transaction gave up waiting (a long backfill held the lock): nothing changed.
    if (code === 'P2028') return { status: 503, body: { error: 'Your projects are busy; try again', code: 'user_projects_unavailable' } };
    if (code !== 'P2002') throw err;
    const clash = await prisma.userProject.findFirst({ where: { userId, nameKey: next.nameKey }, select: { id: true, name: true, archivedAt: true } });
    return taken(clash ?? { id: '', name: next.name, archivedAt: null });
  }
}
