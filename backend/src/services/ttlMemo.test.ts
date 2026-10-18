import { describe, it, expect } from 'vitest';
import { swrMemo, ttlMemo } from './ttlMemo';

describe('ttlMemo', () => {
  it('invokes load once on the first call and returns its value', async () => {
    let calls = 0;
    const get = ttlMemo(async () => {
      calls += 1;
      return 'ami-1';
    }, 1000, () => 0);

    expect(await get()).toBe('ami-1');
    expect(calls).toBe(1);
  });

  it('returns the cached value without invoking load again inside the TTL', async () => {
    let now = 0;
    let calls = 0;
    const get = ttlMemo(async () => {
      calls += 1;
      return 'ami-1';
    }, 1000, () => now);

    expect(await get()).toBe('ami-1');
    now = 999;
    expect(await get()).toBe('ami-1');
    expect(calls).toBe(1);
  });

  it('reloads at exactly loadedAt + ttlMs', async () => {
    let now = 10_000;
    let calls = 0;
    const get = ttlMemo(async () => {
      calls += 1;
      return `v${calls}`;
    }, 500, () => now);

    expect(await get()).toBe('v1');
    now = 10_499;
    expect(await get()).toBe('v1');
    expect(calls).toBe(1);

    now = 10_500;
    expect(await get()).toBe('v2');
    expect(calls).toBe(2);
  });

  it('shares one in-flight promise and stamps loadedAt when the load starts', async () => {
    let now = 0;
    let calls = 0;
    const pending: Array<(value: string) => void> = [];
    const get = ttlMemo(
      () => {
        calls += 1;
        return new Promise<string>((resolve) => { pending.push(resolve); });
      },
      1000,
      () => now,
    );

    const first = get();
    const second = get();
    expect(calls).toBe(1);

    now = 400;
    const stillInFlight = get();
    expect(calls).toBe(1);

    pending[0]('shared');
    expect(await Promise.all([first, second, stillInFlight])).toEqual(['shared', 'shared', 'shared']);

    now = 1000;
    const afterTtl = get();
    expect(calls).toBe(2);
    pending[1]('reloaded');
    expect(await afterTtl).toBe('reloaded');
  });

  it('does not cache a rejection and retries on the next call', async () => {
    let now = 0;
    let calls = 0;
    const pending: Array<{
      resolve: (value: string) => void;
      reject: (err: Error) => void;
    }> = [];
    const get = ttlMemo(
      () => {
        calls += 1;
        return new Promise<string>((resolve, reject) => { pending.push({ resolve, reject }); });
      },
      1000,
      () => now,
    );

    const first = get();
    const second = get();
    expect(calls).toBe(1);

    const err = new Error('discover failed');
    const firstRejected = expect(first).rejects.toBe(err);
    const secondRejected = expect(second).rejects.toBe(err);
    pending[0].reject(err);
    await firstRejected;
    await secondRejected;

    const third = get();
    expect(calls).toBe(2);
    pending[1].resolve('ok');
    expect(await third).toBe('ok');
  });
});

describe('swrMemo', () => {
  const deferred = <T,>() => {
    let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  it('waits for the first load, then serves fresh values without reloading', async () => {
    let now = 0; let calls = 0;
    const get = swrMemo(async () => ++calls, 100, 1000, () => now);
    expect(await get()).toBe(1);
    now = 99;
    expect(await get()).toBe(1);
    expect(calls).toBe(1);
  });

  it('serves the stale value at once and reloads once in the background', async () => {
    let now = 0;
    const loads = [deferred<string>(), deferred<string>()];
    let i = 0;
    const get = swrMemo(() => loads[i++].promise, 100, 1000, () => now);
    const first = get(); loads[0].resolve('a'); expect(await first).toBe('a');
    now = 150;
    expect(await get()).toBe('a');
    expect(await get()).toBe('a');
    expect(i).toBe(2); // one background reload, not two
    loads[1].resolve('b'); await loads[1].promise; await Promise.resolve();
    expect(await get()).toBe('b');
  });

  it('keeps the old value when a background reload fails', async () => {
    let now = 0; let fail = false;
    const get = swrMemo(async () => { if (fail) throw new Error('blip'); return 'a'; }, 100, 1000, () => now);
    await get();
    fail = true; now = 200;
    expect(await get()).toBe('a');
    await new Promise(r => setTimeout(r, 0));
    expect(await get()).toBe('a');
  });

  it('past maxStaleMs the caller waits, and sees the error', async () => {
    let now = 0; let fail = false;
    const get = swrMemo(async () => { if (fail) throw new Error('revoked'); return 'a'; }, 100, 1000, () => now);
    await get();
    fail = true; now = 5000;
    await expect(get()).rejects.toThrow('revoked');
  });
});
