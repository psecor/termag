import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, InstanceStatus } from '../types';
import { BoxFeed, boxIsSettling } from './boxFeed';
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

  it('tells the box list about each new list, and keeps the last one (saying so once) when a fetch fails', async () => {
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
    await feed.reload();
    // Once for the change to isFailing, not again for a second failure in a row.
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(feed.isFailing()).toBe(true);
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

describe('isFresh', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('is fresh only once a list fetched since the last start() has come back', async () => {
    const fetch = scripted('ready', 'stopped');
    const feed = new BoxFeed(fetch, new BoxStatusBus(), 5000);
    expect(feed.isFresh()).toBe(false);

    feed.start();
    await flush();
    expect(feed.isFresh()).toBe(true);

    // The workspace unmounted. The kept list still says ready, but the box
    // can park meanwhile: that copy is loaded, not fresh.
    feed.stop();
    expect(feed.hasLoaded()).toBe(true);
    expect(feed.isFresh()).toBe(false);

    feed.start();
    expect(feed.isFresh()).toBe(false);
    await flush();
    expect(feed.isFresh()).toBe(true);
    expect(feed.getSnapshot().map(b => b.status)).toEqual(['stopped']);
  });

  it('does not count a fetch begun before stop() as fresh after the next start()', async () => {
    let answer!: (boxes: Instance[]) => void;
    const fetch = vi.fn()
      .mockImplementationOnce(async () => [box('ready')])
      .mockImplementationOnce(() => new Promise<Instance[]>(r => { answer = r; }))
      .mockImplementation(() => new Promise<Instance[]>(() => {}));
    const feed = new BoxFeed(fetch, new BoxStatusBus(), 5000);
    feed.start();
    await flush();
    void feed.reload();
    feed.stop();
    feed.start();
    answer([box('ready')]);
    await flush();
    expect(feed.isFresh()).toBe(false);
  });

  it('does not count a fetch begun while the feed was stopped as fresh after the next start()', async () => {
    let answer!: (boxes: Instance[]) => void;
    const fetch = vi.fn()
      .mockImplementationOnce(async () => [box('ready')])
      .mockImplementationOnce(() => new Promise<Instance[]>(r => { answer = r; }))
      .mockImplementation(() => new Promise<Instance[]>(() => {}));
    const feed = new BoxFeed(fetch, new BoxStatusBus(), 5000);
    feed.start();
    await flush();
    feed.stop();
    // A start's follow-up reload, or a clone retry, while nothing owns the feed.
    void feed.reload();
    feed.start();
    answer([box('ready')]);
    await flush();
    expect(feed.isFresh()).toBe(false);
  });

  it('retries on the poll when the fetch after start() fails, though every box has settled', async () => {
    let fail = false;
    const fetch = vi.fn(async () => {
      if (fail) throw new Error('network');
      return [box('stopped')];
    });
    const feed = new BoxFeed(fetch, new BoxStatusBus(), 5000);
    feed.start();
    await flush();
    feed.stop();
    fail = true;
    feed.start();
    await flush();
    expect(feed.isFresh()).toBe(false);
    fail = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(feed.isFresh()).toBe(true);
    // Fresh and settled: no more polling.
    const calls = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(calls);
    feed.stop();
  });
});

// backend services/claimUpdate.ts; Bugbot on #1118: a row left `updating` past the bound must not keep the feed polling.
describe('boxIsSettling for a claim update', () => {
  it('polls while it runs, and not once it is past its bound', () => {
    const ready = { id: 'b', name: 'b', status: 'ready', claimUpdateStatus: 'updating' } as Instance;
    expect(boxIsSettling({ ...ready, claimUpdateStartedAt: new Date().toISOString() })).toBe(true);
    expect(boxIsSettling({ ...ready, claimUpdateStartedAt: new Date(Date.now() - 10 * 60_000).toISOString() })).toBe(false);
  });
});

describe('BoxFeed: a failed refresh', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps the last list, reports isFailing and tells listeners, then clears on the next good fetch', async () => {
    let fail = false;
    const fetch = vi.fn(async () => { if (fail) throw new Error('401'); return [box('ready')]; });
    const feed = new BoxFeed(fetch, new BoxStatusBus(), 5000);
    let told = 0;
    feed.subscribe(() => { told++; });

    await feed.reload();
    expect(feed.isFailing()).toBe(false);
    told = 0;

    fail = true;
    await feed.reload();
    expect(feed.isFailing()).toBe(true);
    expect(feed.getSnapshot()).toEqual([box('ready')]);
    expect(told).toBe(1);

    fail = false;
    await feed.reload();
    expect(feed.isFailing()).toBe(false);
  });

  it('does not report a failure from an older fetch that a newer one already answered', async () => {
    let rejectOld!: (e: Error) => void;
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise<Instance[]>((_, reject) => { rejectOld = reject; }))
      .mockImplementation(async () => [box('ready')]);
    const feed = new BoxFeed(fetch, new BoxStatusBus(), 5000);

    const old = feed.reload();
    await feed.reload();
    rejectOld(new Error('late'));
    await old;

    expect(feed.isFailing()).toBe(false);
  });
});

describe('BoxFeed: reloadIfOlderThan and a restart', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('skips a reload while the last list is fresh, reloads once it is older, and always while failing', async () => {
    let fail = false;
    const fetch = vi.fn(async () => { if (fail) throw new Error('down'); return [box('ready')]; });
    const feed = new BoxFeed(fetch, new BoxStatusBus(), 5000);

    await feed.reload();
    await feed.reloadIfOlderThan(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(31_000);
    await feed.reloadIfOlderThan(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);

    fail = true;
    await feed.reload();
    await feed.reloadIfOlderThan(30_000);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('forgets a failure from before stop() when it starts again', async () => {
    let fail = true;
    const feed = new BoxFeed(async () => { if (fail) throw new Error('401'); return [box('ready')]; }, new BoxStatusBus(), 5000);
    await feed.reload();
    expect(feed.isFailing()).toBe(true);
    feed.stop();
    fail = false;
    feed.start();
    expect(feed.isFailing()).toBe(false);
    await flush();
    expect(feed.isFailing()).toBe(false);
  });
});
