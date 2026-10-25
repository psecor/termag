import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPAWN_LIMITS,
  END_LAUNCH_GRACE_MS,
  FINISHED_IDLE_MS,
  SAMPLE_STALE_MS,
  SPAWN_CLAIM_WINDOW_MS,
  boxHeat,
  boxHints,
  boxRefusal,
  endDecision,
  limitRefusal,
  rebudget,
  parseSpawnLimits,
  spawnHints,
  suggestBox,
  type BoxReading,
  type HintKind,
} from './spawnLimits';

const now = Date.parse('2026-10-17T12:00:00Z');
const box = (over: Partial<BoxReading> = {}): BoxReading => ({
  id: 'b1', name: 'box-1', memUsedPct: 50, diskUsedPct: 40, load1: 1, cores: 2,
  sampledAt: new Date(now - 60_000), liveAgents: 2, ...over,
});

describe('parseSpawnLimits', () => {
  it('is the defaults for nothing, and the per-box cap is off by default', () => {
    expect(parseSpawnLimits(null)).toEqual(DEFAULT_SPAWN_LIMITS);
    expect(DEFAULT_SPAWN_LIMITS.boxCapacity).toBeNull();
  });

  it('takes good keys and falls back key by key on bad ones', () => {
    const l = parseSpawnLimits({ perHour: 50, maxDepth: 'three', boxCapacity: 4, hot: { memPct: 90, loadPerCore: -1 } });
    expect(l.perHour).toBe(50);
    expect(l.maxDepth).toBe(DEFAULT_SPAWN_LIMITS.maxDepth);
    expect(l.boxCapacity).toBe(4);
    expect(l.hot).toEqual({ memPct: 90, loadPerCore: DEFAULT_SPAWN_LIMITS.hot.loadPerCore, diskPct: DEFAULT_SPAWN_LIMITS.hot.diskPct });
  });

  it('lets null switch the box cap off again, and refuses absurd values', () => {
    expect(parseSpawnLimits({ boxCapacity: null }, { ...DEFAULT_SPAWN_LIMITS, boxCapacity: 3 }).boxCapacity).toBeNull();
    expect(parseSpawnLimits({ perHour: 0, maxOpenChildren: 1.5, maxConcurrentPerUser: 1e9 })).toMatchObject({
      perHour: 20, maxOpenChildren: 4, maxConcurrentPerUser: 8,
    });
    expect(parseSpawnLimits([1, 2])).toEqual(DEFAULT_SPAWN_LIMITS);
  });
});

describe('limitRefusal', () => {
  const ok = { parentDepth: 0, openChildren: 0, spawnsLastHour: 0, running: 0 };
  it('names the first limit broken, with a reason for the log', () => {
    expect(limitRefusal(ok)).toBeNull();
    expect(limitRefusal({ ...ok, parentDepth: 2 })?.reason).toBe('depth');
    expect(limitRefusal({ ...ok, openChildren: 4 })?.reason).toBe('open_children');
    expect(limitRefusal({ ...ok, spawnsLastHour: 20 })?.reason).toBe('rate');
    expect(limitRefusal({ ...ok, running: 8 })?.reason).toBe('concurrent');
    expect(limitRefusal({ ...ok, running: 8 }, { ...DEFAULT_SPAWN_LIMITS, maxConcurrentPerUser: 20 })).toBeNull();
  });
});

