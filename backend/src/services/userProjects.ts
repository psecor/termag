/**
 * The project record.
 *
 * The pure rules first: a checkout's repo set and its key, a backfilled
 * project's name, which checkouts get a project and how they group, and "the
 * user's project for a repo set", the one lookup the backfill and every create
 * without a userProjectId use. Then the database half, all behind
 * `user-projects-enabled` except the backfill script: `ensureUserProjects`
 * (a person's checkouts without a project get one), `attachCheckout` (a new
 * checkout joins its project) and `checkRequestedUserProject` (a create that
 * names one). Each write runs under `pg_advisory_xact_lock` on
 * `user-projects:<userId>`, so two at once make one set of rows.
 *
 * `UserProject` is what the UI calls a project; `Project` stays a checkout on
 * one box.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { boolVariation } from './featureFlags';
import type { FlagUser } from './featureFlags';
import { MULTI_REPO_MAX, suggestRepoName } from './projectRepos';
import { parseRepoUrl, repoKey } from './projectTemplates';
import { isBranchName } from './repoCreate';

/** A project's name is 1–60 characters after trimming. */
export const USER_PROJECT_NAME_MAX = 60;

/** A backfilled project with no repositories. */
export const NO_REPO_PROJECT_NAME = 'Scratch';

/**
 * The checkout kinds that belong to a project. A `normal` checkout does, live
 * or archived, on any box (terminated included), and `termag ask --new-box`'s
 * (`createdFor: 'ask'`) is one. Automations, MetaTerm and space orchestrators
 * stay outside projects (the spec's open question 11).
 */
export const USER_PROJECT_KINDS: ReadonlySet<string> = new Set(['normal']);

/** What the rules read of a checkout (a `Project` row with its `ProjectRepo` rows). */
export interface CheckoutRepoFields {
  layout: string;
  repoUrl: string | null;
  repoDefaultBranch: string | null;
  repos: ReadonlyArray<{ url: string; defaultBranch: string | null; position: number }>;
}

export interface CheckoutForGrouping extends CheckoutRepoFields {
  id: string;
  kind: string;
  lastActiveAt: Date;
  createdAt: Date;
}

/** One repository of a repo set, in its checkout's order. */
export interface RepoSetEntry {
  /** owner/name, lowercased; for a URL that isn't GitHub's, the URL lowercased without `.git`. */
  repoKey: string;
  /** Its name in a project name: `termag`. */
  name: string;
  url: string;
  defaultBranch: string | null;
}

/** What the lookup reads of a project. */
export interface UserProjectForLookup {
  id: string;
  repoSetKey: string;
  formerRepoSetKeys: readonly string[];
  archivedAt: Date | null;
  createdAt: Date;
}

/**
 * One repository's key in a repo set: `repoKey` (owner/name, lowercased, the
 * https and ssh spellings alike), or for a URL it can't parse the URL itself,
 * trimmed, lowercased, without trailing slashes or `.git`. A comma would read
 * as two keys in the joined set, so it is escaped.
 */
export function repoSetEntryKey(url: string): string {
  const key = repoKey(url) ?? url.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
  return key.replace(/,/g, '%2c');
}

/** A repository's name in a project name: GitHub's repo name, else the URL's last path segment. */
export function repoDisplayName(url: string): string {
  const parsed = parseRepoUrl(url);
  if (parsed.ok) return parsed.repo;
  const last = url.trim().replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  return last.replace(/\.git$/i, '') || url.trim();
}

/** A set's key from its repositories' keys: deduplicated, sorted, joined by ","; "" for none. */
export function repoSetKeyOf(keys: Iterable<string>): string {
  return [...new Set([...keys].filter(k => k !== ''))].sort().join(',');
}

/** The key of the set these clone URLs make (order, case and spelling don't matter). */
export function repoSetKeyForUrls(urls: Iterable<string>): string {
  return repoSetKeyOf([...urls].map(repoSetEntryKey));
}

/**
 * A checkout's repositories in its own order, each once: a repo checkout's
 * `repoUrl` (none without one), a workspace's `ProjectRepo` rows by position.
 */
