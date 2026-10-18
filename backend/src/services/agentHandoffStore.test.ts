import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  agentHandoff: { findFirst: vi.fn(), updateMany: vi.fn() },
}));
vi.mock('../db', () => ({ prisma }));

import { claimHandoffLaunch, releaseHandoffLaunch } from './agentHandoffStore';

const key = { userId: 'u1', projectId: 'p1', workstream: 'feat', provider: 'cursor' };

describe('claimHandoffLaunch', () => {
  beforeEach(() => {
    prisma.agentHandoff.findFirst.mockReset();
    prisma.agentHandoff.updateMany.mockReset();
  });

  it('starts a killed pane on its handoff and marks the handoff done', async () => {
    prisma.agentHandoff.findFirst.mockResolvedValue({ id: 'ck1', fromProvider: 'claude', toProvider: 'cursor' });
    prisma.agentHandoff.updateMany.mockResolvedValue({ count: 1 });
    await expect(claimHandoffLaunch(key)).resolves.toEqual({ id: 'ck1', command: 'cursor-agent "$(cat "$HOME/.termag/handoffs/ck1.md")"' });
    expect(prisma.agentHandoff.findFirst.mock.calls[0][0].where).toMatchObject({
      userId: 'u1', projectId: 'p1', workstream: 'feat', mode: 'restart', state: 'resetting', launchedAt: null,
    });
    expect(prisma.agentHandoff.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'ck1', state: 'resetting', launchedAt: null }, data: { state: 'done' } });
  });

  it('starts whatever the pane runs when the restart named no provider', async () => {
    prisma.agentHandoff.findFirst.mockResolvedValue({ id: 'ck1', fromProvider: 'claude', toProvider: null });
    prisma.agentHandoff.updateMany.mockResolvedValue({ count: 1 });
    await expect(claimHandoffLaunch(key)).resolves.toMatchObject({ command: 'cursor-agent "$(cat "$HOME/.termag/handoffs/ck1.md")"' });
  });

  it('never claims for a provider that cannot start on a file', async () => {
    prisma.agentHandoff.findFirst.mockResolvedValue({ id: 'ck1', fromProvider: 'claude', toProvider: null });
    await expect(claimHandoffLaunch({ ...key, provider: 'codex' })).resolves.toBeNull();
    expect(prisma.agentHandoff.updateMany).not.toHaveBeenCalled();
  });

  it('is a plain launch for another provider, no handoff, or no project', async () => {
    prisma.agentHandoff.findFirst.mockResolvedValue({ id: 'ck1', fromProvider: 'claude', toProvider: 'devin' });
    await expect(claimHandoffLaunch(key)).resolves.toBeNull();
    prisma.agentHandoff.findFirst.mockResolvedValue(null);
    await expect(claimHandoffLaunch(key)).resolves.toBeNull();
    await expect(claimHandoffLaunch({ ...key, projectId: null })).resolves.toBeNull();
  });

  it('is held when another claimer took the row between our read and our write', async () => {
    prisma.agentHandoff.findFirst.mockResolvedValue({ id: 'ck1', fromProvider: 'cursor', toProvider: null });
    prisma.agentHandoff.updateMany.mockResolvedValue({ count: 0 });
    await expect(claimHandoffLaunch(key)).resolves.toBe('held');
  });

  it('never holds a later launch once the restart is done (a Switch agent right after)', async () => {
    prisma.agentHandoff.findFirst.mockResolvedValue(null);
    await expect(claimHandoffLaunch(key)).resolves.toBeNull();
    expect(prisma.agentHandoff.findFirst).toHaveBeenCalledTimes(1);
  });

  it('never throws: a failed lookup is a plain launch', async () => {
    prisma.agentHandoff.findFirst.mockRejectedValue(new Error('db down'));
    await expect(claimHandoffLaunch(key)).resolves.toBeNull();
  });
});

describe('releaseHandoffLaunch', () => {
  it('hands the claim back to the sweep', async () => {
    prisma.agentHandoff.updateMany.mockResolvedValue({ count: 1 });
    await releaseHandoffLaunch('ck1');
    expect(prisma.agentHandoff.updateMany.mock.calls.at(-1)![0]).toEqual({
      where: { id: 'ck1', state: 'done' }, data: { launchedAt: null, doneAt: null, state: 'resetting' },
    });
  });
});
