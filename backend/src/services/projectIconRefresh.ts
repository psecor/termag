/**
 * When a repository's icons are looked for, and what's kept.
 * A person's repository
 * is read again a week after its last look (UserProjectRepo.iconsCheckedAt):
 * in the background when their project list is read, or by the picker, which
 * waits for it. Every candidate that passes the checks is stored
 * (projectIconStore.ts); the best becomes each of their projects' detected
 * icon for that repository; one no longer found is deleted unless a project
 * shows it. With no GitHub token connected nothing is read, and nothing is
 * stamped, so connecting one later finds them.
 */
import { prisma } from '../db';
import { onGithubCredentialChange, readGithubAccess } from './credentialStore';
import { detectRepoIcons, type Detected, type DetectDeps } from './projectIconDetect';
import { saveIcon } from './projectIconStore';
import { notifyWorkspaceChange } from './workspaceEvents';

export const ICONS_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** After GitHub failed (or no token was connected), the soonest this process asks again. */
const RETRY_MS = 60 * 60 * 1000;
const NO_TOKEN_MS = 10 * 60 * 1000;
/** A look this recent is reused for a repository whose project was made since (New project's picker looked first). */
const REUSE_MS = 10 * 60 * 1000;
/** Repositories read at once, across everyone. */
const CONCURRENCY = 2;

/** Whether a repository last looked at `checkedAt` is due another look. */
export function iconsDue(checkedAt: Date | null | undefined, now = Date.now()): boolean {
  return !checkedAt || now - checkedAt.getTime() >= ICONS_REFRESH_MS;
}

export interface RefreshDeps extends DetectDeps {
  token?: (userId: string) => Promise<string | null>;
  detect?: typeof detectRepoIcons;
  now?: () => number;
}

type Outcome = 'found' | 'none' | 'no-token' | 'error';

/** The last look this process made per person and repository, so the next isn't sooner than it should be. */
const lastLook = new Map<string, { at: number; outcome: Outcome; bestId: string | null }>();
const inFlight = new Map<string, Promise<Result>>();
/** When each person's list last started a background look: at most one a minute. */
const lastSweep = new Map<string, number>();
const SWEEP_MS = 60_000;
let running = 0;
const waiting: Array<() => void> = [];

/** At most CONCURRENCY at once: a finished look hands its slot straight to the next waiter, so none slips in between. */
async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY) await new Promise<void>(r => waiting.push(r));
  else running++;
  try {
    return await run();
  } finally {
    const next = waiting.shift();
    if (next) next(); else running--;
  }
}

const keyOf = (userId: string, repoKey: string) => `${userId}\n${repoKey}`;

/** Bumped when a person's GitHub credential changes: a look begun under the old one records nothing. */
const generation = new Map<string, number>();
const generationOf = (userId: string) => generation.get(userId) ?? 0;

/**
 * Everything this process remembers of a person's looks, forgotten (a look in flight finishes, but records
 * nothing and no longer holds the next one back), and their list's sweep throttle.
 */
export function forgetLooksOf(userId: string): void {
  generation.set(userId, generationOf(userId) + 1);
  for (const key of [...lastLook.keys()]) if (key.startsWith(`${userId}\n`)) lastLook.delete(key);
  for (const key of [...inFlight.keys()]) if (key.startsWith(`${userId}\n`)) inFlight.delete(key);
  lastSweep.delete(userId);
}

/**
 * Connecting or replacing a GitHub token: forget the person's looks, and make every repository of theirs
 * whose last look found nothing due again (a 403 or 404 under the old token may read under the new one),
 * so the next list read or picker looks at once.
 */
export async function credentialChanged(userId: string): Promise<void> {
  forgetLooksOf(userId);
  await prisma.userProjectRepo.updateMany({ where: { userProject: { userId }, iconId: null }, data: { iconsCheckedAt: null } });
}

onGithubCredentialChange(userId => {
  void credentialChanged(userId).catch(err => console.warn(`[PROJECT-ICONS] ${userId}: after a credential change: ${(err as Error).message}`));
});

/**
 * The best icon this process found for a repository of the person's lately (New project's picker, before a
 * project has it): null when that look found none, undefined when it hasn't looked (or GitHub failed).
 */
export function lastBestIcon(userId: string, repoKey: string): string | null | undefined {
  const last = lastLook.get(keyOf(userId, repoKey));
  return last && (last.outcome === 'found' || last.outcome === 'none') ? last.bestId : undefined;
}

/** For tests. */
export function forgetIconLooks(): void { lastLook.clear(); inFlight.clear(); lastSweep.clear(); }

