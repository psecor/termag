/**
 * One pull request up close, and a review of it, for the PR pipeline's row
 * actions. Both run as the user, with
 * their stored gh token, like the searches in prPipelineGithub.ts:
 *
 *   - `fetchPrOverview`: one GraphQL read of the PR, its description, its
 *     files and who has reviewed it, for the dashboard's overview dialog;
 *   - `submitReview`: REST `POST /repos/{o}/{r}/pulls/{n}/reviews`;
 *   - `mergePr`: merge now (REST `PUT …/pulls/{n}/merge`, pinned to the head
 *     commit the user was shown), or turn auto-merge on or off (GraphQL);
 *   - `rerunFailedChecks`: re-run the failed jobs of each failed GitHub
 *     Actions run on the head commit (REST `actions/runs/{id}/rerun-failed-jobs`).
 *     Checks from other apps (Bugbot, say) cannot be restarted this way;
 *   - `requestReviewers`: (re-)request reviews (REST `pulls/{n}/requested_reviewers`),
 *     which notifies a reviewer who already answered again;
 *   - `postComment`: a PR conversation comment (REST `issues/{n}/comments`), the
 *     nudge for reviewers already asked, since re-requesting them does nothing.
 *
 * The writes are the viewer's own, with the viewer's own token: GitHub
 * decides what they may do (no approving your own PR, branch protection, one
 * pending review per PR) and its message is passed back.
 */

import { GithubApiError } from './githubCredential';
import { FRAGMENTS, ORGS, headers, parseOpenPr } from './prPipelineGithub';
import type { OpenPr } from './prPipeline';

type Fetch = typeof fetch;
type Raw = Record<string, any>;
const API = 'https://api.github.com';

// ── Input ────────────────────────────────────────────────────────────────────

export class PrInputError extends Error {}

export interface PrRef { owner: string; name: string; number: number }

const NAME = /^[\w.-]+$/;

/**
 * Any repository's PR, for a read made with the user's own token (the
 * overview of a review group member, which can be from any repository:
 * services/prReviewGroups.ts). Writes stay with parsePrRef's orgs.
 */
export function parseAnyPrRef(owner: unknown, name: unknown, number: unknown): PrRef {
  const n = typeof number === 'string' && /^\d{1,9}$/.test(number) ? Number(number) : NaN;
  if (typeof owner !== 'string' || !NAME.test(owner) || typeof name !== 'string' || !NAME.test(name) || !Number.isInteger(n) || n < 1) {
    throw new PrInputError('Not a pull request');
  }
  return { owner, name, number: n };
}

/** A PR the pipeline could have shown: in one of its orgs, with a sane name and number. */
export function parsePrRef(owner: unknown, name: unknown, number: unknown): PrRef {
  const { number: n } = parseAnyPrRef(owner, name, number);
  const org = ORGS.find(o => o.toLowerCase() === (owner as string).toLowerCase());
  if (!org) throw new PrInputError(`Only pull requests in ${ORGS.join(' or ')} can be opened here`);
  return { owner: org, name: name as string, number: n };
}

export type ReviewEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
export interface ReviewInput { event: ReviewEvent; body: string }

// GitHub's own limit on a review body.
export const MAX_REVIEW_BODY = 65_536;

export function parseReviewInput(raw: unknown): ReviewInput {
  const r = (raw ?? {}) as Raw;
  const event = r.event;
  if (event !== 'APPROVE' && event !== 'COMMENT' && event !== 'REQUEST_CHANGES') {
    throw new PrInputError('event must be APPROVE, COMMENT or REQUEST_CHANGES');
  }
  const body = typeof r.body === 'string' ? r.body.trim() : '';
  if (body.length > MAX_REVIEW_BODY) throw new PrInputError('The review is too long for GitHub');
  // GitHub refuses both without a body; say so before the round trip.
  if (!body && event !== 'APPROVE') throw new PrInputError(event === 'COMMENT' ? 'A comment needs some text' : 'Say what needs to change');
  return { event, body };
}

// ── Overview ─────────────────────────────────────────────────────────────────

export interface PrFile { path: string; additions: number; deletions: number; changeType: string }
export interface PrReviewSummary { author: string | null; state: string; submittedAt: string | null }

