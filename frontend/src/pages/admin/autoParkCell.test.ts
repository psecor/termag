import { describe, expect, it } from 'vitest';
import type { BoxLifecycle } from '../../types';
import { autoParkCell } from './AdminFleet';

const lc = (over: Partial<BoxLifecycle> = {}): BoxLifecycle => ({
  canAutoHibernate: false, parkAction: 'stop', idleHibernateHours: null, idleLimitHours: 2, idleLimitSource: 'default',
  hibernatedTerminateDays: null, hibernateDueAt: null, parkAt: null, warnedAt: null, autoParkedAt: null,
  terminateDueAt: null, parkedAt: null, unsavedWork: null, note: null, warning: null, ...over,
});

describe('autoParkCell', () => {
  const now = new Date('2026-10-23T12:00:00Z').getTime();
  const ec2 = { kind: 'ec2', ec2InstanceId: 'i-1' };

  it('says what auto-park will do with the box, and when it last did', () => {
    expect(autoParkCell(lc(), now, ec2)).toBe('stops after 2 h idle (default window)');
    expect(autoParkCell(lc({ idleLimitHours: 8, idleLimitSource: 'own' }), now, ec2)).toBe('stops after 8 h idle (its own)');
    expect(autoParkCell(lc({ parkAt: '2026-10-23T14:00:00.000Z', warnedAt: '2026-10-23T12:00:00.000Z' }), now, ec2)).toMatch(/ · warned, parks /);
    expect(autoParkCell(lc({ autoParkedAt: '2026-10-23T10:00:00.000Z' }), now, ec2)).toMatch(/ · auto-parked /);
  });

  it('says off, or no owner', () => {
    expect(autoParkCell(lc({ idleLimitHours: null, idleLimitSource: null, parkAction: null }), now, ec2)).toBe('off');
    expect(autoParkCell(null, now, ec2)).toBe('— (no owner)');
  });

  it("says never for a box auto-park can't act on, whatever its settings", () => {
    expect(autoParkCell(lc(), now, { kind: 'external', ec2InstanceId: null })).toBe('never (not an EC2 box termag runs)');
    expect(autoParkCell(lc(), now, { kind: 'ec2', ec2InstanceId: null })).toBe('never (not an EC2 box termag runs)');
  });
});
