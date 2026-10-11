/**
 * CliLifecycle over the functions the cookie routes call (routes/instances.ts,
 * routes/projects.ts). Successes are re-read and shaped into the CLI's views
 * (services/cliViews.ts); failures pass through cliErrorResult, so nothing but
 * the error, a code and a project list ever reaches the CLI.
 */
import { prisma } from '../db';
import { isBoxProvisioningConfigured } from '../services/boxProvisioner';
import type { CliUser } from '../services/cliStore';
import { prismaCliStore } from '../services/cliStorePrisma';
import { cliErrorResult, type CliLifecycle } from './cliLifecycle';
import { createBox, powerOwnedBox, terminateOwnedBox } from './instances';
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
  async createBox(user, name) {
    // Without provisioning, the cookie route hands back a raw token for a
    // hand-built box. The CLI only makes EC2 boxes, so it never asks for one.
    if (!isBoxProvisioningConfigured()) {
      return {
        status: 409,
        body: { error: 'This orchestrator has no box provisioning configured', code: 'provisioning_unconfigured' },
      };
    }
    const result = await createBox(await fullUser(user), { name, kind: 'ec2' });
    if (result.status !== 201) return cliErrorResult(result);
    const claimed = (result.body as { claimed?: boolean }).claimed === true;
    return { status: 201, body: { box: await boxView(user.id, idOf(result.body, 'instance')), claimed } };
  },

  async powerBox(user, boxId, action) {
    const result = await powerOwnedBox(await fullUser(user), boxId, action);
    if (result.status !== 202) return cliErrorResult(result);
    return { status: 202, body: { box: await boxView(user.id, boxId) } };
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

  async createProject(user, { boxId, name, agent }) {
    const result = await createProjectFor(await fullUser(user), {
      name, instanceId: boxId, initialAgent: { enabled: true, provider: agent },
    });
    if (result.status !== 201 && result.status !== 200) return cliErrorResult(result);
    const restored = (result.body as { restored?: boolean }).restored === true;
    return { status: result.status, body: { project: await projectView(user.id, idOf(result.body)), restored } };
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
