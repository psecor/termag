import { createBody, githubRepoUrl, repoKey, type CreateRepoBody, type RepoPick } from './repoPick';

/** Mirrors backend services/projectRepos.ts MULTI_REPO_MAX. */
export const MULTI_REPO_MAX = 8;

export interface ExtraRepo { url: string; name: string; defaultBranch?: string | null }

export interface WorkspaceRepoInput { url: string; name?: string; defaultBranch?: string | null }

/** Mirrors backend suggestRepoName: the checkout's directory name, no dots (the box's clone unit name cannot carry one). */
export function suggestRepoName(url: string): string {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  const base = m ? m[2] : 'repo';
  const safe = base.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 100);
  return safe || 'repo';
}

/**
 * A create's `repos` when the form has more than one repository, else null
 * and the create goes out as it always has. Blank extra rows are ignored; an
 * empty primary pick contributes nothing.
 */
export function workspaceReposBody(
  primary: CreateRepoBody | null,
  extras: readonly ExtraRepo[],
): WorkspaceRepoInput[] | null {
  const rows: WorkspaceRepoInput[] = [];
  if (primary?.repoUrl) {
    rows.push({ url: primary.repoUrl, ...('defaultBranch' in primary && primary.defaultBranch ? { defaultBranch: primary.defaultBranch } : {}) });
  }
  for (const extra of extras) {
    const url = extra.url.trim();
    if (!url) continue;
    const name = extra.name.trim();
    rows.push({ url, ...(name ? { name } : {}), ...(extra.defaultBranch ? { defaultBranch: extra.defaultBranch } : {}) });
  }
  return extras.some(e => e.url.trim()) && rows.length >= 2 ? rows : null;
}

// ── A repository list with more than one ticked ─────────────────────────────
// The simple UI's picker and the classic New project dialog's list. The pick
// stays the first repository (the name, and in the simple UI the trust and
// last start, follow it); the others are listed repositories ticked after it.

export type ListedPick = Extract<RepoPick, { kind: 'listed' }>;

export interface RepoSelection { pick: RepoPick; more: ListedPick[] }

/**
 * A tick on a listed repository: it joins the selection, or leaves it. With
 * nothing picked yet it becomes the pick; unticking the pick promotes the next
 * one. A starter, or a paste field left blank, is replaced. Past `max` a tick
 * does nothing.
 */
export function toggleRepo(selection: RepoSelection, repo: ListedPick, max = MULTI_REPO_MAX): RepoSelection {
  const { pick, more } = selection;
  if (pick.kind === 'listed' && pick.fullName === repo.fullName) {
    return more.length ? { pick: more[0], more: more.slice(1) } : { pick: { kind: 'empty' }, more: [] };
  }
  if (more.some(r => r.fullName === repo.fullName)) {
    return { pick, more: more.filter(r => r.fullName !== repo.fullName) };
  }
  const replacesPick = pick.kind === 'empty' || pick.kind === 'starter' || (pick.kind === 'pasted' && !pick.url.trim());
  const after = (replacesPick ? 1 : 2) + more.length;
  if (after > max) return selection;
  return replacesPick ? { pick: repo, more } : { pick, more: [...more, repo] };
}

/**
 * The create's `repos` for two or more repositories, else null (a
 * single-repository create). A ticked repository that is the pasted first
 * one is the same repository, and counts once. `typed` are the classic
 * dialog's Add another repository rows, listed after the ticked ones.
 */
export function selectionRepos(selection: RepoSelection, typed: readonly ExtraRepo[] = []): WorkspaceRepoInput[] | null {
  const primary = createBody(selection.pick);
  const first = primary?.repoUrl ? repoKey(primary.repoUrl) : null;
  const others = selection.more.filter(r => repoKey(githubRepoUrl(r.fullName)) !== first);
  const extras: ExtraRepo[] = [
    ...others.map(r => ({ url: githubRepoUrl(r.fullName), name: '', defaultBranch: r.defaultBranch })),
    ...typed,
  ];
  return workspaceReposBody(primary, extras);
}

/**
 * The pill's words for more than one repository: the first in full, then
 * each other by its name when the owner is the same, else in full; past three,
 * how many more.
 */
export function selectionLabel(first: string, more: readonly ListedPick[]): string {
  if (more.length === 0) return first;
  const owner = first.includes('/') ? first.slice(0, first.indexOf('/')) : null;
  const short = (fullName: string) => (owner && fullName.startsWith(`${owner}/`) ? fullName.slice(owner.length + 1) : fullName);
  const shown = more.slice(0, 2).map(r => short(r.fullName));
  const rest = more.length - shown.length;
  return [first, ...shown].join(' + ') + (rest > 0 ? ` + ${rest} more` : '');
}
