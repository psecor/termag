import { Router, RequestHandler } from 'express';
import { requireAuth, requireAuthOrAgentToken } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { connectedOwnedBoxes } from '../services/agentRegistry';
import { githubTokenSource } from '../services/credentialStore';
import { GithubApiError } from '../services/githubCredential';
import { fetchPrFiles, fetchPrThreads, type PrFiles, type PrThread } from '../services/prFiles';
import { MAX_ROUNDS, prismaReviewRounds, type LatestRound, type ReviewRoundStore } from '../services/prReviewRounds';

/** A posted round with its PR as GitHub has it now: null when it could not be read. */
export type RoundNow = LatestRound & { now: { state: 'open' | 'merged' | 'closed'; headSha: string | null; askedAgain: boolean; title: string; author: string | null; url: string } | null };
import {
  TERMAG_REPO, assignLanes, branchLane, deployState, followsDeploy, groupByLane, isReviewLane, linkWorkstream, prKey, reviewTarget, touchesBoxes,
  type DeployState, type LinkableWorkstream, type MergedPr, type PrRow,
} from '../services/prPipeline';
import {
  GithubTimeoutError, MERGED_WINDOW_DAYS, ORGS, commitContains, fetchPrLite, fetchPrsByNumber, mergedHeads, searchPrs, viewerLogin,
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
//   GET  /api/prs/:owner/:repo/:number/files    its diff, a patch per file (services/prFiles.ts)
//   GET  /api/prs/:owner/:repo/:number/threads  its review threads, with their lines
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
  /** What the user posted from the simple UI's review card, each PR's latest round with the PR as it is now (services/prReviewRounds.ts). */
  reviewRounds?: RoundNow[];
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
  /**
   * The PRs the user's sessions opened since `since` (their `created` links), with
   * pr-live-updates-enabled on for them; none otherwise. Absent in tests that do not care.
   */
  justOpened?: (userId: string, since: Date) => Promise<{ repo: string; number: number }[]>;
  /** Whether PR reviews in the simple UI are on for the user (simple-ui-reviews-enabled); absent, they're off. */
  reviewsOn?: (userId: string) => Promise<boolean>;
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
  reviewsOn: async userId => {
    const user = await prisma.user.findUnique({
      where: { id: userId }, select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true },
    });
    return user ? boolVariation('simple-ui-reviews-enabled', user, false) : false;
  },
  justOpened: async (userId, since) => {
    const user = await prisma.user.findUnique({
      where: { id: userId }, select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true },
    });
    if (!user || !await boolVariation('pr-live-updates-enabled', user, false)) return [];
    return prisma.workstreamPr.findMany({
      where: { userId, source: 'created', createdAt: { gte: since } },
      select: { repo: true, number: true }, orderBy: { createdAt: 'desc' }, take: JUST_OPENED_MAX,
    });
  },
  now: () => new Date(),
};

/**
 * How far back a PR a session opened is read by number while the search
 * doesn't have it: GitHub's search lags a new PR by seconds to a minute, and
 * the live update (services/prLiveUpdates.ts) re-reads the list the moment the
 * PR opens. At most JUST_OPENED_MAX of them, newest first.
 */
const JUST_OPENED_MS = 10 * 60_000;
const JUST_OPENED_MAX = 10;

/** Whether a repository is in the orgs the search lists (prPipelineGithub ORGS). */
function inSearchedOrg(repo: string): boolean {
  const owner = repo.split('/')[0]?.toLowerCase() ?? '';
  return ORGS.some(o => o.toLowerCase() === owner);
}

/**
 * The search's PRs with the just-opened ones it lacks read by number and
 * added to the viewer's own, open ones only, and only in the orgs the search
 * lists: one elsewhere would show for ten minutes, then go when its link ages
 * out. A failed read adds nothing: the search catches up on its own.
 */
