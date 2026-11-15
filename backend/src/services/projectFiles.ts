/**
 * Project files and My files.
 *
 * Every project (`UserProject`) gets a space of its own, its `filesSpaceId`,
 * made the first time something needs it: a session's start, its Files tab,
 * a chat turn on a box that can address it. Every person gets one My files
 * space (`User.myFilesSpaceId`), made the same way. Spaces stay the mechanism:
 * the person owns both, and Lab shows them by name.
 *
 * Grants. A box gets the Project files of the projects it runs, and its
 * owner's My files while `User.myFilesOnBoxes` is on, only when its agent
 * announces `project-files-v1`: that agent sets each session's TERMAG_SPACE
 * and TERMAG_MY_FILES, and its CLI reads them for a path with no space, so a
 * second and third space don't break a bare `termag space put` there. The
 * grants are made at a session's start, on every hello of a capable agent,
 * before a chat turn that names them, and (My files) on every capable box when
 * My files is first made or turned back on. Each is idempotent, and none is
 * removed when a session ends: the spaces sweep prunes a terminated box's.
 *
 * One space, one role. A space is at most one project's files (the unique
 * `user_projects.filesSpaceId`) or one person's My files, never both: the
 * second isn't unique in the schema (a unique index on an existing table is a
 * change the boot-time additive db:push refuses), so "Use an existing space"
 * checks both under the person's `user-projects:<userId>` advisory lock and
 * the space's own `space-files:<spaceId>` lock, and answers 409 `space_in_use`.
 *
 * Everything here is behind `project-files-enabled` and needs
 * `user-projects-enabled` for the same person; with either off, nothing is
 * made, granted or sent.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { boolVariation } from './featureFlags';
import type { FlagBox, FlagUser } from './featureFlags';
import { recordProductEvent } from './productEvents';
import { MAX_INHERITANCE_HOPS } from './spaces/spaceInheritance';
import type { SpaceCaller } from './spaces/spaceAccess';
import { userProjectsEnabled } from './userProjects';

export const PROJECT_FILES_FLAG = 'project-files-enabled' as const;
/** The agent sets each turn's TERMAG_SPACE / TERMAG_MY_FILES from `files`, and its CLI reads them (agent/chat-runner.js). */
export const PROJECT_FILES_CAPABILITY = 'project-files-v1';
export const SPACE_IN_USE = 'space_in_use';
/** The note on the `space.create` event of a space termag made for files (the audit trail says who made it). */
export const MADE_FOR_FILES_NOTE = 'made-for-files';
/** The note on the `box.add` / `box.remove` events of termag's own grants. */
export const FILES_GRANT_NOTE = 'project-files';

// ---------------------------------------------------------------------------
// Naming (pure).

/** A space name's limit: [a-z0-9-]{2,40} (services/spaces/spacePaths.ts validateSpaceName). */
export const SPACE_NAME_MAX = 40;

/** Lowercased, every run of characters outside [a-z0-9] one `-`, none at either end. */
export function nameSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function suffixOf(n: number): string {
  return n <= 1 ? '' : `-${n}`;
}

/** `head` cut (and any `-` it then ends on dropped) so that `head + tail` fits a space name. */
function fit(head: string, tail: string): string {
  return head.slice(0, SPACE_NAME_MAX - tail.length).replace(/-+$/, '') + tail;
}

/**
 * A project's files: `<unix user>-<project slug>`, the `n`th candidate with
 * `-n` on it (2 and up, for a name taken across termag), cut so the whole
 * name, suffix included, is at most 40 characters. A project whose name has
 * no letter or digit is `<unix user>-project`.
 */
export function projectFilesName(unixUser: string, projectName: string, n = 1): string {
  const user = nameSlug(unixUser) || 'user';
  return fit(`${user}-${nameSlug(projectName) || 'project'}`, suffixOf(n));
}

/** A person's My files: `<unix user>-my-files`, `-2` and up on a clash, the user part cut to fit. */
export function myFilesName(unixUser: string, n = 1): string {
  return fit(nameSlug(unixUser) || 'user', `-my-files${suffixOf(n)}`);
}

// ---------------------------------------------------------------------------
// Decisions (pure).

