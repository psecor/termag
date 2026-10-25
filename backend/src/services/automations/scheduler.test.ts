import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  automation: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
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
vi.mock('../boxPower', () => ({ requestPower: vi.fn(async () => 'starting') }));
vi.mock('../boxLifecycle', () => ({ registerBoxBusyCheck: vi.fn() }));
vi.mock('../featureFlags', () => ({ boolVariation: vi.fn(async () => true), jsonVariation: vi.fn(async () => null) }));
vi.mock('../../routes/workstreams', () => ({ removeWorkstreamFor: vi.fn(async () => ({ status: 200, body: {} })) }));
vi.mock('./complete', () => ({ reportRun: vi.fn(async () => undefined), pushNotesForRun: vi.fn(async () => undefined), queueNotesPushForRun: vi.fn(async () => ({ done: Promise.resolve() })), settleInterruptedRun: vi.fn(async () => undefined) }));
vi.mock('./runner', () => ({ startRun: vi.fn(async () => ({ kind: 'started', workstreamId: 'w1', workstream: 'run-20261020-0900', branch: 'automation/triage/20261020-0900' })) }));

import { Prisma } from '@prisma/client';
import { dailyMinutesUsed, decideAndStart, NOTES_PUSH_DELAY_MS, resolvePending, retireBeyondKeep, startDue, timeOutRuns } from './scheduler';
import { startRun } from './runner';
import { reportRun, settleInterruptedRun } from './complete';
import { DEFAULT_AUTOMATION_LIMITS } from './limits';
import { requestPower } from '../boxPower';
import { isInstanceAgentConnected, sendForProject } from '../agentRegistry';
import { jsonVariation } from '../featureFlags';
import { removeWorkstreamFor } from '../../routes/workstreams';

const now = new Date('2026-10-20T09:00:30Z');
const user = { id: 'u1', unixUsername: 'me', googleEmail: 'me@x', displayName: 'Me', defaultAgentProvider: 'claude' };
const instance = { id: 'box1', name: 'me-box', kind: 'ec2', status: 'ready', hostHome: '/home/me' };
const automation = {
  id: 'a1', projectId: 'p1', userId: 'u1', schedule: '0 9 * * 1-5', timezone: 'UTC', prompt: 'do it', tier: 'full', enabled: true,
  prOnChange: true, wakeBox: false, maxRunMinutes: 60, keepRuns: 20, spaceName: null, pausedReason: null, consecutiveFailures: 0,
  nextRunAt: new Date('2026-10-20T09:00:00Z'), lastOccurrence: new Date('2026-10-16T09:00:00Z'), createdAt: now, updatedAt: now,
  project: { id: 'p1', name: 'triage', userId: 'u1', instanceId: 'box1', repoDefaultBranch: 'main', chatTrustedAt: now, archived: false, user, instance },
};

function p2002(): Error {
  return new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.automation.update.mockResolvedValue({});
  prisma.automationRun.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: `r-${(data.scheduledFor as Date).toISOString()}`, ...data }));
  prisma.automationRun.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, state: 'pending', trigger: 'schedule', scheduledFor: new Date('2026-10-20T09:00:00Z'), automationId: 'a1' }));
  prisma.automationRun.findMany.mockResolvedValue([]);
  prisma.automationRun.count.mockResolvedValue(0);
  prisma.automationRun.update.mockResolvedValue({});
  prisma.automationRun.updateMany.mockResolvedValue({ count: 1 });
  prisma.user.findUnique.mockResolvedValue(user);
  prisma.instance.findUnique.mockResolvedValue(instance);
  vi.mocked(isInstanceAgentConnected).mockReturnValue(true);
});

