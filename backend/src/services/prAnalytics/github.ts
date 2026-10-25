/**
 * GitHub GraphQL reads for PR analytics, made with the
 * nominated admin's stored gh token. The token goes in the Authorization
 * header only; errors carry the HTTP status, never the request.
 */
import { GithubApiError } from '../githubCredential';
import { headers } from '../prPipelineGithub';
import type { Page, PrNode, RateLimit, SearchNode, SearchPage } from './sync';
import type { RepoInfo } from './groups';
import { COMMENT_PAGE, REVIEW_PAGE } from './reviews';

type Fetch = typeof fetch;
const GRAPHQL = 'https://api.github.com/graphql';
/** PRs per page, at most; with 10 commits × 3 authors each, a page costs about 4 points. */
export const PR_PAGE = 50;
/**
 * Page sizes to fall back through when GitHub times out: a full page of busy
 * PRs, each with its reviews, comments and events, can take GitHub past its
 * limit (an HTML 504 from `api.github.com`, seen on termag 2026-10-23). Cursors are
 * positions, so a smaller page continues where the last one ended.
 */
const PAGE_SIZES = [PR_PAGE, 25, 10];

const RATE = 'rateLimit { remaining limit resetAt }';

// title and files serve path-scoped groups; reviews, comments and the ready
// events (ready, review requested) serve the review metrics. A page of 50 costs 8 points (6 without the last three).
const PR_FIELDS = `id number title state isDraft createdAt updatedAt mergedAt closedAt baseRefName additions deletions changedFiles body
        author { login __typename }
        files(first: 100) { nodes { path } }
        commits(last: 10) { nodes { commit { messageBody authors(first: 3) { nodes { user { login } } } } } }
        reviews(first: ${REVIEW_PAGE}) { totalCount nodes { id author { login __typename } state submittedAt body comments { totalCount } } }
        comments(last: ${COMMENT_PAGE}) { totalCount nodes { author { login __typename } } }
        timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT, REVIEW_REQUESTED_EVENT], last: 30) { nodes { __typename
          ... on ReadyForReviewEvent { createdAt }
          ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { slug } } } } }`;

const PR_PAGE_QUERY = `query PrPage($owner: String!, $name: String!, $after: String, $first: Int!) {
  ${RATE}
  repository(owner: $owner, name: $name) {
    visibility
    pullRequests(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${PR_FIELDS}
      }
    }
  }
}`;

const PR_SEARCH_QUERY = `query PrSearch($q: String!, $after: String, $first: Int!) {
  ${RATE}
  search(type: ISSUE, query: $q, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      ${PR_FIELDS}
      repository { nameWithOwner visibility }
    } }
  }
}`;

const ORG_REPOS_QUERY = `query OrgRepos($org: String!, $after: String) {
  ${RATE}
  organization(login: $org) {
    repositories(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { nameWithOwner visibility isArchived }
    }
  }
}`;

const TOPIC_QUERY = `query TopicRepos($q: String!, $after: String) {
  ${RATE}
  search(type: REPOSITORY, query: $q, first: 100, after: $after) {
    repositoryCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on Repository { nameWithOwner visibility isArchived } }
  }
}`;

async function graphql<T>(token: string, query: string, variables: Record<string, unknown>, fetchImpl: Fetch): Promise<T & { rateLimit: RateLimit }> {
  const res = await fetchImpl(GRAPHQL, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new GithubApiError(`GitHub GraphQL failed (HTTP ${res.status})`, res.status);
  const body = await res.json() as { data?: T & { rateLimit: RateLimit }; errors?: Array<{ message?: string; type?: string }> };
  if (!body.data) {
    const why = body.errors?.map(e => e.type ?? e.message).filter(Boolean).join('; ') || 'no data';
    throw new GithubApiError(`GitHub GraphQL failed: ${why}`, 502);
  }
  return body.data;
}

/**
 * A timeout, ours or GitHub's, is worth a smaller page: an HTTP 502/504, our
 * own 30 s abort, or a GraphQL error that says it timed out. Other GraphQL
 * errors (NOT_FOUND, FORBIDDEN, a bad query) fail the same at any size.
 */
const tooBig = (err: unknown) => {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return true;
  if (!(err instanceof GithubApiError) || isRateLimited(err)) return false;
  return /\(HTTP 50[24]\)/.test(err.message) || (err.status === 502 && /timeout|timed out/i.test(err.message));
};

async function shrinking<T>(run: (first: number) => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await run(PAGE_SIZES[i]); } catch (err) { if (!tooBig(err) || i === PAGE_SIZES.length - 1) throw err; }
  }
}

