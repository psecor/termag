import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CliUser } from '../services/cliStore';

const instances = new Map<string, { id: string; name: string; kind: string; userId: string }>();
const projects = new Map<string, { instanceId: string | null; userId: string; boxStatus?: string }>();
vi.mock('../db', () => ({
  prisma: {
    user: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, googleEmail: `${where.id}@x`, displayName: where.id, unixUsername: where.id, defaultAgentProvider: 'claude' }) },
    instance: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) => {
        const row = instances.get(where.id);
        return row && row.userId === where.userId ? { id: row.id, name: row.name, kind: row.kind } : null;
      },
    },
    project: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) => {
        const row = projects.get(where.id);
        return row && row.userId === where.userId
          ? { instanceId: row.instanceId, instance: row.boxStatus ? { status: row.boxStatus } : null }
          : null;
      },
    },
    workstream: { findFirst: async () => ({ id: 'ws1' }) },
  },
}));
const flag = vi.hoisted(() => ({ on: false, asked: [] as string[] }));
vi.mock('../services/desktopAppFlag', () => ({
  T3_CAPABILITY: 't3-v1',
  desktopAppEnabled: async (_user: unknown, box: { id: string }) => { flag.asked.push(box.id); return flag.on; },
}));
const calls = vi.hoisted(() => [] as string[]);
vi.mock('./instances', () => ({
  createBox: vi.fn(), renameOwnedBox: vi.fn(), setOwnedBoxLifecycle: vi.fn(), terminateOwnedBox: vi.fn(),
  powerOwnedBox: async (_user: unknown, _boxId: string, action: string) => { calls.push(`power:${action}`); return { status: 202, body: {} }; },
}));
vi.mock('./projects', () => ({
  archiveOwnedProject: vi.fn(), createProjectFor: vi.fn(), renameOwnedProject: vi.fn(),
  retryCloneFor: async () => { calls.push('retryClone'); return { status: 202, body: {} }; },
}));
vi.mock('./workstreams', () => ({
  createWorkstreamFor: async () => { calls.push('createWorkstream'); return { status: 201, body: {} }; },
  removeWorkstreamFor: async () => { calls.push('removeWorkstream'); return { status: 200, body: {} }; },
}));
vi.mock('../services/cliWorkstreams', () => ({
  createCliWorkstream: async (_req: unknown, deps: { create: (input: unknown) => Promise<unknown> }) => { await deps.create({}); return { status: 201, body: {} }; },
}));
vi.mock('../services/cliStorePrisma', () => ({ prismaCliStore: { listBoxes: async () => [], listProjects: async () => [] } }));
vi.mock('../services/agentRegistry', () => ({ instanceAgentTransport: () => null, sendToInstanceAgent: async () => null }));
vi.mock('../services/boxProvisioner', () => ({ isBoxProvisioningConfigured: () => true }));
vi.mock('../services/agentMessages', () => ({ pickTarget: vi.fn() }));
vi.mock('../services/prBranches', () => ({ repoFromOrigin: vi.fn() }));

const { prismaCliLifecycle } = await import('./cliLifecyclePrisma');

const alice: CliUser = { id: 'alice', googleEmail: 'alice@x', unixUsername: 'alice', displayName: 'alice' };

beforeEach(() => {
  flag.on = false;
  flag.asked = [];
  calls.length = 0;
  instances.clear();
  projects.clear();
  instances.set('b1', { id: 'b1', name: 'dev', kind: 'ec2', userId: 'alice' });
  projects.set('p1', { instanceId: 'b1', userId: 'alice' });
  projects.set('local', { instanceId: null, userId: 'alice' });
});

describe('the desktop-only CLI routes, behind desktop-app-enabled', () => {
  it('answer 404 not_found while the flag is off, and do nothing', async () => {
    const results = await Promise.all([
      prismaCliLifecycle.createWorkstream(alice, 'p1', { name: 'feat' }),
      prismaCliLifecycle.removeWorkstream(alice, 'p1', 'feat', { force: false, keepBranch: true }),
      prismaCliLifecycle.retryClone(alice, 'p1'),
      prismaCliLifecycle.powerBox(alice, 'b1', 'hibernate'),
    ]);
    for (const r of results) expect(r).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect(calls).toEqual([]);
    expect(flag.asked).toEqual(['b1', 'b1', 'b1', 'b1']);
  });

  it('go through once the flag is on for the box', async () => {
    flag.on = true;
    expect((await prismaCliLifecycle.powerBox(alice, 'b1', 'hibernate')).status).toBe(202);
    await prismaCliLifecycle.removeWorkstream(alice, 'p1', 'feat', { force: false, keepBranch: true });
    expect(calls).toEqual(['power:hibernate', 'removeWorkstream']);
  });

  it('refuse a project with no box, and a box that is not the caller\'s', async () => {
    flag.on = true;
    expect(await prismaCliLifecycle.retryClone(alice, 'local')).toMatchObject({ status: 404, body: { code: 'not_found' } });
    const bob: CliUser = { ...alice, id: 'bob' };
    expect(await prismaCliLifecycle.powerBox(bob, 'b1', 'hibernate')).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect(calls).toEqual([]);
  });

  it('refuse a parked box with 409, as the cookie routes do, before touching the worktree', async () => {
    flag.on = true;
    for (const boxStatus of ['stopped', 'hibernating']) {
      projects.set('p1', { instanceId: 'b1', userId: 'alice', boxStatus });
      expect(await prismaCliLifecycle.removeWorkstream(alice, 'p1', 'feat', { force: false, keepBranch: true }))
        .toMatchObject({ status: 409, body: { code: 'box_not_ready' } });
      expect(await prismaCliLifecycle.retryClone(alice, 'p1')).toMatchObject({ status: 409, body: { code: 'box_not_ready' } });
    }
    expect(calls).toEqual([]);
  });

  it('never ask the flag for start and stop', async () => {
    await prismaCliLifecycle.powerBox(alice, 'b1', 'start');
    await prismaCliLifecycle.powerBox(alice, 'b1', 'stop');
    expect(calls).toEqual(['power:start', 'power:stop']);
    expect(flag.asked).toEqual([]);
  });
});
