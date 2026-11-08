/**
 * Multi-repo projects: the pure rules. A
 * workspace project's dir is a plain directory holding one checkout per
 * ProjectRepo, and every workstream gets a worktree of each one on its branch.
 * Nothing here touches the database or a box (projectRepos.test.ts).
 */

import { parseRepoUrl, repoKey } from './projectTemplates';
import { isBranchName } from './repoCreate';
import type { SetupStatus } from './projectSetup';

/** The box agent capability for per-repository clones, workspace roots and worktree paths (agent/workspace.js). */
export const WORKSPACE_CLONE_CAPABILITY = 'workspace-clone-v1';

/** A workspace project holds 2 to this many repositories. */
export const MULTI_REPO_MAX = 8;

export const MULTI_REPO_FLAG = 'multi-repo-projects-enabled';

export const WORKSPACE_UNSUPPORTED = 'Update termag on this box to use more than one repository';

/** The box agent capability for renaming a multi-repo project or its workstream (project-rename's `workspace`, workspace-move). */
export const WORKSPACE_RENAME_CAPABILITY = 'workspace-rename-v1';

export const WORKSPACE_RENAME_UNSUPPORTED = "This box's termag agent cannot rename a project with several repositories yet; update the box and try again";

// The directory name of a repository's checkout. No dots: the box's clone unit
// is named termag-project-clone@<projectId>--<name>.service, and
// deploy/termag-project-clone accepts only [A-Za-z0-9_-] in an instance.
// Starting with a letter or digit, it can never be .worktrees or .termag-workspace.
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export function isWorkspace(project: { layout?: string | null }): boolean {
  return project.layout === 'workspace';
}

/**
 * Whether a failed project-clone RPC is the box refusing the request (its
 * reply starts `project-clone:`, agent/project-clone.js), which sending it
 * again would not change, rather than a timeout or a dropped connection.
 */
export function isCloneRefusal(message: string): boolean {
  return message.startsWith('project-clone:');
}

/**
 * Why a create may not put a workspace project on this box, or null. A box
 * still booting is accepted, as for a single repository: its first hello
 * dispatches the clones, and one without the capability fails the project then
 * (services/workspaceSetup.ts dispatchWorkspace).
 */
export function workspaceBoxRefusal(box: { present: boolean; booting: boolean; capabilities: ReadonlyArray<string> }): { status: 409 | 503; error: string } | null {
  if (!box.present) return box.booting ? null : { status: 503, error: 'Box agent is not connected' };
  if (!box.capabilities.includes(WORKSPACE_CLONE_CAPABILITY)) {
    return { status: 409, error: WORKSPACE_UNSUPPORTED };
  }
  return null;
}

export function repoNameError(name: unknown): string | null {
  if (typeof name !== 'string' || !REPO_NAME_RE.test(name)) {
    return 'a repository directory name is letters, digits, dashes and underscores, starting with a letter or digit';
  }
  return null;
}

/** `owner/name` of a ProjectRepo's URL, as typed (case kept); null for a URL that is not GitHub's. */
export function repoSlug(url: string): string | null {
  const p = parseRepoUrl(url);
  return p.ok ? `${p.owner}/${p.repo}` : null;
}

/**
 * The checkout of `slug` (owner/name, any case) in a workspace root: where git
 * and gh see that repository. Null when no repository of the project is it.
 */
export function repoCheckoutDir(root: string, repos: ReadonlyArray<{ name: string; url: string }>, slug: string | null): string | null {
  if (!slug) return null;
  const hit = repos.find(r => repoSlug(r.url)?.toLowerCase() === slug.toLowerCase());
  return hit ? `${root.replace(/\/+$/, '')}/${hit.name}` : null;
}

/** A repository's directory name from its URL: the basename, made safe. */
export function suggestRepoName(url: string): string {
  const p = parseRepoUrl(url);
  const base = p.ok ? p.repo : 'repo';
  const safe = base.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 100);
  return safe || 'repo';
}

export interface RepoInput { url?: unknown; name?: unknown; defaultBranch?: unknown }
export interface PlannedRepo { name: string; url: string; defaultBranch: string | null; position: number }

/**
 * A create's `repos`: 2 to MULTI_REPO_MAX GitHub repositories, each once (by
 * repoKey), with unique valid directory names.
 */
export function planWorkspaceRepos(input: unknown, max = MULTI_REPO_MAX): { ok: true; repos: PlannedRepo[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'repos must be a list' };
  if (input.length < 2) return { ok: false, error: 'a multi-repo project needs at least two repositories' };
  if (input.length > max) return { ok: false, error: `a project holds at most ${max} repositories` };
  const keys = new Set<string>();
  const names = new Set<string>();
  const repos: PlannedRepo[] = [];
  for (const [i, raw] of (input as RepoInput[]).entries()) {
    const parsed = parseRepoUrl(raw?.url);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const key = repoKey(parsed.url)!;
    if (keys.has(key)) return { ok: false, error: `${key} is listed twice` };
    keys.add(key);
    const name = raw?.name == null || raw.name === '' ? suggestRepoName(parsed.url) : raw.name;
    const bad = repoNameError(name);
    if (bad) return { ok: false, error: bad };
    const lower = (name as string).toLowerCase();
    if (names.has(lower)) return { ok: false, error: `two repositories would both be checked out as ${name}; rename one` };
    names.add(lower);
    const defaultBranch = typeof raw?.defaultBranch === 'string' && raw.defaultBranch.trim() ? raw.defaultBranch.trim() : null;
    if (defaultBranch !== null && !isBranchName(defaultBranch)) return { ok: false, error: `${key}: "${defaultBranch}" is not a branch name` };
    repos.push({ name: name as string, url: parsed.url, defaultBranch, position: i });
  }
  return { ok: true, repos };
}