export function checkoutRepoSet(checkout: CheckoutRepoFields): RepoSetEntry[] {
  const raw = checkout.layout === 'workspace'
    ? [...checkout.repos].sort((a, b) => a.position - b.position).map(r => ({ url: r.url, defaultBranch: r.defaultBranch }))
    : checkout.repoUrl ? [{ url: checkout.repoUrl, defaultBranch: checkout.repoDefaultBranch }] : [];
  const seen = new Set<string>();
  const out: RepoSetEntry[] = [];
  for (const r of raw) {
    const key = repoSetEntryKey(r.url);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push({ repoKey: key, name: repoDisplayName(r.url), url: r.url, defaultBranch: r.defaultBranch ?? null });
  }
  return out;
}

/** The key a checkout groups by: its exact repo set. */
export function checkoutRepoSetKey(checkout: CheckoutRepoFields): string {
  return repoSetKeyOf(checkoutRepoSet(checkout).map(r => r.repoKey));
}

/** Whether a checkout of this kind belongs to a project. */
export function qualifiesForUserProject(checkout: { kind: string }): boolean {
  return USER_PROJECT_KINDS.has(checkout.kind);
}

/** The key that makes a name unique per user: trimmed and lowercased. */
export function projectNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * A backfilled project's name from its repositories, in the most recent
 * checkout's order: one is its name, two are both (`termag + termag-desktop`),
 * three or more the first and a count (`dev + 3 more`), none is `Scratch`.
 */
export function baseProjectName(repoNames: readonly string[]): string {
  if (repoNames.length === 0) return NO_REPO_PROJECT_NAME;
  if (repoNames.length === 1) return repoNames[0];
  if (repoNames.length === 2) return `${repoNames[0]} + ${repoNames[1]}`;
  return `${repoNames[0]} + ${repoNames.length - 1} more`;
}

function fit(base: string, suffix: string): string {
  return base.slice(0, USER_PROJECT_NAME_MAX - suffix.length).trimEnd() + suffix;
}

/**
 * `base`, or with " 2", " 3" and so on when the person already has that name
 * (`takenNameKeys` holds `projectNameKey`s, archived projects' included). Cut
 * so the whole name, suffix included, stays within 60 characters.
 */
export function uniqueProjectName(base: string, takenNameKeys: ReadonlySet<string>): string {
  const trimmed = base.trim() || NO_REPO_PROJECT_NAME;
  let name = fit(trimmed, '');
  for (let n = 2; takenNameKeys.has(projectNameKey(name)); n++) name = fit(trimmed, ` ${n}`);
  return name;
}

/** A group of checkouts with one repo set, which the backfill gives one project. */
export interface CheckoutGroup {
  repoSetKey: string;
  /** The most recent checkout's repositories, in its order: the project's repos and its name. */
  repos: RepoSetEntry[];
  /** The group's checkouts, most recent first. */
  checkoutIds: string[];
}

const byRecency = (a: CheckoutForGrouping, b: CheckoutForGrouping) =>
  b.lastActiveAt.getTime() - a.lastActiveAt.getTime()
  || b.createdAt.getTime() - a.createdAt.getTime()
  || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The checkouts that belong to a project, grouped by exact repo set. The most
 * recent (latest `lastActiveAt`, then `createdAt`) gives the group its
 * repositories. Groups come oldest first (by their oldest checkout), so where
 * two sets would get the same name, the older work keeps the plain one.
 */
