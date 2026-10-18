import { describe, expect, it } from 'vitest';
import {
  CANNOT_HIBERNATE_WARNING,
  canAutoHibernate,
  effectiveTerminateDays,
  isCleanScan,
  subagentLifecycleDefaults,
  type TerminateBox,
  terminateDecision,
  unsavedWorkState,
  unsavedWorkTerminateDays,
  hibernateDueAt,
  idleHibernateDecision,
  type LifecycleBox,
  lifecycleSettingsError,
  lifecycleView,
  lifecycleWarning,
  parseLifecycleSettings,
} from './boxLifecyclePolicy';

const HOUR = 60 * 60 * 1000;
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
  nowMs: t0.getTime() + 2 * HOUR, flagOn: true, busy: false, working: false, ...over,
});

describe('idleHibernateDecision', () => {
  it('hibernates a box idle past its window', () => {
    expect(idleHibernateDecision(box(), facts())).toEqual({ hibernate: true });
  });

  it('waits until the window is up', () => {
    expect(idleHibernateDecision(box(), facts({ nowMs: t0.getTime() + HOUR - 1 })))
      .toEqual({ hibernate: false, reason: 'not-idle' });
    expect(idleHibernateDecision(box(), facts({ nowMs: t0.getTime() + HOUR }))).toEqual({ hibernate: true });
  });

  it('never touches a box that cannot hibernate, an external box or an ownerless one', () => {
    for (const over of [{ hibernationConfigured: false }, { kind: 'external' }, { userId: null }, { ec2InstanceId: null }]) {
      expect(idleHibernateDecision(box(over), facts())).toEqual({ hibernate: false, reason: 'not-eligible' });
    }
  });

  it('skips a box with the setting off, a box not ready and a refresh in progress', () => {
    expect(idleHibernateDecision(box({ idleHibernateHours: null }), facts())).toMatchObject({ reason: 'off' });
    expect(idleHibernateDecision(box({ status: 'hibernated' }), facts())).toMatchObject({ reason: 'not-ready' });
    expect(idleHibernateDecision(box({ rehibernatePending: true }), facts())).toMatchObject({ reason: 'refresh-pending' });
  });

  it('respects the flag, a busy box and a working agent, in that order', () => {
    expect(idleHibernateDecision(box(), facts({ flagOn: false, busy: true }))).toMatchObject({ reason: 'flag-off' });
    expect(idleHibernateDecision(box(), facts({ busy: true, working: true }))).toMatchObject({ reason: 'busy' });
    expect(idleHibernateDecision(box(), facts({ working: true }))).toMatchObject({ reason: 'working' });
  });

  it('counts from first ready when the box has never seen activity', () => {
    const b = box({ lastActivityAt: null, readyAt: t0 });
    expect(hibernateDueAt(b)?.getTime()).toBe(t0.getTime() + HOUR);
    expect(hibernateDueAt(box({ lastActivityAt: null, readyAt: null, createdAt: t0 }))?.getTime()).toBe(t0.getTime() + HOUR);
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
  it('warns only when a setting is on for a box that cannot hibernate', () => {
    const w = (over: Partial<LifecycleBox>, hibernatedTerminateDays: number | null = null) =>
      lifecycleWarning({ ...box(over), hibernatedTerminateDays });
    expect(w({ hibernationConfigured: false })).toBe(CANNOT_HIBERNATE_WARNING);
    expect(w({ kind: 'external', ec2InstanceId: null })).toBe(CANNOT_HIBERNATE_WARNING);
    expect(w({ hibernationConfigured: false, idleHibernateHours: null }, 14)).toBe(CANNOT_HIBERNATE_WARNING);
    expect(w({ hibernationConfigured: false, idleHibernateHours: null })).toBeNull();
    expect(w({}, 14)).toBeNull();
  });

  it('never lets the sweep act on such a box', () => {
    const legacy = box({ hibernationConfigured: false, lastActivityAt: new Date(t0.getTime() - 100 * HOUR) });
    expect(idleHibernateDecision(legacy, { nowMs: t0.getTime(), flagOn: true, busy: false, working: false }))
      .toEqual({ hibernate: false, reason: 'not-eligible' });
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
  it('shows the due time only for a ready box with the setting on', () => {
    const v = view({ ...box(), parkedAt: null, hibernatedTerminateDays: null, unsavedWork: null, unsavedWorkCheckedAt: null });
    expect(v).toEqual({
      canAutoHibernate: true, idleHibernateHours: 1, hibernatedTerminateDays: null,
      hibernateDueAt: new Date(t0.getTime() + HOUR).toISOString(), terminateDueAt: null,
      parkedAt: null, unsavedWork: null, note: null, warning: null,
    });
    expect(view(parked({ hibernationConfigured: false, idleHibernateHours: null })))
      .toMatchObject({ canAutoHibernate: false, hibernateDueAt: null, terminateDueAt: null, warning: CANNOT_HIBERNATE_WARNING });
    expect(view(parked(), 'n')).toMatchObject({
      hibernateDueAt: null, parkedAt: t0.toISOString(), note: 'n',
      unsavedWork: 'clean', terminateDueAt: new Date(t0.getTime() + DAY).toISOString(),
    });
    expect(canAutoHibernate(box({ hibernationConfigured: false }))).toBe(false);
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

  it('waits the unsaved-work limit for unsaved or unscanned work, and never shortens a longer limit', () => {
    const unsaved = parked({ unsavedWork: { ...CLEAN, keptCheckouts: 2 } });
    expect(terminateDecision(unsaved, tf())).toEqual({ terminate: false, reason: 'not-due' });
    expect(terminateDecision(unsaved, tf({ nowMs: t0.getTime() + 90 * DAY }))).toEqual({ terminate: true, days: 90 });
    expect(terminateDecision(parked({ unsavedWorkCheckedAt: null }), tf({ nowMs: t0.getTime() + 89 * DAY })))
      .toMatchObject({ reason: 'not-due' });
    expect(effectiveTerminateDays(parked({ hibernatedTerminateDays: 120, unsavedWork: { error: 'x' } }), 90)).toBe(120);
  });

  it('only ever touches a hibernated box of its own kind', () => {
    const late = tf({ nowMs: t0.getTime() + 400 * DAY });
    for (const status of ['ready', 'stopped', 'stopping', 'hibernating', 'starting', 'terminated']) {
      expect(terminateDecision(parked({ status }), late), status).toEqual({ terminate: false, reason: 'not-parked' });
    }
    expect(terminateDecision(parked({ parkedAt: null }), late)).toMatchObject({ reason: 'not-parked' });
    expect(terminateDecision(parked({ rehibernatePending: true }), late)).toMatchObject({ reason: 'not-parked' });
    for (const over of [{ hibernationConfigured: false }, { kind: 'external' }, { userId: null }]) {
      expect(terminateDecision(parked(over), late)).toEqual({ terminate: false, reason: 'not-eligible' });
    }
    expect(terminateDecision(parked({ hibernatedTerminateDays: null }), late)).toMatchObject({ reason: 'off' });
    expect(terminateDecision(parked(), { ...late, flagOn: false })).toMatchObject({ reason: 'flag-off' });
  });
});

describe('env defaults', () => {
  it('reads the unsaved-work limit and the subagent defaults, falling back on nonsense', () => {
    expect(unsavedWorkTerminateDays({})).toBe(90);
    expect(unsavedWorkTerminateDays({ BOX_UNSAVED_WORK_TERMINATE_DAYS: '30' })).toBe(30);
    expect(unsavedWorkTerminateDays({ BOX_UNSAVED_WORK_TERMINATE_DAYS: '0' })).toBe(90);
    expect(subagentLifecycleDefaults({})).toEqual({ idleHibernateHours: 1, hibernatedTerminateDays: 1 });
    expect(subagentLifecycleDefaults({ BOX_SUBAGENT_HIBERNATED_TERMINATE_DAYS: '3' }).hibernatedTerminateDays).toBe(3);
    expect(subagentLifecycleDefaults({ BOX_SUBAGENT_HIBERNATED_TERMINATE_DAYS: 'x' }).hibernatedTerminateDays).toBe(1);
  });
});
