import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  agentSpawn: { updateMany: vi.fn(async () => ({ count: 1 })), findMany: vi.fn(), update: vi.fn(async () => ({})) },
  user: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
}));
vi.mock('../db', () => ({ prisma }));

import { renameSpawnProject, renameSpawnWorkstream } from './spawnRenames';

const user = { id: 'u1', unixUsername: 'me' };

describe('carrying renames into agent_spawns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.agentSpawn.findMany.mockResolvedValue([{ id: 's1', parentWorkstream: 'new', parentRole: 'agent' }]);
    prisma.user.findUnique.mockResolvedValue({ spawnOrphanHome: { projectId: 'p1', workstream: 'old' } });
  });

  it('renames a workstream wherever a spawn names it: child, parent, foster, orphan home', async () => {
    await renameSpawnWorkstream(user, { id: 'p1', name: 'proj' }, 'old', 'new');
    expect(prisma.agentSpawn.updateMany.mock.calls.map(c => c[0])).toEqual([
      { where: { userId: 'u1', childProjectId: 'p1', childWorkstream: 'old' }, data: { childWorkstream: 'new' } },
      { where: { userId: 'u1', parentProjectId: 'p1', parentWorkstream: 'old' }, data: { parentWorkstream: 'new' } },
      { where: { userId: 'u1', fosterProjectId: 'p1', fosterWorkstream: 'old' }, data: { fosterWorkstream: 'new' } },
    ]);
    expect(prisma.agentSpawn.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { parentSession: 'me-proj-new-agent' } });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { spawnOrphanHome: { projectId: 'p1', workstream: 'new' } } });
  });

  it('renames a project\'s child name and its parents\' sessions', async () => {
    prisma.agentSpawn.findMany.mockResolvedValue([{ id: 's1', parentWorkstream: 'main', parentRole: 'agent' }]);
    await renameSpawnProject(user, 'p1', 'renamed');
    expect(prisma.agentSpawn.updateMany.mock.calls[0][0]).toEqual({ where: { userId: 'u1', childProjectId: 'p1' }, data: { childProjectName: 'renamed' } });
    expect(prisma.agentSpawn.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { parentSession: 'me-renamed-agent' } });
  });

  it('never fails the rename', async () => {
    prisma.agentSpawn.updateMany.mockRejectedValueOnce(new Error('db down'));
    await expect(renameSpawnWorkstream(user, { id: 'p1', name: 'proj' }, 'old', 'new')).resolves.toBeUndefined();
  });
});
