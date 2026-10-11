import { describe, it, expect } from 'vitest';
import {
  describeOnWarmRun,
  onWarmRunUpdate,
  parseOnWarmReport,
  promotesToWarm,
} from './onWarmStatus';

// The shapes `deploy/termag-hook-run` writes to ~/.termag/on-warm.status.json,
// copied from the contract in its header.
const runningFile = {
  schema: 1,
  state: 'running',
  script: '10-setup.sh',
  exitCode: null,
  reason: null,
  startedAt: '2026-09-22T00:31:02Z',
  updatedAt: '2026-09-22T00:31:03Z',
  durations: [{ script: '00-noop.sh', seconds: 0, exitCode: 0 }],
  logTail: 'running 10-setup.sh\n',
};

const succeededFile = {
  schema: 1,
  state: 'succeeded',
  script: null,
  exitCode: null,
  reason: null,
  startedAt: '2026-09-22T00:31:02Z',
  updatedAt: '2026-09-22T00:51:47Z',
  durations: [
    { script: '00-noop.sh', seconds: 0, exitCode: 0 },
    { script: '10-setup.sh', seconds: 1245, exitCode: 0 },
  ],
  logTail: 'warm run succeeded\n',
};

const failedFile = {
  schema: 1,
  state: 'failed',
  script: '10-setup.sh',
  exitCode: 2,
  reason: 'script-failed',
  startedAt: '2026-09-22T00:31:02Z',
  updatedAt: '2026-09-22T00:33:19Z',
  durations: [
    { script: '00-noop.sh', seconds: 0, exitCode: 0 },
    { script: '10-setup.sh', seconds: 137, exitCode: 2 },
  ],
  logTail: 'failed: 10-setup.sh exited 2 after 137s\n',
};

describe('parseOnWarmReport', () => {
  it('reads a running report and the script in flight', () => {
    expect(parseOnWarmReport(runningFile)).toEqual({
      state: 'running',
      script: '10-setup.sh',
      durations: [{ script: '00-noop.sh', seconds: 0, exitCode: 0 }],
      logTail: 'running 10-setup.sh\n',
    });
  });

  it('reads a succeeded report and keeps no failure detail to mistake for a live script', () => {
    const report = parseOnWarmReport(succeededFile);
    expect(report).toEqual({
      state: 'succeeded',
      durations: [
        { script: '00-noop.sh', seconds: 0, exitCode: 0 },
        { script: '10-setup.sh', seconds: 1245, exitCode: 0 },
      ],
      logTail: 'warm run succeeded\n',
    });
    expect(Object.keys(report!).sort()).toEqual(['durations', 'logTail', 'state']);
  });

  it('reads a failed report with its reason and exit code', () => {
    expect(parseOnWarmReport(failedFile)).toEqual({
      state: 'failed',
      script: '10-setup.sh',
      exitCode: 2,
      reason: 'script-failed',
      durations: [
        { script: '00-noop.sh', seconds: 0, exitCode: 0 },
        { script: '10-setup.sh', seconds: 137, exitCode: 2 },
      ],
      logTail: 'failed: 10-setup.sh exited 2 after 137s\n',
    });
  });

  it('reads a file written by a newer runner, keeping the fields it knows', () => {
    expect(parseOnWarmReport({
      ...failedFile,
      schema: 7,
      reason: 'disk-full',
      phase: 'clone',
      durations: [{ script: '00-noop.sh', seconds: 0, exitCode: 0, memoryPeakMb: 91 }],
    })).toEqual({
      state: 'failed',
      script: '10-setup.sh',
      exitCode: 2,
      reason: 'disk-full',
      durations: [{ script: '00-noop.sh', seconds: 0, exitCode: 0 }],
      logTail: 'failed: 10-setup.sh exited 2 after 137s\n',
    });
  });

  it('rejects an unknown state', () => {
    expect(parseOnWarmReport({ ...runningFile, state: 'cancelled' })).toBe(null);
  });

  it('rejects a payload with no state at all', () => {
    expect(parseOnWarmReport({ schema: 1, logTail: 'something happened' })).toBe(null);
  });

  it('rejects payloads that are not status objects', () => {
    expect([
      parseOnWarmReport(null),
      parseOnWarmReport('succeeded'),
      parseOnWarmReport([{ state: 'succeeded' }]),
      parseOnWarmReport({ state: { name: 'succeeded' } }),
    ]).toEqual([null, null, null, null]);
  });

  it('drops duration entries that are not a script run', () => {
    expect(parseOnWarmReport({
      state: 'succeeded',
      durations: [
        { script: '00-noop.sh', seconds: 0, exitCode: 0 },
        { script: '10-half-written.sh', seconds: null, exitCode: 0 },
        'not-an-object',
        { seconds: 3, exitCode: 0 },
      ],
      logTail: '',
    })).toEqual({
      state: 'succeeded',
      durations: [{ script: '00-noop.sh', seconds: 0, exitCode: 0 }],
      logTail: '',
    });
  });

  it('flattens a reason that would otherwise forge a second log line', () => {
    expect(parseOnWarmReport({ ...failedFile, reason: 'runner-error\n[POOL] instance evil warm' })).toMatchObject({
      reason: 'runner-error [POOL] instance evil warm',
    });
  });

  it('defaults a missing log tail to the empty string', () => {
    expect(parseOnWarmReport({ state: 'running' })).toEqual({
      state: 'running',
      script: null,
      durations: [],
      logTail: '',
    });
  });
});

