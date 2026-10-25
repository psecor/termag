/**
 * CliLifecycle over the functions the cookie routes call (routes/instances.ts,
 * routes/projects.ts, routes/workstreams.ts). Successes are re-read and shaped
 * into the CLI's views (services/cliViews.ts, services/cliWorkstreams.ts);
 * failures pass through cliErrorResult, so nothing but the error, a code and a
 * project list ever reaches the CLI.
 */
import { posix } from 'path';
import { prisma } from '../db';
import { pickTarget } from '../services/agentMessages';
import { instanceAgentTransport, sendToInstanceAgent } from '../services/agentRegistry';
import { isBoxProvisioningConfigured } from '../services/boxProvisioner';
import { powerStateError } from '../services/boxPowerPolicy';
import type { CliUser } from '../services/cliStore';
import { prismaCliStore } from '../services/cliStorePrisma';
import { createCliWorkstream } from '../services/cliWorkstreams';
import { T3_CAPABILITY, desktopAppEnabled } from '../services/desktopAppFlag';
import { repoFromOrigin } from '../services/prBranches';
import { projectDirFor } from '../services/tmux';
import { cliErrorResult, type CliLifecycle } from './cliLifecycle';
import { createBox, powerOwnedBox, renameOwnedBox, setOwnedBoxLifecycle, terminateOwnedBox } from './instances';
import { archiveOwnedProject, createProjectFor, renameOwnedProject, retryCloneFor } from './projects';
import type { RouteResult } from './routeResult';
import { createWorkstreamFor, removeWorkstreamFor } from './workstreams';

async function fullUser(user: CliUser): Promise<Express.User> {
  const row = await prisma.user.findUnique({ where: { id: user.id } });
  if (!row) throw new Error('User not found');
  return row;
}

async function boxView(userId: string, id: string) {
  return (await prismaCliStore.listBoxes(userId)).find(b => b.id === id) ?? null;
}

async function projectView(userId: string, id: string) {
  return (await prismaCliStore.listProjects(userId)).find(p => p.id === id) ?? null;
}

/**
 * The routes only the desktop app calls (workstreams, clone retry, hibernate)
 * answer as if they weren't there unless desktop-app-enabled is on for the
 * owner and the box, as the desktop's own bridge does.
 */
const DESKTOP_OFF: RouteResult = {
  status: 404,
  body: { error: 'No such CLI endpoint; this termag CLI may be newer than the orchestrator', code: 'not_found' },
};

async function desktopOff(user: CliUser, boxId: string | null): Promise<boolean> {
  if (!boxId) return true;
  const [owner, box] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id } }),
    prisma.instance.findFirst({ where: { id: boxId, userId: user.id }, select: { id: true, name: true, kind: true } }),
  ]);
  return !owner || !box || !(await desktopAppEnabled(owner, box));
}

async function projectBox(user: CliUser, projectId: string): Promise<string | null> {
  const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { instanceId: true } });
  return project?.instanceId ?? null;
}

/**
 * What refuseParkedBox does for the cookie routes: a project's own (not
 * archived) row, and 409 box_not_ready while its box is parked or on its way.
 */
async function parkedRefusal(user: CliUser, projectId: string): Promise<RouteResult | null> {
  const owned = await prisma.project.findFirst({
    where: { id: projectId, userId: user.id, archived: false },
    select: { instance: { select: { status: true } } },
  });
  if (!owned) return { status: 404, body: { error: 'Project not found', code: 'not_found' } };
  const parked = owned.instance ? powerStateError(owned.instance.status) : null;
  return parked ? { status: 409, body: { error: parked, code: 'box_not_ready' } } : null;
}

/** A workstream handler's refusal, with a code by status where it named none. */
function workstreamError(result: RouteResult): RouteResult {
  const out = cliErrorResult(result);
  const body = out.body as { code?: string };
  if (!body.code) {
    body.code = ({ 400: 'invalid_request', 404: 'not_found', 503: 'box_not_ready' } as Record<number, string>)[out.status] ?? 'failed';
  }
  return out;
}

/**
 * A workstream's directory as the box sees it: through its agent's path_remap
 * (the t3-paths RPC, as t3/projects asks it) when the agent has one, else as
 * the orchestrator names it, which is the same path on every box without a remap.
 */
