import { describe, expect, it } from 'vitest';
import {
  CANNOT_HIBERNATE_WARNING,
  canAutoHibernate,
  IDLE_STOP_DEFAULT_HOURS,
  idleStopAtFor,
  idleStopHours,
  warnLeadMs,
  effectiveTerminateDays,
  isCleanScan,
  askBoxLifecycle,
  type TerminateBox,
  terminateDecision,
  unsavedWorkState,
  unsavedWorkTerminateDays,
  holdingCheck,
  idleHibernateDecision,
  idleSince,
  type LifecycleBox,
  SOFT_BUSY_CAP_MS,
  START_GRACE_MS,
  lifecycleSettingsError,
  lifecycleView,
  lifecycleWarning,
  parseLifecycleSettings,
  isAutoHibernateNote,
  stuckStartDecision,
  stuckStartNote,
  stuckStopRetryDecision,
  autoTerminateNote,
  terminateDueAt,
} from './boxLifecyclePolicy';

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const t0 = new Date('2026-10-09T12:00:00Z');

function box(over: Partial<LifecycleBox> = {}): LifecycleBox {
  return {
    userId: 'u1', kind: 'ec2', status: 'ready', ec2InstanceId: 'i-1',
    hibernationConfigured: true, rehibernatePending: false,
    idleHibernateHours: 1, lastActivityAt: t0, readyAt: new Date(t0.getTime() - 24 * HOUR),
    createdAt: new Date(t0.getTime() - 48 * HOUR),
    ...over,
  };
}
const facts = (over: Partial<Parameters<typeof idleHibernateDecision>[1]> = {}) => ({
  nowMs: t0.getTime() + 2 * HOUR, flagOn: true, busy: [] as readonly string[], working: false, ...over,
});

describe('idleHibernateDecision', () => {
  it('stops a box idle past its own window, unannounced', () => {
    expect(idleHibernateDecision(box(), facts())).toEqual({ stop: true });
    expect(idleHibernateDecision(box({ hibernationConfigured: false }), facts())).toEqual({ stop: true });
  });

  it('waits until the window is up', () => {
    expect(idleHibernateDecision(box(), facts({ nowMs: t0.getTime() + HOUR - 1 })))
      .toEqual({ hibernate: false, reason: 'not-idle' });
    expect(idleHibernateDecision(box(), facts({ nowMs: t0.getTime() + HOUR }))).toEqual({ stop: true });
  });

  it('never touches an external box or an ownerless one', () => {
    for (const over of [{ kind: 'external' }, { userId: null }, { ec2InstanceId: null }]) {
      expect(idleHibernateDecision(box(over), facts())).toEqual({ hibernate: false, reason: 'not-eligible' });
    }
  });

  it('skips a box with the setting off, a box not ready and a refresh in progress', () => {
    expect(idleHibernateDecision(box({ idleHibernateHours: null }), facts())).toMatchObject({ reason: 'off' });
    expect(idleHibernateDecision(box({ status: 'hibernated' }), facts())).toMatchObject({ reason: 'not-ready' });
    expect(idleHibernateDecision(box({ rehibernatePending: true }), facts())).toMatchObject({ reason: 'refresh-pending' });
  });

  it('respects the flag, a busy box and a working agent, in that order', () => {
    expect(idleHibernateDecision(box(), facts({ flagOn: false, busy: ['claude-runner'] }))).toMatchObject({ reason: 'flag-off' });
    expect(idleHibernateDecision(box(), facts({ busy: ['claude-runner'], working: true }))).toEqual({ hibernate: false, reason: 'busy', check: 'claude-runner' });
    expect(idleHibernateDecision(box(), facts({ working: true }))).toMatchObject({ reason: 'working' });
  });

  it('leaves a box alone for 15 minutes after a start request, whoever made it', () => {
    const now = t0.getTime() + 2 * HOUR;
    expect(idleHibernateDecision(box({ lastReadyAt: new Date(now - START_GRACE_MS + 1) }), facts({ nowMs: now })))
      .toEqual({ hibernate: false, reason: 'just-started' });
    expect(idleHibernateDecision(box({ lastReadyAt: new Date(now - START_GRACE_MS) }), facts({ nowMs: now })))
      .toEqual({ stop: true });
  });

  it('lets load hold a box only while it has seen activity in the last 7 days', () => {
    const recent = box();
    const stale = box({ lastActivityAt: new Date(t0.getTime() - SOFT_BUSY_CAP_MS - HOUR) });
    expect(idleHibernateDecision(recent, facts({ busy: ['host-load'] }))).toEqual({ hibernate: false, reason: 'busy', check: 'host-load' });
    expect(idleHibernateDecision(stale, facts({ busy: ['host-load', 'ssh'] }))).toEqual({ stop: true });
    expect(idleHibernateDecision(recent, facts({ busy: ['ssh'] }))).toEqual({ hibernate: false, reason: 'busy', check: 'ssh' });
    expect(idleHibernateDecision(stale, facts({ busy: ['host-load', 'ask-run'] }))).toEqual({ hibernate: false, reason: 'busy', check: 'ask-run' });
    // A soft check that failed holds like any failed check.
    expect(idleHibernateDecision(stale, facts({ busy: ['host-load-failed'] }))).toMatchObject({ reason: 'busy', check: 'host-load-failed' });
  });

  it('holdingCheck prefers the first check that holds', () => {
    expect(holdingCheck([], 0)).toBe(null);
    expect(holdingCheck(['host-load', 'claude-runner'], SOFT_BUSY_CAP_MS + 1)).toBe('claude-runner');
    expect(holdingCheck(['host-load', 'claude-runner'], SOFT_BUSY_CAP_MS)).toBe('host-load');
  });

  it('starts the clock of a claimed warm-pool box at the claim', () => {
    const claimedAt = new Date(t0.getTime() + HOUR);
    expect(idleSince(box({ lastActivityAt: null, readyAt: null, claimedAt }))).toEqual(claimedAt);
    expect(idleSince(box({ claimedAt }))).toEqual(claimedAt);
    expect(idleSince(box({ claimedAt: new Date(t0.getTime() - HOUR) }))).toEqual(t0);
  });

  it('counts from first ready when the box has never seen activity', () => {
    const b = box({ lastActivityAt: null, readyAt: t0 });
    expect(idleHibernateDecision(b, facts({ nowMs: t0.getTime() + HOUR - 1 }))).toEqual({ hibernate: false, reason: 'not-idle' });
    expect(idleHibernateDecision(b, facts({ nowMs: t0.getTime() + HOUR }))).toEqual({ stop: true });
    const created = box({ lastActivityAt: null, readyAt: null, createdAt: t0 });
    expect(idleHibernateDecision(created, facts({ nowMs: t0.getTime() + HOUR }))).toEqual({ stop: true });
  });
});