describe('boxHeat and boxRefusal', () => {
  it('reads memory, disk and load per core against the thresholds', () => {
    expect(boxHeat(box(), DEFAULT_SPAWN_LIMITS, now)).toEqual({ unknown: false, hot: [], warm: [] });
    expect(boxHeat(box({ memUsedPct: 91 }), DEFAULT_SPAWN_LIMITS, now).hot[0]).toMatch(/memory 91% \(limit 85%\)/);
    expect(boxHeat(box({ memUsedPct: 70 }), DEFAULT_SPAWN_LIMITS, now).warm[0]).toMatch(/memory 70%/);
    expect(boxHeat(box({ load1: 4 }), DEFAULT_SPAWN_LIMITS, now).hot[0]).toMatch(/load 2\.00\/core/);
  });

  it('skips load without a core count, and says nothing from a stale sample', () => {
    expect(boxHeat(box({ load1: 40, cores: null }), DEFAULT_SPAWN_LIMITS, now).hot).toEqual([]);
    expect(boxHeat(box({ memUsedPct: 99, sampledAt: new Date(now - SAMPLE_STALE_MS - 1) }), DEFAULT_SPAWN_LIMITS, now).unknown).toBe(true);
    expect(boxRefusal(box({ memUsedPct: 99, sampledAt: null }), DEFAULT_SPAWN_LIMITS, now)).toBeNull();
  });

  it('refuses a hot box, and a full one only when a cap is set', () => {
    expect(boxRefusal(box({ memUsedPct: 95 }), DEFAULT_SPAWN_LIMITS, now)?.reason).toBe('box_busy');
    expect(boxRefusal(box({ liveAgents: 9 }), DEFAULT_SPAWN_LIMITS, now)).toBeNull();
    expect(boxRefusal(box({ liveAgents: 3 }), { ...DEFAULT_SPAWN_LIMITS, boxCapacity: 3 }, now)?.reason).toBe('box_capacity');
  });
});

describe('suggestBox', () => {
  const L = DEFAULT_SPAWN_LIMITS;
  it('picks the coolest other box that would take the spawn', () => {
    const boxes = [box({ id: 'b1' }), box({ id: 'b2', memUsedPct: 30 }), box({ id: 'b3', memUsedPct: 10, diskUsedPct: 95 })].map(b => ({ box: b, limits: L }));
    expect(suggestBox(boxes, 'b1', now)?.box.id).toBe('b2');
    expect(suggestBox([{ box: box({ id: 'b1' }), limits: L }], 'b1', now)).toBeNull();
  });

  it('judges each candidate by the limits its own box is served', () => {
    const full = box({ id: 'b2', memUsedPct: 20, liveAgents: 3 });
    // At capacity under a cap of 3, but the flag gives this bigger box 6.
    expect(suggestBox([{ box: full, limits: { ...L, boxCapacity: 3 } }], 'b1', now)).toBeNull();
    expect(suggestBox([{ box: full, limits: { ...L, boxCapacity: 6 } }], 'b1', now)?.limits.boxCapacity).toBe(6);
  });
});

describe('spawnHints', () => {
  const used = { depth: 0, openHere: 1, lastHour: 2, running: 1 };
  const base = { limits: DEFAULT_SPAWN_LIMITS, used, box: box(), throttledProviders: [], finishedRunning: 0, now };

  it('is quiet when nothing is close', () => {
    expect(spawnHints(base)).toEqual([]);
  });

  it('names a hot or busy box, a throttled provider, finished agents and near limits', () => {
    const kinds = spawnHints({
      ...base, box: box({ memUsedPct: 90 }), throttledProviders: ['claude'], finishedRunning: 2,
      used: { ...used, lastHour: 17, running: 7 },
    }).map(h => h.kind);
    expect(kinds).toEqual(['box_hot', 'provider_throttled', 'finished_running', 'near_limit']);
    expect(spawnHints({ ...base, box: box({ memUsedPct: 72 }) })[0].kind).toBe('box_warm');
  });

  it('says full only with a cap', () => {
    expect(spawnHints({ ...base, box: box({ liveAgents: 3 }), limits: { ...DEFAULT_SPAWN_LIMITS, boxCapacity: 3 } })[0].kind).toBe('box_full');
  });

  it('counts finished agents only after they sat idle', () => {
    expect(FINISHED_IDLE_MS).toBe(30 * 60 * 1000);
  });
});

