import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  agentHandoff: { findMany: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
  project: { findFirst: vi.fn() },
  workflow: { update: vi.fn(async () => ({})) },
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('./agentRegistry', () => ({ isProjectAgentConnected: vi.fn(() => true), sendForProject: vi.fn(async () => ({ ok: true })) }));
vi.mock('./agentRuntime', () => ({
  ensureAgentSessionsAndLaunch: vi.fn(async () => 'launched'),
  stopAgentPane: vi.fn(async () => {}),
  resolveAgentProvider: (wf: string | null, dflt: string | null) => wf ?? dflt ?? 'claude',
}));
vi.mock('./status', () => ({
  getStatus: vi.fn(() => ({ status: 'idle' })),
  hasStatus: vi.fn(() => true),
  setStatus: vi.fn(),
  markAgentPaneStopped: vi.fn(),
  notifyStatusChange: vi.fn(),
  updateStatusMeta: vi.fn(),
}));
vi.mock('./humanActivity', () => ({ lastHumanHeartbeat: vi.fn(() => null) }));

import { runHandoffTick } from './agentHandoffSweep';
import { sendForProject } from './agentRegistry';
import { ensureAgentSessionsAndLaunch, stopAgentPane } from './agentRuntime';
import { getStatus, hasStatus, markAgentPaneStopped, setStatus, updateStatusMeta } from './status';

const now = Date.parse('2026-10-18T12:00:00Z');
const row = (o: Record<string, unknown> = {}) => ({
  id: 'ck1', userId: 'u1', projectId: 'p1', workstream: 'main', instanceId: 'box1', session: 'me-proj-agent',
  mode: 'clear', requestedMode: 'clear', fromProvider: 'claude', toProvider: null, initiator: 'person', surface: 'web',
  note: null, state: 'requested', reason: null, body: null, contextTokensBefore: 200_000,
  createdAt: new Date(now - 1000), writeRequestedAt: null, writtenAt: null, resetAt: null, killedAt: null, launchedAt: null, doneAt: null,
  updatedAt: new Date(now), ...o,
});
const project = {
  name: 'proj', instanceId: 'box1', user: { unixUsername: 'me', defaultAgentProvider: null }, instance: { hostHome: '/home/me' },
  workstreams: [{ workflows: [{ id: 'wf1', type: 'agent', provider: 'claude' }] }],
};
const typed = () => vi.mocked(sendForProject).mock.calls.map(c => (c[2] as { keys: string }).keys);

describe('runHandoffTick', () => {
  let current: ReturnType<typeof row>;
  beforeEach(() => {
    vi.clearAllMocks();
    current = row();
    prisma.agentHandoff.findMany.mockImplementation(async () => [current]);
    prisma.agentHandoff.updateMany.mockImplementation(async (a: { where: { state: string }; data: Record<string, unknown> }) => {
      if (a.where.state !== current.state) return { count: 0 };
      current = { ...current, ...a.data } as ReturnType<typeof row>;
      return { count: 1 };
    });
    prisma.agentHandoff.findUnique.mockImplementation(async () => current);
    prisma.project.findFirst.mockResolvedValue(project);
    vi.mocked(getStatus).mockReturnValue({ status: 'idle' } as never);
  });

  it('reads only open handoffs', async () => {
    await runHandoffTick(now);
    expect(prisma.agentHandoff.findMany.mock.calls[0][0].where).toEqual({ state: { in: ['requested', 'writing', 'written', 'resetting'] } });
  });

  it('asks the idle agent for its handoff with a fixed line, and publishes the state', async () => {
    await runHandoffTick(now);
    expect(current.state).toBe('writing');
    expect(typed()).toEqual([expect.stringMatching(/^\[termag\] Hand off requested: .*handoffId ck1/)]);
    expect(vi.mocked(sendForProject).mock.calls[0][2]).toMatchObject({ sessionName: 'me-proj-agent', literal: true, withEnter: true });
    expect(vi.mocked(updateStatusMeta).mock.calls.at(-1)).toEqual(['me-proj-agent', { handoff: expect.objectContaining({ id: 'ck1', state: 'writing' }) }, 'box1']);
  });

  it('gives a pane with no status entry one, so the strip shows the handoff', async () => {
    vi.mocked(hasStatus).mockReturnValueOnce(false);
    current = row({ state: 'written', mode: 'restart', writtenAt: new Date(now - 5000) });
    vi.mocked(getStatus).mockReturnValue({ status: 'not_running' } as never);
    await runHandoffTick(now);
    expect(setStatus).toHaveBeenCalledWith('me-proj-agent', 'not_running', { handoff: expect.objectContaining({ id: 'ck1', state: 'written' }) }, undefined, 'box1');
  });

  it('types nothing into a pane with an approval prompt up', async () => {
    vi.mocked(getStatus).mockReturnValue({ status: 'waiting' } as never);
    await runHandoffTick(now);
    expect(current.state).toBe('requested');
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('clears, then reads the handoff back in once /clear has settled', async () => {
    current = row({ state: 'written', writtenAt: new Date(now - 5000), body: '## Goal' });
    await runHandoffTick(now);
    expect(current.state).toBe('resetting');
    expect(typed()).toEqual(['/clear']);
    await runHandoffTick(now + 1000);
    expect(typed()).toEqual(['/clear']);
    await runHandoffTick(now + 4000);
    expect(current.state).toBe('done');
    expect(typed()).toEqual(['/clear', expect.stringMatching(/Read ~\/\.termag\/handoffs\/ck1\.md and continue/)]);
  });

  it('retries the read-in line when typing it fails, instead of failing a cleared pane', async () => {
    current = row({ state: 'resetting', mode: 'clear', resetAt: new Date(now - 5000) });
    vi.mocked(sendForProject).mockRejectedValueOnce(new Error('box blip'));
    await runHandoffTick(now);
    expect(current.state).toBe('resetting');
    expect(current.launchedAt).toBeNull();
    await runHandoffTick(now + 5000);
    expect(current.state).toBe('done');
    expect(typed().filter(k => /Read ~\/\.termag\/handoffs/.test(k))).toHaveLength(2);
  });

  it('takes over a read-in claim a dead leader left, by its age', async () => {
    current = row({ state: 'resetting', mode: 'clear', resetAt: new Date(now - 60_000), launchedAt: new Date(now - 45_000) });
    await runHandoffTick(now);
    const where = prisma.agentHandoff.updateMany.mock.calls.find(c => c[0].data.launchedAt)![0].where;
    expect(where.OR).toEqual([{ launchedAt: null }, { launchedAt: { lt: new Date(now - 30_000) } }]);
    expect(current.state).toBe('done');
    expect(typed()).toEqual([expect.stringMatching(/Read ~\/\.termag\/handoffs\/ck1\.md/)]);
  });

  it('redoes the kill when a restart retry finds the pane was never killed', async () => {
    current = row({ state: 'resetting', mode: 'restart', resetAt: new Date(now - 20_000), killedAt: null });
    vi.mocked(getStatus).mockReturnValue({ status: 'working' } as never);
    await runHandoffTick(now);
    expect(stopAgentPane).toHaveBeenCalledTimes(1);
    expect(current.killedAt).toBeInstanceOf(Date);
    expect(ensureAgentSessionsAndLaunch).toHaveBeenCalledTimes(1);
  });

  it('only relaunches when the pane was already killed', async () => {
    current = row({ state: 'resetting', mode: 'restart', resetAt: new Date(now - 20_000), killedAt: new Date(now - 19_000) });
    await runHandoffTick(now);
    expect(stopAgentPane).not.toHaveBeenCalled();
    expect(ensureAgentSessionsAndLaunch).toHaveBeenCalledTimes(1);
  });

  it('puts an open handoff back on a status that lost it (an orchestrator restart)', async () => {
    current = row({ state: 'writing', writeRequestedAt: new Date(now - 1000) });
    vi.mocked(getStatus).mockReturnValue({ status: 'idle' } as never);
    await runHandoffTick(now);
    expect(updateStatusMeta).toHaveBeenCalledWith('me-proj-agent', { handoff: expect.objectContaining({ id: 'ck1', state: 'writing' }) }, 'box1');
    vi.mocked(updateStatusMeta).mockClear();
    vi.mocked(getStatus).mockReturnValue({ status: 'idle', handoff: { id: 'ck1', state: 'writing' } } as never);
    await runHandoffTick(now + 1000);
    expect(updateStatusMeta).not.toHaveBeenCalled();
  });

  it('clears pi with its own /new', async () => {
    current = row({ state: 'written', fromProvider: 'pi', writtenAt: new Date(now - 5000) });
    prisma.project.findFirst.mockResolvedValue({ ...project, workstreams: [{ workflows: [{ id: 'wf1', type: 'agent', provider: 'pi' }] }] });
    await runHandoffTick(now);
    expect(typed()).toEqual(['/new']);
  });

  it('compacts with focus instructions naming the handoff', async () => {
    current = row({ state: 'written', mode: 'compact', writtenAt: new Date(now - 5000) });
    await runHandoffTick(now);
    expect(typed()).toEqual([expect.stringMatching(/^\/compact Keep only .*~\/\.termag\/handoffs\/ck1\.md/)]);
  });

  it('restarts: switches the provider, kills the pane, resets its status and launches the next agent', async () => {
    current = row({ state: 'written', mode: 'restart', toProvider: 'cursor', writtenAt: new Date(now - 5000) });
    vi.mocked(ensureAgentSessionsAndLaunch).mockImplementation(async () => {
      current = { ...current, state: 'done', launchedAt: new Date(now), doneAt: new Date(now) };
      return 'launched';
    });
    await runHandoffTick(now);
    expect(prisma.workflow.update).toHaveBeenCalledWith({ where: { id: 'wf1' }, data: { provider: 'cursor', backend: null, model: null } });
    expect(vi.mocked(stopAgentPane).mock.calls[0][0]).toMatchObject({ provider: 'claude', workstream: 'main', instanceId: 'box1' });
    expect(markAgentPaneStopped).toHaveBeenCalledWith('me-proj-agent', 'box1', { handoff: expect.objectContaining({ state: 'resetting', toProvider: 'cursor' }) });
    expect(vi.mocked(ensureAgentSessionsAndLaunch).mock.calls[0][0]).toMatchObject({ provider: 'cursor', projectName: 'proj' });
    expect(current.state).toBe('done');
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('restarts what the pane runs now when no provider was asked for, never undoing a Switch agent', async () => {
    current = row({ state: 'written', mode: 'restart', toProvider: null, writtenAt: new Date(now - 5000) });
    prisma.project.findFirst.mockResolvedValue({ ...project, workstreams: [{ workflows: [{ id: 'wf1', type: 'agent', provider: 'devin' }] }] });
    await runHandoffTick(now);
    expect(prisma.workflow.update).not.toHaveBeenCalled();
    expect(vi.mocked(stopAgentPane).mock.calls[0][0]).toMatchObject({ provider: 'devin' });
    expect(vi.mocked(ensureAgentSessionsAndLaunch).mock.calls[0][0]).toMatchObject({ provider: 'devin' });
  });

  it('restarts a pane that reads not_running', async () => {
    current = row({ state: 'written', mode: 'restart', writtenAt: new Date(now - 5000) });
    vi.mocked(getStatus).mockReturnValue({ status: 'not_running' } as never);
    await runHandoffTick(now);
    expect(stopAgentPane).toHaveBeenCalledTimes(1);
    expect(ensureAgentSessionsAndLaunch).toHaveBeenCalledTimes(1);
  });

  it('takes the compact baseline when the reset starts, not at the request', async () => {
    current = row({ state: 'written', mode: 'compact', contextTokensBefore: 100_000, writtenAt: new Date(now - 5000) });
    vi.mocked(getStatus).mockReturnValue({ status: 'idle', contextTokens: 240_000 } as never);
    await runHandoffTick(now);
    expect(current.contextTokensBefore).toBe(240_000);
  });

  it('puts the provider back and fails when the box refuses the kill', async () => {
    current = row({ state: 'written', mode: 'restart', toProvider: 'cursor', writtenAt: new Date(now - 5000) });
    vi.mocked(stopAgentPane).mockRejectedValueOnce(new Error('tmux said no'));
    await runHandoffTick(now);
    expect(prisma.workflow.update.mock.calls.map(c => c[0].data.provider)).toEqual(['cursor', 'claude']);
    expect(current.state).toBe('failed');
    expect(current.reason).toMatch(/could not stop Claude: tmux said no/);
    expect(ensureAgentSessionsAndLaunch).not.toHaveBeenCalled();
  });

  it('aborts a handoff whose project is gone', async () => {
    prisma.project.findFirst.mockResolvedValue(null);
    await runHandoffTick(now);
    expect(current.state).toBe('aborted');
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('types nothing when another process claimed the step first', async () => {
    prisma.agentHandoff.updateMany.mockResolvedValue({ count: 0 });
    await runHandoffTick(now);
    expect(sendForProject).not.toHaveBeenCalled();
  });
});