describe('idleHibernateDecision with box-idle-stop-enabled', () => {
  const unset = (over: Partial<LifecycleBox> = {}) => box({ idleHibernateHours: null, ...over });
  const at = (ms: number) => facts({ nowMs: t0.getTime() + ms, flagOn: false, idleStopOn: true });

  it('with it off, no setting stays off and a box that cannot hibernate is never acted on', () => {
    expect(idleHibernateDecision(unset(), facts({ nowMs: t0.getTime() + 100 * HOUR })))
      .toEqual({ hibernate: false, reason: 'off' });
    expect(idleHibernateDecision(unset({ hibernationConfigured: false }), facts({ nowMs: t0.getTime() + 100 * HOUR })))
      .toEqual({ hibernate: false, reason: 'not-eligible' });
    expect(idleHibernateDecision(unset({ hibernationConfigured: false }), facts({ nowMs: t0.getTime() + 100 * HOUR, idleStopOn: false })))
      .toEqual({ hibernate: false, reason: 'not-eligible' });
  });

  it('with it on and no setting, waits 2 h, warns, then stops a box that can hibernate and one that cannot', () => {
    const due = new Date(t0.getTime() + 2 * HOUR);
    expect(idleHibernateDecision(unset(), at(2 * HOUR - 1))).toEqual({ hibernate: false, reason: 'not-idle' });
    expect(idleHibernateDecision(unset(), at(2 * HOUR))).toEqual({ warn: true, stopAt: due });
    const warned = { idleWarnedAt: due, idleParkAt: due };
    expect(idleHibernateDecision(unset(warned), at(2 * HOUR))).toEqual({ stop: true });
    expect(idleHibernateDecision(unset({ ...warned, hibernationConfigured: false }), at(2 * HOUR))).toEqual({ stop: true });
  });

  it('warns the lead before the due time and stops at the due time', () => {
    const due = t0.getTime() + 2 * HOUR;
    const f = (ms: number) => ({ ...at(ms), leadMs: HOUR });
    expect(idleHibernateDecision(unset(), f(HOUR - 1))).toEqual({ hibernate: false, reason: 'not-idle' });
    expect(idleHibernateDecision(unset(), f(HOUR))).toEqual({ warn: true, stopAt: new Date(due) });
    const warned = unset({ idleWarnedAt: new Date(t0.getTime() + HOUR), idleParkAt: new Date(due) });
    expect(idleHibernateDecision(warned, f(2 * HOUR - 1))).toEqual({ hibernate: false, reason: 'warned' });
    expect(idleHibernateDecision(warned, f(2 * HOUR))).toEqual({ stop: true });
  });

  it('promises a full lead from the warning when the box is first seen past its due time', () => {
    expect(idleHibernateDecision(unset(), { ...at(10 * HOUR), leadMs: HOUR }))
      .toEqual({ warn: true, stopAt: new Date(t0.getTime() + 11 * HOUR) });
  });

  it('takes the window from idleStopHours', () => {
    expect(idleHibernateDecision(unset(), { ...at(8 * HOUR - 1), idleStopHours: 8 })).toEqual({ hibernate: false, reason: 'not-idle' });
    expect(idleHibernateDecision(unset(), { ...at(8 * HOUR), idleStopHours: 8 })).toMatchObject({ warn: true });
  });

  it('warns again when the warning went stale: activity since, a longer window, or its time long past', () => {
    const promise = { idleWarnedAt: new Date(t0.getTime() + HOUR), idleParkAt: new Date(t0.getTime() + 2 * HOUR) };
    const f = (ms: number, over = {}) => ({ ...at(ms), leadMs: HOUR, ...over });
    // Activity after the warning starts a new stretch.
    const touched = unset({ ...promise, lastActivityAt: new Date(t0.getTime() + 90 * MIN) });
    expect(idleHibernateDecision(touched, f(2 * HOUR))).toEqual({ hibernate: false, reason: 'not-idle' });
    expect(idleHibernateDecision(touched, f(150 * MIN))).toEqual({ warn: true, stopAt: new Date(t0.getTime() + 210 * MIN) });
    // A longer window moves the due time past the promise.
    expect(idleHibernateDecision(unset(promise), f(4 * HOUR, { idleStopHours: 4 })))
      .toEqual({ warn: true, stopAt: new Date(t0.getTime() + 5 * HOUR) });
    // Held busy (or no sweep) for more than an hour past the promise.
    expect(idleHibernateDecision(unset(promise), f(3 * HOUR + 1))).toEqual({ warn: true, stopAt: new Date(t0.getTime() + 4 * HOUR + 1) });
    expect(idleHibernateDecision(unset(promise), f(3 * HOUR))).toEqual({ stop: true });
  });

  it('keeps the promised time when the window is shortened after the warning', () => {
    const promise = { idleWarnedAt: new Date(t0.getTime() + 2 * HOUR), idleParkAt: new Date(t0.getTime() + 4 * HOUR) };
    expect(idleHibernateDecision(unset(promise), at(3 * HOUR))).toEqual({ hibernate: false, reason: 'warned' });
    expect(idleHibernateDecision(unset(promise), at(4 * HOUR))).toEqual({ stop: true });
  });

  it('stops again with no warning a box woken without its owner and untouched since its auto-stop', () => {
    const autoParkedAt = new Date(t0.getTime() + 30 * MIN);
    expect(idleHibernateDecision(unset({ autoParkedAt }), at(40 * MIN))).toEqual({ stop: true, quiet: true });
    expect(idleHibernateDecision(unset({ autoParkedAt, lastActivityAt: null }), at(40 * MIN))).toEqual({ stop: true, quiet: true });
    // Touched since: the window and the warning apply again.
    expect(idleHibernateDecision(unset({ autoParkedAt, lastActivityAt: new Date(t0.getTime() + 35 * MIN) }), at(40 * MIN)))
      .toEqual({ hibernate: false, reason: 'not-idle' });
    // Its start grace and a busy check still come first.
    expect(idleHibernateDecision(unset({ autoParkedAt, lastReadyAt: new Date(t0.getTime() + 35 * MIN) }), at(40 * MIN)))
      .toEqual({ hibernate: false, reason: 'just-started' });
    expect(idleHibernateDecision(unset({ autoParkedAt }), { ...at(40 * MIN), busy: ['automation-run'] }))
      .toEqual({ hibernate: false, reason: 'busy', check: 'automation-run' });
  });

  it('with it on, a box with its own setting keeps that timing and box-auto-lifecycle-enabled', () => {
    const own = box({ idleHibernateHours: 4 });
    expect(idleHibernateDecision(own, at(2 * HOUR))).toEqual({ hibernate: false, reason: 'flag-off' });
    expect(idleHibernateDecision(own, { ...at(2 * HOUR), flagOn: true })).toEqual({ hibernate: false, reason: 'not-idle' });
    expect(idleHibernateDecision(own, { ...at(4 * HOUR), flagOn: true })).toEqual({ stop: true });
    expect(idleHibernateDecision(box({ idleHibernateHours: 4, hibernationConfigured: false }), { ...at(10 * HOUR), flagOn: true }))
      .toEqual({ stop: true });
  });

  it('keeps the guards: external or ownerless, not ready, refresh, busy, working', () => {
    for (const over of [{ kind: 'external' }, { userId: null }, { ec2InstanceId: null }]) {
      expect(idleHibernateDecision(unset(over), at(10 * HOUR))).toEqual({ hibernate: false, reason: 'not-eligible' });
    }
    expect(idleHibernateDecision(unset({ status: 'stopped' }), at(10 * HOUR))).toMatchObject({ reason: 'not-ready' });
    expect(idleHibernateDecision(unset({ rehibernatePending: true }), at(10 * HOUR))).toMatchObject({ reason: 'refresh-pending' });
    expect(idleHibernateDecision(unset(), { ...at(10 * HOUR), busy: ['claude-runner'] })).toMatchObject({ reason: 'busy', check: 'claude-runner' });
    expect(idleHibernateDecision(unset({ hibernationConfigured: false }), { ...at(10 * HOUR), working: true }))
      .toMatchObject({ reason: 'working' });
  });

  it('counts from lastActivityAt, so a box started a minute ago is not due', () => {
    const justStarted = unset({ hibernationConfigured: false, lastActivityAt: new Date(t0.getTime() + 10 * HOUR - 60_000) });
    expect(idleHibernateDecision(justStarted, at(10 * HOUR))).toEqual({ hibernate: false, reason: 'not-idle' });
  });

  it('gives a box that just came up its start grace, whoever started it', () => {
    const now = t0.getTime() + 10 * HOUR;
    expect(idleHibernateDecision(unset({ lastReadyAt: new Date(now - START_GRACE_MS + 1) }), at(10 * HOUR)))
      .toEqual({ hibernate: false, reason: 'just-started' });
    expect(idleHibernateDecision(unset({ lastReadyAt: new Date(now - START_GRACE_MS) }), at(10 * HOUR))).toMatchObject({ warn: true });
  });

  it('lets a soft busy check hold only within its cap', () => {
    expect(idleHibernateDecision(unset(), { ...at(10 * HOUR), busy: ['host-load'] }))
      .toEqual({ hibernate: false, reason: 'busy', check: 'host-load' });
    expect(idleHibernateDecision(unset(), { ...at(SOFT_BUSY_CAP_MS + 1), busy: ['host-load'] })).toMatchObject({ warn: true });
  });
});

