import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => {
  const p: Record<string, any> = {
    automation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    automationRun: { findUnique: vi.fn(), findFirst: vi.fn() },
    automationNotice: { createMany: vi.fn() },
  };
  // An interactive transaction runs its callback with the client; one that throws commits nothing (the mocks just record).
  p.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(p));
  return p;
});
vi.mock('../../db', () => ({ prisma }));
vi.mock('./notices', () => ({
  enqueueNotices: vi.fn(async () => true), eventData: (n: object) => ({ ...n, channel: 'event' }), startDelivery: vi.fn(),
  ALERT_SETTINGS_SELECT: { alertPrefix: true, alertRegex: true, alertTarget: true, healthAlerts: true, webhookHost: true },
}));
vi.mock('../briefing/slack', async () => ({ ...(await vi.importActual<object>('../briefing/slack')), webBase: () => 'https://termag.example.com' }));

import {
  compileAlertRegex, expandEvent, keywordAlertText, keywordMatch, noteFailedRun, parseAlertSettings, pauseAutomation, pauseAutomations, pauseCause, pauseDmFallback,
} from './alerts';
import { enqueueNotices, startDelivery } from './notices';

const automation = (over: Record<string, unknown> = {}) => ({
  id: 'a1', projectId: 'p1', userId: 'u1', timezone: 'UTC', alertPrefix: null, alertRegex: null, alertTarget: 'dm', healthAlerts: true, webhookHost: null,
  wakeBox: false, boxStartError: null,
  project: { name: 'triage', instanceId: 'box1', user: { id: 'u1', googleEmail: 'me@example.com', displayName: 'Me', unixUsername: 'me', defaultAgentProvider: 'claude' }, instance: { id: 'box1', name: 'box-1', kind: 'box' } },
  ...over,
});
const run = (over: Record<string, unknown> = {}) => ({
  id: 'r1', state: 'blocked', reason: null, summary: 'BLOCKER: the staging DB is down', trigger: 'schedule', scheduledFor: new Date('2026-11-09T09:00:00Z'),
  startedAt: new Date('2026-11-09T09:00:05Z'), finishedAt: new Date('2026-11-09T09:12:00Z'), prUrl: null, workstream: { name: 'run-20261109-0900' }, createdAt: new Date('2026-11-09T09:00:00Z'),
  ...over,
});
const queued = () => vi.mocked(enqueueNotices).mock.calls.flatMap(c => c[0]);
type Row = { kind: string; channel: string; dedupeKey: string; payload: unknown };
const written = (): Row[] => prisma.automationNotice.createMany.mock.calls.flatMap((c: [{ data: Row[] }]) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  prisma.automation.update.mockResolvedValue({});
  prisma.automation.updateMany.mockResolvedValue({ count: 1 });
  prisma.automationNotice.createMany.mockResolvedValue({ count: 0 });
  vi.mocked(enqueueNotices).mockResolvedValue(true);
});

describe('parseAlertSettings', () => {
  it('takes a prefix, a regex, a target and the health switch; empty text is off', () => {
    expect(parseAlertSettings({ alertPrefix: ' BLOCKER: ', alertRegex: '/fail(ed)?/i', alertTarget: 'project', healthAlerts: false }))
      .toEqual({ ok: true, value: { alertPrefix: 'BLOCKER:', alertRegex: '/fail(ed)?/i', alertTarget: 'project', healthAlerts: false } });
    expect(parseAlertSettings({ alertPrefix: '', alertRegex: null })).toEqual({ ok: true, value: { alertPrefix: null, alertRegex: null } });
    expect(parseAlertSettings({})).toEqual({ ok: true, value: {} });
    expect(parseAlertSettings({ alertTarget: 'C0123ABCD45' }).ok).toBe(true);
  });

  it('refuses a regex that does not compile, or that could backtrack for ever, and an unknown target', () => {
    for (const alertRegex of ['(unclosed', '(a+)+', '(x*)*y', '(\\w+){2,}', '(a)\\1', '/x/g']) {
      expect(parseAlertSettings({ alertRegex }).ok, alertRegex).toBe(false);
    }
    for (const alertTarget of ['#general', 'channel', 'U0123ABCD45', 7]) {
      expect(parseAlertSettings({ alertTarget }).ok, String(alertTarget)).toBe(false);
    }
    expect(parseAlertSettings({ healthAlerts: 'yes' }).ok).toBe(false);
    expect(parseAlertSettings({ alertPrefix: 'x'.repeat(201) }).ok).toBe(false);
  });

  it('compiles bare and slashed regexes with their flags', () => {
    const r = compileAlertRegex('/^blocker/i');
    expect(r.ok && r.regex.test('Blocker: x')).toBe(true);
    const bare = compileAlertRegex('^BLOCKER');
    expect(bare.ok && bare.regex.test('blocker')).toBe(false);
  });
});

