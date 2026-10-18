/**
 * Box teardown: the pure decisions. `boxProvisioner.ts` owns every AWS call and
 * Prisma write; this module only classifies errors and picks which terminated
 * rows the provisioning sweep retries, so the rules are unit-testable.
 *
 * A teardown is done when every resource is gone, whether this run deleted it
 * or found it already deleted. That makes a re-run of a finished or half-done
 * teardown cheap: each step answers NotFound at once.
 */

import type { Prisma } from '@prisma/client';

export const EC2_INSTANCE_NOT_FOUND = ['InvalidInstanceID.NotFound'] as const;
export const EC2_GROUP_NOT_FOUND = ['InvalidGroup.NotFound'] as const;
export const EC2_PERMISSION_NOT_FOUND = ['InvalidPermission.NotFound'] as const;
export const IAM_NOT_FOUND = ['NoSuchEntity', 'NoSuchEntityException'] as const;

/** The AWS error code of an SDK v3 error: `name` for both the EC2 and the IAM client. */
export function awsErrorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const e = err as { name?: unknown; Code?: unknown; code?: unknown };
  for (const v of [e.Code, e.code, e.name]) {
    if (typeof v === 'string' && v && v !== 'Error') return v;
  }
  return '';
}

export function isAwsNotFound(err: unknown, codes: readonly string[]): boolean {
  return codes.includes(awsErrorCode(err));
}

const DEFAULT_TEARDOWN_RETRY_SECONDS = 10 * 60;
const DEFAULT_SWEEP_SECONDS = 5 * 60;

/** Teardowns retried per sweep tick. Each one runs in the background for up to several minutes. */
export const TEARDOWN_SWEEP_BATCH = 3;

function positiveSeconds(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * How long a terminated row waits, after it was terminated and after its last
 * teardown started, before the sweep starts another. Longer than one teardown
 * can take (about 5 minutes waiting for EC2, a minute of security-group
 * retries, then IAM), so a teardown still in flight is never started again.
 */
export function teardownRetryAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveSeconds(env.BOX_TEARDOWN_RETRY_SECONDS, DEFAULT_TEARDOWN_RETRY_SECONDS) * 1000;
}

export function provisioningSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveSeconds(env.BOX_PROVISIONING_SWEEP_SECONDS, DEFAULT_SWEEP_SECONDS) * 1000;
}

/**
 * Terminated ec2 rows whose teardown has not finished and has not started
 * within `retryAfterMs`. Also the guard on the claim that stamps
 * cleanupAttemptedAt, so two sweeps (or two orchestrators) that select the
 * same row start only one teardown.
 *
 * A null terminatedAt is included: such a row predates the column, and leaving
 * it out would hide exactly the old leaks this sweep exists to find.
 */
export function teardownCandidatesWhere(now: Date, retryAfterMs: number): Prisma.InstanceWhereInput {
  const before = new Date(now.getTime() - retryAfterMs);
  return {
    kind: 'ec2',
    status: 'terminated',
    cleanedUpAt: null,
    AND: [
      { OR: [{ terminatedAt: null }, { terminatedAt: { lt: before } }] },
      { OR: [{ cleanupAttemptedAt: null }, { cleanupAttemptedAt: { lt: before } }] },
    ],
  };
}
