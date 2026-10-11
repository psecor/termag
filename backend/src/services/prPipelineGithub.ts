/**
 * The PR pipeline's GitHub reads, made with the user's
 * stored `gh` token (githubCredential.ts). The token goes into the
 * Authorization header and nowhere else: errors carry the HTTP status, never
 * the request.
 *
 *   - one GraphQL request with three searches: open PRs I authored, open PRs
 *     that ask for my (or my team's) review, and my merges from the last 14
 *     days, across the ORGS below;
 *   - REST `compare/{base}...{head}` to tell whether a merge commit is in a
 *     running commit. Answers are cached for the life of the process: two
 *     commit SHAs always compare the same way.
 */

import { repoOrgs } from './githubRepos';
import { GithubApiError } from './githubCredential';
import type { CheckState, MergedPr, OpenPr } from './prPipeline';

type Fetch = typeof fetch;
const API = 'https://api.github.com';

// The orgs the PR searches are limited to: GITHUB_REPO_ORGS, the same list the
// repository picker reads. Empty searches the user's pull requests everywhere.
export const ORGS: readonly string[] = repoOrgs();
export const MERGED_WINDOW_DAYS = 14;
const PAGE = 50;

function headers(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'termag',
    Authorization: `Bearer ${token}`,
  };
}

// ── Searches ─────────────────────────────────────────────────────────────────

// Three requests rather than one: GitHub resolves the searches of one query
// in turn, and `mergeable` / `mergeStateStatus` are computed on demand, so
// together they took ~7 s where the slowest alone takes ~3.5 s. Same points.
const SEARCHES = {
  authored: `query Authored($q: String!) {
  viewer { login }
  search(query: $q, type: ISSUE, first: ${PAGE}) { issueCount nodes { ...Open } }
}`,
  review: `query Review($q: String!) {
  search(query: $q, type: ISSUE, first: ${PAGE}) { issueCount nodes { ...Open ...Requested } }
}`,
  merged: `query Merged($q: String!) {
  search(query: $q, type: ISSUE, first: ${PAGE}) { issueCount nodes { ...Merged } }
}`,
};
const FRAGMENTS: Record<'Open' | 'Requested' | 'Merged', string> = {
  Open: `
fragment Open on PullRequest {
  number title url isDraft updatedAt headRefName baseRefName
  reviewDecision mergeable mergeStateStatus
  author { login }
  repository { nameWithOwner }
  autoMergeRequest { enabledAt }
  reviewRequests(first: 20) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
  }
  commits(last: 1) {
    nodes { commit { statusCheckRollup {
      state
      contexts(first: 50) { nodes {
        __typename
        ... on CheckRun { name status conclusion }
        ... on StatusContext { context state }
      } }
    } } }
  }
}`,
  Requested: `
fragment Requested on PullRequest {
  timelineItems(last: 20, itemTypes: [REVIEW_REQUESTED_EVENT]) { nodes { ... on ReviewRequestedEvent {
    createdAt
    requestedReviewer { __typename ... on User { login } ... on Team { slug } }
  } } }
}`,
  Merged: `
fragment Merged on PullRequest {
  number title url headRefName baseRefName mergedAt
  author { login }
  mergedBy { login }
  repository { nameWithOwner }
  mergeCommit { oid }
  files(first: 100) { pageInfo { hasNextPage } nodes { path } }
}`,
};
// GraphQL refuses a document that defines a fragment it does not use.
const USES: Record<keyof typeof SEARCHES, (keyof typeof FRAGMENTS)[]> = {
  authored: ['Open'],
  review: ['Open', 'Requested'],
  merged: ['Merged'],
};

