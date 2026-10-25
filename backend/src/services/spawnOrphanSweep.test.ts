import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  agentSpawn: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  project: { findFirst: vi.fn() },
  user: { findMany: vi.fn() },
  instance: { findMany: vi.fn() },
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('./featureFlags', () => ({ boolVariation: vi.fn(async () => true) }));
vi.mock('./spawnEvents', () => ({ recordSpawnEvent: vi.fn(async () => {}) }));
vi.mock('./agentRegistry', () => ({
  isProjectAgentConnected: vi.fn(() => true),
  sendForProject: vi.fn(),
}));

import { runOrphanTick } from './spawnOrphanSweep';
import { PARENT_GONE_MISSES } from './spawnOrphans';
import { boolVariation } from './featureFlags';
import { recordSpawnEvent } from './spawnEvents';
import { isProjectAgentConnected, sendForProject } from './agentRegistry';

const now = Date.parse('2026-10-19T12:00:00Z');
const child = (over: Record<string, unknown> = {}) => ({
  id: 'c1', userId: 'u1', rootSpawnId: 'r1', relationship: 'delegate', state: 'running', retiredAt: null, endedAt: null, reportedAt: null, nudgedAt: null,
  parentProjectId: 'p1', parentWorkstream: 'mid', parentRole: 'agent',
  fosterProjectId: null, fosterWorkstream: null, fosterRole: null, orphanedAt: null,
  childProjectId: 'p1', childProjectName: 'proj', childWorkstream: 'leaf', childInstanceId: 'box1', ...over,
});

/** The world: projects by id, the spawn that made each session, and what tmux lists. */
let projects: Record<string, { name: string; archived?: boolean; workstreams?: string[]; instanceId?: string | null }>;
let spawns: Record<string, Record<string, unknown>>;
let panes: string[];
let homeSetting: unknown;

beforeEach(() => {
  vi.clearAllMocks();
  projects = { p1: { name: 'proj', workstreams: ['mid', 'leaf'] }, p0: { name: 'top' }, ph: { name: 'home' } };
  spawns = {};
  panes = [];
  homeSetting = null;
  prisma.user.findMany.mockImplementation(async () => [{ id: 'u1', unixUsername: 'me', googleEmail: 'me@x', spawnOrphanHome: homeSetting }]);
  prisma.instance.findMany.mockResolvedValue([{ id: 'box1', name: 'b', kind: 'ec2' }]);
  prisma.agentSpawn.updateMany.mockResolvedValue({ count: 1 });
  // The workstream filter is in the select: answer it from the world.
  prisma.project.findFirst.mockImplementation(async (args: { where: { id: string }; select: { workstreams: { where: { name: string } } } }) => {
    const p = projects[args.where.id];
    if (!p) return null;
    const ws = args.select.workstreams.where.name;
    return { name: p.name, archived: !!p.archived, instanceId: p.instanceId === undefined ? 'box1' : p.instanceId, user: { unixUsername: 'me' }, workstreams: (p.workstreams ?? []).includes(ws) ? [{ name: ws }] : [] };
  });
  prisma.agentSpawn.findFirst.mockImplementation(async ({ where }: { where: { childProjectId: string; childWorkstream: string } }) => spawns[`${where.childProjectId}|${where.childWorkstream}`] ?? null);
  vi.mocked(sendForProject).mockImplementation(async () => ({ sessions: panes }));
  vi.mocked(isProjectAgentConnected).mockReturnValue(true);
  vi.mocked(boolVariation).mockResolvedValue(true);
});

const ended = (over: Record<string, unknown> = {}) => ({
  id: 'm1', endedAt: new Date(now - 60_000), retiredAt: null, state: 'done', reportedAt: null, nudgedAt: null,
  parentProjectId: 'p0', parentWorkstream: 'main', parentRole: 'agent', fosterProjectId: null, fosterWorkstream: null, fosterRole: null, ...over,
});
const adoptedTo = () => prisma.agentSpawn.updateMany.mock.calls.map(c => c[0].data).find((d: Record<string, unknown>) => 'fosterProjectId' in d);

