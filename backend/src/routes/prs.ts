import { Router, RequestHandler } from 'express';
import { requireAuth, requireAuthOrAgentToken } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { connectedOwnedBoxes } from '../services/agentRegistry';
import { githubTokenSource } from '../services/credentialStore';
import { GithubApiError } from '../services/githubCredential';
import {
  TERMAG_REPO, assignLanes, branchLane, deployState, followsDeploy, groupByLane, isReviewLane, linkWorkstream, prKey, reviewTarget, touchesBoxes,
  type DeployState, type LinkableWorkstream, type MergedPr, type PrRow,
} from '../services/prPipeline';
import {
  GithubTimeoutError, MERGED_WINDOW_DAYS, commitContains, fetchPrLite, fetchPrsByNumber, mergedHeads, searchPrs, viewerLogin,
  type LitePr, type NumberedPr, type PrSearchResult,
} from '../services/prPipelineGithub';
import {
  bodySources, prismaSuggestionDismissals, suggestGroups, unknownRefs, type GroupSuggestion, type SuggestionDismissalStore,
} from '../services/prGroupSuggestions';
import { prisma } from '../db';
import { boolVariation } from '../services/featureFlags';
import { readBranches, type BranchSweep } from '../services/prBranches';
import {
  PrInputError, fetchPrHead, fetchPrOverview, mergePr, parseAnyPrRef, parseCommentInput, parseMergeInput, parsePrRef, parseReviewInput, parseReviewersInput,
  postComment, requestReviewers, rerunFailedChecks, submitReview,
  type MergeInput, type MergeResult, type PrHead, type RerunResult, type ReviewersInput, type PrOverview, type PrRef, type ReviewInput, type SubmittedReview,
} from '../services/prReview';
import { termagVersion, type TermagVersion } from '../services/termagVersion';
import { BAKE_WORKFLOW_URL, bakeRuns, dispatchBake, newestOrchestratorImage, type BakeRun, type OrchestratorImage } from '../services/prDeploy';
import { swrMemo } from '../services/ttlMemo';
import { createWorkstreamFor } from './workstreams';
import { parseFirstPrompt } from '../services/firstPrompt';
import { sendResult, type RouteResult } from './routeResult';
import { parseDeferInput, parseDeferKey, prismaDeferrals, type DeferralStore, type PrDeferral } from '../services/prDeferrals';
import {
  assembleGroups, finishedGroups, parseCreateInput, parseMembers, parsePatchInput, prismaReviewGroups,
  type MemberInput, type ReviewGroup, type ReviewGroupStore, type StoredGroup,
} from '../services/prReviewGroups';
import {
  applyLinks, earlierLinks, parseAttachInput, parsePrIdent, prismaWorkstreamPrs, recordCheckoutLinks, type EarlierPr, type StoredLink, type WorkstreamPrStore,
} from '../services/workstreamPrs';

// The PR pipeline:
//
//   GET  /api/prs                              the user's pull requests, already in lanes
//   GET  /api/prs/:owner/:repo/:number         one PR up close, for the row's overview
//   POST /api/prs/:owner/:repo/:number/review  submit the user's review of it
//   POST /api/prs/:owner/:repo/:number/merge   merge it now, or turn auto-merge on / off
//   POST /api/prs/:owner/:repo/:number/rerun-failed  re-run its failed Actions jobs
//   POST /api/prs/:owner/:repo/:number/reviewers     (re-)request reviews
//   POST /api/prs/:owner/:repo/:number/comment       post a conversation comment (a reviewer ping)
//   POST /api/prs/:owner/:repo/:number/workstream    a new workstream on the PR's branch, attached to it ({ projectId, name })
//   POST /api/prs/bake                         bake main's orchestrator image (it deploys itself)
//   PUT  /api/prs/deferrals                    defer a row for N days ({ key, days }; again = N more)
//   DELETE /api/prs/deferrals?key=…            bring a deferred row back
//   PUT  /api/prs/links                        attach a PR to a workstream ({ repo, number, projectId, workstream })
//   DELETE /api/prs/links?repo=…&number=…      drop a PR's stored workstream link
//   POST /api/prs/groups                       a new review group ({ name, members? })
//   PATCH /api/prs/groups/:id                  rename, close or reopen it ({ name?, closed? })
//   PUT  /api/prs/groups/:id/members           its whole ordered member list ({ members: [{ repo, number, note? }] })
//   DELETE /api/prs/groups/:id                 delete it
//   POST /api/prs/group-suggestions/dismiss    "Not these" on a suggested group ({ key })
//   GET  /api/version                          the termag commit this orchestrator runs
//
// GitHub is read as the user, with their stored gh token; a user with none
// gets `{ connected: false }` and the client hides the section. Results are
// memoized per user for 60 s, then served stale while one reload runs, so a
// dashboard and a phone polling together cost one search a minute and only
// the very first load waits on GitHub.
//
// Lanes 1 and 2 (branches with no PR) come from the boxes' `git-branch-state`
// RPC (services/prBranches.ts), read inside the same memoized load.

const FRESH_MS = 60_000;
// Past a minute the last answer is served while a reload runs (the GitHub
// search takes seconds); past ten the caller waits, so an error surfaces.
const MAX_STALE_MS = 10 * 60_000;

