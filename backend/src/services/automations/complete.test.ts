import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  automationRun: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  automation: { update: vi.fn() },
  instance: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock('../../db', () => ({ prisma }));
vi.mock('./memorySync', () => ({ syncMemory: vi.fn(async () => 'done') }));
vi.mock('./runner', () => ({ memoryDir: (home: string, projectId: string) => `${home}/.termag/automations/${projectId}/memory` }));
vi.mock('./limits', () => ({ automationLimitsFor: vi.fn(async () => ({ pauseAfterFailures: 3 })) }));
vi.mock('./report', () => ({
  summarizeBranch: vi.fn(async () => ({ commitsAhead: 2, pushed: true, dirty: false })),
  postRunReport: vi.fn(async () => true),
}));
vi.mock('../tmux', () => ({ projectDirFor: vi.fn(() => '/home/me/termag/projects/triage/.worktrees/run-x') }));

import { completeRun, finishFields, noteEvent, pendingResultFor, pushNotesForRun, settleInterruptedRun } from './complete';
import { syncMemory } from './memorySync';
import { postRunReport, summarizeBranch } from './report';

const seen = (workstreamId: string, event: unknown) => ({ projectId: 'p1', workstream: 'run-x', workstreamId, instanceId: 'box1', turnId: 't1', event });

describe('noteEvent', () => {
  it('remembers the session, the result and the usage, and says when the turn ended', () => {
    expect(noteEvent(seen('w1', { type: 'system', subtype: 'init', session_id: 'sess-1234567' }))).toBe(false);
    expect(noteEvent(seen('w1', { type: 'assistant', message: {} }))).toBe(false);
    expect(noteEvent(seen('w1', { type: 'result', result: 'STATUS: done all good', total_cost_usd: 0.12, usage: { input_tokens: 10, output_tokens: 5 } }))).toBe(false);
    expect(noteEvent(seen('w1', { type: 'turn-end', exitCode: 0 }))).toBe(true);
    expect(pendingResultFor('p1', 'w1')).toMatchObject({ sessionId: 'sess-1234567', text: 'STATUS: done all good', costUsd: 0.12, inputTokens: 10, outputTokens: 5 });
  });

  it('keeps what another project\'s box says about the same workstream id apart', () => {
    noteEvent(seen('w2', { type: 'result', result: 'STATUS: done mine' }));
    noteEvent({ ...seen('w2', { type: 'result', result: 'STATUS: failed forged' }), projectId: 'p-other', instanceId: 'box-other' });
    expect(pendingResultFor('p1', 'w2')).toMatchObject({ text: 'STATUS: done mine' });
    expect(pendingResultFor('p-other', 'w2')).toMatchObject({ text: 'STATUS: failed forged' });
  });

  it('ignores events with no workstream', () => {
    expect(noteEvent(seen('', { type: 'turn-end' }))).toBe(false);
  });
});

