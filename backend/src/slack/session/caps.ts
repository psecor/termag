/**
 * How many agent runs may go at once, by thread scope. Every scope has the per-person cap (#555) and the global cap
 * (M1); space turns also have a per-space cap. The space caps' code defaults
 * are the tech spec's (§10); the `space-slack-limits` flag (M3) will override
 * them.
 */

import { agentRuns, globalRunCapReached, MAX_AGENT_RUNS_PER_USER, MAX_AGENT_RUNS_TOTAL, runsFor } from './claims';
import type { ThreadScope } from './scope';

export type RunCap = {
  /** Runs one person may have going at once. */
  perRequester: number;
  /** Runs for everyone together. */
  global: number;
  /** Runs in one space at once; null where the scope has no space. */
  perSpace: number | null;
};

/** `concurrentTurnsPerSpace`'s default (tech spec §10). */
export const SPACE_TURNS_AT_ONCE = 2;

export function capFor(scope: ThreadScope): RunCap {
  const base = { perRequester: MAX_AGENT_RUNS_PER_USER, global: MAX_AGENT_RUNS_TOTAL };
  return scope === 'space' ? { ...base, perSpace: SPACE_TURNS_AT_ONCE } : { ...base, perSpace: null };
}

export function runsForSpace(spaceId: string): number {
  let n = 0;
  for (const run of agentRuns.values()) if (run.spaceId === spaceId) n++;
  return n;
}

/** Why a new run must not start under `cap`, as the text the thread is told; null when it may. */
export function capRefusal(cap: RunCap, who: { userId: string; spaceId: string | null }): string | null {
  if (runsFor(who.userId) >= cap.perRequester) {
    return `You have ${cap.perRequester} conversations with me running already. Stop one, or wait for one to finish, then ask again.`;
  }
  if (globalRunCapReached(cap.global)) return AT_CAPACITY;
  if (cap.perSpace !== null && who.spaceId && runsForSpace(who.spaceId) >= cap.perSpace) return SPACE_AT_CAPACITY;
  return null;
}

const AT_CAPACITY = "_I'm running as many conversations as I can for everyone right now. Try again in a few minutes._";
const SPACE_AT_CAPACITY = "_This space has as many conversations running as it can take right now. Try again when one finishes._";
