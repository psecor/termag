import { describe, expect, it } from 'vitest';
import { aggregateBoxCost, type UsageDayRow } from './report';
import { DEFAULT_RATES, HOURS_PER_MONTH, ratesByDay } from './rates';

const H = 3600;
const RATE = DEFAULT_RATES.perHour['m9g.2xlarge'];
const range = { keys: ['2026-10-25', '2026-10-26'], sinceKey: '2026-10-25', untilKey: '2026-10-26' };
const row = (extra: Partial<UsageDayRow>): UsageDayRow => ({
  day: '2026-10-26', ec2InstanceId: 'i-1', instanceId: 'inst_1', userId: 'u1', instanceType: 'm9g.2xlarge', volumeGb: 152,
  activeSec: 0, idleSec: 0, poolSec: 0, bootSec: 0, orphanSec: 0, storageGbSec: 0, lastHour: new Date(`${extra.day ?? '2026-10-26'}T23:00:00Z`), ...extra,
});
const boxes = new Map([
  ['inst_1', { name: 'dev', status: 'ready', ownerName: 'pat', terminatedAt: null }],
  ['inst_2', { name: 'old', status: 'hibernated', ownerName: 'pat', terminatedAt: null }],
  ['inst_gone', { name: 'gone', status: 'terminated', ownerName: 'pat', terminatedAt: new Date('2026-10-25T10:20:00Z') }],
]);
const users = new Map([['u1', 'pat']]);

