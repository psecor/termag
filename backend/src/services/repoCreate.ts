const BRANCH_CHARS = /^[a-zA-Z0-9_./-]+$/;

export function isBranchName(value: string): boolean {
  if (!BRANCH_CHARS.test(value)) return false;
  if (value.includes('..')) return false;
  if (value.startsWith('-')) return false;
  if (value.startsWith('/')) return false;
  return true;
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

export function archivedLookup(
  hasRepo: boolean,
  instanceId: string | null,
): { archived: true } | { archived: true; instanceId: string | null } {
  if (!hasRepo) return { archived: true };
  return { archived: true, instanceId };
}

export function archivedRepoConflict(
  hasRepo: boolean,
  foundOnRequestedBox: boolean,
): 'conflict' | 'unarchive' | 'fresh' {
  if (!foundOnRequestedBox) return 'fresh';
  return hasRepo ? 'conflict' : 'unarchive';
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
