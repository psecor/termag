import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
  agentSpawn: { updateMany: vi.fn(async () => ({ count: 1 })), update: vi.fn(async () => ({})), findUnique: vi.fn(async () => ({ parkedAt: new Date(), retiredAt: null })) },
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('./agentRegistry', () => ({ isProjectAgentConnected: vi.fn(() => true), sendForProject: vi.fn() }));
vi.mock('./agentRuntime', () => ({
  ensureAgentSessionsAndLaunch: vi.fn(async () => 'launched'),
  resolveAgentProvider: (p: string | null) => p ?? 'claude',
  stopAgentPane: vi.fn(async () => {}),
  paneLockKey: (i: string | null, sess: string) => `${i}|${sess}`,
  withPaneLock: vi.fn(async (_k: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./spawnEvents', () => ({ recordSpawnEvent: vi.fn(async () => {}) }));
vi.mock('./status', () => ({ setStatus: vi.fn() }));
vi.mock('../routes/projects', () => ({ archiveOwnedProject: vi.fn(async () => ({ status: 200, body: { ok: true } })) }));
vi.mock('../routes/workstreams', () => ({ removeWorkstreamFor: vi.fn(async () => ({ status: 200, body: { ok: true } })) }));

import { checkoutCheck, parkSpawn, resumeSpawn, retireSpawn } from './spawnActions';
import { sendForProject } from './agentRegistry';
import { ensureAgentSessionsAndLaunch, stopAgentPane, withPaneLock } from './agentRuntime';
import { recordSpawnEvent } from './spawnEvents';
import { setStatus } from './status';
import { archiveOwnedProject } from '../routes/projects';
import { removeWorkstreamFor } from '../routes/workstreams';

const spawn = (over: Record<string, unknown> = {}) => ({
  id: 'ck1', userId: 'u1', rootSpawnId: 'ck1', relationship: 'delegate', state: 'done', provider: 'claude',
  childProjectId: 'p1', childProjectName: 'proj', childWorkstream: 'add-tests', childInstanceId: 'box1',
  parkedAt: null, retiredAt: null, endedAt: null, keptReason: null, ...over,
}) as never;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.project.findFirst.mockResolvedValue({
    id: 'p1', name: 'proj', instanceId: 'box1', user: { id: 'u1', unixUsername: 'me', defaultAgentProvider: 'claude' },
    instance: { hostHome: '/home/me', status: 'ready' },
    workstreams: [{ id: 'ws1', name: 'add-tests', workflows: [{ type: 'agent', provider: 'claude' }] }],
  });
});

describe('parkSpawn', () => {
  it('stops the agent CLI, stamps parkedAt once, and logs who did it', async () => {
    expect(await parkSpawn(spawn(), 'sweep')).toEqual({ ok: true });
    expect(vi.mocked(stopAgentPane).mock.calls[0][0]).toMatchObject({ projectName: 'proj', workstream: 'add-tests', provider: 'claude' });
    expect(prisma.agentSpawn.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'ck1', parkedAt: null, retiredAt: null } });
    expect(vi.mocked(recordSpawnEvent).mock.calls[0][0]).toMatchObject({ kind: 'parked', reason: 'sweep' });
    // The stopped pane reads not_running, so the sweep's live-pane guard lets it retire later.
    expect(vi.mocked(setStatus).mock.calls[0]).toEqual(['me-proj-add-tests-agent', 'not_running', { milestone: null }, undefined, 'box1']);
  });

  it('stamps parkedAt before stopping the pane, and takes the stamp back when the stop fails', async () => {
    const order: string[] = [];
    prisma.agentSpawn.updateMany.mockImplementationOnce(async () => { order.push('stamp'); return { count: 1 }; });
    vi.mocked(stopAgentPane).mockImplementationOnce(async () => { order.push('stop'); });
    await parkSpawn(spawn(), 'owner');
    expect(order).toEqual(['stamp', 'stop']);
    vi.mocked(stopAgentPane).mockRejectedValueOnce(new Error('tmux gone'));
    expect(await parkSpawn(spawn(), 'owner')).toMatchObject({ ok: false, status: 503 });
    // Compare-and-set on its own stamp: never clears a park someone else wrote.
    const rollback = prisma.agentSpawn.updateMany.mock.calls.at(-1)![0];
    expect(rollback.data).toEqual({ parkedAt: null });
    expect(rollback.where.parkedAt).toBeInstanceOf(Date);
  });

  it('acts on no box that is powering down or up', async () => {
    prisma.project.findFirst.mockResolvedValue({
      id: 'p1', name: 'proj', instanceId: 'box1', user: { id: 'u1', unixUsername: 'me', defaultAgentProvider: 'claude' },
      instance: { hostHome: '/home/me', status: 'stopping' },
      workstreams: [{ id: 'ws1', name: 'add-tests', workflows: [] }],
    });
    expect(await parkSpawn(spawn(), 'sweep')).toMatchObject({ ok: false, status: 409 });
    expect(await resumeSpawn(spawn({ parkedAt: new Date() }))).toMatchObject({ ok: false, status: 409 });
    expect(await retireSpawn(spawn(), 'owner', { ok: true, why: 'pushed' })).toMatchObject({ ok: false, status: 409 });
    expect((await checkoutCheck(spawn())).ok).toBe(false);
    expect(stopAgentPane).not.toHaveBeenCalled();
    expect(removeWorkstreamFor).not.toHaveBeenCalled();
  });

  it('refuses a retired spawn and leaves a parked one alone', async () => {
    expect(await parkSpawn(spawn({ retiredAt: new Date() }), 'owner')).toMatchObject({ ok: false, status: 409 });
    expect(await parkSpawn(spawn({ parkedAt: new Date() }), 'owner')).toEqual({ ok: true, detail: 'already parked' });
    expect(stopAgentPane).not.toHaveBeenCalled();
  });
});

describe('resumeSpawn', () => {
  it('unparks first, then launches on the conversation (resume)', async () => {
    const parkedAt = new Date();
    expect(await resumeSpawn(spawn({ parkedAt }))).toEqual({ ok: true });
    expect(prisma.agentSpawn.updateMany.mock.calls[0][0]).toMatchObject({ where: { parkedAt }, data: { parkedAt: null, keptReason: null } });
    expect(vi.mocked(ensureAgentSessionsAndLaunch).mock.calls[0][0]).toMatchObject({ workstream: 'add-tests', resume: true });
  });

  it('puts the park back when the launch fails', async () => {
    const parkedAt = new Date();
    vi.mocked(ensureAgentSessionsAndLaunch).mockRejectedValueOnce(new Error('box gone'));
    expect(await resumeSpawn(spawn({ parkedAt }))).toMatchObject({ ok: false, status: 503 });
    expect(prisma.agentSpawn.updateMany.mock.calls.at(-1)![0]).toMatchObject({ where: { parkedAt: null }, data: { parkedAt } });
  });

  it('backs off when the spawn changed under it', async () => {
    prisma.agentSpawn.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await resumeSpawn(spawn({ parkedAt: new Date() }))).toMatchObject({ ok: false, status: 409 });
    expect(ensureAgentSessionsAndLaunch).not.toHaveBeenCalled();
  });
});