/**
 * What a box gets: nothing unless its agent can address the new spaces and the
 * flags are on for its owner; then its projects' files, and My files while
 * the owner keeps it on their boxes.
 */
export function grantPlan(input: { capable: boolean; enabled: boolean; myFilesOnBoxes: boolean }): { projectFiles: boolean; myFiles: boolean } {
  if (!input.capable || !input.enabled) return { projectFiles: false, myFiles: false };
  return { projectFiles: true, myFiles: input.myFilesOnBoxes };
}

export function isCapable(capabilities: readonly string[] | null | undefined): boolean {
  return !!capabilities && capabilities.includes(PROJECT_FILES_CAPABILITY);
}

/** Why a space can't take a files role, or null when it can (useExistingSpace). */
export function spaceInUseReason(
  target: { kind: 'project'; userProjectId: string } | { kind: 'mine'; userId: string },
  holders: { projectId: string | null; myFilesOf: readonly string[] },
): string | null {
  const otherProject = holders.projectId !== null && !(target.kind === 'project' && holders.projectId === target.userProjectId);
  const otherMine = holders.myFilesOf.some(u => !(target.kind === 'mine' && u === target.userId));
  if (otherProject) return 'That space is already a project\'s files';
  if (otherMine) return 'That space is already someone\'s My files';
  return null;
}

/** What a saved file is, from its extension only (`files.saved` kind): never its name. */
export type FileKind = 'image' | 'text' | 'data' | 'archive' | 'other';

const KIND_BY_EXTENSION: Record<string, FileKind> = Object.fromEntries([
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'heic', 'avif', 'ico'].map(e => [e, 'image']),
  ...['txt', 'md', 'markdown', 'log', 'rst', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java',
    'kt', 'swift', 'rb', 'c', 'h', 'cc', 'cpp', 'sh', 'diff', 'patch', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'sql'].map(e => [e, 'text']),
  ...['json', 'jsonl', 'ndjson', 'csv', 'tsv', 'parquet', 'avro', 'sqlite', 'db', 'xls', 'xlsx'].map(e => [e, 'data']),
  ...['zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'zst', '7z', 'rar'].map(e => [e, 'archive']),
]);

export function fileKind(path: string): FileKind {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? KIND_BY_EXTENSION[base.slice(dot + 1).toLowerCase()] ?? 'other' : 'other';
}

/** Who saved it, by the credential: a box's token is its agent, anything else a person. */
export function savedBy(caller: SpaceCaller): 'agent' | 'person' {
  return caller.kind === 'box' ? 'agent' : 'person';
}

export type FilesLocation = 'project-files' | 'my-files' | 'other';

/** `files.saved`'s attributes: metadata only, never a path or a file name. */
export function filesSavedDetail(input: { location: FilesLocation; caller: SpaceCaller; chosen: 'default' | 'explicit' | null; path: string }) {
  return { location: input.location, by: savedBy(input.caller), chosen: input.chosen, kind: fileKind(input.path) };
}

/** A move `files.moved` counts: from Project files to My files, or back. */
export function isFilesCrossover(from: FilesLocation, to: FilesLocation): boolean {
  return (from === 'project-files' && to === 'my-files') || (from === 'my-files' && to === 'project-files');
}

/**
 * `files.moved`'s attributes, for a move between Project files and My files:
 * where from and to, who moved it, who saved it there (the newest write before
 * the move), and how long ago, in hours to one place. Metadata only.
 */
export function filesMovedDetail(input: {
  from: FilesLocation; to: FilesLocation; caller: SpaceCaller; saved: { byBox: boolean; at: Date } | null; now?: number;
}) {
  const now = input.now ?? Date.now();
  return {
    from: input.from,
    to: input.to,
    by: savedBy(input.caller),
    savedBy: input.saved ? (input.saved.byBox ? 'agent' : 'person') : null,
    ageHours: input.saved ? Math.max(0, Math.round((now - input.saved.at.getTime()) / 360_000) / 10) : null,
  };
}

// ---------------------------------------------------------------------------
// The flags.

/** Project files and My files are on for this person (and box): `user-projects-enabled` and `project-files-enabled`. */
export async function projectFilesEnabled(user: FlagUser, box?: FlagBox | null): Promise<boolean> {
  if (!await userProjectsEnabled(user)) return false;
  return boolVariation(PROJECT_FILES_FLAG, user, false, box);
}

