// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retryDelay, usePolled, type PolledOptions } from './useDashboardData';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let visibility: DocumentVisibilityState = 'visible';
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

function Probe({ fetcher, interval, opts }: { fetcher: () => Promise<unknown>; interval: number; opts: PolledOptions }) {
  usePolled(fetcher, interval, opts);
  return null;
}

function mount(fetcher: () => Promise<unknown>, interval: number, opts: PolledOptions = {}) {
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe fetcher={fetcher} interval={interval} opts={opts} />));
  return { unmount: () => act(() => root.unmount()) };
}

/** Advance fake time and let the fetch promises settle. */
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('retryDelay', () => {
  it('doubles per error in a row, up to the cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(n => retryDelay(n, 20_000, 300_000))).toEqual([20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
  });
  it('never waits less than retryMs, even under a smaller cap', () => {
    expect(retryDelay(3, 20_000, 5_000)).toBe(20_000);
  });
});

describe('usePolled', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('backs off on errors in a row and resets after a success', async () => {
    let fail = true;
    const fetcher = vi.fn(() => (fail ? Promise.reject(new Error('502')) : Promise.resolve('ok')));
    const { unmount } = mount(fetcher, 60_000, { retryMs: 20_000, maxRetryMs: 300_000 });
    await advance(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await advance(19_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await advance(1); // 20 s after the first error
    expect(fetcher).toHaveBeenCalledTimes(2);
    await advance(39_999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await advance(1); // 40 s after the second
    expect(fetcher).toHaveBeenCalledTimes(3);
    fail = false;
    await advance(80_000); // the third retry succeeds
    expect(fetcher).toHaveBeenCalledTimes(4);
    await advance(60_000); // then the normal interval
    expect(fetcher).toHaveBeenCalledTimes(5);
    unmount();
  });

  it('does not fetch while hidden, and waits out a fresh payload when shown again', async () => {
    const fetcher = vi.fn(() => Promise.resolve('ok'));
    const { unmount } = mount(fetcher, 60_000);
    await advance(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    await advance(10 * 60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    setVisibility('visible'); // long overdue: fetch now
    await advance(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    setVisibility('hidden');
    await advance(10_000);
    setVisibility('visible'); // 10 s old: wait for the rest of the minute
    await advance(49_999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    unmount();
  });

  it('does not start a second fetch when the tab is shown while one is still loading', async () => {
    let resolve!: (value: string) => void;
    const fetcher = vi.fn(() => new Promise<string>(r => { resolve = r; }));
    const { unmount } = mount(fetcher, 60_000);
    await advance(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    await advance(10_000);
    setVisibility('visible');
    await advance(10_000);
    expect(fetcher).toHaveBeenCalledTimes(1); // the load in flight, not a second one
    await act(async () => { resolve('ok'); });
    await advance(60_000); // then the normal interval
    expect(fetcher).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('makes its first fetch when a page opened in a background tab is shown', async () => {
    visibility = 'hidden';
    const fetcher = vi.fn(() => Promise.resolve('ok'));
    const { unmount } = mount(fetcher, 60_000);
    await advance(5 * 60_000);
    expect(fetcher).not.toHaveBeenCalled();
    setVisibility('visible');
    await advance(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    unmount();
  });
});