/**
 * A row made since the last look (a new project with the repository) takes the icon its siblings show
 * while a look can't run (no token, GitHub failing, or held back after one of those), so what the picker
 * showed as Automatic is what the new project shows. Its own look time stays unset, so it's still due:
 * the next look that runs (a token connected, GitHub back) reads the repository for it. True when a row
 * took one.
 */
async function inheritFromSiblings(userId: string, repoKey: string): Promise<boolean> {
  const sibling = await prisma.userProjectRepo.findFirst({
    where: { repoKey, userProject: { userId }, iconId: { not: null } }, select: { iconId: true },
  });
  if (!sibling) return false;
  const { count } = await prisma.userProjectRepo.updateMany({
    where: { repoKey, userProject: { userId }, iconId: null, iconsCheckedAt: null },
    data: { iconId: sibling.iconId },
  });
  return count > 0;
}

/** Stamp every one of the person's rows for the repository (one per project with it) with its detected icon and the time. */
async function stamp(userId: string, repoKey: string, bestId: string | null, at: Date): Promise<void> {
  await prisma.userProjectRepo.updateMany({ where: { repoKey, userProject: { userId } }, data: { iconId: bestId, iconsCheckedAt: at } });
}

type Result = { outcome: Outcome; changed: boolean };

async function changedSince(userId: string, repoKey: string, before: ReadonlyArray<{ iconId: string | null }>): Promise<boolean> {
  const after = await prisma.userProjectRepo.findMany({ where: { repoKey, userProject: { userId } }, select: { iconId: true } });
  return before.map(r => r.iconId).sort().join() !== after.map(r => r.iconId).sort().join();
}

/**
 * Look for one repository's icons now, for one person, and keep what's found.
 * Returns whether anything a project draws changed.
 */
export async function refreshRepoIcons(userId: string, repoKey: string, deps: RefreshDeps = {}): Promise<Result> {
  const now = deps.now?.() ?? Date.now();
  const key = keyOf(userId, repoKey);
  const gen = generationOf(userId);
  // A credential change since this look began: what it learned is of the old token, so it isn't remembered.
  const remember = (look: { at: number; outcome: Outcome; bestId: string | null }) => { if (generationOf(userId) === gen) lastLook.set(key, look); };
  const before = await prisma.userProjectRepo.findMany({ where: { repoKey, userProject: { userId } }, select: { iconId: true } });
  const recent = lastLook.get(key);
  if (recent && (recent.outcome === 'found' || recent.outcome === 'none') && now - recent.at < REUSE_MS) {
    await stamp(userId, repoKey, recent.bestId, new Date(recent.at));
    return { outcome: recent.outcome, changed: before.some(r => r.iconId !== recent.bestId) };
  }
  const token = await (deps.token ?? (async (u: string) => (await readGithubAccess(u))?.token ?? null))(userId);
  if (!token) {
    remember({ at: now, outcome: 'no-token', bestId: null });
    await inheritFromSiblings(userId, repoKey);
    return { outcome: 'no-token', changed: await changedSince(userId, repoKey, before) };
  }
  const found: Detected = await (deps.detect ?? detectRepoIcons)(repoKey, token, deps);
  // The token changed while GitHub was read: what this look found is of the old one, so it writes nothing
  // (no icon stored, no row stamped, nothing deleted), and the rows credentialChanged made due stay due.
  if (generationOf(userId) !== gen) return { outcome: 'error', changed: false };
  if (found.status === 'error') {
    console.warn(`[PROJECT-ICONS] ${repoKey}: looking for icons failed: ${found.why}`);
    remember({ at: now, outcome: 'error', bestId: null });
    await inheritFromSiblings(userId, repoKey);
    return { outcome: 'error', changed: await changedSince(userId, repoKey, before) };
  }
  const ids: string[] = [];
  for (const icon of found.status === 'ok' ? found.icons : []) {
    const saved = await saveIcon(userId, { data: icon.data, repoKey, path: icon.path });
    if (saved.ok && !ids.includes(saved.id)) ids.push(saved.id);
  }
  const bestId = ids[0] ?? null;
  if (generationOf(userId) !== gen) return { outcome: 'error', changed: false };
  await stamp(userId, repoKey, bestId, new Date(now));
  // What it no longer has, unless a project shows it; the repositories' pointers were just moved off it.
  await prisma.projectIcon.deleteMany({ where: { userId, repoKey, id: { notIn: ids }, projects: { none: {} } } });
  const outcome: Outcome = bestId ? 'found' : 'none';
  remember({ at: now, outcome, bestId });
  return { outcome, changed: before.some(r => r.iconId !== bestId) };
}

