/**
 * A repository's own environment: `.termag/environment.json` in the
 * repository, committed by its maintainers (docs/box-provisioning.md, "A
 * repository's environment"). Not a space's `.termag/` memory, which lives in
 * a termag space and has nothing to do with this file.
 *
 *   { "resources": { "vcpu": 4, "memoryGiB": 32, "diskGiB": 200 } }
 *
 * Only `resources` is read: a preset (small, medium, large) or minimums
 * (services/boxRequirements.ts), and in the object form a disk, `diskGiB`
 * (services/boxDiskSize.ts; on its own it leaves the size to the default),
 * for every box made for a project of the
 * repository, a box made for an ask included (asks do the same work people
 * do). A multi-repo project takes the largest of its repositories'
 * (boxSize.largestBoxSize). decideBoxSize (services/boxSize.ts) puts it
 * between a size asked for and the default. Every other key is reserved
 * (`install`, `start` and `ports` are planned, after Cursor's
 * `.cursor/environment.json`) and ignored without a word.
 *
 * Read from the repository's default branch at the commit a new project would
 * clone (its head now), with the owner's GitHub credential when they have
 * one, and without for a public repository when they have none. The file at a
 * commit never changes, so what was read is cached by commit; the head is
 * looked up each time, so a push to the file applies to the next box.
 *
 * Nothing here fails a box create. A file that isn't there is no setting; a
 * malformed file, a `resources` that isn't a size and a GitHub that doesn't
 * answer each leave it out with a warning, which the create response carries.
 */
import { BOX_SIZES, isBoxSize, largestBoxSize, repoKey, type RepoBoxSizes } from './boxSize';
import { parseRequirements } from './boxRequirements';
import { BOX_DISK_LIMITS, isDiskGiB, largestDiskGiB } from './boxDiskSize';
import { GITHUB_API } from './githubCredential';
import { readGithubAccess } from './credentialStore';

export const REPO_ENVIRONMENT_PATH = '.termag/environment.json';

/** The key read today; the file's other keys are reserved. */
const RESOURCES = 'resources';
/** The disk, in `resources`' object form beside `vcpu` and `memoryGiB`. */
const DISK = 'diskGiB';
/** Files at most this size are read. */
const MAX_BYTES = 16 * 1024;
const TIMEOUT_MS = 5_000;
const CACHE_ENTRIES = 500;

export interface RepoEnvironment {
  /** owner/name, lower case. */
  repo: string;
  /** The default branch's head the file was read at; null when GitHub couldn't say. */
  commit: string | null;
  /** What the file says; null when there is no file, or it couldn't be read. */
  sizes: RepoBoxSizes | null;
  /** Each setting left out, and why, for the create response. */
  warnings: string[];
}

/** An environment.json's text as the size its `resources` asks for: anything it can't use is left out with a warning, never thrown. */
export function parseRepoEnvironment(text: string, repo = 'the repository'): { sizes: RepoBoxSizes; warnings: string[] } {
  const where = `${repo}'s ${REPO_ENVIRONMENT_PATH}`;
  const sizes: RepoBoxSizes = { size: null };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { sizes, warnings: [`${where} is not valid JSON, so it was ignored`] };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { sizes, warnings: [`${where} is not a JSON object, so it was ignored`] };
  }
  const warnings: string[] = [];
  const value = (data as Record<string, unknown>)[RESOURCES];
  if (value === undefined) return { sizes, warnings };
  if (isBoxSize(value)) {
    sizes.size = value;
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    // The disk is read on its own: a bad one leaves the size alone, and a bad size the disk.
    const { [DISK]: disk, ...shape } = value as Record<string, unknown>;
    if (disk !== undefined) {
      if (isDiskGiB(disk)) sizes.diskGiB = disk;
      else warnings.push(`${where}: "${RESOURCES}" "${DISK}" is ${JSON.stringify(disk)}, not a whole number of GB from ${BOX_DISK_LIMITS.minGiB} to ${BOX_DISK_LIMITS.maxGiB}, so it was ignored`);
    }
    if (disk === undefined || Object.keys(shape).length) {
      const req = parseRequirements(shape);
      if (req.ok) sizes.size = req.requirements;
      else warnings.push(`${where}: "${RESOURCES}" ${req.why}, so it was ignored`);
    }
  } else {
    warnings.push(`${where}: "${RESOURCES}" is ${JSON.stringify(value)}, not one of ${BOX_SIZES.join(', ')} or { "vcpu", "memoryGiB" }, so it was ignored`);
  }
  return { sizes, warnings };
}

export interface RepoEnvironmentDeps {
  fetchImpl: typeof fetch;
  /** The owner's GitHub token, or null to read a public repository without one. */
  loadToken(userId: string): Promise<string | null>;
  apiBase?: string;
  cacheEntries?: number;
  timeoutMs?: number;
}