describe('startDue', () => {
  it('runs the newest missed occurrence and records the others as missed', async () => {
    prisma.automation.findMany.mockResolvedValue([automation]);
    const started = await startDue(now);
    expect(started).toBe(1);
    // Fri 16 Oct 09:00 was the last enumerated: Mon 19 and Tue 20 are due; Mon is missed, Tue runs.
    const creates = prisma.automationRun.create.mock.calls.map(c => c[0].data);
    expect(creates).toEqual([
      expect.objectContaining({ scheduledFor: new Date('2026-10-19T09:00:00Z'), state: 'skipped', reason: 'missed' }),
      expect.objectContaining({ scheduledFor: new Date('2026-10-20T09:00:00Z'), state: 'pending', trigger: 'schedule' }),
    ]);
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      project: expect.objectContaining({ id: 'p1', instanceId: 'box1' }),
    }));
    expect(prisma.automation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ nextRunAt: new Date('2026-10-21T09:00:00Z'), lastOccurrence: new Date('2026-10-20T09:00:00Z') }),
    }));
  });

  it('leaves an occurrence another process already made', async () => {
    prisma.automation.findMany.mockResolvedValue([{ ...automation, lastOccurrence: new Date('2026-10-19T09:00:00Z') }]);
    prisma.automationRun.create.mockRejectedValueOnce(p2002());
    expect(await startDue(now)).toBe(0);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('skips the occurrence and says why when the box is asleep and wake is off', async () => {
    prisma.automation.findMany.mockResolvedValue([{ ...automation, lastOccurrence: new Date('2026-10-19T09:00:00Z'), project: { ...automation.project, instance: { ...instance, status: 'hibernated' } } }]);
    vi.mocked(isInstanceAgentConnected).mockReturnValue(false);
    expect(await startDue(now)).toBe(0);
    expect(prisma.automationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ state: 'pending' }), data: expect.objectContaining({ state: 'skipped', reason: 'box_unavailable' }) }));
    expect(requestPower).not.toHaveBeenCalled();
  });

  it('starts the box and leaves the run pending when wake is on', async () => {
    prisma.automation.findMany.mockResolvedValue([{ ...automation, wakeBox: true, lastOccurrence: new Date('2026-10-19T09:00:00Z'), project: { ...automation.project, instance: { ...instance, status: 'hibernated' } } }]);
    vi.mocked(isInstanceAgentConnected).mockReturnValue(false);
    expect(await startDue(now)).toBe(0);
    expect(requestPower).toHaveBeenCalledWith(expect.objectContaining({ id: 'box1' }), 'start');
    expect(prisma.automationRun.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'skipped' }) }));
  });

  it('skips when the previous run is still live', async () => {
    prisma.automation.findMany.mockResolvedValue([{ ...automation, lastOccurrence: new Date('2026-10-19T09:00:00Z') }]);
    prisma.automationRun.count.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => ('automationId' in where ? 1 : 0));
    await startDue(now);
    expect(prisma.automationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ state: 'pending' }), data: expect.objectContaining({ state: 'skipped', reason: 'previous_running' }) }));
    expect(startRun).not.toHaveBeenCalled();
  });

  it('fails the run and counts the failure when the start fails, and does not count it as started', async () => {
    prisma.automation.findMany.mockResolvedValue([{ ...automation, lastOccurrence: new Date('2026-10-19T09:00:00Z'), consecutiveFailures: 2 }]);
    vi.mocked(startRun).mockResolvedValueOnce({ kind: 'failed', reason: 'launch', error: 'git worktree add failed' });
    expect(await startDue(now)).toBe(0);
    expect(prisma.automationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ state: 'running' }), data: expect.objectContaining({ state: 'failed', reason: 'launch' }) }));
    expect(prisma.automation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ consecutiveFailures: 3, pausedReason: 'consecutive_failures' }) }));
  });

  it('leaves the workstream link to the runner (it is written before the brief is sent)', async () => {
    prisma.automation.findMany.mockResolvedValue([{ ...automation, lastOccurrence: new Date('2026-10-19T09:00:00Z') }]);
    expect(await startDue(now)).toBe(1);
    expect(prisma.automationRun.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ workstreamId: 'w1' }) }));
  });
});

describe('decideAndStart', () => {
  it('reports a failed start as failed, not as a start', async () => {
    vi.mocked(startRun).mockResolvedValueOnce({ kind: 'failed', reason: 'launch', error: 'the box said no' });
    const limits = { ...DEFAULT_AUTOMATION_LIMITS };
    expect(await decideAndStart(automation as never, 'r1', limits, now)).toEqual({ kind: 'failed', reason: 'launch', error: 'the box said no' });
  });

  it('leaves a row that completion already finished alone when the send then reports an error', async () => {
    vi.mocked(startRun).mockResolvedValueOnce({ kind: 'failed', reason: 'launch', error: 'late error' });
    prisma.automationRun.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await decideAndStart(automation as never, 'r1', DEFAULT_AUTOMATION_LIMITS, now)).toEqual({ kind: 'start' });
    expect(prisma.automation.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ consecutiveFailures: 1 }) }));
  });

  it('treats a send with no reply as started: the turn may be live', async () => {
    vi.mocked(startRun).mockResolvedValueOnce({ kind: 'unknown', workstreamId: 'w1', workstream: 'run-20261020-0900', branch: 'b', error: 'Agent request timed out: chat-send' });
    expect(await decideAndStart(automation as never, 'r1', DEFAULT_AUTOMATION_LIMITS, now)).toEqual({ kind: 'start' });
    expect(prisma.automationRun.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'failed' }) }));
  });

  it('reports an older runner as a skip', async () => {
    vi.mocked(startRun).mockResolvedValueOnce({ kind: 'failed', reason: 'runner_outdated', error: 'mode-refused' });
    expect(await decideAndStart(automation as never, 'r1', DEFAULT_AUTOMATION_LIMITS, now)).toEqual({ kind: 'skip', reason: 'runner_outdated' });
    expect(prisma.automation.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ consecutiveFailures: 1 }) }));
  });
});

