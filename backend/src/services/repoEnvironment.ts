/**
 * A repository's own environment: `.termag/environment.json` in the
 * repository, committed by its maintainers (docs/box-provisioning.md, "A
 * repository's environment"). Not a space's `.termag/` memory, which lives in
 * a termag space and has nothing to do with this file.
 *
 *   { "resources": { "vcpu": 4, "memoryGiB": 32, "diskGiB": 200 } }
 *
 * `resources` is a preset (small, medium, large) or minimums
 * (services/boxRequirements.ts), and in the object form a disk, `diskGiB`
 * (services/boxDiskSize.ts; on its own it leaves the size to the default),
 * for every box made for a project of the
 * repository, a box made for an ask included (asks do the same work people
 * do). A multi-repo project takes the largest of its repositories'
 * (boxSize.largestBoxSize). decideBoxSize (services/boxSize.ts) puts it
 * between a size asked for and the default. `setupEnabled: false` turns
 * termag's setup off for the box: the CLI states it and
 * `--setup` overrides it, and nothing else applies it (repoSetupFor).
 * `flavor`, the box's image (#1086's flavors), isn't read from here yet: it is
 * ignored with a warning.
 * Every other key is reserved
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
import { MULTI_REPO_MAX, repoNameError, suggestRepoName } from './projectRepos';
import { isBranchName } from './repoCreate';
import { environmentSchemaErrors } from './environmentSchema';

export const REPO_ENVIRONMENT_PATH = '.termag/environment.json';

/** The keys read today; the file's other keys are reserved. */
const RESOURCES = 'resources';
const REPOS = 'repos';
const SETUP = 'setupEnabled';
/** The box's image; documented, not read yet (it is ignored with a warning). */
const FLAVOR = 'flavor';
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
  /** The file's text as read, only when read() was asked for it ({ withText: true }). */
  text?: string;
  sizes: RepoBoxSizes | null;
  /** The file's `repos` (an environment's); null when it has none, or none was read. */
  repos: EnvironmentRepo[] | null;
  /** The file's `setupEnabled`, when it has a usable one. */
  setupEnabled?: boolean;
  /** Set when the file could not be read (GitHub unreachable, slow or erroring): what it says is unknown, not absent. */
  unread?: true;
  /** Each setting left out, and why, for the create response. */
  warnings: string[];
  /** A `setupEnabled` left out, and why: apart, since only an empty-box-enabled caller reads it. */
  setupWarnings?: string[];
}

/** A repository an environment's definition lists (its `repos` key). */
export interface EnvironmentRepo {
  /** owner/name, lower case. */
  repo: string;
  /** The branch the checkout tracks; absent, the repository's default branch. */
  branch?: string;
  /** The checkout's directory in a multi-repo project; absent, the repository's name. */
  path?: string;
}

/** What an environment definition says: its size, its repositories (null: no `repos` key), and what of it was left out. */
export interface EnvironmentDefinition {
  sizes: RepoBoxSizes; repos: EnvironmentRepo[] | null; warnings: string[];
  /** Its `setupEnabled` when usable, and why one wasn't. */
  setupEnabled?: boolean; setupWarnings?: string[];
}