describe('boxHints', () => {
  it('names a hot box, a busy one, and a full one when a cap is set; nothing for a cool box', () => {
    expect(boxHints(box(), DEFAULT_SPAWN_LIMITS, now)).toEqual([]);
    expect(boxHints(box({ memUsedPct: 90 }), DEFAULT_SPAWN_LIMITS, now).map(h => h.kind)).toEqual(['box_hot']);
    expect(boxHints(box({ memUsedPct: 72 }), DEFAULT_SPAWN_LIMITS, now).map(h => h.kind)).toEqual(['box_warm']);
    expect(boxHints(box({ liveAgents: 3 }), { ...DEFAULT_SPAWN_LIMITS, boxCapacity: 3 }, now).map(h => h.kind)).toEqual(['box_full']);
  });
});

describe('endDecision', () => {
  const base = {
    project: { archived: false }, workstreamLive: true, boxStatus: 'ready', boxConnected: true,
    sessionLive: true, misses: 0, launched: true, ageMs: 60 * 60 * 1000,
  };

  it('ends on an archived project, a removed workstream or a terminated box', () => {
    expect(endDecision({ ...base, project: null })).toEqual({ end: 'archived' });
    expect(endDecision({ ...base, project: { archived: true } })).toEqual({ end: 'archived' });
    expect(endDecision({ ...base, workstreamLive: false })).toEqual({ end: 'removed' });
    expect(endDecision({ ...base, boxStatus: 'terminated' })).toEqual({ end: 'box_terminated' });
  });

  it('needs the session missing twice in a row before it ends', () => {
    expect(endDecision({ ...base, sessionLive: false })).toEqual({ misses: 1 });
    expect(endDecision({ ...base, sessionLive: false, misses: 1 })).toEqual({ end: 'killed' });
    expect(endDecision({ ...base, sessionLive: true, misses: 1 })).toEqual({ misses: 0 });
  });

  it('does not end a parked spawn because its pane is gone, but still ends one whose workstream went', () => {
    expect(endDecision({ ...base, parked: true, sessionLive: false, misses: 1 })).toEqual({ misses: 0 });
    expect(endDecision({ ...base, parked: true, workstreamLive: false })).toEqual({ end: 'removed' });
  });

  it('decides nothing for an offline box or a spawn still launching', () => {
    expect(endDecision({ ...base, boxConnected: false, sessionLive: null, misses: 1 })).toEqual({ misses: 1 });
    expect(endDecision({ ...base, boxStatus: 'stopped', boxConnected: false, sessionLive: null })).toEqual({ misses: 0 });
    expect(endDecision({ ...base, launched: false, ageMs: END_LAUNCH_GRACE_MS - 1, sessionLive: false })).toEqual({ misses: 0 });
    // A slow clone an hour in is still starting, inside the brief's claim window.
    expect(endDecision({ ...base, launched: false, ageMs: 60 * 60 * 1000, sessionLive: false })).toEqual({ misses: 0 });
    expect(END_LAUNCH_GRACE_MS).toBe(SPAWN_CLAIM_WINDOW_MS);
  });
});

describe('rebudget', () => {
  const b = (running: number, hints: Array<{ kind: HintKind; message: string }> = []) => ({
    limits: DEFAULT_SPAWN_LIMITS, used: { depth: 0, openHere: 1, lastHour: 3, running },
    box: null, finishedRunning: 0, hints,
  });

  it('counts the spawn and drops a near-limit hint the new counts no longer fit', () => {
    const r = rebudget(b(7, [{ kind: 'near_limit', message: 'close to a spawn limit: running 7/8' }]));
    expect(r.used).toEqual({ depth: 0, openHere: 2, lastHour: 4, running: 8 });
    expect(r.hints).toEqual([]);
  });

  it('adds the near-limit hint the spawn walked into', () => {
    expect(rebudget(b(6)).hints).toEqual([{ kind: 'near_limit', message: 'close to a spawn limit: running 7/8' }]);
  });

  it('keeps the hints one more spawn does not change', () => {
    const box = { kind: 'box_hot' as const, message: 'box b is running hot' };
    expect(rebudget(b(1, [box])).hints).toEqual([box]);
  });
});