describe('the default window: its hours, its lead and its stop time', () => {
  it('takes only whole hours from 1 to 720 from box-idle-park-hours, else 2', () => {
    expect(idleStopHours(8)).toBe(8);
    expect(idleStopHours(720)).toBe(720);
    for (const raw of [0, -1, 1.5, 721, '8', null, undefined, NaN]) expect(idleStopHours(raw)).toBe(IDLE_STOP_DEFAULT_HOURS);
  });

  it('warns two hours ahead by default, never more than half the window', () => {
    expect(warnLeadMs(undefined, 72)).toBe(2 * HOUR);
    expect(warnLeadMs(undefined, 2)).toBe(HOUR);
    expect(warnLeadMs(30, 2)).toBe(30 * MIN);
    expect(warnLeadMs(0, 2)).toBe(0);
    for (const raw of [-5, 2.5, 7 * 24 * 60 + 1, '120']) expect(warnLeadMs(raw, 72)).toBe(2 * HOUR);
  });

  it('says when the window will stop the box: a standing warning, else the due time or a lead from now', () => {
    const unset = (over: Partial<LifecycleBox> = {}) => box({ idleHibernateHours: null, ...over });
    expect(idleStopAtFor(unset(), 2, HOUR, t0.getTime())).toEqual(new Date(t0.getTime() + 2 * HOUR));
    expect(idleStopAtFor(unset(), 2, HOUR, t0.getTime() + 3 * HOUR)).toEqual(new Date(t0.getTime() + 4 * HOUR));
    const warned = unset({ idleWarnedAt: new Date(t0.getTime() + HOUR), idleParkAt: new Date(t0.getTime() + 150 * MIN) });
    expect(idleStopAtFor(warned, 2, HOUR, t0.getTime() + HOUR)).toEqual(new Date(t0.getTime() + 150 * MIN));
    expect(idleStopAtFor(unset({ status: 'stopped' }), 2, HOUR, t0.getTime())).toBeNull();
    expect(idleStopAtFor(unset({ kind: 'external' }), 2, HOUR, t0.getTime())).toBeNull();
    // Woken without its owner and untouched: the quiet re-park, once the start grace is over.
    const woken = unset({ autoParkedAt: new Date(t0.getTime() + 10 * MIN), lastReadyAt: new Date(t0.getTime() + 20 * MIN) });
    expect(idleStopAtFor(woken, 2, HOUR, t0.getTime() + 25 * MIN)).toEqual(new Date(t0.getTime() + 35 * MIN));
    expect(idleStopAtFor(woken, 2, HOUR, t0.getTime() + 40 * MIN)).toEqual(new Date(t0.getTime() + 40 * MIN));
  });

  it('a box in its start grace is warned once the grace is over, so it stops a lead after that', () => {
    const unset = (over: Partial<LifecycleBox> = {}) => box({ idleHibernateHours: null, ...over });
    const started = unset({ lastReadyAt: new Date(t0.getTime() + 3 * HOUR) });
    expect(idleStopAtFor(started, 2, HOUR, t0.getTime() + 3 * HOUR + 5 * MIN)).toEqual(new Date(t0.getTime() + 3 * HOUR + 75 * MIN));
    expect(idleStopAtFor(started, 2, 0, t0.getTime() + 3 * HOUR + 5 * MIN)).toEqual(new Date(t0.getTime() + 3 * HOUR + 15 * MIN));
    // A grace long over doesn't move it.
    expect(idleStopAtFor(unset({ lastReadyAt: t0 }), 2, HOUR, t0.getTime())).toEqual(new Date(t0.getTime() + 2 * HOUR));
    expect(idleStopAtFor(unset({ rehibernatePending: true }), 2, HOUR, t0.getTime())).toBeNull();
  });
});