/** `repos`: each `{ repo, branch?, path? }` that can be used, in order, and a warning for each that can't. */
function parseRepos(value: unknown, where: string, warnings: string[]): EnvironmentRepo[] {
  if (!Array.isArray(value)) {
    warnings.push(`${where}: "${REPOS}" is not a list, so it was ignored`);
    return [];
  }
  const repos: EnvironmentRepo[] = [];
  const dirs = new Set<string>();
  for (const raw of value) {
    const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { repo: raw }) as Record<string, unknown>;
    const repo = typeof r.repo === 'string' ? repoKey(r.repo) : null;
    if (!repo) { warnings.push(`${where}: "${REPOS}": ${JSON.stringify(r.repo ?? null)} is not a GitHub repository (owner/name), so it was left out`); continue; }
    if (repos.some(x => x.repo === repo)) { warnings.push(`${where}: "${REPOS}": ${repo} is listed twice; the second was left out`); continue; }
    if (repos.length >= MULTI_REPO_MAX) { warnings.push(`${where}: "${REPOS}": at most ${MULTI_REPO_MAX} repositories, so ${repo} was left out`); continue; }
    const entry: EnvironmentRepo = { repo };
    if (r.branch != null && r.branch !== '') {
      if (typeof r.branch !== 'string' || !isBranchName(r.branch.trim())) { warnings.push(`${where}: "${REPOS}": ${repo}'s branch ${JSON.stringify(r.branch)} is not a branch name, so it was left out`); continue; }
      entry.branch = r.branch.trim();
    }
    if (r.path != null && r.path !== '') {
      const bad = typeof r.path === 'string' ? repoNameError(r.path.trim()) : 'a checkout path is text';
      if (bad) { warnings.push(`${where}: "${REPOS}": ${repo}'s path: ${bad}, so it was left out`); continue; }
      entry.path = (r.path as string).trim();
    }
    const dir = (entry.path ?? suggestRepoName(`https://github.com/${repo}`)).toLowerCase();
    if (dirs.has(dir)) { warnings.push(`${where}: "${REPOS}": two repositories would both be checked out as ${dir}, so ${repo} was left out; give one a path`); continue; }
    dirs.add(dir);
    repos.push(entry);
  }
  return repos;
}

/**
 * An environment definition's JSON (environment.json's, or an inline
 * environment's) as what termag reads of it: `resources` and `repos`.
 * Anything it can't use is left out with a warning, never thrown. The other
 * keys aren't read yet, but are checked against the schema
 * (docs/environment.schema.json), each problem a warning; `$schema` and keys
 * the schema doesn't name are ignored.
 */
export function parseEnvironmentData(data: unknown, where: string): EnvironmentDefinition {
  const sizes: RepoBoxSizes = { size: null };
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { sizes, repos: null, warnings: [`${where} is not a JSON object, so it was ignored`] };
  }
  // The schema's word on every key termag doesn't read yet (ports, …); the ones it reads say their own below.
  const warnings: string[] = environmentSchemaErrors(data, [REPOS, RESOURCES, SETUP, FLAVOR]).map(e => `${where}: ${e} (docs/environment.schema.json)`);
  const obj = data as Record<string, unknown>;
  const repos = obj[REPOS] === undefined ? null : parseRepos(obj[REPOS], where, warnings);
  const setup = obj[SETUP];
  const baseOut = setup === undefined ? {}
    : typeof setup === 'boolean' ? { setupEnabled: setup }
    : { setupWarnings: [`${where}: "${SETUP}" is ${JSON.stringify(setup)}, not true or false, so it was ignored`] };
  if (obj[FLAVOR] !== undefined) warnings.push(`${where}: "${FLAVOR}" isn't supported yet, so it was ignored`);
  const value = obj[RESOURCES];
  if (value === undefined) return { sizes, repos, ...baseOut, warnings };
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
  return { sizes, repos, ...baseOut, warnings };
}

/** An environment.json's text as parseEnvironmentData reads it. */
export function parseRepoEnvironment(text: string, repo = 'the repository', path = REPO_ENVIRONMENT_PATH): EnvironmentDefinition {
  const where = `${repo}'s ${path}`;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { sizes: { size: null }, repos: null, warnings: [`${where} is not valid JSON, so it was ignored`] };
  }
  return parseEnvironmentData(data, where);
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
  /**
   * null for a repository that isn't on GitHub. `path`: an environment's file
   * (services/environments.ts), else the implicit `.termag/environment.json`;
   * `branch`: the branch whose head is read (an environment pointer's), else
   * the default branch.
   */
  read(userId: string, repo: string, path?: string, branch?: string | null, opts?: { withText?: boolean }): Promise<RepoEnvironment | null>;
  /** What is cached, by `owner/name@commit` (`…:path` for another path); for tests. */
  cachedKeys(): string[];
  /**
   * An environment file's text at a branch (its default branch with none), for the box's steps
   * (services/projectEnvironment.ts freezeEnvironmentFile); not parsed and not cached.
   */
  text(userId: string, repo: string, path: string, ref?: string | null): Promise<{ text: string } | { error: string }>;
  /** A repository's default branch, read from GitHub now (a shared environment runs from it); `{ error }` when GitHub doesn't say. */
  defaultBranch(userId: string, repo: string): Promise<{ branch: string } | { error: string }>;
}

