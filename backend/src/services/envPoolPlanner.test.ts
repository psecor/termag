import { describe, expect, it } from 'vitest';
import { holdingFailure, nextRefreshAt, pickSubnet, planEnvironmentPool, planEnvPoolRefresh, refreshDueAt, sameHeads, type EnvPoolFailureView, type EnvPoolPlanInput, type EnvPoolRefreshInput, type EnvPoolRowView } from './envPoolPlanner';

const NOW = new Date('2026-11-06T12:00:00Z');
const HEADS = { 'e2e-org/envdemo': 'a'.repeat(40) };
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

function row(over: Partial<EnvPoolRowView> & { id: string }): EnvPoolRowView {
  return {
    status: 'env-stopped', poolSetupHash: 'h1', preparedCommit: HEADS, preparedAt: ago(30), createdAt: ago(40), subnetId: 'subnet-a',
    refreshStartedAt: null, refreshCheckedAt: null,
    ...over,
  };
}

function plan(over: Partial<EnvPoolPlanInput>) {
  return planEnvironmentPool({
    rows: [], current: { ok: true, hash: 'h1', heads: HEADS }, target: 3, headroom: 2,
    subnets: ['subnet-a', 'subnet-b', 'subnet-c'], prepareTimeoutMs: 45 * 60_000, now: NOW, ...over,
  });
}

describe('planEnvironmentPool: counts', () => {
  it('launches to the target, capped by the in-flight headroom', () => {
    const one = [row({ id: 's0' })];
    expect(plan({ rows: one }).launch).toHaveLength(2);
    expect(plan({ rows: one, target: 5, headroom: 5 }).launch).toHaveLength(4);
    expect(plan({ rows: one, headroom: 0 }).launch).toHaveLength(0);
  });

  it('launches one at a time until a box has prepared at the current hash, so a broken setup costs one box', () => {
    expect(plan({ headroom: 5 }).launch).toHaveLength(1);
    expect(plan({ headroom: 5, rows: [row({ id: 'p1', status: 'env-preparing', preparedAt: null, createdAt: ago(5) })] }).launch).toHaveLength(0);
  });

  it('counts boxes still preparing as supply', () => {
    const p = plan({ rows: [row({ id: 's1' }), row({ id: 'p1', status: 'env-preparing', preparedAt: null, createdAt: ago(5) })] });
    expect(p.supply).toEqual({ stopped: 1, preparing: 1 });
    expect(p.launch).toHaveLength(1);
  });

  it('counts a box being stopped as prepared', () => {
    const p = plan({ target: 1, rows: [row({ id: 's1', status: 'env-stopping' })] });
    expect(p.launch).toHaveLength(0);
    expect(p.stoppedRows).toEqual([]);
  });

  it('does not count a box a claim is starting, and never retires it', () => {
    const p = plan({ target: 1, rows: [row({ id: 'c1', status: 'env-starting' })] });
    expect(p.launch).toHaveLength(1);
    expect(p.retire).toEqual([]);
  });

  it('retires the oldest prepared beyond the target and keeps the newest', () => {
    const p = plan({
      target: 1, rows: [row({ id: 'old', preparedAt: ago(90) }), row({ id: 'new', preparedAt: ago(10) })],
    });
    expect(p.retire).toEqual([{ id: 'old', reason: 'surplus' }]);
    expect(p.stoppedRows).toEqual(['new']);
  });

  it('drains everything but a starting box when the environment has no pool', () => {
    const p = plan({
      target: 0,
      rows: [row({ id: 's1' }), row({ id: 'p1', status: 'env-preparing' }), row({ id: 'c1', status: 'env-starting' })],
    });
    expect(p.launch).toEqual([]);
    expect(p.retire.map(r => r.id).sort()).toEqual(['p1', 's1']);
    expect(p.retire.every(r => r.reason === 'drain')).toBe(true);
  });
});

describe('planEnvironmentPool: stale rows', () => {
  it('retires a box prepared for another setup hash and replaces it', () => {
    const p = plan({ target: 1, rows: [row({ id: 'stale', poolSetupHash: 'h0' })] });
    expect(p.retire).toEqual([{ id: 'stale', reason: 'stale' }]);
    expect(p.launch).toHaveLength(1);
  });

  it('holds the pool as it is when the environment could not be resolved', () => {
    const p = plan({ current: { ok: false, reason: 'GitHub said 502' }, rows: [row({ id: 's1', poolSetupHash: 'h0' })] });
    expect(p.retire).toEqual([]);
    expect(p.launch).toEqual([]);
  });
});