describe('parseLifecycleSettings', () => {
  it('accepts whole hours in range and null', () => {
    expect(parseLifecycleSettings({ idleHibernateHours: 1 })).toEqual({ settings: { idleHibernateHours: 1 } });
    expect(parseLifecycleSettings({ idleHibernateHours: 720 })).toEqual({ settings: { idleHibernateHours: 720 } });
    expect(parseLifecycleSettings({ idleHibernateHours: null })).toEqual({ settings: { idleHibernateHours: null } });
    expect(parseLifecycleSettings({})).toEqual({ settings: {} });
    expect(parseLifecycleSettings({ idleHibernateHours: 1, hibernatedTerminateDays: 14 }))
      .toEqual({ settings: { idleHibernateHours: 1, hibernatedTerminateDays: 14 } });
    expect(parseLifecycleSettings({ hibernatedTerminateDays: null })).toEqual({ settings: { hibernatedTerminateDays: null } });
  });

  it('refuses fractions, out-of-range values, strings, unknown keys and non-objects', () => {
    for (const body of [{ idleHibernateHours: 0 }, { idleHibernateHours: 1.5 }, { idleHibernateHours: 721 },
      { idleHibernateHours: '1' }, { idleHibernateHour: 1 }, { hibernatedTerminateDays: 0 },
      { hibernatedTerminateDays: 366 }, { hibernatedTerminateDays: 2.5 }, null, [], 'x']) {
      expect(parseLifecycleSettings(body)).toHaveProperty('error');
    }
  });
});

describe('lifecycleSettingsError', () => {
  it('accepts turning it on for a box that cannot hibernate, and refuses only a terminated box', () => {
    const legacy = box({ hibernationConfigured: false });
    expect(lifecycleSettingsError(legacy, { idleHibernateHours: 1 })).toBeNull();
    expect(lifecycleSettingsError(legacy, { idleHibernateHours: null })).toBeNull();
    expect(lifecycleSettingsError(box(), { idleHibernateHours: 4 })).toBeNull();
    expect(lifecycleSettingsError(box({ status: 'terminated' }), { idleHibernateHours: null })).toMatch(/terminated/);
  });
});

