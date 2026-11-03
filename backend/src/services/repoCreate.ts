const BRANCH_CHARS = /^[a-zA-Z0-9_./-]+$/;

export function isBranchName(value: string): boolean {
  if (!BRANCH_CHARS.test(value)) return false;
  if (value.includes('..')) return false;
  if (value.startsWith('-')) return false;
  if (value.startsWith('/')) return false;
  return true;
}

/**
 * A branch termag is about to create: isBranchName plus the rest of
 * `git check-ref-format`'s rules within that character set, so a bad name is
 * refused before anything is recorded rather than by `git worktree add -b`.
 * No empty or `.`-led path part (`team/`, `a//b`, `a/.b`), no part ending in
 * `.lock`, no trailing `.`, and not `HEAD`. (`@` and `{` are already outside
 * isBranchName's characters.)
 */
export function isNewBranchName(value: string): boolean {
  if (!isBranchName(value)) return false;
  if (value === 'HEAD' || value.endsWith('.')) return false;
  return value.split('/').every(part => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

export function recordedBranch(input: {
  instanceId: string | null;
  hasRepo: boolean;
  defaultBranch: string | null;
}): string | undefined {
  if (!input.instanceId) return undefined;
  if (!input.hasRepo) return 'main';
  if (input.defaultBranch != null && isBranchName(input.defaultBranch)) return input.defaultBranch;
  return 'HEAD';
}

/**
 * Where create looks for an archived project of the same name, in order. The
 * requested box comes first: its row is the one holding the name there, and
 * moving another box's row onto it would hit the (user, box, name) unique.
 * Only a plain create looks further, since it un-archives onto any box.
 */
export function archivedLookups(
  hasRepo: boolean,
  instanceId: string | null,
): Array<{ archived: true } | { archived: true; instanceId: string | null }> {
  if (!hasRepo) return [{ archived: true, instanceId }, { archived: true }];
  return [{ archived: true, instanceId }];
}

/**
 * What the New project form answered when create refused a name an archived
 * project holds on the box: bring that project back, or rename it aside
 * (archivedAsideName) and create the new one.
 */
export type ArchivedNameChoice = 'unarchive' | 'rename-aside';

/** null when absent; undefined for a value that is not a choice. */
export function parseArchivedNameChoice(value: unknown): ArchivedNameChoice | null | undefined {
  if (value == null) return null;
  return value === 'unarchive' || value === 'rename-aside' ? value : undefined;
}

/** The code on the 409 that asks the form for an ArchivedNameChoice. */
export const ARCHIVED_NAME_TAKEN = 'archived-name-taken';

export function archivedRepoConflict(
  hasRepo: boolean,
  found: { sameBox: boolean } | null,
  choice: ArchivedNameChoice | null = null,
): 'conflict' | 'unarchive' | 'rename-aside' | 'fresh' {
  if (!found) return 'fresh';
  // Another box's row does not hold the name here, so there is nothing to move aside.
  if (choice === 'rename-aside') return found.sameBox ? 'rename-aside' : 'fresh';
  if (choice === 'unarchive') return 'unarchive';
  return hasRepo ? 'conflict' : 'unarchive';
}

/**
 * The name an archived project is renamed to so a new one can take its name:
 * `<name>-archived-<day it was archived>`, then -2, -3… past names in use.
 */
export function archivedAsideName(name: string, archivedAt: Date, taken: ReadonlySet<string>): string {
  const base = `${name}-archived-${archivedAt.toISOString().slice(0, 10)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

export function parseClaimTiming(
  body: unknown,
): { ok: true; ms: number; pickMs: number | null } | { ok: false; error: string } {
  const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {};
  const ms = record.ms;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    return { ok: false, error: 'ms must be a finite non-negative number' };
  }
  if (record.pickMs == null) return { ok: true, ms, pickMs: null };
  const pickMs = record.pickMs;
  if (typeof pickMs !== 'number' || !Number.isFinite(pickMs) || pickMs < 0) {
    return { ok: false, error: 'pickMs must be a finite non-negative number' };
  }
  return { ok: true, ms, pickMs };
}