describe('onWarmRunUpdate', () => {
  it('writes the running state and its log tail, and only while the box is warming', () => {
    expect(onWarmRunUpdate('box-1', parseOnWarmReport(runningFile)!)).toEqual({
      where: { id: 'box-1', status: 'warming' },
      data: {
        onWarmStatus: 'running',
        onWarmLog: 'running 10-setup.sh\n',
      },
    });
  });

  it('writes the succeeded state without touching the row status', () => {
    // markWarmIfComplete owns the promotion, and its own where clause is what
    // authorises it.
    expect(onWarmRunUpdate('box-1', parseOnWarmReport(succeededFile)!)).toEqual({
      where: { id: 'box-1', status: 'warming' },
      data: {
        onWarmStatus: 'succeeded',
        onWarmLog: 'warm run succeeded\n',
      },
    });
  });

  // Leaving the row `warming` held an in-flight slot against the launch cap,
  // hid the failure from the breaker, and waited out the 45-minute sweep for a
  // run that had already reported why it stopped.
  it('fails the box when the run failed, recording the reason', () => {
    expect(onWarmRunUpdate('box-1', parseOnWarmReport(failedFile)!)).toEqual({
      where: { id: 'box-1', status: 'warming' },
      data: {
        onWarmStatus: 'failed',
        onWarmLog: 'failed: 10-setup.sh exited 2 after 137s\n',
        status: 'failed',
        provisioningError: 'on-warm script-failed at 10-setup.sh exit 2',
      },
    });
  });

  it('names a timeout as the reason rather than an exit code alone', () => {
    const report = parseOnWarmReport({
      ...failedFile, reason: 'timeout', exitCode: 124, script: '20-docker-images.sh',
    })!;
    expect(onWarmRunUpdate('box-1', report).data.provisioningError)
      .toBe('on-warm timeout at 20-docker-images.sh exit 124');
  });

  it('still records a failure a runner could not describe', () => {
    const report = parseOnWarmReport({
      ...failedFile, reason: null, exitCode: null, script: null,
    })!;
    expect(onWarmRunUpdate('box-1', report).data.provisioningError).toBe('on-warm failed');
  });

  it('keeps the last 4 KB of an oversized tail and drops the older head', () => {
    const tail = 'x'.repeat(4096);
    const update = onWarmRunUpdate('box-1', parseOnWarmReport({
      ...failedFile,
      logTail: `this head is older than the 4 KB the column holds${tail}`,
    })!);
    expect(update.data.onWarmLog).toBe(tail);
  });

  it('leaves a tail that already fits untouched', () => {
    const tail = 'y'.repeat(4096);
    expect(onWarmRunUpdate('box-1', parseOnWarmReport({ ...failedFile, logTail: tail })!).data.onWarmLog)
      .toBe(tail);
  });
});

describe('promotesToWarm', () => {
  it('promotes on a succeeded run', () => {
    expect(promotesToWarm(parseOnWarmReport(succeededFile)!)).toBe(true);
  });

  it('does not promote a run still in flight', () => {
    expect(promotesToWarm(parseOnWarmReport(runningFile)!)).toBe(false);
  });

  it('does not promote a failed run', () => {
    expect(promotesToWarm(parseOnWarmReport(failedFile)!)).toBe(false);
  });
});

describe('describeOnWarmRun', () => {
  it('names the script in flight and the ones already done', () => {
    expect(describeOnWarmRun(parseOnWarmReport(runningFile)!))
      .toBe('running 10-setup.sh [00-noop.sh 0s]');
  });

  it('reports every script duration on success', () => {
    expect(describeOnWarmRun(parseOnWarmReport(succeededFile)!))
      .toBe('succeeded [00-noop.sh 0s, 10-setup.sh 1245s]');
  });

  it('separates the reason from the script and its exit code on failure', () => {
    expect(describeOnWarmRun(parseOnWarmReport(failedFile)!))
      .toBe('failed script-failed at 10-setup.sh exit 2 [00-noop.sh 0s, 10-setup.sh 137s]');
  });

  it('reports a broken checkout, which fails before any script runs', () => {
    expect(describeOnWarmRun(parseOnWarmReport({
      state: 'failed',
      script: null,
      exitCode: null,
      reason: 'missing-scripts',
      durations: [],
      logTail: 'failed: no script directory at /home/termag/src/termag/deploy/on-warm.d',
    })!)).toBe('failed missing-scripts');
  });

  it('reports a failure whose reason a newer runner invented', () => {
    expect(describeOnWarmRun(parseOnWarmReport({ ...failedFile, reason: 'disk-full' })!))
      .toBe('failed disk-full at 10-setup.sh exit 2 [00-noop.sh 0s, 10-setup.sh 137s]');
  });

  it('reports a failure with no reason at all', () => {
    expect(describeOnWarmRun(parseOnWarmReport({ state: 'failed', exitCode: 124 })!))
      .toBe('failed unknown exit 124');
  });
});
