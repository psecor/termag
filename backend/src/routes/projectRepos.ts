/**
 * The repositories of a multi-repo project after creation:
 * list them, and add
 * one (cloned beside the running sessions, then a worktree of it in every
 * workstream). Owner only, behind `multi-repo-projects-enabled`; a
 * single-repository project answers 409, since turning one into a folder of
 * repositories is not built yet. Removing one is not built either.
 */
import { prisma } from '../db';
import { agentView } from '../services/projectClone';
import {
  isWorkspace,
  planAddedRepo,
  WORKSPACE_CLONE_CAPABILITY,
  WORKSPACE_UNSUPPORTED,
  type RepoInput,
} from '../services/projectRepos';
import { MULTI_REPO_DISABLED_CODE, multiRepoEnabled } from '../services/multiRepoFlag';
import { dispatchWorkspace } from '../services/workspaceSetup';
import { notifyOnSuccess } from '../services/workspaceEvents';
import type { RouteResult } from './routeResult';

const NOT_MULTI_REPO = { error: 'This project is a single repository; only a project created with several repositories can add one', code: 'not_multi_repo' };
const DISABLED = { error: 'Projects with more than one repository are not on for you', code: MULTI_REPO_DISABLED_CODE };

function loadOwned(user: Express.User, id: string) {
  return prisma.project.findFirst({
    where: { id, userId: user.id, archived: false },
    include: { repos: { orderBy: { position: 'asc' } } },
  });
}

type OwnedWorkspace = NonNullable<Awaited<ReturnType<typeof loadOwned>>>;

async function ownedWorkspace(user: Express.User, id: string): Promise<{ project: OwnedWorkspace } | { refused: RouteResult }> {
  const project = await loadOwned(user, id);
  if (!project) return { refused: { status: 404, body: { error: 'Project not found' } } };
  if (!isWorkspace(project)) return { refused: { status: 409, body: NOT_MULTI_REPO } };
  if (!await multiRepoEnabled(user)) return { refused: { status: 403, body: DISABLED } };
  return { project };
}

function repoView(r: { name: string; url: string; defaultBranch: string | null; setupStatus: string; setupError: string | null; position: number }) {
  return { name: r.name, url: r.url, defaultBranch: r.defaultBranch, setupStatus: r.setupStatus, setupError: r.setupError, position: r.position };
}

export async function listProjectRepos(user: Express.User, id: string): Promise<RouteResult> {
  const owned = await ownedWorkspace(user, id);
  if ('refused' in owned) return owned.refused;
  return { status: 200, body: { repos: owned.project.repos.map(repoView) } };
}

/**
 * Add a repository: its row in pending, then the box's clone of it. The
 * request answers once the row is written (202); the clone and the worktrees
 * follow, and the row's status says how far they got. Needs the box's agent
 * connected and able to clone into a workspace.
 */
export async function addProjectRepo(user: Express.User, id: string, input: RepoInput | null | undefined): Promise<RouteResult> {
  const owned = await ownedWorkspace(user, id);
  if ('refused' in owned) return owned.refused;
  const { project } = owned;
  if (!project.instanceId) return { status: 400, body: { error: 'A project with several repositories runs on a box' } };
  const view = agentView(project.instanceId);
  if (view.kind !== 'present') return { status: 503, body: { error: 'Box agent is not connected' } };
  if (!view.capabilities.includes(WORKSPACE_CLONE_CAPABILITY)) return { status: 409, body: { error: WORKSPACE_UNSUPPORTED, code: 'agent_outdated' } };
  let added;
  try {
    // The project's row lock lines up two adds, so the second plans against the first's row:
    // the unique (projectId, name) alone lets one URL in twice under two names.
    added = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${project.id} FOR UPDATE`;
      const existing = await tx.projectRepo.findMany({ where: { projectId: project.id }, orderBy: { position: 'asc' } });
      const planned = planAddedRepo(existing, input);
      if (!planned.ok) return planned;
      const { repo } = planned;
      return {
        ok: true as const,
        row: await tx.projectRepo.create({
          data: { projectId: project.id, name: repo.name, url: repo.url, defaultBranch: repo.defaultBranch, position: repo.position },
        }),
      };
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return { status: 409, body: { error: 'a repository is already checked out under that name' } };
    throw err;
  }
  if (!added.ok) return { status: 400, body: { error: added.error } };
  const created = added.row;
  void dispatchWorkspace(project.id).catch(e => console.error(`[PROJECTS] ${project.id}: cloning ${created.name} failed:`, (e as Error).message));
  return notifyOnSuccess({ status: 202, body: { repo: repoView(created) } }, user.id, 'projects');
}