export function groupCheckouts(checkouts: readonly CheckoutForGrouping[]): CheckoutGroup[] {
  const groups = new Map<string, { members: CheckoutForGrouping[]; oldest: number }>();
  for (const c of checkouts) {
    if (!qualifiesForUserProject(c)) continue;
    const key = checkoutRepoSetKey(c);
    const g = groups.get(key);
    if (g) {
      g.members.push(c);
      g.oldest = Math.min(g.oldest, c.createdAt.getTime());
    } else {
      groups.set(key, { members: [c], oldest: c.createdAt.getTime() });
    }
  }
  return [...groups.entries()]
    .sort(([ka, a], [kb, b]) => a.oldest - b.oldest || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .map(([repoSetKey, g]) => {
      const members = [...g.members].sort(byRecency);
      return { repoSetKey, repos: checkoutRepoSet(members[0]), checkoutIds: members.map(m => m.id) };
    });
}

function oldest<T extends UserProjectForLookup>(projects: T[]): T | null {
  return projects.reduce<T | null>((best, p) => {
    if (!best) return p;
    const d = p.createdAt.getTime() - best.createdAt.getTime();
    return d < 0 || (d === 0 && p.id < best.id) ? p : best;
  }, null);
}

/**
 * The user's project for a repo set, among their unarchived projects: one
 * whose set is exactly it, else one that had exactly it before a repository
 * was added (never for the empty set), else none. Only exact sets match, so a
 * project that merely contains the set's repositories never does. Of several
 * matches at a step, the oldest wins: the original home of a set keeps it.
 */
export function findUserProjectForRepoSet<T extends UserProjectForLookup>(projects: readonly T[], setKey: string): T | null {
  const live = projects.filter(p => p.archivedAt === null);
  const exact = oldest(live.filter(p => p.repoSetKey === setKey));
  if (exact || setKey === '') return exact;
  return oldest(live.filter(p => p.formerRepoSetKeys.includes(setKey)));
}

/** What the plan reads of a project: the lookup's fields and its name. */
export interface UserProjectForPlan extends UserProjectForLookup {
  name: string;
  nameKey: string;
}

/** What the backfill does with one group of checkouts. */
export interface PlanEntry {
  repoSetKey: string;
  repos: RepoSetEntry[];
  checkoutIds: string[];
  /** The project the group joins; null when the backfill makes one, named `name`. */
  existing: { id: string; name: string } | null;
  name: string;
}

/**
 * What `ensureUserProjects` does with a person's checkouts that have no
 * project: each group joins the person's project for its set, or gets a new
 * one, named from its repositories (" 2" on a clash with any of their names,
 * archived included). The dry run prints this; the backfill writes it.
 */
export function planUserProjects(checkouts: readonly CheckoutForGrouping[], projects: readonly UserProjectForPlan[]): PlanEntry[] {
  const taken = new Set(projects.map(p => p.nameKey));
  return groupCheckouts(checkouts).map(group => {
    const found = findUserProjectForRepoSet(projects, group.repoSetKey);
    if (found) return { ...group, existing: { id: found.id, name: found.name }, name: found.name };
    const name = uniqueProjectName(baseProjectName(group.repos.map(r => r.name)), taken);
    taken.add(projectNameKey(name));
    return { ...group, existing: null, name };
  });
}

/** Why a create naming a project can't use it, or null when it can. */
export function requestedProjectRefusal(
  project: { archivedAt: Date | null; repoSetKey: string } | null,
  requestSetKey: string,
): { status: 404 | 409; code: string; error: string } | null {
  if (!project) return { status: 404, code: 'user_project_not_found', error: 'No such project' };
  if (project.archivedAt) return { status: 409, code: 'user_project_archived', error: 'That project is archived' };
  if (project.repoSetKey !== requestSetKey) {
    return { status: 409, code: 'user_project_repos_mismatch', error: "The new session's repositories aren't that project's" };
  }
  return null;
}

/** A project made with + New project (POST /api/user-projects), checked. */
export interface NewUserProject {
  name: string;
  repoSetKey: string;
  /** In the order given: a checkout clones them in it. */
  repos: RepoSetEntry[];
}

/** Why POST /api/user-projects can't make that project: the field at fault, and for a repository, which one. */
export interface NewUserProjectError {
  field: 'name' | 'repos';
  error: string;
  /** The URL as given, when one repository is at fault. */
  repo?: string;
}

/**
 * POST /api/user-projects's body:
 * `{ name, repos: [{ url, defaultBranch? }] }`. The name is 1–60 characters
 * after trimming, any text. `repos` is `[]` (or left out) for none, else up to
 * `maxRepos` GitHub repositories (MULTI_REPO_MAX, the cap a workspace checkout
 * takes; 1 while multi-repo-projects-enabled is off for the person, since
 * their first checkout couldn't be made), each once (by `repoKey`). Two can't
 * share a repository name (`acme/api` and `octo/api`): a workspace checkout
 * puts each in a folder named after it (services/projectRepos.ts suggestRepoName).
 */
export function planNewUserProject(body: unknown, maxRepos = MULTI_REPO_MAX): { ok: true; project: NewUserProject } | ({ ok: false } & NewUserProjectError) {
  const input = body && typeof body === 'object' ? body as { name?: unknown; repos?: unknown } : {};
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return { ok: false, field: 'name', error: 'Give the project a name' };
  if (name.length > USER_PROJECT_NAME_MAX) return { ok: false, field: 'name', error: `A project's name is at most ${USER_PROJECT_NAME_MAX} characters` };
  const rawRepos = input.repos ?? [];
  if (!Array.isArray(rawRepos)) return { ok: false, field: 'repos', error: 'repos must be a list' };
  if (rawRepos.length > maxRepos) {
    return { ok: false, field: 'repos', error: maxRepos === 1 ? 'Projects with more than one repository are not on for you' : `A project holds at most ${maxRepos} repositories` };
  }
  const repos: RepoSetEntry[] = [];
  for (const raw of rawRepos as Array<{ url?: unknown; defaultBranch?: unknown } | null>) {
    const given = typeof raw?.url === 'string' ? raw.url : '';
    const parsed = parseRepoUrl(raw?.url);
    if (!parsed.ok) return { ok: false, field: 'repos', repo: given, error: `${given.trim() || 'A repository'} isn't a GitHub repository URL` };
    const key = repoSetEntryKey(parsed.url);
    if (repos.some(r => r.repoKey === key)) return { ok: false, field: 'repos', repo: given, error: `${key} is listed twice` };
    const folder = suggestRepoName(parsed.url).toLowerCase();
    const clash = repos.find(r => suggestRepoName(r.url).toLowerCase() === folder);
    if (clash) return { ok: false, field: 'repos', repo: given, error: `${key} and ${clash.repoKey} would both be checked out as ${folder}: pick one` };
    const branch = typeof raw?.defaultBranch === 'string' && raw.defaultBranch.trim() ? raw.defaultBranch.trim() : null;
    if (branch !== null && !isBranchName(branch)) return { ok: false, field: 'repos', repo: given, error: `${key}: "${branch}" is not a branch name` };
    repos.push({ repoKey: key, name: repoDisplayName(parsed.url), url: parsed.url, defaultBranch: branch });
  }
  return { ok: true, project: { name, repoSetKey: repoSetKeyOf(repos.map(r => r.repoKey)), repos } };
}

/** Why a repository can't be added to a project (POST /api/user-projects/:id/repos), or the entry to add. */
export type AddedRepoPlan =
  | { ok: true; repo: RepoSetEntry }
  | { ok: false; status: 400 | 409; code: string; error: string };

/**
 * A repository added to a project ("Adding
 * a repository"): `{ url, defaultBranch? }`, a GitHub repository the project
 * doesn't hold yet (409 user_project_repo_exists), within `maxRepos` (409
 * user_project_repo_limit at MULTI_REPO_MAX, a workspace checkout's cap; 1
 * while multi-repo-projects-enabled is off for the person), and not one whose
 * checkout folder another of its repositories already takes.
 */
export function planAddedUserProjectRepo(
  existing: ReadonlyArray<{ repoKey: string; url: string }>, body: unknown, maxRepos = MULTI_REPO_MAX,
): AddedRepoPlan {
  const raw = body && typeof body === 'object' ? body as { url?: unknown; defaultBranch?: unknown } : {};
  const given = typeof raw.url === 'string' ? raw.url : '';
  const parsed = parseRepoUrl(raw.url);
  if (!parsed.ok) return { ok: false, status: 400, code: 'user_project_invalid', error: `${given.trim() || 'That'} isn't a GitHub repository URL` };
  const key = repoSetEntryKey(parsed.url);
  if (existing.some(r => r.repoKey === key)) return { ok: false, status: 409, code: 'user_project_repo_exists', error: `The project already has ${key}` };
  if (existing.length >= maxRepos) {
    return maxRepos === 1
      ? { ok: false, status: 409, code: 'user_project_repo_limit', error: 'Projects with more than one repository are not on for you' }
      : { ok: false, status: 409, code: 'user_project_repo_limit', error: `A project holds at most ${maxRepos} repositories` };
  }
  const folder = suggestRepoName(parsed.url).toLowerCase();
  const clash = existing.find(r => suggestRepoName(r.url).toLowerCase() === folder);
  if (clash) return { ok: false, status: 400, code: 'user_project_invalid', error: `${key} and ${clash.repoKey} would both be checked out as ${folder}` };
  const branch = typeof raw.defaultBranch === 'string' && raw.defaultBranch.trim() ? raw.defaultBranch.trim() : null;
  if (branch !== null && !isBranchName(branch)) return { ok: false, status: 400, code: 'user_project_invalid', error: `${key}: "${branch}" is not a branch name` };
  return { ok: true, repo: { repoKey: key, name: repoDisplayName(parsed.url), url: parsed.url, defaultBranch: branch } };
}

/**
 * The project's keys once a repository is added: its new set, and the set it
 * had kept among its former ones (never the empty set, and each once), so a
 * checkout made on the old set still finds it (findUserProjectForRepoSet).
 */
export function grownRepoSetKeys(project: { repoSetKey: string; formerRepoSetKeys: readonly string[] }, addedKey: string): { repoSetKey: string; formerRepoSetKeys: string[] } {
  const repoSetKey = repoSetKeyOf([...project.repoSetKey.split(',').filter(Boolean), addedKey]);
  const former = project.repoSetKey === '' || project.formerRepoSetKeys.includes(project.repoSetKey)
    ? [...project.formerRepoSetKeys]
    : [...project.formerRepoSetKeys, project.repoSetKey];
  return { repoSetKey, formerRepoSetKeys: former };
}

/**
 * The clone URLs a create asks for (POST /api/projects): `repos` for a
 * workspace, else `repoUrl`, else none. Null for a `repos` that isn't a list,
 * which the create refuses (400) rather than read.
 */
export function createRepoUrls(input: { repoUrl?: unknown; repos?: unknown }): string[] | null {
  if (input.repos != null) {
    if (!Array.isArray(input.repos)) return null;
    return input.repos.map((r: unknown) => {
      const url = r && typeof r === 'object' ? (r as { url?: unknown }).url : undefined;
      return typeof url === 'string' ? url : '';
    });
  }
  return typeof input.repoUrl === 'string' && input.repoUrl.trim() ? [input.repoUrl] : [];
}

// ---------------------------------------------------------------------------
// The database half.

/** Whether the project record is on for this person (`user-projects-enabled`). */
export function userProjectsEnabled(user: FlagUser): Promise<boolean> {
  return boolVariation('user-projects-enabled', user, false);
}

type Tx = Prisma.TransactionClient;

const CHECKOUT_SELECT = {
  id: true, kind: true, layout: true, repoUrl: true, repoDefaultBranch: true, lastActiveAt: true, createdAt: true,
  repos: { select: { url: true, defaultBranch: true, position: true } },
} as const;

const PROJECT_SELECT = {
  id: true, name: true, nameKey: true, repoSetKey: true, formerRepoSetKeys: true, archivedAt: true, createdAt: true,
} as const;

/** A person's checkouts that should have a project and don't. */
function unattachedWhere(userId: string): Prisma.ProjectWhereInput {
  return { userId, userProjectId: null, kind: { in: [...USER_PROJECT_KINDS] } };
}

async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`user-projects:${userId}`}))`;
}

async function createUserProject(tx: Tx, userId: string, entry: { name: string; repoSetKey: string; repos: RepoSetEntry[] }, origin: 'backfill' | 'checkout' | 'person') {
  return tx.userProject.create({
    data: {
      userId, name: entry.name, nameKey: projectNameKey(entry.name), repoSetKey: entry.repoSetKey, origin,
      repos: { create: entry.repos.map((r, position) => ({ repoKey: r.repoKey, url: r.url, defaultBranch: r.defaultBranch, position })) },
    },
    select: PROJECT_SELECT,
  });
}

/**
 * Point checkouts at a project, in SQL so `Project.updatedAt` stays as it
 * was: an archived checkout's is when it was archived (the create route's
 * archived-name answer and its rename-aside read it). `onlyUnattached` leaves a
 * checkout another write attached first alone.
 */
async function setUserProject(tx: Tx, checkoutIds: string[], userProjectId: string, onlyUnattached: boolean): Promise<number> {
  if (checkoutIds.length === 0) return 0;
  return onlyUnattached
    ? tx.$executeRaw`UPDATE "projects" SET "userProjectId" = ${userProjectId} WHERE "id" = ANY(${checkoutIds}) AND "userProjectId" IS NULL`
    : tx.$executeRaw`UPDATE "projects" SET "userProjectId" = ${userProjectId} WHERE "id" = ANY(${checkoutIds})`;
}

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

/**
 * Give each of a person's checkouts that should have a project, and doesn't,
 * one (the plan above), and attach them. Idempotent: the common case is one
 * indexed read that finds nothing. Runs at the top of the person's project
 * reads while the flag is on for them, so turning it on backfills them and a
 * checkout made while it was off is picked up on the next read.
 */
export async function ensureUserProjects(userId: string): Promise<{ attached: number; created: number }> {
  const none = { attached: 0, created: 0 };
  if (!await prisma.project.findFirst({ where: unattachedWhere(userId), select: { id: true } })) return none;
  return prisma.$transaction(async tx => {
    await lockUser(tx, userId);
    const checkouts = await tx.project.findMany({ where: unattachedWhere(userId), select: CHECKOUT_SELECT });
    if (checkouts.length === 0) return none;
    const projects = await tx.userProject.findMany({ where: { userId }, select: PROJECT_SELECT });
    let attached = 0;
    let created = 0;
    for (const entry of planUserProjects(checkouts, projects)) {
      let id = entry.existing?.id;
      if (!id) {
        id = (await createUserProject(tx, userId, entry, 'backfill')).id;
        created++;
      }
      attached += await setUserProject(tx, entry.checkoutIds, id, true);
    }
    return { attached, created };
  }, TX_OPTIONS);
}

/**
 * The project a create that names one may use (POST /api/projects with
 * `userProjectId`): the caller's own, unarchived, with exactly the repo set
 * the create asks for. Answers the refusal otherwise (404, or 409
 * `user_project_archived` / `user_project_repos_mismatch`).
 */
export async function checkRequestedUserProject(
  userId: string, requested: unknown, repoUrls: readonly string[],
): Promise<{ ok: true; id: string } | { ok: false; status: 400 | 404 | 409; code: string; error: string }> {
  if (typeof requested !== 'string' || requested === '') {
    return { ok: false, status: 400, code: 'user_project_invalid', error: 'userProjectId must be a project id' };
  }
  const project = await prisma.userProject.findFirst({ where: { id: requested, userId }, select: { archivedAt: true, repoSetKey: true } });
  const refusal = requestedProjectRefusal(project, repoSetKeyForUrls(repoUrls));
  return refusal ? { ok: false, ...refusal } : { ok: true, id: requested };
}

/**
 * + New project (POST /api/user-projects): make the person's project, with no
 * checkout yet (its first session makes one). A name they already have,
 * ignoring case and archived ones included, is refused with that project's id
 * and whether it's archived, so the form can offer to unarchive it.
 */
export async function createPersonUserProject(
  userId: string, project: NewUserProject,
): Promise<{ ok: true; id: string } | { ok: false; taken: { id: string; name: string; archived: boolean } }> {
  const nameKey = projectNameKey(project.name);
  const clash = (tx: Tx | typeof prisma) => tx.userProject.findFirst({ where: { userId, nameKey }, select: { id: true, name: true, archivedAt: true } });
  const taken = (row: { id: string; name: string; archivedAt: Date | null }) => ({ ok: false as const, taken: { id: row.id, name: row.name, archived: row.archivedAt !== null } });
  try {
    return await prisma.$transaction(async tx => {
      await lockUser(tx, userId);
      const existing = await clash(tx);
      if (existing) return taken(existing);
      return { ok: true as const, id: (await createUserProject(tx, userId, project, 'person')).id };
    }, TX_OPTIONS);
  } catch (err) {
    // A write that doesn't take the lock made the name meanwhile: the unique index caught it.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    const existing = await clash(prisma);
    if (!existing) throw err;
    return taken(existing);
  }
}

/**
 * Add a repository to one of the person's projects (POST /api/user-projects/:id/repos),
 * under the record's lock: its new checkouts clone it; the ones it has keep
 * what they cloned, and a create on the old set still finds it (its former
 * sets). 404 when it isn't theirs, 409 for an archived one, else the plan's refusal.
 */
export async function addUserProjectRepo(
  userId: string, projectId: string, body: unknown, maxRepos = MULTI_REPO_MAX,
): Promise<{ ok: true } | { ok: false; status: 400 | 404 | 409; code: string; error: string }> {
  return prisma.$transaction(async tx => {
    await lockUser(tx, userId);
    const project = await tx.userProject.findFirst({
      where: { id: projectId, userId },
      select: { id: true, archivedAt: true, repoSetKey: true, formerRepoSetKeys: true, repos: { select: { repoKey: true, url: true, position: true } } },
    });
    if (!project) return { ok: false as const, status: 404 as const, code: 'user_project_not_found', error: 'No such project' };
    if (project.archivedAt) return { ok: false as const, status: 409 as const, code: 'user_project_archived', error: 'That project is archived' };
    const plan = planAddedUserProjectRepo(project.repos, body, maxRepos);
    if (!plan.ok) return plan;
    const position = project.repos.reduce((m, r) => Math.max(m, r.position + 1), 0);
    await tx.userProjectRepo.create({
      data: { userProjectId: project.id, repoKey: plan.repo.repoKey, url: plan.repo.url, defaultBranch: plan.repo.defaultBranch, position },
    });
    await tx.userProject.update({ where: { id: project.id }, data: grownRepoSetKeys(project, plan.repo.repoKey) });
    return { ok: true as const };
  }, TX_OPTIONS);
}

/**
 * A checkout just made (or un-archived) joins its project: the one the create
 * named, when it is still the caller's and on the checkout's set, or on the
 * set the create checked it against (`checkedSetKey`) when a repository was
 * added to it meanwhile; else the one it already has; else the person's
 * project for its set (the lookup), made now (`origin: checkout`) when there
 * is none. Answers the project's id, or null for a checkout of a kind that has none.
 */
export async function attachCheckout(userId: string, checkoutId: string, requestedId: string | null = null, checkedSetKey: string | null = null): Promise<string | null> {
  return prisma.$transaction(async tx => {
    await lockUser(tx, userId);
    const checkout = await tx.project.findFirst({
      where: { id: checkoutId, userId }, select: { ...CHECKOUT_SELECT, userProjectId: true },
    });
    if (!checkout || !qualifiesForUserProject(checkout)) return null;
    const setKey = checkoutRepoSetKey(checkout);
    const projects = await tx.userProject.findMany({ where: { userId }, select: PROJECT_SELECT });
    const requested = requestedId ? projects.find(p => p.id === requestedId) ?? null : null;
    // On the project's set, or on the set the create checked it against (`checkedSetKey`,
    // checkRequestedUserProject) when a repository was added to it since (addUserProjectRepo), the
    // empty set included: still the person's choice, never another project's that holds the old set.
    const fits = !!requested && (!requestedProjectRefusal({ ...requested, archivedAt: null }, setKey)
      || (checkedSetKey !== null && checkedSetKey === setKey));
    if (requested && fits) {
      // Archived since the create checked it (checkRequestedUserProject), by an archive that ran
      // meanwhile (routes/userProjectWrites.ts): the session the person asked for there is live
      // now, so the project is too, rather than its checkout joining another one.
      if (requested.archivedAt) await tx.userProject.update({ where: { id: requested.id }, data: { archivedAt: null } });
      await setUserProject(tx, [checkout.id], requested.id, false);
      return requested.id;
    }
    if (checkout.userProjectId) return checkout.userProjectId;
    const [entry] = planUserProjects([checkout], projects);
    const id = entry.existing?.id ?? (await createUserProject(tx, userId, entry, 'checkout')).id;
    await setUserProject(tx, [checkout.id], id, true);
    return id;
  }, TX_OPTIONS);
}
