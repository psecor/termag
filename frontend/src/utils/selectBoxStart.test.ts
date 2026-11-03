import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, InstanceStatus } from '../types';
import { BoxStatusBus } from './boxStatusBus';
import { SelectBoxStarter, selectStartDecision, startErrorKind } from './selectBoxStart';

const box = (status: InstanceStatus, over: Partial<Instance> = {}) =>
  ({ id: 'box-1', name: 'box-1', kind: 'ec2', ec2InstanceId: 'i-1', status, ...over }) as Instance;

const none = { inFlight: new Set<string>(), refused: new Map<string, InstanceStatus>() };

describe('selectStartDecision', () => {
  it('starts a stopped or a hibernated box', () => {
    expect(selectStartDecision(box('stopped'), none)).toBe('start');
    expect(selectStartDecision(box('hibernated'), none)).toBe('start');
  });

  it('leaves a box that is up, coming up or going down', () => {
    for (const s of ['ready', 'starting', 'stopping', 'hibernating', 'provisioning', 'awaiting-agent', 'failed'] as InstanceStatus[]) {
      expect(selectStartDecision(box(s), none), s).toBe('not-parked');
    }
  });

  it('leaves an external box, and one with no EC2 instance yet', () => {
    expect(selectStartDecision(box('stopped', { kind: 'external' }), none)).toBe('not-parked');
    expect(selectStartDecision(box('stopped', { ec2InstanceId: null }), none)).toBe('not-parked');
  });

  it('asks nothing for a project with no box in the caller\'s list (local, or someone else\'s box)', () => {
    expect(selectStartDecision(undefined, none)).toBe('no-box');
  });

  it('sends no second start while one is out', () => {
    expect(selectStartDecision(box('stopped'), { ...none, inFlight: new Set(['box-1']) })).toBe('in-flight');
  });

  it('does not retry a refused start until the box status changes', () => {
    const refused = new Map<string, InstanceStatus>([['box-1', 'stopped']]);
    expect(selectStartDecision(box('stopped'), { ...none, refused })).toBe('refused');
    expect(selectStartDecision(box('hibernated'), { ...none, refused })).toBe('start');
  });
});

describe('SelectBoxStarter', () => {
  function setup(start: (id: string) => Promise<unknown> = async () => ({ ok: true, status: 'starting' })) {
    const bus = new BoxStatusBus();
    const startBox = vi.fn(start);
    const reload = vi.fn(async () => {});
    return { bus, startBox, reload, starter: new SelectBoxStarter(startBox, reload, bus) };
  }

  it('starts a parked box once and reloads the box list', async () => {
    const { starter, startBox, reload } = setup();
    expect(await starter.open(box('stopped'))).toBe('start');
    expect(startBox).toHaveBeenCalledWith('box-1');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for a box that is already starting or ready', async () => {
    const { starter, startBox } = setup();
    expect(await starter.open(box('starting'))).toBe('not-parked');
    expect(await starter.open(box('ready'))).toBe('not-parked');
    expect(startBox).not.toHaveBeenCalled();
  });

  it('sends one start when two projects on one parked box are opened back to back', async () => {
    let answer!: () => void;
    const { starter, startBox } = setup(() => new Promise<void>(r => { answer = r; }));
    // Both opens read the list before the start answered: it still says stopped.
    const first = starter.open(box('stopped'));
    const second = starter.open(box('stopped'));
    expect(await second).toBe('in-flight');
    answer();
    expect(await first).toBe('start');
    expect(startBox).toHaveBeenCalledTimes(1);
  });

  it('keeps the box in flight until the list has reloaded after the start', async () => {
    let reloaded!: () => void;
    const bus = new BoxStatusBus();
    const startBox = vi.fn(async () => ({}));
    const starter = new SelectBoxStarter(startBox, () => new Promise<void>(r => { reloaded = r; }), bus);
    const first = starter.open(box('stopped'));
    await vi.waitFor(() => expect(reloaded).toBeTypeOf('function'));
    expect(await starter.open(box('stopped'))).toBe('in-flight');
    reloaded();
    await first;
    expect(startBox).toHaveBeenCalledTimes(1);
  });

  it('does not retry a refused start (another owner\'s box, a 409) until the box status changes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { starter, startBox, reload, bus } = setup(async () => {
      throw { response: { status: 404, data: { error: 'Box not found' } } };
    });
    expect(await starter.open(box('stopped'))).toBe('refused');
    expect(await starter.open(box('stopped'))).toBe('refused');
    expect(startBox).toHaveBeenCalledTimes(1);
    // The list is reloaded once after the refusal, so a list that was behind catches up.
    expect(reload).toHaveBeenCalledTimes(1);
    // Started by hand, then stopped again: the next open may start it.
    bus.publish([box('stopped')]);
    bus.publish([box('starting')]);
    expect(await starter.open(box('stopped'))).toBe('refused');
    expect(startBox).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('lets a later open retry a start that got no answer from the route', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail: unknown = new Error('Network Error');
    const { starter, startBox } = setup(async () => { if (fail) throw fail; return {}; });
    expect(await starter.open(box('stopped'))).toBe('failed');
    fail = { response: { status: 502, data: { error: 'EC2 refused the start: throttled' } } };
    expect(await starter.open(box('stopped'))).toBe('failed');
    fail = null;
    expect(await starter.open(box('stopped'))).toBe('start');
    expect(startBox).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe('SelectBoxStarter waits', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('lets a start that never answers go after the wait, so a later open can try again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const startBox = vi.fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({ ok: true, status: 'starting' });
    const starter = new SelectBoxStarter(startBox, async () => {}, new BoxStatusBus(), 1000);
    const first = starter.open(box('stopped'));
    expect(await starter.open(box('stopped'))).toBe('in-flight');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toBe('failed');
    expect(await starter.open(box('stopped'))).toBe('start');
    expect(startBox).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('lets the box go when the reload after a start never answers, or throws', async () => {
    const startBox = vi.fn(async () => ({}));
    const hung = new SelectBoxStarter(startBox, () => new Promise<void>(() => {}), new BoxStatusBus(), 1000);
    const first = hung.open(box('stopped'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toBe('start');
    // Not held as in flight any more: the next open sends again.
    const again = hung.open(box('stopped'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await again).toBe('start');
    expect(startBox).toHaveBeenCalledTimes(2);

    const throwing = new SelectBoxStarter(startBox, async () => { throw new Error('list down'); }, new BoxStatusBus(), 1000);
    expect(await throwing.open(box('stopped', { id: 'box-2' }))).toBe('start');
  });
});

describe('startErrorKind', () => {
  const res = (status: number, data?: unknown) => ({ response: { status, data } });
  it('holds what the route decided: 4xx, and its own 503', () => {
    for (const s of [400, 403, 404, 409]) expect(startErrorKind(res(s, { error: 'x' })), String(s)).toBe('refused');
    expect(startErrorKind(res(503, { error: 'Box provisioning is not configured on this orchestrator' }))).toBe('refused');
  });
  it('lets a later open retry the rest: no answer, a 502, a proxy\'s 503', () => {
    expect(startErrorKind(new Error('Network Error'))).toBe('failed');
    expect(startErrorKind(res(502, { error: 'EC2 refused the start: throttled' }))).toBe('failed');
    expect(startErrorKind(res(503, '<html>Service Unavailable</html>'))).toBe('failed');
    expect(startErrorKind(res(503, { error: 'upstream connect error' }))).toBe('failed');
    expect(startErrorKind(res(504))).toBe('failed');
  });
});