// ---------------------------------------------------------------------------
// Making the spaces.

export interface FilesSpace { id: string; name: string }

type Tx = Prisma.TransactionClient;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`user-projects:${userId}`}))`;
}

async function lockSpace(tx: Tx, spaceId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`space-files:${spaceId}`}))`;
}

const MAX_CANDIDATES = 50;

/** The first candidate name no space has (a deleted space's name was released). */
async function freeName(tx: Tx, candidate: (n: number) => string): Promise<string> {
  for (let n = 1; n <= MAX_CANDIDATES; n++) {
    const name = candidate(n);
    if (!await tx.space.findUnique({ where: { name }, select: { id: true } })) return name;
  }
  throw new Error(`no free space name after ${candidate(MAX_CANDIDATES)}`);
}

/** A space owned by `userId`, as POST /api/spaces makes one, marked as made for files. */
async function makeSpace(tx: Tx, name: string, userId: string, description: string): Promise<FilesSpace> {
  const space = await tx.space.create({ data: { name, description, createdById: userId }, select: { id: true, name: true } });
  await tx.spaceMember.create({ data: { spaceId: space.id, userId, role: 'owner', addedById: userId } });
  await tx.spaceEvent.create({ data: { spaceId: space.id, actorUserId: userId, action: 'space.create', note: MADE_FOR_FILES_NOTE } });
  return space;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Runs `fn` again when a name it chose was taken in the moment between its check and its create. */
async function retryingNameClash<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= 2) throw err;
    }
  }
}

const live = (s: { id: string; name: string; deletedAt: Date | null } | null | undefined): FilesSpace | null =>
  s && !s.deletedAt ? { id: s.id, name: s.name } : null;

const SPACE_SELECT = { select: { id: true, name: true, deletedAt: true } } as const;

/**
 * The project's Project files, made now if it has none (or its space was
 * deleted). Null for a project that isn't `userId`'s. Idempotent under
 * concurrent calls: the make runs under the person's lock and reads again
 * first, so two at once make one space.
 */
export async function ensureProjectFiles(userProjectId: string, userId: string): Promise<FilesSpace | null> {
  const row = await prisma.userProject.findFirst({ where: { id: userProjectId, userId }, select: { filesSpace: SPACE_SELECT } });
  if (!row) return null;
  const have = live(row.filesSpace);
  if (have) return have;
  return retryingNameClash(() => prisma.$transaction(async tx => {
    await lockUser(tx, userId);
    const project = await tx.userProject.findFirst({
      where: { id: userProjectId, userId },
      select: { name: true, filesSpace: SPACE_SELECT, user: { select: { unixUsername: true } } },
    });
    if (!project) return null;
    const now = live(project.filesSpace);
    if (now) return now;
    const name = await freeName(tx, n => projectFilesName(project.user.unixUsername, project.name, n));
    const space = await makeSpace(tx, name, userId, `Project files for ${project.name}`.slice(0, 500));
    await tx.userProject.update({ where: { id: userProjectId }, data: { filesSpaceId: space.id } });
    return space;
  }, TX_OPTIONS));
}

/** The person's My files, made now if they have none; `made` says so (the caller grants it to their boxes). */
export async function ensureMyFiles(userId: string): Promise<{ space: FilesSpace; made: boolean } | null> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { myFilesSpace: SPACE_SELECT } });
  if (!row) return null;
  const have = live(row.myFilesSpace);
  if (have) return { space: have, made: false };
  return retryingNameClash(() => prisma.$transaction(async tx => {
    await lockUser(tx, userId);
    const user = await tx.user.findUnique({ where: { id: userId }, select: { unixUsername: true, myFilesSpace: SPACE_SELECT } });
    if (!user) return null;
    const now = live(user.myFilesSpace);
    if (now) return { space: now, made: false };
    const name = await freeName(tx, n => myFilesName(user.unixUsername, n));
    const space = await makeSpace(tx, name, userId, 'My files');
    await tx.user.update({ where: { id: userId }, data: { myFilesSpaceId: space.id } });
    return { space, made: true };
  }, TX_OPTIONS));
}

// ---------------------------------------------------------------------------
// Grants.