describe('skip write', () => {
  it('leaves a row another process already claimed: only a pending row is skipped', async () => {
    vi.mocked(isInstanceAgentConnected).mockReturnValue(false);
    prisma.instance.findUnique.mockResolvedValue({ ...instance, status: 'stopped' });
    prisma.automationRun.updateMany.mockResolvedValueOnce({ count: 0 });
    const a = { ...automation, project: { ...automation.project, instance: { ...instance, status: 'stopped' } } };
    expect(await decideAndStart(a as never, 'r1', DEFAULT_AUTOMATION_LIMITS, now)).toEqual({ kind: 'skip', reason: 'previous_running' });
    expect(prisma.automationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r1', state: 'pending' }, data: expect.objectContaining({ state: 'skipped' }) }));
    expect(prisma.automationRun.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'skipped' }) }));
  });
});

describe('box cap after the claim', () => {
  it("steps back when another leader's claim filled the box first, and starts when it is within the cap", async () => {
    const limits = { ...DEFAULT_AUTOMATION_LIMITS, perBoxConcurrent: 1 };
    // The box's running rows (dailyMinutesUsed reads runs through the same findMany, by owner).
    let onBox = [{ id: 'other' }, { id: 'r1' }];
    prisma.automationRun.findMany.mockImplementation(async ({ where }: { where: { instanceId?: string } }) => (where.instanceId ? onBox : []));
    expect(await decideAndStart(automation as never, 'r1', limits, now)).toEqual({ kind: 'skip', reason: 'box_concurrent' });
    expect(startRun).not.toHaveBeenCalled();
    expect(prisma.automationRun.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: 'r1', state: 'running' }, data: expect.objectContaining({ state: 'skipped', reason: 'box_concurrent' }) }));
    onBox = [{ id: 'r1' }, { id: 'other' }];
    expect(await decideAndStart(automation as never, 'r1', limits, now)).toEqual({ kind: 'start' });
    expect(startRun).toHaveBeenCalledTimes(1);
  });
});

describe('resolvePending', () => {
  const waiting = { id: 'r1', automationId: 'a1', createdAt: new Date(now.getTime() - 5 * 60_000) };

  it('starts a pending run whose automation is still enabled', async () => {
    prisma.automationRun.findMany.mockResolvedValue([waiting]);
    prisma.automation.findUnique.mockResolvedValue(automation);
    await resolvePending(now);
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it('skips a pending run whose automation was disabled while it waited', async () => {
    prisma.automationRun.findMany.mockResolvedValue([waiting]);
    prisma.automation.findUnique.mockResolvedValue({ ...automation, enabled: false });
    await resolvePending(now);
    expect(startRun).not.toHaveBeenCalled();
    expect(prisma.automationRun.updateMany).toHaveBeenCalledWith({ where: { id: 'r1', state: 'pending' }, data: { state: 'skipped', reason: 'disabled', finishedAt: now } });
  });

  it('skips a pending run whose project was archived while it waited', async () => {
    prisma.automationRun.findMany.mockResolvedValue([waiting]);
    prisma.automation.findUnique.mockResolvedValue({ ...automation, project: { ...automation.project, archived: true } });
    await resolvePending(now);
    expect(startRun).not.toHaveBeenCalled();
    expect(prisma.automationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'skipped', reason: 'disabled' }) }));
  });
});

