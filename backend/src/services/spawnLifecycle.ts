/**
 * When a spawned agent is parked or retired. Pure:
 * the sweep and the dismiss routes gather the inputs and act.
 *
 *   park    stop the agent CLI; worktree, branch, conversation and report stay
 *   retire  remove the workstream (worktree, tmux pair, Slack channel, the
 *           local branch once pushed); never with work that would be lost
 */

export interface BranchState {
  dirty: boolean;
  upstream: string | null;
  ahead: number;
  /** Commits origin's base lacks (or, local-only, its spawn base); null when it could not be counted. */
  aheadOfBase: number | null;
  /** The checkout has no origin at all: nothing could ever be pushed (#453). */
  localOnly?: boolean;
  /** A local-only count was made against the commit it was spawned from (the only base that counts). */
  spawnBaseCounted?: boolean;
  /**
   * Origin itself (git ls-remote) holds HEAD on the upstream branch: true,
   * false, or null when it could not be told. Absent from agents that predate
   * the check, which then can never count as pushed.
   */
  remoteContainsHead?: boolean | null;
}

export type RetireCheck =
  | { ok: true; why: 'nothing_beyond_base' | 'pushed' }
  | { ok: false; reason: string };

/**
 * May this checkout be removed? Only when nothing in it would be lost: no
 * uncommitted change, and every commit either already in origin's base or on
 * its pushed upstream. Anything that cannot be told (no state, counts
 * unknown) is kept. "Ahead of base" alone never decides: a squash merge
 * leaves a branch ahead for good, so a pushed branch counts as safe, but only
 * when origin itself confirms it holds HEAD: the local remote-tracking ref can
 * be stale (the branch deleted on the server) or gone, and still say "ahead 0".
 */
export function retireCheck(s: BranchState | null): RetireCheck {
  if (!s) return { ok: false, reason: 'its checkout state could not be read' };
  if (s.dirty) return { ok: false, reason: 'uncommitted changes' };
  // No remote: only a count against the commit it was spawned from decides, and only an empty
  // one goes. Without one (no recorded base, as a new project's spawn; a box agent that predates
  // the local count; an agent that counted some other way) it is kept.
  if (s.localOnly) {
    if (s.aheadOfBase === 0 && s.spawnBaseCounted) return { ok: true, why: 'nothing_beyond_base' };
    if (s.aheadOfBase !== null && s.aheadOfBase > 0 && s.spawnBaseCounted) {
      return { ok: false, reason: `${s.aheadOfBase} commit${s.aheadOfBase === 1 ? '' : 's'} of its own (a local-only project: nothing to push to)` };
    }
    return { ok: false, reason: 'a local-only project (no remote), and nothing records the commit it was spawned from to count against' };
  }
  if (s.aheadOfBase === 0) return { ok: true, why: 'nothing_beyond_base' };
  if (s.upstream && s.ahead > 0) return { ok: false, reason: `${s.ahead} commit${s.ahead === 1 ? '' : 's'} not pushed` };
  if (s.upstream && s.remoteContainsHead === true) return { ok: true, why: 'pushed' };
  if (s.upstream && s.remoteContainsHead === false) return { ok: false, reason: 'origin does not have its commits (branch deleted, or not pushed)' };
  if (s.upstream) return { ok: false, reason: 'could not confirm its branch is on origin' };
  if (s.aheadOfBase === null) return { ok: false, reason: 'its commits could not be counted' };
  return { ok: false, reason: `${s.aheadOfBase} commit${s.aheadOfBase === 1 ? '' : 's'} never pushed` };
}

export interface LifecycleRow {
  relationship: string;
  state: string;
  reportedAt: Date | null;
  parkedAt: Date | null;
  retiredAt: Date | null;
  endedAt: Date | null;
}

export interface LifecycleContext {
  /** The child agent pane's live status (working / waiting / idle / not_running). */
  paneStatus: string;
  /** When that status last changed, ms epoch; null when unknown. */
  paneSince: number | null;
  parkIdleMs: number;
  now: number;
}

/**
 * What the sweep does with one spawn now: park it, consider retiring it (the
 * caller reads its checkout and asks retireNow), or nothing.
 */
export function lifecycleStep(r: LifecycleRow, c: LifecycleContext): 'park' | 'retire' | 'none' {
  if (r.retiredAt) return 'none';
  // Waiting on someone: never touched.
  if (r.state === 'blocked' || r.state === 'needs_input' || r.state === 'failed') return 'none';
  if (r.state !== 'done' || !r.reportedAt) return 'none';
  if (r.parkedAt && c.paneStatus !== 'not_running') {
    // Parked but its pane is live (launched again by some other path): a
    // retire would kill a working agent. Wait until it stops.
    return 'none';
  }
  if (!r.parkedAt) {
    if (r.endedAt) return 'none'; // its pane is already gone: nothing to stop
    if (c.paneStatus !== 'idle') return 'none';
    const idleSince = Math.max(r.reportedAt.getTime(), c.paneSince ?? 0);
    return c.now - idleSince >= c.parkIdleMs ? 'park' : 'none';
  }
  // Peers are parked, never retired automatically. A parked delegate is a
  // candidate: retireNow decides once its checkout has been read.
  return r.relationship === 'delegate' ? 'retire' : 'none';
}

/**
 * Retire a parked delegate now? Its work must be safe to remove (retireCheck)
 * and either have landed (its PR merged, or nothing beyond the base) or have
 * sat parked past the retire delay. A refusal comes back as the reason kept.
 */
export function retireNow(
  check: RetireCheck,
  c: { prMerged: boolean; parkedForMs: number; retireAfterMs: number },
): { retire: true } | { retire: false; kept: string | null } {
  if (!check.ok) return { retire: false, kept: check.reason };
  const landed = c.prMerged || check.why === 'nothing_beyond_base';
  if (landed || c.parkedForMs >= c.retireAfterMs) return { retire: true };
  return { retire: false, kept: null };
}

/** The lifecycle as one word for views and list_spawns. */
export function lifecycleLabel(r: Pick<LifecycleRow, 'parkedAt' | 'retiredAt' | 'endedAt'> & { keptReason?: string | null }): string | null {
  if (r.retiredAt) return 'retired';
  if (r.endedAt && r.parkedAt) return 'ended · parked';
  if (r.parkedAt) return r.keptReason ? `parked · kept: ${r.keptReason}` : 'parked';
  return null;
}

/** The `git-branch-state` RPC reply as a BranchState; null when it is not one. */
export function branchStateFromRpc(raw: unknown): BranchState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.dirty !== 'boolean') return null;
  const ahead = typeof r.ahead === 'number' && Number.isInteger(r.ahead) && r.ahead >= 0 ? r.ahead : null;
  if (ahead === null) return null;
  const aob = r.aheadOfBase;
  const rch = r.remoteContainsHead;
  return {
    dirty: r.dirty,
    // No ahead/behind line from git means the upstream ref is gone: treat it as never pushed.
    upstream: typeof r.upstream === 'string' && r.upstream && r.abKnown !== false ? r.upstream : null,
    ahead,
    aheadOfBase: typeof aob === 'number' && Number.isInteger(aob) && aob >= 0 ? aob : null,
    // `origin` is the remote's URL, null with none; absent from a malformed answer, which stays remote.
    ...('origin' in r && r.origin === null ? { localOnly: true } : {}),
    ...(r.baseLocal === 'spawn-base' ? { spawnBaseCounted: true } : {}),
    ...(rch === true || rch === false ? { remoteContainsHead: rch } : { remoteContainsHead: null }),
  };
}
