import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  agentSpawn: { findFirst: vi.fn(), updateMany: vi.fn() },
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('./spawnEvents', () => ({ recordSpawnEvent: vi.fn(async () => {}), sweepSpawnEvents: vi.fn(async () => 0) }));

import { claimSpawnLaunch, releaseSpawnLaunch } from './agentSpawnStore';

const key = { userId: 'u1', projectId: 'p1', workstream: 'add-tests', provider: 'claude' };

describe('claimSpawnLaunch', () => {
  beforeEach(() => {
    prisma.agentSpawn.findFirst.mockReset();
    prisma.agentSpawn.updateMany.mockReset();
  });

  it('types the brief launch for an unclaimed spawn of this pane and marks it running', async () => {
    prisma.agentSpawn.findFirst.mockResolvedValue({ id: 'ck1' });
    prisma.agentSpawn.updateMany.mockResolvedValue({ count: 1 });
    await expect(claimSpawnLaunch(key)).resolves.toEqual({ id: 'ck1', command: 'claude "$(cat "$HOME/.termag/spawn-prompts/ck1.md")"' });
    const where = prisma.agentSpawn.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ userId: 'u1', childProjectId: 'p1', childWorkstream: 'add-tests', provider: 'claude', launchedAt: null, state: 'starting' });
    expect(where).not.toHaveProperty('childProjectName');
    expect(prisma.agentSpawn.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'ck1', launchedAt: null }, data: { state: 'running' } });
  });

  it('is a plain launch when there is no spawn, or another launch claimed it first', async () => {
    prisma.agentSpawn.findFirst.mockResolvedValue(null);
    await expect(claimSpawnLaunch(key)).resolves.toBeNull();
    prisma.agentSpawn.findFirst.mockResolvedValue({ id: 'ck1' });
    prisma.agentSpawn.updateMany.mockResolvedValue({ count: 0 });
    await expect(claimSpawnLaunch(key)).resolves.toBeNull();
  });

  it('claims by spawn id when the caller has one, so racing spawns never swap briefs', async () => {
    prisma.agentSpawn.findFirst.mockResolvedValue({ id: 'ck2' });
    prisma.agentSpawn.updateMany.mockResolvedValue({ count: 1 });
    await claimSpawnLaunch({ ...key, spawnId: 'ck2' });
    const where = prisma.agentSpawn.findFirst.mock.calls[0][0].where;
    // By id it must still be this project's spawn: a stray id never lands a brief elsewhere.
    expect(where).toMatchObject({ id: 'ck2', childProjectId: 'p1' });
  });

  it('claims nothing with neither a spawn id nor a project id', async () => {
    await expect(claimSpawnLaunch({ ...key, projectId: null })).resolves.toBeNull();
    expect(prisma.agentSpawn.findFirst).not.toHaveBeenCalled();
  });

  it('hands back a claim whose launch failed, unless the child already reported', async () => {
    prisma.agentSpawn.updateMany.mockResolvedValue({ count: 1 });
    await releaseSpawnLaunch('ck1');
    expect(prisma.agentSpawn.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'ck1', state: 'running', reportedAt: null },
      data: { launchedAt: null, state: 'starting' },
    });
  });

  it('never throws: a failed lookup is a plain launch', async () => {
    prisma.agentSpawn.findFirst.mockRejectedValue(new Error('db down'));
    await expect(claimSpawnLaunch(key)).resolves.toBeNull();
  });
});
