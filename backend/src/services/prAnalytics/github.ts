/**
 * GitHub GraphQL reads for PR analytics, made with the
 * nominated admin's stored gh token. The token goes in the Authorization
 * header only; errors carry the HTTP status, never the request.
 */
import { GithubApiError } from '../githubCredential';
import { headers } from '../prPipelineGithub';
import type { Page, PrNode, RateLimit } from './sync';
import type { RepoInfo } from './groups';

type Fetch = typeof fetch;
const GRAPHQL = 'https://api.github.com/graphql';
/** PRs per page; with 10 commits × 3 authors each, a page costs about 4 points. */
export const PR_PAGE = 50;

const RATE = 'rateLimit { remaining limit resetAt }';

const PR_PAGE_QUERY = `query PrPage($owner: String!, $name: String!, $after: String) {
  ${RATE}
  repository(owner: $owner, name: $name) {
    visibility
    pullRequests(first: ${PR_PAGE}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id number state isDraft createdAt updatedAt mergedAt closedAt baseRefName additions deletions changedFiles body
        author { login __typename }
        commits(last: 10) { nodes { commit { messageBody authors(first: 3) { nodes { user { login } } } } } }
      }
    }
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

export async function fetchPrPage(token: string, repo: string, after: string | null, fetchImpl: Fetch = fetch): Promise<Page> {
  const [owner, name] = repo.split('/');
  const d = await graphql<{ repository: { visibility: string; pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: PrNode[] } } | null }>(
    token, PR_PAGE_QUERY, { owner, name, after }, fetchImpl);
  if (!d.repository) throw new GithubApiError(`repository ${repo} not found or not readable with this token`, 404);
  const prs = d.repository.pullRequests;
  return { visibility: d.repository.visibility.toLowerCase(), nodes: prs.nodes, hasNextPage: prs.pageInfo.hasNextPage, endCursor: prs.pageInfo.endCursor, rateLimit: d.rateLimit };
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
