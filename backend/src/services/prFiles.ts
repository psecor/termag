// A PR's diff and its review threads, for the simple UI's Files changed tab:
// each file's patch (REST pulls/{n}/files, the
// only API that gives the patch text) and every review thread with its line,
// whether it is resolved or outdated, and its comments (GraphQL
// reviewThreads). Reads with the user's own token, as the overview does.
import { GithubApiError } from './githubCredential';
import { headers } from './prPipelineGithub';
import type { PrRef } from './prReview';

type Fetch = typeof fetch;
type Raw = Record<string, any>;
const API = 'https://api.github.com';

export interface PrFilePatch {
  path: string;
  /** The path before a rename, else null. */
  previousPath: string | null;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  /** The unified diff's hunks; null when GitHub gives none (binary, too large) or the total cap is reached. */
  patch: string | null;
  /** Set when GitHub gave a patch that termag left out, past its total cap (not GitHub's omission). */
  capped?: boolean;
}

export interface PrFiles {
  files: PrFilePatch[];
  /** More files than were read, or patches left out to stay under the cap. */
  truncated: boolean;
}

export const MAX_FILES = 300;
const PAGE = 100;
/** Patch text kept in one answer: a big PR's diff is for GitHub's own view. */
export const MAX_PATCH_BYTES = 1_000_000;
const STATUSES = new Set(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']);

async function restRead(token: string, url: string, fetchImpl: Fetch): Promise<unknown> {
  const res = await fetchImpl(url, { headers: headers(token) });
  if (!res.ok) throw new GithubApiError(`GitHub read failed (HTTP ${res.status})`, res.status);
  return res.json();
}

/** One page of GitHub's file list as PrFilePatch, skipping what isn't a file. */
export function parseFilesPage(raw: unknown): PrFilePatch[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f: Raw) => {
    if (!f || typeof f.filename !== 'string') return [];
    const status = STATUSES.has(f.status) ? f.status : 'modified';
    return [{
      path: f.filename,
      previousPath: typeof f.previous_filename === 'string' ? f.previous_filename : null,
      status,
      additions: Number.isInteger(f.additions) ? f.additions : 0,
      deletions: Number.isInteger(f.deletions) ? f.deletions : 0,
      patch: typeof f.patch === 'string' ? f.patch : null,
    } as PrFilePatch];
  });
}

export async function fetchPrFiles(token: string, ref: PrRef, fetchImpl: Fetch = fetch): Promise<PrFiles> {
  const base = `${API}/repos/${ref.owner}/${ref.name}/pulls/${ref.number}/files`;
  const files: PrFilePatch[] = [];
  let truncated = false;
  for (let page = 1; files.length < MAX_FILES; page++) {
    const got = parseFilesPage(await restRead(token, `${base}?per_page=${PAGE}&page=${page}`, fetchImpl));
    files.push(...got);
    if (got.length < PAGE) break;
  }
  if (files.length >= MAX_FILES) truncated = true;
  const capped = capPatches(files.slice(0, MAX_FILES));
  return { files: capped.files, truncated: truncated || capped.truncated };
}

/**
 * Patches kept while they fit in `max` bytes, in order: one that doesn't fit is left out (patch null), and a
 * later one that still fits is kept. Pure, for the tests.
 */
export function capPatches(files: PrFilePatch[], max = MAX_PATCH_BYTES): PrFiles {
  let bytes = 0;
  let truncated = false;
  const out = files.map(f => {
    if (!f.patch) return f;
    if (bytes + f.patch.length > max) { truncated = true; return { ...f, patch: null, capped: true }; }
    bytes += f.patch.length;
    return f;
  });
  return { files: out, truncated };
}

export interface PrThreadComment { id: string; author: string | null; bot: boolean; body: string; createdAt: string | null; url: string | null }
export interface PrThread {
  id: string;
  path: string;
  /** The line on the PR's head (RIGHT) or base (LEFT); null for an outdated thread GitHub can't place. */
  line: number | null;
  side: 'LEFT' | 'RIGHT';
  resolved: boolean;
  outdated: boolean;
  /** The first comments, oldest first: the opener, then its replies. */
  comments: PrThreadComment[];
  /** How many comments GitHub has: more than `comments` on a very long thread. */
  total: number;
}

/** Threads past this many pages of 100 aren't read: a thousand is far past any PR termag reviews. */
const MAX_THREAD_PAGES = 10;
const THREADS = `query ReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine diffSide
          comments(first: 100) { totalCount nodes { id body createdAt url author { login __typename } } }
        }
      }
    }
  }
}`;

export function parseThreads(data: Raw | null | undefined): PrThread[] {
  const nodes = data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((t: Raw) => {
    if (!t || typeof t.id !== 'string' || typeof t.path !== 'string') return [];
    const comments = (Array.isArray(t.comments?.nodes) ? t.comments.nodes : []).flatMap((c: Raw) => (c && typeof c.body === 'string' ? [{
      id: String(c.id ?? ''),
      author: typeof c.author?.login === 'string' ? c.author.login : null,
      bot: c.author?.__typename === 'Bot',
      body: c.body,
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : null,
      url: typeof c.url === 'string' ? c.url : null,
    }] : []));
    // Only the line GitHub places on the PR's head: an outdated thread's originalLine is a line of an older
    // blob, so it stays off the diff's lines and is listed under its file.
    const line = Number.isInteger(t.line) ? t.line : null;
    const total = Number.isInteger(t.comments?.totalCount) ? Math.max(t.comments.totalCount, comments.length) : comments.length;
    return [{ id: t.id, path: t.path, line, side: t.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT', resolved: t.isResolved === true, outdated: t.isOutdated === true, comments, total } as PrThread];
  });
}

/**
 * Every review thread, page by page (GitHub lists them oldest first, so a later round's are on the later pages).
 * A page that fails fails the read: the approval gates read these, and a part could hide one of your open threads.
 */
export async function fetchPrThreads(token: string, ref: PrRef, fetchImpl: Fetch = fetch): Promise<PrThread[]> {
  const out: PrThread[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const res = await fetchImpl(`${API}/graphql`, {
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: THREADS, variables: { owner: ref.owner, name: ref.name, number: ref.number, after } }),
    });
    if (!res.ok) throw new GithubApiError(`GitHub read failed (HTTP ${res.status})`, res.status);
    const body = await res.json() as { data?: Raw | null; errors?: { message?: string }[] };
    if (!body.data?.repository?.pullRequest) {
      const why = body.errors?.map(e => e.message).filter(Boolean).join('; ');
      throw new GithubApiError(why ? `GitHub could not read the review threads: ${why}` : 'GitHub has no such pull request, or your token cannot see it', 404);
    }
    // A page with errors, or without its threads, isn't the end of the list: the read fails rather than answer part.
    const threads = body.data.repository.pullRequest.reviewThreads;
    if (body.errors?.length || !threads || !Array.isArray(threads.nodes) || !threads.pageInfo) {
      const why = body.errors?.map(e => e.message).filter(Boolean).join('; ');
      throw new GithubApiError(`GitHub could not read the review threads${why ? `: ${why}` : ''}`, 502);
    }
    out.push(...parseThreads(body.data));
    if (threads.pageInfo.hasNextPage !== true) return out;
    if (typeof threads.pageInfo.endCursor !== 'string') throw new GithubApiError('GitHub gave no cursor for the next page of review threads', 502);
    after = threads.pageInfo.endCursor;
  }
  // More than termag reads: not all of them, so not an answer the gates can stand on.
  throw new GithubApiError(`This PR has more than ${MAX_THREAD_PAGES * 100} review threads, more than termag reads`, 502);
}