/**
 * A repository added to an existing multi-repo project: a GitHub URL the
 * project does not hold yet (by repoKey), under a directory name no other of
 * its repositories has, within MULTI_REPO_MAX.
 */
export function planAddedRepo(
  existing: ReadonlyArray<{ name: string; url: string; position: number }>,
  raw: RepoInput | null | undefined,
  max = MULTI_REPO_MAX,
): { ok: true; repo: PlannedRepo } | { ok: false; error: string } {
  if (existing.length >= max) return { ok: false, error: `a project holds at most ${max} repositories` };
  const parsed = parseRepoUrl(raw?.url);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const key = repoKey(parsed.url)!;
  if (existing.some(r => repoKey(r.url) === key)) return { ok: false, error: `${key} is already in this project` };
  const name = raw?.name == null || raw.name === '' ? suggestRepoName(parsed.url) : raw.name;
  const bad = repoNameError(name);
  if (bad) return { ok: false, error: bad };
  if (existing.some(r => r.name.toLowerCase() === (name as string).toLowerCase())) {
    return { ok: false, error: `a repository is already checked out as ${name}; pick another directory name` };
  }
  const defaultBranch = typeof raw?.defaultBranch === 'string' && raw.defaultBranch.trim() ? raw.defaultBranch.trim() : null;
  if (defaultBranch !== null && !isBranchName(defaultBranch)) return { ok: false, error: `${key}: "${defaultBranch}" is not a branch name` };
  const position = existing.reduce((m, r) => Math.max(m, r.position + 1), 0);
  return { ok: true, repo: { name: name as string, url: parsed.url, defaultBranch, position } };
}

export interface RepoSetupRow {
  name: string;
  setupStatus: string;
  setupError?: string | null;
}

/**
 * What the project's setupStatus becomes after one of its repositories moved,
 * or null for no change. A project that reached ready stays ready: a
 * repository added later clones beside its running sessions, its own row
 * carrying its status, and never sends the project back through setup.
 */
export function settledSetup(
  from: string,
  fromError: string | null,
  repos: ReadonlyArray<RepoSetupRow>,
): { status: SetupStatus; error: string | null } | null {
  if (from === 'ready') return null;
  const next = aggregateSetup(repos);
  if (next.status === from && (next.error ?? null) === (fromError ?? null)) return null;
  return next;
}

/** How joinRepo's error starts: the clone landed, a workstream's worktree did not. */
export const JOIN_FAILED = 'no worktree of it in';

/** Its checkout is in the project folder: ready, or cloned and then failed joining a workstream. */
export function hasMainCheckout(r: RepoSetupRow): boolean {
  return r.setupStatus === 'ready' || (r.setupStatus === 'failed' && (r.setupError ?? '').startsWith(JOIN_FAILED));
}

/**
 * The repositories one root's guide lists, by what is in it. A workstream
 * root's are its `present` worktrees, as the box reads them
 * (workspace-root-state), since a repository that failed joining one
 * workstream may still have joined another. The project folder's are the
 * ones with a checkout there, and `joined`, the one whose clone just landed.
 */
export function guideRepos<R extends RepoSetupRow>(repos: ReadonlyArray<R>, root: { present?: ReadonlyArray<string>; joined?: string } = {}): R[] {
  if (root.present) {
    const here = new Set(root.present);
    return repos.filter(r => here.has(r.name));
  }
  return repos.filter(r => r.name === root.joined || hasMainCheckout(r));
}

/**
 * The repositories a new workstream gets a worktree of. One still cloning
 * holds Branch off back; one that failed to clone is left out, and its Retry
 * joins every workstream then, so a repository that will not clone does not
 * stop the project branching. A pull request in a failed one cannot be
 * checked out.
 */
export function workstreamRepos<R extends RepoSetupRow>(
  repos: ReadonlyArray<R>,
  prRepo?: string,
): { ok: true; repos: R[] } | { ok: false; error: string } {
  const unready = repos.find(r => r.setupStatus === 'pending' || r.setupStatus === 'cloning');
  if (unready) return { ok: false, error: `${unready.name} is not cloned yet` };
  const failedPr = prRepo === undefined ? undefined : repos.find(r => r.name === prRepo && r.setupStatus !== 'ready');
  if (failedPr) return { ok: false, error: `${failedPr.name} did not clone; Retry it first` };
  return { ok: true, repos: repos.filter(r => r.setupStatus === 'ready') };
}

