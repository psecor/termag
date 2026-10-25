import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  agentSpawn: { findMany: vi.fn(), findFirst: vi.fn() },
  project: { findMany: vi.fn() },
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('./spawnEvents', () => ({ recordSpawnEvent: vi.fn(async () => {}) }));

import { noteStatusTransition, refreshWatchedSessions, resetWatchedSessions, watchLaunchedSpawn, watchSpawnedSession } from './spawnStatusLog';
import { recordSpawnEvent } from './spawnEvents';

describe('spawn status history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWatchedSessions();
    prisma.agentSpawn.findMany.mockResolvedValue([
      { id: 's1', userId: 'u1', rootSpawnId: 'r1', childProjectId: 'p1', childWorkstream: 'leaf' },
      { id: 's2', userId: 'u1', rootSpawnId: 'r1', childProjectId: 'gone', childWorkstream: 'x' },
    ]);
    // Renamed since the spawn: the session is rebuilt from the project's name now.
    prisma.project.findMany.mockResolvedValue([{ id: 'p1', name: 'renamed', instanceId: 'box1', user: { unixUsername: 'me' } }]);
  });

  it('logs a spawned child\'s transitions, and nobody else\'s', async () => {
    expect(await refreshWatchedSessions()).toBe(1);
    expect(prisma.agentSpawn.findMany.mock.calls[0][0].where).toMatchObject({ endedAt: null, retiredAt: null, state: { not: 'failed' } });
    noteStatusTransition('me-renamed-leaf-agent', 'box1', 'working', 'idle');
    noteStatusTransition('me-renamed-leaf-agent', 'box2', 'working', 'idle');
    noteStatusTransition('me-other-agent', 'box1', 'working', 'idle');
    noteStatusTransition('me-renamed-leaf-agent', 'box1', 'idle', 'idle');
    expect(recordSpawnEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordSpawnEvent).mock.calls[0][0]).toEqual({
      kind: 'status', spawnId: 's1', rootSpawnId: 'r1', userId: 'u1', instanceId: 'box1', reason: 'idle', detail: { from: 'working' },
    });
  });

  it('follows a workstream rename from the next refresh on (the rows carry the new name)', async () => {
    await refreshWatchedSessions();
    prisma.agentSpawn.findMany.mockResolvedValue([{ id: 's1', userId: 'u1', rootSpawnId: 'r1', childProjectId: 'p1', childWorkstream: 'leaf2' }]);
    await refreshWatchedSessions();
    noteStatusTransition('me-renamed-leaf-agent', 'box1', 'idle', 'working');
    noteStatusTransition('me-renamed-leaf2-agent', 'box1', 'idle', 'working');
    expect(recordSpawnEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordSpawnEvent).mock.calls[0][0]).toMatchObject({ spawnId: 's1', reason: 'working' });
  });

  it('watches a new spawn at once, and a refresh that was already reading keeps it', async () => {
    watchSpawnedSession({ spawnId: 's9', userId: 'u1', rootSpawnId: 'r1', instanceId: 'box1', session: 'me-renamed-new-agent' });
    noteStatusTransition('me-renamed-new-agent', 'box1', undefined, 'working');
    expect(vi.mocked(recordSpawnEvent).mock.calls[0][0]).toMatchObject({ spawnId: 's9', reason: 'working' });
    // A refresh whose query ran before the spawn was written does not list it.
    let release!: () => void;
    prisma.agentSpawn.findMany.mockImplementationOnce(() => new Promise(r => { release = () => r([]); }));
    const pending = refreshWatchedSessions();
    watchSpawnedSession({ spawnId: 's10', userId: 'u1', rootSpawnId: 'r1', instanceId: 'box1', session: 'me-renamed-late-agent' });
    release();
    await pending;
    noteStatusTransition('me-renamed-late-agent', 'box1', 'idle', 'working');
    expect(vi.mocked(recordSpawnEvent).mock.calls.at(-1)?.[0]).toMatchObject({ spawnId: 's10' });
  });

  it('watches a project spawn again at launch, after a refresh that ran before its row was linked', async () => {
    watchSpawnedSession({ spawnId: 'sp', userId: 'u1', rootSpawnId: 'r1', instanceId: 'box1', session: 'me-newproj-agent' });
    // Its row has no childProjectId yet (the project is still being created): the refresh can't list it.
    prisma.agentSpawn.findMany.mockResolvedValueOnce([]);
    await refreshWatchedSessions();
    noteStatusTransition('me-newproj-agent', 'box1', undefined, 'working');
    expect(recordSpawnEvent).not.toHaveBeenCalled();
    // The launch, once the project exists, watches it again.
    prisma.agentSpawn.findFirst.mockResolvedValueOnce({ id: 'sp', rootSpawnId: 'r1' });
    await watchLaunchedSpawn({ userId: 'u1', projectId: 'pnew', workstream: 'main', session: 'me-newproj-agent', instanceId: 'box1' });
    expect(prisma.agentSpawn.findFirst.mock.calls[0][0].where).toMatchObject({ userId: 'u1', childProjectId: 'pnew', childWorkstream: 'main', retiredAt: null });
    noteStatusTransition('me-newproj-agent', 'box1', 'idle', 'working');
    expect(vi.mocked(recordSpawnEvent).mock.calls[0][0]).toMatchObject({ spawnId: 'sp', reason: 'working' });
  });

  it('watches nothing at launch for a pane no spawn made, and never throws', async () => {
    prisma.agentSpawn.findFirst.mockResolvedValueOnce(null);
    await watchLaunchedSpawn({ userId: 'u1', projectId: 'p1', workstream: 'main', session: 'me-proj-agent', instanceId: 'box1' });
    prisma.agentSpawn.findFirst.mockRejectedValueOnce(new Error('db down'));
    await expect(watchLaunchedSpawn({ userId: 'u1', projectId: 'p1', workstream: 'x', session: 'me-proj-x-agent', instanceId: 'box1' })).resolves.toBeUndefined();
    noteStatusTransition('me-proj-agent', 'box1', undefined, 'working');
    expect(recordSpawnEvent).not.toHaveBeenCalled();
  });

  it('drops a child once a refresh no longer lists it', async () => {
    await refreshWatchedSessions();
    prisma.agentSpawn.findMany.mockResolvedValue([]);
    expect(await refreshWatchedSessions()).toBe(0);
    noteStatusTransition('me-renamed-leaf-agent', 'box1', undefined, 'working');
    expect(recordSpawnEvent).not.toHaveBeenCalled();
  });
});
