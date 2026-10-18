import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  agentSpawn: {
    findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn(),
    create: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
  },
  project: { findFirst: vi.fn(), findMany: vi.fn() },
  instance: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  spawnEvent: { groupBy: vi.fn() },
  tokenUsageDay: { findMany: vi.fn() },
  hostSample: { findMany: vi.fn() },
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('../middleware/auth', () => ({ requireAuthOrAgentToken: vi.fn() }));
vi.mock('../services/sessionResolver', () => ({
  resolveSessionProject: vi.fn(),
  isAmbiguousSession: (v: unknown) => !!v && (v as { ambiguous?: boolean }).ambiguous === true,
}));
vi.mock('../services/agentRegistry', () => ({ isProjectAgentConnected: vi.fn(() => true), sendForProject: vi.fn(async () => ({ ok: true })) }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => true) }));
vi.mock('../services/status', () => ({ getStatus: vi.fn(() => ({ status: 'idle' })) }));
vi.mock('./projects', () => ({ createProjectFor: vi.fn() }));
vi.mock('../services/spawnEvents', () => ({ recordSpawnEvent: vi.fn(async () => {}) }));
vi.mock('../services/spawnBudget', async () => {
  const { DEFAULT_SPAWN_LIMITS } = await import('../services/spawnLimits');
  return {
    buildBudget: vi.fn(), userBoxReadings: vi.fn(async () => []), spawnLimitsFor: vi.fn(async () => DEFAULT_SPAWN_LIMITS),
    BOX_SELECT: {},
    readings: vi.fn(async (rows: Array<Record<string, unknown>>) => rows.map(r => ({ ...r, sampledAt: r.hostSampledAt, cores: 2, liveAgents: 1 }))),
  };
});
vi.mock('./workstreams', () => ({ createWorkstreamFor: vi.fn() }));

import { reportFor, spawnFor, usageFor } from './spawns';
import { resolveSessionProject } from '../services/sessionResolver';
import { isProjectAgentConnected, sendForProject } from '../services/agentRegistry';
import { boolVariation } from '../services/featureFlags';
import { createProjectFor } from './projects';
import { createWorkstreamFor } from './workstreams';
import { buildBudget, spawnLimitsFor, userBoxReadings } from '../services/spawnBudget';
import { recordSpawnEvent } from '../services/spawnEvents';
import { DEFAULT_SPAWN_LIMITS, type Budget, type BoxReading } from '../services/spawnLimits';

const coolBox = (over: Partial<BoxReading> = {}): BoxReading => ({
  id: 'box1', name: 'box-1', memUsedPct: 40, diskUsedPct: 30, load1: 0.5, cores: 2, sampledAt: new Date(), liveAgents: 1, ...over,
});
function budget(over: Partial<Budget['used']> = {}, box: Partial<BoxReading> = {}, limits = DEFAULT_SPAWN_LIMITS): Budget {
  return {
    limits, used: { depth: 0, openHere: 0, lastHour: 0, running: 0, ...over },
    box: { ...coolBox(box), capacity: limits.boxCapacity }, finishedRunning: 0, hints: [],
  };
}
const refusedReasons = () => vi.mocked(recordSpawnEvent).mock.calls.filter(c => c[0].kind === 'refused').map(c => c[0].reason);

const user = { id: 'u1', unixUsername: 'me', defaultAgentProvider: 'claude', googleEmail: 'me@x', displayName: 'Me' } as unknown as Express.User;
const BOX = 'box1';
const parentProject = {
  id: 'p1', name: 'proj', instanceId: BOX, userId: 'u1',
  workstreams: [{ name: 'main', workflows: [{ type: 'agent', provider: 'claude' }] }],
};