/**
 * The project's setupStatus over its repositories: failed if any failed, else
 * cloning, else pending, else ready. Every existing gate reads that one field.
 */
export function aggregateSetup(repos: ReadonlyArray<RepoSetupRow>): { status: SetupStatus; error: string | null } {
  const failed = repos.filter(r => r.setupStatus === 'failed');
  if (failed.length > 0) {
    return { status: 'failed', error: failed.map(r => `${r.name}: ${r.setupError || 'clone failed'}`).join('; ') };
  }
  if (repos.some(r => r.setupStatus === 'cloning')) return { status: 'cloning', error: null };
  if (repos.some(r => r.setupStatus === 'pending')) return { status: 'pending', error: null };
  return { status: 'ready', error: null };
}

export type RepoCloneDecision =
  | { kind: 'ignore'; why: string }
  | { kind: 'write'; status: 'cloning' | 'ready' | 'failed'; error: string | null; branch: string | null };

/**
 * A box's report for one repository. Stale attempts and reports for a
 * repository already settled are dropped, as projectSetup does for a repo
 * project.
 */
export function decideRepoReport(
  row: { setupStatus: string; setupAttempt: number },
  report: { attempt: number; status: string; error?: string | null; branch?: string | null },
): RepoCloneDecision {
  if (report.attempt !== row.setupAttempt) return { kind: 'ignore', why: `attempt ${report.attempt} is not the live ${row.setupAttempt}` };
  if (row.setupStatus !== 'pending' && row.setupStatus !== 'cloning') return { kind: 'ignore', why: `already ${row.setupStatus}` };
  switch (report.status) {
    case 'pending': return { kind: 'ignore', why: 'still pending' };
    case 'cloning':
      return row.setupStatus === 'cloning' ? { kind: 'ignore', why: 'already cloning' } : { kind: 'write', status: 'cloning', error: null, branch: null };
    case 'ready': return { kind: 'write', status: 'ready', error: null, branch: report.branch ?? null };
    case 'failed': return { kind: 'write', status: 'failed', error: report.error || 'clone failed', branch: null };
    default: return { kind: 'ignore', why: `unknown status ${report.status}` };
  }
}

export interface GuideInput {
  project: string;
  /** 'main', or the workstream whose root this is (every repository a worktree on `branch`). */
  workstream: string;
  branch: string;
  repos: ReadonlyArray<{ name: string; url: string; position: number }>;
}

/** The generated AGENTS.md at a workspace root: what the directory is and the few rules that differ from a single repository. */
export function workspaceGuide(input: GuideInput): string {
  const repos = [...input.repos].sort((a, b) => a.position - b.position);
  const main = input.workstream === 'main';
  const lines = [
    '<!-- Generated by termag; rewritten when this workspace changes. Put lasting notes in a repository\'s own AGENTS.md. -->',
    `# ${input.project}${main ? '' : ` / ${input.workstream}`}`,
    '',
    `This directory is not a git repository. Each subdirectory is one repository (${main ? 'its main checkout' : `a worktree on branch \`${input.branch}\``}); run git inside it.`,
    '',
    ...repos.map(r => `- \`${r.name}/\`: ${r.url}`),
    '',
    'Commit, push and open a pull request only in the repositories you change.',
  ];
  if (!main) lines.push('To run a repository you are not changing, you can use main\'s checkout at `../../<repo>` instead of setting up this one.');
  return `${lines.join('\n')}\n`;
}

/**
 * Why a multi-repo project, or one of its workstreams, may not be renamed
 * now, or null; checked before anything moves. The box's agent must know how
 * (a rename by an older one would move the folder and leave every worktree
 * pointing at the old paths), and no repository may still be cloning into
 * the folder that would move. A failed clone is fine: Retry clones it into
 * the new folder.
 */
export function workspaceRenameRefusal(input: {
  capabilities: ReadonlyArray<string>;
  repos: ReadonlyArray<{ name: string; setupStatus: string }>;
}): { status: 409; error: string; code?: string } | null {
  if (!input.capabilities.includes(WORKSPACE_RENAME_CAPABILITY)) {
    return { status: 409, error: WORKSPACE_RENAME_UNSUPPORTED, code: 'agent_outdated' };
  }
  const cloning = input.repos.find(r => r.setupStatus === 'pending' || r.setupStatus === 'cloning');
  if (cloning) return { status: 409, error: `${cloning.name} is still being cloned; rename once it is done` };
  return null;
}

export interface GuideWrite { dir: string; content: string }

/**
 * The generated guides a rename rewrites: the project root's and each named
 * workstream's (main is the root), with the names they have after it. The
 * box writes only those termag wrote, in folders that are there.
 */
export function workspaceGuideWrites(input: {
  project: string;
  repos: ReadonlyArray<{ name: string; url: string; position: number }>;
  workstreams: ReadonlyArray<{ name: string; branch: string }>;
  dirFor: (workstream: string) => string;
}): GuideWrite[] {
  return input.workstreams.map(ws => ({
    dir: input.dirFor(ws.name),
    content: workspaceGuide({ project: input.project, workstream: ws.name, branch: ws.branch, repos: input.repos }),
  }));
}