export async function fetchPrPage(token: string, repo: string, after: string | null, fetchImpl: Fetch = fetch): Promise<Page> {
  const [owner, name] = repo.split('/');
  const d = await shrinking(first => graphql<{ repository: { visibility: string; pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: PrNode[] } } | null }>(
    token, PR_PAGE_QUERY, { owner, name, after, first }, fetchImpl));
  if (!d.repository) throw new GithubApiError(`repository ${repo} not found or not readable with this token`, 404);
  const prs = d.repository.pullRequests;
  return { visibility: d.repository.visibility.toLowerCase(), nodes: prs.nodes, hasNextPage: prs.pageInfo.hasNextPage, endCursor: prs.pageInfo.endCursor, rateLimit: d.rateLimit };
}

/** One page of an owner's PRs updated since `since` (searchSync). */
export async function searchPrPage(token: string, owner: string, since: Date, after: string | null, fetchImpl: Fetch = fetch): Promise<SearchPage> {
  // Newest-updated first: a PR updated while a search is paged moves above
  // what was read, and is after the search's start, so the next pass has it.
  const q = `org:${owner} is:pr updated:>=${since.toISOString().replace(/\.\d{3}Z$/, 'Z')} sort:updated-desc`;
  const d = await shrinking(first => graphql<{ search: { issueCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<SearchNode | Record<string, never>> } }>(
    token, PR_SEARCH_QUERY, { q, after, first }, fetchImpl));
  const nodes = d.search.nodes.filter((n): n is SearchNode => typeof (n as SearchNode).id === 'string');
  return { issueCount: d.search.issueCount, nodes, hasNextPage: d.search.pageInfo.hasNextPage, endCursor: d.search.pageInfo.endCursor, rateLimit: d.rateLimit };
}

/** GitHub refused for the rate limit: wait for the reset rather than retry each repo. */
export function isRateLimited(err: unknown): boolean {
  if (!(err instanceof GithubApiError)) return false;
  return /RATE_LIMIT/.test(err.message) || err.status === 429 || (err.status === 403 && /rate limit/i.test(err.message));
}

const repoInfo = (n: { nameWithOwner: string; visibility: string; isArchived: boolean }): RepoInfo =>
  ({ repo: n.nameWithOwner.toLowerCase(), visibility: n.visibility.toLowerCase(), archived: n.isArchived });

export async function listOrgRepos(token: string, org: string, fetchImpl: Fetch = fetch): Promise<{ repos: RepoInfo[]; rateLimit: RateLimit | null }> {
  const repos: RepoInfo[] = []; let after: string | null = null; let rateLimit: RateLimit | null = null;
  for (let i = 0; i < 100; i++) {
    const d: { rateLimit: RateLimit; organization: { repositories: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ nameWithOwner: string; visibility: string; isArchived: boolean }> } } | null }
      = await graphql(token, ORG_REPOS_QUERY, { org, after }, fetchImpl);
    rateLimit = d.rateLimit;
    if (!d.organization) break;
    repos.push(...d.organization.repositories.nodes.map(repoInfo));
    if (!d.organization.repositories.pageInfo.hasNextPage) break;
    after = d.organization.repositories.pageInfo.endCursor;
  }
  return { repos, rateLimit };
}

export async function listTopicRepos(token: string, org: string, topic: string, fetchImpl: Fetch = fetch): Promise<{ repos: RepoInfo[]; rateLimit: RateLimit | null }> {
  const repos: RepoInfo[] = []; let after: string | null = null; let rateLimit: RateLimit | null = null;
  for (let i = 0; i < 10; i++) {
    const d: { rateLimit: RateLimit; search: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ nameWithOwner: string; visibility: string; isArchived: boolean }> } }
      = await graphql(token, TOPIC_QUERY, { q: `org:${org} topic:${topic} archived:false`, after }, fetchImpl);
    rateLimit = d.rateLimit;
    repos.push(...d.search.nodes.filter(n => n?.nameWithOwner).map(repoInfo));
    if (!d.search.pageInfo.hasNextPage) break;
    after = d.search.pageInfo.endCursor;
  }
  return { repos, rateLimit };
}