describe('lifecycleWarning', () => {
  it('warns only when a setting is on for a box that cannot be stopped', () => {
    const w = (over: Partial<LifecycleBox>, hibernatedTerminateDays: number | null = null) =>
      lifecycleWarning({ ...box(over), hibernatedTerminateDays });
    // Parking by a stop needs no hibernation.
    expect(w({ hibernationConfigured: false })).toBeNull();
    expect(w({ hibernationConfigured: false, idleHibernateHours: null }, 14)).toBeNull();
    expect(w({ kind: 'external', ec2InstanceId: null })).toBe(CANNOT_HIBERNATE_WARNING);
    expect(w({ kind: 'external', ec2InstanceId: null, idleHibernateHours: null }, 14)).toBe(CANNOT_HIBERNATE_WARNING);
    expect(w({ kind: 'external', ec2InstanceId: null, idleHibernateHours: null })).toBeNull();
    expect(w({}, 14)).toBeNull();
  });
});

const DAY = 24 * HOUR;
const CLEAN = { scanned: 2, repos: [], errors: [], keptCheckouts: 0 };
function parked(over: Partial<TerminateBox> = {}): TerminateBox {
  return {
    ...box({ status: 'hibernated', lastActivityAt: new Date(t0.getTime() - 2 * HOUR) }),
    parkedAt: t0, hibernatedTerminateDays: 1,
    unsavedWork: CLEAN, unsavedWorkCheckedAt: new Date(t0.getTime() - HOUR),
    ...over,
  };
}
const view = (b: TerminateBox, note: string | null = null) => lifecycleView({ ...b, lifecycleNote: note }, 90);

describe('lifecycleView', () => {
  it('promises a stop for a ready box with the setting on, never a hibernate', () => {
    const v = view({ ...box(), parkedAt: null, hibernatedTerminateDays: null, unsavedWork: null, unsavedWorkCheckedAt: null });
    expect(v).toEqual({
      canAutoHibernate: true, idleHibernateHours: 1, hibernatedTerminateDays: null,
      hibernateDueAt: null, terminateDueAt: null,
      parkedAt: null, unsavedWork: null, note: null, warning: null,
      // box-auto-lifecycle-enabled not given: the own hours don't run, so no park is promised.
      parkAt: null, parkAction: null, idleLimitHours: null, idleLimitSource: null,
      warnedAt: null, autoParkedAt: null, parkStop: true,
    });
    const ready = { ...box(), parkedAt: null, hibernatedTerminateDays: null, unsavedWork: null, unsavedWorkCheckedAt: null, lifecycleNote: null };
    expect(lifecycleView(ready, 90, { autoLifecycleOn: true }, t0.getTime())).toMatchObject({
      parkAt: new Date(t0.getTime() + HOUR).toISOString(), parkAction: 'stop', idleLimitHours: 1, idleLimitSource: 'own',
    });
    expect(view(parked({ hibernationConfigured: false, idleHibernateHours: null })))
      .toMatchObject({ canAutoHibernate: false, hibernateDueAt: null, terminateDueAt: null, warning: null });
    expect(view(parked(), 'n')).toMatchObject({
      hibernateDueAt: null, parkedAt: t0.toISOString(), note: 'n',
      unsavedWork: 'clean', terminateDueAt: new Date(t0.getTime() + DAY).toISOString(),
    });
    expect(canAutoHibernate(box({ hibernationConfigured: false }))).toBe(false);
  });
});

describe('lifecycleView under the default window', () => {
  const ready = (over: Partial<TerminateBox> = {}) =>
    ({ ...box({ idleHibernateHours: null }), parkedAt: null, hibernatedTerminateDays: null, unsavedWork: null, unsavedWorkCheckedAt: null, lifecycleNote: null, ...over });
  const on = { idleStopOn: true, idleStopHours: 2, warnMinutes: 60 };

  it("shows the stop, the window's hours and a standing warning, only while box-idle-stop-enabled is on", () => {
    expect(lifecycleView(ready(), 90, on, t0.getTime())).toMatchObject({
      parkAt: new Date(t0.getTime() + 2 * HOUR).toISOString(), parkAction: 'stop', idleLimitHours: 2, idleLimitSource: 'default',
      hibernateDueAt: null, warnedAt: null,
    });
    const warned = ready({ idleWarnedAt: new Date(t0.getTime() + HOUR), idleParkAt: new Date(t0.getTime() + 2 * HOUR) });
    expect(lifecycleView(warned, 90, on, t0.getTime() + HOUR)).toMatchObject({ warnedAt: new Date(t0.getTime() + HOUR).toISOString() });
    // A keystroke since makes the warning stale.
    expect(lifecycleView({ ...warned, lastActivityAt: new Date(t0.getTime() + 90 * MIN) }, 90, on, t0.getTime() + 90 * MIN))
      .toMatchObject({ warnedAt: null, parkAt: new Date(t0.getTime() + 210 * MIN).toISOString() });
    expect(lifecycleView(ready(), 90, { idleStopOn: false }, t0.getTime()))
      .toMatchObject({ parkAt: null, parkAction: null, idleLimitHours: null, idleLimitSource: null });
    expect(lifecycleView(ready({ autoParkedAt: t0 }), 90, undefined, t0.getTime())).toMatchObject({ autoParkedAt: t0.toISOString() });
  });

  it('warns of nothing on a box that cannot hibernate', () => {
    expect(lifecycleView(ready({ hibernationConfigured: false, hibernatedTerminateDays: 14 }), 90, { ...on, idleStopHours: 6 }, t0.getTime()).warning)
      .toBeNull();
  });
});