/** A box as the grant paths know it: its owner decides, and the flag reads it as the user+box context. */
export interface FilesBox { id: string; name: string; kind: string; userId: string | null }

async function spaceStore() {
  return (await import('./spaces/spacesRuntime')).spaceStore;
}

/**
 * Grant `space` to `box` as its owner, unless it already holds it. Only while
 * the owner may add a box to the space (editor or owner) and the box is theirs.
 */
async function grantOnce(space: FilesSpace, box: FilesBox, ownerId: string): Promise<boolean> {
  if (box.userId !== ownerId) return false;
  if (await prisma.spaceBox.findFirst({ where: { spaceId: space.id, instanceId: box.id }, select: { id: true } })) return true;
  const member = await prisma.spaceMember.findFirst({ where: { spaceId: space.id, userId: ownerId, role: { in: ['owner', 'editor'] } }, select: { userId: true } });
  if (!member) return false;
  const store = await spaceStore();
  await store.addGrant(space.id, box.id, ownerId);
  await store.recordEvent({ spaceId: space.id, actorUserId: ownerId, action: 'box.add', path: box.name, note: FILES_GRANT_NOTE });
  return true;
}

export interface GrantedFiles {
  /** Each project's files the box now holds, by UserProject id. */
  projects: Map<string, FilesSpace>;
  /** The owner's My files, when the box now holds it. */
  mine: FilesSpace | null;
}

const NOTHING = (): GrantedFiles => ({ projects: new Map(), mine: null });

/**
 * Whether every live box that inherits `box`'s grants (its children of the
 * same owner, theirs, and so on: services/spaces/spaceInheritance.ts) can
 * address the new spaces too. A child's agent that doesn't announce
 * project-files-v1 (an older one, or one not connected, so it can't say) would
 * see Project files and My files through its parent and lose its bare-path
 * default, so the parent gets them only once none would. A terminated box
 * passes nothing on, so it and what's below it don't count.
 */
export async function heirsCanAddress(box: FilesBox): Promise<boolean> {
  const { instanceAgentTransport } = await import('./agentRegistry');
  const seen = new Set([box.id]);
  let frontier = [box.id];
  for (let hop = 0; hop < MAX_INHERITANCE_HOPS && frontier.length > 0; hop++) {
    const children = await prisma.instance.findMany({
      where: { parentInstanceId: { in: frontier }, userId: box.userId, status: { not: 'terminated' } },
      select: { id: true },
    });
    frontier = [];
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      if (!isCapable(instanceAgentTransport(child.id)?.capabilities)) return false;
      frontier.push(child.id);
    }
  }
  return true;
}

/**
 * What a capable box of `owner`'s should hold for the projects it runs
 * (`userProjectIds`), made and granted now: each project's files, and My
 * files while `myFilesOnBoxes` is on. Nothing for a box whose agent doesn't
 * announce project-files-v1, or with the flags off for the owner and box.
 */
export async function grantFilesToBox(owner: FlagUser & { id: string }, box: FilesBox, capabilities: readonly string[], userProjectIds: readonly string[]): Promise<GrantedFiles> {
  const out = NOTHING();
  if (!isCapable(capabilities) || box.userId !== owner.id) return out;
  const enabled = await projectFilesEnabled(owner, box);
  if (enabled && !await heirsCanAddress(box)) {
    console.log(`[PROJECT-FILES] ${box.name}: a box below it can't address Project files yet; no grants until it can`);
    return out;
  }
  const prefs = enabled ? await prisma.user.findUnique({ where: { id: owner.id }, select: { myFilesOnBoxes: true } }) : null;
  const plan = grantPlan({ capable: true, enabled, myFilesOnBoxes: prefs?.myFilesOnBoxes ?? false });
  if (plan.projectFiles) {
    for (const id of new Set(userProjectIds)) {
      const space = await ensureProjectFiles(id, owner.id);
      if (space && await grantOnce(space, box, owner.id)) out.projects.set(id, space);
    }
  }
  if (plan.myFiles) {
    const mine = await ensureMyFiles(owner.id);
    if (mine && await grantOnce(mine.space, box, owner.id)) {
      // Turned off meanwhile (setMyFilesOnBoxes writes the setting, then removes the grants): take this one back,
      // so either the opt-out's removal or this check sees the other and no grant outlives the switch.
      if ((await prisma.user.findUnique({ where: { id: owner.id }, select: { myFilesOnBoxes: true } }))?.myFilesOnBoxes === false) {
        await removeMyFilesGrants(owner.id);
      } else {
        out.mine = mine.space;
      }
    }
    if (mine?.made) void grantMyFilesEverywhere(owner).catch(err => console.warn(`[PROJECT-FILES] ${owner.id}: My files to every box: ${(err as Error).message}`));
  }
  return out;
}

