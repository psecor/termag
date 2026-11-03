import { describe, expect, it } from 'vitest';
import type { QuarantineStepResult } from '../services/adminApi';
import {
  QUARANTINE_REASON_MAX,
  QUARANTINE_STEP_LABELS,
  canQuarantine,
  quarantineConfirmed,
  quarantineNeedsRetry,
  quarantineSnapshotIds,
  quarantineStillConnected,
} from './boxQuarantine';

const at = '2026-10-23T18:00:00.000Z';
const all = (outcome: QuarantineStepResult['outcome']): QuarantineStepResult[] =>
  QUARANTINE_STEP_LABELS.map(([step]) => ({ step, outcome, detail: '', at }));

describe('box quarantine helpers', () => {
  it('offers the action on any box still in service', () => {
    expect(['ready', 'stopped', 'hibernated', 'failed', 'warm'].every(status => canQuarantine({ status }))).toBe(true);
    expect(canQuarantine({ status: 'quarantined' })).toBe(false);
    expect(canQuarantine({ status: 'terminated' })).toBe(false);
  });

  it('offers a retry while a step failed or nothing was recorded, and not once everything finished', () => {
    const box = { status: 'quarantined' };
    expect(quarantineNeedsRetry(box, all('done'))).toBe(false);
    expect(quarantineNeedsRetry(box, all('skipped'))).toBe(false);
    expect(quarantineNeedsRetry(box, all('done').map(s => (s.step === 'stop' ? { ...s, outcome: 'failed' as const } : s)))).toBe(true);
    expect(quarantineNeedsRetry(box, all('done').slice(0, 5))).toBe(true);
    expect(quarantineNeedsRetry(box, null)).toBe(true);
    expect(quarantineNeedsRetry({ status: 'terminated' }, null)).toBe(false);
    // A run still in flight would answer a retry with a 409.
    expect(quarantineNeedsRetry(box, null, true)).toBe(false);
    expect(quarantineNeedsRetry(box, [{ step: 'tokens', outcome: 'done', detail: '', at }], true)).toBe(false);
  });

  it('needs the exact box name and a reason', () => {
    expect(quarantineConfirmed('jackbox01', 'jackbox01', 'stealer')).toBe(true);
    expect(quarantineConfirmed('jackbox01', ' jackbox01 ', 'stealer')).toBe(true);
    expect(quarantineConfirmed('jackbox01', 'jackbox0', 'stealer')).toBe(false);
    expect(quarantineConfirmed('jackbox01', 'jackbox01', '  ')).toBe(false);
    expect(quarantineConfirmed('jackbox01', 'jackbox01', 'x'.repeat(QUARANTINE_REASON_MAX + 1))).toBe(false);
  });

  it('stops the box before it snapshots it', () => {
    const order = QUARANTINE_STEP_LABELS.map(([step]) => step);
    expect(order.indexOf('stop')).toBeLessThan(order.indexOf('snapshot'));
  });

  it('warns that open connections are up until the stop lands', () => {
    expect(quarantineStillConnected(null)).toBe(true);
    expect(quarantineStillConnected(all('done').slice(0, 4))).toBe(true);
    expect(quarantineStillConnected(all('done').map(s => (s.step === 'stop' ? { ...s, outcome: 'failed' as const } : s)))).toBe(true);
    expect(quarantineStillConnected(all('done'))).toBe(false);
    // Skipped: EC2 already had it stopped.
    expect(quarantineStillConnected(all('skipped'))).toBe(false);
  });

  it('lists every snapshot taken', () => {
    expect(quarantineSnapshotIds([{ step: 'snapshot', outcome: 'done', detail: '', at,
      snapshots: [{ volumeId: 'vol-1', device: '/dev/sda1', snapshotId: 'snap-1' }, { volumeId: 'vol-2', device: '/dev/sdf', snapshotId: 'snap-2' }] }]))
      .toEqual(['snap-1', 'snap-2']);
    expect(quarantineSnapshotIds(null)).toEqual([]);
  });
});
