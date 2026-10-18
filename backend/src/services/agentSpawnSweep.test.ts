import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  agentSpawn: { findMany: vi.fn(), updateMany: vi.fn() },
  project: { findFirst: vi.fn(), findMany: vi.fn() },
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('./spawnEvents', () => ({ recordSpawnEvent: vi.fn(async () => {}), sweepSpawnEvents: vi.fn(async () => 0) }));
vi.mock('./agentRegistry', () => ({
  isProjectAgentConnected: vi.fn(() => true),
  sendForProject: vi.fn(async () => ({ ok: true })),
  sendToInstanceAgent: vi.fn(async () => ({ sessions: [] })),
}));
vi.mock('./status', () => ({ getStatus: vi.fn(() => ({ status: 'idle' })) }));
vi.mock('./humanActivity', () => ({ lastHumanHeartbeat: vi.fn(() => null) }));
vi.mock('./spawnGaugeSnapshot', () => ({ buildGaugeSnapshot: vi.fn() }));
vi.mock('./spawnMetrics', () => ({ setGaugeSnapshot: vi.fn(), timedSweep: vi.fn((_s: string, fn: () => unknown) => fn()) }));

import { refreshGaugeSnapshot, runSpawnEndTick, runSpawnNudgeTick, stopSpawnNudgeSweep, sweepGeneration } from './agentSpawnSweep';
import { buildGaugeSnapshot } from './spawnGaugeSnapshot';
import { setGaugeSnapshot } from './spawnMetrics';
import { recordSpawnEvent } from './spawnEvents';
import { sendForProject, sendToInstanceAgent } from './agentRegistry';
import { getStatus } from './status';

const now = Date.parse('2026-10-16T12:00:00Z');
const row = {
  id: 'ck1', userId: 'u1', relationship: 'delegate', parentProjectId: 'p1', parentWorkstream: 'main', parentRole: 'agent',
  parentSession: 'me-proj-agent', childProjectName: 'proj', childWorkstream: 'add-tests', state: 'done',
  reportedAt: new Date(now - 60_000), nudgedAt: null,
};

describe('runSpawnNudgeTick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.agentSpawn.findMany.mockResolvedValue([row]);
    prisma.agentSpawn.updateMany.mockResolvedValue({ count: 1 });
    prisma.project.findFirst.mockResolvedValue({ name: 'proj', instanceId: 'box1', user: { unixUsername: 'me' } });
    vi.mocked(getStatus).mockReturnValue({ status: 'idle' } as never);
  });

  it('reads only rows not yet nudged for their latest report', async () => {
    await runSpawnNudgeTick(now);
    expect(prisma.agentSpawn.findMany.mock.calls[0][0].where).toMatchObject({ relationship: 'delegate', nudgedAt: null });
  });

  it('claims, then types the fixed line into the idle parent agent pane', async () => {
    expect(await runSpawnNudgeTick(now)).toBe(1);
    expect(prisma.agentSpawn.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'ck1', nudgedAt: null } });
    const [, cmd, args] = vi.mocked(sendForProject).mock.calls[0];
    expect(cmd).toBe('tmux-send-keys');
    expect(args).toMatchObject({ sessionName: 'me-proj-agent', literal: true, withEnter: true });
    expect((args as { keys: string }).keys).toBe('[termag] delegate proj/add-tests reported done. Call list_spawns (metaterm MCP server) to read its report.');
  });

  it('types nothing when another process claimed it first', async () => {
    prisma.agentSpawn.updateMany.mockResolvedValue({ count: 0 });
    expect(await runSpawnNudgeTick(now)).toBe(0);
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('leaves a busy parent for a later tick, and stamps a gone one without typing', async () => {
    vi.mocked(getStatus).mockReturnValue({ status: 'waiting' } as never);
    await runSpawnNudgeTick(now);
    expect(prisma.agentSpawn.updateMany).not.toHaveBeenCalled();
    prisma.project.findFirst.mockResolvedValue(null);
    await runSpawnNudgeTick(now);
    expect(prisma.agentSpawn.updateMany).toHaveBeenCalledTimes(1);
    expect(sendForProject).not.toHaveBeenCalled();
  });
});

