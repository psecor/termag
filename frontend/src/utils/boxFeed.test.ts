import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, InstanceStatus } from '../types';
import { BoxFeed } from './boxFeed';
import { BoxStatusBus } from './boxStatusBus';

const box = (status: InstanceStatus) => ({ id: 'box-1', name: 'box-1', status }) as Instance;

/** A fetch that answers with each status in turn, then keeps answering the last. */
function scripted(...statuses: InstanceStatus[]) {
  let i = 0;
  const fetch = vi.fn(async () => [box(statuses[Math.min(i++, statuses.length - 1)])]);
  return fetch;
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('BoxFeed', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('carries a stop through to stopped on the bus with no box list subscribed (sidebar collapsed)', async () => {
    const bus = new BoxStatusBus();
    const heard: string[] = [];
    bus.subscribe((_, status) => heard.push(status));
    const feed = new BoxFeed(scripted('stopping', 'stopping', 'stopped'), bus, 5000);

    feed.start();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(heard).toEqual(['stopping', 'stopped']);
  });

  it('keeps polling after the box list unsubscribes', async () => {
    const bus = new BoxStatusBus();
    const heard: string[] = [];
    bus.subscribe((_, status) => heard.push(status));
    const feed = new BoxFeed(scripted('starting', 'starting', 'ready'), bus, 5000);
    const unsubscribeList = feed.subscribe(() => {});

    feed.start();
    await flush();
    unsubscribeList();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(heard).toEqual(['starting', 'ready']);
  });

  it('stops polling once every box has settled', async () => {
    const fetch = scripted('stopping', 'stopped');
    const feed = new BoxFeed(fetch, new BoxStatusBus(), 5000);

    feed.start();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('polls nothing after stop(), and start() twice does not double the polling', async () => {
    const fetch = scripted('starting');
    const feed = new BoxFeed(fetch, new BoxStatusBus(), 5000);

    feed.start();
    feed.start();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(2);

    feed.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('tells the box list about each new list, and keeps the last one when a fetch fails', async () => {
    let fail = false;
    const feed = new BoxFeed(async () => {
      if (fail) throw new Error('network');
      return [box('ready')];
    }, new BoxStatusBus());
    const onChange = vi.fn();
    feed.subscribe(onChange);

    await feed.reload();
    expect(onChange).toHaveBeenCalledTimes(1);
    fail = true;
    await feed.reload();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(feed.getSnapshot().map(b => b.status)).toEqual(['ready']);
  });

  it('upsert puts a box into the list at once and tells the list, replacing a stale copy', async () => {
    const bus = new BoxStatusBus();
    const feed = new BoxFeed(scripted('ready'), bus, 5000);
    const seen: string[][] = [];
    feed.subscribe(() => seen.push(feed.getSnapshot().map(b => `${b.id}:${b.status}`)));
    await feed.reload();

    feed.upsert({ id: 'claimed', name: 'claimed', status: 'ready' } as Instance);
    feed.upsert({ id: 'box-1', name: 'box-1', status: 'stopping' } as Instance);

    expect(seen).toEqual([
      ['box-1:ready'],
      ['claimed:ready', 'box-1:ready'],
      ['box-1:stopping', 'claimed:ready'],
    ]);
  });

  it('keeps polling a ready box while its claim-time dotfiles are pending or running', async () => {
    const claims = ['pending', 'running', 'succeeded'];
    let i = 0;
    const fetch = vi.fn(async () => [{ id: 'c', name: 'c', status: 'ready', onClaimStatus: claims[Math.min(i++, 2)] } as Instance]);
    const feed = new BoxFeed(fetch, new BoxStatusBus(), 5000);

    feed.start();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(feed.getSnapshot()[0].onClaimStatus).toBe('succeeded');
  });

  it('does not poll a settled cold box that has no claim status', async () => {
    const fetch = vi.fn(async () => [{ id: 'cold', name: 'cold', status: 'ready', onClaimStatus: null } as Instance]);
    const feed = new BoxFeed(fetch, new BoxStatusBus(), 5000);

    feed.start();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('isGone', () => {
  const bus = new BoxStatusBus();
  const ready = (id: string) => ({ id, name: id, status: 'ready' }) as Instance;

  it('does not call a box gone from a list fetched before the box existed', async () => {
    const lists: Instance[][] = [[ready('old')], [ready('old'), ready('new')]];
    const feed = new BoxFeed(async () => lists.shift() ?? [], bus, 60_000);
    await feed.reload();

    feed.lookFor('new');
    expect(feed.isGone('new')).toBe(false);
    await vi.waitFor(() => expect(feed.getSnapshot().map(b => b.id)).toContain('new'));
    expect(feed.isGone('new')).toBe(false);
  });

  it('calls a box gone once a list fetched after lookFor still lacks it', async () => {
    const feed = new BoxFeed(async () => [ready('other')], bus, 60_000);
    await feed.reload();
    expect(feed.isGone('terminated')).toBe(false);

    feed.lookFor('terminated');
    await vi.waitFor(() => expect(feed.isGone('terminated')).toBe(true));
  });

  it('retries a lookup whose fetch failed, on the poll, even with no box settling', async () => {
    vi.useFakeTimers();
    try {
      let fail = false;
      const feed = new BoxFeed(async () => {
        if (fail) { fail = false; throw new Error('network'); }
        return [ready('other')];
      }, bus, 5000);
      feed.start();
      await flush();

      fail = true;
      feed.lookFor('terminated');
      await flush();
      expect(feed.isGone('terminated')).toBe(false);
      await vi.advanceTimersByTimeAsync(5000);
      expect(feed.isGone('terminated')).toBe(true);
      feed.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores an older fetch that settles after a newer one', async () => {
    const resolvers: ((l: Instance[]) => void)[] = [];
    const feed = new BoxFeed(() => new Promise<Instance[]>(r => { resolvers.push(r); }), bus, 60_000);
    const first = feed.reload();
    const second = feed.reload();
    resolvers[1]([ready('new')]);
    await second;
    resolvers[0]([]);
    await first;
    expect(feed.getSnapshot().map(b => b.id)).toEqual(['new']);
  });
});

describe('hasLoaded', () => {
  it('is false until the first successful load, whatever the list holds', async () => {
    const { BoxFeed } = await import('./boxFeed');
    const bus = { publish: () => {} } as unknown as import('./boxStatusBus').BoxStatusBus;
    const feed = new BoxFeed(async () => [], bus, 60_000);
    expect(feed.hasLoaded()).toBe(false);
    await feed.reload();
    expect(feed.hasLoaded()).toBe(true);
    feed.stop();
  });
});