describe('timeOutRuns', () => {
  const late = {
    id: 'r1', state: 'running', startedAt: new Date(now.getTime() - 61 * 60_000), scheduledFor: now,
    automation: { ...automation, project: { id: 'p1', name: 'triage', userId: 'u1', instanceId: 'box1' } }, workstream: { id: 'w1' },
  };

  it('fails a run past its limit before interrupting it, whatever its status', async () => {
    prisma.automationRun.findMany.mockResolvedValue([late]);
    expect(await timeOutRuns(now)).toBe(1);
    expect(sendForProject).toHaveBeenCalledWith({ userId: 'u1', instanceId: 'box1' }, 'chat-interrupt', { chatKey: 'p1--w1' }, 10_000);
    expect(prisma.automationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'failed', reason: 'timeout' }) }));
    // The row is written first: the turn-end the interrupt causes must find it already failed.
    expect(prisma.automationRun.updateMany.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(sendForProject).mock.invocationCallOrder[0]);
  });

  it('hands the run to settleInterruptedRun with the delay (push queued now, report after), and reports nothing mid-turn itself', async () => {
    prisma.automationRun.findMany.mockResolvedValue([late]);
    await timeOutRuns(now);
    expect(reportRun).not.toHaveBeenCalled();
    expect(settleInterruptedRun).toHaveBeenCalledWith('r1', NOTES_PUSH_DELAY_MS);
  });

  it('leaves a run that finished on its own meanwhile alone', async () => {
    prisma.automationRun.findMany.mockResolvedValue([late]);
    prisma.automationRun.updateMany.mockResolvedValue({ count: 0 });
    expect(await timeOutRuns(now)).toBe(0);
    expect(sendForProject).not.toHaveBeenCalled();
    expect(prisma.automation.update).not.toHaveBeenCalled();
  });

  it('reads the pause threshold for the real owner and box', async () => {
    prisma.automationRun.findMany.mockResolvedValue([{ ...late, automation: { ...late.automation, consecutiveFailures: 1 } }]);
    vi.mocked(jsonVariation).mockResolvedValueOnce({ pauseAfterFailures: 2 });
    expect(await timeOutRuns(now)).toBe(1);
    expect(jsonVariation).toHaveBeenCalledWith('automation-limits', expect.objectContaining({ id: 'u1', unixUsername: 'me', googleEmail: 'me@x' }), null, expect.objectContaining({ id: 'box1', name: 'me-box', kind: 'ec2' }));
    expect(prisma.automation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ consecutiveFailures: 2, pausedReason: 'consecutive_failures' }) }));
  });

  it('leaves a run inside its limit alone', async () => {
    prisma.automationRun.findMany.mockResolvedValue([{
      id: 'r1', state: 'running', startedAt: new Date(now.getTime() - 10 * 60_000), scheduledFor: now,
      automation: { ...automation, project: { id: 'p1', name: 'triage', userId: 'u1', instanceId: 'box1' } }, workstream: { id: 'w1' },
    }]);
    expect(await timeOutRuns(now)).toBe(0);
    expect(sendForProject).not.toHaveBeenCalled();
  });
});

describe('dailyMinutesUsed', () => {
  it('adds finished runs and the live ones so far', async () => {
    prisma.automationRun.findMany.mockResolvedValue([
      { startedAt: new Date('2026-10-20T01:00:00Z'), finishedAt: new Date('2026-10-20T01:30:00Z'), state: 'done' },
      { startedAt: new Date('2026-10-20T08:50:30Z'), finishedAt: null, state: 'running' },
      { startedAt: null, finishedAt: null, state: 'skipped' },
    ]);
    expect(await dailyMinutesUsed('u1', now)).toBe(40);
  });
});

describe('startDue after a long outage', () => {
  it('runs the newest due occurrence even when the enumeration was cut off, and records only older ones as missed', async () => {
    // Every 15 minutes, last enumerated 30 days ago: thousands of occurrences, far past MAX_ENUMERATED.
    prisma.automation.findMany.mockResolvedValue([{ ...automation, schedule: '*/15 * * * *', lastOccurrence: new Date('2026-09-20T09:00:00Z') }]);
    await startDue(now);
    const creates = prisma.automationRun.create.mock.calls.map(c => c[0].data);
    const pending = creates.filter(d => d.state === 'pending');
    expect(pending).toEqual([expect.objectContaining({ scheduledFor: new Date('2026-10-20T09:00:00Z') })]);
    expect(creates.filter(d => d.state === 'skipped').every(d => (d.scheduledFor as Date).getTime() < new Date('2026-10-20T09:00:00Z').getTime())).toBe(true);
    expect(prisma.automation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastOccurrence: new Date('2026-10-20T09:00:00Z') }) }));
  });
});

describe('retireBeyondKeep', () => {
  it('retires a skipped launch still linked to a worktree, whatever keepRuns says', async () => {
    prisma.automation.findMany.mockResolvedValue([{ id: 'a1', keepRuns: 20, userId: 'u1', projectId: 'p1', project: { name: 'triage' } }]);
    prisma.automationRun.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'r-stray', workstreamId: 'w-stray' }]);
    expect(await retireBeyondKeep(now)).toBe(1);
    expect(prisma.automationRun.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ state: 'skipped', workstreamId: { not: null } }) }));
    expect(removeWorkstreamFor).toHaveBeenCalledWith(expect.anything(), 'p1', 'w-stray', { force: false });
    expect(prisma.automationRun.update).toHaveBeenCalledWith({ where: { id: 'r-stray' }, data: { retiredAt: now, workstreamId: null } });
  });
});

describe('retire', () => {
  it('is wired to removeWorkstreamFor', () => {
    expect(removeWorkstreamFor).toBeDefined();
  });
});
