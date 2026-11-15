import { describe, expect, it } from 'vitest';
import { hasReposWords, heatOf, loadOf, placeSession, repoSetKey, type PlacementBoxInput, type PlacementInput } from './boxPlacement';
import { DEFAULT_SPAWN_LIMITS } from './spawnLimits';

const NOW = Date.parse('2030-01-01T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000);

function box(id: string, over: Partial<Omit<PlacementBoxInput, 'reading'>> & { mem?: number | null; disk?: number | null; load1?: number | null; cores?: number | null; sampled?: Date | null; liveAgents?: number | null } = {}): PlacementBoxInput {
  const { mem = 40, disk = 30, load1 = 0.5, cores = 4, sampled = minsAgo(1), liveAgents = null, ...rest } = over;
  return {
    reading: { id, name: id, memUsedPct: mem, diskUsedPct: disk, load1, cores, sampledAt: sampled, liveAgents },
    limits: DEFAULT_SPAWN_LIMITS,
    status: 'ready',
    connected: true,
    startable: true,
    sessions: 0,
    checkoutProjectId: null,
    lastUsedAt: null,
    ...rest,
  };
}

const input = (boxes: PlacementBoxInput[], over: Partial<PlacementInput> = {}): PlacementInput => ({
  policy: 'reuse-first', policySource: 'org', boxes, repoNames: ['termag'], poolFree: true, now: NOW, ...over,
});

describe('placeSession, reuse first', () => {
  it('1: an up, cool box with the repo set beats your last box', () => {
    const v = placeSession(input([
      box('last', { lastUsedAt: minsAgo(1) }),
      box('older-repo', { checkoutProjectId: 'p-old', lastUsedAt: minsAgo(60) }),
      box('repo', { checkoutProjectId: 'p1', lastUsedAt: minsAgo(10) }),
    ]));
    expect(v.recommended).toEqual({ kind: 'box', instanceId: 'repo', reason: ['has termag', 'room to spare'] });
  });

  it('1: the last box with the repo set says both, last used first', () => {
    const v = placeSession(input([box('a', { checkoutProjectId: 'p1', lastUsedAt: minsAgo(1) }), box('b')]));
    expect(v.recommended).toEqual({ kind: 'box', instanceId: 'a', reason: ['Last used', 'has termag', 'room to spare'] });
  });

  it('1: names every repository of a multi-repo set', () => {
    const v = placeSession(input([box('a', { checkoutProjectId: 'p1' })], { repoNames: ['termag', 'termag-desktop'] }));
    expect(v.recommended.reason).toEqual(['has termag + termag-desktop', 'room to spare']);
  });

  it('2: your last box when no up box has the repo set', () => {
    const v = placeSession(input([box('cool', { mem: 10 }), box('last', { mem: 50, lastUsedAt: minsAgo(5) })]));
    expect(v.recommended).toEqual({ kind: 'box', instanceId: 'last', reason: ['Last used', 'room to spare'] });
  });

  it('2: a warm last box says how busy it is', () => {
    const v = placeSession(input([box('last', { mem: 72, lastUsedAt: minsAgo(5) })]));
    expect(v.recommended.reason).toEqual(['Last used', 'busy: memory 72%']);
  });

  it('2: skips a hot last box, and a repo box that is hot', () => {
    const v = placeSession(input([
      box('last', { mem: 91, lastUsedAt: minsAgo(1) }),
      box('repo', { disk: 95, checkoutProjectId: 'p1' }),
      box('other', { mem: 20 }),
    ]));
    expect(v.recommended).toEqual({ kind: 'box', instanceId: 'other', reason: ['room to spare'] });
  });

  it('3: another up box, coolest first; one with no recent reading after those with one', () => {
    const v = placeSession(input([
      box('unknown', { sampled: minsAgo(60) }),
      box('warmer', { mem: 60 }),
      box('cooler', { mem: 20, disk: 10, load1: 0.1 }),
    ]));
    expect(v.recommended).toMatchObject({ kind: 'box', instanceId: 'cooler' });
    const only = placeSession(input([box('unknown', { sampled: null })]));
    expect(only.recommended).toEqual({ kind: 'box', instanceId: 'unknown', reason: ['no recent reading'] });
  });

  it('4: a parked box when no up box is cool, the one with the repo set first', () => {
    const v = placeSession(input([
      box('hot', { mem: 99 }),
      box('stopped', { status: 'stopped', lastUsedAt: minsAgo(1) }),
      box('hibernated-repo', { status: 'hibernated', checkoutProjectId: 'p1', lastUsedAt: minsAgo(100) }),
    ]));
    expect(v.recommended).toEqual({ kind: 'box', instanceId: 'hibernated-repo', reason: ['has termag', 'asleep · wakes when you start'] });
  });

  it('4: a box already waking counts, and is not started twice', () => {
    const v = placeSession(input([box('w', { status: 'starting', lastUsedAt: minsAgo(3) })]));
    expect(v.recommended).toEqual({ kind: 'box', instanceId: 'w', reason: ['Last used', 'waking up'] });
  });

  it('4: never an asleep box a start would not take', () => {
    const v = placeSession(input([box('ext', { status: 'stopped', startable: false })]));
    expect(v.recommended).toEqual({ kind: 'new', source: 'pool', reason: ['a ready box from the pool'] });
  });

  it('4: never a box on its way down', () => {
    const v = placeSession(input([box('s', { status: 'stopping' })], { poolFree: false }));
    expect(v.recommended).toEqual({ kind: 'new', source: 'cold', reason: ['a new box · takes a few minutes'] });
  });

  it('5: no boxes is New box, from the pool or a cold launch', () => {
    expect(placeSession(input([])).recommended).toEqual({ kind: 'new', source: 'pool', reason: ['a ready box from the pool'] });
    expect(placeSession(input([], { poolFree: false })).recommended).toEqual({ kind: 'new', source: 'cold', reason: ['a new box · takes a few minutes'] });
  });

  it('5: every box hot is New box, and says your boxes are busy', () => {
    const v = placeSession(input([box('a', { mem: 90 }), box('b', { load1: 8, cores: 4 })]));
    expect(v.recommended).toEqual({ kind: 'new', source: 'pool', reason: ['your boxes are busy', 'a ready box from the pool'] });
  });

  it('never a ready box whose agent is not connected now, even with the repo set', () => {
    const v = placeSession(input([
      box('offline-repo', { connected: false, checkoutProjectId: 'p1', lastUsedAt: minsAgo(1) }),
      box('live', { mem: 50 }),
    ]));
    expect(v.recommended).toEqual({ kind: 'box', instanceId: 'live', reason: ['room to spare'] });
    expect(v.boxes.map(b => b.instanceId)).toEqual(['live', 'offline-repo']);
    expect(v.boxes[1]).toMatchObject({ connected: false, heat: 'unknown', load: null });
    const alone = placeSession(input([box('offline', { connected: false })], { poolFree: false }));
    expect(alone.recommended).toEqual({ kind: 'new', source: 'cold', reason: ['a new box · takes a few minutes'] });
  });

  it('a box at its agent capacity is hot', () => {
    const limits = { ...DEFAULT_SPAWN_LIMITS, boxCapacity: 2 };
    const v = placeSession(input([box('full', { limits, liveAgents: 2 }), box('room', { limits, liveAgents: 1, mem: 60 })]));
    expect(v.recommended).toMatchObject({ instanceId: 'room' });
    expect(v.boxes.find(b => b.instanceId === 'full')).toMatchObject({ heat: 'hot', heatReasons: ['at its agent capacity (2/2)'] });
  });
});

describe('placeSession, fresh first', () => {
  it('is New box, and lists your boxes', () => {
    const v = placeSession(input([box('a', { checkoutProjectId: 'p1', lastUsedAt: minsAgo(1) })], { policy: 'fresh-first', policySource: 'personal' }));
    expect(v.recommended).toEqual({ kind: 'new', source: 'pool', reason: ['your default is a fresh box', 'a ready box from the pool'] });
    expect(v.boxes.map(b => b.instanceId)).toEqual(['a']);
    expect(v).toMatchObject({ policy: 'fresh-first', policySource: 'personal' });
  });

  it('is a cold launch with no pool box free', () => {
    const v = placeSession(input([], { policy: 'fresh-first', poolFree: false }));
    expect(v.recommended).toEqual({ kind: 'new', source: 'cold', reason: ['your default is a fresh box', 'a new box · takes a few minutes'] });
    expect(v.newBox).toEqual({ source: 'cold' });
  });
});

describe('the box rows', () => {
  it('lists up and cool first, then waking, asleep, and hot boxes last', () => {
    const v = placeSession(input([
      box('hot', { mem: 92, lastUsedAt: minsAgo(1) }),
      box('asleep', { status: 'stopped' }),
      box('waking', { status: 'starting' }),
      box('up-old', { lastUsedAt: minsAgo(50) }),
      box('up-new', { lastUsedAt: minsAgo(5) }),
    ]));
    expect(v.boxes.map(b => b.instanceId)).toEqual(['up-new', 'up-old', 'waking', 'asleep', 'hot']);
    expect(v.boxes.at(-1)).toMatchObject({ heat: 'hot', heatReasons: ['memory 92% (limit 85%)'] });
  });

  it('carries state, sessions, the repo set and when it was last used', () => {
    const v = placeSession(input([box('a', { sessions: 3, checkoutProjectId: 'p1', lastUsedAt: minsAgo(2) })]));
    expect(v.boxes[0]).toEqual({
      instanceId: 'a', name: 'a', status: 'ready', connected: true, heat: 'ok', heatReasons: [], load: 0.47,
      sessions: 3, hasRepos: true, checkoutProjectId: 'p1', lastUsedAt: minsAgo(2).toISOString(),
    });
  });

  it('reads no heat from a box that is not up', () => {
    const v = placeSession(input([box('s', { status: 'stopped', mem: 99 })]));
    expect(v.boxes[0]).toMatchObject({ heat: 'unknown', heatReasons: [], load: null });
  });
});

describe('heat and load', () => {
  it('is warm at 80% of a threshold and hot over it', () => {
    expect(heatOf(box('a', { mem: 70 }), NOW)).toEqual({ heat: 'warm', reasons: ['memory 70% (limit 85%)'] });
    expect(heatOf(box('a', { mem: 85 }), NOW)).toEqual({ heat: 'hot', reasons: ['memory 85% (limit 85%)'] });
    expect(heatOf(box('a', { sampled: minsAgo(20) }), NOW)).toEqual({ heat: 'unknown', reasons: [] });
  });

  it('is the tightest of memory, disk and load per core against its threshold', () => {
    expect(loadOf(box('a', { mem: 42.5, disk: 45, load1: 3, cores: 4 }), NOW)).toBe(0.5);
    expect(loadOf(box('a', { mem: 10, disk: 10, load1: 6, cores: 2 }), NOW)).toBe(2);
    expect(loadOf(box('a', { sampled: null }), NOW)).toBeNull();
  });
});

describe('repo sets', () => {
  it('compares case- and order-blind, and ignores what is not a repository', () => {
    expect(repoSetKey(['Example-Org/termag-desktop', 'example-org/termag', null])).toBe('example-org/termag example-org/termag-desktop');
    expect(repoSetKey([null])).toBeNull();
    expect(hasReposWords([])).toBeNull();
  });
});