describe('runOrphanTick', () => {
  it('reads every candidate that may need a parent, in pages', async () => {
    prisma.agentSpawn.findMany.mockResolvedValue([]);
    await runOrphanTick(now);
    const where = prisma.agentSpawn.findMany.mock.calls[0][0].where;
    expect(where.retiredAt).toBeNull();
    // A parent, or a foster (a browser-spawned root the owner moved into a session).
    expect(where.AND[0].OR).toEqual([{ parentProjectId: { not: null } }, { fosterProjectId: { not: null } }]);
    expect(where.AND[1].OR).toHaveLength(3);
  });

  it('gives a child whose parent spawn ended to the nearest living ancestor', async () => {
    spawns['p1|mid'] = ended();
    panes = ['me-top-agent'];
    prisma.agentSpawn.findMany.mockResolvedValue([child()]);
    expect(await runOrphanTick(now)).toEqual({ adopted: 1, orphaned: 0 });
    expect(adoptedTo()).toMatchObject({ fosterProjectId: 'p0', fosterWorkstream: 'main', fosterRole: 'agent', adoptedBy: 'ancestor', orphanedAt: null });
    // Compare-and-set on the foster it had.
    expect(prisma.agentSpawn.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'c1', fosterProjectId: null, fosterWorkstream: null });
    expect(vi.mocked(recordSpawnEvent).mock.calls[0][0]).toMatchObject({ kind: 'adopted', reason: 'ancestor', parentProjectId: 'p0' });
  });

  it('skips an ancestor whose pane is down (parked), and falls back to the orphan home', async () => {
    spawns['p1|mid'] = ended();
    homeSetting = { projectId: 'ph', workstream: 'main' };
    panes = ['me-home-agent'];
    prisma.agentSpawn.findMany.mockResolvedValue([child()]);
    expect(await runOrphanTick(now)).toEqual({ adopted: 1, orphaned: 0 });
    expect(adoptedTo()).toMatchObject({ fosterProjectId: 'ph', adoptedBy: 'home' });
  });

  it('marks it orphaned once when nobody can take it, and adopts it when a home turns up', async () => {
    spawns['p1|mid'] = ended();
    prisma.agentSpawn.findMany.mockResolvedValue([child()]);
    expect(await runOrphanTick(now)).toEqual({ adopted: 0, orphaned: 1 });
    expect(prisma.agentSpawn.updateMany.mock.calls[0][0].data).toEqual({ orphanedAt: new Date(now) });
    expect(vi.mocked(recordSpawnEvent).mock.calls[0][0]).toMatchObject({ kind: 'orphaned', detail: { homeSet: false } });

    vi.mocked(recordSpawnEvent).mockClear();
    prisma.agentSpawn.updateMany.mockClear();
    prisma.agentSpawn.findMany.mockResolvedValue([child({ orphanedAt: new Date(now) })]);
    expect(await runOrphanTick(now + 60_000)).toEqual({ adopted: 0, orphaned: 0 });
    expect(recordSpawnEvent).not.toHaveBeenCalled();

    homeSetting = { projectId: 'ph' };
    panes = ['me-home-agent'];
    expect(await runOrphanTick(now + 120_000)).toEqual({ adopted: 1, orphaned: 0 });
  });

  it('waits ten sweeps before a root\'s missing pane counts as gone, and un-orphans when it is back', async () => {
    // The parent is a person's own session, not a spawn.
    prisma.agentSpawn.findMany.mockResolvedValue([child({ parentWorkstream: 'main' })]);
    for (let i = 1; i < PARENT_GONE_MISSES; i++) expect(await runOrphanTick(now + i)).toEqual({ adopted: 0, orphaned: 0 });
    expect(await runOrphanTick(now + PARENT_GONE_MISSES)).toEqual({ adopted: 0, orphaned: 1 });

    prisma.agentSpawn.updateMany.mockClear();
    prisma.agentSpawn.findMany.mockResolvedValue([child({ parentWorkstream: 'main', orphanedAt: new Date(now) })]);
    panes = ['me-proj-agent'];
    await runOrphanTick(now + 100);
    expect(prisma.agentSpawn.updateMany.mock.calls[0][0].data).toEqual({ orphanedAt: null });
  });

  it('asks the user\'s own agent about a session on the orchestrator host', async () => {
    projects.p1.instanceId = null;
    prisma.agentSpawn.findMany.mockResolvedValue([child({ parentWorkstream: 'main' })]);
    for (let i = 1; i < PARENT_GONE_MISSES; i++) await runOrphanTick(now + i);
    expect(await runOrphanTick(now + PARENT_GONE_MISSES)).toEqual({ adopted: 0, orphaned: 1 });
    expect(vi.mocked(sendForProject).mock.calls[0][0]).toEqual({ userId: 'u1', instanceId: null });
  });

  it('checks a browser-spawned root once the owner moved it into a session, and walks no ancestors', async () => {
    spawns['ph|main'] = ended();
    homeSetting = { projectId: 'p0' };
    panes = ['me-top-agent'];
    prisma.agentSpawn.findMany.mockResolvedValue([child({ parentProjectId: null, parentWorkstream: null, parentRole: null, fosterProjectId: 'ph', fosterWorkstream: 'main', fosterRole: 'agent' })]);
    expect(await runOrphanTick(now)).toEqual({ adopted: 1, orphaned: 0 });
    expect(adoptedTo()).toMatchObject({ fosterProjectId: 'p0', adoptedBy: 'home' });
  });

  it('adopts only if it is still as orphaned (or not) as it was read', async () => {
    spawns['p1|mid'] = ended();
    panes = ['me-top-agent'];
    prisma.agentSpawn.findMany.mockResolvedValue([child()]);
    await runOrphanTick(now);
    expect(prisma.agentSpawn.updateMany.mock.calls[0][0].where).toMatchObject({ orphanedAt: null });
  });

  it('keeps a child with a parent whose spawn ended but whose pane is back, and lets that parent adopt', async () => {
    // The end sweep ended mid; reconnect reconstruction relaunched its pane.
    spawns['p1|mid'] = ended();
    panes = ['me-proj-mid-agent', 'me-top-agent'];
    prisma.agentSpawn.findMany.mockResolvedValue([child()]);
    expect(await runOrphanTick(now)).toEqual({ adopted: 0, orphaned: 0 });
    expect(prisma.agentSpawn.updateMany).not.toHaveBeenCalled();
    // An orphan whose parent pane is back is un-orphaned.
    prisma.agentSpawn.findMany.mockResolvedValue([child({ orphanedAt: new Date(now - 60_000) })]);
    await runOrphanTick(now);
    expect(prisma.agentSpawn.updateMany.mock.calls[0][0].data).toEqual({ orphanedAt: null });
    // Its box unreachable: nothing is decided.
    prisma.agentSpawn.updateMany.mockClear();
    vi.mocked(isProjectAgentConnected).mockReturnValue(false);
    prisma.agentSpawn.findMany.mockResolvedValue([child()]);
    expect(await runOrphanTick(now)).toEqual({ adopted: 0, orphaned: 0 });
    expect(prisma.agentSpawn.updateMany).not.toHaveBeenCalled();
  });

  it('lets an ended ancestor whose pane is back adopt', async () => {
    spawns['p1|mid'] = ended();
    spawns['p0|main'] = ended({ parentProjectId: null });
    panes = ['me-top-agent'];
    prisma.agentSpawn.findMany.mockResolvedValue([child()]);
    expect(await runOrphanTick(now)).toEqual({ adopted: 1, orphaned: 0 });
    expect(adoptedTo()).toMatchObject({ fosterProjectId: 'p0', adoptedBy: 'ancestor' });
  });

  it('decides nothing while the parent\'s box cannot be asked', async () => {
    vi.mocked(isProjectAgentConnected).mockReturnValue(false);
    prisma.agentSpawn.findMany.mockResolvedValue([child({ parentWorkstream: 'main' })]);
    for (let i = 0; i < PARENT_GONE_MISSES + 2; i++) await runOrphanTick(now + i);
    expect(prisma.agentSpawn.updateMany).not.toHaveBeenCalled();
  });

  it('leaves a child alone while its parent lives, or while spawn-lifecycle-enabled is off', async () => {
    panes = ['me-proj-mid-agent'];
    spawns['p1|mid'] = ended({ endedAt: null });
    prisma.agentSpawn.findMany.mockResolvedValue([child()]);
    expect(await runOrphanTick(now)).toEqual({ adopted: 0, orphaned: 0 });

    spawns['p1|mid'] = ended();
    vi.mocked(boolVariation).mockResolvedValue(false);
    expect(await runOrphanTick(now)).toEqual({ adopted: 0, orphaned: 0 });
    expect(vi.mocked(boolVariation).mock.calls[0][0]).toBe('spawn-lifecycle-enabled');
    expect(prisma.agentSpawn.updateMany).not.toHaveBeenCalled();
  });

  it('treats a removed parent workstream as gone at once', async () => {
    projects.p1.workstreams = ['leaf'];
    panes = ['me-top-agent'];
    spawns['p1|mid'] = ended({ endedAt: null });
    prisma.agentSpawn.findMany.mockResolvedValue([child()]);
    expect(await runOrphanTick(now)).toEqual({ adopted: 1, orphaned: 0 });
  });

  it('never orphans a child that ended, and takes one off the list once it has', async () => {
    spawns['p1|mid'] = ended();
    prisma.agentSpawn.findMany.mockResolvedValue([child({ endedAt: new Date(now - 5) })]);
    expect(await runOrphanTick(now)).toEqual({ adopted: 0, orphaned: 0 });
    expect(prisma.agentSpawn.updateMany).not.toHaveBeenCalled();
    prisma.agentSpawn.findMany.mockResolvedValue([child({ endedAt: new Date(now - 5), orphanedAt: new Date(now - 60_000) })]);
    await runOrphanTick(now);
    expect(prisma.agentSpawn.updateMany.mock.calls[0][0].data).toEqual({ orphanedAt: null });
  });

  it('lets a finished child with its report already read go without a parent', async () => {
    spawns['p1|mid'] = ended();
    prisma.agentSpawn.findMany.mockResolvedValue([child({ state: 'done', reportedAt: new Date(now - 10), nudgedAt: new Date(now - 5) })]);
    expect(await runOrphanTick(now)).toEqual({ adopted: 0, orphaned: 0 });
  });
});