export interface PrOverview extends OpenPr {
  viewer: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  body: string;
  createdAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** The first page of files; `filesTruncated` when there are more. */
  files: PrFile[];
  filesTruncated: boolean;
  /** Each reviewer's latest review. */
  reviews: PrReviewSummary[];
  /** The viewer's own latest review, if any (a PENDING one is a draft on GitHub). */
  viewerReview: PrReviewSummary | null;
  /** Whether the viewer's review can approve or request changes: false on their own PR. */
  viewerCanReview: boolean;
  /** GraphQL node id and head commit, for the merge actions. */
  nodeId: string | null;
  headSha: string | null;
  /** The method auto-merge will use, when it is on. */
  autoMergeMethod: MergeMethod | null;
  /** What the repository allows. `methods` in GitHub's button order, never empty for a mergeable repo. */
  mergeSettings: { methods: MergeMethod[]; defaultMethod: MergeMethod | null; autoMergeAllowed: boolean };
  /** termag offers the merge panel on the viewer's own open PRs; GitHub still decides. */
  viewerCanMerge: boolean;
  /** The head commit's failed check suites: Actions runs termag can re-run, and other apps it cannot. */
  failedSuites: FailedSuites;
  /** Pending review requests by kind, for re-requesting and @-mentions (`requestedReviewers` flattens them). */
  requestedUsers: string[];
  requestedTeams: string[];
}

export interface FailedSuites {
  runs: { runId: number; workflow: string }[];
  other: string[];
}

export type MergeMethod = 'MERGE' | 'SQUASH' | 'REBASE';
const MERGE_METHODS: MergeMethod[] = ['SQUASH', 'MERGE', 'REBASE'];
const isMethod = (v: unknown): v is MergeMethod => typeof v === 'string' && (MERGE_METHODS as string[]).includes(v);

// Aliased: the Open fragment already selects `commits(last: 1)` with other fields.
const SUITES_FRAGMENT = `
fragment Suites on PullRequest {
  head: commits(last: 1) { nodes { commit { checkSuites(first: 50) { nodes {
    status conclusion
    app { name }
    workflowRun { databaseId workflow { name } }
  } } } } }
}`;

const FAILED_SUITE = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);

/** A finished, failed suite with a workflow run can be re-run through Actions; any other failed suite is listed by its app. */
export function parseFailedSuites(pr: Raw | null | undefined): FailedSuites {
  const suites = (pr?.head?.nodes?.[0]?.commit?.checkSuites?.nodes ?? []) as Raw[];
  const runs: FailedSuites['runs'] = [];
  const other = new Set<string>();
  for (const s of suites) {
    if (s?.status !== 'COMPLETED' || !FAILED_SUITE.has(s?.conclusion)) continue;
    const runId = s.workflowRun?.databaseId;
    if (typeof runId === 'number') {
      if (!runs.some(r => r.runId === runId)) runs.push({ runId, workflow: typeof s.workflowRun.workflow?.name === 'string' ? s.workflowRun.workflow.name : `run ${runId}` });
    } else {
      other.add(typeof s.app?.name === 'string' ? s.app.name : 'an app');
    }
  }
  return { runs, other: [...other] };
}

const OVERVIEW = `query Overview($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    ...Open
    state body createdAt additions deletions changedFiles
    files(first: 100) { pageInfo { hasNextPage } nodes { path additions deletions changeType } }
    latestReviews(first: 20) { nodes { author { login } state submittedAt } }
    viewerLatestReview { author { login } state submittedAt }
    id headRefOid
    autoMergeRequest { mergeMethod }
    repository { mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed viewerDefaultMergeMethod }
    ...Suites
  } }
}
${SUITES_FRAGMENT}
${FRAGMENTS.Open}`;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function review(node: Raw | null | undefined): PrReviewSummary | null {
  if (!node || typeof node.state !== 'string') return null;
  return { author: typeof node.author?.login === 'string' ? node.author.login : null, state: node.state, submittedAt: node.submittedAt ?? null };
}

function mergeSettings(repo: Raw | undefined): PrOverview['mergeSettings'] {
  const allowed: Record<MergeMethod, unknown> = { SQUASH: repo?.squashMergeAllowed, MERGE: repo?.mergeCommitAllowed, REBASE: repo?.rebaseMergeAllowed };
  const methods = MERGE_METHODS.filter(m => allowed[m] === true);
  const preferred = repo?.viewerDefaultMergeMethod;
  return {
    methods,
    defaultMethod: isMethod(preferred) && methods.includes(preferred) ? preferred : methods[0] ?? null,
    autoMergeAllowed: repo?.autoMergeAllowed === true,
  };
}