function resolvesTo(projectId: string | null, workstream = 'main', userId = 'u1') {
  vi.mocked(resolveSessionProject).mockResolvedValue({ userId, instanceId: BOX, projectId, workstream });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(boolVariation).mockResolvedValue(true);
  vi.mocked(isProjectAgentConnected).mockReturnValue(true);
  resolvesTo('p1');
  // resolveCaller's project read, then spawnWorkstream's target read.
  prisma.project.findFirst.mockImplementation(async ({ include }: { include?: { workstreams?: { select?: unknown } } }) => (
    include?.workstreams?.select
      ? { ...parentProject, workstreams: [{ name: 'main' }], instance: { hostHome: '/home/me', status: 'ready' } }
      : parentProject));
  prisma.agentSpawn.findFirst.mockResolvedValue(null);
  prisma.agentSpawn.count.mockResolvedValue(0);
  prisma.agentSpawn.create.mockResolvedValue({ id: 'ck1' });
  prisma.agentSpawn.update.mockResolvedValue({});
  prisma.agentSpawn.findUnique.mockResolvedValue({ launchedAt: new Date() });
  prisma.instance.findUnique.mockResolvedValue({ id: BOX, name: 'b', kind: 'ec2' });
  vi.mocked(createWorkstreamFor).mockResolvedValue({ status: 201, body: { name: 'x' } });
  vi.mocked(buildBudget).mockResolvedValue(budget());
});

const from = { session: 'me-proj-agent', head: 'abc1234' };

