/**
 * How long a New session takes to start, from its create to Claude's first
 * words, as one `session.start.timed` product event per session
 * (docs/agents/observability.md). It gives
 * Runs on: Auto real numbers for a later change; until there are enough, the
 * UI says words, not estimates.
 *
 * The phases that applied, in ms: `wakeMs` (a parked box, the create to its
 * agent's hello), `launchMs` (a box still launching or claimed, the same),
 * `cloneMs` (the box up, or the create, to the checkout being set up),
 * `firstTextMs` (from there to the first assistant text), and `totalMs`.
 * `placement` says how the session got its box: reuse, worktree, wake, pool or
 * cold. In memory, per process, as `box.resumed` is: a restart drops the
 * sample, and one that never says anything is dropped after an hour.
 * Metadata only.
 */
import { recordProductEvent } from './productEvents';

export type StartPlacement = 'reuse' | 'worktree' | 'wake' | 'pool' | 'cold';

interface Pending {
  userId: string;
  boxId: string;
  placement: StartPlacement;
  provider: string | null;
  at: number;
  boxUpAt?: number;
  setupAt?: number;
}

const pending = new Map<string, Pending>();
const DROP_AFTER_MS = 60 * 60_000;
const key = (projectId: string, workstream: string) => `${projectId}|${workstream}`;

/**
 * A box claimed from the warm pool for this session: claimed in the last few
 * minutes (New session claims it just before the create) and with no session
 * on it yet. A later session on it is a reuse.
 */
export function claimedJustNow(claimedAt: Date | null | undefined, otherSessions: number, now = Date.now()): boolean {
  return !!claimedAt && otherSessions === 0 && now - claimedAt.getTime() < 10 * 60_000;
}

/** How a session got its box, from the box's status at the create (and whether the browser claimed it from the pool). */
export function placementFor(boxStatus: string, warmClaimed: boolean | undefined): StartPlacement {
  // A parked box is a wake whatever claimed it once; a claim counts only for the box's first session.
  if (['stopped', 'hibernated', 'starting', 'stopping', 'hibernating'].includes(boxStatus)) return 'wake';
  if (warmClaimed === true) return 'pool';
  if (['provisioning', 'awaiting-agent'].includes(boxStatus)) return 'cold';
  return 'reuse';
}

function sweep(now: number) {
  for (const [k, p] of pending) if (now - p.at > DROP_AFTER_MS) pending.delete(k);
}

/**
 * A New session was made. Its clock starts at `startedAt`, when the create was
 * asked for (the checkout may have finished inside the create, `setupDone`),
 * and a box whose agent is already connected is up from the start: a claimed
 * pool box's launch is the claim, before the create, and the browser times it.
 */
export function noteSessionCreated(
  projectId: string, workstream: string,
  p: { userId: string; boxId: string; placement: StartPlacement; provider: string | null; boxUp?: boolean; setupDone?: boolean },
  startedAt = Date.now(), now = Date.now(),
): void {
  sweep(now);
  const { boxUp, setupDone, ...rest } = p;
  pending.set(key(projectId, workstream), {
    ...rest, at: startedAt,
    ...(boxUp ? { boxUpAt: startedAt } : {}),
    ...(setupDone ? { setupAt: now } : {}),
  });
}

/** A box's agent said hello: the sessions waiting on it have their box. */
export function noteBoxUp(boxId: string, now = Date.now()): void {
  sweep(now);
  for (const p of pending.values()) if (p.boxId === boxId && p.boxUpAt === undefined && (p.placement === 'wake' || p.placement === 'cold' || p.placement === 'pool')) p.boxUpAt = now;
}

/** The project's checkout is set up (its clone ready, or no repository to clone). */
export function noteSetupDone(projectId: string, now = Date.now()): void {
  sweep(now);
  for (const [k, p] of pending) if (k.startsWith(`${projectId}|`) && p.setupAt === undefined) p.setupAt = now;
}

/** Claude's first words in the session: the event goes, once. */
export function noteFirstText(projectId: string, workstream: string, now = Date.now()): void {
  sweep(now);
  const k = key(projectId, workstream);
  const p = pending.get(k);
  if (!p) return;
  pending.delete(k);
  const boxUp = p.boxUpAt ?? p.at;
  const ready = p.setupAt ?? boxUp;
  recordProductEvent('session.start.timed', { user: p.userId, box: p.boxId }, {
    placement: p.placement,
    provider: p.provider,
    ...(p.placement === 'wake' && p.boxUpAt !== undefined ? { wakeMs: p.boxUpAt - p.at } : {}),
    ...((p.placement === 'cold' || p.placement === 'pool') && p.boxUpAt !== undefined && p.boxUpAt > p.at ? { launchMs: p.boxUpAt - p.at } : {}),
    ...(p.setupAt !== undefined ? { cloneMs: Math.max(0, p.setupAt - boxUp) } : {}),
    firstTextMs: Math.max(0, now - ready),
    totalMs: now - p.at,
  });
}

/** Tests: forget every pending session. */
export function resetSessionStartTiming(): void {
  pending.clear();
}
