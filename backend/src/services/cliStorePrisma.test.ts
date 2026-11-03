import { describe, it, expect, vi, beforeEach } from 'vitest';

// GET /api/cli/v1/boxes and /projects answer with these lists (routes/cliApi.ts).
const prisma = vi.hoisted(() => ({
  instance: { findMany: vi.fn() },
  project: { findMany: vi.fn() },
  user: { findUnique: vi.fn() },
  boxEvent: { findMany: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('./agentRegistry', () => ({ isInstanceAgentConnected: () => true }));
vi.mock('./status', () => ({ getAllStatuses: () => new Map() }));
// box-auto-lifecycle-enabled is on; every other flag reads its fallback.
vi.mock('./featureFlags', () => ({
  boolVariation: async (key: string, _user: unknown, fallback: boolean) => key === 'box-auto-lifecycle-enabled' || fallback,
  numberVariation: async (_key: string, _user: unknown, fallback: number) => fallback,
}));

import { prismaCliStore } from './cliStorePrisma';

const T = new Date('2026-10-29T12:00:00Z');
const box = (id: string, createdFor: string | null) => ({
  id, name: id, kind: 'ec2', status: 'ready', provisioningError: null, ec2InstanceId: null, region: null,
  hostUnixUser: 'fabian', createdAt: T, readyAt: T, size: null, instanceType: null, createdFor, projects: [],
});
const fabian = { id: 'u1', googleEmail: 'fabian@example.com', displayName: 'Fabian', unixUsername: 'fabian', defaultAgentProvider: 'claude' };
const project = (id: string, createdFor: string | null) => ({
  id, name: 'webapp', instanceId: id, lastActiveAt: T, repoUrl: null, setupStatus: 'ready', setupError: null, createdFor,
  instance: { id, name: id, hostHome: null, kind: 'ec2', status: 'ready', provisioningError: null },
  user: { unixUsername: 'fabian' }, workstreams: [], workflows: [],
});

describe('prismaCliStore lists', () => {
  beforeEach(() => vi.clearAllMocks());

  it("gives each box's createdFor: 'ask' for an ask box, null otherwise", async () => {
    prisma.instance.findMany.mockResolvedValue([box('ask-box', 'ask'), box('devbox', null)]);
    const boxes = await prismaCliStore.listBoxes('u1');
    expect(boxes.map(b => [b.name, b.createdFor])).toEqual([['ask-box', 'ask'], ['devbox', null]]);
  });

  it('says when auto-park stops each box, as the web list does', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T });
    prisma.user.findUnique.mockResolvedValue(fabian);
    prisma.instance.findMany.mockResolvedValue([{
      ...box('devbox', null), userId: 'u1', ec2InstanceId: 'i-1', idleHibernateHours: 4,
      lastActivityAt: new Date(T.getTime() - 60 * 60_000),
    }]);
    const [devbox] = await prismaCliStore.listBoxes('u1');
    expect(devbox.lifecycle).toMatchObject({
      idleLimitHours: 4, idleLimitSource: 'own', parkAction: 'stop',
      parkAt: new Date(T.getTime() + 3 * 60 * 60_000).toISOString(),
    });
    vi.useRealTimers();
  });

  it("lists the boxes without a lifecycle when their owner can't be read", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.instance.findMany.mockResolvedValue([box('devbox', null)]);
    expect((await prismaCliStore.listBoxes('u1')).map(b => b.lifecycle)).toEqual([null]);
  });

  it("gives each project's createdFor: 'ask' for an ask project, null otherwise", async () => {
    prisma.project.findMany.mockResolvedValue([project('ask-box', 'ask'), project('devbox', null)]);
    const projects = await prismaCliStore.listProjects('u1');
    expect(prisma.project.findMany.mock.calls[0][0].select.createdFor).toBe(true);
    expect(projects.map(p => [p.ref, p.createdFor])).toEqual([['ask-box/webapp', 'ask'], ['devbox/webapp', null]]);
  });
});