describe('spawnFor', () => {
  it('spawns a delegate workstream from the caller\'s agent pane, off its HEAD, with the brief claimed by id', async () => {
    const r = await spawnFor(user, BOX, { task: 'Add tests', from });
    expect(r.status).toBe(201);
    expect(prisma.agentSpawn.create.mock.calls[0][0].data).toMatchObject({
      parentSession: 'me-proj-agent', parentRole: 'agent', childProjectId: 'p1', childWorkstream: 'add-tests', depth: 1, provider: 'claude',
    });
    expect(vi.mocked(sendForProject).mock.calls[0][1]).toBe('write-file');
    expect(vi.mocked(createWorkstreamFor).mock.calls[0][2]).toEqual({ name: 'add-tests', baseRef: 'abc1234', provider: 'claude', spawnId: 'ck1' });
  });

  it('refuses an agent token that names no pane: the limits would have nothing to count', async () => {
    const r = await spawnFor(user, BOX, { task: 'x', projectId: 'p1' });
    expect(r.status).toBe(400);
    expect(prisma.agentSpawn.create).not.toHaveBeenCalled();
  });

  it('lets a browser session spawn without a pane', async () => {
    const r = await spawnFor(user, undefined, { task: 'x', projectId: 'p1' });
    expect(r.status).toBe(201);
  });

  it('refuses a ctrl pane as the parent', async () => {
    const r = await spawnFor(user, BOX, { task: 'x', from: { session: 'me-proj-ctrl' } });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/ctrl pane/);
  });

  it('404s a session that is another user\'s, or no project at all', async () => {
    resolvesTo('p1', 'main', 'u2');
    expect((await spawnFor(user, BOX, { task: 'x', from })).status).toBe(404);
    resolvesTo(null);
    expect((await spawnFor(user, BOX, { task: 'x', from })).status).toBe(404);
  });

  it('reads the flag for the target box, and writes nothing when it is off', async () => {
    vi.mocked(boolVariation).mockResolvedValue(false);
    const r = await spawnFor(user, BOX, { task: 'x', from });
    expect(r.status).toBe(403);
    expect(vi.mocked(boolVariation).mock.calls[0][3]).toMatchObject({ id: BOX });
    expect(prisma.agentSpawn.create).not.toHaveBeenCalled();
  });

  it('refuses by depth (from the caller\'s own spawn) and by the budget\'s counts, and logs why', async () => {
    prisma.agentSpawn.findFirst.mockResolvedValue({ id: 'ck0', depth: 2, rootSpawnId: 'ck0' });
    expect((await spawnFor(user, BOX, { task: 'x', from })).status).toBe(429);
    prisma.agentSpawn.findFirst.mockResolvedValue(null);
    vi.mocked(buildBudget).mockResolvedValue(budget({ openHere: 4 }));
    expect((await spawnFor(user, BOX, { task: 'x', from })).status).toBe(429);
    vi.mocked(buildBudget).mockResolvedValue(budget({ running: 8 }));
    expect((await spawnFor(user, BOX, { task: 'x', from })).status).toBe(429);
    expect(refusedReasons()).toEqual(['depth', 'open_children', 'concurrent']);
    expect(prisma.agentSpawn.create).not.toHaveBeenCalled();
  });

  it('refuses a hot box; a workstream target gets no box to move to', async () => {
    vi.mocked(buildBudget).mockResolvedValue(budget({}, { memUsedPct: 95 }));
    const r = await spawnFor(user, BOX, { task: 'x', from });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'box_busy', hint: null });
    expect((r.body as { error: string }).error).toMatch(/memory 95%.*this project lives on that box/);
    expect(userBoxReadings).not.toHaveBeenCalled();
  });

  it('refuses a full box only when the limits give it a capacity', async () => {
    vi.mocked(buildBudget).mockResolvedValue(budget({}, { liveAgents: 3 }));
    expect((await spawnFor(user, BOX, { task: 'x', from })).status).toBe(201);
    vi.mocked(buildBudget).mockResolvedValue(budget({}, { liveAgents: 3 }, { ...DEFAULT_SPAWN_LIMITS, boxCapacity: 3 }));
    const r = await spawnFor(user, BOX, { task: 'y', from });
    expect(r.body).toMatchObject({ code: 'box_capacity' });
  });

  it('suggests another of the user\'s boxes for a project target on a hot box', async () => {
    prisma.instance.findFirst.mockResolvedValue({ id: BOX, hostHome: '/home/me', status: 'ready' });
    vi.mocked(buildBudget).mockResolvedValue(budget({}, { memUsedPct: 95 }));
    vi.mocked(userBoxReadings).mockResolvedValue([coolBox({ id: BOX, memUsedPct: 95 }), coolBox({ id: 'box2', name: 'spare', memUsedPct: 20 })]);
    const r = await spawnFor(user, BOX, { task: 'x', from, target: 'project' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'box_busy', hint: { box: { id: 'box2', name: 'spare' } } });
    expect((r.body as { error: string }).error).toMatch(/retry with boxId=box2/);
  });

  it('suggests a box by the limits served for it, not the refused box\'s', async () => {
    prisma.instance.findFirst.mockResolvedValue({ id: BOX, hostHome: '/home/me', status: 'ready' });
    prisma.instance.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, name: where.id, kind: 'ec2' }));
    vi.mocked(buildBudget).mockResolvedValue(budget({}, { memUsedPct: 95 }));
    vi.mocked(userBoxReadings).mockResolvedValue([coolBox({ id: 'big', memUsedPct: 20, liveAgents: 3 })]);
    vi.mocked(spawnLimitsFor).mockResolvedValue({ ...DEFAULT_SPAWN_LIMITS, boxCapacity: 6 });
    const r = await spawnFor(user, BOX, { task: 'x', from, target: 'project' });
    expect(r.body).toMatchObject({ code: 'box_busy', hint: { box: { id: 'big', capacity: 6 } } });
  });

  it('files a refusal under the box the child would have run on', async () => {
    prisma.instance.findFirst.mockResolvedValue({ id: 'other-box', hostHome: '/home/me', status: 'failed' });
    const r = await spawnFor(user, BOX, { task: 'x', from, target: 'project', boxId: 'other-box' });
    expect(r.body).toMatchObject({ code: 'box-failed' });
    const refused = vi.mocked(recordSpawnEvent).mock.calls.find(c => c[0].kind === 'refused')![0];
    expect(refused).toMatchObject({ reason: 'box-failed', instanceId: 'other-box' });
    prisma.instance.findFirst.mockResolvedValue({ id: 'other-box', hostHome: '/home/me', status: 'terminated' });
    expect((await spawnFor(user, BOX, { task: 'x', from, target: 'project', boxId: 'other-box' })).body).toMatchObject({ code: 'box_terminated' });
  });

  it('records a root as its own tree, a child under its parent\'s root, and the created event', async () => {
    await spawnFor(user, BOX, { task: 'root', from });
    expect(prisma.agentSpawn.update.mock.calls[0][0]).toEqual({ where: { id: 'ck1' }, data: { rootSpawnId: 'ck1' } });
    vi.clearAllMocks();
    vi.mocked(buildBudget).mockResolvedValue(budget());
    vi.mocked(createWorkstreamFor).mockResolvedValue({ status: 201, body: { name: 'x' } });
    prisma.agentSpawn.create.mockResolvedValue({ id: 'ck2' });
    prisma.agentSpawn.findUnique.mockResolvedValue({ launchedAt: new Date() });
    prisma.agentSpawn.findFirst.mockResolvedValue({ id: 'ck1', depth: 1, rootSpawnId: 'ck1' });
    const r = await spawnFor(user, BOX, { task: 'child', from });
    expect(prisma.agentSpawn.create.mock.calls[0][0].data).toMatchObject({ depth: 2, rootSpawnId: 'ck1' });
    expect(vi.mocked(recordSpawnEvent).mock.calls.map(c => c[0].kind)).toEqual(['created', 'requested']);
    expect((r.body as { budget: Budget }).budget.used).toMatchObject({ lastHour: 1, running: 1 });
  });

  it('logs a refusal that never reached the limits with its code', async () => {
    await spawnFor(user, BOX, { task: 'x', projectId: 'p1' });
    expect(refusedReasons()).toEqual(['no_pane']);
  });

  it('409s a workstream target on a parked box before writing a brief', async () => {
    prisma.project.findFirst.mockImplementation(async ({ include }: { include?: { workstreams?: { select?: unknown } } }) => (
      include?.workstreams?.select
        ? { ...parentProject, workstreams: [], instance: { hostHome: '/home/me', status: 'stopped' } }
        : parentProject));
    vi.mocked(isProjectAgentConnected).mockReturnValue(false);
    const r = await spawnFor(user, BOX, { task: 'x', from });
    expect(r.status).toBe(409);
    expect(prisma.agentSpawn.create).not.toHaveBeenCalled();
  });

  it('409s a project target on a parked box, and an explicit name already on the box', async () => {
    prisma.instance.findFirst.mockResolvedValue({ id: BOX, hostHome: '/home/me', status: 'stopping' });
    expect((await spawnFor(user, BOX, { task: 'x', from, target: 'project' })).status).toBe(409);
    prisma.instance.findFirst.mockResolvedValue({ id: BOX, hostHome: '/home/me', status: 'ready' });
    prisma.project.findMany.mockResolvedValue([{ name: 'Docs' }]);
    expect((await spawnFor(user, BOX, { task: 'x', from, target: 'project', name: 'docs' })).status).toBe(409);
    expect(createProjectFor).not.toHaveBeenCalled();
  });

  it('marks the spawn failed when the create fails', async () => {
    vi.mocked(createWorkstreamFor).mockResolvedValue({ status: 409, body: { error: 'A workstream with that name already exists' } });
    const r = await spawnFor(user, BOX, { task: 'x', from });
    expect(r.status).toBe(409);
    expect(prisma.agentSpawn.update.mock.calls.map(c => c[0])).toContainEqual(expect.objectContaining({ where: { id: 'ck1' }, data: expect.objectContaining({ state: 'failed' }) }));
    expect(vi.mocked(recordSpawnEvent).mock.calls.map(c => c[0].kind)).toContain('failed');
  });
});

