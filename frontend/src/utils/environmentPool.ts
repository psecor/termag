// An environment's pool as people read it: the environment page's line
// and the create dialogs' "ready in about 20 s". Pure, so the wording is a unit test.
import type { EnvironmentPoolView } from '../services/api';

/** "40 min ago", "3 h ago", "just now": how long ago an ISO time was, coarsely. */
export function agoLabel(iso: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** The newest prepared commit, short: one repository's, or the first of several with how many more. */
export function commitLabel(commits: Record<string, string> | null): string | null {
  const entries = Object.entries(commits ?? {});
  if (!entries.length) return null;
  if (entries.length === 1) return entries[0][1].slice(0, 7);
  return entries.map(([repo, sha]) => `${repo.split('/')[1]}@${sha.slice(0, 7)}`).join(', ');
}

/** The pool line: "3 ready, prepared 40 min ago at abc1234", with what is still preparing. Split so the commit can be code. */
export function poolLine(pool: EnvironmentPoolView, now: number = Date.now()): { text: string; commit: string | null } {
  if (!pool.ready) {
    if (pool.target <= 0) return { text: 'No pool: its boxes are going', commit: null };
    return { text: pool.preparing ? `None ready yet, ${pool.preparing} preparing` : 'None ready', commit: null };
  }
  const preparing = pool.preparing ? `, ${pool.preparing} preparing` : '';
  const when = pool.preparedAt ? `, prepared ${agoLabel(pool.preparedAt, now)}` : '';
  const commit = commitLabel(pool.preparedCommit);
  return { text: `${pool.ready} ready${preparing}${when}${commit ? ' at' : ''}`, commit };
}

/** "in 40 min", "in 3 h", "now": how long until an ISO time, coarsely. */
export function inLabel(iso: string, now: number = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return iso;
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `in ${min} min`;
  return `in ${Math.round(min / 60)} h`;
}

/**
 * When the pool's stopped boxes are next checked for new commits on their default branches: a box whose branches
 * moved is started, pulled, set up again and stopped; one whose didn't is left as it is. Null when nothing is stopped.
 */
export function refreshLine(pool: EnvironmentPoolView, now: number = Date.now()): string | null {
  if (!pool.nextRefreshAt || pool.target <= 0) return null;
  return `Next refresh check ${inLabel(pool.nextRefreshAt, now)}`;
}

/**
 * The Pool card's line for its last failed prepare: when, and what the pool does next. A setup that ran and failed
 * holds it until the setup or a default branch changes; any other failure (the launch, the image, a clone, a timeout)
 * is tried again ENV_POOL_RETRY_MS (backend services/envPool.ts) after it.
 */
export function poolFailureLine(at: string, now: number = Date.now()): string {
  return `The last prepare failed ${agoLabel(at, now)}. A failed setup holds the pool until its setup or a default branch changes; any other failure is tried again 10 minutes after it.`;
}

/** What a create dialog says about a new box for this environment: a pool box starts in about 20 s. */
export const POOL_READY_HINT = 'ready in about 20 s';

/** Whether a new box for the environment would start from its pool now. */
export function poolHasBox(pool: EnvironmentPoolView | null | undefined): boolean {
  return !!pool && pool.ready > 0;
}