export interface PipelineResponse {
  connected: true;
  viewer: string;
  lanes: ReturnType<typeof groupByLane>;
  prod: TermagVersion;
  /** The viewer's connected boxes, whose agent commit was checked for box-side merges. */
  boxes: number;
  /** Where termag merges stand between merge and prod: the newest orchestrator image and bakes in flight. */
  deploy: DeployPipeline;
  /** How far back merged PRs are searched: the Deployed and Merged lanes cover this many days. */
  mergedWindowDays: number;
  fetchedAt: string;
  notes: string[];
  /** Which repository each of the user's workstreams is a checkout of, when its box said: the overlay's Attach picker offers those first. */
  checkouts: { projectId: string; workstream: string; repo: string }[];
  /**
   * The sweep's workstreams, for linking review group members no lane lists
   * (a live checkout, a reviewTarget). Server-side only: GET /api/prs drops it.
   */
  linkable?: LinkableWorkstream[];
}

/** What GET /api/prs answers: the memoized pipeline plus the user's deferrals, read fresh. */
export type PrsResponse = PipelineResponse & {
  deferred: PrDeferral[];
  /** Stored workstream links whose PR no lane lists (services/workstreamPrs.ts earlierLinks): the sidebar's grey pills. */
  earlier: EarlierPr[];
  /** The user's review groups (services/prReviewGroups.ts): open ones, then closed ones kept a while. */
  groups: ReviewGroup[];
  /** Set when the groups' members could not be read from GitHub: the cards show what is stored. */
  groupsError?: string;
  /** Suggested review groups (services/prGroupSuggestions.ts), for a user with the flag on; else none. */
  suggestions: GroupSuggestion[];
};

export interface DeployPipeline {
  image: OrchestratorImage | null;
  /** Publish AMI runs on main queued or running; null when not asked (nothing waiting) or GitHub could not say. */
  bakes: BakeRun[] | null;
  workflowUrl: string;
}

/** Everything a load reads, injectable so the assembly is testable without GitHub or boxes. */
export interface PipelineDeps {
  search: (token: string, now: Date) => Promise<PrSearchResult>;
  branches: (userId: string) => Promise<BranchSweep>;
  version: () => Promise<TermagVersion>;
  contains: (token: string, repo: string, running: string, commit: string) => Promise<boolean | null>;
  mergedHeads: (token: string, viewer: string, heads: { repo: string; branch: string }[]) => Promise<Set<string> | null>;
  /** The commit each of the user's connected boxes' agent runs (null when it did not say). */
  boxCommits: (userId: string) => (string | null)[];
  orchestratorImage: () => Promise<OrchestratorImage | null>;
  bakeRuns: (token: string) => Promise<BakeRun[] | null>;
  /** Stores the rows' live checkout links (services/workstreamPrs.ts); absent in tests that do not care. */
  recordLinks?: (userId: string, rows: PrRow[]) => Promise<void>;
  /** Review group members by number (prPipelineGithub fetchPrsByNumber); absent in tests that do not care. */
  byNumber?: (token: string, viewer: string, refs: { repo: string; number: number }[]) => Promise<NumberedPr[]>;
  /** The token's login, for a group edit made before any list was read. */
  viewer?: (token: string) => Promise<string>;
  /** A few fields of PRs by number, with their descriptions when asked (suggested groups); absent in tests that do not care. */
  lite?: (token: string, refs: { repo: string; number: number }[], withBody: boolean) => Promise<LitePr[]>;
  /** Whether to suggest groups for the user (pr-review-groups-enabled): their descriptions are read only then. */
  suggestionsOn?: (userId: string) => Promise<boolean>;
  now: () => Date;
}

const defaultDeps: PipelineDeps = {
  search: (token, now) => searchPrs(token, now),
  branches: readBranches,
  version: termagVersion,
  contains: (token, repo, running, commit) => commitContains(token, repo, running, commit),
  mergedHeads: (token, viewer, heads) => mergedHeads(token, viewer, heads),
  boxCommits: userId => connectedOwnedBoxes().filter(b => b.user.id === userId).map(b => b.agentCommit),
  orchestratorImage: newestOrchestratorImage,
  bakeRuns: token => bakeRuns(token),
  recordLinks: (userId, rows) => recordCheckoutLinks(userId, rows),
  byNumber: (token, viewer, refs) => fetchPrsByNumber(token, viewer, refs),
  viewer: token => viewerLogin(token),
  lite: (token, refs, withBody) => fetchPrLite(token, refs, withBody),
  suggestionsOn: async userId => {
    const user = await prisma.user.findUnique({
      where: { id: userId }, select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true },
    });
    return user ? boolVariation('pr-review-groups-enabled', user, false) : false;
  },
  now: () => new Date(),
};

// Compare calls are cached forever, so this caps only a cold load's burst
// (merges × boxes), which could otherwise trip GitHub's secondary rate limit.
const COMPARE_CONCURRENCY = 6;

/** A tiny limiter: at most `n` of the returned function's calls run at once. */
export function limit(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => { active--; queue.shift()?.(); };
  return fn => new Promise((resolve, reject) => {
    const run = () => { active++; fn().then(resolve, reject).finally(next); };
    if (active < n) run(); else queue.push(run);
  });
}

