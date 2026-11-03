import type { QuarantineStepName, QuarantineStepResult } from '../services/adminApi';

/**
 * Mirrors STEP_LABELS in backend/src/services/boxQuarantinePolicy.ts, in the
 * order the steps run (QUARANTINE_STEPS there). boxQuarantinePolicy.mirror.test.ts
 * in the backend fails when the two drift.
 */
export const QUARANTINE_STEP_LABELS: ReadonlyArray<[QuarantineStepName, string]> = [
  ['tokens', 'revoke box tokens and drop its agent'],
  ['tag', 'tag the EC2 instance'],
  ['iam', 'deny every action to the box role'],
  ['network', 'remove every security group rule'],
  ['stop', 'stop the instance, ending connections already open'],
  ['snapshot', 'snapshot every EBS volume once it is stopped'],
];

/** Mirrors QUARANTINE_REASON_MAX in backend/src/services/boxQuarantinePolicy.ts. */
export const QUARANTINE_REASON_MAX = 500;

/** The Fleet card's row labels, short enough to sit beside a long AWS detail. */
export const QUARANTINE_STEP_SHORT: Readonly<Record<QuarantineStepName, string>> = {
  tokens: 'tokens', tag: 'instance tag', iam: 'role', network: 'network', snapshot: 'snapshots', stop: 'power',
};

export function canQuarantine(box: { status: string }): boolean {
  return box.status !== 'terminated' && box.status !== 'quarantined';
}

/**
 * A quarantined box whose last run left a step failed, or recorded nothing: a
 * retry re-runs only those. Never while a run is still in flight, which would
 * answer the retry with a 409.
 */
export function quarantineNeedsRetry(
  box: { status: string },
  steps: readonly QuarantineStepResult[] | null,
  running = false,
): boolean {
  if (box.status !== 'quarantined' || running) return false;
  if (!steps) return true;
  return steps.some(s => s.outcome === 'failed') || steps.length < QUARANTINE_STEP_LABELS.length;
}

export function quarantineOutcomeClass(outcome: QuarantineStepResult['outcome']): string {
  return outcome === 'done' ? 'admin-good' : outcome === 'failed' ? 'admin-bad' : 'usage-dim';
}

/** Every snapshot the quarantine took, for the terminate confirmation. */
export function quarantineSnapshotIds(steps: readonly QuarantineStepResult[] | null): string[] {
  return (steps ?? []).flatMap(s => s.snapshots?.map(x => x.snapshotId) ?? []);
}

/** The typed confirmation must name the box exactly, so a quarantine is never one stray click. */
export function quarantineConfirmed(boxName: string, typed: string, reason: string): boolean {
  return typed.trim() === boxName && reason.trim().length > 0 && reason.length <= QUARANTINE_REASON_MAX;
}

/**
 * The stop has not landed (failed, or not recorded yet): removing the security
 * group rules refused new connections only, so any already open are still up.
 */
export function quarantineStillConnected(steps: readonly QuarantineStepResult[] | null): boolean {
  const stop = steps?.find(s => s.step === 'stop');
  return !stop || stop.outcome === 'failed';
}
