// New session starts from a project
// (user-projects-enabled): the pure pieces. Which project it opens on, how the
// pill names a project's repositories, the repository pick a project stands
// for (so Send, the permission pill, the box size and Runs on: Auto read it as
// they read a picked repository), what its checkout is called on the box, and
// which of its checkouts a session can be a worktree of.
import type { Project } from '../types';
import type { UserProjectView } from '../services/api';
import type { RepoPick } from '../utils/repoPick';
import type { ListedPick } from '../utils/multiRepo';
import { suggestedName } from '../utils/repoPick';
import { isSdkChat } from './simpleChat';

/** Mirrors backend routes/projectNames.ts RESERVED_PROJECT_NAMES: a checkout can't be called this. */
export const RESERVED_CHECKOUT_NAMES: readonly string[] = ['metaterm'];

/** A no-repo project's checkout, when its name has none of a checkout name's characters. */
export const NO_REPO_CHECKOUT_NAME = 'scratch';

/** The projects New session offers: the person's own, unarchived, most recently active first (as the server lists them). */
export function offeredProjects(projects: readonly UserProjectView[]): UserProjectView[] {
  return projects.filter(p => !p.archived);
}

/**
 * The project New session opens on: the one `wanted` names (`?project=`, from a
 * project's New session here) while it's offered, else the most recently
 * active (the server's order, so it follows the person across browsers), else
 * none ("Pick a project").
 */
export function defaultUserProject(projects: readonly UserProjectView[], wanted: string | null): UserProjectView | null {
  const offered = offeredProjects(projects);
  return (wanted ? offered.find(p => p.id === wanted) : undefined) ?? offered[0] ?? null;
}

/**
 * A project's repositories on its row in the project menu, muted at its right:
 * their names, "termag · termag-desktop",
 * or "no repo". Nothing when the project is named after its one repository
 * (a project "termag" on termag), where it would only repeat the name.
 */
export function projectRowRepos(project: Pick<UserProjectView, 'name' | 'repos'>): string {
  if (project.repos.length === 0) return 'no repo';
  if (project.repos.length === 1 && project.repos[0].name.toLowerCase() === project.name.trim().toLowerCase()) return '';
  return project.repos.map(r => r.name).join(' · ');
}

/** owner/name as the URL spells it, or null for a URL that isn't a GitHub repository's. */
function fullNameOf(url: string): string | null {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The repository pick a project stands for: its first repository as the pick
 * (listed with its default branch when the project knows it, else as its URL,
 * so no empty branch is ever sent), the rest ticked after it. A project with no
 * repository is the empty pick.
 */
export function projectSelection(project: Pick<UserProjectView, 'repos'>): { pick: RepoPick; more: ListedPick[] } {
  const [first, ...rest] = project.repos;
  if (!first) return { pick: { kind: 'empty' }, more: [] };
  const firstName = fullNameOf(first.url);
  const pick: RepoPick = firstName && first.defaultBranch
    ? { kind: 'listed', fullName: firstName, defaultBranch: first.defaultBranch }
    : { kind: 'pasted', url: first.url };
  const more = rest.flatMap((r): ListedPick[] => {
    const fullName = fullNameOf(r.url);
    return fullName ? [{ kind: 'listed', fullName, defaultBranch: r.defaultBranch ?? '' }] : [];
  });
  return { pick, more };
}

/**
 * The create body's repositories for a new checkout of the project: exactly the
 * project's, each URL as the project keeps it (an ssh URL stays ssh, for a box
 * that clones over ssh) with its default branch. `repos` for several, else
 * `repoUrl`; nothing for a project with none.
 */
export function projectCreateRepos(project: Pick<UserProjectView, 'repos'>):
  | { repos: Array<{ url: string; defaultBranch?: string }> }
  | { repoUrl: string; defaultBranch: string | null }
  | null {
  const [first] = project.repos;
  if (!first) return null;
  if (project.repos.length === 1) return { repoUrl: first.url, defaultBranch: first.defaultBranch };
  return { repos: project.repos.map(r => ({ url: r.url, ...(r.defaultBranch ? { defaultBranch: r.defaultBranch } : {}) })) };
}

/**
 * What a project's new checkout is called on the box: after its first
 * repository, as New session names one today, or for a no-repo project after
 * the project's name made a directory name (lowercase letters, digits, - and
 * _), else `scratch`. Never the project's name as it is: that's any text, and
 * a checkout's name is a directory. People never see it in the chat UI.
 */
export function checkoutBaseName(project: Pick<UserProjectView, 'name' | 'repos'>): string {
  const { pick } = projectSelection(project);
  const fromRepo = pick.kind === 'empty' ? null : suggestedName(pick);
  if (fromRepo) return fromRepo;
  const slug = project.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 40).replace(/[-_]+$/, '');
  return slug || NO_REPO_CHECKOUT_NAME;
}

