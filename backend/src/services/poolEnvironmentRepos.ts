/**
 * The repositories a preparing pool box may fetch with the pool credential
 * (services/githubAuthz.ts, the pool rule): the ones its environment
 * (Instance.poolEnvironmentId) resolves to, read as the pool sees them, with
 * the pool's own credential. Only a shared environment can be pooled;
 * a personal or
 * missing one has no repositories here, so the rule refuses everything.
 *
 * The environment's row is read on every lookup, so one made personal or
 * deleted has no repositories from the next request on. Its resolve (a pointer
 * reads GitHub) is cached for a minute against the row's updatedAt: a clone is
 * several broker requests, and an edit to the row resolves again at once. A
 * change to a pointer's file on GitHub is seen within the minute. An
 * incomplete resolve is never cached: a pointer whose file GitHub didn't serve (unreachable, an error, or
 * a repository the credential can't see) resolves to its file's repository
 * alone, and the next request reads again, so a recovery or a new credential
 * counts at once. A set or delete of the pool credential drops the cache.
 */

import { prismaEnvironmentStore, type EnvironmentStore } from './environments';
import {
  createRepoEnvironmentReader, resolveEnvironmentDefinition, type RepoEnvironment, type RepoEnvironmentReader,
} from './repoEnvironment';
import { onPoolCredentialChange, poolGithubTokenSource } from './poolCredential';

const CACHE_MS = 60_000;
// The reader's API takes a user; the pool has none, and its loadToken ignores it.
const POOL_READER_USER = 'environment-pool';

export interface PoolEnvironmentReposDeps {
  store?: Pick<EnvironmentStore, 'get'>;
  reader?: RepoEnvironmentReader;
  now?: () => number;
  /** Drop the cache whenever the pool credential is set or deleted (onPoolCredentialChange). */
  forgetOnCredentialChange?: boolean;
}

export type PoolEnvironmentRepos = ((environmentId: string) => Promise<readonly string[] | null>) & {
  /** Drops every cached environment. */
  forget(): void;
  /** Stops listening for credential changes. */
  stop(): void;
};

export const poolRepoEnvironmentReader: RepoEnvironmentReader = createRepoEnvironmentReader({
  fetchImpl: (...args) => fetch(...args),
  loadToken: () => poolGithubTokenSource(),
});

/** A pointer's file read in full: GitHub named the commit, and the file at it was read or isn't there. */
function readInFull(read: RepoEnvironment | null): boolean {
  return !!read && read.commit !== null && !read.unread;
}

export function createPoolEnvironmentRepos(deps: PoolEnvironmentReposDeps = {}): PoolEnvironmentRepos {
  const store = deps.store ?? prismaEnvironmentStore;
  const reader = deps.reader ?? poolRepoEnvironmentReader;
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, { repos: readonly string[]; version: number; at: number }>();
  const lookup = async (environmentId: string): Promise<readonly string[] | null> => {
    const env = await store.get(environmentId);
    if (!env || env.visibility !== 'shared') {
      cache.delete(environmentId);
      return null;
    }
    const version = env.updatedAt.getTime();
    const hit = cache.get(environmentId);
    if (hit && hit.version === version && now() - hit.at < CACHE_MS) return hit.repos;
    // The same reader, watched: whether the pointer's file was read in full decides whether the answer is cached.
    let full = true;
    const watched: RepoEnvironmentReader = {
      ...reader,
      read: async (...args) => {
        const read = await reader.read(...args);
        if (!readInFull(read)) full = false;
        return read;
      },
    };
    const resolved = await resolveEnvironmentDefinition(POOL_READER_USER, env, watched);
    const repos: readonly string[] = resolved.repos.map(r => r.repo.toLowerCase());
    const complete = env.kind === 'inline' || full;
    if (complete) cache.set(environmentId, { repos, version, at: now() });
    else cache.delete(environmentId);
    return repos;
  };
  const forget = () => { cache.clear(); };
  const stop = deps.forgetOnCredentialChange ? onPoolCredentialChange(forget) : () => {};
  return Object.assign(lookup, { forget, stop });
}

export const poolEnvironmentRepos = createPoolEnvironmentRepos({ forgetOnCredentialChange: true });
