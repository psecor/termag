/**
 * What the PR overlay's "Attach to a workstream" picker offers (backend
 * services/workstreamPrs.ts): the user's own live workstreams, newest work
 * first, with the PR's current one left out. Narrowed to the projects with a
 * checkout of the PR's repository (GET /api/prs `checkouts`, from the boxes'
 * branch read) when there are any; every project when none is known, since a
 * box that is offline cannot say what it has checked out.
 */
import type { PrCheckout, PrWorkstreamLink } from '../services/api';
import type { Project } from '../types';

export interface WorkstreamChoice { value: string; label: string; projectId: string; workstream: string }

export interface ChoiceList {
  choices: WorkstreamChoice[];
  /** True when narrowed to checkouts of the PR's repository. */
  sameRepo: boolean;
}

/** The user's own projects the picker offers, narrowed like the choices; most recently active first. */
export function scopedProjects(projects: Project[], repo: string | null, checkouts: PrCheckout[] = []): Project[] {
  const own = projects.filter(p => !p.archived && p.kind !== 'metaterm' && p.role !== 'collaborator');
  const wanted = repo?.toLowerCase();
  const matching = new Set(wanted ? checkouts.filter(c => c.repo.toLowerCase() === wanted).map(c => c.projectId) : []);
  const scoped = matching.size > 0 ? own.filter(p => matching.has(p.id)) : own;
  return [...scoped].sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '') || a.name.localeCompare(b.name));
}

const WORKSTREAM_NAME = /^[A-Za-z0-9_-]+$/;
export const isWorkstreamName = (s: string) => WORKSTREAM_NAME.test(s) && s !== 'main';

/**
 * A new workstream's name for a PR: the repository's name, the PR's number and
 * the branch's last segment (`feat/pr-defer` of #359 in termag →
 * `termag-pr359-pr-defer`), the repo and number prefixes kept once, at most 48
 * characters.
 */
export function suggestWorkstreamName(repo: string, number: number, branch: string): string {
  const repoName = (repo.split('/')[1] ?? repo).replace(/[^A-Za-z0-9_-]+/g, '-');
  const prefix = `${repoName}-pr${number}`;
  const last = branch.split('/').filter(Boolean).pop() ?? branch;
  const slug = last.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  let rest = slug === repoName ? '' : slug.startsWith(`${repoName}-`) ? slug.slice(repoName.length + 1) : slug;
  if (rest === `pr${number}` || rest.startsWith(`pr${number}-`)) rest = rest.slice(`pr${number}`.length + 1);
  return (rest ? `${prefix}-${rest}` : prefix).slice(0, 48).replace(/-$/, '');
}

/** What a new PR workstream's agent is asked first, unless the user changes it. */
export function suggestPrPrompt(repo: string, number: number): string {
  const repoName = repo.split('/')[1] ?? repo;
  return `Can you give a quick description of ${repoName}#${number} and any particular key points to review carefully?`;
}

export function workstreamChoices(
  projects: Project[], current: PrWorkstreamLink | null, repo: string | null = null, checkouts: PrCheckout[] = [],
): ChoiceList {
  const own = projects.filter(p => !p.archived && p.kind !== 'metaterm' && p.role !== 'collaborator');
  const wanted = repo?.toLowerCase();
  const matching = new Set(wanted ? checkouts.filter(c => c.repo.toLowerCase() === wanted).map(c => c.projectId) : []);
  const sameRepo = matching.size > 0;
  const out: (WorkstreamChoice & { at: string })[] = [];
  for (const p of own) {
    // A project's worktrees share its origin, so one known checkout vouches for the project.
    if (sameRepo && !matching.has(p.id)) continue;
    for (const ws of p.workstreams ?? []) {
      if (ws.archived) continue;
      if (current && current.projectId === p.id && current.workstream === ws.name) continue;
      out.push({
        value: `${p.id}/${ws.name}`,
        label: ws.name === 'main' ? p.name : `${p.name} · ${ws.name}`,
        projectId: p.id,
        workstream: ws.name,
        at: ws.lastActiveAt ?? '',
      });
    }
  }
  const choices = out.sort((a, b) => b.at.localeCompare(a.at) || a.label.localeCompare(b.label)).map(({ at: _at, ...c }) => c);
  return { choices, sameRepo };
}

/** The choices whose label has every word of the query, in any order and case. */
export function filterChoices(choices: WorkstreamChoice[], query: string): WorkstreamChoice[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return choices;
  return choices.filter(c => { const l = c.label.toLowerCase(); return words.every(w => l.includes(w)); });
}

/** The overlay's word for how a PR got its workstream. */
export function linkedByText(by: string | null | undefined): string | null {
  switch (by) {
    case 'checkout': return 'its branch is checked out there';
    case 'created': return 'opened from there';
    case 'branch': return 'its branch was checked out there';
    case 'manual': return 'attached by you';
    default: return null;
  }
}
