import { describe, expect, it } from 'vitest';
import { DEFAULT_RATES, HOURS_PER_MONTH, hourlyRate, ratesByDay, usageCost, vcpusFor } from './rates';

describe('vcpusFor', () => {
  it('reads the size off the name', () => {
    expect(vcpusFor('m9g.large')).toBe(2);
    expect(vcpusFor('m9g.xlarge')).toBe(4);
    expect(vcpusFor('m9g.2xlarge')).toBe(8);
    expect(vcpusFor('c8g.16xlarge')).toBe(64);
    expect(vcpusFor('m8g.medium')).toBe(1);
  });

  it('gives burstable types 2 vCPUs up to large', () => {
    expect(vcpusFor('t4g.medium')).toBe(2);
    expect(vcpusFor('t4g.micro')).toBe(2);
    expect(vcpusFor('t4g.xlarge')).toBe(4);
    expect(vcpusFor('t4g.2xlarge')).toBe(8);
  });

  it('is null for names it does not know', () => {
    expect(vcpusFor('m8g.metal-24xl')).toBeNull();
    expect(vcpusFor('unknown')).toBeNull();
  });
});

describe('hourlyRate', () => {
  it('uses a type its own rate', () => {
    expect(hourlyRate('m9g.2xlarge')).toEqual({ usd: 0.15902, known: true });
  });

  it('falls back to the vCPU rate', () => {
    expect(hourlyRate('m9g.8xlarge').usd).toBeCloseTo(32 * DEFAULT_RATES.perVcpuHour);
    expect(hourlyRate('m9g.8xlarge').known).toBe(true);
  });

  it('counts an unrecognised type as $0 and says so', () => {
    expect(hourlyRate('mystery')).toEqual({ usd: 0, known: false });
  });
});

describe('usageCost', () => {
  const zero = { activeSec: 0, idleSec: 0, poolSec: 0, bootSec: 0, orphanSec: 0, storageGbSec: 0 };

  it('prices each slice at the type rate', () => {
    const c = usageCost({ ...zero, instanceType: 'm9g.2xlarge', activeSec: 1800, idleSec: 1800 });
    expect(c.active).toBeCloseTo(0.15902 / 2);
    expect(c.idle).toBeCloseTo(0.15902 / 2);
    expect(c.compute).toBeCloseTo(0.15902);
    expect(c.rated).toBe(true);
  });

  it('prices a month of 100 GB at the gp3 rate', () => {
    const c = usageCost({ ...zero, instanceType: 'm9g.2xlarge', storageGbSec: 100 * 3600 * HOURS_PER_MONTH });
    expect(c.storage).toBeCloseTo(100 * DEFAULT_RATES.gp3PerGbMonth);
    expect(c.compute).toBe(0);
    expect(c.total).toBeCloseTo(c.storage);
  });
});

describe('ratesByDay', () => {
  const days = ['2026-10-25', '2026-10-26', '2026-10-27'];

  it('keeps the defaults before any bill', () => {
    const r = ratesByDay(days, []);
    expect(r.get('2026-10-25')).toEqual(DEFAULT_RATES);
  });

  it('overlays a learned rate from its day on, and carries it forward', () => {
    const r = ratesByDay(days, [
      { day: '2026-10-26', key: 'm8g.2xlarge', usd: 0.2 },
      { day: '2026-10-26', key: 'ebs:gp3', usd: 0.07 },
    ]);
    expect(r.get('2026-10-25')!.perHour['m8g.2xlarge']).toBe(DEFAULT_RATES.perHour['m8g.2xlarge']);
    expect(r.get('2026-10-26')!.perHour['m8g.2xlarge']).toBe(0.2);
    expect(r.get('2026-10-27')!.perHour['m8g.2xlarge']).toBe(0.2);
    expect(r.get('2026-10-27')!.gp3PerGbMonth).toBe(0.07);
    expect(r.get('2026-10-27')!.perHour['m9g.2xlarge']).toBe(DEFAULT_RATES.perHour['m9g.2xlarge']);
    expect(r.get('2026-10-27')!.source).toMatch(/through 2026-10-26/);
  });

  it('uses the latest rate before the window when the bill has nothing inside it', () => {
    const r = ratesByDay(['2026-10-27'], [{ day: '2026-10-20', key: 'm8g.2xlarge', usd: 0.3 }, { day: '2026-10-22', key: 'm8g.2xlarge', usd: 0.25 }]);
    expect(r.get('2026-10-27')!.perHour['m8g.2xlarge']).toBe(0.25);
  });
});