describe('unsavedWorkState', () => {
  it('is clean only for a clean scan newer than the last activity', () => {
    expect(unsavedWorkState(parked())).toBe('clean');
    expect(unsavedWorkState(parked({ unsavedWorkCheckedAt: null }))).toBe('unknown');
    expect(unsavedWorkState(parked({ unsavedWork: null }))).toBe('unknown');
    expect(unsavedWorkState(parked({ lastActivityAt: new Date(t0.getTime() - HOUR / 2) }))).toBe('unknown');
  });

  it('counts any finding, an unreadable repo, a kept checkout or a failed scan as unsaved', () => {
    for (const scan of [
      { ...CLEAN, repos: [{ path: '/x', dirty: 1, unpushed: 0, stashes: 0 }] },
      { ...CLEAN, errors: [{ path: '/x', error: 'bad' }] },
      { ...CLEAN, keptCheckouts: 1 },
      { error: 'agent too old to scan for unsaved work' },
      { repos: [] },
      'nonsense',
    ]) {
      expect(unsavedWorkState(parked({ unsavedWork: scan })), JSON.stringify(scan)).toBe('unsaved');
    }
    expect(isCleanScan(CLEAN)).toBe(true);
  });
});

describe('terminateDecision', () => {
  const tf = (over: Partial<{ nowMs: number; flagOn: boolean; unsavedLimitDays: number }> = {}) =>
    ({ nowMs: t0.getTime() + DAY, flagOn: true, unsavedLimitDays: 90, ...over });

  it('terminates a clean parked box at its own limit, not before', () => {
    expect(terminateDecision(parked(), tf({ nowMs: t0.getTime() + DAY - 1 }))).toEqual({ terminate: false, reason: 'not-due' });
    expect(terminateDecision(parked(), tf())).toEqual({ terminate: true, days: 1 });
  });

  it('never terminates a box that hosts an enabled automation, once it is otherwise due (babysit-1027)', () => {
    expect(terminateDecision(parked(), { ...tf(), hostsAutomation: true })).toEqual({ terminate: false, reason: 'hosts-automation' });
    // The cheaper reasons come first, so the sweep asks about automations only for a due box.
    expect(terminateDecision(parked(), { ...tf({ nowMs: t0.getTime() + DAY - 1 }), hostsAutomation: true })).toMatchObject({ reason: 'not-due' });
    expect(terminateDecision(parked(), { ...tf(), hostsAutomation: false })).toEqual({ terminate: true, days: 1 });
    // And the box list dates no terminate for it.
    expect(lifecycleView({ ...parked(), lifecycleNote: null }, 90, { hostsAutomation: true }, t0.getTime())).toMatchObject({ terminateDueAt: null, parkedAt: t0.toISOString() });
  });

  it('waits the unsaved-work limit for unsaved or unscanned work, and never shortens a longer limit', () => {
    const unsaved = parked({ unsavedWork: { ...CLEAN, keptCheckouts: 2 } });
    expect(terminateDecision(unsaved, tf())).toEqual({ terminate: false, reason: 'not-due' });
    expect(terminateDecision(unsaved, tf({ nowMs: t0.getTime() + 90 * DAY }))).toEqual({ terminate: true, days: 90 });
    expect(terminateDecision(parked({ unsavedWorkCheckedAt: null }), tf({ nowMs: t0.getTime() + 89 * DAY })))
      .toMatchObject({ reason: 'not-due' });
    expect(effectiveTerminateDays(parked({ hibernatedTerminateDays: 120, unsavedWork: { error: 'x' } }), 90)).toBe(120);
  });

  it('only ever touches a parked box of its own kind', () => {
    const late = tf({ nowMs: t0.getTime() + 400 * DAY });
    for (const status of ['ready', 'stopping', 'hibernating', 'starting', 'terminated']) {
      expect(terminateDecision(parked({ status }), late), status).toEqual({ terminate: false, reason: 'not-parked' });
    }
    expect(terminateDecision(parked({ parkedAt: null }), late)).toMatchObject({ reason: 'not-parked' });
    expect(terminateDecision(parked({ rehibernatePending: true }), late)).toMatchObject({ reason: 'not-parked' });
    for (const over of [{ kind: 'external' }, { userId: null }]) {
      expect(terminateDecision(parked(over), late)).toEqual({ terminate: false, reason: 'not-eligible' });
    }
    // A hibernated box that can't hibernate is not one auto-park hibernated.
    expect(terminateDecision(parked({ hibernationConfigured: false }), late)).toEqual({ terminate: false, reason: 'not-parked' });
    expect(terminateDecision(parked({ hibernatedTerminateDays: null }), late)).toMatchObject({ reason: 'off' });
    expect(terminateDecision(parked(), { ...late, flagOn: false })).toMatchObject({ reason: 'flag-off' });
  });
});

describe('env defaults', () => {
  it('reads the unsaved-work limit, falling back on nonsense', () => {
    expect(unsavedWorkTerminateDays({})).toBe(90);
    expect(unsavedWorkTerminateDays({ BOX_UNSAVED_WORK_TERMINATE_DAYS: '30' })).toBe(30);
    expect(unsavedWorkTerminateDays({ BOX_UNSAVED_WORK_TERMINATE_DAYS: '0' })).toBe(90);
  });

  it('gives a box made for an ask no idle hours of its own (the default window stops it, nothing hibernates it) and no terminate', () => {
    expect(askBoxLifecycle()).toEqual({ idleHibernateHours: null, hibernatedTerminateDays: null });
  });
});

const at = (ms: number) => new Date(ms);