describe('aggregateBoxCost', () => {
  it('prices slices and sums them per day, box and person', () => {
    const r = aggregateBoxCost({
      range, boxes, users, meteredFrom: new Date('2026-10-25T00:00:00Z'),
      rows: [
        row({ day: '2026-10-25', activeSec: 2 * H, idleSec: 6 * H }),
        row({ day: '2026-10-26', idleSec: 4 * H, storageGbSec: 152 * 24 * H }),
      ],
    });
    expect(r.totals.active).toBeCloseTo(2 * RATE);
    expect(r.totals.idle).toBeCloseTo(10 * RATE);
    expect(r.totals.storage).toBeCloseTo((152 * 24 / HOURS_PER_MONTH) * DEFAULT_RATES.gp3PerGbMonth);
    expect(r.totals.runningHours).toBeCloseTo(12);
    expect(r.days.map(d => d.day)).toEqual(['2026-10-25', '2026-10-26']);
    expect(r.days[0].compute).toBeCloseTo(8 * RATE);
    expect(r.boxes).toHaveLength(1);
    expect(r.boxes[0]).toMatchObject({ name: 'dev', owner: 'pat', runningHours: 12 });
    expect(r.boxes[0].activeShare).toBeCloseTo(2 / 12);
    expect(r.people).toEqual([expect.objectContaining({ userId: 'u1', name: 'pat', boxes: 1 })]);
    expect(r.people[0].usd.total).toBeCloseTo(r.totals.total);
  });

  it('keeps pool and orphan time off everyone and out of the active share', () => {
    const r = aggregateBoxCost({
      range, boxes, users, meteredFrom: null,
      rows: [
        row({ ec2InstanceId: 'i-pool', instanceId: 'inst_p', userId: null, poolSec: 5 * H }),
        row({ ec2InstanceId: 'i-stray', instanceId: null, userId: null, orphanSec: 3 * H }),
      ],
    });
    expect(r.people).toEqual([]);
    expect(r.totals.pool).toBeCloseTo(5 * RATE);
    expect(r.totals.orphan).toBeCloseTo(3 * RATE);
    const stray = r.boxes.find(b => b.ec2InstanceId === 'i-stray')!;
    expect(stray).toMatchObject({ name: null, owner: null, activeShare: null });
  });

  it('never charges a person orphan time, even on a row that names them', () => {
    const r = aggregateBoxCost({
      range, boxes, users, meteredFrom: null,
      rows: [row({ idleSec: 2 * H, orphanSec: 3 * H, storageGbSec: 152 * H })],
    });
    expect(r.people[0].usd.orphan).toBe(0);
    expect(r.people[0].usd.compute).toBeCloseTo(2 * RATE);
    expect(r.people[0].usd.total).toBeCloseTo(2 * RATE + r.totals.storage);
    expect(r.people[0].runningHours).toBeCloseTo(2);
    expect(r.totals.orphan).toBeCloseTo(3 * RATE);
  });

  it('takes a box identity from its latest day, whatever order rows come in', () => {
    const r = aggregateBoxCost({
      range, boxes, users, meteredFrom: null,
      rows: [
        row({ day: '2026-10-26', ec2InstanceId: 'i-2', instanceId: 'inst_2', storageGbSec: 152 * H }),
        row({ day: '2026-10-25', ec2InstanceId: 'i-2', instanceId: null, userId: null, orphanSec: H }),
        row({ day: '2026-10-26', ec2InstanceId: 'i-3', instanceId: null, userId: null, orphanSec: H }),
        row({ day: '2026-10-26', ec2InstanceId: 'i-3', instanceId: 'inst_1', idleSec: H }),
      ],
    });
    expect(r.boxes.find(b => b.ec2InstanceId === 'i-2')).toMatchObject({ name: 'old', status: 'hibernated' });
    expect(r.boxes.find(b => b.ec2InstanceId === 'i-3')).toMatchObject({ name: 'dev', instanceId: 'inst_1' });
    expect(r.parked.boxes).toBe(1);
  });

  it('flags a terminated box only when EC2 kept it an hour past the teardown', () => {
    const clean = aggregateBoxCost({
      range, boxes, users, meteredFrom: null,
      rows: [row({ day: '2026-10-25', ec2InstanceId: 'i-gone', instanceId: 'inst_gone', idleSec: H, lastHour: new Date('2026-10-25T10:00:00Z') })],
    });
    expect(clean.boxes[0]).toMatchObject({ name: 'gone', teardownUnfinished: false });
    const lingering = aggregateBoxCost({
      range, boxes, users, meteredFrom: null,
      rows: [row({ day: '2026-10-25', ec2InstanceId: 'i-gone', instanceId: 'inst_gone', userId: null, orphanSec: H, lastHour: new Date('2026-10-25T12:00:00Z') })],
    });
    expect(lingering.boxes[0].teardownUnfinished).toBe(true);
  });

    it('prices what parked boxes keep paying for', () => {
    const r = aggregateBoxCost({
      range, boxes, users, meteredFrom: null,
      rows: [row({ ec2InstanceId: 'i-2', instanceId: 'inst_2', storageGbSec: 152 * H })],
    });
    expect(r.parked).toEqual({ boxes: 1, gb: 152, monthlyUsd: 152 * DEFAULT_RATES.gp3PerGbMonth });
  });

  it('takes a box type and volume from its latest day, and lists unrated types', () => {
    const r = aggregateBoxCost({
      range, boxes, users, meteredFrom: null,
      rows: [
        row({ day: '2026-10-25', instanceType: 'mystery.box', volumeGb: 120, idleSec: H }),
        row({ day: '2026-10-26', volumeGb: 152, idleSec: H }),
      ],
    });
    expect(r.boxes[0]).toMatchObject({ instanceType: 'm9g.2xlarge', volumeGb: 152 });
    expect(r.unrated).toEqual(['mystery.box']);
    expect(r.totals.idle).toBeCloseTo(RATE);
  });

  it('prices each day at its own learned rate, and reconciles whole metered days', () => {
    const r = aggregateBoxCost({
      range, boxes, users, meteredFrom: null,
      rows: [row({ day: '2026-10-25', idleSec: 10 * H }), row({ day: '2026-10-26', idleSec: 24 * H })],
      rates: ratesByDay(range.keys, [{ day: '2026-10-26', key: 'm9g.2xlarge', usd: 0.2 }]),
      billed: [
        { day: '2026-10-26', ec2InstanceId: 'i-1', instanceType: 'm9g.2xlarge', hours: 24, usd: 4.8, estimated: true },
        { day: '2026-10-26', ec2InstanceId: 'i-orch', instanceType: 't3.large', hours: 24, usd: 2, estimated: true },
      ],
      meterStartedAt: new Date('2026-10-25T14:00:00Z'),
      now: new Date('2026-10-28T03:00:00Z'),
    });
    expect(r.days[0].compute).toBeCloseTo(10 * RATE);
    expect(r.days[1].compute).toBeCloseTo(24 * 0.2);
    expect(r.rates.perHour['m9g.2xlarge']).toBe(0.2);
    expect(r.reconcile).toMatchObject({ days: ['2026-10-26'], estimatedDays: 1, meteredHours: 24, billedHours: 24, notMeteredUsd: 2 });
    expect(r.reconcile!.meteredUsd).toBeCloseTo(4.8);
  });
});
