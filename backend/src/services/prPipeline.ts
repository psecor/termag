/**
 * The PR pipeline's lane rules: every pull request the
 * user authored or was asked to review, and every live branch that has not
 * become one, placed in exactly one lane. Pure: the GitHub reads live in
 * prPipelineGithub.ts, the assembly in routes/prs.ts.
 *
 * Lanes left to right are the order work moves. `merged` is the terminal lane
 * for repositories other than this deployment's termag (TERMAG_REPO), which v1 cannot follow to a
 * deploy; termag's merges go to `merged_not_deployed` or `deployed` instead.
 */

// The repository whose merges the pipeline can follow to a deploy: this
// deployment's own termag. TERMAG_REPO overrides the public default.
export const TERMAG_REPO = process.env.TERMAG_REPO?.trim() || 'psecor/termag';

export const LANES = [
  { id: 'in_progress', label: 'In progress' },
  { id: 'needs_pr', label: 'Needs a PR' },
  { id: 'checks', label: 'Checks & bot review' },
  { id: 'needs_approval', label: 'Needs approval' },
  { id: 'needs_my_review', label: 'Needs my review' },
  { id: 'ready_to_merge', label: 'Ready to merge' },
  { id: 'merged_not_deployed', label: 'Merged, not deployed' },
  { id: 'deployed', label: 'Deployed' },
  { id: 'merged', label: 'Merged' },
] as const;

export type LaneId = typeof LANES[number]['id'];

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface CheckState {
  name: string;
  /** pending: queued or running; failed: a red conclusion; passed: anything else that finished. */
  state: 'pending' | 'failed' | 'passed';
}

/** An open pull request, as read from GitHub. */
export interface OpenPr {
  repo: string; // owner/name
  number: number;
  title: string;
  url: string;
  author: string | null;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null (no review required). */
  reviewDecision: string | null;
  /** MERGEABLE | CONFLICTING | UNKNOWN */
  mergeable: string;
  /** BEHIND | BLOCKED | CLEAN | DIRTY | DRAFT | HAS_HOOKS | UNKNOWN | UNSTABLE */
  mergeStateStatus: string;
  autoMerge: boolean;
  /** SUCCESS | FAILURE | ERROR | PENDING | EXPECTED | null (no checks at all). */
  checkRollup: string | null;
  checks: CheckState[];
  /** Users and teams asked to review who have not answered yet. */
  requestedReviewers: string[];
  /** When the latest review request was made; review-requested search only. */
  requestedAt?: string | null;
}

/** A merged pull request from the last 14 days. */
export interface MergedPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  headRefName: string;
  baseRefName: string;
  mergedAt: string;
  mergedBy: string | null;
  mergeCommit: string | null;
  /** The first page of changed paths (GitHub's limit is 100 per page). */
  files: string[];
  /** More files than `files` holds: whether it touches the boxes is unknown. */
  filesTruncated?: boolean;
}

/**
 * A live workstream's git state, from the box's `git-branch-state` RPC.
 * `pushed` means the branch has an upstream and no commits the upstream lacks.
 */
export interface BranchState {
  repo: string | null;
  branch: string;
  baseBranch: string;
  /** Null when the box could not count against origin/<base> (no such ref, a timeout). */
  aheadOfBase: number | null;
  pushed: boolean;
  dirty: boolean;
  lastCommitAt: string | null;
  workstream: WorkstreamLink;
}

export interface WorkstreamLink {
  projectId: string;
  projectName: string;
  workstream: string;
}

/** Whether a termag merge commit is in what runs, from routes/prs.ts's compare calls. */
export type DeployState =
  | { state: 'unknown'; reason: string }
  | { state: 'not_deployed' }
  // On the orchestrator, but some connected boxes run an agent without it.
  | { state: 'orchestrator_only'; boxesBehind: number; boxesUnknown: number; boxes: number }
  | { state: 'deployed'; boxesUnknown: number; boxes: number };

