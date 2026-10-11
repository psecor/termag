import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudSession } from '../types';
import { CloudSessionFeed } from './cloudSessionFeed';

const one = [{ key: 'cse_01A' } as CloudSession];

describe('CloudSessionFeed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('loads on start, polls, and tells subscribers', async () => {
    const fetcher = vi.fn().mockResolvedValue(one);
    const feed = new CloudSessionFeed(fetcher, 1000);
    const heard = vi.fn();
    feed.subscribe(heard);
    expect(feed.hasLoaded()).toBe(false);
    feed.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.getSnapshot()).toEqual(one);
    expect(feed.hasLoaded()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    feed.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the last list on an error and shares one in-flight request between reloads', async () => {
    let resolve!: (v: CloudSession[]) => void;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(one)
      .mockRejectedValueOnce(new Error('503'))
      .mockImplementationOnce(() => new Promise<CloudSession[]>(r => { resolve = r; }));
    const feed = new CloudSessionFeed(fetcher, 60_000);
    feed.start();
    await vi.advanceTimersByTimeAsync(0);
    await feed.reload();
    expect(feed.getSnapshot()).toEqual(one);
    const a = feed.reload(); const b = feed.reload();
    expect(a).toBe(b);
    resolve([]);
    await a;
    expect(feed.getSnapshot()).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    feed.stop();
  });
});
