import { describe, expect, it, vi } from 'vitest';
import { FAILED_KEEP_MS, HeldReviewStarts, WAKE_WAIT_MS, type StartAnswer } from './reviewHeld';

function store(statuses: Array<string | null>) {
  const seq = [...statuses];
  let now = 0;
  const held = new HeldReviewStarts({ boxStatus: async () => (seq.length > 1 ? seq.shift()! : seq[0]), now: () => now }, 0);
  return { held, tick: (ms: number) => { now += ms; } };
}
const req = (over: Partial<{ woken: boolean; replay: () => Promise<StartAnswer>; wake: () => Promise<StartAnswer> }> = {}) => ({
  projectId: 'p', workstream: 'main', instanceId: 'i', box: 'termag-20', pr: 1, reviewer: 'devin', woken: true,
  replay: vi.fn(async () => ({ status: 201, body: {} })), wake: vi.fn(async () => ({ status: 202, body: {} })), ...over,
});

describe('HeldReviewStarts', () => {
  it('runs a held start once its box is ready, and forgets it', async () => {
    const { held } = store(['starting', 'ready']);
    const r = req();
    held.hold(r);
    await held.sweep();
    expect(r.replay).not.toHaveBeenCalled();
    expect(held.get('p', 'main')).toMatchObject({ state: 'waking' });
    await held.sweep();
    expect(r.replay).toHaveBeenCalledTimes(1);
    expect(held.get('p', 'main')).toBeNull();
  });

  it('wakes a box that was on its way down once it is down', async () => {
    const { held } = store(['stopping', 'stopped', 'starting', 'ready']);
    const r = req({ woken: false });
    held.hold(r);
    await held.sweep();
    expect(r.wake).not.toHaveBeenCalled();
    await held.sweep();
    expect(r.wake).toHaveBeenCalledTimes(1);
    await held.sweep();
    await held.sweep();
    expect(r.wake).toHaveBeenCalledTimes(1);
    expect(r.replay).toHaveBeenCalledTimes(1);
  });

  it('tries again while a ready box\'s agent reconnects', async () => {
    const { held } = store(['ready']);
    const replay = vi.fn<() => Promise<StartAnswer>>()
      .mockResolvedValueOnce({ status: 503, body: { error: "Owner's agent is offline" } })
      .mockResolvedValueOnce({ status: 201, body: {} });
    held.hold(req({ replay }));
    await held.sweep();
    expect(held.get('p', 'main')).toMatchObject({ state: 'waking' });
    await held.sweep();
    expect(held.get('p', 'main')).toBeNull();
  });

  it('never runs again a start that failed after it may have launched the reviewer', async () => {
    const { held } = store(['ready']);
    const replay = vi.fn(async () => ({ status: 503, body: { error: 'Could not start the review: tmux-send-keys timed out' } }));
    held.hold(req({ replay }));
    await held.sweep();
    await held.sweep();
    expect(replay).toHaveBeenCalledTimes(1);
    expect(held.get('p', 'main')).toMatchObject({ state: 'failed', error: 'Could not start the review: tmux-send-keys timed out' });
  });

  it('keeps a refused start\'s reason, then lets it go', async () => {
    const { held, tick } = store(['ready']);
    held.hold(req({ replay: async () => ({ status: 409, body: { error: 'All 8 review panes in this workstream are in use: stop or close one.' } }) }));
    await held.sweep();
    expect(held.get('p', 'main')).toMatchObject({ state: 'failed', error: 'All 8 review panes in this workstream are in use: stop or close one.' });
    tick(FAILED_KEEP_MS + 1);
    await held.sweep();
    expect(held.get('p', 'main')).toBeNull();
  });

  it('fails, saying what to do, when the box never comes up or is gone', async () => {
    const slow = store(['starting']);
    slow.held.hold(req());
    slow.tick(WAKE_WAIT_MS + 1);
    await slow.held.sweep();
    expect(slow.held.get('p', 'main')?.error).toBe('termag-20 took too long to wake. Start termag-20 from your boxes, then Review again.');

    const gone = store([null]);
    gone.held.hold(req());
    await gone.held.sweep();
    expect(gone.held.get('p', 'main')?.error).toBe("termag-20 is gone: start a New session on the PR's repository, then Review again.");
  });

  it('keeps waiting when another start beat its wake to the box', async () => {
    const { held } = store(['stopped', 'starting', 'starting']);
    held.hold(req({ woken: false, wake: async () => ({ status: 409, body: { error: "Can't start a box that is starting" } }) }));
    await held.sweep();
    expect(held.get('p', 'main')).toMatchObject({ state: 'waking' });
  });

  it('wakes the box itself when the start that beat it failed and the box went back to sleep', async () => {
    const { held } = store(['starting', 'stopped', 'starting', 'ready']);
    const wake = vi.fn(async () => ({ status: 202, body: {} }));
    // Held after another start beat this one to the box: not woken by it.
    const r = { ...req({ woken: false, wake }), beaten: true };
    held.hold(r);
    await held.sweep();
    expect(wake).not.toHaveBeenCalled();
    await held.sweep();
    expect(wake).toHaveBeenCalledTimes(1);
    await held.sweep();
    await held.sweep();
    expect(r.replay).toHaveBeenCalledTimes(1);
  });

  it('leaves a box asleep that its owner stopped while another start was waking it', async () => {
    const { held } = store(['starting', 'stopping', 'stopped']);
    const wake = vi.fn(async () => ({ status: 202, body: {} }));
    held.hold({ ...req({ woken: false, wake }), beaten: true });
    await held.sweep();
    await held.sweep();
    await held.sweep();
    expect(wake).not.toHaveBeenCalled();
    expect(held.get('p', 'main')?.error).toBe("termag-20 was stopped while it was starting, so the review didn't start. Start termag-20 from your boxes, then Review again.");
  });

  it('waits out the hibernation refresh, then wakes the box once it\'s back down', async () => {
    // Beaten to the box by the refresh's start; the refresh's stop isn't anyone stopping it.
    // The refresh clears rehibernatePending as it asks for its stop: the stop reads as a plain `stopping`.
    const { held } = store(['refreshing', 'refreshing', 'stopping', 'stopped', 'starting', 'ready']);
    const wake = vi.fn(async () => ({ status: 202, body: {} }));
    const r = { ...req({ woken: false, wake }), beaten: true };
    held.hold(r);
    for (let i = 0; i < 6; i++) await held.sweep();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(r.replay).toHaveBeenCalledTimes(1);
    expect(held.get('p', 'main')).toBeNull();
  });

  it('says why a wake the start path refuses failed', async () => {
    const { held } = store(['stopped']);
    held.hold(req({ woken: false, wake: async () => ({ status: 409, body: { error: 'This box is being terminated automatically' } }) }));
    await held.sweep();
    expect(held.get('p', 'main')?.error).toBe("Couldn't wake termag-20: This box is being terminated automatically. Start termag-20 from your boxes, then Review again.");
  });

  it('holds one start per workstream: a second replaces the first', async () => {
    const { held } = store(['starting']);
    held.hold(req({ pr: 1 } as never));
    held.hold({ ...req(), pr: 2 });
    expect(held.get('p', 'main')?.pr).toBe(2);
  });
});
