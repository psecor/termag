/**
 * CliLifecycle over the functions the cookie routes call (routes/instances.ts,
 * routes/projects.ts). Successes are re-read and shaped into the CLI's views
 * (services/cliViews.ts); failures pass through cliErrorResult, so nothing but
 * the error, a code and a project list ever reaches the CLI.
 */
import { prisma } from '../db';
import { pickTarget } from '../services/agentMessages';
import { instanceAgentTransport, sendToInstanceAgent } from '../services/agentRegistry';
import { isBoxProvisioningConfigured } from '../services/boxProvisioner';
import type { CliUser } from '../services/cliStore';
import { prismaCliStore } from '../services/cliStorePrisma';
import { repoFromOrigin } from '../services/prBranches';
import { projectDirFor } from '../services/tmux';
import { cliErrorResult, type CliLifecycle } from './cliLifecycle';
import { createBox, powerOwnedBox, setOwnedBoxLifecycle, terminateOwnedBox } from './instances';
import { archiveOwnedProject, createProjectFor, renameOwnedProject } from './projects';

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
};