describe('stuckStartDecision', () => {
  const starting = box({ status: 'starting' });
  const started = t0.getTime() - 30 * MIN;
  const f = (over: Partial<Parameters<typeof stuckStartDecision>[1]> = {}) => ({
    nowMs: t0.getTime(), flagOn: true, startRequestedAt: started, agentConnected: false, startTimeoutMs: 15 * MIN,
    leadMs: 2 * HOUR, busy: [] as readonly string[], ...over,
  });

  it('warns first, two start timeouts into starting with no agent, and stops once the warned time is up', () => {
    expect(stuckStartDecision(starting, f())).toEqual({ act: 'warn', stopAt: at(t0.getTime() + 2 * HOUR) });
    expect(stuckStartDecision(starting, f({ startRequestedAt: started + 1 }))).toEqual({ act: 'none', reason: 'not-stuck' });
    const warned = box({ status: 'starting', idleWarnedAt: t0, idleParkAt: at(t0.getTime() + 2 * HOUR) });
    expect(stuckStartDecision(warned, f({ nowMs: t0.getTime() + HOUR }))).toEqual({ act: 'none', reason: 'warned' });
    expect(stuckStartDecision(warned, f({ nowMs: t0.getTime() + 2 * HOUR }))).toEqual({ act: 'stop' });
  });

  it("doesn't count a warning from before this start, and lets any busy check hold the box", () => {
    const old = box({ status: 'starting', idleWarnedAt: at(started - HOUR), idleParkAt: at(started - 30 * MIN) });
    expect(stuckStartDecision(old, f())).toMatchObject({ act: 'warn' });
    expect(stuckStartDecision(starting, f({ busy: ['ssh'] }))).toEqual({ act: 'none', reason: 'busy', check: 'ssh' });
  });

  it('leaves a box whose agent is back, one with no known start, a box not starting, and the flag off', () => {
    expect(stuckStartDecision(starting, f({ agentConnected: true }))).toMatchObject({ act: 'none', reason: 'not-stuck' });
    expect(stuckStartDecision(starting, f({ startRequestedAt: null }))).toMatchObject({ act: 'none', reason: 'not-stuck' });
    expect(stuckStartDecision(box({ status: 'ready' }), f())).toMatchObject({ act: 'none', reason: 'not-stuck' });
    expect(stuckStartDecision(box({ status: 'starting', kind: 'external' }), f())).toMatchObject({ act: 'none', reason: 'not-stuck' });
    expect(stuckStartDecision(starting, f({ flagOn: false }))).toEqual({ act: 'none', reason: 'flag-off' });
  });

  it("leaves a note saying why, which is not the auto-hibernate note, so a reviewer can't wake the box", () => {
    const note = stuckStartNote(new Date('2026-10-23T14:02:00Z'));
    expect(note).toBe('Stopped automatically: it was started at 2026-10-23 14:02 UTC and its agent never connected. Start it again, or terminate it if that keeps happening.');
    expect(isAutoHibernateNote(note)).toBe(false);
  });
});

describe('stuckStopRetryDecision', () => {
  const triedAt = at(t0.getTime() - 20 * MIN);
  // The power sweep's timeout clears autoParkedAt; the note is the mark, until an agent's connect drops it.
  const timedOut = (over: Record<string, unknown> = {}) => ({
    ...box({ autoParkedAt: null, idleWarnedAt: at(t0.getTime() - 2 * HOUR) }), lifecycleNote: stuckStartNote(at(t0.getTime() - 3 * HOUR)),
    lastConnectedAt: at(t0.getTime() - 4 * HOUR), ...over,
  });
  const f = { flagOn: true, agentConnected: false, busy: [] as readonly string[] };

  it('stops again a box whose stuck-start stop timed out back to ready with still no agent', () => {
    expect(stuckStopRetryDecision(timedOut(), f)).toBe(true);
    expect(stuckStopRetryDecision(timedOut({ autoParkedAt: triedAt }), f)).toBe(true);
  });

  it('leaves it once an agent is connected, a box with another note, a busy box, and the flag off', () => {
    expect(stuckStopRetryDecision(timedOut(), { ...f, agentConnected: true })).toBe(false);
    expect(stuckStopRetryDecision(timedOut({ lifecycleNote: 'Stopped automatically after 72 h idle.' }), f)).toBe(false);
    expect(stuckStopRetryDecision(timedOut({ lifecycleNote: null }), f)).toBe(false);
    // A connect since the warning whose write lost its guard, so the note stayed: the box came up.
    expect(stuckStopRetryDecision(timedOut({ lastConnectedAt: at(t0.getTime() - 10 * MIN) }), f)).toBe(false);
    expect(stuckStopRetryDecision(timedOut({ lastConnectedAt: null }), f)).toBe(true);
    expect(stuckStopRetryDecision(timedOut(), { ...f, busy: ['ask-run'] })).toBe(false);
    expect(stuckStopRetryDecision(timedOut(), { ...f, flagOn: false })).toBe(false);
  });
});

