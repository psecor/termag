import { describe, expect, it, vi } from 'vitest';
import { SessionPinsStore, type SessionPin, type SessionPinsApi } from './sessionPins';
import { PINS_PUSH_EVENT, PROJECTS_PUSH_EVENT } from '../utils/workspacePush';

vi.mock('../services/api', () => ({ sessionPinsApi: {} }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../flags', () => ({ FLAGS: { userProjects: 'user-projects-enabled' }, useFlag: () => false }));

const pin = (workstreamId: string, pinnedAt = '2026-11-13T12:00:00.000Z'): SessionPin =>
  ({ workstreamId, projectId: 'p1', workstream: workstreamId, pinnedAt });
const row = (workstreamId: string) => ({ workstreamId, projectId: 'p1', workstream: workstreamId });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** An API whose every call waits for the test to answer it. */
function fakeApi() {
  const calls: Array<{ kind: 'list' | 'pin' | 'unpin'; id?: string; answer: ReturnType<typeof deferred<unknown>> }> = [];
  const take = <T>(kind: 'list' | 'pin' | 'unpin', id?: string) => {
    const answer = deferred<unknown>();
    calls.push({ kind, id, answer });
    return answer.promise as Promise<T>;
  };
  const api: SessionPinsApi = {
    list: () => take<SessionPin[]>('list'),
    pin: id => take<SessionPin>('pin', id),
    unpin: id => take<void>('unpin', id),
  };
  return { api, calls };
}

const flush = () => new Promise(r => setTimeout(r, 0));
const ids = (s: SessionPinsStore) => s.getSnapshot().pins?.map(p => p.workstreamId) ?? null;

describe('SessionPinsStore', () => {
  it('reads when the first reader comes, re-reads on each push, and stops with the last', async () => {
    const { api, calls } = fakeApi();
    const events = new EventTarget();
    const store = new SessionPinsStore(api, events);
    expect(store.getSnapshot()).toMatchObject({ pins: null, settled: false });

    const one = store.acquire();
    const two = store.acquire();
    expect(calls.map(c => c.kind)).toEqual(['list']);
    calls[0].answer.resolve([pin('a')]);
    await flush();
    expect(store.getSnapshot()).toMatchObject({ settled: true, failed: false });
    expect(ids(store)).toEqual(['a']);
    expect(store.isPinned('a')).toBe(true);
    expect(store.isPinned('b')).toBe(false);
    expect(store.isPinned(null)).toBe(false);

    events.dispatchEvent(new Event(PINS_PUSH_EVENT));
    events.dispatchEvent(new Event(PROJECTS_PUSH_EVENT));
    expect(calls.map(c => c.kind)).toEqual(['list', 'list', 'list']);
    // The latest read wins.
    calls[2].answer.resolve([pin('b')]);
    calls[1].answer.resolve([pin('stale')]);
    await flush();
    expect(ids(store)).toEqual(['b']);

    one();
    one();
    events.dispatchEvent(new Event(PINS_PUSH_EVENT));
    expect(calls).toHaveLength(4);
    two();
    expect(store.getSnapshot().pins).toBeNull();
    events.dispatchEvent(new Event(PINS_PUSH_EVENT));
    expect(calls).toHaveLength(4);
  });

  it("shows a pin at once, then the server's", async () => {
    const { api, calls } = fakeApi();
    const store = new SessionPinsStore(api, new EventTarget());
    store.acquire();
    calls[0].answer.resolve([pin('a')]);
    await flush();
    const done = store.pin(row('b'));
    expect(ids(store)).toEqual(['a', 'b']);
    await flush();
    expect(calls[1]).toMatchObject({ kind: 'pin', id: 'b' });
    calls[1].answer.resolve(pin('b', '2026-11-13T12:05:00.000Z'));
    expect(await done).toBe(true);
    expect(store.getSnapshot().pins?.[1].pinnedAt).toBe('2026-11-13T12:05:00.000Z');
    // Pinning a pinned one doesn't add it twice.
    void store.pin(row('a'));
    expect(ids(store)).toEqual(['a', 'b']);
  });

  it('shows an unpin at once', async () => {
    const { api, calls } = fakeApi();
    const store = new SessionPinsStore(api, new EventTarget());
    store.acquire();
    calls[0].answer.resolve([pin('a'), pin('b')]);
    await flush();
    const done = store.unpin('a');
    expect(ids(store)).toEqual(['b']);
    await flush();
    calls[1].answer.resolve(undefined);
    expect(await done).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('sends writes to one session one after another, and the last click wins', async () => {
    const { api, calls } = fakeApi();
    const store = new SessionPinsStore(api, new EventTarget());
    store.acquire();
    calls[0].answer.resolve([]);
    await flush();
    const first = store.pin(row('a'));
    const second = store.unpin('a');
    expect(ids(store)).toEqual([]);
    await flush();
    // The unpin waits for the pin's answer.
    expect(calls.map(c => c.kind)).toEqual(['list', 'pin']);
    calls[1].answer.resolve(pin('a'));
    await first;
    await flush();
    // The pin's answer didn't bring it back: the unpin is newer.
    expect(ids(store)).toEqual([]);
    expect(calls.map(c => c.kind)).toEqual(['list', 'pin', 'unpin']);
    calls[2].answer.resolve(undefined);
    expect(await second).toBe(true);
    expect(ids(store)).toEqual([]);
  });

  it("drops a read that lands during a write, and reads again once it's done", async () => {
    const { api, calls } = fakeApi();
    const events = new EventTarget();
    const store = new SessionPinsStore(api, events);
    store.acquire();
    calls[0].answer.resolve([]);
    await flush();
    events.dispatchEvent(new Event(PINS_PUSH_EVENT));
    const done = store.pin(row('a'));
    // The read went out before the click, so it can't have the pin.
    calls[1].answer.resolve([]);
    await flush();
    expect(ids(store)).toEqual(['a']);
    // A push during the write waits for it.
    events.dispatchEvent(new Event(PINS_PUSH_EVENT));
    await flush();
    expect(calls.map(c => c.kind)).toEqual(['list', 'list', 'pin']);
    calls[2].answer.resolve(pin('a'));
    await done;
    await flush();
    expect(calls.map(c => c.kind)).toEqual(['list', 'list', 'pin', 'list']);
    calls[3].answer.resolve([pin('a')]);
    await flush();
    expect(ids(store)).toEqual(['a']);
  });

  it('reads again after a write when a read fails during it (Bugbot)', async () => {
    const { api, calls } = fakeApi();
    const store = new SessionPinsStore(api, new EventTarget());
    store.acquire();
    // A pin during the first read, which then fails.
    const done = store.pin(row('a'));
    calls[0].answer.reject(new Error('network'));
    await flush();
    expect(store.getSnapshot()).toMatchObject({ failed: false, settled: false });
    expect(ids(store)).toEqual(['a']);
    expect(calls.map(c => c.kind)).toEqual(['list', 'pin']);
    calls[1].answer.resolve(pin('a'));
    await done;
    await flush();
    expect(calls.map(c => c.kind)).toEqual(['list', 'pin', 'list']);
    calls[2].answer.resolve([pin('a'), pin('b')]);
    await flush();
    expect(store.getSnapshot()).toMatchObject({ failed: false, settled: true });
    expect(ids(store)).toEqual(['a', 'b']);
  });

  it("drops a read that was out when a write started, even when the write finishes first", async () => {
    const { api, calls } = fakeApi();
    const events = new EventTarget();
    const store = new SessionPinsStore(api, events);
    store.acquire();
    calls[0].answer.resolve([]);
    await flush();
    events.dispatchEvent(new Event(PINS_PUSH_EVENT));
    const done = store.pin(row('a'));
    await flush();
    calls[2].answer.resolve(pin('a'));
    await done;
    await flush();
    // The read from before the click answers last, without the pin: it's dropped, and a fresh one is out.
    calls[1].answer.resolve([]);
    await flush();
    expect(ids(store)).toEqual(['a']);
    expect(calls.map(c => c.kind)).toEqual(['list', 'list', 'pin', 'list']);
    calls[3].answer.resolve([pin('a')]);
    await flush();
    expect(ids(store)).toEqual(['a']);
  });

  it('puts it back as the server has it when a write fails', async () => {
    const { api, calls } = fakeApi();
    const store = new SessionPinsStore(api, new EventTarget());
    store.acquire();
    calls[0].answer.resolve([]);
    await flush();
    const done = store.pin(row('archived'));
    expect(ids(store)).toEqual(['archived']);
    await flush();
    calls[1].answer.reject({ response: { status: 409, data: { code: 'session_archived' } } });
    expect(await done).toBe(false);
    await flush();
    expect(calls.map(c => c.kind)).toEqual(['list', 'pin', 'list']);
    calls[2].answer.resolve([]);
    await flush();
    expect(ids(store)).toEqual([]);
  });

  it('undoes a failed click at once, even when the re-read fails too', async () => {
    const { api, calls } = fakeApi();
    const store = new SessionPinsStore(api, new EventTarget());
    store.acquire();
    calls[0].answer.resolve([pin('a', '2026-11-13T12:00:00.000Z'), pin('b', '2026-11-13T12:01:00.000Z')]);
    await flush();
    const unpinned = store.unpin('a');
    const pinned = store.pin(row('c'));
    const again = store.pin(row('b'));
    expect(ids(store)).toEqual(['b', 'c']);
    await flush();
    calls[1].answer.reject(new Error('network'));
    calls[2].answer.reject(new Error('network'));
    calls[3].answer.reject(new Error('network'));
    expect(await unpinned).toBe(false);
    expect(await pinned).toBe(false);
    expect(await again).toBe(false);
    // a is back in its place, c is gone, and b, pinned before the click, stays.
    expect(ids(store)).toEqual(['a', 'b']);
    await flush();
    calls[4].answer.reject(new Error('network'));
    await flush();
    expect(ids(store)).toEqual(['a', 'b']);
    expect(store.getSnapshot().failed).toBe(true);
  });

  it('undoes a failed toggle to what the server had, not to an unanswered click (Devin)', async () => {
    for (const startPinned of [false, true]) {
      const { api, calls } = fakeApi();
      const store = new SessionPinsStore(api, new EventTarget());
      store.acquire();
      calls[0].answer.resolve(startPinned ? [pin('a')] : []);
      await flush();
      const first = startPinned ? store.unpin('a') : store.pin(row('a'));
      const second = startPinned ? store.pin(row('a')) : store.unpin('a');
      await flush();
      calls[1].answer.reject(new Error('network'));
      await first;
      await flush();
      calls[2].answer.reject(new Error('network'));
      expect(await second).toBe(false);
      expect(store.isPinned('a')).toBe(startPinned);
      await flush();
      calls[3].answer.reject(new Error('network'));
      await flush();
      expect(store.isPinned('a')).toBe(startPinned);
    }
  });

  it('puts a pin a failed toggle restores back in its place (Bugbot)', async () => {
    const { api, calls } = fakeApi();
    const store = new SessionPinsStore(api, new EventTarget());
    store.acquire();
    calls[0].answer.resolve([pin('a', '2026-11-13T12:00:00.000Z'), pin('b', '2026-11-13T12:01:00.000Z')]);
    await flush();
    const unpinA = store.unpin('a');
    const repinA = store.pin(row('a'));
    // The re-pin shows at the end, with its new time.
    expect(ids(store)).toEqual(['b', 'a']);
    await flush();
    calls[1].answer.reject(new Error('network'));
    await unpinA;
    await flush();
    calls[2].answer.reject(new Error('network'));
    expect(await repinA).toBe(false);
    // Both failed: a's own row is back, first, by when it was pinned.
    expect(ids(store)).toEqual(['a', 'b']);
    expect(store.getSnapshot().pins?.[0].pinnedAt).toBe('2026-11-13T12:00:00.000Z');
    // Even when the re-read fails too.
    await flush();
    expect(calls[3].kind).toBe('list');
    calls[3].answer.reject(new Error('network'));
    await flush();
    expect(ids(store)).toEqual(['a', 'b']);
  });

  it('undoes a failed click to an earlier click the server took', async () => {
    const { api, calls } = fakeApi();
    const store = new SessionPinsStore(api, new EventTarget());
    store.acquire();
    calls[0].answer.resolve([]);
    await flush();
    const first = store.pin(row('a'));
    const second = store.unpin('a');
    await flush();
    calls[1].answer.resolve(pin('a', '2026-11-13T12:09:00.000Z'));
    await first;
    await flush();
    calls[2].answer.reject(new Error('network'));
    expect(await second).toBe(false);
    expect(store.getSnapshot().pins).toEqual([pin('a', '2026-11-13T12:09:00.000Z')]);
  });

  it('keeps the last good list when a read fails', async () => {
    const { api, calls } = fakeApi();
    const events = new EventTarget();
    const store = new SessionPinsStore(api, events);
    store.acquire();
    calls[0].answer.resolve([pin('a')]);
    await flush();
    events.dispatchEvent(new Event(PINS_PUSH_EVENT));
    calls[1].answer.reject(new Error('network'));
    await flush();
    expect(store.getSnapshot()).toMatchObject({ failed: true, settled: true });
    expect(ids(store)).toEqual(['a']);
  });

  it("is off when the server says so, and pin and unpin then do nothing", async () => {
    const { api, calls } = fakeApi();
    const store = new SessionPinsStore(api, new EventTarget());
    store.acquire();
    calls[0].answer.reject({ response: { status: 404, data: { code: 'session_pins_disabled' } } });
    await flush();
    expect(store.getSnapshot()).toEqual({ pins: null, settled: true, failed: false, offOnServer: true });
    expect(await store.pin(row('a'))).toBe(false);
    expect(await store.unpin('a')).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('writes nothing with no reader', async () => {
    const { api, calls } = fakeApi();
    const store = new SessionPinsStore(api, new EventTarget());
    expect(await store.pin(row('a'))).toBe(false);
    await store.reload();
    expect(calls).toHaveLength(0);
  });
});
