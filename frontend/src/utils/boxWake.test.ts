import { describe, expect, it, vi } from 'vitest';
import type { Instance, InstanceStatus } from '../types';
import { WAKE_BOX_DEADLINE_MS, WAKE_BOX_POLL_MS, wakeBox, wakeNote, wakeStep } from './boxWake';

const box = (status: InstanceStatus, over: Partial<Instance> = {}): Instance =>
  ({ id: 'box-1', name: 'dev01', kind: 'ec2', status, createdAt: '2026-10-01T00:00:00.000Z', ...over });

/** A clock the fake sleep advances, so the loop runs without timers. */
function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (_ms: number) => { t += WAKE_BOX_POLL_MS; },
  };
}

/** An `instancesApi.get` that answers each status in turn, then keeps answering the last. */
function scripted(...statuses: InstanceStatus[]) {
  let i = 0;
  return vi.fn(async (id: string) => box(statuses[Math.min(i++, statuses.length - 1)], { id }));
}

describe('wakeStep', () => {
  it('goes ahead on a ready box and starts one that is down', () => {
    expect(wakeStep('ready')).toBe('ready');
    expect(wakeStep('stopped')).toBe('start');
    expect(wakeStep('hibernated')).toBe('start');
  });

  it('waits out a box already on its way, down or up', () => {
    for (const s of ['starting', 'stopping', 'hibernating', 'provisioning', 'awaiting-agent', 'warming', 'warm'] as const) {
      expect(wakeStep(s)).toBe('wait');
    }
  });

  it('gives up on a box no start will help', () => {
    for (const s of ['failed', 'terminated'] as const) expect(wakeStep(s)).toBe('unavailable');
    expect(wakeStep(null)).toBe('unavailable');
    expect(wakeStep(undefined)).toBe('unavailable');
  });
});

describe('wakeNote', () => {
  it('says what is happening to the box, by name', () => {
    expect(wakeNote('dev01', 'stopped')).toMatch(/^Starting dev01/);
    expect(wakeNote('dev01', 'hibernated')).toMatch(/^Resuming dev01 from hibernation/);
    expect(wakeNote('dev01', 'starting')).toMatch(/^dev01 is starting/);
    expect(wakeNote('dev01', 'stopping')).toMatch(/^dev01 is stopping/);
    expect(wakeNote('dev01', 'provisioning')).toMatch(/^Waiting for dev01/);
  });
});

