// A multi-repo project's repositories after creation, added through
// /api/projects/:id/repos (backend routes/projectRepos.ts): the simple UI's
// repo pill over the composer (pages/chat/SessionRepoPill.tsx) and the
// classic UI's Add repository… (components/AddRepoDialog.tsx).
import { repoKey } from './repoPick';
import type { ListedPick } from './multiRepo';

export type RepoSetupStatus = 'pending' | 'cloning' | 'ready' | 'failed';

export interface ProjectRepoView {
  name: string;
  url: string;
  defaultBranch: string | null;
  setupStatus: RepoSetupStatus;
  setupError: string | null;
  position: number;
}

const FULL_NAME_RE = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;

/** owner/name of a repository's GitHub URL, as it is spelled there; the URL itself when it is not one. */
export function repoFullName(url: string): string {
  const m = FULL_NAME_RE.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : url;
}

/** The project's repositories as the pickers' picks, in their order. */
export function repoPicks(repos: readonly ProjectRepoView[]): ListedPick[] {
  return [...repos].sort((a, b) => a.position - b.position)
    .map(r => ({ kind: 'listed', fullName: repoFullName(r.url), defaultBranch: r.defaultBranch ?? '' }));
}

/** Whether `fullName` is one of the project's repositories, however either is spelled. */
export function inProject(repos: readonly ProjectRepoView[], fullName: string): boolean {
  const key = fullName.toLowerCase();
  return repos.some(r => repoKey(r.url) === key);
}

/** A clone or its worktrees are still on the way: the list keeps being read. */
export function reposSettling(repos: readonly ProjectRepoView[]): boolean {
  return repos.some(r => r.setupStatus === 'pending' || r.setupStatus === 'cloning');
}

/** What the pill adds to the repositories' names: a clone on the way, else one that failed. */
export function reposState(repos: readonly ProjectRepoView[]): 'cloning' | 'failed' | null {
  if (reposSettling(repos)) return 'cloning';
  return repos.some(r => r.setupStatus === 'failed') ? 'failed' : null;
}

/** A repository's line under its row; none once it is ready. */
export function repoStatusText(repo: ProjectRepoView): string | null {
  switch (repo.setupStatus) {
    case 'pending': return 'Waiting to clone';
    case 'cloning': return 'Cloning, then adding it to each workstream…';
    case 'failed': return repo.setupError ? `Failed: ${repo.setupError}` : 'Failed';
    default: return null;
  }
}

/** Why the project's repositories cannot be unticked, under the list. */
export const LOCKED_HINT = 'A repository stays once added. To work without one, start a new session or project.';
