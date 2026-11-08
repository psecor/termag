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

/**
 * Failed launches released per sweep tick. Each is a dozen quick IAM and EC2
 * calls with no instance to wait for, run one after another so a backlog
 * does not trip IAM's rate limit.
 */
export const FAILED_LAUNCH_SWEEP_BATCH = 10;

/**
 * How old a failed launch must be before its leftovers are released: well past
 * the stuck sweep's 15 minutes, which can fail a row whose launch is still
 * waiting on AWS, and the SDK's own retries.
 */
export const FAILED_LAUNCH_SETTLE_MS = 60 * 60 * 1000;

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

/**
 * Failed ec2 rows whose launch never got an instance but did leave a security
 * group, a role or an instance profile behind, and whose release has not
 * finished (cleanedUpAt null) or started within `retryAfterMs`.
 *
 * Nothing can use those resources: there is no instance, a Retry launches a
 * new box under a new id, and a warm-pool row that failed is never claimed or
 * retired. Left alone, each one holds an IAM role until the account's role
 * quota (1,000) refuses every new box. Created more than
 * FAILED_LAUNCH_SETTLE_MS (and `retryAfterMs`) ago, so a launch still making
 * its resources is not raced; sweepFailedLaunches also skips any launch
 * still running in this process.
 */
export function failedLaunchLeftoversWhere(now: Date, retryAfterMs: number): Prisma.InstanceWhereInput {
  const before = new Date(now.getTime() - retryAfterMs);
  const settled = new Date(now.getTime() - Math.max(retryAfterMs, FAILED_LAUNCH_SETTLE_MS));
  return {
    kind: 'ec2',
    status: 'failed',
    ec2InstanceId: null,
    cleanedUpAt: null,
    createdAt: { lt: settled },
    AND: [
      { OR: [{ securityGroupId: { not: null } }, { iamRoleName: { not: null } }, { iamInstanceProfileName: { not: null } }] },
      { OR: [{ cleanupAttemptedAt: null }, { cleanupAttemptedAt: { lt: before } }] },
    ],
  };
}
