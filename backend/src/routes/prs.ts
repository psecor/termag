import { Router, RequestHandler } from 'express';
import { requireAuth, requireAuthOrAgentToken } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { connectedOwnedBoxes } from '../services/agentRegistry';
import { githubTokenSource } from '../services/credentialStore';
import { GithubApiError } from '../services/githubCredential';
import {
  TERMAG_REPO, assignLanes, branchLane, deployState, followsDeploy, groupByLane, prKey, touchesBoxes,
  type DeployState, type MergedPr,
} from '../services/prPipeline';
import { commitContains, mergedHeads, searchPrs, type PrSearchResult } from '../services/prPipelineGithub';
import { readBranches, type BranchSweep } from '../services/prBranches';
import { termagVersion, type TermagVersion } from '../services/termagVersion';
import { swrMemo } from '../services/ttlMemo';

// The PR pipeline:
//
//   GET /api/prs       the user's pull requests, already in lanes
//   GET /api/version   the termag commit this orchestrator runs
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
  /** Connected boxes whose agent commit was checked for box-side merges. */
  boxes: number;
  fetchedAt: string;
  notes: string[];
}

/** Everything a load reads, injectable so the assembly is testable without GitHub or boxes. */
export interface PipelineDeps {
  search: (token: string, now: Date) => Promise<PrSearchResult>;
  branches: (userId: string) => Promise<BranchSweep>;
  version: () => Promise<TermagVersion>;
  contains: (token: string, repo: string, running: string, commit: string) => Promise<boolean | null>;
  mergedHeads: (token: string, viewer: string, heads: { repo: string; branch: string }[]) => Promise<Set<string> | null>;
  /** The commit each connected box's agent runs (null when it did not say). */
  boxCommits: () => (string | null)[];
  now: () => Date;
}

const defaultDeps: PipelineDeps = {
  search: (token, now) => searchPrs(token, now),
  branches: readBranches,
  version: termagVersion,
  contains: (token, repo, running, commit) => commitContains(token, repo, running, commit),
  mergedHeads: (token, viewer, heads) => mergedHeads(token, viewer, heads),
  boxCommits: () => connectedOwnedBoxes().map(b => b.agentCommit),
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
): Promise<Map<string, DeployState>> {
  const out = new Map<string, DeployState>();
  const termag = merged.filter(pr => followsDeploy(pr) && pr.mergeCommit);
  if (termag.length === 0) return out;
  const boxShas = deps.boxCommits();
  const gate = limit(COMPARE_CONCURRENCY);
  const contains = (running: string, commit: string) => gate(() => deps.contains(token, TERMAG_REPO, running, commit));
  await Promise.all(termag.map(async pr => {
    const oid = pr.mergeCommit!;
    const inProd = prod.sha ? await contains(prod.sha, oid) : null;
    const boxSide = touchesBoxes(pr.files, pr.filesTruncated);
    const inBox = inProd && boxSide
      ? await Promise.all(boxShas.map(sha => sha ? contains(sha, oid) : Promise.resolve(null)))
      : [];
    out.set(prKey(pr.repo, pr.number), deployState(inProd, boxSide, inBox));
  }));
  return out;
}

const SEARCH_NAME = { authored: 'your open pull requests', review: 'review requests', merged: 'your merges of the last 14 days' };

/** The response's notes: whatever is missing from the lanes, and why. */
export function pipelineNotes(search: Pick<PrSearchResult, 'truncated'>, sweep: Pick<BranchSweep, 'offline' | 'outdatedAgent' | 'failed'>, prod: TermagVersion): string[] {
  const notes: string[] = [];
  for (const t of search.truncated) notes.push(`Showing ${t.shown} of ${t.total} ${SEARCH_NAME[t.search]}.`);
  if (sweep.offline) notes.push(`${plural(sweep.offline, 'workstream')} on a box that is offline or stopped: not shown in In progress / Needs a PR.`);
  if (sweep.outdatedAgent) notes.push(`${plural(sweep.outdatedAgent, 'workstream')} on a box whose agent predates the branch read; restart that agent.`);
  if (sweep.failed) notes.push(`${plural(sweep.failed, 'workstream')} could not be read (a timeout, or a missing worktree): not shown in In progress / Needs a PR.`);
  if (!prod.sha) notes.push('The orchestrator cannot tell which commit it runs, so termag merges stay in "Merged, not deployed".');
  return notes;
}

export async function loadPipeline(userId: string, token: string, deps: PipelineDeps = defaultDeps): Promise<PipelineResponse> {
  const now = deps.now();
  const [search, sweep, prod] = await Promise.all([
    deps.search(token, now),
    deps.branches(userId),
    deps.version(),
  ]);
  const candidates = sweep.branches.filter(b => b.repo && branchLane(b)).map(b => ({ repo: b.repo!, branch: b.branch }));
  const [deploys, merged] = await Promise.all([
    termagDeploys(token, search.merged, prod, deps),
    candidates.length ? deps.mergedHeads(token, search.viewer, candidates) : Promise.resolve(new Set<string>()),
  ]);
  const rows = assignLanes({ ...search, deploys, branches: sweep.branches, workstreams: sweep.workstreams, mergedHeads: merged ?? undefined });
  return {
    connected: true,
    viewer: search.viewer,
    lanes: groupByLane(rows),
    prod,
    boxes: deps.boxCommits().length,
    fetchedAt: now.toISOString(),
    notes: pipelineNotes(search, sweep, prod),
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

/** Test seam. */
export function _resetPipelineMemos(): void {
  memos.clear();
}

export function prsRouter(
  deps: PipelineDeps = defaultDeps,
  tokenFor: (userId: string) => Promise<string | null> = githubTokenSource,
): Router {
  const router = Router();

  const prs: RequestHandler = async (req, res) => {
    const token = await tokenFor(req.user!.id);
    if (!token) { res.json({ connected: false }); return; }
    try {
      res.json(await pipelineFor(req.user!.id, token, deps));
    } catch (err) {
      if (!(err instanceof GithubApiError)) throw err;
      const error = err.status === 401
        ? 'GitHub rejected your stored token. Reconnect GitHub in Settings.'
        : err.message;
      res.status(502).json({ error });
    }
  };

  const version: RequestHandler = async (_req, res) => {
    res.json(await deps.version());
  };

  router.get('/prs', requireAuth, asyncHandler(prs));
  router.get('/version', requireAuthOrAgentToken, asyncHandler(version));
  return router;
}
