/**
 * Workstreams on a multi-repo project: a
 * workstream root at <project>/.worktrees/<ws>/ holding a worktree of every
 * repository (<wsRoot>/<repo>, branched from that repository's main checkout)
 * and a generated AGENTS.md.
 *
 * Box first both ways, as the rest of the workstream routes: the row is written
 * only once the tree exists, and removed only once it is gone.
 */

import { sendForProject } from './agentRegistry';
import { repoSlug } from './projectRepos';
import { workspaceRoot, writeGuide } from './workspaceSetup';

/** The agent capability for git-worktree-add-pr's `worktreePath` (agent/git-worktree-pr.js). */
export const WORKTREE_PR_PATH_CAPABILITY = 'worktree-pr-path-v1';

// Longer than the agent can take (agent/git-worktree-pr.js MAX_DURATION_MS: two
// 90 s fetches, a 90 s checkout and the ref steps: 510 s), so the orchestrator
// never gives up on a checkout the agent then finishes.
export const PR_CHECKOUT_TIMEOUT_MS = 600_000;

/** A pull request to check out into one repository of the tree (routes/workstreams.ts `pr`). */
export interface WorkspacePr { repoName: string; number: number; sameRepo: boolean; headOid: string }

export interface WorkspaceProject {
  id: string;
  name: string;
  userId: string;
  instanceId: string | null;
  user: { unixUsername: string };
  instance: { hostHome: string | null } | null;
}

export interface WorkspaceRepo { name: string; url: string; position: number; setupStatus?: string }

type Host = { userId: string; instanceId: string | null };

function hostOf(p: WorkspaceProject): Host {
  return { userId: p.userId, instanceId: p.instanceId };
}

async function removeWorktree(host: Host, root: string, wsRoot: string, wsName: string, repo: string, branch: string | undefined, force: boolean): Promise<string | null> {
  const result = await sendForProject(host, 'git-worktree-remove', {
    projectDir: `${root}/${repo}`,
    worktreeName: wsName,
    worktreePath: `${wsRoot}/${repo}`,
    branch,
    force,
  }, 30_000) as { branchDeleteWarning?: string | null } | undefined;
  return result?.branchDeleteWarning ?? null;
}

/**
 * Which of a multi-repo project's repositories a pull request is in, by the
 * ProjectRepo URL's owner/name (any case). A PR with no repository is refused,
 * naming them, as the Review pane does (services/reviewRepo.ts reviewTarget):
 * its number could be in any of them.
 */
export function workspacePrRepo<R extends WorkspaceRepo>(
  projectName: string, repos: ReadonlyArray<R>, pr: { repo: string | null; number: number },
): { ok: true; repo: R } | { ok: false; error: string } {
  const ordered = [...repos].sort((a, b) => a.position - b.position);
  const slugs = ordered.map(r => repoSlug(r.url) ?? r.name).join(', ');
  if (!pr.repo) {
    return { ok: false, error: `${projectName} holds several repositories (${slugs}), so PR #${pr.number} could be in any of them. Use the PR's URL or owner/repo#${pr.number}.` };
  }
  const wanted = pr.repo.toLowerCase();
  const hit = ordered.find(r => repoSlug(r.url)?.toLowerCase() === wanted);
  if (!hit) {
    return { ok: false, error: `${projectName} holds ${slugs}, not ${pr.repo}. Make a project for ${pr.repo} (or un-archive one), then try again.` };
  }
  return { ok: true, repo: hit };
}

/**
 * Undo the worktrees a build made, then the root if nothing else is left in
 * it. A worktree the build found already there is not in `made`, so a
 * concurrent request's tree is never taken. Each made worktree's branch goes
 * with it, except in the repositories of `keepBranchIn`: a pull request's
 * branch is the PR's, and may hold the user's work.
 */
export async function undoWorkstreamTree(
  project: WorkspaceProject, made: ReadonlyArray<string>, wsName: string, branch: string, keepBranchIn: ReadonlyArray<string> = [],
): Promise<void> {
  const host = hostOf(project);
  const root = workspaceRoot(project);
  const wsRoot = workspaceRoot(project, wsName);
  for (const repo of made) {
    await removeWorktree(host, root, wsRoot, wsName, repo, keepBranchIn.includes(repo) ? undefined : branch, true).catch(() => {});
  }
  await sendForProject(host, 'workspace-root-remove', { wsRoot }).catch(() => {});
}

/**
 * Make the workstream root and a worktree of every repository on `branch`.
 * With `pr`, that repository's worktree is the pull request's own branch
 * (git-worktree-add-pr, as a single repository's PR checkout), made first
 * since it is the step most likely to fail; the others branch off their main
 * checkout's `baseRef` onto `branch`, as Branch off does. A failed worktree
 * add, or guide write, undoes the worktrees this call made and the root, and
 * answers the error. `made` is what a caller must undo if the row then cannot
 * be written.
 */
