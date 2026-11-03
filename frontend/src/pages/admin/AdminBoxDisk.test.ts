import { describe, expect, it } from 'vitest';
import { boxDiskSummary, boxGrowSummary, defaultGrowGb } from './AdminBoxDisk';

describe('boxDiskSummary', () => {
  it('shows the volume, and a modification only while EBS is still on it', () => {
    const v = { volumeId: 'vol-1', sizeGb: 152, volumeType: 'gp3', modification: null };
    expect(boxDiskSummary(v)).toBe('vol-1 · 152 GB gp3');
    expect(boxDiskSummary({ ...v, modification: { state: 'optimizing', progress: 40, targetSizeGb: 304, startedAt: null } }))
      .toBe('vol-1 · 152 GB gp3 · EBS optimizing 40% → 304 GB');
    expect(boxDiskSummary({ ...v, modification: { state: 'completed', progress: 100, targetSizeGb: 152, startedAt: null } })).toBe('vol-1 · 152 GB gp3');
  });
  it('says why there is no volume', () => {
    expect(boxDiskSummary(null)).toMatch(/not an EC2 box/);
    expect(boxDiskSummary({ error: 'AccessDenied' })).toBe('could not read the volume: AccessDenied');
  });
});

describe('boxGrowSummary', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  it('names the step a running grow is on, and the outcome of a finished one', () => {
    const g = { volumeId: 'vol-1', fromGb: 152, toGb: 304, by: 'admin1', startedAt: '2026-10-27T11:58:00Z', state: 'filesystem' as const, detail: null, finishedAt: null };
    expect(boxGrowSummary(g, now)).toMatch(/^152 → 304 GB by admin1 .* · growing the file system$/);
    expect(boxGrowSummary({ ...g, state: 'done', detail: 'file system 148 → 297 GB (partition grown)' }, now)).toMatch(/· done · file system 148 → 297 GB/);
    expect(boxGrowSummary(null, now)).toBeNull();
  });
});

describe('defaultGrowGb', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  const v = { volumeId: 'vol-1', sizeGb: 152, volumeType: 'gp3', modification: null };
  const failed = { volumeId: 'vol-1', fromGb: 152, toGb: 304, by: 'admin1', startedAt: '2026-10-27T11:00:00Z', state: 'failed' as const, detail: 'ask again to the same size', finishedAt: '2026-10-27T11:20:00Z' };

  it('doubles, within the ceiling', () => {
    expect(defaultGrowGb(v, null, 16_384, now)).toBe(304);
    expect(defaultGrowGb({ ...v, sizeGb: 10_000 }, null, 16_384, now)).toBe(16_384);
  });
  it('keeps the size a failed grow already took the volume to, so a retry runs only the file system step', () => {
    expect(defaultGrowGb({ ...v, sizeGb: 304 }, failed, 16_384, now)).toBe(304);
  });
  it('keeps the size EBS modified the volume to in the last six hours (a grow an orchestrator restart cut off)', () => {
    const m = { state: 'optimizing', progress: 60, targetSizeGb: 304, startedAt: '2026-10-27T10:00:00Z' };
    expect(defaultGrowGb({ ...v, sizeGb: 304, modification: m }, null, 16_384, now)).toBe(304);
    expect(defaultGrowGb({ ...v, sizeGb: 304, modification: { ...m, state: 'completed', startedAt: '2026-10-27T05:00:00Z' } }, null, 16_384, now)).toBe(608);
  });
});
