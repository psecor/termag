import { describe, it, expect } from 'vitest';
import { summarize, truncateToMinute, reduceRecord, reduceSweep, Bucket } from './contextSampler';

const MIN = 60_000;
function bucket(over: Partial<Bucket> = {}): Bucket {
  return { projectId: 'p1', workstream: 'main', bucketStart: 0, samples: [100], lastValue: 100, lastSampleAt: 0, ...over };
}

describe('summarize', () => {
  it('computes mean (rounded), max, count', () => {
    expect(summarize([100, 200, 250])).toEqual({ meanTokens: 183, maxTokens: 250, sampleCount: 3 });
  });
  it('handles a single sample', () => {
    expect(summarize([500])).toEqual({ meanTokens: 500, maxTokens: 500, sampleCount: 1 });
  });
});

describe('truncateToMinute', () => {
  it('floors to the minute', () => {
    expect(truncateToMinute(90_000)).toBe(60_000);
    expect(truncateToMinute(59_999)).toBe(0);
  });
});

describe('reduceRecord', () => {
  it('starts a bucket for a new key', () => {
    const r = reduceRecord(undefined, 'p1', 'main', 100, 30_000);
    expect(r.flush).toBeUndefined();
    expect(r.next).toMatchObject({ projectId: 'p1', workstream: 'main', bucketStart: 0, samples: [100], lastValue: 100 });
  });

  it('appends within the same minute without flushing', () => {
    const existing = bucket({ samples: [100], lastValue: 100, lastSampleAt: 10_000 });
    const r = reduceRecord(existing, 'p1', 'main', 150, 40_000);
    expect(r.flush).toBeUndefined();
    expect(r.next!.samples).toEqual([100, 150]);
    expect(r.next!.lastValue).toBe(150);
  });

  it('flushes the old bucket and rolls when the minute changes', () => {
    const existing = bucket({ samples: [100, 120], lastValue: 120, lastSampleAt: 50_000 });
    const r = reduceRecord(existing, 'p1', 'main', 130, MIN + 5_000);
    expect(r.flush).toBe(existing);
    expect(r.next).toMatchObject({ bucketStart: MIN, samples: [130], lastValue: 130 });
  });

  it('evicts (flushing what we have) on a null reading', () => {
    const existing = bucket();
    const r = reduceRecord(existing, 'p1', 'main', null, 99_999);
    expect(r.flush).toBe(existing);
    expect(r.next).toBeUndefined();
  });

  it('is a no-op for null with no existing bucket', () => {
    expect(reduceRecord(undefined, 'p1', 'main', null, 1)).toEqual({});
  });
});

describe('reduceSweep', () => {
  it('flushes and evicts a stale bucket', () => {
    const b = bucket({ lastSampleAt: 0 });
    const r = reduceSweep(b, 20 * MIN, 12 * MIN);
    expect(r.flush).toBe(b);
    expect(r.next).toBeUndefined();
  });

  it('carries the last value forward when the minute rolls', () => {
    const b = bucket({ samples: [100, 200], lastValue: 200, lastSampleAt: 30_000 });
    const r = reduceSweep(b, 90_000, 12 * MIN); // now in minute 1, last sample recent
    expect(r.flush).toBe(b);
    expect(r.next).toMatchObject({ bucketStart: MIN, samples: [200], lastValue: 200 });
  });

  it('leaves the bucket unchanged within the same minute', () => {
    const b = bucket({ bucketStart: 0, lastSampleAt: 30_000 });
    const r = reduceSweep(b, 40_000, 12 * MIN);
    expect(r.flush).toBeUndefined();
    expect(r.next).toBe(b);
  });
});