describe('planEnvironmentPool: one failure rule', () => {
  // A failed prepare or refresh, whatever failed (its launch, the image, a clone, setup, a timeout): a terminated row
  // that keeps the setup hash and heads it ran at, and when it failed.
  const HOLD = 60 * 60_000;
  const failure = (min: number, over: Partial<EnvPoolFailureView> = {}): EnvPoolFailureView =>
    ({ id: 'f1', poolSetupHash: 'h1', preparedCommit: HEADS, failedAt: ago(min), ...over });

  it('holds launches at the hash and heads it failed at, for an hour', () => {
    const p = plan({ lastFailure: failure(20), holdMs: HOLD });
    expect(p.launch).toEqual([]);
    expect(p.held).toEqual({ rowId: 'f1', until: new Date(ago(20).getTime() + HOLD) });
  });

  it('lets go after the hour: a transient failure recovers on its own, a broken setup costs one box an hour', () => {
    const p = plan({ lastFailure: failure(61), holdMs: HOLD });
    expect(p.held).toBeNull();
    expect(p.launch).toHaveLength(1);
  });

  it('lets go at once when the setup hash changed (a new image, a changed setup)', () => {
    const p = plan({ lastFailure: failure(5, { poolSetupHash: 'h0' }), holdMs: HOLD });
    expect(p.held).toBeNull();
    expect(p.launch).toHaveLength(1);
  });

  it('lets go at once when a default branch moved past it', () => {
    const p = plan({ lastFailure: failure(5, { preparedCommit: { 'e2e-org/envdemo': 'b'.repeat(40) } }), holdMs: HOLD });
    expect(p.held).toBeNull();
    expect(p.launch).toHaveLength(1);
  });

  it('a failure that recorded no heads holds nothing', () => {
    expect(plan({ lastFailure: failure(5, { preparedCommit: null }), holdMs: HOLD }).held).toBeNull();
  });

  it('holds nothing while the environment is unresolved (nothing is launched then anyway)', () => {
    const p = plan({ current: { ok: false, reason: 'GitHub said 502' }, lastFailure: failure(5), holdMs: HOLD });
    expect(p.held).toBeNull();
    expect(p.launch).toEqual([]);
  });

  it('fails a box that has been preparing past the window', () => {
    const p = plan({ rows: [row({ id: 'p1', status: 'env-preparing', preparedAt: null, createdAt: ago(46) })] });
    expect(p.fail).toEqual([{ id: 'p1', reason: 'prepare timed out after 45 min' }]);
    // Its slot is free again this tick: one probe, until a box prepares at the current hash.
    expect(p.launch).toHaveLength(1);
  });
});

describe('planEnvironmentPool: zones', () => {
  it('spreads launches over the subnets with the fewest of this environment', () => {
    const p = plan({ target: 4, headroom: 3, rows: [row({ id: 's1', subnetId: 'subnet-a' })] });
    expect(p.launch.map(l => l.subnetId)).toEqual(['subnet-b', 'subnet-c', 'subnet-a']);
  });

  it('does not count a box it is retiring', () => {
    const p = plan({ target: 1, headroom: 1, rows: [row({ id: 'stale', subnetId: 'subnet-a', poolSetupHash: 'h0' })] });
    expect(p.launch).toEqual([{ subnetId: 'subnet-a' }]);
  });

  it('launches with no subnet when none is configured', () => {
    expect(plan({ subnets: [], target: 1 }).launch).toEqual([{ subnetId: null }]);
    expect(pickSubnet([], new Map())).toBeNull();
  });
});

describe('sameHeads', () => {
  it('compares every repository', () => {
    expect(sameHeads({ a: '1', b: '2' }, { b: '2', a: '1' })).toBe(true);
    expect(sameHeads({ a: '1' }, { a: '1', b: '2' })).toBe(false);
    expect(sameHeads(null, {})).toBe(false);
  });
});

describe('planEnvironmentPool: a refresh in flight', () => {
  it("times a refresh out from its start, not from the box's launch hours ago", () => {
    const refreshing = row({ id: 'r1', status: 'env-preparing', createdAt: ago(600), refreshStartedAt: ago(5) });
    expect(plan({ rows: [refreshing] }).fail).toEqual([]);
    const stuck = row({ id: 'r2', status: 'env-preparing', createdAt: ago(600), refreshStartedAt: ago(50) });
    expect(plan({ rows: [stuck] }).fail).toEqual([{ id: 'r2', reason: 'prepare timed out after 45 min' }]);
  });

  it('counts a refreshing box as preparing supply, and never names it in stoppedRows (not claimable)', () => {
    const p = plan({ rows: [row({ id: 's1' }), row({ id: 'r1', status: 'env-preparing', refreshStartedAt: ago(2) })] });
    expect(p.supply).toEqual({ stopped: 1, preparing: 1 });
    expect(p.stoppedRows).toEqual(['s1']);
  });
});

