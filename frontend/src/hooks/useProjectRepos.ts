import { useCallback, useEffect, useRef, useState } from 'react';
import { projectsApi } from '../services/api';
import { githubRepoUrl } from '../utils/repoPick';
import { apiErrorText } from '../utils/prPipeline';
import { reposSettling, type ProjectRepoView } from '../utils/projectRepos';

/** How often the list is read again while a clone or its worktrees are on the way. */
export const REPOS_POLL_MS = 2_000;

export interface ProjectReposState {
  /** Null until the first read. */
  repos: ProjectRepoView[] | null;
  error: string | null;
  /** The listed repositories (owner/name) whose add is in flight. */
  adding: ReadonlySet<string>;
  add: (fullName: string) => Promise<boolean>;
  retry: () => Promise<void>;
}

/**
 * A multi-repo project's repositories, for both UIs' add: read them (null
 * id: not at all), add one by owner/name, read again until every clone has
 * settled, and Retry the failed ones (POST /clone/retry). onSettled runs
 * once each time the list goes from settling to settled, so the caller can
 * reload the project list.
 */
export function useProjectRepos(projectId: string | null, onSettled?: () => void): ProjectReposState {
  const [repos, setRepos] = useState<ProjectRepoView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const wasSettling = useRef(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const body = await projectsApi.repos(projectId);
      setRepos(body.repos);
    } catch (err) {
      setError(apiErrorText(err, 'Could not read the repositories'));
    }
  }, [projectId]);

  useEffect(() => {
    setRepos(null);
    setError(null);
    void load();
  }, [load]);

  const settling = repos ? reposSettling(repos) : false;
  useEffect(() => {
    if (wasSettling.current && !settling) settled.current?.();
    wasSettling.current = settling;
    if (!settling) return;
    const timer = setInterval(() => { void load(); }, REPOS_POLL_MS);
    return () => clearInterval(timer);
  }, [settling, load]);

  const add = useCallback(async (fullName: string) => {
    if (!projectId) return false;
    setError(null);
    setAdding(s => new Set(s).add(fullName));
    try {
      const { repo } = await projectsApi.addRepo(projectId, { url: githubRepoUrl(fullName) });
      setRepos(list => [...(list ?? []).filter(r => r.name !== repo.name), repo]);
      return true;
    } catch (err) {
      setError(apiErrorText(err, `Could not add ${fullName}`));
      return false;
    } finally {
      setAdding(s => { const next = new Set(s); next.delete(fullName); return next; });
    }
  }, [projectId]);

  const retry = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    try {
      await projectsApi.retryClone(projectId);
    } catch (err) {
      setError(apiErrorText(err, 'Could not retry'));
    }
    await load();
  }, [projectId, load]);

  return { repos, error, adding, add, retry };
}
