import { describe, expect, it } from 'vitest';
import {
  EC2_GROUP_NOT_FOUND,
  EC2_INSTANCE_NOT_FOUND,
  IAM_NOT_FOUND,
  awsErrorCode,
  isAwsNotFound,
  provisioningSweepIntervalMs,
  teardownCandidatesWhere,
  teardownRetryAfterMs,
} from './boxTeardownPolicy';

const awsError = (name: string) => Object.assign(new Error('boom'), { name });

describe('awsErrorCode', () => {
  it('reads the SDK v3 error name', () => {
    expect(awsErrorCode(awsError('InvalidGroup.NotFound'))).toBe('InvalidGroup.NotFound');
  });

  it('prefers an explicit Code over the generic name', () => {
    expect(awsErrorCode(Object.assign(new Error('x'), { Code: 'NoSuchEntity' }))).toBe('NoSuchEntity');
  });

  it('is empty for a plain Error and for non-errors', () => {
    expect(awsErrorCode(new Error('x'))).toBe('');
    expect(awsErrorCode('InvalidGroup.NotFound')).toBe('');
    expect(awsErrorCode(undefined)).toBe('');
  });
});

describe('isAwsNotFound', () => {
  it('matches each resource kind only on its own code', () => {
    expect(isAwsNotFound(awsError('InvalidInstanceID.NotFound'), EC2_INSTANCE_NOT_FOUND)).toBe(true);
    expect(isAwsNotFound(awsError('InvalidGroup.NotFound'), EC2_GROUP_NOT_FOUND)).toBe(true);
    expect(isAwsNotFound(awsError('NoSuchEntityException'), IAM_NOT_FOUND)).toBe(true);
    expect(isAwsNotFound(awsError('NoSuchEntity'), IAM_NOT_FOUND)).toBe(true);
    expect(isAwsNotFound(awsError('InvalidGroup.NotFound'), EC2_INSTANCE_NOT_FOUND)).toBe(false);
  });

  it('never treats a refusal as gone', () => {
    for (const code of ['DependencyViolation', 'AccessDenied', 'UnauthorizedOperation', 'DeleteConflict']) {
      expect(isAwsNotFound(awsError(code), [...EC2_INSTANCE_NOT_FOUND, ...EC2_GROUP_NOT_FOUND, ...IAM_NOT_FOUND])).toBe(false);
    }
  });
});

describe('env knobs', () => {
  it('default to 10 minutes between teardown attempts and a 5 minute sweep', () => {
    expect(teardownRetryAfterMs({})).toBe(600_000);
    expect(provisioningSweepIntervalMs({})).toBe(300_000);
  });

  it('take seconds from the environment', () => {
    expect(teardownRetryAfterMs({ BOX_TEARDOWN_RETRY_SECONDS: '20' })).toBe(20_000);
    expect(provisioningSweepIntervalMs({ BOX_PROVISIONING_SWEEP_SECONDS: '5' })).toBe(5_000);
  });

  it('ignore a value that is not a positive number', () => {
    for (const v of ['', '0', '-5', 'soon']) {
      expect(teardownRetryAfterMs({ BOX_TEARDOWN_RETRY_SECONDS: v })).toBe(600_000);
      expect(provisioningSweepIntervalMs({ BOX_PROVISIONING_SWEEP_SECONDS: v })).toBe(300_000);
    }
  });
});

describe('teardownCandidatesWhere', () => {
  it('selects uncleaned terminated ec2 rows past the window on both clocks', () => {
    const now = new Date('2026-10-06T12:00:00Z');
    const before = new Date('2026-10-06T11:50:00Z');
    expect(teardownCandidatesWhere(now, 10 * 60_000)).toEqual({
      kind: 'ec2',
      status: 'terminated',
      cleanedUpAt: null,
      AND: [
        { OR: [{ terminatedAt: null }, { terminatedAt: { lt: before } }] },
        { OR: [{ cleanupAttemptedAt: null }, { cleanupAttemptedAt: { lt: before } }] },
      ],
    });
  });
});