describe('checkoutCheck and retireSpawn', () => {
  it('reads the child worktree\'s branch state', async () => {
    vi.mocked(sendForProject).mockResolvedValue({ branch: 'add-tests', upstream: 'origin/add-tests', ahead: 0, abKnown: true, aheadOfBase: 3, dirty: false, remoteContainsHead: true });
    expect(await checkoutCheck(spawn())).toEqual({ ok: true, why: 'pushed' });
    const [, cmd, payload] = vi.mocked(sendForProject).mock.calls[0];
    expect(cmd).toBe('git-branch-state');
    expect(payload).toMatchObject({ verifyRemote: true });
    expect((payload as { cwd: string }).cwd).toMatch(/proj\/\.worktrees\/add-tests$/);
  });

  it('passes the commit it was spawned from, so a local-only checkout can be counted', async () => {
    vi.mocked(sendForProject).mockResolvedValue({ branch: 'add-tests', upstream: null, ahead: 0, aheadOfBase: 0, dirty: false, origin: null, baseLocal: 'spawn-base' });
    expect(await checkoutCheck(spawn({ baseSha: 'abc1234' }))).toEqual({ ok: true, why: 'nothing_beyond_base' });
    expect(vi.mocked(sendForProject).mock.calls[0][2]).toMatchObject({ verifyRemote: true, base: 'abc1234' });
  });

  it('keeps work that would be lost, recording why once', async () => {
    expect(await retireSpawn(spawn(), 'sweep', { ok: false, reason: '2 commits not pushed' })).toMatchObject({ ok: false, status: 409 });
    expect(prisma.agentSpawn.update.mock.calls[0][0]).toMatchObject({ data: { keptReason: '2 commits not pushed' } });
    expect(vi.mocked(recordSpawnEvent).mock.calls[0][0]).toMatchObject({ kind: 'retire_refused' });
    vi.clearAllMocks();
    await retireSpawn(spawn({ keptReason: '2 commits not pushed' }), 'sweep', { ok: false, reason: '2 commits not pushed' });
    expect(recordSpawnEvent).not.toHaveBeenCalled();
    expect(removeWorkstreamFor).not.toHaveBeenCalled();
  });

  it('removes a workstream child without forcing, and archives a project child', async () => {
    expect(await retireSpawn(spawn(), 'owner', { ok: true, why: 'pushed' })).toEqual({ ok: true });
    expect(vi.mocked(removeWorkstreamFor).mock.calls[0]).toEqual([expect.objectContaining({ id: 'u1' }), 'p1', 'ws1', { force: false }]);
    expect(prisma.agentSpawn.update.mock.calls.at(-1)![0].data).toMatchObject({ retiredAt: expect.any(Date), keptReason: null });
    prisma.project.findFirst.mockResolvedValue({
      id: 'p2', name: 'docs', instanceId: 'box1', user: { id: 'u1', unixUsername: 'me', defaultAgentProvider: 'claude' },
      instance: { hostHome: '/home/me', status: 'ready' }, workstreams: [{ id: 'm', name: 'main', workflows: [] }],
    });
    await retireSpawn(spawn({ childProjectId: 'p2', childWorkstream: 'main' }), 'owner', { ok: true, why: 'nothing_beyond_base' });
    expect(vi.mocked(archiveOwnedProject).mock.calls[0][1]).toBe('p2');
  });

  it('removes under the pane\'s launch lock, and a sweep backs off from a spawn launched again meanwhile', async () => {
    await retireSpawn(spawn({ parkedAt: new Date() }), 'sweep', { ok: true, why: 'nothing_beyond_base' });
    expect(vi.mocked(withPaneLock).mock.calls[0][0]).toBe('box1|me-proj-add-tests-agent');
    vi.clearAllMocks();
    prisma.agentSpawn.findUnique.mockResolvedValueOnce({ parkedAt: null, retiredAt: null });
    expect(await retireSpawn(spawn({ parkedAt: new Date() }), 'sweep', { ok: true, why: 'nothing_beyond_base' })).toMatchObject({ ok: false, status: 409, error: 'it was launched again' });
    expect(removeWorkstreamFor).not.toHaveBeenCalled();
  });

  it('keeps the spawn when the remove itself fails (git refused)', async () => {
    vi.mocked(removeWorkstreamFor).mockResolvedValueOnce({ status: 409, body: { error: 'git worktree remove failed: contains modified files' } });
    expect(await retireSpawn(spawn(), 'owner', { ok: true, why: 'pushed' })).toMatchObject({ ok: false, status: 409 });
    expect(prisma.agentSpawn.update.mock.calls.at(-1)![0].data).toHaveProperty('keptReason');
    expect(prisma.agentSpawn.update.mock.calls.at(-1)![0].data).not.toHaveProperty('retiredAt');
  });
});
