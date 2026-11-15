import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionBoxWakes, WAKE_ERROR_KEEP_MS, WAKE_WAIT_MS, type WakeAnswer } from './sessionBoxWake';

/** A New session's box woken once: asleep now, on its way down once it's down, starting never twice. */

let now = 0;
let status: string | null = 'stopped';
const wake = vi.fn(async (): Promise<WakeAnswer> => ({ status: 202, body: { ok: true, status: 'starting' } }));
const redispatch = vi.fn(async () => {});
let wakes: SessionBoxWakes;

beforeEach(() => {
  now = 1_000;
  status = 'stopped';
  wake.mockReset();
  wake.mockImplementation(async () => { status = 'starting'; return { status: 202, body: { ok: true, status: 'starting' } }; });
  redispatch.mockClear();
  wakes = new SessionBoxWakes({ boxStatus: async () => status, wake, redispatch, now: () => now }, 0);
});

describe('SessionBoxWakes', () => {
  it('starts an asleep box at once, through the owner-only start', async () => {
    expect(await wakes.wakeFor('u1', 'b1', 'dev', 'stopped')).toEqual({ state: 'waking' });
    expect(wake).toHaveBeenCalledWith('u1', 'b1');
    expect(wakes.errorFor('b1')).toBeNull();
    status = 'hibernated';
    expect(await wakes.wakeFor('u1', 'b1', 'dev', 'hibernated')).toEqual({ state: 'waking' });
  });

  it('never starts a box already starting, or one up', async () => {
    expect(await wakes.wakeFor('u1', 'b1', 'dev', 'starting')).toEqual({ state: 'none' });
    expect(await wakes.wakeFor('u1', 'b1', 'dev', 'ready')).toEqual({ state: 'none' });
    expect(wake).not.toHaveBeenCalled();
  });

  it("keeps a refused start's reason for the session, for a while", async () => {
    wake.mockImplementation(async () => ({ status: 502, body: { error: 'EC2 refused the start: InsufficientInstanceCapacity.' } }));
    const r = await wakes.wakeFor('u1', 'b1', 'dev', 'stopped');
    expect(r).toEqual({ state: 'failed', error: "Couldn't wake dev: EC2 refused the start: InsufficientInstanceCapacity" });
    expect(wakes.errorFor('b1')).toBe(r.error);
    now += WAKE_ERROR_KEEP_MS + 1;
    expect(wakes.errorFor('b1')).toBeNull();
  });

  it('drops an earlier failure once the box is coming up, however it got there', async () => {
    wake.mockImplementationOnce(async () => ({ status: 502, body: { error: 'EC2 said no' } }));
    await wakes.wakeFor('u1', 'b1', 'dev', 'stopped');
    expect(wakes.errorFor('b1')).toBe("Couldn't wake dev: EC2 said no");
    status = 'starting';
    expect(await wakes.wakeFor('u1', 'b1', 'dev', 'starting')).toEqual({ state: 'none' });
    expect(wakes.errorFor('b1')).toBeNull();
  });

  it('fails a refused start on a box that is gone or held, never as waking', async () => {
    for (const end of ['terminated', 'failed', 'quarantined']) {
      wake.mockImplementationOnce(async () => { status = end; return { status: 409, body: { error: `Can't start a box that is ${end}` } }; });
      status = 'stopped';
      const r = await wakes.wakeFor('u1', 'b1', 'dev', 'stopped');
      expect(r.state).toBe('failed');
    }
  });

  it('takes a start another beat it to as waking, not a failure', async () => {
    wake.mockImplementation(async () => { status = 'starting'; return { status: 409, body: { error: "Can't start a box that is starting" } }; });
    expect(await wakes.wakeFor('u1', 'b1', 'dev', 'stopped')).toEqual({ state: 'waking' });
    expect(wakes.errorFor('b1')).toBeNull();
  });

  it('holds a box on its way down and starts it once, when it is down', async () => {
    status = 'stopping';
    expect(await wakes.wakeFor('u1', 'b1', 'dev', 'stopping')).toEqual({ state: 'held' });
    // A second session on the same box shares the one wake.
    expect(await wakes.wakeFor('u1', 'b1', 'dev', 'stopping')).toEqual({ state: 'held' });
    await wakes.sweep();
    expect(wake).not.toHaveBeenCalled();
    expect(wakes.isHeld('b1')).toBe(true);
    status = 'stopped';
    await wakes.sweep();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wakes.isHeld('b1')).toBe(false);
    await wakes.sweep();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('runs the held checkouts when the box comes back up without sleeping (its stop timed out)', async () => {
    status = 'stopping';
    await wakes.wakeFor('u1', 'b1', 'dev', 'stopping');
    status = 'ready';
    await wakes.sweep();
    expect(redispatch).toHaveBeenCalledWith('u1', 'b1');
    expect(wake).not.toHaveBeenCalled();
    expect(wakes.isHeld('b1')).toBe(false);
  });

  it('lets go of a held box that came up some other way, or is gone, or took too long', async () => {
    status = 'hibernating';
    await wakes.wakeFor('u1', 'b1', 'dev', 'hibernating');
    status = 'starting';
    await wakes.sweep();
    expect(wakes.isHeld('b1')).toBe(false);
    expect(wake).not.toHaveBeenCalled();

    status = 'stopping';
    await wakes.wakeFor('u1', 'b1', 'dev', 'stopping');
    status = 'terminated';
    await wakes.sweep();
    expect(wakes.errorFor('b1')).toBe("Couldn't wake dev: it is terminated");

    status = 'stopping';
    await wakes.wakeFor('u1', 'b2', 'docs', 'stopping');
    now += WAKE_WAIT_MS + 1;
    await wakes.sweep();
    expect(wakes.isHeld('b2')).toBe(false);
    expect(wakes.errorFor('b2')).toBe("Couldn't wake docs: it took too long to go to sleep");
  });
});