describe('reportFor', () => {
  it('records the report on the caller\'s own spawn and clears the nudge stamp', async () => {
    resolvesTo('p1', 'add-tests');
    prisma.project.findFirst.mockResolvedValue({ ...parentProject, workstreams: [{ name: 'add-tests', workflows: [] }] });
    prisma.agentSpawn.findFirst.mockResolvedValue({ id: 'ck1', parentSession: 'me-proj-agent', relationship: 'delegate', provider: 'claude', createdAt: new Date(Date.now() - 90_000), reportedAt: null, rootSpawnId: 'ck1' });
    const r = await reportFor(user, BOX, { session: 'me-proj-add-tests-agent', status: 'done', summary: 'ok' });
    expect(r.status).toBe(200);
    expect(prisma.agentSpawn.findFirst.mock.calls[0][0].where).toMatchObject({ userId: 'u1', childProjectId: 'p1', childWorkstream: 'add-tests' });
    expect(prisma.agentSpawn.update.mock.calls[0][0].data).toMatchObject({ state: 'done', nudgedAt: null });
    const reported = vi.mocked(recordSpawnEvent).mock.calls.find(c => c[0].kind === 'reported')![0];
    expect(reported.detail).toMatchObject({ provider: 'claude', first: true });
    expect(reported.detail!.secondsSinceCreated).toBeGreaterThanOrEqual(89);
  });

  it('404s a session nobody spawned, and another user\'s session', async () => {
    resolvesTo('p1', 'main');
    expect((await reportFor(user, BOX, { session: 'me-proj-agent', status: 'done', summary: 'x' })).status).toBe(404);
    resolvesTo('p1', 'main', 'u2');
    expect((await reportFor(user, BOX, { session: 'me-proj-agent', status: 'done', summary: 'x' })).status).toBe(404);
    expect(prisma.agentSpawn.update).not.toHaveBeenCalled();
  });
});