type Cached = { sizes: RepoBoxSizes | null; repos: EnvironmentRepo[] | null; setupEnabled?: boolean; warnings: string[]; setupWarnings?: string[]; text?: string };

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

  async function read(userId: string, repo: string, path = REPO_ENVIRONMENT_PATH, branch: string | null = null, opts: { withText?: boolean } = {}): Promise<RepoEnvironment | null> {
    const key = repoKey(repo);
    if (!key) return null;
    const unread = (why: string): RepoEnvironment => ({
      repo: key, commit: null, sizes: null, repos: null, unread: true,
      warnings: [`couldn't read ${key}'s ${path} (${why}), so it was left out`],
    });
    let token: string | null = null;
    try {
      token = await deps.loadToken(userId);
    } catch {
      token = null;
    }
    let commit: string;
    try {
      const ref = branch ? branch.split('/').map(encodeURIComponent).join('/') : 'HEAD';
      const head = await get(`${apiBase}/repos/${key}/commits/${ref}`, token, 'application/vnd.github.sha');
      // No such repository (or branch), or none this credential sees: no file to read, and nothing to warn about
      // that the clone won't say louder.
      if (head.status === 404 || head.status === 409 || head.status === 422) return { repo: key, commit: null, sizes: null, repos: null, warnings: [] };
      if (head.status !== 200 || !/^[0-9a-f]{40}$/.test(head.text.trim())) return unread(`GitHub answered ${head.status} for ${branch ? `its branch ${branch}` : 'its default branch'}`);
      commit = head.text.trim();
    } catch (err) {
      return unread(err instanceof Error && err.name === 'AbortError' ? 'GitHub did not answer in time' : 'GitHub could not be reached');
    }

    const cacheKey = path === REPO_ENVIRONMENT_PATH ? `${key}@${commit}` : `${key}@${commit}:${path}`;
    const hit = byCommit.get(cacheKey);
    if (hit) {
      byCommit.delete(cacheKey);
      byCommit.set(cacheKey, hit);
      return { repo: key, commit, ...copy(hit, opts.withText) };
    }

    let file: { status: number; text: string };
    try {
      file = await get(`${apiBase}/repos/${key}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`, token, 'application/vnd.github.raw');
    } catch (err) {
      return { ...unread(err instanceof Error && err.name === 'AbortError' ? 'GitHub did not answer in time' : 'GitHub could not be reached'), commit };
    }
    let found: Cached;
    if (file.status === 404) found = { sizes: null, repos: null, warnings: [] };
    else if (file.status !== 200) return { ...unread(`GitHub answered ${file.status}`), commit };
    else if (Buffer.byteLength(file.text, 'utf8') > MAX_BYTES) found = { sizes: null, repos: null, warnings: [`${key}'s ${path} is over ${MAX_BYTES / 1024} KiB, so it was ignored`] };
    else found = { ...parseRepoEnvironment(file.text, key, path), text: file.text };

    byCommit.set(cacheKey, found);
    while (byCommit.size > limit) byCommit.delete(byCommit.keys().next().value as string);
    return { repo: key, commit, ...copy(found, opts.withText) };
  }

  // The file's text only for a caller that asks (an environment pointer's resolve, which freezes it).
  function copy(c: Cached, withText?: boolean): Omit<RepoEnvironment, 'repo' | 'commit'> {
    return {
      ...(withText && c.text !== undefined ? { text: c.text } : {}),
      sizes: c.sizes, repos: c.repos, ...(c.setupEnabled !== undefined ? { setupEnabled: c.setupEnabled } : {}), warnings: [...c.warnings],
      ...(c.setupWarnings ? { setupWarnings: [...c.setupWarnings] } : {}),
    };
  }

  async function text(userId: string, repo: string, path: string, ref?: string | null): Promise<{ text: string } | { error: string }> {
    const key = repoKey(repo);
    if (!key) return { error: `${repo} is not a GitHub repository` };
    let token: string | null = null;
    try { token = await deps.loadToken(userId); } catch { token = null; }
    try {
      const at = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const file = await get(`${apiBase}/repos/${key}/contents/${path.split('/').map(encodeURIComponent).join('/')}${at}`, token, 'application/vnd.github.raw');
      if (file.status === 404) return { error: `${key} has no ${path}${ref ? ` on ${ref}` : ''}` };
      if (file.status !== 200) return { error: `GitHub answered ${file.status} for ${key}'s ${path}` };
      if (Buffer.byteLength(file.text, 'utf8') > MAX_BYTES) return { error: `${key}'s ${path} is over ${MAX_BYTES / 1024} KiB` };
      return { text: file.text };
    } catch (err) {
      return { error: err instanceof Error && err.name === 'AbortError' ? 'GitHub did not answer in time' : 'GitHub could not be reached' };
    }
  }

  async function defaultBranch(userId: string, repo: string): Promise<{ branch: string } | { error: string }> {
    const key = repoKey(repo);
    if (!key) return { error: `${repo} is not a GitHub repository` };
    let token: string | null = null;
    try { token = await deps.loadToken(userId); } catch { token = null; }
    try {
      const res = await get(`${apiBase}/repos/${key}`, token, 'application/vnd.github+json');
      if (res.status === 404) return { error: `GitHub doesn't show you ${key}` };
      if (res.status !== 200) return { error: `GitHub answered ${res.status} for ${key}` };
      const branch = (JSON.parse(res.text) as { default_branch?: unknown }).default_branch;
      return typeof branch === 'string' && branch ? { branch } : { error: `GitHub didn't say ${key}'s default branch` };
    } catch (err) {
      return { error: err instanceof Error && err.name === 'AbortError' ? 'GitHub did not answer in time' : 'GitHub could not be reached' };
    }
  }

  return { read, cachedKeys: () => [...byCommit.keys()], text, defaultBranch };
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

