import { describe, expect, it } from 'vitest';
import { admitRun, type AdmitInput } from './admit';
import { DEFAULT_AUTOMATION_LIMITS } from './limits';

const ok: AdmitInput = {
  pausedReason: null, flagOn: true, previousLive: false, dailyMinutesUsed: 0, boxLiveRuns: 0,
  boxWake: 'wait', boxConnected: true, runnerCapable: true, wakeBox: false, limits: DEFAULT_AUTOMATION_LIMITS,
};

describe('admitRun', () => {
  it('starts when everything is in order', () => {
    expect(admitRun(ok)).toEqual({ kind: 'start' });
  });

  it('skips in the order the reasons are known', () => {
    expect(admitRun({ ...ok, pausedReason: 'box_gone', flagOn: false })).toEqual({ kind: 'skip', reason: 'paused' });
    expect(admitRun({ ...ok, flagOn: false, previousLive: true })).toEqual({ kind: 'skip', reason: 'flag_off' });
    expect(admitRun({ ...ok, previousLive: true })).toEqual({ kind: 'skip', reason: 'previous_running' });
    expect(admitRun({ ...ok, dailyMinutesUsed: 480 })).toEqual({ kind: 'skip', reason: 'budget' });
    expect(admitRun({ ...ok, boxLiveRuns: 2 })).toEqual({ kind: 'skip', reason: 'box_concurrent' });
    expect(admitRun({ ...ok, boxWake: 'gone', boxConnected: false })).toEqual({ kind: 'skip', reason: 'box_gone' });
  });

  it('waits for a box that is coming up, and wakes a parked one only when asked', () => {
    expect(admitRun({ ...ok, boxConnected: false, boxWake: 'wait' })).toEqual({ kind: 'pending', wake: false });
    expect(admitRun({ ...ok, boxConnected: false, boxWake: 'start' })).toEqual({ kind: 'skip', reason: 'box_unavailable' });
    expect(admitRun({ ...ok, boxConnected: false, boxWake: 'start', wakeBox: true })).toEqual({ kind: 'pending', wake: true });
  });

  it('refuses a connected box whose runner cannot run the tier', () => {
    expect(admitRun({ ...ok, runnerCapable: false })).toEqual({ kind: 'skip', reason: 'runner_outdated' });
  });
});