function requestsByKind(node: Raw): { requestedUsers: string[]; requestedTeams: string[] } {
  const reviewers = ((node.reviewRequests?.nodes ?? []) as Raw[]).map(n => n?.requestedReviewer);
  const pick = (kind: string, key: string) => reviewers
    .filter(r => r?.__typename === kind && typeof r[key] === 'string' && r[key])
    .map(r => r[key] as string);
  return { requestedUsers: pick('User', 'login'), requestedTeams: pick('Team', 'slug') };
}

export function parseOverview(data: Raw): PrOverview | null {
  const node = data?.repository?.pullRequest;
  const base = node ? parseOpenPr(node) : null;
  if (!base) return null;
  const viewer = typeof data.viewer?.login === 'string' ? data.viewer.login : '';
  const state = node.state === 'MERGED' || node.state === 'CLOSED' ? node.state : 'OPEN';
  return {
    ...base,
    viewer,
    state,
    body: typeof node.body === 'string' ? node.body : '',
    createdAt: node.createdAt ?? null,
    additions: num(node.additions),
    deletions: num(node.deletions),
    changedFiles: num(node.changedFiles),
    files: ((node.files?.nodes ?? []) as Raw[])
      .filter(f => typeof f?.path === 'string')
      .map(f => ({ path: f.path, additions: num(f.additions), deletions: num(f.deletions), changeType: String(f.changeType ?? 'MODIFIED') })),
    filesTruncated: node.files?.pageInfo?.hasNextPage === true,
    reviews: ((node.latestReviews?.nodes ?? []) as Raw[]).map(review).filter((r): r is PrReviewSummary => r !== null),
    viewerReview: review(node.viewerLatestReview),
    viewerCanReview: state === 'OPEN' && !!viewer && base.author?.toLowerCase() !== viewer.toLowerCase(),
    nodeId: typeof node.id === 'string' ? node.id : null,
    headSha: typeof node.headRefOid === 'string' ? node.headRefOid : null,
    autoMergeMethod: isMethod(node.autoMergeRequest?.mergeMethod) ? node.autoMergeRequest.mergeMethod : null,
    mergeSettings: mergeSettings(node.repository),
    viewerCanMerge: state === 'OPEN' && !!viewer && base.author?.toLowerCase() === viewer.toLowerCase(),
    failedSuites: parseFailedSuites(node),
    ...requestsByKind(node),
  };
}

export async function fetchPrOverview(token: string, ref: PrRef, fetchImpl: Fetch = fetch): Promise<PrOverview> {
  const res = await fetchImpl(`${API}/graphql`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: OVERVIEW, variables: { owner: ref.owner, name: ref.name, number: ref.number } }),
  });
  if (!res.ok) throw new GithubApiError(`GitHub read failed (HTTP ${res.status})`, res.status);
  const body = await res.json() as { data?: Raw; errors?: { message?: string }[] };
  const pr = body.data ? parseOverview(body.data) : null;
  if (!pr) {
    const why = body.errors?.map(e => e.message).filter(Boolean).join('; ');
    throw new GithubApiError(why ? `GitHub could not read that pull request: ${why}` : 'GitHub has no such pull request, or your token cannot see it', 404);
  }
  return pr;
}

// ── Review ───────────────────────────────────────────────────────────────────

/** GitHub's reason for refusing, from a REST error body: `message` plus any `errors[]` strings. */
export function githubReason(body: unknown): string | null {
  const b = (body ?? {}) as Raw;
  const parts: string[] = [];
  if (typeof b.message === 'string' && b.message) parts.push(b.message);
  for (const e of Array.isArray(b.errors) ? b.errors : []) {
    const m = typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : null;
    if (m) parts.push(m);
  }
  return parts.length ? parts.join(': ') : null;
}

export interface SubmittedReview { id: number | null; state: string | null; url: string | null }

export async function submitReview(token: string, ref: PrRef, input: ReviewInput, fetchImpl: Fetch = fetch): Promise<SubmittedReview> {
  const res = await fetchImpl(`${API}/repos/${ref.owner}/${ref.name}/pulls/${ref.number}/reviews`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    // An APPROVE with no text sends no body: GitHub stores "" as an empty comment.
    body: JSON.stringify(input.body ? { event: input.event, body: input.body } : { event: input.event }),
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const reason = githubReason(body);
    throw new GithubApiError(reason ? `GitHub refused the review: ${reason}` : `GitHub refused the review (HTTP ${res.status})`, res.status);
  }
  const b = (body ?? {}) as Raw;
  return { id: typeof b.id === 'number' ? b.id : null, state: typeof b.state === 'string' ? b.state : null, url: typeof b.html_url === 'string' ? b.html_url : null };
}