/** An environment as resolving it needs it (services/environments.ts): its definition inline, or a pointer to a file. */
export type EnvironmentSource =
  | { name: string; kind: 'inline'; definition: unknown }
  | { name: string; kind: 'pointer'; file: { repo: string; branch: string | null; path: string } };

/** What an environment resolves to when a box or project is made from it. */
export interface ResolvedEnvironment {
  /** The repositories a project made from it holds, in order; a pointer's file repository is always one of them. */
  repos: EnvironmentRepo[];
  /** Its `resources`; null when it says none, or its file couldn't be read. */
  sizes: RepoBoxSizes | null;
  /** What was left out, and why: a warning at creation, never a failure. */
  warnings: string[];
  /** A pointer's file as it was read, so the project created from it freezes this, not a second read. */
  text?: string;
}

/**
 * An environment's definition as a box or project made from it uses it.
 * Inline, the stored JSON. A pointer, the file read now from the pointer's
 * branch (its repository's default branch when it names none), and the
 * file's own repository is one of `repos` whether the file lists it or not
 * (first, on the pointer's branch, when it doesn't). The repositories' own
 * `.termag/environment.json` files are not read, and nothing is combined.
 */
export async function resolveEnvironmentDefinition(
  userId: string, env: EnvironmentSource, reader: RepoEnvironmentReader = repoEnvironment,
): Promise<ResolvedEnvironment> {
  if (env.kind === 'inline') {
    const d = parseEnvironmentData(env.definition, `${env.name}'s definition`);
    return { repos: d.repos ?? [], sizes: d.sizes, warnings: d.warnings };
  }
  const { file } = env;
  const where = `${file.repo}${file.branch ? `:${file.branch}` : ''}:${file.path}`;
  const own: EnvironmentRepo = { repo: file.repo, ...(file.branch ? { branch: file.branch } : {}) };
  const read = await reader.read(userId, file.repo, file.path, file.branch, { withText: true });
  if (!read) return { repos: [], sizes: null, warnings: [`${env.name}'s file names ${file.repo}, which is not a GitHub repository, so it was left out`] };
  const listed = read.repos ?? [];
  const added: string[] = [];
  let repos = listed;
  if (!listed.some(r => r.repo === read.repo)) {
    // The file's own repository comes first, so the file's list makes room for it: a repository
    // checked out in its directory, then any past the cap, is left out (Bugbot, #985).
    const ownDir = suggestRepoName(`https://github.com/${read.repo}`).toLowerCase();
    const dirOf = (r: EnvironmentRepo) => (r.path ?? suggestRepoName(`https://github.com/${r.repo}`)).toLowerCase();
    const others = listed.filter(r => {
      if (dirOf(r) !== ownDir) return true;
      added.push(`${env.name}'s file: ${r.repo} would be checked out as ${ownDir}, the file's own repository's directory, so ${r.repo} was left out; give it a path`);
      return false;
    });
    for (const r of others.slice(MULTI_REPO_MAX - 1)) {
      added.push(`${env.name}'s file: with its own repository, ${env.name} holds at most ${MULTI_REPO_MAX}, so ${r.repo} was left out`);
    }
    repos = [own, ...others.slice(0, MULTI_REPO_MAX - 1)];
  }
  const missing = read.sizes || read.repos || read.warnings.length ? []
    : read.commit ? [`${env.name}'s file, ${where}, is not there, so it was left out`]
    : [`${env.name}'s file is in ${read.repo}${file.branch ? ` on ${file.branch}` : ''}, which GitHub doesn't show you, so it was left out`];
  return { repos, sizes: read.sizes, warnings: [...read.warnings, ...added, ...missing], ...(read.text !== undefined ? { text: read.text } : {}) };
}