export async function buildWorkstreamTree(
  project: WorkspaceProject,
  repos: ReadonlyArray<WorkspaceRepo>,
  wsName: string,
  branch: string,
  baseRef: string,
  pr?: WorkspacePr,
): Promise<{ ok: true; made: string[] } | { ok: false; error: string }> {
  const host = hostOf(project);
  const root = workspaceRoot(project);
  const wsRoot = workspaceRoot(project, wsName);
  const keep = pr ? [pr.repoName] : [];
  try {
    await sendForProject(host, 'init-workspace', { dir: wsRoot });
  } catch (err) {
    return { ok: false, error: `the workstream root: ${(err as Error).message}` };
  }
  const made: string[] = [];
  const ordered = pr ? [...repos.filter(r => r.name === pr.repoName), ...repos.filter(r => r.name !== pr.repoName)] : repos;
  for (const repo of ordered) {
    const common = { projectDir: `${root}/${repo.name}`, worktreeName: wsName, worktreePath: `${wsRoot}/${repo.name}`, branch };
    try {
      const added = repo.name === pr?.repoName
        ? await sendForProject(host, 'git-worktree-add-pr', {
          ...common, number: pr.number, sameRepo: pr.sameRepo, headOid: pr.headOid,
        }, PR_CHECKOUT_TIMEOUT_MS) as { existing?: unknown } | undefined
        : await sendForProject(host, 'git-worktree-add', { ...common, baseRef, initRepo: false }, 30_000) as { existing?: unknown } | undefined;
      if (added?.existing !== true) made.push(repo.name);
    } catch (err) {
      await undoWorkstreamTree(project, made, wsName, branch, keep);
      return { ok: false, error: `${repo.name}: ${(err as Error).message}` };
    }
  }
  try {
    await writeGuide(project, repos, wsName, branch);
  } catch (err) {
    await undoWorkstreamTree(project, made, wsName, branch, keep);
    return { ok: false, error: `the workstream guide: ${(err as Error).message}` };
  }
  return { ok: true, made };
}

/**
 * Why a workstream's tree may not be removed without force, or null. Every
 * repository is read before anything is removed: a worktree with uncommitted
 * changes refuses, as for a single repository, and so does one that cannot be
 * read (a slow `git status`, a broken worktree), since it may hold work. Only
 * a worktree whose directory is not there counts as gone. Files at the root
 * outside every repository refuse too, since removing the root deletes them.
 */
async function removalRefusal(project: WorkspaceProject, wsName: string, repos: ReadonlyArray<WorkspaceRepo>): Promise<string | null> {
  const host = hostOf(project);
  const wsRoot = workspaceRoot(project, wsName);
  let state: { exists?: boolean; present?: unknown; leftovers?: unknown };
  try {
    state = await sendForProject(host, 'workspace-root-state', { wsRoot, repos: repos.map(r => r.name) }, 10_000) as typeof state;
  } catch (err) {
    return `The workstream could not be checked: ${(err as Error).message}. Try again, or remove with force.`;
  }
  if (state?.exists !== true) return null;
  const present = new Set(Array.isArray(state.present) ? state.present : []);
  const leftovers = Array.isArray(state.leftovers) ? state.leftovers.filter((n): n is string => typeof n === 'string') : [];
  const checks = await Promise.all(repos.filter(r => present.has(r.name)).map(async repo => {
    try {
      const s = await sendForProject(host, 'git-branch-state', { cwd: `${wsRoot}/${repo.name}` }, 10_000) as { dirty?: boolean };
      return { name: repo.name, state: s?.dirty === true ? 'dirty' as const : 'clean' as const };
    } catch {
      return { name: repo.name, state: 'unknown' as const };
    }
  }));
  const dirty = checks.filter(c => c.state === 'dirty').map(c => c.name);
  const unknown = checks.filter(c => c.state === 'unknown').map(c => c.name);
  const reasons: string[] = [];
  if (dirty.length > 0) reasons.push(`These repositories have uncommitted changes: ${dirty.join(', ')}.`);
  if (unknown.length > 0) reasons.push(`These repositories could not be checked: ${unknown.join(', ')}.`);
  if (leftovers.length > 0) reasons.push(`The workstream folder also holds ${leftovers.join(', ')}, which removing it would delete.`);
  return reasons.length > 0 ? `${reasons.join(' ')} Commit or move them, or remove with force.` : null;
}

/**
 * Remove a workstream's tree. Without force, everything is checked first
 * (removalRefusal), so a refusal leaves the tree whole. Commits stay on the
 * branch when git will not delete it (the warnings). With force, worktrees
 * go with their changes and the root with whatever else it held.
 */
export async function removeWorkstreamTree(
  project: WorkspaceProject,
  repos: ReadonlyArray<WorkspaceRepo>,
  ws: { name: string; branch: string },
  opts: { force: boolean; keepBranch?: boolean },
): Promise<{ ok: true; warnings: string[] } | { ok: false; status: number; error: string }> {
  if (!opts.force) {
    const refusal = await removalRefusal(project, ws.name, repos);
    if (refusal) return { ok: false, status: 409, error: refusal };
  }
  const host = hostOf(project);
  const root = workspaceRoot(project);
  const wsRoot = workspaceRoot(project, ws.name);
  const warnings: string[] = [];
  for (const repo of repos) {
    try {
      const w = await removeWorktree(host, root, wsRoot, ws.name, repo.name, opts.keepBranch ? undefined : ws.branch, opts.force);
      if (w) warnings.push(`${repo.name}: ${w}`);
    } catch (err) {
      // A repository added since, still cloning or failed, may have no checkout to ask; the root's removal
      // below still refuses, without force, to delete a worktree of it that is there.
      if (repo.setupStatus && repo.setupStatus !== 'ready') continue;
      return { ok: false, status: 409, error: `${repo.name}: git worktree remove failed: ${(err as Error).message}` };
    }
  }
  try {
    await sendForProject(host, 'workspace-root-remove', { wsRoot, force: opts.force });
  } catch (err) {
    return { ok: false, status: 409, error: `the workstream root could not be removed: ${(err as Error).message}` };
  }
  return { ok: true, warnings };
}
