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
 *   the page budget or the rate limit is simply repeated. The ingester runs
 *   these only when an owner's search (searchSync) has more hits than search
 *   returns; otherwise one search per owner stands in for them.
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
  /** For path-scoped groups (groups.ts scorePr): the title, and the first 100 changed files. */
  title?: string;
  files?: { nodes: Array<{ path: string }> } | null;
  commits: { nodes: Array<{ commit: { messageBody: string; authors: { nodes: Array<{ user: { login: string } | null }> } } }> };
  /** For the review metrics; absent in fixtures from before reviews were read. */
  reviews?: { totalCount: number; nodes: Array<{ id: string; author: { login: string; __typename: string } | null; state: string; submittedAt: string | null; body?: string | null; comments: { totalCount: number } }> } | null;
  comments?: { totalCount: number; nodes: Array<{ author: { login: string; __typename: string } | null }> } | null;
  timelineItems?: { nodes: Array<{ __typename?: string; createdAt?: string; requestedReviewer?: { __typename: string; login?: string; slug?: string } | null }> } | null;
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
      paused = deps.shouldPause(page.rateLimit);
      if (!page.hasNextPage || !last || t(last.updatedAt) < h) {
        state.backfillDone = true;
        state.highWater = state.backfillTop;
        state.backfillCursor = null;
        break;
      }
      after = page.endCursor;
      state.backfillCursor = after;
      if (paused) break;
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
    // Checked on every page: most passes are one page long, and a check only
    // before the next page never ran, so 158 one-page passes a quarter-hour
    // spent the owner's whole quota (2026-10-21).
    paused = deps.shouldPause(page.rateLimit);
    if (reached) {
      if (top !== null && top > mark) state.highWater = new Date(top);
      break;
    }
    after = page.endCursor;
    if (paused) break;
  }
  return { state, pages, written, paused, visibility };
}

/** A search hit: a PR node plus the repository it is in. */
export interface SearchNode extends PrNode { repository: { nameWithOwner: string; visibility: string } }

export interface SearchPage {
  issueCount: number;
  nodes: SearchNode[];
  hasNextPage: boolean;
  endCursor: string | null;
  rateLimit: RateLimit;
}

/** GitHub search returns at most this many results for one query. */
export const SEARCH_CAP = 1000;

export interface SearchSyncDeps {
  fetchPage: (after: string | null) => Promise<SearchPage>;
  /** Write the hits of one repo (owner/name, lowercase). */
  write: (repo: string, nodes: SearchNode[], visibility: string) => Promise<void>;
  /** Whether a repo (owner/name, lowercase) is one this pass covers. */
  include: (repo: string) => boolean;
  shouldPause: (rate: RateLimit) => boolean;
}

export interface SearchSyncResult {
  pages: number;
  written: number;
  paused: boolean;
  /** Every page was read: the covered repos are current as of the search. */
  complete: boolean;
  /** More hits than search returns: the caller falls back to per-repo passes. */
  overCap: boolean;
  /** Where to continue a search cut short (the page budget, the rate limit); null once complete. */
  cursor: string | null;
}

/**
 * The incremental pass for one owner: a single search for its PRs updated
 * since a time, instead of a head pass per repo, resumable from `start` (the
 * cursor a cut-short run returned). Hits in repos the pass does
 * not cover are skipped. One search costs what one repo's head pass did, and
 * an owner's quarter-hour of changes is a page or two, while the head passes
 * cost a page per repo whether anything changed or not.
 */
export async function searchSync(maxPages: number, deps: SearchSyncDeps, start: string | null = null): Promise<SearchSyncResult> {
  let pages = 0; let written = 0; let paused = false; let after: string | null = start;
  while (pages < maxPages) {
    const page = await deps.fetchPage(after); pages++;
    paused = deps.shouldPause(page.rateLimit);
    if (page.issueCount > SEARCH_CAP) return { pages, written, paused, complete: false, overCap: true, cursor: null };
    const byRepo = new Map<string, SearchNode[]>();
    for (const n of page.nodes) {
      const repo = n.repository?.nameWithOwner?.toLowerCase();
      if (!repo || !deps.include(repo)) continue;
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), n]);
    }
    for (const [repo, nodes] of byRepo) {
      await deps.write(repo, nodes, nodes[0].repository.visibility.toLowerCase());
      written += nodes.length;
    }
    if (!page.hasNextPage) return { pages, written, paused, complete: true, overCap: false, cursor: null };
    after = page.endCursor;
    if (paused) break;
  }
  return { pages, written, paused, complete: false, overCap: false, cursor: after };
}

/** Keep a share of the hourly budget for the token owner's own use (the PR pipeline). */
export function pauseBelow(reserveFraction: number) {
  return (rate: RateLimit) => rate.remaining < Math.max(50, rate.limit * reserveFraction);
}
