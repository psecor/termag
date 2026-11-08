import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  agentSpawn: { findFirst: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  project: { findUnique: vi.fn() },
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('./spawnEvents', () => ({ recordSpawnEvent: vi.fn(async () => {}), sweepSpawnEvents: vi.fn(async () => 0) }));

import { claimSpawnLaunch, releaseSpawnLaunch, spawnTelemetryFor, unparkOnLaunch } from './agentSpawnStore';

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

describe('unparkOnLaunch', () => {
  beforeEach(() => { prisma.agentSpawn.findMany.mockReset(); prisma.agentSpawn.updateMany.mockReset(); });
  it('unparks a parked spawn whose pane is being launched by another path, compare-and-set', async () => {
    const parkedAt = new Date();
    prisma.agentSpawn.findMany.mockResolvedValue([{ id: 'ck3', parkedAt, rootSpawnId: 'ck3', childInstanceId: 'b1' }]);
    prisma.agentSpawn.updateMany.mockResolvedValue({ count: 1 });
    await unparkOnLaunch('u1', 'p1', 'ws');
    expect(prisma.agentSpawn.findMany.mock.calls[0][0].where).toMatchObject({ userId: 'u1', childProjectId: 'p1', childWorkstream: 'ws', retiredAt: null });
    expect(prisma.agentSpawn.updateMany.mock.calls[0][0]).toEqual({ where: { id: 'ck3', parkedAt }, data: { parkedAt: null, keptReason: null, endedAt: null } });
  });

  it('does nothing without a project, and never throws', async () => {
    await unparkOnLaunch('u1', null, 'ws');
    expect(prisma.agentSpawn.findMany).not.toHaveBeenCalled();
    prisma.agentSpawn.findMany.mockRejectedValue(new Error('db down'));
    await expect(unparkOnLaunch('u1', 'p1', 'ws')).resolves.toBeUndefined();
  });
});

describe('spawnTelemetryFor', () => {
  const k = { userId: 'u1', projectId: 'p1', workstream: 'add-tests' };
  beforeEach(() => {
    prisma.agentSpawn.findFirst.mockReset();
    prisma.project.findUnique.mockReset();
  });

  it('names the newest spawn of the workstream, its root, depth and parent by project name', async () => {
    prisma.agentSpawn.findFirst.mockResolvedValue({ id: 'ck2', rootSpawnId: 'ck1', depth: 2, parentProjectId: 'pp', parentWorkstream: 'main', parentInstanceId: 'box1' });
    prisma.project.findUnique.mockResolvedValue({ name: 'termag' });
    await expect(spawnTelemetryFor(k)).resolves.toEqual({ id: 'ck2', root: 'ck1', depth: 2, parentProject: 'termag', parentWorkstream: 'main', parentBox: 'box1' });
    const q = prisma.agentSpawn.findFirst.mock.calls[0][0];
    // Any launch of the workstream, claimed or not: a resume stays in its tree.
    // A later failed or retired attempt never takes the live spawn's place.
    expect(q.where).toEqual({ userId: 'u1', childProjectId: 'p1', childWorkstream: 'add-tests', retiredAt: null, state: { not: 'failed' } });
    expect(q.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('is its own root without one, and has no parent project when the parent is gone', async () => {
    prisma.agentSpawn.findFirst.mockResolvedValue({ id: 'ck1', rootSpawnId: null, depth: 1, parentProjectId: 'gone', parentWorkstream: 'main', parentInstanceId: null });
    prisma.project.findUnique.mockResolvedValue(null);
    await expect(spawnTelemetryFor(k)).resolves.toMatchObject({ id: 'ck1', root: 'ck1', parentProject: null });
  });

  it('is null for a workstream no spawn made, with no project, or on a failed lookup', async () => {
    prisma.agentSpawn.findFirst.mockResolvedValue(null);
    await expect(spawnTelemetryFor(k)).resolves.toBeNull();
    await expect(spawnTelemetryFor({ ...k, projectId: null })).resolves.toBeNull();
    prisma.agentSpawn.findFirst.mockRejectedValue(new Error('db down'));
    await expect(spawnTelemetryFor(k)).resolves.toBeNull();
  });
});
