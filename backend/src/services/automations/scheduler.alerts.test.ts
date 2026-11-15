// Every pause and box_unavailable skip the scheduler makes goes through alerts.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  automation: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  automationRun: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  instance: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock('../../db', () => ({ prisma }));
vi.mock('../agentRegistry', () => ({
  instanceAgentTransport: vi.fn(() => ({ capabilities: ['chat-runner-v1', 'chat-auto-v1'] })),
  isInstanceAgentConnected: vi.fn(() => true),
  sendForProject: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../boxPower', () => ({ PowerRequestConflict: class extends Error {}, requestPower: vi.fn(async () => 'starting') }));
vi.mock('../boxLifecycle', () => ({ registerBoxBusyCheck: vi.fn() }));
vi.mock('../boxActivity', () => ({ noteAutomationRunActivity: vi.fn(async () => undefined) }));
vi.mock('../featureFlags', () => ({ boolVariation: vi.fn(async () => true), jsonVariation: vi.fn(async () => null) }));
vi.mock('../../routes/workstreams', () => ({ removeWorkstreamFor: vi.fn(async () => ({ status: 200, body: {} })) }));
vi.mock('./complete', () => ({ reportRun: vi.fn(async () => undefined), pushNotesForRun: vi.fn(async () => undefined), queueNotesPushForRun: vi.fn(async () => ({ done: Promise.resolve() })), settleInterruptedRun: vi.fn(async () => undefined) }));
vi.mock('./alerts', () => ({ pauseAutomation: vi.fn(async () => undefined), noteFailedRun: vi.fn(async () => undefined) }));
vi.mock('./notices', () => ({
  startNoticeSweep: vi.fn(() => true),
  finishRunWithEvent: vi.fn(async (run: { id: string }, where: object, data: object) => (await prisma.automationRun.updateMany({ where: { ...where, id: run.id }, data })).count),
}));
vi.mock('./runner', () => ({ startRun: vi.fn(async () => ({ kind: 'started', workstreamId: 'w1', workstream: 'run-20261020-0900', branch: 'automation/triage/20261020-0900' })) }));

import { decideAndStart, resolvePending, schedulerTick, timeOutRuns } from './scheduler';
import { startRun } from './runner';
import { DEFAULT_AUTOMATION_LIMITS } from './limits';
import { isInstanceAgentConnected } from '../agentRegistry';
import { noteFailedRun, pauseAutomation } from './alerts';
import { finishRunWithEvent, startNoticeSweep } from './notices';

const now = new Date('2026-10-20T09:00:30Z');
const user = { id: 'u1', unixUsername: 'me', googleEmail: 'me@x', displayName: 'Me', defaultAgentProvider: 'claude' };
const instance = { id: 'box1', name: 'me-box', kind: 'ec2', status: 'ready', hostHome: '/home/me' };
const automation = {
  id: 'a1', projectId: 'p1', userId: 'u1', schedule: '0 9 * * 1-5', timezone: 'UTC', prompt: 'do it', tier: 'full', enabled: true, kind: 'chat',
  prOnChange: true, wakeBox: false, maxRunMinutes: 60, keepRuns: 20, spaceName: null, pausedReason: null, consecutiveFailures: 1, boxStartFailures: 0,
  nextRunAt: new Date('2026-10-20T09:00:00Z'), lastOccurrence: new Date('2026-10-16T09:00:00Z'), createdAt: now, updatedAt: now,
  project: { id: 'p1', name: 'triage', userId: 'u1', instanceId: 'box1', repoDefaultBranch: 'main', chatTrustedAt: now, archived: false, user, instance },
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.automation.update.mockResolvedValue({});
  prisma.automationRun.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, state: 'pending', trigger: 'schedule', scheduledFor: new Date('2026-10-20T09:00:00Z'), automationId: 'a1' }));
  prisma.automationRun.findMany.mockResolvedValue([]);
  prisma.automationRun.count.mockResolvedValue(0);
  prisma.automationRun.updateMany.mockResolvedValue({ count: 1 });
  prisma.user.findUnique.mockResolvedValue(user);
  prisma.instance.findUnique.mockResolvedValue(instance);
  prisma.automation.findMany.mockResolvedValue([]);
  vi.mocked(isInstanceAgentConnected).mockReturnValue(true);
});