export async function withJustOpened(
  search: PrSearchResult, refs: { repo: string; number: number }[], token: string, deps: Pick<PipelineDeps, 'byNumber'>,
): Promise<PrSearchResult> {
  const have = new Set(search.authored.map(p => prKey(p.repo.toLowerCase(), p.number)));
  const missing = refs.filter(r => inSearchedOrg(r.repo) && !have.has(prKey(r.repo.toLowerCase(), r.number))).slice(0, JUST_OPENED_MAX);
  if (missing.length === 0 || !deps.byNumber) return search;
  const got = await deps.byNumber(token, search.viewer, missing).catch(err => {
    console.warn('[PRS] could not read just-opened PRs by number:', err instanceof Error ? err.message : String(err));
    return [];
  });
  const viewer = search.viewer.toLowerCase();
  const added = got.flatMap(n => (n.open && n.open.author?.toLowerCase() === viewer ? [n.open] : []));
  return added.length ? { ...search, authored: [...search.authored, ...added] } : search;
}

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
  const [searched, sweep, prod, image, opened] = await Promise.all([
    deps.search(token, now),
    deps.branches(userId),
    deps.version(),
    deps.orchestratorImage(),
    deps.justOpened ? deps.justOpened(userId, new Date(now.getTime() - JUST_OPENED_MS)).catch(() => []) : Promise.resolve([]),
  ]);
  // A PR a session just opened, before GitHub's search has it (services/prLiveUpdates.ts).
  const search = await withJustOpened(searched, opened, token, deps);
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

const memos = new Map<string, { token: string; load: (() => Promise<PipelineResponse>) & { reload: () => Promise<PipelineResponse> } }>();