/** Deploy state of each termag merge into main, keyed by prKey. */
export async function termagDeploys(
  token: string, merged: MergedPr[], prod: TermagVersion, deps: Pick<PipelineDeps, 'contains' | 'boxCommits'>,
  userId: string, image: OrchestratorImage | null = null,
): Promise<Map<string, DeployState>> {
  const out = new Map<string, DeployState>();
  const termag = merged.filter(pr => followsDeploy(pr) && pr.mergeCommit);
  if (termag.length === 0) return out;
  // The viewer's own boxes: the ones they can update. The fleet's are the admin's view.
  const boxShas = deps.boxCommits(userId);
  const gate = limit(COMPARE_CONCURRENCY);
  const contains = (running: string, commit: string) => gate(() => deps.contains(token, TERMAG_REPO, running, commit));
  await Promise.all(termag.map(async pr => {
    const oid = pr.mergeCommit!;
    const inProd = prod.sha ? await contains(prod.sha, oid) : null;
    const boxSide = touchesBoxes(pr.files, pr.filesTruncated);
    const inBox = inProd && boxSide
      ? await Promise.all(boxShas.map(sha => sha ? contains(sha, oid) : Promise.resolve(null)))
      : [];
    const state = deployState(inProd, boxSide, inBox);
    // Not on prod: is it at least in the image the next rollout ships?
    if (state.state === 'not_deployed') state.baked = image?.sha ? await contains(image.sha, oid) : null;
    out.set(prKey(pr.repo, pr.number), state);
  }));
  return out;
}

const SEARCH_NAME = { authored: 'your open pull requests', review: 'review requests', merged: 'your merges of the last 14 days' };

/** The response's notes: whatever is missing from the lanes, and why. */
export function pipelineNotes(search: Pick<PrSearchResult, 'truncated'> & Partial<Pick<PrSearchResult, 'checksMissing'>>, sweep: Pick<BranchSweep, 'offline' | 'outdatedAgent' | 'failed'>, prod: TermagVersion): string[] {
  const notes: string[] = [];
  for (const t of search.truncated) notes.push(`Showing ${t.shown} of ${t.total} ${SEARCH_NAME[t.search]}.`);
  if (search.checksMissing) notes.push(`GitHub did not list the checks of ${plural(search.checksMissing, 'pull request')}: their failing or pending state shows, the check names do not.`);
  if (sweep.offline) notes.push(`${plural(sweep.offline, 'workstream')} on a box that is offline or stopped: not shown in In progress / Needs a PR.`);
  if (sweep.outdatedAgent) notes.push(`${plural(sweep.outdatedAgent, 'workstream')} on a box whose agent predates the branch read; restart that agent.`);
  if (sweep.failed) notes.push(`${plural(sweep.failed, 'workstream')} could not be read (a timeout, or a missing worktree): not shown in In progress / Needs a PR.`);
  if (!prod.sha) notes.push('The orchestrator cannot tell which commit it runs, so termag merges stay in "Merged, not deployed".');
  return notes;
}