describe('wakeBox', () => {
  it('does nothing to a ready box and never calls start', async () => {
    const start = vi.fn(async () => ({}));
    const get = scripted('ready');
    const result = await wakeBox(box('ready'), { get, start, ...clock() });
    expect(result).toEqual({ ok: true, box: box('ready') });
    expect(start).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('starts a stopped box once and waits for the agent connect to say ready', async () => {
    const start = vi.fn(async () => ({ ok: true, status: 'starting' }));
    const get = scripted('starting', 'starting', 'ready');
    const seen: InstanceStatus[] = [];
    const result = await wakeBox(box('stopped'), { get, start, onWait: b => seen.push(b.status), ...clock() });
    expect(result.ok).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith('box-1');
    expect(seen).toEqual(['stopped', 'starting', 'starting']);
  });

  it('resumes a hibernated box', async () => {
    const start = vi.fn(async () => ({ ok: true, status: 'starting' }));
    const result = await wakeBox(box('hibernated'), { get: scripted('starting', 'ready'), start, ...clock() });
    expect(result.ok).toBe(true);
    expect(start).toHaveBeenCalledWith('box-1');
  });

  it('waits out a stopping box, then starts it when it settles', async () => {
    const start = vi.fn(async () => ({ ok: true, status: 'starting' }));
    const get = scripted('stopping', 'stopped', 'starting', 'ready');
    const result = await wakeBox(box('stopping'), { get, start, ...clock() });
    expect(result.ok).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('starts a box that is stopped again after it began to come up', async () => {
    const start = vi.fn(async () => ({ ok: true, status: 'starting' }));
    const get = scripted('starting', 'stopped', 'starting', 'ready');
    const result = await wakeBox(box('stopped'), { get, start, ...clock() });
    expect(result.ok).toBe(true);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('gives up on a failed box without asking EC2 to start it', async () => {
    const start = vi.fn(async () => ({}));
    const result = await wakeBox(box('failed'), { get: scripted('failed'), start, ...clock() });
    expect(result).toEqual({ ok: false, error: 'dev01 is failed; a workstream cannot be made on it.' });
    expect(start).not.toHaveBeenCalled();
  });

  it('times out with the status it last saw when the agent never connects', async () => {
    const start = vi.fn(async () => ({ ok: true, status: 'starting' }));
    const result = await wakeBox(box('stopped'), {
      get: scripted('starting'), start, deadlineMs: WAKE_BOX_POLL_MS * 3, ...clock(),
    });
    expect(result).toEqual({
      ok: false,
      error: 'dev01 did not come up in time (still starting). Try again once it is ready.',
    });
  });

  it('waits up to the default deadline', async () => {
    let t = 0;
    const result = await wakeBox(box('starting'), {
      get: async () => box('starting'),
      start: async () => ({}),
      now: () => t,
      sleep: async (ms: number) => { t += ms; },
    });
    expect(result.ok).toBe(false);
    expect(t).toBe(WAKE_BOX_DEADLINE_MS);
  });

  it('lets a start the backend refuses reject with its error', async () => {
    const start = vi.fn(async () => { throw Object.assign(new Error('no'), { response: { data: { error: 'Box provisioning is not configured on this orchestrator' } } }); });
    await expect(wakeBox(box('stopped'), { get: scripted('stopped'), start, ...clock() }))
      .rejects.toThrow('no');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('keeps polling when a read fails mid-wait', async () => {
    const start = vi.fn(async () => ({ ok: true, status: 'starting' }));
    const get = vi.fn()
      .mockResolvedValueOnce(box('starting'))
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValueOnce(box('ready'));
    const result = await wakeBox(box('stopped'), { get, start, ...clock() });
    expect(result.ok).toBe(true);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('gives up at the deadline when every read after the start fails', async () => {
    const start = vi.fn(async () => ({ ok: true, status: 'starting' }));
    const get = vi.fn(async () => { throw new Error('502'); });
    const result = await wakeBox(box('stopped'), { get, start, deadlineMs: WAKE_BOX_POLL_MS * 2, ...clock() });
    expect(result.ok).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('waits when another tab started the box between the read and the start', async () => {
    const start = vi.fn(async () => { throw Object.assign(new Error('conflict'), { response: { data: { error: "Can't start a box that is starting" } } }); });
    const get = vi.fn()
      .mockResolvedValueOnce(box('starting'))
      .mockResolvedValueOnce(box('ready'));
    const result = await wakeBox(box('stopped'), { get, start, ...clock() });
    expect(result).toEqual({ ok: true, box: box('ready') });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('returns at once when the refused start finds the box already up', async () => {
    const start = vi.fn(async () => { throw Object.assign(new Error('conflict'), { response: { data: { error: "Can't start a box that is ready" } } }); });
    const result = await wakeBox(box('stopped'), { get: vi.fn(async () => box('ready')), start, ...clock() });
    expect(result).toEqual({ ok: true, box: box('ready') });
  });

  it('rethrows a start the box refused, rather than waiting out the deadline', async () => {
    const refused = new Error('Box provisioning is not configured on this orchestrator');
    const start = vi.fn(async () => { throw refused; });
    await expect(wakeBox(box('stopped'), { get: vi.fn(async () => box('stopped')), start, ...clock() }))
      .rejects.toBe(refused);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('rethrows a refused start when the box cannot be read either', async () => {
    const refused = new Error('EC2 refused the start');
    const get = vi.fn(async () => { throw new Error('502'); });
    await expect(wakeBox(box('stopped'), { get, start: vi.fn(async () => { throw refused; }), ...clock() }))
      .rejects.toBe(refused);
  });

  it('ends the wake when a read says the box is gone', async () => {
    const gone = Object.assign(new Error('Box not found'), { response: { status: 404, data: { error: 'Box not found' } } });
    const start = vi.fn(async () => ({ ok: true, status: 'starting' }));
    const get = vi.fn()
      .mockResolvedValueOnce(box('starting'))
      .mockRejectedValueOnce(gone);
    await expect(wakeBox(box('stopped'), { get, start, ...clock() })).rejects.toBe(gone);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('throws the read\'s 404 when the box is gone before the start can be checked', async () => {
    const gone = Object.assign(new Error('Box not found'), { response: { status: 404 } });
    await expect(wakeBox(box('stopped'), {
      get: vi.fn(async () => { throw gone; }),
      start: vi.fn(async () => { throw new Error('conflict'); }),
      ...clock(),
    })).rejects.toBe(gone);
  });
});
