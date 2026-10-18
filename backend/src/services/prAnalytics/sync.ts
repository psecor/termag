/**
 * One repo's sync step. Pages GitHub's
 * `pullRequests(orderBy: UPDATED_AT DESC)` connection, which has no result cap,
 * through injected fetch/write functions so the paging is tested without
 * GitHub.
 *
 *   First pass (backfillDone false): from the saved cursor down to the
 *   horizon, a bounded number of pages per call, resumable. The newest
 *   updatedAt seen when it started (backfillTop) becomes the high-water mark
 *   when it ends, so anything updated while it ran is picked up by the head
 *   pass, even a PR that moved from below the cursor to the top.
 *
 *   Head pass (backfillDone true): from the top down to the high-water mark.
 *   The mark only advances when the pass reaches it, so a pass cut short by
 *   the page budget or the rate limit is simply repeated.
 */

export interface PrNode {
  id: string;
  number: number;
  state: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  body: string | null;
  author: { login: string; __typename: string } | null;
  commits: { nodes: Array<{ commit: { messageBody: string; authors: { nodes: Array<{ user: { login: string } | null }> } } }> };
}

export interface RateLimit { remaining: number; limit: number; resetAt: string }

export interface Page {
  visibility: string;
  nodes: PrNode[];
  hasNextPage: boolean;
  endCursor: string | null;
  rateLimit: RateLimit;
}

export interface SyncState {
  backfillCursor: string | null;
  backfillTop: Date | null;
  backfillDone: boolean;
  highWater: Date | null;
}

export interface SyncDeps {
  fetchPage: (after: string | null) => Promise<Page>;
  write: (nodes: PrNode[], visibility: string) => Promise<void>;
  /** True when the rate limit says to stop for now. */
  shouldPause: (rate: RateLimit) => boolean;
}

export interface SyncResult { state: SyncState; pages: number; written: number; paused: boolean; visibility: string | null }

const t = (iso: string) => new Date(iso).getTime();
const newest = (nodes: PrNode[]) => nodes.reduce<number | null>((m, n) => (m == null || t(n.updatedAt) > m ? t(n.updatedAt) : m), null);

export async function syncRepo(start: SyncState, horizon: Date, maxPages: number, deps: SyncDeps): Promise<SyncResult> {
  const state: SyncState = { ...start };
  let pages = 0; let written = 0; let paused = false; let visibility: string | null = null;
  const h = horizon.getTime();

  if (!state.backfillDone) {
    let after = state.backfillCursor;
    while (pages < maxPages) {
      const page = await deps.fetchPage(after); pages++; visibility = page.visibility;
      if (after === null && state.backfillTop === null) {
        const top = newest(page.nodes);
        state.backfillTop = top === null ? horizon : new Date(top);
      }
      const keep = page.nodes.filter(n => t(n.updatedAt) >= h);
      if (keep.length) { await deps.write(keep, page.visibility); written += keep.length; }
      const last = page.nodes[page.nodes.length - 1];
      if (!page.hasNextPage || !last || t(last.updatedAt) < h) {
        state.backfillDone = true;
        state.highWater = state.backfillTop;
        state.backfillCursor = null;
        break;
      }
      after = page.endCursor;
      state.backfillCursor = after;
      if (deps.shouldPause(page.rateLimit)) { paused = true; break; }
    }
    return { state, pages, written, paused, visibility };
  }

  const mark = state.highWater?.getTime() ?? h;
  let after: string | null = null;
  let top: number | null = null;
  while (pages < maxPages) {
    const page = await deps.fetchPage(after); pages++; visibility = page.visibility;
    if (top === null) top = newest(page.nodes);
    const fresh = page.nodes.filter(n => t(n.updatedAt) > mark);
    if (fresh.length) { await deps.write(fresh, page.visibility); written += fresh.length; }
    const reached = !page.hasNextPage || page.nodes.length === 0 || page.nodes.some(n => t(n.updatedAt) <= mark);
    if (reached) {
      if (top !== null && top > mark) state.highWater = new Date(top);
      break;
    }
    after = page.endCursor;
    if (deps.shouldPause(page.rateLimit)) { paused = true; break; }
  }
  return { state, pages, written, paused, visibility };
}

/** Keep a share of the hourly budget for the token owner's own use (the PR pipeline). */
export function pauseBelow(reserveFraction: number) {
  return (rate: RateLimit) => rate.remaining < Math.max(50, rate.limit * reserveFraction);
}