/** The user's memoized pipeline; `fresh`, read from GitHub now while other callers keep the last answer. */
function pipelineFor(userId: string, token: string, deps: PipelineDeps, fresh = false): Promise<PipelineResponse> {
  let memo = memos.get(userId);
  // A replaced token (reconnect as someone else) must not serve the old answer.
  if (!memo || memo.token !== token) {
    memo = { token, load: swrMemo(() => loadPipeline(userId, token, deps), FRESH_MS, MAX_STALE_MS) };
    memos.set(userId, memo);
  }
  return fresh ? memo.load.reload() : memo.load();
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

/**
 * The same pipeline, read from GitHub again now (services/prLiveUpdates.ts,
 * after a session opens a PR). GET /api/prs keeps serving the last answer
 * until this one lands, then serves it. Null as for pipelineForUser.
 */
export async function reloadPipelineForUser(userId: string): Promise<PipelineResponse | null> {
  try {
    const token = await githubTokenSource(userId);
    if (!token) return null;
    return await pipelineFor(userId, token, defaultDeps, true);
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
  roundHeadMemos.delete(userId);
}

/** Test seam. */
export function _resetPipelineMemos(): void {
  memos.clear();
  memberMemos.clear();
  suggestMemos.clear();
  roundHeadMemos.clear();
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
  /** The diff and its review threads, for the simple UI's Files changed (services/prFiles.ts). */
  files: (token: string, ref: PrRef) => Promise<PrFiles>;
  threads: (token: string, ref: PrRef) => Promise<PrThread[]>;
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
  files: (token, ref) => fetchPrFiles(token, ref),
  threads: (token, ref) => fetchPrThreads(token, ref),
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

// A posted round's PR, read again for its head: memoized per user and PR, so the minute's poll costs one small query a PR.
// Held with the token that read it, as the member memos are: a reconnect as someone else starts over, so no head one
// token could read reaches another. A failed read isn't kept, and a write (forget) drops the user's heads.
const roundHeadMemos = new Map<string, { token: string; heads: Map<string, { at: number; head: PrHead }> }>();
const ROUND_HEAD_TTL_MS = 60_000;

/** Each PR's latest posted round with the PR as it is now. */
async function roundsFor(
  userId: string, token: string, laneRows: PrRow[], store: ReviewRoundStore,
  headOf: (token: string, ref: PrRef) => Promise<PrHead>, now: Date,
): Promise<RoundNow[]> {
  let latest: LatestRound[];
  try { latest = await store.latest(userId, now); } catch (err) {
    console.warn(`[PRS] ${userId}: review rounds: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  let memo = roundHeadMemos.get(userId);
  if (!memo || memo.token !== token) {
    memo = { token, heads: new Map() };
    roundHeadMemos.set(userId, memo);
  }
  const heads = memo.heads;
  // Every round of a PR a lane lists, so a request GitHub kept after it is settled rather than new, and the newest
  // MAX_ROUNDS others: each reads the PR's head.
  const listed = (r: LatestRound) => laneRows.some(x => x.kind === 'pr' && x.repo?.toLowerCase() === r.repo && x.number === r.number);
  let others = 0;
  const kept = latest.filter(r => listed(r) || others++ < MAX_ROUNDS);
  return Promise.all(kept.map(async r => {
    const [owner, name] = r.repo.split('/');
    const key = `${r.repo}#${r.number}`;
    const hit = heads.get(key);
    let head: PrHead | null;
    if (hit && now.getTime() - hit.at <= ROUND_HEAD_TTL_MS) head = hit.head;
    else {
      head = await headOf(token, { owner, name, number: r.number }).catch(() => null);
      if (head) heads.set(key, { at: now.getTime(), head }); else heads.delete(key);
    }
    const row = laneRows.find(x => x.kind === 'pr' && x.repo?.toLowerCase() === r.repo && x.number === r.number);
    // Asked again: a review request newer than the round. Being in a review lane isn't enough: GitHub keeps a
    // named request after a COMMENT review, and a team's after any verdict.
    const askedAgain = !!row && (row.lane === 'needs_my_review' || row.lane === 'team_review')
      && !!row.requestedAt && Date.parse(row.requestedAt) > Date.parse(r.postedAt);
    return {
      ...r,
      now: head ? {
        state: head.state === 'OPEN' ? 'open' : head.state === 'MERGED' ? 'merged' : 'closed',
        headSha: head.headOid.toLowerCase(), askedAgain,
        title: row?.title ?? r.title, author: row?.author ?? r.author, url: row?.url ?? `https://github.com/${r.repo}/pull/${r.number}`,
      } : null,
    };
  }));
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
  rounds: ReviewRoundStore = prismaReviewRounds,
  headOf: (token: string, ref: PrRef) => Promise<PrHead> = fetchPrHead,
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
  /** Rounds are read only with simple-ui-reviews-enabled on. Never fails the list: a failed lookup reads none. */
  const reviewsFor = async (userId: string): Promise<boolean> => {
    if (!deps.reviewsOn) return false;
    try {
      return await deps.reviewsOn(userId);
    } catch (err) {
      console.warn(`[PRS] ${userId}: reviews flag: ${err instanceof Error ? err.message : String(err)}`);
      return false;
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
      // Rounds are the simple UI's review card's: read only for someone with it on (simple-ui-reviews-enabled).
      const reviewRounds = await reviewsFor(userId) ? await roundsFor(userId, token, laneRows, rounds, headOf, deps.now()) : undefined;
      return { status: 200, body: { ...pipeline, lanes, deferred, earlier, groups, ...(groupsError ? { groupsError } : {}), suggestions, ...(reviewRounds ? { reviewRounds } : {}) } satisfies PrsResponse };
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

/**
 * A new workstream on a PR's own branch, attached to the PR:
 * the cookie route's handler, and the desktop's
 * `POST /api/cli/v1/prs/:owner/:repo/:number/workstream` (routes/cliPrs.ts), which
 * passes its agent (`claude-chat`) and no first prompt. `params` are the route's
 * owner, repo and number; `body` is `{ projectId, name, prompt? }`.
 */
export async function prWorkstreamFor(
  user: Express.User,
  params: { owner?: string; repo?: string; number?: string },
  body: unknown,
  options: { provider?: string },
  tokenFor: (userId: string) => Promise<string | null> = githubTokenSource,
  head: PrActionDeps['head'] = defaultActions.head,
  createWorkstream: typeof createWorkstreamFor = createWorkstreamFor,
  links: WorkstreamPrStore = prismaWorkstreamPrs,
): Promise<RouteResult> {
  let ref: PrRef;
  try { ref = parsePrRef(params.owner, params.repo, params.number); } catch (err) {
    if (err instanceof PrInputError) return { status: 400, body: { error: err.message } };
    throw err;
  }
  const { projectId, name, prompt } = (body ?? {}) as { projectId?: unknown; name?: unknown; prompt?: unknown };
  if (typeof projectId !== 'string' || !projectId || typeof name !== 'string' || !name) {
    return { status: 400, body: { error: 'projectId and name required' } };
  }
  const first = parseFirstPrompt(prompt);
  if (!first.ok) return { status: 400, body: { error: first.error } };
  const token = await tokenFor(user.id);
  if (!token) return { status: 409, body: { error: 'Connect GitHub in Settings first.' } };
  let prHead: PrHead;
  try { prHead = await head(token, ref); } catch (err) {
    if (!(err instanceof GithubApiError)) throw err;
    const failure = githubFailure(err);
    return { status: failure.status, body: { error: failure.error } };
  }
  if (prHead.state !== 'OPEN') return { status: 409, body: { error: `The pull request is ${prHead.state.toLowerCase()}: nothing to work on.` } };
  const result = await createWorkstream(user, projectId, {
    name, branch: prHead.branch, pr: { repo: `${ref.owner}/${ref.name}`, number: ref.number, sameRepo: prHead.sameRepo, headOid: prHead.headOid },
    firstPrompt: first.prompt, ...(options.provider ? { provider: options.provider } : {}),
  });
  if (result.status === 201) {
    const ws = (result.body as { name?: string }).name ?? name;
    await links.record(user.id, { repo: `${ref.owner}/${ref.name}`, number: ref.number }, { projectId, workstream: ws }, 'manual')
      .catch(err => console.warn('[PRS] could not attach the new workstream:', err instanceof Error ? err.message : String(err)));
  }
  return result;
}

/**
 * Bake & deploy now, by user id: the cookie route and the desktop's
 * `POST /api/cli/v1/prs/bake` (routes/cliPrs.ts). Not a PR action: one bake
 * of main's orchestrator image deploys every merge waiting in "Merged, not
 * deployed", dispatched as the user (their GitHub write access decides).
 */
export async function bakeNow(
  userId: string,
  tokenFor: (userId: string) => Promise<string | null> = githubTokenSource,
  bake: PrActionDeps['bake'] = defaultActions.bake,
): Promise<RouteResult> {
  const token = await tokenFor(userId);
  if (!token) return { status: 409, body: { error: 'Connect GitHub in Settings first.' } };
  try {
    await bake(token);
  } catch (err) {
    if (!(err instanceof GithubApiError)) throw err;
    const { status, error } = githubFailure(err);
    return { status, body: { error } };
  }
  // The next read shows the queued run.
  forget(userId);
  return { status: 202, body: { ok: true, workflowUrl: BAKE_WORKFLOW_URL } };
}

/**
 * The pipeline's own writes, by user id: deferrals and review groups. The
 * cookie routes below and the desktop's `/api/cli/v1/prs/*`
 * (routes/cliPrs.ts) both run these. Bad input is a 400.
 */
export interface PrsWrites {
  defer(userId: string, body: unknown): Promise<RouteResult>;
  undefer(userId: string, key: unknown): Promise<RouteResult>;
  createGroup(userId: string, body: unknown): Promise<RouteResult>;
  patchGroup(userId: string, id: string, body: unknown): Promise<RouteResult>;
  putMembers(userId: string, id: string, body: unknown): Promise<RouteResult>;
  deleteGroup(userId: string, id: string): Promise<RouteResult>;
  dismissSuggestion(userId: string, body: unknown): Promise<RouteResult>;
  /**
   * A review the desktop app posted to GitHub itself (T3's review form, pinned
   * to the head) as the PR's next round: the record half of POST
   * /api/prs/:owner/:repo/:number/review, with no GitHub write. Behind
   * simple-ui-reviews-enabled, as rounds are.
   */
  recordReviewRound(userId: string, params: { owner: string; repo: string; number: string }, body: unknown): Promise<RouteResult>;
}

const ROUND_EVENTS = new Set(['APPROVE', 'COMMENT', 'REQUEST_CHANGES']);
const MAX_ROUND_TITLE = 1000;

export function prsWrites(
  deps: PipelineDeps = defaultDeps,
  tokenFor: (userId: string) => Promise<string | null> = githubTokenSource,
  deferrals: DeferralStore = prismaDeferrals,
  groupStore: ReviewGroupStore = prismaReviewGroups,
  dismissals: SuggestionDismissalStore = prismaSuggestionDismissals,
  rounds: ReviewRoundStore = prismaReviewRounds,
): PrsWrites {
  const failed = (status: number, error: string): RouteResult => ({ status, body: { error } });
  const NO_GROUP = failed(404, 'No such group of yours');
  /** A PrInputError anywhere in `fn` (a parse, the group cap) is the caller's: 400. */
  const checked = async (fn: () => Promise<RouteResult>): Promise<RouteResult> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PrInputError) return failed(400, err.message);
      throw err;
    }
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
  const ownGroup = async (userId: string, id: string): Promise<StoredGroup | null> =>
    (await groupStore.list(userId, deps.now())).find(g => g.id === id) ?? null;

  return {
    defer: (userId, body) => checked(async () => {
      const input = parseDeferInput(body);
      return { status: 200, body: await deferrals.defer(userId, input, deps.now()) };
    }),
    undefer: (userId, key) => checked(async () => {
      await deferrals.undefer(userId, parseDeferKey(key));
      return { status: 204, body: null };
    }),
    createGroup: (userId, body) => checked(async () => {
      const input = parseCreateInput(body);
      const members = await withTitles(userId, input.members, []);
      if (!Array.isArray(members)) return failed(members.status, members.error);
      return { status: 201, body: await groupStore.create(userId, input.name, members) };
    }),
    patchGroup: (userId, id, body) => checked(async () => {
      const patch = parsePatchInput(body);
      if (!(await groupStore.update(userId, id, patch, deps.now()))) return NO_GROUP;
      return { status: 200, body: { ok: true } };
    }),
    putMembers: (userId, id, body) => checked(async () => {
      const members = parseMembers(((body ?? {}) as { members?: unknown }).members);
      const group = await ownGroup(userId, id);
      if (!group) return NO_GROUP;
      const titled = await withTitles(userId, members, group.members);
      if (!Array.isArray(titled)) return failed(titled.status, titled.error);
      if (!(await groupStore.setMembers(userId, group.id, titled))) return NO_GROUP;
      return { status: 200, body: { ok: true } };
    }),
    deleteGroup: async (userId, id) => {
      await groupStore.remove(userId, id);
      return { status: 204, body: null };
    },
    dismissSuggestion: async (userId, body) => {
      const key = ((body ?? {}) as { key?: unknown }).key;
      if (typeof key !== 'string' || !key || key.length > 5000) return failed(400, 'key required');
      await dismissals.dismiss(userId, key);
      return { status: 204, body: null };
    },
    recordReviewRound: async (userId, params, body) => {
      if (!deps.reviewsOn || !await deps.reviewsOn(userId)) return { status: 404, body: { error: 'PR reviews are not on for you.', code: 'reviews-off' } };
      let ref: PrRef;
      try { ref = parsePrRef(params.owner, params.repo, params.number); } catch (err) {
        if (err instanceof PrInputError) return failed(400, err.message);
        throw err;
      }
      const b = (body ?? {}) as { headSha?: unknown; event?: unknown; comments?: unknown; title?: unknown; author?: unknown };
      // Hex in either case, as web's review takes it, recorded lowercased.
      if (typeof b.headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(b.headSha)) return failed(400, 'headSha must be the 40-character head commit the review was posted at');
      const headSha = b.headSha.toLowerCase();
      if (typeof b.event !== 'string' || !ROUND_EVENTS.has(b.event)) return failed(400, 'event must be APPROVE, COMMENT or REQUEST_CHANGES');
      if (!Number.isSafeInteger(b.comments) || (b.comments as number) < 0) return failed(400, 'comments must be a count');
      if (typeof b.title !== 'string' || b.title.length > MAX_ROUND_TITLE) return failed(400, 'title is required');
      if (b.author !== null && (typeof b.author !== 'string' || b.author.length > 200)) return failed(400, 'author must be a login or null');
      const round = await rounds.record(userId, {
        repo: `${ref.owner}/${ref.name}`, number: ref.number, headSha,
        event: b.event as Parameters<ReviewRoundStore['record']>[1]['event'], comments: b.comments as number, title: b.title, author: b.author,
      });
      // The round moves the PR between lanes (changed since your review, waiting on the author): the next /api/prs reads afresh.
      forget(userId);
      return { status: 200, body: { round } };
    },
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
  rounds: ReviewRoundStore = prismaReviewRounds,
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
  // Reads with the user's token, any repository, as the overview is.
  const reviewsOn = (userId: string): Promise<boolean> => (deps.reviewsOn ? deps.reviewsOn(userId) : Promise.resolve(false));
  /** Answers 404 while simple-ui-reviews-enabled is off for the caller; the browser hides the feature, the server refuses it. */
  const ifReviews = (handler: RequestHandler): RequestHandler => async (req, res, next) => {
    if (!await reviewsOn(req.user!.id)) { res.status(404).json({ error: 'PR reviews are not on for you.', code: 'reviews-off' }); return; }
    return handler(req, res, next);
  };
  const files = ifReviews(withGithub((token, ref) => actions.files(token, ref), parseAnyPrRef));
  const threads = ifReviews(withGithub(async (token, ref) => ({ threads: await actions.threads(token, ref) }), parseAnyPrRef));

  // Inline comments and a pinned head are what the simple UI's review card posts: they come with
  // simple-ui-reviews-enabled, as the card does. The lab's summary-only review is as it was.
  const cardFields = (handler: RequestHandler): RequestHandler => async (req, res, next) => {
    const body = req.body as { comments?: unknown; commitId?: unknown } | undefined;
    const card = (Array.isArray(body?.comments) && body.comments.length > 0) || body?.commitId !== undefined;
    if (card && !await reviewsOn(req.user!.id)) {
      res.status(403).json({ error: 'Inline comments come with PR reviews in termag, which are not on for you.', code: 'reviews-off' });
      return;
    }
    return handler(req, res, next);
  };
  const review = cardFields(withGithub(async (token, ref, req) => {
    const input = parseReviewInput(req.body);
    const submitted = await actions.review(token, ref, input);
    // A review posted from the simple UI's card names its head: it is a round.
    if (input.commitId) {
      const title = typeof req.body?.title === 'string' ? req.body.title : '';
      const author = typeof req.body?.author === 'string' ? req.body.author : null;
      await rounds.record(req.user!.id, { repo: `${ref.owner}/${ref.name}`, number: ref.number, headSha: input.commitId, event: input.event, comments: input.comments?.length ?? 0, title, author })
        .catch(err => console.warn(`[PRS] ${req.user!.id}: could not record the review round: ${err instanceof Error ? err.message : String(err)}`));
    }
    // The review moves the PR between lanes, and checks it off in its group; the next /api/prs reads afresh.
    forget(req.user!.id);
    return submitted;
  }));

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

  // Deferrals and review groups: the same handlers as the desktop's /api/cli/v1/prs/* (routes/cliPrs.ts).
  const writes = prsWrites(deps, tokenFor, deferrals, groupStore, dismissals, rounds);
  const byUser = (fn: (userId: string, req: Parameters<RequestHandler>[0]) => Promise<RouteResult>): RequestHandler => async (req, res) => {
    sendResult(res, await fn(req.user!.id, req));
  };
  const defer = byUser((userId, req) => writes.defer(userId, req.body));
  const undefer = byUser((userId, req) => writes.undefer(userId, req.query.key));
  const createGroup = byUser((userId, req) => writes.createGroup(userId, req.body));
  const patchGroup = byUser((userId, req) => writes.patchGroup(userId, String(req.params.id), req.body));
  const putMembers = byUser((userId, req) => writes.putMembers(userId, String(req.params.id), req.body));
  const deleteGroup = byUser((userId, req) => writes.deleteGroup(userId, String(req.params.id)));
  const dismissSuggestion = byUser((userId, req) => writes.dismissSuggestion(userId, req.body));

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

  const list = prsLister(deps, tokenFor, deferrals, links, groupStore, dismissals, rounds);
  const prs: RequestHandler = async (req, res) => {
    sendResult(res, await list(req.user!.id));
  };

  // A new workstream on the PR's own branch (routes/workstreams.ts, `pr`), attached to the PR by hand.
  const newWorkstream: RequestHandler = async (req, res) => {
    sendResult(res, await prWorkstreamFor(req.user!, req.params, req.body, {}, tokenFor, actions.head, createWorkstream, links));
  };

  const version: RequestHandler = async (_req, res) => {
    res.json(await deps.version());
  };

  const bake = byUser(userId => bakeNow(userId, tokenFor, actions.bake));

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
  router.get('/prs/:owner/:repo/:number/files', requireAuth, asyncHandler(files));
  router.get('/prs/:owner/:repo/:number/threads', requireAuth, asyncHandler(threads));
  router.post('/prs/:owner/:repo/:number/review', requireAuth, asyncHandler(review));
  router.post('/prs/:owner/:repo/:number/merge', requireAuth, asyncHandler(merge));
  router.post('/prs/:owner/:repo/:number/rerun-failed', requireAuth, asyncHandler(rerun));
  router.post('/prs/:owner/:repo/:number/reviewers', requireAuth, asyncHandler(reviewers));
  router.post('/prs/:owner/:repo/:number/comment', requireAuth, asyncHandler(comment));
  router.post('/prs/:owner/:repo/:number/workstream', requireAuth, asyncHandler(newWorkstream));
  router.get('/version', requireAuthOrAgentToken, asyncHandler(version));
  return router;
}