describe('the scheduler\'s pauses and health alerts', () => {
  it('a box that is gone pauses through pauseAutomation, naming the run and the box', async () => {
    const gone = { ...automation, project: { ...automation.project, instance: { ...instance, status: 'terminated' } } };
    vi.mocked(isInstanceAgentConnected).mockReturnValue(false);
    expect(await decideAndStart(gone as never, 'r1', DEFAULT_AUTOMATION_LIMITS, now)).toEqual({ kind: 'skip', reason: 'box_gone' });
    expect(pauseAutomation).toHaveBeenCalledWith('a1', 'box_gone', { runId: 'r1', error: 'me-box is terminated' });
  });

  it('a parked box with Start the box off is a box_unavailable alert', async () => {
    const parked = { ...automation, project: { ...automation.project, instance: { ...instance, status: 'stopped' } } };
    vi.mocked(isInstanceAgentConnected).mockReturnValue(false);
    expect(await decideAndStart(parked as never, 'r1', DEFAULT_AUTOMATION_LIMITS, now)).toEqual({ kind: 'skip', reason: 'box_unavailable' });
    // The skip raises its run.box_unavailable event with the write; delivery tells the first of a streak.
    expect(finishRunWithEvent).toHaveBeenCalledWith({ id: 'r1', automationId: 'a1' }, { state: 'pending' }, expect.objectContaining({ state: 'skipped', reason: 'box_unavailable' }));
    expect(pauseAutomation).not.toHaveBeenCalled();
  });

  it('a pending run that waited past pendingMinutes is a box_unavailable alert too', async () => {
    prisma.automationRun.findMany.mockResolvedValue([{ id: 'r1', automationId: 'a1', createdAt: new Date(now.getTime() - 24 * 60 * 60_000) }]);
    prisma.automation.findUnique.mockResolvedValue(automation);
    await resolvePending(now);
    expect(finishRunWithEvent).toHaveBeenCalledWith({ id: 'r1', automationId: 'a1' }, { state: 'pending' }, expect.objectContaining({ state: 'skipped', reason: 'box_unavailable' }));
  });

  it('one run whose sweep step throws does not keep the sweep from the next', async () => {
    prisma.automationRun.findMany.mockResolvedValue([
      { id: 'r1', automationId: 'a1', createdAt: new Date(now.getTime() - 24 * 60 * 60_000) },
      { id: 'r2', automationId: 'a1', createdAt: new Date(now.getTime() - 24 * 60 * 60_000) },
    ]);
    prisma.automation.findUnique.mockRejectedValueOnce(new Error('db down')).mockResolvedValue(automation);
    await resolvePending(now);
    expect(finishRunWithEvent).toHaveBeenCalledWith({ id: 'r2', automationId: 'a1' }, { state: 'pending' }, expect.objectContaining({ reason: 'box_unavailable' }));
  });

  it('a timeout whose step throws does not keep the sweep from the next run', async () => {
    const late = (id: string) => ({
      id, automationId: 'a1', state: 'running', startedAt: new Date(now.getTime() - 61 * 60_000), scheduledFor: now,
      automation: { ...automation, project: { id: 'p1', name: 'triage', userId: 'u1', instanceId: 'box1' } }, workstream: { id: 'w1' },
    });
    prisma.automationRun.findMany.mockResolvedValue([late('r1'), late('r2')]);
    vi.mocked(noteFailedRun).mockRejectedValueOnce(new Error('db down'));
    expect(await timeOutRuns(now)).toBe(2);
    expect(noteFailedRun).toHaveBeenCalledTimes(2);
  });

  it('a launch that failed counts through noteFailedRun with its reason', async () => {
    vi.mocked(startRun).mockResolvedValueOnce({ kind: 'failed', reason: 'launch', error: 'git worktree add failed' });
    await decideAndStart(automation as never, 'r1', DEFAULT_AUTOMATION_LIMITS, now);
    expect(noteFailedRun).toHaveBeenCalledWith('a1', 1, DEFAULT_AUTOMATION_LIMITS.pauseAfterFailures, { id: 'r1', reason: 'launch' });
  });

  it('a timeout counts through noteFailedRun as a timeout', async () => {
    prisma.automationRun.findMany.mockResolvedValue([{
      id: 'r1', state: 'running', startedAt: new Date(now.getTime() - 61 * 60_000), scheduledFor: now,
      automation: { ...automation, project: { id: 'p1', name: 'triage', userId: 'u1', instanceId: 'box1' } }, workstream: { id: 'w1' },
    }]);
    expect(await timeOutRuns(now)).toBe(1);
    expect(noteFailedRun).toHaveBeenCalledWith('a1', 1, DEFAULT_AUTOMATION_LIMITS.pauseAfterFailures, { id: 'r1', reason: 'timeout' });
  });

  it('every tick starts the notice sweep without waiting on it', async () => {
    await schedulerTick(now);
    expect(startNoticeSweep).toHaveBeenCalledWith(now);
  });
});
