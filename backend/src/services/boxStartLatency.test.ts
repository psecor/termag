import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./productEvents', () => ({ recordProductEvent: vi.fn() }));

const { recordProductEvent } = await import('./productEvents');
const {
  armBoxStart, boxStartWatchForTests, recordBoxStartFailed, recordBoxStartReady, recordBoxStartStillStarting,
  resetBoxStartsForTests, resumeFromStatus, startLatency,
} = await import('./boxStartLatency');

const at = Date.UTC(2026, 9, 26, 15, 50, 0); // 15:50 UTC
const box = (status: string) => ({
  id: 'inst_1', status, userId: 'u1', kind: 'ec2', region: 'us-east-1', imageId: 'ami-1', imageSource: 'published',
  hibernationConfigured: true, claimedAt: null, parentInstanceId: null,
});
/** What every box.resumed from `box` carries to slice by. */
const DIMS = { boxKind: 'ec2', region: 'us-east-1', imageId: 'ami-1', imageSource: 'published', hibernationConfigured: true, fromPool: false, child: false };

beforeEach(() => {
  resetBoxStartsForTests();
  vi.mocked(recordProductEvent).mockClear();
});

describe('startLatency', () => {
  it('counts whole seconds from the request to the observation', () => {
    expect(startLatency(at, at)).toEqual({ durationSec: 0, hourUtc: 15 });
    expect(startLatency(at, at + 499)).toEqual({ durationSec: 0, hourUtc: 15 });
    expect(startLatency(at, at + 500)).toEqual({ durationSec: 1, hourUtc: 15 });
    expect(startLatency(at, at + 90_000)).toEqual({ durationSec: 90, hourUtc: 15 });
    expect(startLatency(at, at + 15 * 60 * 1000)).toEqual({ durationSec: 900, hourUtc: 15 });
  });

  it('keeps the request hour when the outcome is in the next hour', () => {
    const late = Date.UTC(2026, 9, 26, 23, 50, 0);
    const afterMidnight = Date.UTC(2026, 9, 27, 0, 10, 0);
    expect(startLatency(late, afterMidnight)).toEqual({ durationSec: 20 * 60, hourUtc: 23 });
  });

  it('rounds a partial second and ignores which status the box resumes from', () => {
    expect(startLatency(at, at + 22_600)).toEqual({ durationSec: 23, hourUtc: 15 });
    expect(resumeFromStatus('stopped')).toBe('stop');
    expect(resumeFromStatus('hibernated')).toBe('hibernate');
    expect(resumeFromStatus('ready')).toBeNull();
  });

  it('drops a sample whose clock went backwards or is not a time', () => {
    expect(startLatency(at, at - 1)).toBeNull();
    expect(startLatency(Number.NaN, at)).toBeNull();
    expect(startLatency(at, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('box.resumed', () => {
  it('records a hibernate resume when the box is ready, from the request', () => {
    armBoxStart(box('hibernated'), 'user', at);
    recordBoxStartReady('inst_1', at + 90_400);
    expect(recordProductEvent).toHaveBeenCalledTimes(1);
    expect(recordProductEvent).toHaveBeenCalledWith('box.resumed', { user: 'u1', box: 'inst_1' }, {
      from: 'hibernate', outcome: 'ready', durationSec: 90, hourUtc: 15, source: 'user', by: null, afterAutoPark: false, parkedMinutes: null, downMinutes: null, ...DIMS,
    });
    recordBoxStartReady('inst_1', at + 100_000);
    expect(recordProductEvent).toHaveBeenCalledTimes(1);
  });

  it('records a failed stop-resume from the sweep on its own', () => {
    armBoxStart(box('stopped'), 'sweep', at);
    recordBoxStartFailed('inst_1', at + 60_000);
    expect(recordProductEvent).toHaveBeenCalledWith('box.resumed', { user: 'u1', box: 'inst_1' }, {
      from: 'stop', outcome: 'failed', durationSec: 60, hourUtc: 15, source: 'sweep', by: null, afterAutoPark: false, parkedMinutes: null, downMinutes: null, ...DIMS,
    });
    expect(boxStartWatchForTests('inst_1')).toBeUndefined();
  });

  it('records still-starting once, then ready from the same request', () => {
    armBoxStart(box('stopped'), 'user', at);
    recordBoxStartStillStarting('inst_1', at + 15 * 60 * 1000);
    recordBoxStartStillStarting('inst_1', at + 16 * 60 * 1000);
    recordBoxStartReady('inst_1', at + 16 * 60 * 1000);
    expect(vi.mocked(recordProductEvent).mock.calls.map(call => call[2])).toEqual([
      { from: 'stop', outcome: 'still-starting', durationSec: 900, hourUtc: 15, source: 'user', by: null, afterAutoPark: false, parkedMinutes: null, downMinutes: null, ...DIMS },
      { from: 'stop', outcome: 'ready', durationSec: 960, hourUtc: 15, source: 'user', by: null, afterAutoPark: false, parkedMinutes: null, downMinutes: null, ...DIMS },
    ]);
  });

  it('says who the start was for, and how long after the lifecycle sweep parked the box', () => {
    armBoxStart({ ...box('stopped'), autoParkedAt: new Date(at - 90 * 60_000) }, 'user', at, 'owner');
    recordBoxStartReady('inst_1', at + 15_000);
    expect(vi.mocked(recordProductEvent).mock.calls.map(call => call[2])).toEqual([
      { from: 'stop', outcome: 'ready', durationSec: 15, hourUtc: 15, source: 'user', by: 'owner', afterAutoPark: true, parkedMinutes: 90, downMinutes: null, ...DIMS },
    ]);
  });

  it('says how long the box was down: since its stop or hibernate settled, else since it last hibernated', () => {
    armBoxStart({ ...box('stopped'), downSince: new Date(at - 125 * 60_000) }, 'user', at, 'owner');
    expect(boxStartWatchForTests('inst_1')!.downMinutes).toBe(125);
    // A box hibernated before downSince was recorded falls back to hibernatedAt.
    armBoxStart({ ...box('hibernated'), downSince: null, hibernatedAt: new Date(at - 3 * 24 * 60 * 60_000) }, 'user', at);
    expect(boxStartWatchForTests('inst_1')!.downMinutes).toBe(3 * 24 * 60);
    // A stopped box has no such fallback: hibernatedAt is a hibernate's, cleared by the stop.
    armBoxStart({ ...box('stopped'), downSince: null, hibernatedAt: new Date(at - 60_000) }, 'user', at);
    expect(boxStartWatchForTests('inst_1')!.downMinutes).toBeNull();
    // A clock that went backwards is no sample.
    armBoxStart({ ...box('stopped'), downSince: new Date(at + 60_000) }, 'user', at);
    expect(boxStartWatchForTests('inst_1')!.downMinutes).toBeNull();
    recordBoxStartReady('inst_1', at + 1_000);
    expect(vi.mocked(recordProductEvent).mock.calls[0][2]).toMatchObject({ downMinutes: null });
  });

  it('does not arm a start that was not from stopped or hibernated', () => {
    armBoxStart(box('ready'), 'user', at);
    recordBoxStartReady('inst_1', at + 1_000);
    expect(recordProductEvent).not.toHaveBeenCalled();
  });
});