/** One look per person and repository at a time, at most CONCURRENCY at once. */
function look(userId: string, repoKey: string, deps: RefreshDeps): Promise<Result> {
  const key = keyOf(userId, repoKey);
  const already = inFlight.get(key);
  if (already) return already;
  const p = slot(() => refreshRepoIcons(userId, repoKey, deps))
    .catch((err): Result => { console.warn(`[PROJECT-ICONS] ${repoKey}: ${(err as Error).message}`); return { outcome: 'error', changed: false }; })
    // Only its own entry: after a token change, a new look may already hold this key.
    .finally(() => { if (inFlight.get(key) === p) inFlight.delete(key); });
  inFlight.set(key, p);
  return p;
}

/** Whether this process asked too recently to ask again (GitHub failed, no token, or a look just now). */
function heldBack(userId: string, repoKey: string, now: number): boolean {
  const last = lastLook.get(keyOf(userId, repoKey));
  if (!last) return false;
  if (last.outcome === 'error') return now - last.at < RETRY_MS;
  if (last.outcome === 'no-token') return now - last.at < NO_TOKEN_MS;
  return false;
}

/** The person's repositories due a look: never looked at, or a week ago. */
async function dueRepoKeys(userId: string, only: readonly string[] | null, now: number): Promise<{ due: string[]; held: string[] }> {
  const rows = await prisma.userProjectRepo.findMany({
    where: {
      userProject: { userId, archivedAt: null },
      ...(only ? { repoKey: { in: [...only] } } : {}),
      OR: [{ iconsCheckedAt: null }, { iconsCheckedAt: { lt: new Date(now - ICONS_REFRESH_MS) } }],
    },
    select: { repoKey: true },
  });
  const keys = [...new Set(rows.map(r => r.repoKey))];
  return { due: keys.filter(k => !heldBack(userId, k, now)), held: keys.filter(k => heldBack(userId, k, now)) };
}

/** Held back from looking: a new row still takes its siblings' icon. True when one did. */
async function inheritHeld(userId: string, held: readonly string[]): Promise<boolean> {
  const took = await Promise.all(held.map(k => inheritFromSiblings(userId, k)));
  return took.some(Boolean);
}

/**
 * GET /api/user-projects: look, in the background, for the icons of the
 * person's repositories that are due, and push `projects` when an icon a
 * project draws changed. At most once a minute per person, unless `force` (a
 * project just made or given a repository: its new rows take the picker's look
 * now); the caller doesn't wait (the promise is for tests), and it never rejects.
 */
export function refreshDueIconsInBackground(userId: string, deps: RefreshDeps = {}, opts: { force?: boolean } = {}): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const last = lastSweep.get(userId);
  if (!opts.force && last !== undefined && now - last < SWEEP_MS) return Promise.resolve();
  lastSweep.set(userId, now);
  return dueRepoKeys(userId, null, now).then(async ({ due, held }) => {
    const [results, inherited] = await Promise.all([Promise.all(due.map(k => look(userId, k, deps))), inheritHeld(userId, held)]);
    if (inherited || results.some(r => r.changed)) notifyWorkspaceChange(userId, 'projects');
  }).catch(err => console.warn(`[PROJECT-ICONS] ${userId}: background look failed: ${(err as Error).message}`));
}

/**
 * The picker: look now for the given repositories, the person's projects' ones
 * that are due, or (New project, no project yet) any not looked at in this
 * process lately, waiting up to `waitMs` so its choices are current.
 */
export async function refreshForPicker(userId: string, repoKeys: readonly string[], opts: { waitMs?: number; deps?: RefreshDeps } = {}): Promise<void> {
  const deps = opts.deps ?? {};
  const now = deps.now?.() ?? Date.now();
  const found = await dueRepoKeys(userId, repoKeys, now);
  const due = new Set(found.due);
  if (await inheritHeld(userId, found.held)) notifyWorkspaceChange(userId, 'projects');
  const owned = new Set((await prisma.userProjectRepo.findMany({
    where: { repoKey: { in: [...repoKeys] }, userProject: { userId } }, select: { repoKey: true },
  })).map(r => r.repoKey));
  for (const k of repoKeys) {
    const last = lastLook.get(keyOf(userId, k));
    if (!owned.has(k) && !heldBack(userId, k, now) && !(last && now - last.at < REUSE_MS)) due.add(k);
  }
  if (due.size === 0) return;
  const all = Promise.all([...due].map(k => look(userId, k, deps))).then(results => {
    if (results.some(r => r.changed)) notifyWorkspaceChange(userId, 'projects');
  });
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([all, new Promise<void>(r => { timer = setTimeout(r, opts.waitMs ?? 10_000); timer.unref?.(); })]);
  clearTimeout(timer);
}