// ── Merge ────────────────────────────────────────────────────────────────────

export type MergeInput =
  | { mode: 'now'; method: MergeMethod; sha: string }
  | { mode: 'auto'; method: MergeMethod }
  | { mode: 'cancel_auto' };

const SHA = /^[0-9a-f]{40}$/i;

export function parseMergeInput(raw: unknown): MergeInput {
  const r = (raw ?? {}) as Raw;
  if (r.mode === 'cancel_auto') return { mode: 'cancel_auto' };
  if (r.mode !== 'now' && r.mode !== 'auto') throw new PrInputError('mode must be now, auto or cancel_auto');
  if (!isMethod(r.method)) throw new PrInputError('method must be SQUASH, MERGE or REBASE');
  if (r.mode === 'auto') return { mode: 'auto', method: r.method };
  // A merge is pinned to the commit the user looked at: a push since then makes GitHub refuse (409).
  if (typeof r.sha !== 'string' || !SHA.test(r.sha)) throw new PrInputError('sha must be the head commit you reviewed');
  return { mode: 'now', method: r.method, sha: r.sha };
}

export interface MergeResult {
  merged: boolean;
  /** For a merge now, the merge commit; null otherwise. */
  sha: string | null;
  autoMerge: boolean;
  message: string | null;
}