/**
 * The termag setup a box made for `repos` takes from their environment.json
 * files: off (false) only when every repository says so,
 * since it leaves out what a repository that doesn't would need; on (true)
 * when some do and some don't, with a warning; null when none says. Its
 * warnings are setupEnabled's own; readWarnings are the file's others (it
 * couldn't be read, or isn't valid), the ones repoSizesFor carries, for a
 * caller that didn't read the sizes.
 */
export async function repoSetupFor(userId: string, repos: ReadonlyArray<string | null | undefined> | string | null | undefined): Promise<{ setupEnabled: boolean | null; repos: string[]; warnings: string[]; readWarnings: string[] }> {
  const list = (Array.isArray(repos) ? repos : [repos]).filter((r): r is string => !!r);
  if (!list.length) return { setupEnabled: null, repos: [], warnings: [], readWarnings: [] };
  const reads = (await Promise.all(list.map(r => repoEnvironment.read(userId, r)))).filter((r): r is RepoEnvironment => !!r);
  const warnings = reads.flatMap(r => r.setupWarnings ?? []);
  const readWarnings = reads.flatMap(r => r.warnings);
  const off = reads.filter(r => r.setupEnabled === false);
  if (!off.length) return { setupEnabled: reads.some(r => r.setupEnabled !== undefined) ? true : null, repos: [], warnings, readWarnings };
  if (off.length === reads.length && reads.length === list.length) return { setupEnabled: false, repos: off.map(r => r.repo), warnings, readWarnings };
  const others = reads.filter(r => r.setupEnabled !== false).map(r => r.repo);
  warnings.push(`${off.map(r => r.repo).join(', ')} ${off.length > 1 ? 'turn' : 'turns'} termag setup off and ${others.join(', ') || 'another repository'} ${others.length > 1 ? 'do' : 'does'} not, so the box has it on`);
  return { setupEnabled: true, repos: [], warnings, readWarnings };
}