/** The name of the person's My files, or null before it's made (or once it's deleted). */
export async function myFilesSpaceName(userId: string): Promise<string | null> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { myFilesSpace: SPACE_SELECT } });
  return live(row?.myFilesSpace)?.name ?? null;
}

/** The projects with a live checkout on `boxId` of `ownerId`'s. */
async function projectsOnBox(boxId: string, ownerId: string): Promise<string[]> {
  const rows = await prisma.project.findMany({
    where: { instanceId: boxId, userId: ownerId, archived: false, userProjectId: { not: null } },
    select: { userProjectId: true },
  });
  return [...new Set(rows.flatMap(r => (r.userProjectId ? [r.userProjectId] : [])))];
}

/**
 * A capable agent's hello: the box gets My files (while on) and the Project
 * files of every project with a live checkout there. On every hello, so a box
 * that was parked or launching when its session started catches up.
 */
export async function grantOnHello(owner: FlagUser & { id: string }, box: FilesBox, capabilities: readonly string[]): Promise<GrantedFiles> {
  if (!isCapable(capabilities)) return NOTHING();
  return grantFilesToBox(owner, box, capabilities, await projectsOnBox(box.id, owner.id));
}

/**
 * Grants on every capable hello (grantOnHello), once the hello's own writes
 * and credential delivery have settled. Registered by index.ts; returns the
 * unsubscribe.
 */
export function startProjectFilesGrants(): () => void {
  let off: (() => void) | null = null;
  let stopped = false;
  void import('./agentRegistry').then(({ onBoxAgentHello }) => {
    if (stopped) return;
    off = onBoxAgentHello(ev => {
      if (!isCapable(ev.capabilities)) return;
      void ev.settled
        .then(() => grantOnHello(ev.user, { id: ev.instance.id, name: ev.instance.name, kind: ev.instance.kind, userId: ev.instance.userId }, ev.capabilities))
        .catch(err => console.warn(`[PROJECT-FILES] ${ev.instance.name}: grants on hello: ${(err as Error).message}`));
    });
  });
  return () => { stopped = true; off?.(); };
}

async function capableBoxesOf(userId: string): Promise<Array<{ box: FilesBox; capabilities: string[] }>> {
  const { connectedOwnedBoxes } = await import('./agentRegistry');
  return connectedOwnedBoxes()
    .filter(c => c.user.id === userId && isCapable(c.capabilities))
    .map(c => ({ box: { id: c.instance.id, name: c.instance.name, kind: c.instance.kind, userId: c.instance.userId }, capabilities: c.capabilities }));
}

/** My files on every connected capable box the person owns (a box not connected now gets it on its hello). */
export async function grantMyFilesEverywhere(owner: FlagUser & { id: string }): Promise<number> {
  let n = 0;
  for (const { box, capabilities } of await capableBoxesOf(owner.id)) {
    const granted = await grantFilesToBox(owner, box, capabilities, []);
    if (granted.mine) n++;
  }
  return n;
}

/** My files' grants on every box the person owns, removed (the opt-out). The space and its files stay. */
export async function removeMyFilesGrants(userId: string): Promise<number> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { myFilesSpaceId: true } });
  if (!row?.myFilesSpaceId) return 0;
  const grants = await prisma.spaceBox.findMany({
    where: { spaceId: row.myFilesSpaceId, instance: { userId } },
    select: { instanceId: true, instance: { select: { name: true } } },
  });
  const store = await spaceStore();
  let n = 0;
  for (const g of grants) {
    if (!await store.removeGrant(row.myFilesSpaceId, g.instanceId)) continue;
    await store.recordEvent({ spaceId: row.myFilesSpaceId, actorUserId: userId, action: 'box.remove', path: g.instance.name, note: FILES_GRANT_NOTE });
    n++;
  }
  return n;
}