describe('planEnvPoolRefresh', () => {
  const HOUR = 60 * 60_000;
  const MOVED = { 'e2e-org/envdemo': 'b'.repeat(40) };
  function refresh(over: Partial<EnvPoolRefreshInput>) {
    const rows = over.rows ?? [];
    return planEnvPoolRefresh({
      rows, stoppedRows: rows.map(r => r.id), current: { ok: true, hash: 'h1', heads: HEADS },
      held: null, intervalMs: HOUR, now: NOW, ...over,
    });
  }

  it('skips a due row whose every default-branch head is the one it was prepared at', () => {
    expect(refresh({ rows: [row({ id: 's1', preparedAt: ago(61) })] })).toEqual({ refresh: [], skip: [{ id: 's1', reason: 'unchanged' }] });
  });

  it('refreshes a due row when a default branch moved, oldest prepared first', () => {
    const rows = [row({ id: 'new', preparedAt: ago(70) }), row({ id: 'old', preparedAt: ago(200) })];
    // One first (the probe below); the order is the plan's.
    expect(refresh({ rows, current: { ok: true, hash: 'h1', heads: MOVED } }).refresh).toEqual(['old']);
    const proven = row({ id: 'p', preparedAt: ago(5), preparedCommit: MOVED });
    expect(refresh({ rows: [...rows, proven], stoppedRows: ['new', 'old'], current: { ok: true, hash: 'h1', heads: MOVED } }).refresh).toEqual(['old', 'new']);
  });

  it('refreshes when one repository of several moved', () => {
    const two = { 'o/a': 'a'.repeat(40), 'o/b': 'b'.repeat(40) };
    const r = row({ id: 's1', preparedAt: ago(90), preparedCommit: two });
    expect(refresh({ rows: [r], current: { ok: true, hash: 'h1', heads: two } }).refresh).toEqual([]);
    expect(refresh({ rows: [r], current: { ok: true, hash: 'h1', heads: { ...two, 'o/b': 'c'.repeat(40) } } }).refresh).toEqual(['s1']);
  });

  it('leaves a row alone until an interval after it was prepared or last checked', () => {
    const moved = { current: { ok: true as const, hash: 'h1', heads: MOVED } };
    expect(refresh({ ...moved, rows: [row({ id: 's1', preparedAt: ago(59) })] }).refresh).toEqual([]);
    expect(refresh({ ...moved, rows: [row({ id: 's1', preparedAt: ago(120), refreshCheckedAt: ago(30) })] }).refresh).toEqual([]);
    expect(refresh({ ...moved, rows: [row({ id: 's1', preparedAt: ago(120), refreshCheckedAt: ago(60) })] }).refresh).toEqual(['s1']);
  });

  it('checks nothing while the environment is unresolved', () => {
    expect(refresh({ rows: [row({ id: 's1', preparedAt: ago(200) })], current: { ok: false, reason: 'GitHub down' } })).toEqual({ refresh: [], skip: [] });
  });

  it('checks nothing while a failure holds the pool, so each row is still due once it lets go', () => {
    const rows = [row({ id: 's1', preparedAt: ago(200) })];
    const held = { rowId: 'f1', until: new Date(NOW.getTime() + 60_000) };
    expect(refresh({ rows, held, current: { ok: true, hash: 'h1', heads: MOVED } })).toEqual({ refresh: [], skip: [] });
    expect(refresh({ rows, held: null, current: { ok: true, hash: 'h1', heads: MOVED } }).refresh).toEqual(['s1']);
  });

  it('considers only the plan\'s stopped rows: not stale, surplus or preparing ones', () => {
    const rows = [row({ id: 's1', preparedAt: ago(200) }), row({ id: 'p1', status: 'env-preparing', preparedAt: ago(200) })];
    const p = refresh({ rows, stoppedRows: ['p1'], current: { ok: true, hash: 'h1', heads: MOVED } });
    expect(p).toEqual({ refresh: [], skip: [] });
  });

  it('dates the next check: the soonest due, never before now, null with nothing stopped', () => {
    const a = row({ id: 'a', preparedAt: ago(20) });
    const b = row({ id: 'b', preparedAt: ago(200), refreshCheckedAt: ago(10) });
    expect(refreshDueAt(a, HOUR)).toEqual(new Date(NOW.getTime() + 40 * 60_000));
    expect(nextRefreshAt([a, b], HOUR, NOW)).toEqual(new Date(NOW.getTime() + 40 * 60_000));
    expect(nextRefreshAt([row({ id: 'c', preparedAt: ago(300) })], HOUR, NOW)).toEqual(NOW);
    expect(nextRefreshAt([], HOUR, NOW)).toBeNull();
  });
});