// ── Output ───────────────────────────────────────────────────────────────────

export interface PrRow {
  kind: 'pr' | 'branch';
  lane: LaneId;
  repo: string | null;
  number: number | null;
  title: string;
  url: string | null;
  author: string | null;
  headRefName: string;
  baseRefName: string;
  /** When the row last changed: the PR's updatedAt, mergedAt, or the branch's last commit. */
  at: string | null;
  /** draft, conflict, auto-merge, dirty. */
  badges: string[];
  failingChecks: string[];
  pendingChecks: string[];
  waitingOn: string[];
  /** Lane 6: what stands between the PR and a merge, when GitHub says something does. */
  blockedBy: string | null;
  mergedAt: string | null;
  mergeCommit: string | null;
  deploy: DeployState | null;
  workstream: WorkstreamLink | null;
  /** Lane 5: when the review of me was asked for. */
  requestedAt: string | null;
  /** Lane 5: where "Review with Devin" runs: the linked workstream, else main of a project on the PR's repo. */
  reviewTarget: WorkstreamLink | null;
}

// ── Rules ────────────────────────────────────────────────────────────────────

const GREEN_ROLLUPS = new Set(['SUCCESS']);
const NEEDS_HUMAN = new Set(['REVIEW_REQUIRED', 'CHANGES_REQUESTED']);

function checksGreen(pr: OpenPr): boolean {
  // No checks at all is green: nothing is running and nothing is red.
  return pr.checkRollup === null || GREEN_ROLLUPS.has(pr.checkRollup);
}

/** The lane of an open PR the user authored. */
export function authoredLane(pr: OpenPr): LaneId {
  if (pr.isDraft || !checksGreen(pr)) return 'checks';
  if (pr.reviewDecision && NEEDS_HUMAN.has(pr.reviewDecision)) return 'needs_approval';
  return 'ready_to_merge';
}

/** mergeStateStatus values that mean an approved, green PR still can't merge. */
const BLOCKING: Record<string, string> = {
  BEHIND: 'branch is behind its base',
  BLOCKED: 'blocked by branch protection',
  DIRTY: 'merge conflict',
  UNSTABLE: 'non-required checks failing',
};

function badgesFor(pr: OpenPr): string[] {
  const out: string[] = [];
  if (pr.isDraft) out.push('draft');
  if (pr.mergeable === 'CONFLICTING') out.push('conflict');
  if (pr.autoMerge) out.push('auto-merge');
  return out;
}

function openRow(pr: OpenPr, lane: LaneId): PrRow {
  return {
    kind: 'pr',
    lane,
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    at: pr.updatedAt,
    badges: badgesFor(pr),
    failingChecks: pr.checks.filter(c => c.state === 'failed').map(c => c.name),
    pendingChecks: pr.checks.filter(c => c.state === 'pending').map(c => c.name),
    waitingOn: pr.requestedReviewers,
    blockedBy: lane === 'ready_to_merge' ? BLOCKING[pr.mergeStateStatus] ?? null : null,
    mergedAt: null,
    mergeCommit: null,
    deploy: null,
    workstream: null,
    requestedAt: lane === 'needs_my_review' ? pr.requestedAt ?? null : null,
    reviewTarget: null,
  };
}

/** The deploy lanes follow termag merges into `main` only; a stacked or release base never reaches prod as such. */
export const TERMAG_DEPLOY_BRANCH = 'main';
export function followsDeploy(pr: Pick<MergedPr, 'repo' | 'baseRefName'>): boolean {
  return pr.repo === TERMAG_REPO && pr.baseRefName === TERMAG_DEPLOY_BRANCH;
}

/** Which lane a merged PR is in, given its deploy state (termag only). */
export function mergedLane(pr: MergedPr, deploy: DeployState | null): LaneId {
  if (!followsDeploy(pr)) return 'merged';
  return deploy?.state === 'deployed' ? 'deployed' : 'merged_not_deployed';
}