/**
 * Settings > My files, "Put My files on my boxes". Off removes My files from
 * every box they own, and no grant path adds it back while it's off; on grants
 * it to every capable box they own.
 */
export async function setMyFilesOnBoxes(owner: FlagUser & { id: string }, on: boolean): Promise<void> {
  await prisma.user.update({ where: { id: owner.id }, data: { myFilesOnBoxes: on } });
  if (on) await grantMyFilesEverywhere(owner);
  else await removeMyFilesGrants(owner.id);
}

// ---------------------------------------------------------------------------
// A session.

/**
 * A new session's space (Workstream.spaceId) when it has a project: the
 * project's files, made now. Null with the flags off, or when they can't be
 * made (the session then gets its space as before).
 */
export async function sessionSpaceChoice(user: FlagUser & { id: string }, userProjectId: string | null | undefined): Promise<FilesSpace | null> {
  if (!userProjectId || !await projectFilesEnabled(user)) return null;
  try {
    return await ensureProjectFiles(userProjectId, user.id);
  } catch (err) {
    console.warn(`[PROJECT-FILES] ${userProjectId}: Project files not made for a new session: ${(err as Error).message}`);
    return null;
  }
}

/**
 * A session started on checkout `checkoutId`: its box gets the project's
 * files (and My files) now if its agent is connected and capable; else on
 * the agent's hello. Never throws.
 */
export async function grantSessionFiles(owner: FlagUser & { id: string }, checkoutId: string): Promise<void> {
  try {
    const checkout = await prisma.project.findFirst({
      where: { id: checkoutId, userId: owner.id },
      select: { userProjectId: true, instance: { select: { id: true, name: true, kind: true, userId: true } } },
    });
    if (!checkout?.instance || !checkout.userProjectId) return;
    const { instanceAgentTransport } = await import('./agentRegistry');
    const agent = instanceAgentTransport(checkout.instance.id);
    if (!agent?.helloReceived) return;
    await grantFilesToBox(owner, checkout.instance, agent.capabilities, [checkout.userProjectId]);
  } catch (err) {
    console.warn(`[PROJECT-FILES] ${checkoutId}: session grants: ${(err as Error).message}`);
  }
}

/** A chat turn's `files` (agent/chat-runner.js filesOf): the space names its TERMAG_SPACE and TERMAG_MY_FILES take. */
export interface TurnFiles { project: string | null; mine: string | null }

/**
 * The `files` a chat turn of workstream `workstreamId` carries, granted to its
 * box first: its project's files and its owner's My files, each only once the
 * box holds it. Undefined (send nothing) for a box that can't take it, with
 * the flags off for the owner and box, or for a session with no project and
 * no My files. Never throws: a turn goes out without it.
 */