describe('runSpawnEndTick', () => {
  const spawn = {
    id: 'ck1', userId: 'u1', childProjectId: 'p1', childProjectName: 'proj', childWorkstream: 'add-tests',
    childInstanceId: 'box1', launchedAt: new Date(now - 3600_000), createdAt: new Date(now - 3600_000),
  };
  const project = (over: Record<string, unknown> = {}) => ({
    id: 'p1', name: 'proj', archived: false, instanceId: 'box1', userId: 'u1', user: { unixUsername: 'me' },
    instance: { status: 'ready' }, workstreams: [{ name: 'add-tests' }], ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.agentSpawn.findMany.mockResolvedValue([spawn]);
    prisma.agentSpawn.updateMany.mockResolvedValue({ count: 1 });
    prisma.project.findMany.mockResolvedValue([project()]);
  });

  it('keeps a spawn whose agent session is live, asking tmux once per box', async () => {
    vi.mocked(sendToInstanceAgent).mockResolvedValue({ sessions: ['me-proj-add-tests-agent'] });
    expect(await runSpawnEndTick(now)).toBe(0);
    expect(sendToInstanceAgent).toHaveBeenCalledTimes(1);
    expect(prisma.agentSpawn.updateMany).not.toHaveBeenCalled();
  });

  it('ends it after the session is missing on two sweeps, and logs how', async () => {
    vi.mocked(sendToInstanceAgent).mockResolvedValue({ sessions: [] });
    expect(await runSpawnEndTick(now)).toBe(0);
    expect(await runSpawnEndTick(now + 60_000)).toBe(1);
    expect(prisma.agentSpawn.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'ck1', endedAt: null } });
    expect(vi.mocked(recordSpawnEvent).mock.calls[0][0]).toMatchObject({ kind: 'ended', reason: 'killed', spawnId: 'ck1' });
  });

  it('pages through every unended spawn, without an age cutoff', async () => {
    const page = (n: number, from: number) => Array.from({ length: n }, (_, k) => ({ ...spawn, id: `ck${String(from + k).padStart(4, '0')}` }));
    prisma.agentSpawn.findMany.mockResolvedValueOnce(page(500, 0)).mockResolvedValueOnce(page(3, 500));
    vi.mocked(sendToInstanceAgent).mockResolvedValue({ sessions: ['me-proj-add-tests-agent'] });
    await runSpawnEndTick(now);
    expect(prisma.agentSpawn.findMany).toHaveBeenCalledTimes(2);
    const [first, second] = prisma.agentSpawn.findMany.mock.calls.map(c => c[0]);
    expect(first.where).not.toHaveProperty('createdAt');
    expect(first).toMatchObject({ orderBy: { id: 'asc' }, take: 500 });
    expect(second).toMatchObject({ cursor: { id: 'ck0499' }, skip: 1 });
  });

  it('ends at once when its workstream was removed', async () => {
    prisma.project.findMany.mockResolvedValue([project({ workstreams: [] })]);
    expect(await runSpawnEndTick(now)).toBe(1);
    expect(vi.mocked(recordSpawnEvent).mock.calls[0][0]).toMatchObject({ reason: 'removed' });
  });
});

describe('refreshGaugeSnapshot', () => {
  const snap = { running: [], finishedRunning: [], limits: [], boxes: [] };
  beforeEach(() => vi.clearAllMocks());

  it('publishes the snapshot it built', async () => {
    vi.mocked(buildGaugeSnapshot).mockResolvedValue(snap);
    await refreshGaugeSnapshot();
    expect(vi.mocked(setGaugeSnapshot).mock.calls).toEqual([[snap]]);
  });

  it('drops a snapshot that was still building when the sweep stopped (a drain)', async () => {
    let finish!: (s: typeof snap) => void;
    vi.mocked(buildGaugeSnapshot).mockReturnValue(new Promise(r => { finish = r; }));
    const refreshing = refreshGaugeSnapshot();
    stopSpawnNudgeSweep();
    finish(snap);
    await refreshing;
    // The stop's null is the last word.
    expect(vi.mocked(setGaugeSnapshot).mock.calls).toEqual([[null]]);
  });

  it('drops it too when the stop came earlier in the same tick, before the refresh began', async () => {
    vi.mocked(buildGaugeSnapshot).mockResolvedValue(snap);
    const tickStarted = sweepGeneration();
    stopSpawnNudgeSweep(); // a drain during the tick's nudge or end work
    vi.mocked(setGaugeSnapshot).mockClear();
    await refreshGaugeSnapshot(tickStarted);
    expect(buildGaugeSnapshot).not.toHaveBeenCalled();
    expect(setGaugeSnapshot).not.toHaveBeenCalled();
  });
});
