import { describe, expect, it } from 'vitest';
import {
  SEEN_STOPS_KEY, UNSEEN_MAX_AGE_MS, formatStopAge, markSeen, mergeSeenStops, readSeenStops, unseenStopAge, writeSeenStops,
} from './unseenStops';

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
}

const T = Date.parse('2026-10-13T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const min = 60_000;

describe('unseen stops', () => {
  it('a first read sets and stores a baseline, so older stops are not marked', () => {
    const storage = memStorage();
    const store = readSeenStops(storage, T);
    expect(store).toEqual({ since: T, seen: {} });
    expect(JSON.parse(storage.m.get(SEEN_STOPS_KEY)!)).toEqual({ since: T, seen: {} });
    expect(unseenStopAge(store, 'k', 'idle', iso(T - min), T)).toBeNull();
    expect(unseenStopAge(store, 'k', 'idle', iso(T + min), T + 2 * min)).toBe('fresh');
  });

  it('round-trips, dropping seen entries older than the marker lifetime', () => {
    const storage = memStorage();
    writeSeenStops(storage, { since: T, seen: { a: T, b: T - UNSEEN_MAX_AGE_MS - 1 } });
    expect(readSeenStops(storage, T)).toEqual({ since: T, seen: { a: T } });
  });

  it('survives corrupt storage', () => {
    expect(readSeenStops(memStorage({ [SEEN_STOPS_KEY]: '{nope' }), T)).toEqual({ since: T, seen: {} });
    expect(readSeenStops(null, T)).toEqual({ since: T, seen: {} });
  });

  it('marks only at-rest sessions that stopped after they were seen, and ages them', () => {
    const store = { since: 0, seen: { k: T } };
    const stop = T + min;
    expect(unseenStopAge(store, 'k', 'idle', iso(T - min), T + 2 * min)).toBeNull();
    expect(unseenStopAge(store, 'k', 'working', iso(stop), stop)).toBeNull();
    expect(unseenStopAge(store, 'k', 'waiting', iso(stop), stop)).toBeNull();
    expect(unseenStopAge(store, 'k', 'idle', null, stop)).toBeNull();
    expect(unseenStopAge(store, 'k', 'not_running', iso(stop), stop + 14 * min)).toBe('fresh');
    expect(unseenStopAge(store, 'k', 'idle', iso(stop), stop + 30 * min)).toBe('recent');
    expect(unseenStopAge(store, 'k', 'idle', iso(stop), stop + 2 * 60 * min)).toBe('old');
    expect(unseenStopAge(store, 'k', 'idle', iso(stop), stop + UNSEEN_MAX_AGE_MS)).toBeNull();
  });

  it('marking seen covers a stop stamped ahead of the browser clock', () => {
    const store = markSeen({ since: 0, seen: {} }, 'k', T, iso(T + 30_000));
    expect(store.seen.k).toBe(T + 30_000);
    expect(unseenStopAge(store, 'k', 'idle', iso(T + 30_000), T + min)).toBeNull();
    expect(markSeen(store, 'k', T)).toBe(store);
  });

  it("merging two tabs' views keeps the later seen time per key", () => {
    const mine = { since: T, seen: { a: T + 5, b: T } };
    const theirs = { since: T - 10, seen: { b: T + 9, c: T + 1 } };
    expect(mergeSeenStops(mine, theirs)).toEqual({ since: T - 10, seen: { a: T + 5, b: T + 9, c: T + 1 } });
  });

  it('formats the age column', () => {
    expect(formatStopAge(10_000)).toBe('now');
    expect(formatStopAge(12 * min)).toBe('12m');
    expect(formatStopAge(3 * 60 * min + 5)).toBe('3h');
  });
});