export async function turnFilesFor(workstreamId: string, capabilities: readonly string[]): Promise<TurnFiles | undefined> {
  if (!isCapable(capabilities)) return undefined;
  try {
    const ws = await prisma.workstream.findUnique({ where: { id: workstreamId }, select: { project: { select: CHECKOUT_FILES_SELECT } } });
    return ws?.project ? await filesOfCheckout(ws.project, capabilities) : undefined;
  } catch (err) {
    console.warn(`[PROJECT-FILES] ${workstreamId}: turn files: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * The same for an agent pane of checkout `checkoutId` as it launches
 * (services/agentRuntime.ts, services/launchCommand.ts filesEnvPrefix): its
 * TERMAG_SPACE and TERMAG_MY_FILES for the pane's whole life. Never throws.
 */
export async function paneFilesFor(checkoutId: string | null | undefined, capabilities: readonly string[]): Promise<TurnFiles | undefined> {
  if (!checkoutId || !isCapable(capabilities)) return undefined;
  try {
    const checkout = await prisma.project.findUnique({ where: { id: checkoutId }, select: CHECKOUT_FILES_SELECT });
    return checkout ? await filesOfCheckout(checkout, capabilities) : undefined;
  } catch (err) {
    console.warn(`[PROJECT-FILES] ${checkoutId}: pane files: ${(err as Error).message}`);
    return undefined;
  }
}

const CHECKOUT_FILES_SELECT = {
  userProjectId: true,
  user: { select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true } },
  instance: { select: { id: true, name: true, kind: true, userId: true } },
} as const;

async function filesOfCheckout(
  checkout: { userProjectId: string | null; user: FlagUser & { id: string }; instance: FilesBox | null },
  capabilities: readonly string[],
): Promise<TurnFiles | undefined> {
  if (!checkout.instance) return undefined;
  const granted = await grantFilesToBox(checkout.user, checkout.instance, capabilities, checkout.userProjectId ? [checkout.userProjectId] : []);
  const project = checkout.userProjectId ? granted.projects.get(checkout.userProjectId)?.name ?? null : null;
  const mine = granted.mine?.name ?? null;
  return project || mine ? { project, mine } : undefined;
}

// ---------------------------------------------------------------------------
// Use an existing space.

export type UseSpaceResult =
  | { ok: true; space: FilesSpace; previous: string | null }
  | { ok: false; status: 403 | 404 | 409; code: string; error: string };

/** A live space the caller owns, by name. */
async function ownedSpace(userId: string, name: unknown): Promise<FilesSpace | UseSpaceResult> {
  if (typeof name !== 'string' || !/^[a-z0-9-]{2,40}$/.test(name)) return { ok: false, status: 404, code: 'space_not_found', error: 'No such space' };
  const space = await prisma.space.findFirst({
    where: { name, deletedAt: null, readOnlyAt: null, members: { some: { userId } } },
    select: { id: true, name: true, members: { where: { userId }, select: { role: true } } },
  });
  if (!space) return { ok: false, status: 404, code: 'space_not_found', error: 'No such space' };
  if (space.members[0]?.role !== 'owner') return { ok: false, status: 403, code: 'space_not_owned', error: `You need to own ${space.name} to use it for files` };
  return { id: space.id, name: space.name };
}

async function holdersOf(tx: Tx, spaceId: string): Promise<{ projectId: string | null; myFilesOf: string[] }> {
  const project = await tx.userProject.findFirst({ where: { filesSpaceId: spaceId }, select: { id: true } });
  const people = await tx.user.findMany({ where: { myFilesSpaceId: spaceId }, select: { id: true } });
  return { projectId: project?.id ?? null, myFilesOf: people.map(p => p.id) };
}

/**
 * Use one of the caller's spaces as a project's files ("Use an existing space
 * for files…", PATCH /api/user-projects/:id `filesSpace`) or as their My files
 * (PUT /auth/me/preferences `myFilesSpace`). It must be theirs to own, and
 * not already another project's files or anyone's My files (409
 * `space_in_use`), checked and written under the person's lock and the
 * space's. The space it replaces is kept, in Other spaces, with its files,
 * grants and sessions: deleting even an empty one termag made could race an
 * upload signed in the moment between the check and the delete (and an empty
 * file counts no bytes), so its owner deletes it if they want it gone.
 */
export async function useExistingSpace(
  user: FlagUser & { id: string },
  target: { kind: 'project'; userProjectId: string } | { kind: 'mine' },
  spaceName: unknown,
): Promise<UseSpaceResult> {
  const found = await ownedSpace(user.id, spaceName);
  if ('ok' in found) return found;
  const space = found;
  let previous: string | null;
  try {
    const answer = await prisma.$transaction(async (tx): Promise<UseSpaceResult | { ok: true; previous: string | null }> => {
      await lockUser(tx, user.id);
      await lockSpace(tx, space.id);
      let current: string | null;
      if (target.kind === 'project') {
        const project = await tx.userProject.findFirst({ where: { id: target.userProjectId, userId: user.id }, select: { filesSpaceId: true } });
        if (!project) return { ok: false, status: 404, code: 'user_project_not_found', error: 'No such project' };
        current = project.filesSpaceId;
      } else {
        current = (await tx.user.findUnique({ where: { id: user.id }, select: { myFilesSpaceId: true } }))?.myFilesSpaceId ?? null;
      }
      if (current === space.id) return { ok: true, previous: null };
      const why = spaceInUseReason(target.kind === 'project' ? target : { kind: 'mine', userId: user.id }, await holdersOf(tx, space.id));
      if (why) return { ok: false, status: 409, code: SPACE_IN_USE, error: why };
      if (target.kind === 'project') await tx.userProject.update({ where: { id: target.userProjectId }, data: { filesSpaceId: space.id } });
      else await tx.user.update({ where: { id: user.id }, data: { myFilesSpaceId: space.id } });
      return { ok: true, previous: current };
    }, TX_OPTIONS);
    if (!answer.ok) return answer;
    previous = answer.previous;
  } catch (err) {
    // Another project took it between the checks and the write: the unique filesSpaceId caught it.
    if (isUniqueViolation(err)) return { ok: false, status: 409, code: SPACE_IN_USE, error: 'That space is already a project\'s files' };
    throw err;
  }
  await grantAfterUse(user, target).catch(err => console.warn(`[PROJECT-FILES] ${user.id}: grants after use: ${(err as Error).message}`));
  return { ok: true, space, previous };
}

/** The boxes that should now hold the new space: those running the project, or (My files) every one of the person's. */
async function grantAfterUse(user: FlagUser & { id: string }, target: { kind: 'project'; userProjectId: string } | { kind: 'mine' }): Promise<void> {
  if (target.kind === 'mine') { await grantMyFilesEverywhere(user); return; }
  for (const { box, capabilities } of await capableBoxesOf(user.id)) {
    if ((await projectsOnBox(box.id, user.id)).includes(target.userProjectId)) await grantFilesToBox(user, box, capabilities, [target.userProjectId]);
  }
}

// ---------------------------------------------------------------------------
// files.saved.

/** Whether a space is a project's files, someone's My files, or neither. */
export async function filesLocation(spaceId: string): Promise<FilesLocation> {
  if (await prisma.userProject.findFirst({ where: { filesSpaceId: spaceId }, select: { id: true } })) return 'project-files';
  if (await prisma.user.findFirst({ where: { myFilesSpaceId: spaceId }, select: { id: true } })) return 'my-files';
  return 'other';
}

/**
 * The `files.saved` product event for an upload just signed (routes/spaces.ts
 * onUploadSigned), under project-files-enabled for the caller: where it went,
 * who saved it, whether the space was named, and its kind. Never throws.
 */
export async function recordFilesSaved(upload: { caller: SpaceCaller; spaceId: string; path: string; chosen: 'default' | 'explicit' | null }): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: upload.caller.userId },
      select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true },
    });
    if (!user || !await projectFilesEnabled(user)) return;
    const location = await filesLocation(upload.spaceId);
    recordProductEvent('files.saved', { user: user.id, box: upload.caller.kind === 'box' ? upload.caller.instanceId : null }, filesSavedDetail({ ...upload, location }));
  } catch (err) {
    console.warn(`[PROJECT-FILES] files.saved not recorded: ${(err as Error).message}`);
  }
}

/**
 * The `files.moved` product event for a file moved between spaces
 * (routes/spaces.ts files/move-to, onFileMoved), only when it went between
 * Project files and My files, under project-files-enabled for the mover. An
 * agent's save that a person moves soon after is a wrong call. Never throws.
 */
export async function recordFilesMoved(move: { caller: SpaceCaller; fromSpaceId: string; toSpaceId: string; saved: { byBox: boolean; at: Date } | null }): Promise<void> {
  try {
    const [from, to] = [await filesLocation(move.fromSpaceId), await filesLocation(move.toSpaceId)];
    // Only the crossover: Project files to My files or back, never two of one kind or another space.
    if (!isFilesCrossover(from, to)) return;
    const user = await prisma.user.findUnique({
      where: { id: move.caller.userId },
      select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true },
    });
    if (!user || !await projectFilesEnabled(user)) return;
    recordProductEvent('files.moved', { user: user.id, box: move.caller.kind === 'box' ? move.caller.instanceId : null }, filesMovedDetail({ from, to, caller: move.caller, saved: move.saved }));
  } catch (err) {
    console.warn(`[PROJECT-FILES] files.moved not recorded: ${(err as Error).message}`);
  }
}

/** project-files-enabled for a spaces caller, a person or their box (routes/spaces.ts moveToEnabled). Never throws. */
export async function projectFilesEnabledForCaller(caller: SpaceCaller): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: caller.userId },
      select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true },
    });
    return !!user && await projectFilesEnabled(user);
  } catch {
    return false;
  }
}

