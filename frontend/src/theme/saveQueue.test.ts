import { describe, expect, it, vi } from 'vitest';
import { createSaveQueue } from './saveQueue';

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createSaveQueue', () => {
  it('runs saves strictly one after another, in request order', async () => {
    const first = deferred();
    const started: string[] = [];
    const run = vi.fn((item: string) => { started.push(item); return item === 'a' ? first.promise : Promise.resolve(); });
    const q = createSaveQueue(run, () => {});

    const a = q.push('a');
    const b = q.push('b');
    await Promise.resolve();
    expect(started).toEqual(['a']);        // b waits for a
    expect(q.pending).toBe(2);

    first.resolve();
    await Promise.all([a, b]);
    expect(started).toEqual(['a', 'b']);
    expect(q.pending).toBe(0);
  });

  it('calls onDrain once, after the last queued save settles, not after each one', async () => {
    const first = deferred();
    const second = deferred();
    const onDrain = vi.fn();
    const q = createSaveQueue((item: string) => (item === 'a' ? first.promise : second.promise), onDrain);

    const a = q.push('a');
    const b = q.push('b');
    first.resolve();
    await a;
    expect(onDrain).not.toHaveBeenCalled();  // b is still running
    second.resolve();
    await b;
    expect(onDrain).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failure to its caller without blocking the saves behind it', async () => {
    const onDrain = vi.fn();
    const q = createSaveQueue((item: string) => (item === 'bad' ? Promise.reject(new Error('nope')) : Promise.resolve()), onDrain);

    const bad = q.push('bad');
    const good = q.push('good');
    await expect(bad).rejects.toThrow('nope');
    await expect(good).resolves.toBeUndefined();
    expect(onDrain).toHaveBeenCalledTimes(1);
    expect(q.pending).toBe(0);
  });
});