/** The setup states a checkout takes a new session in (backend services/sessionGate.ts refuses the rest). */
const SESSION_READY = new Set(['ready', 'none']);

/**
 * The checkouts a New session in this project can be a worktree of on the
 * chosen box: the person's own chat checkouts of this project there, set up
 * (one still cloning, waiting for its box or failed would refuse the session),
 * holding every repository the project has now (one made before a repository
 * was added gets a new checkout instead). Not a no-repo project's: there's
 * nothing to branch. Newest first, as Runs on: Auto's pick is.
 */
export function projectWorktreeTargets(project: Pick<UserProjectView, 'id' | 'repos'>, projects: readonly Project[], boxId: string | null): Project[] {
  if (!boxId || project.repos.length === 0) return [];
  const wanted = project.repos.map(r => r.repoKey.toLowerCase());
  return projects
    .filter(p => p.userProjectId === project.id && !p.archived && (p.instanceId ?? null) === boxId
      && (p.kind ?? 'normal') === 'normal' && p.role !== 'collaborator' && isSdkChat(p, 'main')
      && (p.setupStatus == null || SESSION_READY.has(p.setupStatus))
      && wanted.every(k => (p.repoKeys ?? []).some(have => have.toLowerCase() === k)))
    .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
}

/**
 * The name to try after `attempted` came back taken (409 checkout_name_taken: a
 * checkout made meanwhile, or an archived one, which New session never sees):
 * the next suffix of `base` past it (`termag` → `termag-2`, `termag-3` →
 * `termag-4`), skipping any the person's live checkouts and the reserved names hold.
 */
export function nextCheckoutName(base: string, attempted: string, taken: Iterable<string>): string {
  const used = new Set([...taken, attempted, ...RESERVED_CHECKOUT_NAMES].map(n => n.toLowerCase()));
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^${escaped}-(\\d+)$`, 'i').exec(attempted);
  let n = m ? Number(m[1]) + 1 : 2;
  while (used.has(`${base}-${n}`.toLowerCase())) n++;
  return `${base}-${n}`;
}

/** A repository picked for a new project, or added to one: as the create and addRepo send it. */
export interface PickedRepo { fullName: string; url: string; defaultBranch: string | null }

/** A listed repository as a pick. */
export function listedRepo(entry: { fullName: string; defaultBranch: string | null }): PickedRepo {
  return { fullName: entry.fullName, url: `https://github.com/${entry.fullName}.git`, defaultBranch: entry.defaultBranch || null };
}

/**
 * A repository typed or pasted into a search: a GitHub URL (https or ssh, kept as given) or `owner/name`.
 * Null for anything else, and for a word with no slash, which is a search.
 */
export function pastedRepo(text: string): PickedRepo | null {
  const t = text.trim();
  const url = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(t);
  if (url) return { fullName: `${url[1]}/${url[2]}`, url: t, defaultBranch: null };
  const slug = /^([\w.-]+)\/([\w.-]+)$/.exec(t);
  return slug ? { fullName: `${slug[1]}/${slug[2]}`, url: `https://github.com/${slug[1]}/${slug[2]}.git`, defaultBranch: null } : null;
}

/** The create body's repositories for what was picked, each once by owner/name, in the order picked. */
export function pickedReposBody(picked: readonly PickedRepo[]): Array<{ url: string; defaultBranch?: string }> {
  const seen = new Set<string>();
  return picked.flatMap(r => {
    const key = r.fullName.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ url: r.url, ...(r.defaultBranch ? { defaultBranch: r.defaultBranch } : {}) }];
  });
}

/**
 * What a typed name is to the person's projects (names are unique per person, ignoring case, archived
 * ones included): one of theirs (pick it), an archived one (unarchive it), or free (make it).
 */
export function nameMatch(projects: readonly UserProjectView[], typed: string):
  | { kind: 'free' }
  | { kind: 'live'; project: UserProjectView }
  | { kind: 'archived'; project: UserProjectView } {
  const key = typed.trim().toLowerCase();
  const hit = key ? projects.find(p => p.name.trim().toLowerCase() === key) : undefined;
  if (!hit) return { kind: 'free' };
  return hit.archived ? { kind: 'archived', project: hit } : { kind: 'live', project: hit };
}