/**
 * Paths whose changes run on the boxes too, so the orchestrator alone is not
 * "deployed". A truncated file list counts as box-side: unknown has to err
 * toward "boxes behind", never toward "deployed".
 */
export function touchesBoxes(files: string[], truncated = false): boolean {
  return truncated || files.some(f => f.startsWith('agent/') || f.startsWith('deploy/'));
}

/**
 * Combine "is the merge commit in prod" with, for a box-side change, "is it in
 * each connected box's agent". `inBox` holds one answer per connected box: true,
 * false, or null when GitHub could not say (a box cloned from the public mirror
 * runs a commit the internal repo does not have). Unknown boxes are counted but
 * do not hold a PR back, since nothing termag does would ever resolve them.
 */
export function deployState(inProd: boolean | null, boxSide: boolean, inBox: (boolean | null)[]): DeployState {
  if (inProd === null) return { state: 'unknown', reason: 'cannot tell which commit the orchestrator runs' };
  if (!inProd) return { state: 'not_deployed' };
  const boxes = boxSide ? inBox.length : 0;
  const boxesUnknown = boxSide ? inBox.filter(b => b === null).length : 0;
  const boxesBehind = boxSide ? inBox.filter(b => b === false).length : 0;
  if (boxesBehind > 0) return { state: 'orchestrator_only', boxesBehind, boxesUnknown, boxes };
  return { state: 'deployed', boxesUnknown, boxes };
}

function mergedRow(pr: MergedPr, deploy: DeployState | null): PrRow {
  return {
    kind: 'pr',
    lane: mergedLane(pr, deploy),
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    at: pr.mergedAt,
    badges: [],
    failingChecks: [],
    pendingChecks: [],
    waitingOn: [],
    blockedBy: null,
    mergedAt: pr.mergedAt,
    mergeCommit: pr.mergeCommit,
    deploy: followsDeploy(pr) ? deploy : null,
    workstream: null,
    requestedAt: null,
    reviewTarget: null,
  };
}

/** Lanes 1 and 2 for a branch no PR (open or merged) covers; null when there is nothing to show. */
export function branchLane(b: BranchState): LaneId | null {
  // No origin GitHub knows: nothing a PR could be opened from (a scratch repo, a fresh project).
  if (!b.repo) return null;
  if (b.branch === b.baseBranch) return null;
  // An unknown count is a branch that may hold work: show it rather than drop
  // it. Only a known 0 means "nothing past base".
  const ahead = b.aheadOfBase === null || b.aheadOfBase > 0;
  if (b.pushed && ahead) return 'needs_pr';
  if (ahead || b.dirty) return 'in_progress';
  return null;
}

function branchRow(b: BranchState, lane: LaneId): PrRow {
  return {
    kind: 'branch',
    lane,
    repo: b.repo,
    number: null,
    title: b.branch,
    url: null,
    author: null,
    headRefName: b.branch,
    baseRefName: b.baseBranch,
    at: b.lastCommitAt,
    badges: b.dirty ? ['dirty'] : [],
    failingChecks: [],
    pendingChecks: [],
    waitingOn: [],
    blockedBy: null,
    mergedAt: null,
    mergeCommit: null,
    deploy: null,
    workstream: b.workstream,
    requestedAt: null,
    reviewTarget: null,
  };
}

// ── Workstream linkage ───────────────────────────────────────────────────────

export interface LinkableWorkstream extends WorkstreamLink {
  branch: string;
  /** owner/name of the checkout's origin, when known. */
  repo: string | null;
}

/**
 * The workstream a PR came from: same repository and branch. Projects do not
 * record their repository yet, so a workstream with no known repo matches on
 * branch alone, and only when exactly one does: a guess between two is worse
 * than no chip. A base branch (main, master, the PR's own base) never links,
 * since every project has one.
 */