describe('planEnvironmentPool and planEnvPoolRefresh: a failed refresh holds both, at the heads it refreshed to', () => {
  const MOVED = { 'e2e-org/envdemo': 'b'.repeat(40) };
  it('holds the refresh of the other rows and new launches, until the hour or a head moves', () => {
    const current = { ok: true as const, hash: 'h1', heads: MOVED };
    const due = row({ id: 's1', preparedAt: ago(200) });
    const failed = { id: 'f1', poolSetupHash: 'h1', preparedCommit: MOVED, failedAt: ago(5) };
    const p = plan({ rows: [due], current, target: 2, lastFailure: failed, holdMs: 60 * 60_000 });
    expect(p.held?.rowId).toBe('f1');
    expect(p.launch).toEqual([]);
    expect(planEnvPoolRefresh({ rows: [due], stoppedRows: p.stoppedRows, current, held: p.held, intervalMs: 60 * 60_000, now: NOW })).toEqual({ refresh: [], skip: [] });
    const later = { ok: true as const, hash: 'h1', heads: { 'e2e-org/envdemo': 'c'.repeat(40) } };
    const q = plan({ rows: [due], current: later, target: 2, lastFailure: failed, holdMs: 60 * 60_000 });
    expect(q.held).toBeNull();
    expect(planEnvPoolRefresh({ rows: [due], stoppedRows: q.stoppedRows, current: later, held: q.held, intervalMs: 60 * 60_000, now: NOW }).refresh).toEqual(['s1']);
  });
});

describe("nextRefreshAt and the failure hold (Bugbot on #1455)", () => {
  const HOUR = 60 * 60_000;
  const due = row({ id: 's1', preparedAt: ago(200) });
  const current = { ok: true as const, hash: 'h1', heads: HEADS };
  const failed = { id: 'f1', poolSetupHash: 'h1', preparedCommit: HEADS, failedAt: ago(3) };

  it("dates the next check no earlier than the end of the plan's hold, when nothing is checked", () => {
    const p = plan({ rows: [due], current, lastFailure: failed, holdMs: 10 * 60_000 });
    const until = new Date(NOW.getTime() + 7 * 60_000);
    expect(p.held).toEqual({ rowId: 'f1', until });
    expect(nextRefreshAt([due], HOUR, NOW, p.held?.until ?? null)).toEqual(until);
    // A check due after the hold is unchanged by it.
    expect(nextRefreshAt([row({ id: 's2', preparedAt: ago(10) })], HOUR, NOW, until)).toEqual(new Date(NOW.getTime() + 50 * 60_000));
    expect(nextRefreshAt([due], HOUR, NOW, null)).toEqual(NOW);
  });
});

describe('planEnvPoolRefresh probes one box at new heads first (Bugbot on #1455)', () => {
  const HOUR = 60 * 60_000;
  const MOVED = { 'e2e-org/envdemo': 'b'.repeat(40) };
  const current = { ok: true as const, hash: 'h1', heads: MOVED };
  const a = row({ id: 'a', preparedAt: ago(200) });
  const b = row({ id: 'b', preparedAt: ago(201) });
  const refresh = (rows: EnvPoolRowView[], stoppedRows = rows.filter(r => r.status === 'env-stopped').map(r => r.id)) =>
    planEnvPoolRefresh({ rows, stoppedRows, current, held: null, intervalMs: HOUR, now: NOW });

  it('refreshes one box until a box has prepared at the new heads, so a broken setup costs one box', () => {
    expect(refresh([a, b]).refresh).toEqual(['b']);
  });

  it('starts no second one while that probe (or a launch at the new heads) is still preparing', () => {
    const probing = row({ id: 'b', status: 'env-preparing', refreshStartedAt: ago(1), preparedCommit: MOVED });
    expect(refresh([a, probing], ['a'])).toEqual({ refresh: [], skip: [] });
    const launching = row({ id: 'l', status: 'env-preparing', preparedAt: null, createdAt: ago(1), preparedCommit: MOVED });
    expect(refresh([a, launching], ['a']).refresh).toEqual([]);
  });

  it('refreshes the rest together once one box prepared at the new heads', () => {
    const c = row({ id: 'c', preparedAt: ago(202) });
    const done = row({ id: 'd', status: 'env-stopped', preparedAt: ago(1), preparedCommit: MOVED });
    expect(refresh([a, b, c, done], ['a', 'b', 'c']).refresh).toEqual(['c', 'b', 'a']);
  });

  it('keeps the one-box probe while a probe at older heads is still preparing: it says nothing about these', () => {
    const older = row({ id: 'o', status: 'env-preparing', refreshStartedAt: ago(1), preparedCommit: { 'e2e-org/envdemo': 'c'.repeat(40) } });
    expect(refresh([a, b, older], ['a', 'b']).refresh).toEqual(['b']);
  });
});

