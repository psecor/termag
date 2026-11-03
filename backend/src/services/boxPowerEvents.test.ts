import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./productEvents', () => ({ recordProductEvent: vi.fn() }));

const { recordProductEvent } = await import('./productEvents');
const { boxEventDimensions, minutesSince, recordBoxReady, resetSleepWatchesForTests, sleepOutcome } = await import('./boxPowerEvents');

beforeEach(() => {
  resetSleepWatchesForTests();
  vi.mocked(recordProductEvent).mockClear();
});

describe('boxEventDimensions', () => {
  it('reads the slicing fields off the row, and whether it came from the pool or another box', () => {
    expect(boxEventDimensions({
      kind: 'ec2', region: 'us-east-2', imageId: 'ami-1', imageSource: 'channel:beta', hibernationConfigured: false,
      claimedAt: new Date(), parentInstanceId: 'inst_parent',
    })).toEqual({ boxKind: 'ec2', region: 'us-east-2', imageId: 'ami-1', imageSource: 'channel:beta', hibernationConfigured: false, fromPool: true, child: true });
    expect(boxEventDimensions({ kind: 'external', region: null, imageId: null, imageSource: null, claimedAt: null, parentInstanceId: null }))
      .toMatchObject({ boxKind: 'external', region: null, fromPool: false, child: false });
  });

  it('leaves out what a partial row does not say, rather than guessing false', () => {
    expect(boxEventDimensions({})).toEqual({ boxKind: null, region: null, imageId: null, imageSource: null, hibernationConfigured: null, fromPool: null, child: null });
  });
});

describe('sleepOutcome', () => {
  it('names what a stop or hibernate settled to, a timeout back to ready as failed', () => {
    expect(sleepOutcome('stopping', 'stopped')).toBe('stopped');
    expect(sleepOutcome('hibernating', 'hibernated')).toBe('hibernated');
    expect(sleepOutcome('hibernating', 'stopped')).toBe('stopped');
    expect(sleepOutcome('stopping', 'ready')).toBe('failed');
  });

  it('is null for a start settling, and for no new status', () => {
    expect(sleepOutcome('starting', 'stopped')).toBeNull();
    expect(sleepOutcome('stopping', undefined)).toBeNull();
  });
});

describe('minutesSince', () => {
  it('rounds to whole minutes and drops a missing instant or a clock that went backwards', () => {
    const now = Date.UTC(2026, 9, 26, 12, 0, 0);
    expect(minutesSince(new Date(now - 90 * 60_000 - 20_000), now)).toBe(90);
    expect(minutesSince(null, now)).toBeNull();
    expect(minutesSince(new Date(now + 1), now)).toBeNull();
  });
});

describe('box.ready', () => {
  it('records the seconds from the row to the first connect, with the dimensions', () => {
    const createdAt = new Date(Date.UTC(2026, 9, 26, 12, 0, 0));
    recordBoxReady({ id: 'inst_1', userId: 'u1', createdAt, kind: 'ec2', claimedAt: null }, new Date(createdAt.getTime() + 245_600));
    expect(recordProductEvent).toHaveBeenCalledWith('box.ready', { user: 'u1', box: 'inst_1' }, expect.objectContaining({ provisionSec: 246, boxKind: 'ec2', fromPool: false }));
  });

  it('never throws over a row without its creation time', () => {
    expect(() => recordBoxReady({ id: 'inst_1', userId: 'u1' } as any, new Date())).not.toThrow();
    expect(vi.mocked(recordProductEvent).mock.calls[0][2]).toMatchObject({ provisionSec: null });
  });
});
