import { describe, expect, it } from 'vitest';
import { firstWholeDay, lastSettledDay, reconcile, type BilledDay, type MeteredDay } from './reconcile';

const H = 3600;
const billed = (extra: Partial<BilledDay>): BilledDay => ({ day: '2026-10-28', ec2InstanceId: 'i-1', instanceType: 'm8g.2xlarge', hours: 24, usd: 3.5, estimated: false, ...extra });
const metered = (extra: Partial<MeteredDay>): MeteredDay => ({ day: '2026-10-28', ec2InstanceId: 'i-1', name: 'dev', instanceType: 'm8g.2xlarge', runningSec: 24 * H, computeUsd: 3.5, ...extra });
const STARTED = new Date('2026-10-27T05:10:00Z');
const NOW = new Date('2026-10-31T03:00:00Z');

describe('firstWholeDay', () => {
  it('never takes the start day as whole, even an hour-aligned 00:00 start', () => {
    expect(firstWholeDay(STARTED)).toBe('2026-10-28');
    expect(firstWholeDay(new Date('2026-10-27T00:00:00Z'))).toBe('2026-10-28');
  });
});

describe('lastSettledDay', () => {
  it('is two days before today', () => {
    expect(lastSettledDay(NOW)).toBe('2026-10-29');
  });
});

describe('reconcile', () => {
  it('is null before the meter has a whole billed day', () => {
    expect(reconcile({ billed: [billed({})], metered: [metered({})], meterStartedAt: null, now: NOW })).toBeNull();
    expect(reconcile({ billed: [billed({ day: '2026-10-27' })], metered: [], meterStartedAt: STARTED, now: NOW })).toBeNull();
  });

  it('matches instances and sums both sides over the compared days', () => {
    const r = reconcile({
      billed: [billed({}), billed({ day: '2026-10-27', usd: 99 })],
      metered: [metered({}), metered({ day: '2026-10-27', runningSec: 5 * H })],
      meterStartedAt: STARTED, now: NOW,
    })!;
    expect(r.days).toEqual(['2026-10-28']);
    expect(r).toMatchObject({ meteredHours: 24, billedHours: 24, billedUsd: 3.5, notMetered: [], notBilled: [], drift: [] });
  });

  it('leaves out days the bill has not settled', () => {
    const r = reconcile({ billed: [billed({}), billed({ day: '2026-10-30', hours: 6 })], metered: [metered({}), metered({ day: '2026-10-30' })], meterStartedAt: STARTED, now: NOW })!;
    expect(r.days).toEqual(['2026-10-28']);
    expect(r.drift).toEqual([]);
  });

  it('lists billed instances the meter never saw, apart from the box totals', () => {
    const r = reconcile({ billed: [billed({}), billed({ ec2InstanceId: 'i-orch', instanceType: 't3.large', usd: 2 })], metered: [metered({})], meterStartedAt: STARTED, now: NOW })!;
    expect(r.notMetered).toEqual([expect.objectContaining({ ec2InstanceId: 'i-orch', instanceType: 't3.large', billedUsd: 2, meteredHours: 0 })]);
    expect(r.notMeteredUsd).toBe(2);
    expect(r.billedUsd).toBe(3.5);
  });

  it('lists metered boxes with no bill, and boxes whose hours are too far apart', () => {
    const r = reconcile({
      billed: [billed({ hours: 20 }), billed({ ec2InstanceId: 'i-ok', hours: 23.8 })],
      metered: [metered({}), metered({ ec2InstanceId: 'i-ok', name: 'ok' }), metered({ ec2InstanceId: 'i-free', name: 'free', runningSec: 3 * H })],
      meterStartedAt: STARTED, now: NOW,
    })!;
    expect(r.drift.map(l => l.ec2InstanceId)).toEqual(['i-1']);
    expect(r.notBilled.map(l => [l.name, l.instanceType])).toEqual([['free', 'm8g.2xlarge']]);
    expect(r.estimatedDays).toBe(0);
  });
});