describe('planEnvPoolRefresh counts this tick\'s launches as the probe (Bugbot on #1455)', () => {
  const MOVED = { 'e2e-org/envdemo': 'b'.repeat(40) };
  const a = row({ id: 'a', preparedAt: ago(200) });
  const input = { rows: [a], stoppedRows: ['a'], current: { ok: true as const, hash: 'h1', heads: MOVED }, held: null, intervalMs: 60 * 60_000, now: NOW };

  it('starts no refresh in a tick that launches a box at the new heads, until a box has prepared at them', () => {
    expect(planEnvPoolRefresh({ ...input, launched: 1 }).refresh).toEqual([]);
    expect(planEnvPoolRefresh({ ...input, launched: 0 }).refresh).toEqual(['a']);
  });

  it('lets the refreshes go with a launch once a box has prepared at the new heads', () => {
    const proven = row({ id: 'p', preparedAt: ago(5), preparedCommit: MOVED });
    expect(planEnvPoolRefresh({ ...input, rows: [a, proven], launched: 1 }).refresh).toEqual(['a']);
  });
});

describe('planEnvPoolRefresh keeps a held row due (Bugbot on #1455)', () => {
  const MOVED = { 'e2e-org/envdemo': 'b'.repeat(40) };
  it("leaves a row a failed setup holds back unchecked, so it refreshes as soon as the hold lifts, not an interval later", () => {
    const a = row({ id: 'a', preparedAt: ago(200) });
    const input = { rows: [a], stoppedRows: ['a'], intervalMs: 60 * 60_000, now: NOW };
    const held = planEnvPoolRefresh({ ...input, current: { ok: true, hash: 'h1', heads: MOVED }, held: { rowId: 'f1', until: new Date(NOW.getTime() + 60 * 60_000) } });
    expect(held).toEqual({ refresh: [], skip: [] });
    // The broken commit is fixed: new heads, no hold, and the row is still due.
    const fixed = planEnvPoolRefresh({ ...input, current: { ok: true, hash: 'h1', heads: { 'e2e-org/envdemo': 'c'.repeat(40) } }, held: null, now: new Date(NOW.getTime() + 60_000) });
    expect(fixed.refresh).toEqual(['a']);
  });
});

describe('holdingFailure: the failure that holds the pool at the current hash and heads (Devin on #1464)', () => {
  const A = { 'e2e-org/envdemo': 'a'.repeat(40) };
  const B = { 'e2e-org/envdemo': 'b'.repeat(40) };
  const at = (min: number) => new Date(NOW.getTime() - min * 60_000);
  const failures = [
    { id: 'fB', poolSetupHash: 'h1', preparedCommit: B, failedAt: at(5) },
    { id: 'fA', poolSetupHash: 'h1', preparedCommit: A, failedAt: at(20) },
  ];
  it("finds A's failure when the branch went back to A after a newer failure at B", () => {
    expect(holdingFailure(failures, { ok: true, hash: 'h1', heads: A })?.id).toBe('fA');
    expect(holdingFailure(failures, { ok: true, hash: 'h1', heads: B })?.id).toBe('fB');
  });
  it('finds none at another hash or heads, or unresolved', () => {
    expect(holdingFailure(failures, { ok: true, hash: 'h2', heads: A })).toBeNull();
    expect(holdingFailure(failures, { ok: true, hash: 'h1', heads: { 'e2e-org/envdemo': 'c'.repeat(40) } })).toBeNull();
    expect(holdingFailure(failures, { ok: false, reason: 'down' })).toBeNull();
  });
});