async function boxDirectory(userId: string, projectId: string, name: string): Promise<{ directory: string; exists: boolean }> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { name: true, instanceId: true, user: { select: { unixUsername: true } }, instance: { select: { hostHome: true } } },
  });
  if (!project) throw new Error('Project not found');
  const directory = projectDirFor(project, name);
  const agent = project.instanceId ? instanceAgentTransport(project.instanceId) : null;
  if (!project.instanceId || !agent?.capabilities.includes(T3_CAPABILITY)) return { directory, exists: true };
  try {
    const [seen] = await sendToInstanceAgent(project.instanceId, 't3-paths', { paths: [directory] }, 10_000) as Array<{ path: string | null; exists: boolean }>;
    // Normalized like t3/projects: t3 matches a workspace by its exact path.
    return { directory: posix.normalize(seen?.path ?? directory), exists: seen?.exists ?? true };
  } catch {
    return { directory, exists: true };
  }
}

function idOf(body: unknown, key?: string): string {
  const obj = (key ? (body as Record<string, unknown>)[key] : body) as { id: string };
  return obj.id;
}

export const prismaCliLifecycle: CliLifecycle = {
  async createBox(user, name, parentInstanceId) {
    // Without provisioning, the cookie route hands back a raw token for a
    // hand-built box. The CLI only makes EC2 boxes, so it never asks for one.
    if (!isBoxProvisioningConfigured()) {
      return {
        status: 409,
        body: { error: 'This orchestrator has no box provisioning configured', code: 'provisioning_unconfigured' },
      };
    }
    const result = await createBox(await fullUser(user), { name, kind: 'ec2' }, { parentInstanceId });
    if (result.status !== 201) return cliErrorResult(result);
    const claimed = (result.body as { claimed?: boolean }).claimed === true;
    return { status: 201, body: { box: await boxView(user.id, idOf(result.body, 'instance')), claimed } };
  },

  async boxParent(user, boxId) {
    const box = await prisma.instance.findFirst({ where: { id: boxId, userId: user.id }, select: { parentInstanceId: true } });
    return box ? box.parentInstanceId : undefined;
  },

  async projectRepoUrl(user, box, project) {
    const rows = await prisma.project.findMany({
      where: {
        archived: false,
        name: project,
        instance: { name: box },
        OR: [{ userId: user.id }, { shares: { some: { userId: user.id } } }],
      },
      select: {
        id: true, name: true, userId: true, repoUrl: true, instanceId: true,
        instance: { select: { name: true, hostHome: true } },
        user: { select: { unixUsername: true } },
      },
    });
    const picked = pickTarget(rows.map(p => ({
      projectId: p.id, projectName: p.name, boxName: p.instance?.name ?? null,
      ownerUsername: p.user.unixUsername, isOwner: p.userId === user.id,
    })), { box, project, workstream: null });
    if ('error' in picked) {
      return { status: picked.status, body: { error: picked.error, code: picked.status === 404 ? 'not_found' : 'ambiguous' } };
    }
    const p = rows.find(r => r.id === picked.projectId)!;
    if (p.repoUrl) return { repoUrl: p.repoUrl };
    const none = `${box}/${project} has no GitHub repository on record`;
    const unknown = (error: string) => ({ status: 409, body: { error, code: 'no_repository' } });
    // The live origin is whatever the source box's owner set it to, so only
    // that owner may have it choose the repository cloned onto their box.
    if (p.userId !== user.id) return unknown(`${none}; only its owner can start from its checkout's origin`);
    if (!p.instanceId || !instanceAgentTransport(p.instanceId)) return unknown(`${none}, and ${box} is not connected to say which it is`);
    try {
      const cwd = projectDirFor({ name: p.name, user: p.user, instance: p.instance }, 'main');
      const state = await sendToInstanceAgent(p.instanceId, 'git-branch-state', { cwd }, 10_000);
      // get-url expands insteadOf, so a box's origin may read as the GitHub broker.
      const repo = repoFromOrigin(state?.origin);
      return repo ? { repoUrl: `https://github.com/${repo}` } : unknown(`${none}, and its checkout's origin is not on GitHub`);
    } catch (e) {
      return unknown(`${none}, and ${box} could not say: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  async powerBox(user, boxId, action) {
    if (action === 'hibernate' && await desktopOff(user, boxId)) return DESKTOP_OFF;
    const result = await powerOwnedBox(await fullUser(user), boxId, action);
    if (result.status !== 202) return cliErrorResult(result);
    return { status: 202, body: { box: await boxView(user.id, boxId) } };
  },

  async setBoxLifecycle(user, boxId, settings) {
    const result = await setOwnedBoxLifecycle(await fullUser(user), boxId, settings);
    if (result.status !== 200) return cliErrorResult(result);
    return result;
  },

  async removeBox(user, boxId, confirmed) {
    const result = await terminateOwnedBox(await fullUser(user), boxId, confirmed);
    if (result.status !== 200) return cliErrorResult(result);
    const body = result.body as { archivedProjects?: number; alreadyTerminated?: boolean };
    return {
      status: 200,
      body: { ok: true, archivedProjects: body.archivedProjects ?? 0, alreadyTerminated: body.alreadyTerminated === true },
    };
  },

  async renameBox(user, boxId, name) {
    const result = await renameOwnedBox(await fullUser(user), boxId, name);
    if (result.status !== 200) return cliErrorResult(result);
    return { status: 200, body: { box: await boxView(user.id, boxId) } };
  },

  async createProject(user, { boxId, name, agent, repoUrl }) {
    const result = await createProjectFor(await fullUser(user), {
      name, instanceId: boxId, initialAgent: { enabled: true, provider: agent }, repoUrl,
    });
    if (result.status !== 201 && result.status !== 200) return cliErrorResult(result);
    const restored = (result.body as { restored?: boolean }).restored === true;
    // An un-archived project keeps its old directory; only a fresh one is cloned.
    return {
      status: result.status,
      body: { project: await projectView(user.id, idOf(result.body)), restored, repoUrl: restored ? null : repoUrl ?? null },
    };
  },

  async renameProject(user, projectId, name) {
    const result = await renameOwnedProject(await fullUser(user), projectId, name);
    if (result.status !== 200) return cliErrorResult(result);
    return { status: 200, body: { project: await projectView(user.id, projectId) } };
  },

  async archiveProject(user, projectId) {
    const result = await archiveOwnedProject(await fullUser(user), projectId);
    if (result.status !== 200) return cliErrorResult(result);
    return { status: 200, body: { ok: true } };
  },

  async createWorkstream(user, projectId, request) {
    if (await desktopOff(user, await projectBox(user, projectId))) return DESKTOP_OFF;
    const owner = await fullUser(user);
    const result = await createCliWorkstream(request, {
      create: input => createWorkstreamFor(owner, projectId, input),
      locate: name => boxDirectory(user.id, projectId, name),
    });
    return result.status === 201 ? result : workstreamError(result);
  },

  async removeWorkstream(user, projectId, name, { force, keepBranch }) {
    if (await desktopOff(user, await projectBox(user, projectId))) return DESKTOP_OFF;
    const refused = await parkedRefusal(user, projectId);
    if (refused) return refused;
    const workstream = await prisma.workstream.findFirst({
      where: { projectId, name, project: { userId: user.id } },
      select: { id: true },
    });
    if (!workstream) return { status: 404, body: { error: 'Workstream not found', code: 'not_found' } };
    const result = await removeWorkstreamFor(await fullUser(user), projectId, workstream.id, { force, keepBranch });
    if (result.status !== 200) return workstreamError(result);
    const body = result.body as { branchDeleteWarning?: string | null };
    return { status: 200, body: { ok: true, branchDeleteWarning: body.branchDeleteWarning ?? null } };
  },

  async retryClone(user, projectId) {
    if (await desktopOff(user, await projectBox(user, projectId))) return DESKTOP_OFF;
    const refused = await parkedRefusal(user, projectId);
    if (refused) return refused;
    const result = await retryCloneFor(await fullUser(user), projectId);
    if (result.status !== 202) return cliErrorResult(result);
    // A relaunch moves the project to a new box; the view follows it there.
    return { status: 202, body: { project: await projectView(user.id, projectId) } };
  },
};