/** The three search strings. `review-requested:` includes requests to the user's teams. */
export function searchQueries(now: Date): { authored: string; review: string; merged: string } {
  const orgs = ORGS.map(o => `org:${o}`).join(' ');
  const since = new Date(now.getTime() - MERGED_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  return {
    authored: `is:pr is:open author:@me archived:false ${orgs}`,
    review: `is:pr is:open review-requested:@me -author:@me archived:false ${orgs}`,
    merged: `is:pr is:merged author:@me merged:>=${since} ${orgs}`,
  };
}

export interface PrSearchResult {
  viewer: string;
  authored: OpenPr[];
  reviewRequested: OpenPr[];
  merged: MergedPr[];
  /** Searches GitHub matched more PRs for than one page holds, with the totals. */
  truncated: { search: 'authored' | 'review' | 'merged'; total: number; shown: number }[];
}

async function graphql(token: string, query: string, variables: Record<string, string>, fetchImpl: Fetch): Promise<Raw> {
  const res = await fetchImpl(`${API}/graphql`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new GithubApiError(`GitHub search failed (HTTP ${res.status})`, res.status);
  const body = await res.json() as { data?: Raw; errors?: { message?: string }[] };
  // GraphQL answers 200 with `errors` for a query it partly could not run (an
  // org that blocks the token's SAML session, say); keep whatever came back.
  if (!body.data) {
    const why = body.errors?.map(e => e.message).filter(Boolean).join('; ') || 'no data';
    throw new GithubApiError(`GitHub search failed: ${why}`, 502);
  }
  return body.data;
}

export async function searchPrs(token: string, now: Date, fetchImpl: Fetch = fetch): Promise<PrSearchResult> {
  const q = searchQueries(now);
  const run = (k: keyof typeof SEARCHES) => graphql(token, [SEARCHES[k], ...USES[k].map(f => FRAGMENTS[f])].join('\n'), { q: q[k] }, fetchImpl);
  const [authored, review, merged] = await Promise.all([run('authored'), run('review'), run('merged')]);
  return parseSearch({ viewer: authored.viewer, authored: authored.search, review: review.search, merged: merged.search });
}

// ── Parsing ──────────────────────────────────────────────────────────────────

// GitHub GraphQL nodes, read defensively field by field.
type Raw = Record<string, any>;

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function checkState(node: Raw): CheckState | null {
  if (node?.__typename === 'CheckRun') {
    const name = str(node.name);
    if (!name) return null;
    if (node.status !== 'COMPLETED') return { name, state: 'pending' };
    return { name, state: FAILED_CONCLUSIONS.has(node.conclusion) ? 'failed' : 'passed' };
  }
  if (node?.__typename === 'StatusContext') {
    const name = str(node.context);
    if (!name) return null;
    if (node.state === 'PENDING' || node.state === 'EXPECTED') return { name, state: 'pending' };
    return { name, state: node.state === 'FAILURE' || node.state === 'ERROR' ? 'failed' : 'passed' };
  }
  return null;
}

/** Search nodes that are not pull requests (an empty `{}` for an issue) are dropped. */
function isPr(node: Raw): boolean {
  return typeof node?.number === 'number' && typeof node?.repository?.nameWithOwner === 'string';
}

/**
 * When the viewer's review was asked for: the latest request naming the
 * viewer, else the latest naming a team (the search matched through one of
 * the viewer's teams). A later request to somebody else does not reset it.
 */
function requestedAtFor(node: Raw, viewer: string): string | null {
  const events = ((node.timelineItems?.nodes ?? []) as Raw[]).filter(e => str(e?.createdAt));
  const latest = (pick: (r: Raw) => boolean) => [...events].reverse().find(e => e?.requestedReviewer && pick(e.requestedReviewer))?.createdAt ?? null;
  return latest(r => r.__typename === 'User' && typeof r.login === 'string' && r.login.toLowerCase() === viewer.toLowerCase())
    ?? latest(r => r.__typename === 'Team');
}

export function parseOpenPr(node: Raw, viewer?: string): OpenPr | null {
  if (!isPr(node)) return null;
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
  const checks = ((rollup?.contexts?.nodes ?? []) as Raw[]).map(checkState).filter((c): c is CheckState => c !== null);
  const requestedReviewers = ((node.reviewRequests?.nodes ?? []) as Raw[])
    .map(n => n?.requestedReviewer)
    .map(r => r?.__typename === 'Team' ? str(r.slug) : str(r?.login))
    .filter((r): r is string => r !== null);
  return {
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: str(node.title) ?? '',
    url: str(node.url) ?? '',
    author: str(node.author?.login),
    isDraft: node.isDraft === true,
    headRefName: str(node.headRefName) ?? '',
    baseRefName: str(node.baseRefName) ?? '',
    updatedAt: str(node.updatedAt) ?? '',
    reviewDecision: str(node.reviewDecision),
    mergeable: str(node.mergeable) ?? 'UNKNOWN',
    mergeStateStatus: str(node.mergeStateStatus) ?? 'UNKNOWN',
    autoMerge: !!node.autoMergeRequest,
    checkRollup: str(rollup?.state),
    checks,
    requestedReviewers,
    requestedAt: viewer === undefined ? null : requestedAtFor(node, viewer),
  };
}

export function parseMergedPr(node: Raw): MergedPr | null {
  if (!isPr(node) || !str(node.mergedAt)) return null;
  return {
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: str(node.title) ?? '',
    url: str(node.url) ?? '',
    author: str(node.author?.login),
    headRefName: str(node.headRefName) ?? '',
    baseRefName: str(node.baseRefName) ?? '',
    mergedAt: node.mergedAt,
    mergedBy: str(node.mergedBy?.login),
    mergeCommit: str(node.mergeCommit?.oid),
    files: ((node.files?.nodes ?? []) as Raw[]).map(f => str(f?.path)).filter((p): p is string => p !== null),
    // No files block at all is as unknown as a truncated one.
    filesTruncated: node.files?.pageInfo?.hasNextPage !== false,
  };
}

export function parseSearch(data: Raw): PrSearchResult {
  const nodes = (k: string): Raw[] => (data[k]?.nodes ?? []) as Raw[];
  const viewer = str(data.viewer?.login) ?? '';
  const truncated: PrSearchResult['truncated'] = [];
  for (const search of ['authored', 'review', 'merged'] as const) {
    const total = data[search]?.issueCount;
    const shown = nodes(search).length;
    if (typeof total === 'number' && total > shown) truncated.push({ search, total, shown });
  }
  return {
    viewer,
    authored: nodes('authored').map(n => parseOpenPr(n)).filter((p): p is OpenPr => p !== null),
    reviewRequested: nodes('review').map(n => parseOpenPr(n, viewer)).filter((p): p is OpenPr => p !== null),
    merged: nodes('merged').map(parseMergedPr).filter((p): p is MergedPr => p !== null),
    truncated,
  };
}

// ── Merged heads ─────────────────────────────────────────────────────────────

const MAX_HEADS = 50;
export const headKey = (repo: string, branch: string) => `${repo.toLowerCase()}:${branch}`;

/**
 * Which of these (repo, branch) pairs already had a PR by the viewer merged
 * from them, at any time. A squash merge leaves the branch "ahead of base" for good, so
 * without this every finished workstream older than the merged search's
 * window would come back as "Needs a PR". One GraphQL request, the names as
 * variables; null when GitHub could not answer, so callers can keep the rows.
 */
export async function mergedHeads(
  token: string, viewer: string, heads: { repo: string; branch: string }[], fetchImpl: Fetch = fetch,
): Promise<Set<string> | null> {
  const list = heads.filter(h => /^[\w.-]+\/[\w.-]+$/.test(h.repo)).slice(0, MAX_HEADS);
  if (list.length === 0) return new Set();
  const decls: string[] = [];
  const fields: string[] = [];
  const variables: Record<string, string> = {};
  list.forEach((h, i) => {
    const [owner, name] = h.repo.split('/');
    decls.push(`$o${i}: String!, $n${i}: String!, $h${i}: String!`);
    fields.push(`h${i}: repository(owner: $o${i}, name: $n${i}) { pullRequests(headRefName: $h${i}, states: MERGED, first: 10) { nodes { author { login } } } }`);
    Object.assign(variables, { [`o${i}`]: owner, [`n${i}`]: name, [`h${i}`]: h.branch });
  });
  const query = `query MergedHeads(${decls.join(', ')}) {\n${fields.join('\n')}\n}`;
  try {
    const res = await fetchImpl(`${API}/graphql`, {
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) return null;
    const body = await res.json() as { data?: Raw };
    if (!body.data) return null;
    const out = new Set<string>();
    list.forEach((h, i) => {
      // Only the viewer's own merges: a colleague's `feat-x` merged last year
      // says nothing about my live `feat-x`.
      const authors = ((body.data![`h${i}`]?.pullRequests?.nodes ?? []) as Raw[]).map(n => str(n?.author?.login)?.toLowerCase());
      if (authors.includes(viewer.toLowerCase())) out.add(headKey(h.repo, h.branch));
    });
    return out;
  } catch {
    return null;
  }
}

// ── Containment ──────────────────────────────────────────────────────────────

const SHA = /^[0-9a-f]{7,40}$/i;
const contained = new Map<string, boolean>();

/**
 * Is `commit` an ancestor of (or equal to) `running`, in `repo`? null when
 * GitHub cannot say: a SHA it does not have (a public-mirror commit, a local
 * hot-patch), or an error. Only definite answers are cached.
 */
export async function commitContains(
  token: string, repo: string, running: string, commit: string, fetchImpl: Fetch = fetch,
): Promise<boolean | null> {
  if (!SHA.test(running) || !SHA.test(commit)) return null;
  if (running === commit) return true;
  const key = `${repo}:${running}...${commit}`;
  const hit = contained.get(key);
  if (hit !== undefined) return hit;
  try {
    // per_page=1 keeps the answer small: only `status` is read.
    const res = await fetchImpl(`${API}/repos/${repo}/compare/${running}...${commit}?per_page=1`, { headers: headers(token) });
    if (!res.ok) return null;
    const body = await res.json() as { status?: unknown };
    // Relative to `running`, `commit` is behind (an ancestor) or identical when it is in it.
    const answer = body.status === 'behind' || body.status === 'identical' ? true
      : body.status === 'ahead' || body.status === 'diverged' ? false
      : null;
    if (answer !== null) contained.set(key, answer);
    return answer;
  } catch {
    return null;
  }
}

/** Test seam. */
export function _resetContainmentCache(): void {
  contained.clear();
}