describe('completeRun', () => {
  const ref = (workstreamId: string, projectId = 'p1', instanceId = 'box1') => ({ projectId, instanceId, workstreamId });
  const run = (state: string) => ({
    id: 'r1', state, workstreamId: 'w1', instanceId: 'box1', scheduledFor: new Date('2026-10-20T09:00:00Z'), chatSessionId: null,
    reason: null, summary: null, prUrl: null, costUsd: null, commitsAhead: null, pushed: null, dirty: null, reportedAt: null, workstream: { name: 'run-x' },
    automation: { id: 'a1', userId: 'u1', projectId: 'p1', spaceName: 'team', notifySlack: true, timezone: 'UTC', consecutiveFailures: 0, project: { name: 'triage', userId: 'u1', instanceId: 'box1', slackChannelId: 'C1', instance: { hostHome: '/home/me' }, user: { unixUsername: 'me' } } },
  });
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.automationRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.automationRun.update.mockResolvedValue({});
    prisma.automation.update.mockResolvedValue({});
    prisma.instance.findUnique.mockResolvedValue({ id: 'box1', hostHome: '/home/me', hostUnixUser: 'me' });
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', unixUsername: 'me' });
  });

  it('finishes a running row, then pushes the notes and waits for the push', async () => {
    prisma.automationRun.findUnique.mockResolvedValue(run('running'));
    await completeRun(ref('w1'), { exitCode: 0 });
    expect(prisma.automationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r1', state: 'running' }, data: expect.objectContaining({ state: 'done' }) }));
    expect(syncMemory).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1', spaceName: 'team', projectId: 'p1', projectName: 'triage', memoryDir: '/home/me/.termag/automations/p1/memory' }), 'put', expect.anything());
    expect(prisma.automationRun.updateMany.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(syncMemory).mock.invocationCallOrder[0]);
  });

  it('reports what the row says, but pushes no notes, for a turn-end on a row the timeout sweep or Stop finished (those push through pushNotesForRun)', async () => {
    prisma.automationRun.findUnique.mockResolvedValue({ ...run('failed'), reason: 'timeout', summary: 'stopped after 60 minutes' });
    await completeRun(ref('w1'), { exitCode: null, signal: 'SIGINT' });
    expect(prisma.automationRun.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ state: 'running' }) }));
    expect(prisma.automation.update).not.toHaveBeenCalled();
    expect(postRunReport).toHaveBeenCalledWith('C1', expect.objectContaining({ run: expect.objectContaining({ state: 'failed', reason: 'timeout', summary: 'stopped after 60 minutes' }), changes: { commitsAhead: 2, pushed: true, dirty: false } }));
    // reportedAt is claimed before the post, on a row not yet reported.
    expect(prisma.automationRun.updateMany).toHaveBeenCalledWith({ where: { id: 'r1', reportedAt: null }, data: { reportedAt: expect.any(Date) } });
    expect(prisma.automationRun.updateMany.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(postRunReport).mock.invocationCallOrder[0]);
    expect(syncMemory).not.toHaveBeenCalled();
    await pushNotesForRun('r1');
    expect(syncMemory).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1', spaceName: 'team' }), 'put', expect.anything());
  });

  it('summarizes the branch once: a follow-up turn-end leaves the run\'s Changes alone', async () => {
    prisma.automationRun.findUnique.mockResolvedValue({ ...run('done'), commitsAhead: 1, pushed: false, dirty: false, automation: { ...run('done').automation, notifySlack: false } });
    await completeRun(ref('w1'), { exitCode: 0 });
    expect(prisma.automationRun.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ commitsAhead: expect.anything() }) }));
  });

  it('reports a run once: a follow-up turn on a reported row posts nothing, and a lost claim posts nothing', async () => {
    prisma.automationRun.findUnique.mockResolvedValue({ ...run('done'), reportedAt: new Date() });
    await completeRun(ref('w1'), { exitCode: 0 });
    expect(postRunReport).not.toHaveBeenCalled();
    prisma.automationRun.findUnique.mockResolvedValue(run('done'));
    prisma.automationRun.updateMany.mockResolvedValue({ count: 0 }); // another caller claimed reportedAt first
    await completeRun(ref('w1'), { exitCode: 0 });
    expect(postRunReport).not.toHaveBeenCalled();
  });

  it('claims the report even when there is nowhere to post it, so a later follow-up or opt-in posts nothing for this run', async () => {
    prisma.automationRun.findUnique.mockResolvedValue({ ...run('done'), commitsAhead: 0, pushed: true, dirty: false, reportedAt: null, automation: { ...run('done').automation, notifySlack: false } });
    await completeRun(ref('w1'), { exitCode: 0 });
    expect(prisma.automationRun.updateMany).toHaveBeenCalledWith({ where: { id: 'r1', reportedAt: null }, data: { reportedAt: expect.any(Date) } });
    expect(postRunReport).not.toHaveBeenCalled();
  });

  it('settles an interrupted run: the push is queued at once, the branch is read only after the delay', async () => {
    vi.useFakeTimers();
    try {
      const row = { ...run('failed'), reason: 'timeout', commitsAhead: null, pushed: null, dirty: null, reportedAt: null, workstream: { name: 'run-x' },
        automation: { ...run('failed').automation, timezone: 'UTC', notifySlack: false, project: { ...run('failed').automation.project, user: { unixUsername: 'me' }, instance: { hostHome: '/home/me' } } } };
      prisma.automationRun.findUnique.mockResolvedValue(row);
      await settleInterruptedRun('r1', 5000);
      expect(syncMemory).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1' }), 'put', { delayMs: 5000 });
      expect(summarizeBranch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
      expect(summarizeBranch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pushes nothing for a run that Stop or the sweep failed in its setup: never linked to a workstream, so never past its pull', async () => {
    prisma.automationRun.findUnique.mockResolvedValue({ ...run('failed'), reason: 'interrupted', workstreamId: null });
    await pushNotesForRun('r1');
    expect(syncMemory).not.toHaveBeenCalled();
  });

  it('ignores a turn-end from another project or box naming this run\'s workstream: no finish, no notes push, no report', async () => {
    prisma.automationRun.findUnique.mockResolvedValue(run('running'));
    await completeRun(ref('w1', 'p-other', 'box-other'), { exitCode: 0 });
    await completeRun(ref('w1', 'p1', 'box-other'), { exitCode: 0 });
    expect(prisma.automationRun.updateMany).not.toHaveBeenCalled();
    expect(syncMemory).not.toHaveBeenCalled();
    expect(postRunReport).not.toHaveBeenCalled();
  });

  it('pushes nothing for an automation without a space, and nothing for a workstream that is no run', async () => {
    prisma.automationRun.findUnique.mockResolvedValueOnce({ ...run('running'), automation: { ...run('running').automation, spaceName: null } });
    await completeRun(ref('w1'), { exitCode: 0 });
    prisma.automationRun.findUnique.mockResolvedValueOnce(null);
    await completeRun(ref('w9'), { exitCode: 0 });
    expect(syncMemory).not.toHaveBeenCalled();
  });
});

describe('finishFields', () => {
  it('reads the report of a clean turn', () => {
    expect(finishFields({ text: 'STATUS: needs_input which repo?', costUsd: null, inputTokens: null, outputTokens: null, sessionId: null, isError: false, runnerError: null }, { exitCode: 0 }))
      .toEqual({ state: 'needs_input', reason: null, summary: 'which repo?', prUrl: null });
  });

  it('fails a turn that errored, was interrupted, or was lost', () => {
    expect(finishFields({ text: null, costUsd: null, inputTokens: null, outputTokens: null, sessionId: null, isError: false, runnerError: 'Claude exited 1: boom' }, { exitCode: 1 }))
      .toMatchObject({ state: 'failed', reason: 'runner-error', summary: 'Claude exited 1: boom' });
    expect(finishFields(undefined, { exitCode: null, signal: 'SIGINT' })).toMatchObject({ state: 'failed', reason: 'interrupted' });
    expect(finishFields(undefined, { lost: true })).toMatchObject({ state: 'failed', reason: 'runner-error', summary: 'the box lost the turn' });
    expect(finishFields({ text: 'rate limited', costUsd: null, inputTokens: null, outputTokens: null, sessionId: null, isError: true, runnerError: null }, { exitCode: 0 }))
      .toMatchObject({ state: 'failed', reason: 'runner-error' });
  });

  it('reads a result with no STATUS line as done', () => {
    expect(finishFields({ text: 'Nothing to do.', costUsd: null, inputTokens: null, outputTokens: null, sessionId: null, isError: false, runnerError: null }, { exitCode: 0 }))
      .toEqual({ state: 'done', reason: null, summary: 'Nothing to do.', prUrl: null });
  });
});