async function graphqlWrite(token: string, query: string, variables: Record<string, unknown>, fetchImpl: Fetch): Promise<Raw> {
  const res = await fetchImpl(`${API}/graphql`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new GithubApiError(`GitHub refused (HTTP ${res.status})`, res.status);
  const body = await res.json() as { data?: Raw; errors?: { message?: string }[] };
  // A refused mutation is a 200 with `errors` ("Pull request is in clean status", "not allowed").
  if (body.errors?.length) {
    throw new GithubApiError(`GitHub refused: ${body.errors.map(e => e.message).filter(Boolean).join('; ') || 'unknown error'}`, 422);
  }
  return body.data ?? {};
}

/**
 * A read, unlike graphqlWrite: GitHub answers 200 with `errors` beside the
 * data when part of a query could not resolve (one app's suite, a SAML-gated
 * field), and the overview renders from what came back, so this does too.
 * Only no data at all is an error.
 */
async function graphqlRead(token: string, query: string, variables: Record<string, unknown>, fetchImpl: Fetch): Promise<Raw> {
  const res = await fetchImpl(`${API}/graphql`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new GithubApiError(`GitHub read failed (HTTP ${res.status})`, res.status);
  const body = await res.json() as { data?: Raw | null; errors?: { message?: string }[] };
  if (!body.data) {
    const why = body.errors?.map(e => e.message).filter(Boolean).join('; ') || 'no data';
    throw new GithubApiError(`GitHub read failed: ${why}`, 502);
  }
  return body.data;
}

const PR_ID = `query PrId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`;
const ENABLE_AUTO = `mutation EnableAutoMerge($id: ID!, $method: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { pullRequest { autoMergeRequest { enabledAt } } }
}`;
const DISABLE_AUTO = `mutation DisableAutoMerge($id: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { autoMergeRequest { enabledAt } } }
}`;

export async function mergePr(token: string, ref: PrRef, input: MergeInput, fetchImpl: Fetch = fetch): Promise<MergeResult> {
  if (input.mode === 'now') {
    const res = await fetchImpl(`${API}/repos/${ref.owner}/${ref.name}/pulls/${ref.number}/merge`, {
      method: 'PUT',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      // No title or message: GitHub's defaults, as its own button uses.
      body: JSON.stringify({ merge_method: input.method.toLowerCase(), sha: input.sha }),
    });
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      const reason = githubReason(body);
      throw new GithubApiError(reason ? `GitHub refused the merge: ${reason}` : `GitHub refused the merge (HTTP ${res.status})`, res.status);
    }
    const b = (body ?? {}) as Raw;
    return { merged: b.merged === true, sha: typeof b.sha === 'string' ? b.sha : null, autoMerge: false, message: typeof b.message === 'string' ? b.message : null };
  }
  // The mutations take the PR's node id; read it here rather than trust one from the browser.
  const idData = await graphqlWrite(token, PR_ID, { owner: ref.owner, name: ref.name, number: ref.number }, fetchImpl);
  const id = idData.repository?.pullRequest?.id;
  if (typeof id !== 'string') throw new GithubApiError('GitHub has no such pull request, or your token cannot see it', 404);
  const data = input.mode === 'auto'
    ? await graphqlWrite(token, ENABLE_AUTO, { id, method: input.method }, fetchImpl)
    : await graphqlWrite(token, DISABLE_AUTO, { id }, fetchImpl);
  const pr = (data.enablePullRequestAutoMerge ?? data.disablePullRequestAutoMerge)?.pullRequest;
  return { merged: false, sha: null, autoMerge: !!pr?.autoMergeRequest, message: null };
}

// ── Re-run failed checks ─────────────────────────────────────────────────────

const SUITES = `query Suites($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ...Suites } }
}
${SUITES_FRAGMENT}`;

export interface RerunResult {
  rerun: { runId: number; workflow: string }[];
  /** Runs GitHub refused to restart (still running, no permission), with its reason. */
  refused: { runId: number; workflow: string; error: string }[];
  /** Failed checks from apps other than Actions, which only their app (or GitHub's UI) can restart. */
  other: string[];
}

/**
 * Re-runs the failed jobs of every failed Actions run on the PR's head commit,
 * read here rather than taken from the browser. One run GitHub refuses does
 * not stop the others; only "nothing could be re-run" is an error.
 */
export async function rerunFailedChecks(token: string, ref: PrRef, fetchImpl: Fetch = fetch): Promise<RerunResult> {
  const data = await graphqlRead(token, SUITES, { owner: ref.owner, name: ref.name, number: ref.number }, fetchImpl);
  const pr = data.repository?.pullRequest;
  if (!pr) throw new GithubApiError('GitHub has no such pull request, or your token cannot see it', 404);
  const { runs, other } = parseFailedSuites(pr);
  const result: RerunResult = { rerun: [], refused: [], other };
  await Promise.all(runs.map(async run => {
    const res = await fetchImpl(`${API}/repos/${ref.owner}/${ref.name}/actions/runs/${run.runId}/rerun-failed-jobs`, {
      method: 'POST',
      headers: headers(token),
    });
    if (res.ok) { result.rerun.push(run); return; }
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    result.refused.push({ ...run, error: githubReason(body) ?? `HTTP ${res.status}` });
  }));
  if (runs.length === 0 && other.length === 0) throw new GithubApiError('No failed checks on the latest commit', 422);
  if (result.rerun.length === 0 && result.refused.length > 0) {
    throw new GithubApiError(`GitHub refused to re-run: ${result.refused.map(r => `${r.workflow}: ${r.error}`).join('; ')}`, 422);
  }
  return result;
}

// ── Reviewers and comments ───────────────────────────────────────────────────

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TEAM = /^[A-Za-z0-9][\w.-]{0,99}$/;
// GitHub's own cap on one request.
const MAX_REVIEWERS = 15;

export interface ReviewersInput { users: string[]; teams: string[] }

export function parseReviewersInput(raw: unknown): ReviewersInput {
  const r = (raw ?? {}) as Raw;
  const list = (v: unknown, re: RegExp, what: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new PrInputError(`${what} must be a list`);
    const out = [...new Set(v.map(x => typeof x === 'string' ? x.trim().replace(/^@/, '') : x))];
    for (const x of out) if (typeof x !== 'string' || !re.test(x)) throw new PrInputError(`Not a GitHub ${what.slice(0, -1)}: ${String(x)}`);
    return out as string[];
  };
  const users = list(r.users, LOGIN, 'users');
  // A team is its slug; "org/slug" as typed in GitHub's box is accepted for the PR's own org.
  const teams = list(Array.isArray(r.teams) ? r.teams.map((t: unknown) => typeof t === 'string' ? t.replace(/^@?[^/]+\//, '') : t) : r.teams, TEAM, 'teams');
  if (users.length + teams.length === 0) throw new PrInputError('Pick at least one reviewer');
  if (users.length + teams.length > MAX_REVIEWERS) throw new PrInputError(`At most ${MAX_REVIEWERS} reviewers at once`);
  return { users, teams };
}

export const MAX_COMMENT = 65_536;

export function parseCommentInput(raw: unknown): { body: string } {
  const body = typeof (raw as Raw)?.body === 'string' ? (raw as Raw).body.trim() : '';
  if (!body) throw new PrInputError('The comment is empty');
  if (body.length > MAX_COMMENT) throw new PrInputError('The comment is too long for GitHub');
  return { body };
}

async function restWrite(token: string, url: string, payload: unknown, what: string, fetchImpl: Fetch, method: 'POST' | 'PATCH' = 'POST'): Promise<Raw> {
  const res = await fetchImpl(url, {
    method,
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const reason = githubReason(body);
    throw new GithubApiError(reason ? `GitHub refused the ${what}: ${reason}` : `GitHub refused the ${what} (HTTP ${res.status})`, res.status);
  }
  return (body ?? {}) as Raw;
}

/** Asks (or asks again) for these reviews; GitHub notifies each. Answers who is now requested. */
export async function requestReviewers(token: string, ref: PrRef, input: ReviewersInput, fetchImpl: Fetch = fetch): Promise<{ users: string[]; teams: string[] }> {
  const b = await restWrite(token, `${API}/repos/${ref.owner}/${ref.name}/pulls/${ref.number}/requested_reviewers`,
    { reviewers: input.users, team_reviewers: input.teams }, 'review request', fetchImpl);
  const logins = (v: unknown, key: string) => (Array.isArray(v) ? v : []).map((x: Raw) => x?.[key]).filter((x: unknown): x is string => typeof x === 'string');
  return { users: logins(b.requested_reviewers, 'login'), teams: logins(b.requested_teams, 'slug') };
}

export async function postComment(token: string, ref: PrRef, body: string, fetchImpl: Fetch = fetch): Promise<{ url: string | null; id: string | null }> {
  const b = await restWrite(token, `${API}/repos/${ref.owner}/${ref.name}/issues/${ref.number}/comments`, { body }, 'comment', fetchImpl);
  return {
    url: typeof b.html_url === 'string' ? b.html_url : null,
    // The REST id, which editComment takes (a number; kept as text, as PreviewShare.prCommentId).
    id: typeof b.id === 'number' || typeof b.id === 'string' ? String(b.id) : null,
  };
}

/** Rewrites a comment postComment made, by its REST id (a preview share's, when the share ends). */
export async function editComment(token: string, ref: PrRef, commentId: string, body: string, fetchImpl: Fetch = fetch): Promise<void> {
  if (!/^\d{1,20}$/.test(commentId)) throw new PrInputError('Not a comment id');
  await restWrite(token, `${API}/repos/${ref.owner}/${ref.name}/issues/comments/${commentId}`, { body }, 'comment edit', fetchImpl, 'PATCH');
}

// ── What a preview link share checks on a PR (services/previewShareLinks.ts) ─

export interface PrFacts {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  /** The base repository, `owner/name` as GitHub spells it. */
  repo: string;
  /** PRIVATE | INTERNAL | PUBLIC. */
  visibility: string;
  headBranch: string;
  headOid: string;
  /** Whether the head branch lives in another repository (a fork). */
  crossRepo: boolean;
  author: { login: string | null; id: number | null };
  /** Who the token belongs to, read now (a rename since it was stored doesn't matter). */
  viewer: { login: string; id: number };
}

const PR_FACTS = `query PrFacts($owner: String!, $name: String!, $number: Int!) {
  viewer { login databaseId }
  repository(owner: $owner, name: $name) {
    nameWithOwner visibility
    pullRequest(number: $number) {
      state isDraft headRefName headRefOid isCrossRepository
      author { login ... on User { databaseId } }
    }
  }
}`;

/** The facts a preview link share rests on, read with the owner's token. */
export async function fetchPrFacts(token: string, ref: PrRef, fetchImpl: Fetch = fetch): Promise<PrFacts> {
  const data = await graphqlRead(token, PR_FACTS, { owner: ref.owner, name: ref.name, number: ref.number }, fetchImpl);
  const repo = data.repository;
  const pr = repo?.pullRequest;
  if (!repo || !pr || typeof pr.headRefName !== 'string' || typeof pr.headRefOid !== 'string') throw new GithubApiError('GitHub has no such pull request', 404);
  if (typeof data.viewer?.login !== 'string' || typeof data.viewer?.databaseId !== 'number') throw new GithubApiError('GitHub did not say whose token this is', 502);
  return {
    state: pr.state,
    isDraft: pr.isDraft === true,
    repo: String(repo.nameWithOwner),
    visibility: String(repo.visibility ?? ''),
    headBranch: pr.headRefName,
    headOid: pr.headRefOid,
    crossRepo: pr.isCrossRepository === true,
    author: { login: typeof pr.author?.login === 'string' ? pr.author.login : null, id: typeof pr.author?.databaseId === 'number' ? pr.author.databaseId : null },
    viewer: { login: data.viewer.login, id: data.viewer.databaseId },
  };
}

// ── A PR's head, for a new workstream on it (routes/prs.ts) ──────────────────

export interface PrHead {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  /** The PR's branch, as its head repository names it. */
  branch: string;
  /** Whether the head branch lives in the PR's own repository (false for a fork). */
  sameRepo: boolean;
  /** The PR's head commit: the box checks that origin's pull/<n>/head is this one. */
  headOid: string;
}

const PR_HEAD = `query PrHead($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    state headRefName headRefOid isCrossRepository
  } }
}`;

export async function fetchPrHead(token: string, ref: PrRef, fetchImpl: Fetch = fetch): Promise<PrHead> {
  const data = await graphqlRead(token, PR_HEAD, { owner: ref.owner, name: ref.name, number: ref.number }, fetchImpl);
  const pr = data.repository?.pullRequest;
  if (!pr || typeof pr.headRefName !== 'string' || typeof pr.headRefOid !== 'string') throw new GithubApiError('GitHub has no such pull request', 404);
  return { state: pr.state, branch: pr.headRefName, sameRepo: pr.isCrossRepository !== true, headOid: pr.headRefOid };
}

// ── What decides an automatic preview share (services/previewShareLinks.ts, 4c) ─

export interface PrScope {
  labels: string[];
  /** Changed paths, as many as were read (MAX_SCOPE_FILES at most). */
  paths: string[];
  /** Whether `paths` is every changed path. */
  complete: boolean;
}

const MAX_SCOPE_FILES = 300;
const SCOPE_PAGE = 100;

async function restRead(token: string, url: string, fetchImpl: Fetch): Promise<unknown> {
  const res = await fetchImpl(url, { headers: headers(token) });
  if (!res.ok) throw new GithubApiError(`GitHub read failed (HTTP ${res.status})`, res.status);
  return res.json();
}

/**
 * A PR's labels and changed paths, paged up to MAX_SCOPE_FILES files. REST,
 * not GraphQL: only REST names a renamed file's old path
 * (`previous_filename`), and a PR that moves a file out from under the
 * filter changed that path too. A file list GitHub doesn't give (a diff too
 * large, a page that isn't a list) counts as incomplete, never as empty.
 */
export async function fetchPrScope(token: string, ref: PrRef, fetchImpl: Fetch = fetch): Promise<PrScope> {
  const base = `${API}/repos/${ref.owner}/${ref.name}/pulls/${ref.number}`;
  const pr = await restRead(token, base, fetchImpl) as Raw;
  const labels = (Array.isArray(pr?.labels) ? pr.labels : []).map((l: Raw) => l?.name).filter((n: unknown): n is string => typeof n === 'string');
  const paths: string[] = [];
  const changed = typeof pr?.changed_files === 'number' ? pr.changed_files : null;
  // Files read, not paths: a rename adds its old path beside the new one.
  let read = 0;
  for (let page = 1; read < MAX_SCOPE_FILES; page++) {
    let files: unknown;
    try { files = await restRead(token, `${base}/files?per_page=${SCOPE_PAGE}&page=${page}`, fetchImpl); } catch (err) {
      if (err instanceof GithubApiError && (err.status === 401 || err.status === 404)) throw err;
      return { labels, paths, complete: false };
    }
    if (!Array.isArray(files)) return { labels, paths, complete: false };
    for (const f of files as Raw[]) {
      if (typeof f?.filename === 'string') paths.push(f.filename);
      if (typeof f?.previous_filename === 'string') paths.push(f.previous_filename);
    }
    read += files.length;
    // Every file the PR says it changed is read: complete, whatever the page's size.
    if (changed !== null && read >= changed) return { labels, paths, complete: true };
    // A short page is the last; without a count to check it against, it is taken as the end.
    if (files.length < SCOPE_PAGE) return { labels, paths, complete: changed === null };
  }
  return { labels, paths, complete: changed !== null && read >= changed };
}