export async function loadPipeline(userId: string, token: string, deps: PipelineDeps = defaultDeps): Promise<PipelineResponse> {
  const now = deps.now();
  const [search, sweep, prod, image] = await Promise.all([
    deps.search(token, now),
    deps.branches(userId),
    deps.version(),
    deps.orchestratorImage(),
  ]);
  const candidates = sweep.branches.filter(b => b.repo && branchLane(b)).map(b => ({ repo: b.repo!, branch: b.branch }));
  const [deploys, merged] = await Promise.all([
    termagDeploys(token, search.merged, prod, deps, userId, image),
    candidates.length ? deps.mergedHeads(token, search.viewer, candidates) : Promise.resolve(new Set<string>()),
  ]);
  const rows = assignLanes({ ...search, deploys, branches: sweep.branches, workstreams: sweep.workstreams, mergedHeads: merged ?? undefined });
  // Remembered, so the PR keeps its workstream once the checkout moves on. Never holds up the list.
  deps.recordLinks?.(userId, rows).catch(err => console.warn('[PRS] could not store workstream links:', err instanceof Error ? err.message : String(err)));
  // Bakes in flight only matter while something waits on one.
  const waiting = rows.some(r => r.lane === 'merged_not_deployed');
  const bakes = waiting ? await deps.bakeRuns(token) : null;
  return {
    connected: true,
    viewer: search.viewer,
    lanes: groupByLane(rows),
    prod,
    boxes: deps.boxCommits(userId).length,
    deploy: { image, bakes, workflowUrl: BAKE_WORKFLOW_URL },
    mergedWindowDays: MERGED_WINDOW_DAYS,
    fetchedAt: now.toISOString(),
    notes: pipelineNotes(search, sweep, prod),
    checkouts: sweep.workstreams.filter(w => w.repo).map(w => ({ projectId: w.projectId, workstream: w.workstream, repo: w.repo! })),
    linkable: sweep.workstreams,
  };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

const memos = new Map<string, { token: string; load: () => Promise<PipelineResponse> }>();

function pipelineFor(userId: string, token: string, deps: PipelineDeps): Promise<PipelineResponse> {
  let memo = memos.get(userId);
  // A replaced token (reconnect as someone else) must not serve the old answer.
  if (!memo || memo.token !== token) {
    memo = { token, load: swrMemo(() => loadPipeline(userId, token, deps), FRESH_MS, MAX_STALE_MS) };
    memos.set(userId, memo);
  }
  return memo.load();
}

/**
 * The same memoized load for a service (the daily briefing's ledger): null
 * when the user has no stored GitHub token or GitHub refuses, never throws.
 */
export async function pipelineForUser(userId: string): Promise<PipelineResponse | null> {
  try {
    const token = await githubTokenSource(userId);
    if (!token) return null;
    return await pipelineFor(userId, token, defaultDeps);
  } catch {
    return null;
  }
}

// Review group members, read by number: memoized like the pipeline, per user,
// for one token and one member list (an edit that changes the list reads afresh).
const memberMemos = new Map<string, { key: string; load: () => Promise<Map<string, NumberedPr>> }>();

function membersFor(userId: string, token: string, viewer: string, refs: { repo: string; number: number }[], deps: PipelineDeps): Promise<Map<string, NumberedPr>> {
  const byNumber = deps.byNumber;
  if (!byNumber || refs.length === 0) return Promise.resolve(new Map());
  const key = `${token}\u0000${viewer}\u0000${refs.map(r => prKey(r.repo, r.number)).sort().join(' ')}`;
  let memo = memberMemos.get(userId);
  if (!memo || memo.key !== key) {
    memo = {
      key,
      load: swrMemo(async () => {
        const got = await byNumber(token, viewer, refs);
        // Keyed as stored (lowercased): GitHub answers with the repository's own case.
        return new Map(got.map((p, i) => [prKey(refs[i].repo, refs[i].number), p]));
      }, FRESH_MS, MAX_STALE_MS),
    };
    memberMemos.set(userId, memo);
  }
  return memo.load();
}

/**
 * A row built for a group member no lane lists, linked as lane rows are
 * (Devin, #667): the live checkout on its branch (assignLanes), then a stored
 * link over it (applyLinks), and for a review row where Review with Devin runs.
 */
function linkCardRow(row: PrRow, links: StoredLink[], linkable: LinkableWorkstream[]): PrRow {
  if (!row.repo) return row;
  const live = { ...row, workstream: linkWorkstream(row.repo, row.headRefName, row.baseRefName, linkable) };
  const [linked] = applyLinks([live], links);
  return isReviewLane(linked.lane) ? { ...linked, reviewTarget: reviewTarget(linked.repo!, linked.workstream, linkable) } : linked;
}

// Suggested groups read descriptions, which change rarely: memoized longer
// than the lanes, per user, for one token and one set of review requests.
const SUGGEST_FRESH_MS = 10 * 60_000;
const SUGGEST_STALE_MS = 30 * 60_000;
const suggestMemos = new Map<string, { key: string; load: () => Promise<{ bodies: Map<string, string>; others: Map<string, LitePr & { open: boolean }> }> }>();

function suggestReadsFor(userId: string, token: string, laneRows: PrRow[], deps: PipelineDeps) {
  const lite = deps.lite!;
  const sources = bodySources(laneRows).map(r => ({ repo: r.repo!, number: r.number! }));
  const key = `${token}\u0000${sources.map(r => prKey(r.repo.toLowerCase(), r.number)).sort().join(' ')}`;
  let memo = suggestMemos.get(userId);
  if (!memo || memo.key !== key) {
    memo = {
      key,
      load: swrMemo(async () => {
        const got = sources.length ? await lite(token, sources, true) : [];
        const bodies = new Map(got.map((p, i) => [prKey(sources[i].repo.toLowerCase(), sources[i].number), p.body ?? '']));
        // Linked PRs no lane lists: are they open (an issue, a merged PR, a missing one links nothing)?
        const unknown = unknownRefs(laneRows, bodies);
        const looked = unknown.length ? await lite(token, unknown, false) : [];
        // Paired by position before the filter: lite answers in the order asked.
        const others = new Map(looked.map((p, i) => [prKey(unknown[i].repo.toLowerCase(), unknown[i].number), p] as const).filter(([, p]) => p.found));
        return { bodies, others };
      }, SUGGEST_FRESH_MS, SUGGEST_STALE_MS),
    };
    suggestMemos.set(userId, memo);
  }
  return memo.load();
}

/** Every member of the user's groups, once each, in a stable order. */
function memberRefs(groups: StoredGroup[]): { repo: string; number: number }[] {
  const seen = new Map<string, { repo: string; number: number }>();
  for (const g of groups) for (const m of g.members) seen.set(prKey(m.repo, m.number), { repo: m.repo, number: m.number });
  return [...seen.values()];
}

/**
 * After a write on GitHub: the lanes and the groups' members are read afresh
 * on the next GET, so a merge or a review checks a member off (and can close
 * its group) at once, not when the member memo ages out.
 */
function forget(userId: string): void {
  memos.delete(userId);
  memberMemos.delete(userId);
}

/** Test seam. */
export function _resetPipelineMemos(): void {
  memos.clear();
  memberMemos.clear();
  suggestMemos.clear();
}

/** The row actions' GitHub calls (services/prReview.ts), injectable for the route tests. */
export interface PrActionDeps {
  overview: (token: string, ref: PrRef) => Promise<PrOverview>;
  review: (token: string, ref: PrRef, input: ReviewInput) => Promise<SubmittedReview>;
  merge: (token: string, ref: PrRef, input: MergeInput) => Promise<MergeResult>;
  rerun: (token: string, ref: PrRef) => Promise<RerunResult>;
  reviewers: (token: string, ref: PrRef, input: ReviewersInput) => Promise<{ users: string[]; teams: string[] }>;
  comment: (token: string, ref: PrRef, body: string) => Promise<{ url: string | null }>;
  bake: (token: string) => Promise<void>;
  head: (token: string, ref: PrRef) => Promise<PrHead>;
}

const defaultActions: PrActionDeps = {
  overview: (token, ref) => fetchPrOverview(token, ref),
  review: (token, ref, input) => submitReview(token, ref, input),
  merge: (token, ref, input) => mergePr(token, ref, input),
  rerun: (token, ref) => rerunFailedChecks(token, ref),
  reviewers: (token, ref, input) => requestReviewers(token, ref, input),
  comment: (token, ref, body) => postComment(token, ref, body),
  bake: token => dispatchBake(token),
  head: (token, ref) => fetchPrHead(token, ref),
};

/**
 * A GitHub failure as the browser should see it. 401 is never passed through
 * (the client treats it as "signed out of termag"); a refusal GitHub explains
 * (403 SSO, 404, 405 "not mergeable", 409 "head branch was modified", 422 "can
 * not approve your own pull request") keeps its status.
 */
export function githubFailure(err: GithubApiError): { status: number; error: string } {
  if (err.status === 401) return { status: 502, error: 'GitHub rejected your stored token. Reconnect GitHub in Settings.' };
  if (err instanceof GithubTimeoutError) return { status: 504, error: 'GitHub timed out listing your pull requests. It retries in a minute.' };
  return { status: [403, 404, 405, 409, 422].includes(err.status) ? err.status : 502, error: err.message };
}

/**
 * GET /api/prs's answer for a user, so the CLI's `GET /api/cli/v1/prs` (the
 * TUI's pills, routes/cliTui.ts) serves the same memoized read: `{ connected:
 * false }` with no stored GitHub token, 502 (504 on a timeout) when GitHub fails.
 */
export function prsLister(
  deps: PipelineDeps = defaultDeps,
  tokenFor: (userId: string) => Promise<string | null> = githubTokenSource,
  deferrals: DeferralStore = prismaDeferrals,
  links: WorkstreamPrStore = prismaWorkstreamPrs,
  groupStore: ReviewGroupStore = prismaReviewGroups,
  dismissals: SuggestionDismissalStore = prismaSuggestionDismissals,
): (userId: string) => Promise<RouteResult> {
  // Outside the memo: a deferral shows on the next read. A database hiccup hides no PR, it only un-defers.
  const deferredFor = (userId: string): Promise<PrDeferral[]> => deferrals.list(userId, deps.now()).catch(err => {
    console.warn('[PRS] could not read deferrals:', err instanceof Error ? err.message : String(err));
    return [];
  });
  // Outside the memo too, so an attach shows on the next read. A database hiccup only loses the stored links.
  const linksFor = (userId: string): Promise<StoredLink[]> => links.list(userId).catch(err => {
    console.warn('[PRS] could not read workstream links:', err instanceof Error ? err.message : String(err));
    return [];
  });
  // Outside the memo as well, so an edit shows on the next read. A database hiccup shows no groups.
  const storedGroupsFor = (userId: string): Promise<StoredGroup[]> => groupStore.list(userId, deps.now()).catch(err => {
    console.warn('[PRS] could not read review groups:', err instanceof Error ? err.message : String(err));
    return [];
  });
  /** The groups with their members' state; a failed GitHub read keeps the cards, with what is stored. */
  const groupsFor = async (
    userId: string, token: string, viewer: string, stored: StoredGroup[], laneRows: PrRow[], links: StoredLink[], linkable: LinkableWorkstream[],
  ) => {
    if (stored.length === 0) return { groups: [] as ReviewGroup[] };
    let fetched: Map<string, NumberedPr> | null = null;
    let groupsError: string | undefined;
    try {
      fetched = await membersFor(userId, token, viewer, memberRefs(stored), deps);
    } catch (err) {
      if (!(err instanceof GithubApiError)) throw err;
      console.warn(`[PRS] ${userId}: review group members: ${err.message} (HTTP ${err.status})`);
      groupsError = 'Could not read the groups\' pull requests from GitHub: showing what is stored.';
    }
    const groups = assembleGroups(stored, fetched, laneRows, viewer).map(g => ({
      ...g,
      members: g.members.map(m => {
        const row = m.row && !m.inLane ? linkCardRow(m.row, links, linkable) : m.row;
        // A pane for every member, merged or yours too: Review all with Devin may run the rest there (Devin, #668).
        const pane = row?.repo ? reviewTarget(row.repo, row.workstream, linkable) : null;
        return { ...m, row, pane };
      }),
    }));
    // Every member merged or closed: the group closes itself (once; a failure retries on the next read).
    const finished = finishedGroups(groups);
    if (finished.length) {
      const at = deps.now();
      const saved = await Promise.all(finished.map(id => groupStore.update(userId, id, { closed: true }, at).catch(() => false)));
      // Only a close that was written shows as one: a failed write stays open, and retries on the next read (Devin, #667).
      const closed = new Set(finished.filter((_, i) => saved[i]));
      for (const g of groups) if (closed.has(g.id)) g.closedAt = at.toISOString();
    }
    return { groups, groupsError };
  };
  /**
   * Suggested groups, only with the flag on (its descriptions cost a GitHub
   * read). Never fails the list: a GitHub or database hiccup suggests nothing.
   */
  const suggestionsFor = async (userId: string, token: string, laneRows: PrRow[], stored: StoredGroup[]): Promise<GroupSuggestion[]> => {
    if (!deps.lite || !deps.suggestionsOn) return [];
    try {
      if (!(await deps.suggestionsOn(userId))) return [];
      const [{ bodies, others }, dismissed] = await Promise.all([suggestReadsFor(userId, token, laneRows, deps), dismissals.list(userId)]);
      const grouped = new Map<string, { id: string; name: string; size: number }>();
      for (const g of stored) {
        if (!g.closedAt) for (const m of g.members) grouped.set(prKey(m.repo.toLowerCase(), m.number), { id: g.id, name: g.name, size: g.members.length });
      }
      return suggestGroups({ rows: laneRows, bodies, others, grouped, dismissed });
    } catch (err) {
      console.warn(`[PRS] ${userId}: suggested groups: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  };
  return async (userId) => {
    const token = await tokenFor(userId);
    if (!token) return { status: 200, body: { connected: false } };
    try {
      const [{ linkable = [], ...pipeline }, deferred, stored, storedGroups] = await Promise.all([
        pipelineFor(userId, token, deps), deferredFor(userId), linksFor(userId), storedGroupsFor(userId),
      ]);
      const lanes = pipeline.lanes.map(l => ({ ...l, rows: applyLinks(l.rows, stored) }));
      const laneRows = lanes.flatMap(l => l.rows);
      const earlier = earlierLinks(laneRows, stored, pipeline.fetchedAt);
      const [{ groups, groupsError }, suggestions] = await Promise.all([
        groupsFor(userId, token, pipeline.viewer, storedGroups, laneRows, stored, linkable),
        suggestionsFor(userId, token, laneRows, storedGroups),
      ]);
      return { status: 200, body: { ...pipeline, lanes, deferred, earlier, groups, ...(groupsError ? { groupsError } : {}), suggestions } satisfies PrsResponse };
    } catch (err) {
      if (!(err instanceof GithubApiError)) throw err;
      // Logged: the browser's sidebar tile is the only other place this shows,
      // and a user whose list never loads otherwise leaves no trace.
      console.warn(`[PRS] ${userId}: ${err.message} (HTTP ${err.status})`);
      // The list is one call over many PRs: any GitHub failure is a 502 here,
      // except a timeout (a 504 or a "timed out" GraphQL error, not GitHub's
      // generic "something went wrong"), which says so (504).
      const failure = githubFailure(err);
      return { status: failure.status === 504 ? 504 : 502, body: { error: failure.error } };
    }
  };
}

export function prsRouter(
  deps: PipelineDeps = defaultDeps,
  tokenFor: (userId: string) => Promise<string | null> = githubTokenSource,
  actions: PrActionDeps = defaultActions,
  deferrals: DeferralStore = prismaDeferrals,
  links: WorkstreamPrStore = prismaWorkstreamPrs,
  createWorkstream: typeof createWorkstreamFor = createWorkstreamFor,
  groupStore: ReviewGroupStore = prismaReviewGroups,
  dismissals: SuggestionDismissalStore = prismaSuggestionDismissals,
): Router {
  const router = Router();

  /** Runs a row action with the user's token, mapping bad input to 400 and GitHub's refusals through githubFailure. */
  // `parse`: the orgs' PRs only (parsePrRef), except for a read anyone's PR can take (parseAnyPrRef).
  const withGithub = (fn: (token: string, ref: PrRef, req: Parameters<RequestHandler>[0]) => Promise<unknown>, parse = parsePrRef): RequestHandler => async (req, res) => {
    let ref: PrRef;
    try {
      ref = parse(req.params.owner, req.params.repo, req.params.number);
    } catch (err) {
      if (err instanceof PrInputError) { res.status(400).json({ error: err.message }); return; }
      throw err;
    }
    const token = await tokenFor(req.user!.id);
    if (!token) { res.status(409).json({ error: 'Connect GitHub in Settings first.' }); return; }
    try {
      res.json(await fn(token, ref, req));
    } catch (err) {
      if (err instanceof PrInputError) { res.status(400).json({ error: err.message }); return; }
      if (!(err instanceof GithubApiError)) throw err;
      const { status, error } = githubFailure(err);
      res.status(status).json({ error });
    }
  };

  // A read with the user's own token: any repository, since a review group can hold any PR (Devin, #667).
  const overview = withGithub((token, ref) => actions.overview(token, ref), parseAnyPrRef);

  const review = withGithub(async (token, ref, req) => {
    const input = parseReviewInput(req.body);
    const submitted = await actions.review(token, ref, input);
    // The review moves the PR between lanes, and checks it off in its group; the next /api/prs reads afresh.
    forget(req.user!.id);
    return submitted;
  });

  const merge = withGithub(async (token, ref, req) => {
    const input = parseMergeInput(req.body);
    const result = await actions.merge(token, ref, input);
    forget(req.user!.id);
    return result;
  });

  const rerun = withGithub(async (token, ref, req) => {
    const result = await actions.rerun(token, ref);
    // Re-run checks are pending again: the PR's row says so on the next read.
    forget(req.user!.id);
    return result;
  });

  const reviewers = withGithub(async (token, ref, req) => {
    const result = await actions.reviewers(token, ref, parseReviewersInput(req.body));
    // The row's "waiting on" list changes.
    forget(req.user!.id);
    return result;
  });

  // A comment moves no PR between lanes: the memo stays.
  const comment = withGithub((token, ref, req) => actions.comment(token, ref, parseCommentInput(req.body).body));

  const defer: RequestHandler = async (req, res) => {
    let input;
    try { input = parseDeferInput(req.body); } catch (err) {
      if (err instanceof PrInputError) { res.status(400).json({ error: err.message }); return; }
      throw err;
    }
    res.json(await deferrals.defer(req.user!.id, input, deps.now()));
  };

  const undefer: RequestHandler = async (req, res) => {
    let key;
    try { key = parseDeferKey(req.query.key); } catch (err) {
      if (err instanceof PrInputError) { res.status(400).json({ error: err.message }); return; }
      throw err;
    }
    await deferrals.undefer(req.user!.id, key);
    res.status(204).end();
  };

  const attach: RequestHandler = async (req, res) => {
    let input;
    try { input = parseAttachInput(req.body); } catch (err) {
      if (err instanceof PrInputError) { res.status(400).json({ error: err.message }); return; }
      throw err;
    }
    const ok = await links.record(req.user!.id, input, input, 'manual');
    if (!ok) { res.status(404).json({ error: 'No such workstream of yours' }); return; }
    res.json({ ok: true });
  };

  const detach: RequestHandler = async (req, res) => {
    let pr;
    try { pr = parsePrIdent(req.query as Record<string, unknown>); } catch (err) {
      if (err instanceof PrInputError) { res.status(400).json({ error: err.message }); return; }
      throw err;
    }
    await links.detach(req.user!.id, pr);
    res.status(204).end();
  };

  const list = prsLister(deps, tokenFor, deferrals, links, groupStore, dismissals);
  const prs: RequestHandler = async (req, res) => {
    sendResult(res, await list(req.user!.id));
  };

  // A new workstream on the PR's own branch (routes/workstreams.ts, `pr`), attached to the PR by hand.
  const newWorkstream: RequestHandler = async (req, res) => {
    let ref: PrRef;
    try { ref = parsePrRef(req.params.owner, req.params.repo, req.params.number); } catch (err) {
      if (err instanceof PrInputError) { res.status(400).json({ error: err.message }); return; }
      throw err;
    }
    const { projectId, name, prompt } = (req.body ?? {}) as { projectId?: unknown; name?: unknown; prompt?: unknown };
    if (typeof projectId !== 'string' || !projectId || typeof name !== 'string' || !name) {
      res.status(400).json({ error: 'projectId and name required' });
      return;
    }
    const first = parseFirstPrompt(prompt);
    if (!first.ok) { res.status(400).json({ error: first.error }); return; }
    const token = await tokenFor(req.user!.id);
    if (!token) { res.status(409).json({ error: 'Connect GitHub in Settings first.' }); return; }
    let head: PrHead;
    try { head = await actions.head(token, ref); } catch (err) {
      if (!(err instanceof GithubApiError)) throw err;
      const failure = githubFailure(err);
      res.status(failure.status).json({ error: failure.error });
      return;
    }
    if (head.state !== 'OPEN') { res.status(409).json({ error: `The pull request is ${head.state.toLowerCase()}: nothing to work on.` }); return; }
    const result = await createWorkstream(req.user!, projectId, {
      name, branch: head.branch, pr: { repo: `${ref.owner}/${ref.name}`, number: ref.number, sameRepo: head.sameRepo, headOid: head.headOid }, firstPrompt: first.prompt,
    });
    if (result.status === 201) {
      const ws = (result.body as { name?: string }).name ?? name;
      await links.record(req.user!.id, { repo: `${ref.owner}/${ref.name}`, number: ref.number }, { projectId, workstream: ws }, 'manual')
        .catch(err => console.warn('[PRS] could not attach the new workstream:', err instanceof Error ? err.message : String(err)));
    }
    sendResult(res, result);
  };

  /**
   * Members as stored: their titles from GitHub, which also refuses one it has
   * no such PR for. Members already in the group keep their stored title
   * without a read, so reordering or a note costs nothing.
   */
  const withTitles = async (userId: string, members: MemberInput[], known: StoredGroup['members']): Promise<(MemberInput & { title: string })[] | { error: string; status: number }> => {
    const have = new Map(known.map(m => [prKey(m.repo, m.number), m.title]));
    const fresh = members.filter(m => !have.has(prKey(m.repo, m.number)));
    const titles = new Map<string, string>();
    if (fresh.length) {
      const token = await tokenFor(userId);
      if (!token) return { status: 409, error: 'Connect GitHub in Settings first.' };
      if (!deps.byNumber || !deps.viewer) return { status: 500, error: 'Cannot read pull requests from GitHub here.' };
      let got: NumberedPr[];
      try {
        got = await deps.byNumber(token, await deps.viewer(token), fresh);
      } catch (err) {
        if (!(err instanceof GithubApiError)) throw err;
        return githubFailure(err);
      }
      const missing = fresh.filter((_, i) => !got[i]?.found);
      if (missing.length) {
        return { status: 404, error: `GitHub has no pull request ${missing.map(m => prKey(m.repo, m.number)).join(', ')} that you can see.` };
      }
      fresh.forEach((m, i) => titles.set(prKey(m.repo, m.number), got[i].title));
    }
    return members.map(m => ({ ...m, title: titles.get(prKey(m.repo, m.number)) ?? have.get(prKey(m.repo, m.number)) ?? '' }));
  };
  const inputError = (res: Parameters<RequestHandler>[1], err: unknown): boolean => {
    if (err instanceof PrInputError) { res.status(400).json({ error: err.message }); return true; }
    return false;
  };
  const ownGroup = async (userId: string, id: string): Promise<StoredGroup | null> =>
    (await groupStore.list(userId, deps.now())).find(g => g.id === id) ?? null;

  const createGroup: RequestHandler = async (req, res) => {
    let input;
    try { input = parseCreateInput(req.body); } catch (err) { if (inputError(res, err)) return; throw err; }
    const members = await withTitles(req.user!.id, input.members, []);
    if (!Array.isArray(members)) { res.status(members.status).json({ error: members.error }); return; }
    try {
      res.status(201).json(await groupStore.create(req.user!.id, input.name, members));
    } catch (err) { if (inputError(res, err)) return; throw err; }
  };

  const patchGroup: RequestHandler = async (req, res) => {
    let patch;
    try { patch = parsePatchInput(req.body); } catch (err) { if (inputError(res, err)) return; throw err; }
    try {
      const ok = await groupStore.update(req.user!.id, String(req.params.id), patch, deps.now());
      if (!ok) { res.status(404).json({ error: 'No such group of yours' }); return; }
    } catch (err) { if (inputError(res, err)) return; throw err; }
    res.json({ ok: true });
  };

  const putMembers: RequestHandler = async (req, res) => {
    let members;
    try { members = parseMembers((req.body ?? {}).members); } catch (err) { if (inputError(res, err)) return; throw err; }
    const group = await ownGroup(req.user!.id, String(req.params.id));
    if (!group) { res.status(404).json({ error: 'No such group of yours' }); return; }
    const titled = await withTitles(req.user!.id, members, group.members);
    if (!Array.isArray(titled)) { res.status(titled.status).json({ error: titled.error }); return; }
    if (!(await groupStore.setMembers(req.user!.id, group.id, titled))) { res.status(404).json({ error: 'No such group of yours' }); return; }
    res.json({ ok: true });
  };

  const dismissSuggestion: RequestHandler = async (req, res) => {
    const key = (req.body ?? {}).key;
    if (typeof key !== 'string' || !key || key.length > 5000) { res.status(400).json({ error: 'key required' }); return; }
    await dismissals.dismiss(req.user!.id, key);
    res.status(204).end();
  };

  const deleteGroup: RequestHandler = async (req, res) => {
    await groupStore.remove(req.user!.id, String(req.params.id));
    res.status(204).end();
  };

  const version: RequestHandler = async (_req, res) => {
    res.json(await deps.version());
  };

  // Not a PR action: one bake deploys every merge waiting in "Merged, not deployed".
  const bake: RequestHandler = async (req, res) => {
    const token = await tokenFor(req.user!.id);
    if (!token) { res.status(409).json({ error: 'Connect GitHub in Settings first.' }); return; }
    try {
      await actions.bake(token);
    } catch (err) {
      if (!(err instanceof GithubApiError)) throw err;
      const { status, error } = githubFailure(err);
      res.status(status).json({ error });
      return;
    }
    // The next read shows the queued run.
    forget(req.user!.id);
    res.status(202).json({ ok: true, workflowUrl: BAKE_WORKFLOW_URL });
  };

  router.get('/prs', requireAuth, asyncHandler(prs));
  router.post('/prs/bake', requireAuth, asyncHandler(bake));
  router.put('/prs/deferrals', requireAuth, asyncHandler(defer));
  router.delete('/prs/deferrals', requireAuth, asyncHandler(undefer));
  router.put('/prs/links', requireAuth, asyncHandler(attach));
  router.delete('/prs/links', requireAuth, asyncHandler(detach));
  router.post('/prs/groups', requireAuth, asyncHandler(createGroup));
  router.patch('/prs/groups/:id', requireAuth, asyncHandler(patchGroup));
  router.put('/prs/groups/:id/members', requireAuth, asyncHandler(putMembers));
  router.delete('/prs/groups/:id', requireAuth, asyncHandler(deleteGroup));
  router.post('/prs/group-suggestions/dismiss', requireAuth, asyncHandler(dismissSuggestion));
  router.get('/prs/:owner/:repo/:number', requireAuth, asyncHandler(overview));
  router.post('/prs/:owner/:repo/:number/review', requireAuth, asyncHandler(review));
  router.post('/prs/:owner/:repo/:number/merge', requireAuth, asyncHandler(merge));
  router.post('/prs/:owner/:repo/:number/rerun-failed', requireAuth, asyncHandler(rerun));
  router.post('/prs/:owner/:repo/:number/reviewers', requireAuth, asyncHandler(reviewers));
  router.post('/prs/:owner/:repo/:number/comment', requireAuth, asyncHandler(comment));
  router.post('/prs/:owner/:repo/:number/workstream', requireAuth, asyncHandler(newWorkstream));
  router.get('/version', requireAuthOrAgentToken, asyncHandler(version));
  return router;
}
