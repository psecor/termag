import { describe, expect, it } from 'vitest';
import { BOX_DISK_LIMITS, decideBoxDisk, defaultDiskGiB, diskOptions, isDiskGiB, largestDiskGiB } from './boxDiskSize';

describe('the range: a whole number of GiB from 50 to 300', () => {
  it('takes the ends and anything between', () => {
    expect(BOX_DISK_LIMITS).toEqual({ minGiB: 50, maxGiB: 300 });
    for (const v of [50, 120, 200, 300]) expect(isDiskGiB(v), String(v)).toBe(true);
  });

  it('refuses anything else, strings of numbers included', () => {
    for (const v of [49, 301, 0, -120, 120.5, NaN, Infinity, '120', null, undefined, {}]) expect(isDiskGiB(v), String(v)).toBe(false);
  });
});

describe('the default: BOX_ROOT_VOLUME_GB, else 120', () => {
  it('is 120 with nothing configured', () => {
    expect(defaultDiskGiB({})).toBe(120);
  });

  it('follows BOX_ROOT_VOLUME_GB, the floor every launch already used', () => {
    expect(defaultDiskGiB({ BOX_ROOT_VOLUME_GB: '150' })).toBe(150);
  });

  it('is 120 for a value that is not a number', () => {
    expect(defaultDiskGiB({ BOX_ROOT_VOLUME_GB: 'big' })).toBe(120);
  });
});

describe('the disk order: the one asked for, then the repo file, then the default', () => {
  it('takes an explicit size over the repo file', () => {
    expect(decideBoxDisk(200, { size: null, diskGiB: 250 }, 120)).toEqual({ ok: true, diskGiB: 200, source: 'explicit' });
  });

  it('takes the repo file\'s, larger or smaller than the default', () => {
    expect(decideBoxDisk(undefined, { size: 'medium', diskGiB: 250 }, 120)).toEqual({ ok: true, diskGiB: 250, source: 'repo' });
    expect(decideBoxDisk(undefined, { size: null, diskGiB: 80 }, 120)).toEqual({ ok: true, diskGiB: 80, source: 'repo' });
  });

  it('is the default with no file, or a file without one', () => {
    expect(decideBoxDisk(undefined, null, 120)).toEqual({ ok: true, diskGiB: 120, source: 'default' });
    expect(decideBoxDisk(null, { size: 'large' }, 120)).toEqual({ ok: true, diskGiB: 120, source: 'default' });
  });

  it('refuses one out of range, or not a whole number, with a 400 naming the range', () => {
    for (const v of [49, 301, 120.5, '200', true]) {
      expect(decideBoxDisk(v, null, 120), String(v)).toEqual({
        ok: false, status: 400, code: 'invalid_disk', error: 'diskGiB must be a whole number of GB from 50 to 300',
      });
    }
  });
});

describe('largestDiskGiB: a multi-repo project takes the largest disk any repository asks for', () => {
  it('takes the most, skipping repositories that say nothing', () => {
    expect(largestDiskGiB([80, null, 250, undefined, 120])).toBe(250);
  });

  it('is nothing when none says anything', () => {
    expect(largestDiskGiB([null, undefined])).toBeNull();
    expect(largestDiskGiB([])).toBeNull();
  });
});

describe('what the New box disk fields are told', () => {
  it('gives the range, the default, and what a box for the repositories gets', () => {
    expect(diskOptions(120, { size: null, diskGiB: 200 })).toEqual({ minGiB: 50, maxGiB: 300, defaultGiB: 120, diskGiB: 200 });
    expect(diskOptions(120, null)).toEqual({ minGiB: 50, maxGiB: 300, defaultGiB: 120, diskGiB: 120 });
  });
});