describe('usageFor', () => {
  it('returns the budget, trees with tokens, refusals by reason and each box\'s day', async () => {
    vi.mocked(buildBudget).mockResolvedValue(budget({ lastHour: 3, running: 2 }));
    const created = new Date();
    prisma.agentSpawn.findMany.mockResolvedValue([
      { id: 'r1', rootSpawnId: 'r1', depth: 1, createdAt: created, relationship: 'delegate', state: 'done', title: 'Root', provider: 'claude',
        childProjectId: 'p1', childProjectName: 'proj', childWorkstream: 'ws1', childInstanceId: BOX,
        parentProjectId: 'p1', parentWorkstream: 'main', parentSession: 'me-proj-agent', report: null, error: null,
        launchedAt: created, reportedAt: null, nudgedAt: null, endedAt: null },
    ]);
    prisma.spawnEvent.groupBy.mockResolvedValue([{ reason: 'rate', _count: { _all: 1 } }, { reason: 'box_busy', _count: { _all: 4 } }]);
    prisma.instance.findMany.mockResolvedValue([{ id: BOX, name: 'box-1', kind: 'ec2', userId: 'u1', status: 'ready', memUsedPct: 88, diskUsedPct: 30, load1: 1, hostSampledAt: new Date() }]);
    prisma.tokenUsageDay.findMany.mockResolvedValue([
      { projectId: 'p1', workstream: 'ws1', date: created.toISOString().slice(0, 10), input: 10n, output: 4n, cacheRead: 100n, cacheCreate: 1n, reasoning: 0n },
    ]);
    prisma.hostSample.findMany.mockResolvedValue([{ instanceId: BOX, at: new Date(), memUsedPct: 88, load1: 1, cores: 2, liveAgents: 1 }]);

    const r = await usageFor(user);
    expect(r.status).toBe(200);
    const body = r.body as {
      trees: Array<{ rootId: string; nodes: Array<{ id: string; level: number; tokens: unknown }> }>;
      refusals: Array<{ reason: string; count: number }>;
      boxes: Array<{ heat: string; loadPerCore: number; samples: unknown[] }>;
    };
    expect(body.trees[0]).toMatchObject({ rootId: 'r1', nodes: [{ id: 'r1', level: 0, tokens: { input: 10, output: 4, cacheRead: 100, cacheCreate: 1 } }] });
    expect(body.refusals).toEqual([{ reason: 'box_busy', count: 4 }, { reason: 'rate', count: 1 }]);
    expect(body.boxes[0]).toMatchObject({ heat: 'hot', loadPerCore: 0.5 });
    // The hot box speaks up in the hint list, ahead of the user-level hints.
    expect((r.body as { budget: Budget }).budget.hints[0]).toMatchObject({ kind: 'box_hot' });
    expect((r.body as { budget: Budget }).budget.hints[0].message).toMatch(/box-1 is running hot \(memory 88%/);
    expect(body.boxes[0].samples).toHaveLength(1);
    // The owner's own spawns only, and estimated token rows left out.
    expect(prisma.agentSpawn.findMany.mock.calls[0][0].where.userId).toBe('u1');
    expect(prisma.tokenUsageDay.findMany.mock.calls[0][0].where).toMatchObject({ userId: 'u1', estimated: false });
  });

  const spawnRow = (id: string, createdAt: Date, over: Record<string, unknown> = {}) => ({
    id, rootSpawnId: id, depth: 1, createdAt, relationship: 'delegate', state: 'running', title: id, provider: 'claude',
    childProjectId: 'p1', childProjectName: 'proj', childWorkstream: id, childInstanceId: BOX,
    parentProjectId: 'p1', parentWorkstream: 'main', parentSession: 'me-proj-agent', report: null, error: null,
    launchedAt: createdAt, reportedAt: null, nudgedAt: null, endedAt: null, ...over,
  });

  it('keeps an old tree that is still running, whatever the recent window holds', async () => {
    vi.mocked(buildBudget).mockResolvedValue(budget());
    const old = spawnRow('old', new Date(Date.now() - 30 * 24 * 3600_000));
    prisma.agentSpawn.findMany
      .mockResolvedValueOnce([spawnRow('new', new Date())]) // the last week
      .mockResolvedValueOnce([old]);                         // still running, any age
    prisma.spawnEvent.groupBy.mockResolvedValue([]);
    prisma.instance.findMany.mockResolvedValue([]);
    prisma.tokenUsageDay.findMany.mockResolvedValue([]);
    const body = (await usageFor(user)).body as { trees: Array<{ rootId: string }>; treesTotal: number };
    expect(body.trees.map(t => t.rootId).sort()).toEqual(['new', 'old']);
    const runningQuery = prisma.agentSpawn.findMany.mock.calls[1][0].where;
    expect(runningQuery).toEqual({ userId: 'u1', endedAt: null, state: { not: 'failed' } });
  });

  it('caps the trees it returns and says how many there were', async () => {
    vi.mocked(buildBudget).mockResolvedValue(budget());
    const many = Array.from({ length: 25 }, (_, i) => spawnRow(`t${i}`, new Date(Date.now() - i * 60_000)));
    prisma.agentSpawn.findMany.mockResolvedValueOnce(many).mockResolvedValueOnce([]);
    prisma.spawnEvent.groupBy.mockResolvedValue([]);
    prisma.instance.findMany.mockResolvedValue([]);
    prisma.tokenUsageDay.findMany.mockResolvedValue([]);
    const body = (await usageFor(user)).body as { trees: unknown[]; treesTotal: number };
    expect(body.trees).toHaveLength(20);
    expect(body.treesTotal).toBe(25);
  });

  it('gives each box its own threshold, and its hints in box order however the flag reads resolve', async () => {
    vi.mocked(buildBudget).mockResolvedValue(budget());
    prisma.agentSpawn.findMany.mockResolvedValue([spawnRow('a', new Date())]);
    prisma.spawnEvent.groupBy.mockResolvedValue([]);
    prisma.tokenUsageDay.findMany.mockResolvedValue([]);
    prisma.hostSample.findMany.mockResolvedValue([]);
    prisma.instance.findMany.mockResolvedValue([
      { id: 'b1', name: 'alpha', kind: 'ec2', userId: 'u1', status: 'ready', memUsedPct: 92, diskUsedPct: 10, load1: 0, hostSampledAt: new Date() },
      { id: 'b2', name: 'beta', kind: 'ec2', userId: 'u1', status: 'ready', memUsedPct: 92, diskUsedPct: 10, load1: 0, hostSampledAt: new Date() },
    ]);
    // alpha's limits resolve last, and alpha is served a higher threshold.
    vi.mocked(spawnLimitsFor).mockImplementation(async (_u, box) => {
      if (box?.id === 'b1') { await new Promise(r => setTimeout(r, 20)); return { ...DEFAULT_SPAWN_LIMITS, hot: { ...DEFAULT_SPAWN_LIMITS.hot, memPct: 90 } }; }
      return DEFAULT_SPAWN_LIMITS;
    });
    const body = (await usageFor(user)).body as { budget: Budget; boxes: Array<{ name: string; hotMemPct: number }> };
    expect(body.boxes.map(b => [b.name, b.hotMemPct])).toEqual([['alpha', 90], ['beta', 85]]);
    expect(body.budget.hints.map(h => h.message.split(' ')[1])).toEqual(['alpha', 'beta']);
    vi.mocked(spawnLimitsFor).mockResolvedValue(DEFAULT_SPAWN_LIMITS);
  });
});
