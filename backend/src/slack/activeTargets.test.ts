import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  chatActiveTarget: { upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({})), findMany: vi.fn(async () => [] as unknown[]) },
}));
vi.mock('../db', () => ({ prisma }));

import {
  clearActiveTarget, getActiveTarget, guessActiveTarget, loadActiveTargets, loadActiveTargetsOrRetry, resetActiveTargetsForTests, setActiveTarget,
} from './activeTargets';

const t = (iso: string) => new Date(iso);
const row = (chatUserId: string, projectId: string, updatedAt: string, workstream = 'main') =>
  ({ platform: 'slack', chatUserId, projectId, workstream, updatedAt: t(updatedAt) });

describe('active targets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetActiveTargetsForTests();
    prisma.chatActiveTarget.findMany.mockResolvedValue([]);
  });

  it('answers from the map and writes each choice through, with the same time', async () => {
    setActiveTarget('discord', '1234', { projectId: 'p1', workstream: 'fix' }, t('2026-10-23T10:00:00Z'));
    expect(getActiveTarget('1234')).toEqual({ projectId: 'p1', workstream: 'fix' });
    await vi.waitFor(() => expect(prisma.chatActiveTarget.upsert).toHaveBeenCalledWith({
      where: { platform_chatUserId: { platform: 'discord', chatUserId: '1234' } },
      update: { projectId: 'p1', workstream: 'fix', updatedAt: t('2026-10-23T10:00:00Z') },
      create: { platform: 'discord', chatUserId: '1234', projectId: 'p1', workstream: 'fix', updatedAt: t('2026-10-23T10:00:00Z') },
    }));
    expect(getActiveTarget('U-nobody')).toBeNull();
  });

  it('forgets a target in the map and the table', async () => {
    setActiveTarget('slack', 'U1', { projectId: 'p1', workstream: 'main' });
    clearActiveTarget('slack', 'U1');
    expect(getActiveTarget('U1')).toBeNull();
    await vi.waitFor(() => expect(prisma.chatActiveTarget.deleteMany).toHaveBeenCalledWith({ where: { platform: 'slack', chatUserId: 'U1' } }));
  });

  it("commits one person's writes in the order they were made", async () => {
    const committed: string[] = [];
    let releaseFirst!: () => void;
    prisma.chatActiveTarget.upsert
      .mockImplementationOnce((async (args: any) => { await new Promise<void>(r => { releaseFirst = r; }); committed.push(args.create.projectId); }) as never)
      .mockImplementationOnce((async (args: any) => { committed.push(args.create.projectId); }) as never);
    setActiveTarget('slack', 'U1', { projectId: 'first', workstream: 'main' });
    setActiveTarget('slack', 'U1', { projectId: 'second', workstream: 'main' });
    await vi.waitFor(() => expect(prisma.chatActiveTarget.upsert).toHaveBeenCalledTimes(1));
    releaseFirst();
    await vi.waitFor(() => expect(committed).toEqual(['first', 'second']));
    expect(getActiveTarget('U1')?.projectId).toBe('second');
  });

  it('brings saved targets back after a restart, skipping archived projects', async () => {
    prisma.chatActiveTarget.findMany.mockResolvedValue([row('U1', 'p1', '2026-10-23T09:00:00Z', 'fix'), row('U2', 'p2', '2026-10-23T09:00:00Z')]);
    expect(await loadActiveTargets()).toBe(2);
    expect(prisma.chatActiveTarget.findMany).toHaveBeenCalledWith({ where: { project: { archived: false } } });
    expect(getActiveTarget('U1')).toEqual({ projectId: 'p1', workstream: 'fix' });
    expect(getActiveTarget('U2')).toEqual({ projectId: 'p2', workstream: 'main' });
  });

  it('keeps a choice made since its row was written, and takes a newer one from another lease holder', async () => {
    setActiveTarget('slack', 'U1', { projectId: 'mine-new', workstream: 'main' }, t('2026-10-23T10:00:00Z'));
    setActiveTarget('slack', 'U2', { projectId: 'mine-old', workstream: 'main' }, t('2026-10-23T08:00:00Z'));
    prisma.chatActiveTarget.findMany.mockResolvedValue([
      row('U1', 'saved-older', '2026-10-23T09:00:00Z'),
      row('U2', 'theirs-newer', '2026-10-23T09:00:00Z'),
    ]);
    await loadActiveTargets();
    expect(getActiveTarget('U1')?.projectId).toBe('mine-new');
    expect(getActiveTarget('U2')?.projectId).toBe('theirs-newer');
  });

  it('never saves a guess, and lets any saved row replace it', async () => {
    guessActiveTarget('U1', { projectId: 'first-alphabetically', workstream: 'main' });
    expect(getActiveTarget('U1')?.projectId).toBe('first-alphabetically');
    expect(prisma.chatActiveTarget.upsert).not.toHaveBeenCalled();
    prisma.chatActiveTarget.findMany.mockResolvedValue([row('U1', 'their-choice', '2026-10-01T00:00:00Z')]);
    await loadActiveTargets();
    expect(getActiveTarget('U1')?.projectId).toBe('their-choice');
  });

  it('never lets a guess replace a target that arrived first', async () => {
    // A retried load fills the slot while the caller is still looking up its fallback.
    prisma.chatActiveTarget.findMany.mockResolvedValue([row('U1', 'their-choice', '2026-10-01T00:00:00Z')]);
    await loadActiveTargets();
    guessActiveTarget('U1', { projectId: 'first-alphabetically', workstream: 'main' });
    expect(getActiveTarget('U1')?.projectId).toBe('their-choice');
  });

  it('keeps trying a failed load every 30 s until one works', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      prisma.chatActiveTarget.findMany
        .mockRejectedValueOnce(new Error('db down'))
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValue([row('U1', 'p1', '2026-10-23T09:00:00Z')]);
      await loadActiveTargetsOrRetry('SLACK');
      await loadActiveTargetsOrRetry('DISCORD'); // a second bot's start: still one retry timer
      expect(error).toHaveBeenCalledWith('[SLACK] Could not load the saved /t targets, trying again in 30 s:', 'db down');
      expect(getActiveTarget('U1')).toBeNull();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getActiveTarget('U1')?.projectId).toBe('p1');
      expect(prisma.chatActiveTarget.findMany).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it('logs a failed write rather than failing the command', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.chatActiveTarget.upsert.mockRejectedValueOnce(new Error('db down'));
    expect(() => setActiveTarget('slack', 'U1', { projectId: 'p1', workstream: 'main' })).not.toThrow();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[CHAT] Failed to save the active target:', 'db down'));
    expect(getActiveTarget('U1')?.projectId).toBe('p1');
    error.mockRestore();
  });
});
