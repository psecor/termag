import { describe, expect, it } from 'vitest';
import { COLD_START_BOOT_MS, coldStartMarker, resumeMarker } from './coldStart';

const T = Date.parse('2026-11-04T08:00:00Z');
const at = (min: number) => new Date(T + min * 60_000);
const box = (over: Partial<Parameters<typeof resumeMarker>[0]> = {}) => ({
  resumedFromHibernationAt: null, lastReadyAt: at(0), readyAt: at(-60 * 24 * 10), hibernatedAt: null, rehibernatePending: false, ...over,
});

describe('coldStartMarker', () => {
  it('is the connect that made a stopped box ready, less the boot window', () => {
    expect(coldStartMarker(box())).toEqual(new Date(T - COLD_START_BOOT_MS));
  });
  it('is none for a box that never came up, a hibernation resume, the 60-day refresh or a first boot', () => {
    expect(coldStartMarker(box({ lastReadyAt: null }))).toBeNull();
    expect(coldStartMarker(box({ hibernatedAt: at(-600) }))).toBeNull();
    expect(coldStartMarker(box({ rehibernatePending: true }))).toBeNull();
    expect(coldStartMarker(box({ readyAt: at(0) }))).toBeNull();
  });
});

describe('coldStartMarker and the stop before the start (Devin on #1304)', () => {
  it('starts at the agent\'s disconnect before the connect, so a run before the stop never spends it', () => {
    // Stopped at 07:56, connected again at 08:00: a run at 07:55 was the last boot's.
    expect(coldStartMarker(box({ agentDisconnectedAt: at(-4) }))).toEqual(at(-4));
  });
  it('never later than the boot window, and the window stands in when a later disconnect overwrote it', () => {
    expect(coldStartMarker(box({ agentDisconnectedAt: at(-600) }))).toEqual(new Date(T - COLD_START_BOOT_MS));
    expect(coldStartMarker(box({ agentDisconnectedAt: at(30) }))).toEqual(new Date(T - COLD_START_BOOT_MS));
  });
});

describe('resumeMarker', () => {
  it('prefers the stored hibernation marker, else the cold start, else none', () => {
    expect(resumeMarker(box({ resumedFromHibernationAt: at(-1), hibernatedAt: at(-600) }))).toEqual({ at: at(-1), kind: 'hibernation' });
    expect(resumeMarker(box())).toEqual({ at: new Date(T - COLD_START_BOOT_MS), kind: 'cold-start' });
    expect(resumeMarker(box({ hibernatedAt: at(-600) }))).toBeNull();
  });
});