export interface RepoEnvironmentReader {
  /** null for a repository that isn't on GitHub. */
  read(userId: string, repo: string): Promise<RepoEnvironment | null>;
  /** What is cached, by `owner/name@commit`; for tests. */
  cachedKeys(): string[];
}

type Cached = { sizes: RepoBoxSizes | null; warnings: string[] };

export function createRepoEnvironmentReader(deps: RepoEnvironmentDeps): RepoEnvironmentReader {
  const apiBase = deps.apiBase ?? GITHUB_API;
  const limit = deps.cacheEntries ?? CACHE_ENTRIES;
  // Insertion order is age: a hit moves its entry to the end, the oldest goes first.
  const byCommit = new Map<string, Cached>();

  async function get(url: string, token: string | null, accept: string): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'termag' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await deps.fetchImpl(url, { headers, signal: ctrl.signal });
      const text = await res.text();
      return { status: res.status, text };
    } finally {
      clearTimeout(timer);
    }
  }

  async function read(userId: string, repo: string): Promise<RepoEnvironment | null> {
    const key = repoKey(repo);
    if (!key) return null;
    const unread = (why: string): RepoEnvironment => ({
      repo: key, commit: null, sizes: null,
      warnings: [`couldn't read ${key}'s ${REPO_ENVIRONMENT_PATH} (${why}), so it was left out`],
    });
    let token: string | null = null;
    try {
      token = await deps.loadToken(userId);
    } catch {
      token = null;
    }
    let commit: string;
    try {
      const head = await get(`${apiBase}/repos/${key}/commits/HEAD`, token, 'application/vnd.github.sha');
      // No such repository, or none this credential sees: no file to read, and nothing to warn about
      // that the clone won't say louder.
      if (head.status === 404 || head.status === 409) return { repo: key, commit: null, sizes: null, warnings: [] };
      if (head.status !== 200 || !/^[0-9a-f]{40}$/.test(head.text.trim())) return unread(`GitHub answered ${head.status} for its default branch`);
      commit = head.text.trim();
    } catch (err) {
      return unread(err instanceof Error && err.name === 'AbortError' ? 'GitHub did not answer in time' : 'GitHub could not be reached');
    }

    const cacheKey = `${key}@${commit}`;
    const hit = byCommit.get(cacheKey);
    if (hit) {
      byCommit.delete(cacheKey);
      byCommit.set(cacheKey, hit);
      return { repo: key, commit, sizes: hit.sizes, warnings: [...hit.warnings] };
    }

    let file: { status: number; text: string };
    try {
      file = await get(`${apiBase}/repos/${key}/contents/${REPO_ENVIRONMENT_PATH}?ref=${commit}`, token, 'application/vnd.github.raw');
    } catch (err) {
      return { ...unread(err instanceof Error && err.name === 'AbortError' ? 'GitHub did not answer in time' : 'GitHub could not be reached'), commit };
    }
    let found: Cached;
    if (file.status === 404) found = { sizes: null, warnings: [] };
    else if (file.status !== 200) return { ...unread(`GitHub answered ${file.status}`), commit };
    else if (Buffer.byteLength(file.text, 'utf8') > MAX_BYTES) found = { sizes: null, warnings: [`${key}'s ${REPO_ENVIRONMENT_PATH} is over ${MAX_BYTES / 1024} KiB, so it was ignored`] };
    else found = parseRepoEnvironment(file.text, key);

    byCommit.set(cacheKey, found);
    while (byCommit.size > limit) byCommit.delete(byCommit.keys().next().value as string);
    return { repo: key, commit, sizes: found.sizes, warnings: [...found.warnings] };
  }

  return { read, cachedKeys: () => [...byCommit.keys()] };
}

export const repoEnvironment: RepoEnvironmentReader = createRepoEnvironmentReader({
  fetchImpl: (...args) => fetch(...args),
  loadToken: async userId => (await readGithubAccess(userId))?.token ?? null,
});

/**
 * The size and disk a box made for `repos` takes from their environment.json
 * files: the largest of each across them (a multi-repo project's), with every repository's
 * warnings; nothing for no repository.
 */
export async function repoSizesFor(userId: string, repos: ReadonlyArray<string | null | undefined> | string | null | undefined): Promise<{ sizes: RepoBoxSizes | null; warnings: string[] }> {
  const list = (Array.isArray(repos) ? repos : [repos]).filter((r): r is string => !!r);
  if (!list.length) return { sizes: null, warnings: [] };
  const reads = (await Promise.all(list.map(r => repoEnvironment.read(userId, r)))).filter((r): r is RepoEnvironment => !!r);
  const size = largestBoxSize(reads.map(r => r.sizes?.size ?? null));
  const diskGiB = largestDiskGiB(reads.map(r => r.sizes?.diskGiB));
  return {
    sizes: reads.some(r => r.sizes) ? { size, ...(diskGiB != null ? { diskGiB } : {}) } : null,
    warnings: reads.flatMap(r => r.warnings),
  };
}