export function linkWorkstream(
  repo: string, branch: string, base: string, workstreams: LinkableWorkstream[],
): WorkstreamLink | null {
  if (branch === base || branch === 'main' || branch === 'master') return null;
  const sameBranch = workstreams.filter(w => w.branch === branch && (w.repo === null || sameRepo(w.repo, repo)));
  const exact = sameBranch.filter(w => w.repo !== null);
  const pick = exact.length > 0 ? exact : sameBranch;
  if (pick.length !== 1) return null;
  const { projectId, projectName, workstream } = pick[0];
  return { projectId, projectName, workstream };
}

function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Where to review a PR with Devin: the workstream it came from, else the
 * `main` workstream of a project whose checkout is the PR's repository (a
 * colleague's PR reviewed from my own clone). Null when no project has it.
 */
export function reviewTarget(repo: string, linked: WorkstreamLink | null, workstreams: LinkableWorkstream[]): WorkstreamLink | null {
  if (linked) return linked;
  const main = workstreams.find(w => w.workstream === 'main' && w.repo !== null && sameRepo(w.repo, repo));
  return main ? { projectId: main.projectId, projectName: main.projectName, workstream: main.workstream } : null;
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export interface PipelineInput {
  viewer: string;
  authored: OpenPr[];
  reviewRequested: OpenPr[];
  merged: MergedPr[];
  /** Keyed by `${repo}#${number}`; termag merges only. */
  deploys: Map<string, DeployState>;
  branches: BranchState[];
  workstreams: LinkableWorkstream[];
  /** `${repo lowercased}:${branch}` heads that already had a PR merged (prPipelineGithub.mergedHeads). */
  mergedHeads?: Set<string>;
}

export const prKey = (repo: string, number: number) => `${repo}#${number}`;

/** Every row in its lane, newest first within a lane. */
export function assignLanes(input: PipelineInput): PrRow[] {
  const rows: PrRow[] = [];
  const seen = new Set<string>();
  const covered = new Set<string>(); // `${repo}:${branch}` and `:${branch}` for branch-row suppression

  const cover = (repo: string, branch: string) => {
    covered.add(`${repo.toLowerCase()}:${branch}`);
    covered.add(`:${branch}`);
  };

  for (const pr of input.authored) {
    const key = prKey(pr.repo, pr.number);
    if (seen.has(key)) continue;
    seen.add(key);
    cover(pr.repo, pr.headRefName);
    rows.push(openRow(pr, authoredLane(pr)));
  }
  for (const pr of input.reviewRequested) {
    const key = prKey(pr.repo, pr.number);
    // The search excludes the viewer's own PRs; the author check is a backstop.
    if (seen.has(key) || pr.author === input.viewer) continue;
    seen.add(key);
    rows.push(openRow(pr, 'needs_my_review'));
  }
  for (const pr of input.merged) {
    const key = prKey(pr.repo, pr.number);
    if (seen.has(key)) continue;
    seen.add(key);
    cover(pr.repo, pr.headRefName);
    rows.push(mergedRow(pr, input.deploys.get(key) ?? null));
  }
  for (const row of rows) {
    if (!row.repo) continue;
    row.workstream = linkWorkstream(row.repo, row.headRefName, row.baseRefName, input.workstreams);
    if (row.lane === 'needs_my_review') row.reviewTarget = reviewTarget(row.repo, row.workstream, input.workstreams);
  }

  for (const b of input.branches) {
    const coveredKey = b.repo ? `${b.repo.toLowerCase()}:${b.branch}` : `:${b.branch}`;
    if (covered.has(coveredKey) || input.mergedHeads?.has(coveredKey)) continue;
    const lane = branchLane(b);
    if (lane) rows.push(branchRow(b, lane));
  }

  return rows.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
}

/** The rows grouped by lane, every lane present, in left-to-right order. */
export function groupByLane(rows: PrRow[]): { id: LaneId; label: string; rows: PrRow[] }[] {
  return LANES.map(l => ({ id: l.id, label: l.label, rows: rows.filter(r => r.lane === l.id) }));
}