describe('keywordMatch', () => {
  it('matches the summary\'s start against the prefix, and anywhere against the regex', async () => {
    expect(await keywordMatch('BLOCKER: db down', 'BLOCKER:', null)).toBe('BLOCKER:');
    expect(await keywordMatch('  BLOCKER: db down', 'BLOCKER:', null)).toBe('BLOCKER:');
    expect(await keywordMatch('not a BLOCKER: here', 'BLOCKER:', null)).toBeNull();
    expect(await keywordMatch('tests failed on main', null, 'fail(ed)?')).toBe('/fail(ed)?/');
    expect(await keywordMatch('Tests FAILED', null, '/failed/i')).toBe('/failed/i');
    expect(await keywordMatch('all good', 'BLOCKER:', 'fail')).toBeNull();
    expect(await keywordMatch(null, 'BLOCKER:', 'x')).toBeNull();
  });

  it('a regex that backtracks catastrophically, and slips past the save-time check, is stopped at its time limit as no match', async () => {
    expect(parseAlertSettings({ alertRegex: '(a|aa)+$' }).ok).toBe(true);
    const started = Date.now();
    expect(await keywordMatch(`${'a'.repeat(1990)}!`, null, '(a|aa)+$')).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('pauseCause', () => {
  it('names the cause, with the last failure for a streak', () => {
    expect(pauseCause('consecutive_failures', { failures: 3, lastReason: 'timeout' })).toBe('3 runs failed in a row; the last one stopped at its time limit');
    expect(pauseCause('box_gone', { error: 'box-1 was terminated' })).toBe('its box is gone (box-1 was terminated)');
    expect(pauseCause('t3_task_gone', { error: 'The T3 task is gone' })).toBe('t3 task gone: The T3 task is gone');
  });
});

describe('expandEvent: run.finished', () => {
  const ev = { automationId: 'a1', runId: 'r1', kind: 'run.finished', payload: {} };

  it('builds the keyword alert and the webhook\'s run.done when the summary matches', async () => {
    prisma.automation.findUnique.mockResolvedValue(automation({ alertPrefix: 'BLOCKER:', alertTarget: 'C0123ABCD45', webhookHost: 'hooks.example.com' }));
    prisma.automationRun.findUnique.mockResolvedValue(run());
    const [keyword, hook] = await expandEvent(ev);
    expect(keyword).toMatchObject({ channel: 'slack', kind: 'keyword', dedupeKey: 'r1:keyword', payload: { target: 'C0123ABCD45' } });
    expect((keyword.payload as { text: string }).text).toContain('matched `BLOCKER:`');
    expect((keyword.payload as { text: string }).text).toContain('Run `r1`');
    expect((keyword.payload as { text: string }).text).toContain('https://termag.example.com/automations/p1');
    expect(hook).toMatchObject({
      channel: 'webhook', kind: 'run.done', dedupeKey: 'r1:webhook:run.done',
      payload: { event: 'run.done', automation: { id: 'a1', projectId: 'p1', name: 'triage' }, run: { id: 'r1', state: 'blocked', summary: 'BLOCKER: the staging DB is down', finishedAt: '2026-11-09T09:12:00.000Z' } },
    });
  });

  it('a failed run is run.failed, and no keyword alert without a match', async () => {
    prisma.automation.findUnique.mockResolvedValue(automation({ alertPrefix: 'BLOCKER:', webhookHost: 'hooks.example.com' }));
    prisma.automationRun.findUnique.mockResolvedValue(run({ state: 'failed', reason: 'timeout', summary: 'stopped after 60 minutes' }));
    expect((await expandEvent(ev)).map(n => n.kind)).toEqual(['run.failed']);
  });

  it('nothing with nothing configured, so a run that finished before an alert existed was told nothing then', async () => {
    prisma.automation.findUnique.mockResolvedValue(automation());
    prisma.automationRun.findUnique.mockResolvedValue(run());
    expect(await expandEvent(ev)).toEqual([]);
  });

  it('throws when it cannot tell, so delivery tries the event again', async () => {
    prisma.automation.findUnique.mockRejectedValue(new Error('db down'));
    await expect(expandEvent(ev)).rejects.toThrow('db down');
  });
});

describe('pauseAutomations', () => {
  it('writes the pause and a plain automation.paused event in one transaction, doing no lookup there', async () => {
    prisma.automation.findUnique.mockResolvedValue({ updatedAt: new Date('2026-11-09T08:00:00Z') });
    await pauseAutomation('a1', 'consecutive_failures', { runId: 'r1', failures: 3, lastReason: 'timeout', also: { consecutiveFailures: 3 } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.automation.updateMany).toHaveBeenCalledWith({ where: { id: 'a1', pausedReason: null }, data: { consecutiveFailures: 3, pausedReason: 'consecutive_failures' } });
    expect(written()).toEqual([expect.objectContaining({
      channel: 'event', kind: 'automation.paused', dedupeKey: 'event:paused:a1:2026-11-09T08:00:00.000Z',
      payload: expect.objectContaining({ reason: 'consecutive_failures', cause: { runId: 'r1', failures: 3, lastReason: 'timeout' }, episode: '2026-11-09T08:00:00.000Z', pausedAt: expect.any(String) }),
    })]);
    expect(prisma.automationRun.findUnique).not.toHaveBeenCalled();
    expect(startDelivery).toHaveBeenCalledWith(['event:paused:a1:2026-11-09T08:00:00.000Z']);
  });

  it('the event carries the pause time and a copy of the alert settings as they were', async () => {
    prisma.automation.findUnique.mockResolvedValue({ updatedAt: new Date('2026-11-09T08:00:00Z'), alertPrefix: null, alertRegex: null, alertTarget: 'project', healthAlerts: true, webhookHost: 'hooks.example.com' });
    await pauseAutomation('a1', 'box_gone');
    expect(written()[0].payload).toMatchObject({ pausedAt: expect.any(String), settings: { alertTarget: 'project', healthAlerts: true, webhookHost: 'hooks.example.com' } });
  });

  it('a failed event insert never undoes the pause: it is written on its own', async () => {
    prisma.automation.findUnique.mockResolvedValue({ updatedAt: new Date('2026-11-09T08:00:00Z') });
    prisma.automationNotice.createMany.mockRejectedValueOnce(new Error('db down'));
    await expect(pauseAutomation('a1', 'box_gone')).resolves.toBeUndefined();
    expect(prisma.automation.updateMany).toHaveBeenLastCalledWith({ where: { id: { in: ['a1'] }, pausedReason: null }, data: { pausedReason: 'box_gone' } });
  });

  it('one already paused is no transition: no event, and only the failure count is written', async () => {
    prisma.automation.findUnique.mockResolvedValue({ updatedAt: new Date('2026-11-09T08:00:00Z') });
    prisma.automation.updateMany.mockResolvedValue({ count: 0 });
    expect(await pauseAutomations(['a1'], 'consecutive_failures', { runId: 'r1', failures: 4, also: { consecutiveFailures: 4 } })).toEqual([]);
    expect(prisma.automation.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { consecutiveFailures: 4 } });
    expect(written()).toEqual([]);
  });

  it('pauseDmFallback queues a DM-only pause event, built as the pause\'s is (time and settings copy included)', async () => {
    prisma.automation.findUnique.mockResolvedValue({ updatedAt: new Date('2026-11-09T08:05:00Z'), alertPrefix: null, alertRegex: null, alertTarget: 'dm', healthAlerts: true, webhookHost: null });
    await pauseDmFallback(['a1'], 'box_gone', { error: 'box-1 was terminated', ownerTold: true });
    expect(queued()).toEqual([expect.objectContaining({
      channel: 'event', kind: 'automation.paused', dedupeKey: 'event:paused:a1:2026-11-09T08:05:00.000Z:dm',
      payload: expect.objectContaining({ dmOnly: true, pausedAt: expect.any(String), settings: { alertPrefix: null, alertRegex: null, alertTarget: 'dm', healthAlerts: true, webhookHost: null } }),
    })]);
  });
});

describe('expandEvent: automation.paused', () => {
  const ev = (payload: Record<string, unknown>) => ({ automationId: 'a1', runId: 'r1', kind: 'automation.paused', payload: { reason: 'consecutive_failures', cause: { runId: 'r1', failures: 3, lastReason: 'timeout' }, episode: '2026-11-09T08:00:00.000Z', ...payload } });

  it('the health alert and the webhook, keyed by the episode, the cause in words', async () => {
    prisma.automation.findUnique.mockResolvedValue(automation({ webhookHost: 'hooks.example.com' }));
    prisma.automationRun.findUnique.mockResolvedValue(run({ state: 'failed', reason: 'timeout' }));
    const [health, hook] = await expandEvent(ev({}));
    expect(health).toMatchObject({ channel: 'slack', kind: 'health', dedupeKey: 'a1:paused:2026-11-09T08:00:00.000Z', payload: { target: 'dm' } });
    expect((health.payload as { text: string }).text).toContain('is paused: 3 runs failed in a row; the last one stopped at its time limit');
    expect((health.payload as { text: string }).text).toContain('termag automation resume a1');
    expect(hook).toMatchObject({ kind: 'automation.paused', dedupeKey: 'a1:paused:2026-11-09T08:00:00.000Z:webhook', payload: { event: 'automation.paused', pause: { reason: 'consecutive_failures' }, run: { id: 'r1' } } });
  });

  it('expands against the settings the event was written with, and dates the webhook by the pause', async () => {
    // Since the pause, the owner turned health alerts off and removed the webhook; the event still says what was due then.
    prisma.automation.findUnique.mockResolvedValue(automation({ healthAlerts: false, webhookHost: null }));
    const sends = await expandEvent(ev({ pausedAt: '2026-11-09T08:01:00.000Z', settings: { alertPrefix: null, alertRegex: null, alertTarget: 'dm', healthAlerts: true, webhookHost: 'hooks.example.com' } }));
    expect(sends.map(n => n.kind)).toEqual(['health', 'automation.paused']);
    expect((sends[1].payload as { at: string }).at).toBe('2026-11-09T08:01:00.000Z');
  });

  it('skips the DM the owner already had, but not a channel target; a DM-only event is only that', async () => {
    prisma.automation.findUnique.mockResolvedValue(automation({ webhookHost: 'hooks.example.com' }));
    expect((await expandEvent(ev({ cause: { ownerTold: true } }))).map(n => n.kind)).toEqual(['automation.paused']);
    prisma.automation.findUnique.mockResolvedValue(automation({ alertTarget: 'project' }));
    expect((await expandEvent(ev({ cause: { ownerTold: true } }))).map(n => n.kind)).toEqual(['health']);
    prisma.automation.findUnique.mockResolvedValue(automation({ webhookHost: 'hooks.example.com' }));
    expect((await expandEvent(ev({ dmOnly: true }))).map(n => n.dedupeKey)).toEqual(['a1:paused:2026-11-09T08:00:00.000Z:dm']);
  });
});

describe('noteFailedRun', () => {
  it('counts a failure, and pauses through pauseAutomations at the limit', async () => {
    prisma.automation.findUnique.mockResolvedValue({ updatedAt: new Date('2026-11-09T08:00:00Z') });
    await noteFailedRun('a1', 0, 3, { id: 'r1', reason: 'runner-error' });
    expect(prisma.automation.update).toHaveBeenLastCalledWith({ where: { id: 'a1' }, data: { consecutiveFailures: 1 } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    await noteFailedRun('a1', 2, 3, { id: 'r1', reason: 'runner-error' });
    expect(prisma.automation.updateMany).toHaveBeenLastCalledWith({ where: { id: 'a1', pausedReason: null }, data: { consecutiveFailures: 3, pausedReason: 'consecutive_failures' } });
    expect(written().map(n => n.kind)).toEqual(['automation.paused']);
  });
});

describe('expandEvent: run.box_unavailable', () => {
  const ev = (runId: string) => ({ automationId: 'a1', runId, kind: 'run.box_unavailable', payload: {} });
  it('nothing for a run that is not a box_unavailable skip', async () => {
    prisma.automation.findUnique.mockResolvedValue(automation());
    prisma.automationRun.findUnique.mockResolvedValue(run({ state: 'running' }));
    expect(await expandEvent(ev('r1'))).toEqual([]);
  });

  it('tells the first skip of a streak only', async () => {
    prisma.automation.findUnique.mockResolvedValue(automation());
    prisma.automationRun.findUnique.mockResolvedValue(run({ state: 'skipped', reason: 'box_unavailable' }));
    prisma.automationRun.findFirst.mockResolvedValueOnce({ state: 'done', reason: null });
    const sends = await expandEvent(ev('r1'));
    expect(sends).toEqual([expect.objectContaining({ kind: 'health', dedupeKey: 'r1:box_unavailable' })]);
    expect((sends[0].payload as { text: string }).text).toContain('its box *box-1* was asleep');
    prisma.automationRun.findFirst.mockResolvedValueOnce({ state: 'skipped', reason: 'box_unavailable' });
    expect(await expandEvent(ev('r2'))).toEqual([]);
  });
});

describe('keywordAlertText', () => {
  it('withholds a summary that looks like it holds a secret', () => {
    const text = keywordAlertText({
      name: 'triage', occurrence: 'Mon 9 Nov 2026 09:00 UTC', matched: 'BLOCKER:',
      run: { id: 'r1', state: 'blocked', reason: null, summary: 'BLOCKER: token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, links: { run: null, automation: null },
    });
    expect(text).toContain('summary withheld');
    expect(text).not.toContain('ghp_');
  });
});