describe('parking by a stop', () => {
  const own = (over: Partial<LifecycleBox> = {}) => box({ idleHibernateHours: 2, ...over });
  const lead = 30 * MIN;
  const on = (over: Partial<Parameters<typeof idleHibernateDecision>[1]> = {}) => facts({ leadMs: lead, ...over });

  it('its own hours stop the box once they are up, with no warning, whether or not it can hibernate', () => {
    for (const hibernationConfigured of [true, false]) {
      const b = own({ hibernationConfigured });
      // The lead is the default window's; own hours never warn, whatever it says.
      expect(idleHibernateDecision(b, on({ nowMs: t0.getTime() + 2 * HOUR - lead }))).toEqual({ hibernate: false, reason: 'not-idle' });
      expect(idleHibernateDecision(b, on({ nowMs: t0.getTime() + 2 * HOUR - 1 }))).toEqual({ hibernate: false, reason: 'not-idle' });
      expect(idleHibernateDecision(b, on({ nowMs: t0.getTime() + 2 * HOUR }))).toEqual({ stop: true });
    }
  });

  it('a box woken without its owner goes back down by a stop once its hours are up again, never a hibernate', () => {
    const woken = own({ autoParkedAt: t0, lastActivityAt: t0 });
    expect(idleHibernateDecision(woken, on({ nowMs: t0.getTime() + HOUR }))).toEqual({ hibernate: false, reason: 'not-idle' });
    expect(idleHibernateDecision(woken, on())).toEqual({ stop: true });
  });

  it('still needs box-auto-lifecycle-enabled, and keeps the guards', () => {
    expect(idleHibernateDecision(own(), on({ flagOn: false }))).toEqual({ hibernate: false, reason: 'flag-off' });
    expect(idleHibernateDecision(own({ kind: 'external' }), on())).toEqual({ hibernate: false, reason: 'not-eligible' });
    expect(idleHibernateDecision(own(), on({ working: true }))).toEqual({ hibernate: false, reason: 'working' });
    expect(idleHibernateDecision(own({ rehibernatePending: true }), on())).toEqual({ hibernate: false, reason: 'refresh-pending' });
  });

  const stopped = (over: Partial<TerminateBox> = {}) => parked({ status: 'stopped', ...over });
  const tf = (over: Partial<{ nowMs: number; flagOn: boolean; unsavedLimitDays: number }> = {}) =>
    ({ nowMs: t0.getTime() + DAY, flagOn: true, unsavedLimitDays: 90, ...over });

  it('terminate-after counts from the stop auto-park made, for any box that can be stopped', () => {
    for (const hibernationConfigured of [true, false]) {
      const b = stopped({ hibernationConfigured });
      expect(terminateDecision(b, tf({ nowMs: t0.getTime() + DAY - 1 }))).toEqual({ terminate: false, reason: 'not-due' });
      expect(terminateDecision(b, tf())).toEqual({ terminate: true, days: 1 });
    }
    // A hibernated box is still terminated as before.
    expect(terminateDecision(parked(), tf())).toEqual({ terminate: true, days: 1 });
  });

  it('keeps the unsaved-work limit: 90 days unless the scan before the stop found nothing', () => {
    const unsaved = stopped({ unsavedWork: { ...CLEAN, repos: [{ path: '/home/u/src/x' }] } });
    expect(terminateDecision(unsaved, tf({ nowMs: t0.getTime() + 89 * DAY }))).toEqual({ terminate: false, reason: 'not-due' });
    expect(terminateDecision(unsaved, tf({ nowMs: t0.getTime() + 90 * DAY }))).toEqual({ terminate: true, days: 90 });
    const unscanned = stopped({ unsavedWork: null, unsavedWorkCheckedAt: null });
    expect(terminateDecision(unscanned, tf({ nowMs: t0.getTime() + 89 * DAY }))).toMatchObject({ reason: 'not-due' });
    const touched = stopped({ lastActivityAt: new Date(t0.getTime() - 30 * MIN) });
    expect(terminateDecision(touched, tf())).toMatchObject({ reason: 'not-due' });
  });

  it('a stopped box without parkedAt (stopped by hand) is never terminated', () => {
    const late = { nowMs: t0.getTime() + 400 * DAY };
    expect(terminateDecision(stopped({ parkedAt: null }), tf(late))).toEqual({ terminate: false, reason: 'not-parked' });
    expect(terminateDecision(stopped(), tf({ ...late, flagOn: false }))).toEqual({ terminate: false, reason: 'flag-off' });
  });

  it('the view says stop, warns of nothing on a box that cannot hibernate, and dates a stopped box\'s terminate', () => {
    const ready = { ...own({ hibernationConfigured: false }), parkedAt: null, hibernatedTerminateDays: 7, unsavedWork: null, unsavedWorkCheckedAt: null, lifecycleNote: null };
    const v = lifecycleView(ready, 90, { autoLifecycleOn: true, warnMinutes: 30 }, t0.getTime());
    expect(v).toMatchObject({
      parkStop: true, warning: null, hibernateDueAt: null, parkAction: 'stop',
      parkAt: new Date(t0.getTime() + 2 * HOUR).toISOString(), idleLimitHours: 2, idleLimitSource: 'own',
    });
    expect(lifecycleView({ ...stopped(), lifecycleNote: null }, 90, {}, t0.getTime())).toMatchObject({
      parkStop: true, unsavedWork: 'clean', terminateDueAt: new Date(t0.getTime() + DAY).toISOString(),
    });
  });

  it('never terminates a box with no terminate-after, whatever stopped it', () => {
    const late = tf({ nowMs: t0.getTime() + 400 * DAY });
    for (const b of [stopped({ hibernatedTerminateDays: null }), stopped({ hibernatedTerminateDays: null, hibernationConfigured: false }), parked({ hibernatedTerminateDays: null })]) {
      expect(terminateDecision(b, late)).toEqual({ terminate: false, reason: 'off' });
      expect(terminateDueAt(b, 90)).toBe(null);
    }
  });

  it('the terminate note says parked', () => {
    expect(autoTerminateNote(1)).toBe('Terminated automatically after 1 day parked.');
    expect(autoTerminateNote(3)).toBe('Terminated automatically after 3 days parked.');
  });
});
