import { prisma } from '../db';
import { validateAgentToken } from '../routes/agentTokens';
import { isInstanceAgentConnected } from './agentRegistry';
import { getAllStatuses } from './status';
import { statusKey } from './statusKey';
import { sessionName } from './tmux';
import { boxCredentialFromAgentToken, type CliStore, type CliUser } from './cliStore';
import { shapeBox, shapeProject, type CliProject } from './cliViews';

const userSelect = { id: true, googleEmail: true, unixUsername: true, displayName: true } as const;

function toCliUser(u: CliUser): CliUser {
  return { id: u.id, googleEmail: u.googleEmail, unixUsername: u.unixUsername, displayName: u.displayName };
}

export const prismaCliStore: CliStore = {
  async createSession({ userId, deviceName, tokenHash, tokenPrefix, now }) {
    const [, row] = await prisma.$transaction([
      prisma.cliSession.updateMany({
        where: { userId, deviceName, revokedAt: null },
        data: { revokedAt: now },
      }),
      prisma.cliSession.create({
        data: { userId, deviceName, tokenHash, tokenPrefix, createdAt: now, lastUsedAt: now },
        include: { user: { select: userSelect } },
      }),
    ]);
    return row;
  },

  async findSessionByHash(tokenHash) {
    return prisma.cliSession.findUnique({
      where: { tokenHash },
      include: { user: { select: userSelect } },
    });
  },

  async findSessionById(id) {
    return prisma.cliSession.findUnique({
      where: { id },
      include: { user: { select: userSelect } },
    });
  },

  async touchSession(id, now) {
    await prisma.cliSession.update({ where: { id }, data: { lastUsedAt: now } });
  },

  async revokeSession(id, now) {
    await prisma.cliSession.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now } });
  },

  async validateAgentToken(rawToken) {
    const box = boxCredentialFromAgentToken(await validateAgentToken(rawToken));
    return box && { user: toCliUser(box.user), instanceId: box.instanceId };
  },

  async listBoxes(userId) {
    const rows = await prisma.instance.findMany({
      where: { userId, status: { not: 'terminated' } },
      select: {
        id: true, name: true, kind: true, status: true, provisioningError: true,
        ec2InstanceId: true, region: true, hostUnixUser: true, createdAt: true, readyAt: true,
        projects: { where: { archived: false }, select: { id: true, name: true }, orderBy: { name: 'asc' } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(r => shapeBox(r, isInstanceAgentConnected(r.id)));
  },

  async listProjects(userId) {
    const rows = await prisma.project.findMany({
      where: { userId, archived: false },
      select: {
        id: true, name: true, instanceId: true, lastActiveAt: true,
        instance: { select: { id: true, name: true, hostHome: true } },
        user: { select: { unixUsername: true } },
        workstreams: { where: { archived: false }, select: { name: true }, orderBy: { createdAt: 'asc' } },
        workflows: { where: { type: 'agent' }, select: { provider: true } },
      },
      orderBy: [{ pinned: 'desc' }, { lastActiveAt: 'desc' }],
    });
    // Read the raw map: getStatus() fabricates entries for unknown sessions.
    const statuses = getAllStatuses();
    const out: CliProject[] = [];
    for (const r of rows) {
      const session = sessionName(r.user.unixUsername, r.name, 'agent', 'main');
      const view = shapeProject(r, statuses.get(statusKey(r.instanceId, session)), {
        agent: session,
        ctrl: sessionName(r.user.unixUsername, r.name, 'ctrl', 'main'),
      });
      if (view) out.push(view);
    }
    return out;
  },

  async listDevices(userId) {
    return prisma.cliSession.findMany({
      where: { userId, revokedAt: null },
      select: { id: true, deviceName: true, tokenPrefix: true, createdAt: true, lastUsedAt: true, revokedAt: true },
      orderBy: { lastUsedAt: 'desc' },
    });
  },

  async revokeDevice(userId, id, now) {
    const result = await prisma.cliSession.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: now },
    });
    return result.count > 0;
  },
};
