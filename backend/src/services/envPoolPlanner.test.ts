import { describe, expect, it } from 'vitest';
import { envPoolRetryAt, nextRefreshAt, pickSubnet, planEnvironmentPool, planEnvPoolRefresh, refreshDueAt, sameHeads, type EnvPoolPlanInput, type EnvPoolRefreshInput, type EnvPoolRowView } from './envPoolPlanner';

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

describe('planEnvironmentPool: failures', () => {
  const failed = row({ id: 'f1', status: 'env-failed', preparedAt: null, setupFailed: true, createdAt: ago(20) });

  it('launches nothing after a failure at the current setup and heads', () => {
    const p = plan({ rows: [failed] });
    expect(p.blocked).toEqual({ rowId: 'f1' });
    expect(p.launch).toEqual([]);
    expect(p.retire).toEqual([]);
  });

  it('launches again once the setup text changed (a new hash)', () => {
    const p = plan({ current: { ok: true, hash: 'h2', heads: HEADS }, rows: [failed] });
    expect(p.blocked).toBeNull();
    expect(p.launch).toHaveLength(1);
    // The newest failure is kept for the page until a box prepares after it.
    expect(p.retire).toEqual([]);
  });

  it('launches again once a default branch moved', () => {
    const p = plan({ current: { ok: true, hash: 'h1', heads: { 'e2e-org/envdemo': 'b'.repeat(40) } }, rows: [failed] });
    expect(p.blocked).toBeNull();
    expect(p.launch).toHaveLength(1);
  });

  it('retires a failure once a later box prepared, and older failures at once', () => {
    const older = row({ id: 'f0', status: 'env-failed', preparedAt: null, createdAt: ago(200), poolSetupHash: 'h0' });
    const later = row({ id: 's1', preparedAt: ago(5) });
    const p = plan({ current: { ok: true, hash: 'h1', heads: { x: 'y' } }, rows: [older, failed, later] });
    expect(p.retire.map(r => r.id).sort()).toEqual(['f0', 'f1']);
  });

  it('fails a box that has been preparing past the window', () => {
    const p = plan({ rows: [row({ id: 'p1', status: 'env-preparing', preparedAt: null, createdAt: ago(46) })] });
    expect(p.fail).toEqual([{ id: 'p1', reason: 'prepare timed out after 45 min' }]);
    // Its slot is free again this tick.
    expect(p.launch).toHaveLength(1);
  });
});

describe('planEnvironmentPool: failures that are not setup\'s', () => {
  // A launch error, an old image, a clone or a timeout: the row keeps the hash and heads it launched at, and
  // setupFailed is false.
  const other = (min: number, over: Partial<EnvPoolRowView> = {}) =>
    row({ id: 'o1', status: 'env-failed', preparedAt: null, setupFailed: false, createdAt: ago(min + 1), terminatedAt: ago(min), ...over });
  const COOLDOWN = 10 * 60_000;

  it('never holds the pool, at the current hash and heads', () => {
    const p = plan({ rows: [other(30)], retryAfterMs: COOLDOWN });
    expect(p.blocked).toBeNull();
    expect(p.launch).toHaveLength(1);
  });

  it('spaces out the retries of the definition it failed for', () => {
    const p = plan({ rows: [row({ id: 's1' }), other(3)], retryAfterMs: COOLDOWN });
    expect(p.blocked).toBeNull();
    expect(p.launch).toEqual([]);
    expect(p.retryAt).toEqual(new Date(ago(3).getTime() + COOLDOWN));
  });

  it('does not delay a new definition: a failure at an old setup hash (a new image, a changed setup) inside the cooldown', () => {
    const p = plan({ rows: [other(3, { poolSetupHash: 'h0' })], retryAfterMs: COOLDOWN });
    expect(p.retryAt).toBeNull();
    expect(p.launch).toHaveLength(1);
  });

  it('does not delay a new definition for a failure that recorded no heads either', () => {
    const p = plan({ rows: [other(3, { poolSetupHash: 'h0', preparedCommit: null })], retryAfterMs: COOLDOWN });
    expect(p.retryAt).toBeNull();
    expect(p.launch).toHaveLength(1);
  });

  it('does not delay once a default branch moved past the failure', () => {
    const p = plan({ rows: [other(3, { preparedCommit: { 'e2e-org/envdemo': 'b'.repeat(40) } })], retryAfterMs: COOLDOWN });
    expect(p.retryAt).toBeNull();
    expect(p.launch).toHaveLength(1);
  });

  it('while a setup that ran and failed still holds it, at its hash and heads only', () => {
    const failed = row({ id: 'f1', status: 'env-failed', preparedAt: null, setupFailed: true, createdAt: ago(20) });
    expect(plan({ rows: [failed], retryAfterMs: COOLDOWN }).blocked).toEqual({ rowId: 'f1' });
    expect(plan({ rows: [{ ...failed, poolSetupHash: 'h0' }], retryAfterMs: COOLDOWN }).blocked).toBeNull();
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
      blocked: false, intervalMs: HOUR, now: NOW, ...over,
    });
  }

  it('skips a due row whose every default-branch head is the one it was prepared at', () => {
    expect(refresh({ rows: [row({ id: 's1', preparedAt: ago(61) })] })).toEqual({ refresh: [], skip: [{ id: 's1', reason: 'unchanged' }], held: [] });
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
    expect(refresh({ rows: [row({ id: 's1', preparedAt: ago(200) })], current: { ok: false, reason: 'GitHub down' } })).toEqual({ refresh: [], skip: [], held: [] });
  });

  it('holds a refresh while a failed prepare at these heads holds the pool', () => {
    const rows = [row({ id: 's1', preparedAt: ago(200) })];
    expect(refresh({ rows, blocked: true, current: { ok: true, hash: 'h1', heads: MOVED } })).toEqual({ refresh: [], skip: [], held: ['s1'] });
  });

  it('considers only the plan\'s stopped rows: not stale, surplus or preparing ones', () => {
    const rows = [row({ id: 's1', preparedAt: ago(200) }), row({ id: 'p1', status: 'env-preparing', preparedAt: ago(200) })];
    const p = refresh({ rows, stoppedRows: ['p1'], current: { ok: true, hash: 'h1', heads: MOVED } });
    expect(p).toEqual({ refresh: [], skip: [], held: [] });
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

describe('planEnvironmentPool: a failed refresh', () => {
  it("dates a failed refresh from the refresh, so a box prepared before it doesn't supersede it", () => {
    // Launched ten hours ago, refreshed (and failed) five minutes ago; the other box was prepared an hour ago.
    const failed = row({ id: 'f1', status: 'env-failed', createdAt: ago(600), refreshStartedAt: ago(5), preparedCommit: { 'e2e-org/envdemo': 'b'.repeat(40) } });
    const p = plan({ rows: [failed, row({ id: 's1', preparedAt: ago(60) })] });
    expect(p.retire).toEqual([]);
  });
  it('holds the pool when a refresh failed at the current heads, as a failed prepare does', () => {
    const failed = row({ id: 'f1', status: 'env-failed', createdAt: ago(600), refreshStartedAt: ago(5), setupFailed: true });
    expect(plan({ rows: [failed, row({ id: 's1' })] }).blocked).toEqual({ rowId: 'f1' });
    // The same failure before setup ran (its fetch, a timeout) doesn't hold it.
    expect(plan({ rows: [{ ...failed, setupFailed: false }, row({ id: 's1' })] }).blocked).toBeNull();
  });
});

describe('planEnvPoolRefresh and #1453\'s failure kinds', () => {
  const HOUR = 60 * 60_000;
  const MOVED = { 'e2e-org/envdemo': 'b'.repeat(40) };
  const due = row({ id: 's1', preparedAt: ago(200) });

  it('is blocked only by a setup that ran and failed (its heads kept), not by any env-failed row', () => {
    // Both keep the hash and the heads the refresh started at (#1453's 47e76cd5); poolSetupFailed tells them apart.
    const setupFailed = row({ id: 'f1', status: 'env-failed', refreshStartedAt: ago(30), terminatedAt: ago(29), preparedCommit: MOVED, setupFailed: true });
    const otherFailed = row({ id: 'f2', status: 'env-failed', refreshStartedAt: ago(30), terminatedAt: ago(29), preparedCommit: MOVED, setupFailed: false });
    const current = { ok: true as const, hash: 'h1', heads: MOVED };
    const withSetup = plan({ rows: [due, setupFailed], current });
    expect(withSetup.blocked).toEqual({ rowId: 'f1' });
    expect(planEnvPoolRefresh({ rows: [due, setupFailed], stoppedRows: withSetup.stoppedRows, current, blocked: !!withSetup.blocked, retryAt: withSetup.retryAt, intervalMs: HOUR, now: NOW }))
      .toEqual({ refresh: [], skip: [], held: ['s1'] });
    const withOther = plan({ rows: [due, otherFailed], current, retryAfterMs: 10 * 60_000 });
    expect(withOther.blocked).toBeNull();
    // Older than ENV_POOL_RETRY_MS: no wait left, so the row is refreshed.
    expect(withOther.retryAt).toBeNull();
    expect(planEnvPoolRefresh({ rows: [due, otherFailed], stoppedRows: withOther.stoppedRows, current, blocked: !!withOther.blocked, retryAt: withOther.retryAt, intervalMs: HOUR, now: NOW }).refresh).toEqual(['s1']);
  });

  it("waits out the plan's retryAt after a failure that wasn't setup's, checking nothing so the row stays due", () => {
    const recent = row({ id: 'f2', status: 'env-failed', refreshStartedAt: ago(4), terminatedAt: ago(3), preparedCommit: MOVED, setupFailed: false });
    const current = { ok: true as const, hash: 'h1', heads: MOVED };
    const p = plan({ rows: [due, recent], current, retryAfterMs: 10 * 60_000 });
    expect(p.retryAt).toEqual(new Date(NOW.getTime() + 7 * 60_000));
    const input = { rows: [due, recent], stoppedRows: p.stoppedRows, current, blocked: !!p.blocked, retryAt: p.retryAt, intervalMs: HOUR };
    expect(planEnvPoolRefresh({ ...input, now: NOW })).toEqual({ refresh: [], skip: [], held: [] });
    expect(planEnvPoolRefresh({ ...input, now: new Date(NOW.getTime() + 8 * 60_000) }).refresh).toEqual(['s1']);
  });

  it('waits only for a failure at the current hash and heads: a refresh to a newer commit goes at once', () => {
    const NEWER = { 'e2e-org/envdemo': 'c'.repeat(40) };
    const recent = row({ id: 'f2', status: 'env-failed', refreshStartedAt: ago(4), terminatedAt: ago(3), preparedCommit: MOVED, setupFailed: false });
    const current = { ok: true as const, hash: 'h1', heads: NEWER };
    const p = plan({ rows: [due, recent], current, retryAfterMs: 10 * 60_000 });
    expect(p.retryAt).toBeNull();
    expect(p.blocked).toBeNull();
    expect(planEnvPoolRefresh({ rows: [due, recent], stoppedRows: p.stoppedRows, current, blocked: false, retryAt: p.retryAt, intervalMs: HOUR, now: NOW }).refresh).toEqual(['s1']);
  });
});

describe("nextRefreshAt and the retry wait (Bugbot on #1455)", () => {
  const HOUR = 60 * 60_000;
  const due = row({ id: 's1', preparedAt: ago(200) });
  const failed = row({ id: 'f1', status: 'env-failed', refreshStartedAt: ago(4), terminatedAt: ago(3), setupFailed: false });
  const current = { ok: true as const, hash: 'h1', heads: HEADS };

  it("is the plan's retryAt: the same failures at the current hash and heads, only while it is ahead", () => {
    expect(envPoolRetryAt([due, failed], current, 10 * 60_000, NOW)).toEqual(new Date(NOW.getTime() + 7 * 60_000));
    expect(plan({ rows: [due, failed], current, retryAfterMs: 10 * 60_000 }).retryAt).toEqual(envPoolRetryAt([due, failed], current, 10 * 60_000, NOW));
    expect(envPoolRetryAt([due, failed], current, 2 * 60_000, NOW)).toBeNull();
    expect(envPoolRetryAt([due, { ...failed, setupFailed: true }], current, 10 * 60_000, NOW)).toBeNull();
    expect(envPoolRetryAt([due, failed], { ok: true, hash: 'h2', heads: HEADS }, 10 * 60_000, NOW)).toBeNull();
    expect(envPoolRetryAt([due, failed], { ok: false, reason: 'down' }, 10 * 60_000, NOW)).toBeNull();
  });

  it('dates the next check no earlier than the end of the wait, when nothing is checked', () => {
    const retryAt = new Date(NOW.getTime() + 7 * 60_000);
    expect(nextRefreshAt([due], HOUR, NOW, retryAt)).toEqual(retryAt);
    // A check due after the wait is unchanged by it.
    expect(nextRefreshAt([row({ id: 's2', preparedAt: ago(10) })], HOUR, NOW, retryAt)).toEqual(new Date(NOW.getTime() + 50 * 60_000));
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
    planEnvPoolRefresh({ rows, stoppedRows, current, blocked: false, intervalMs: HOUR, now: NOW });

  it('refreshes one box until a box has prepared at the new heads, so a broken setup costs one box', () => {
    expect(refresh([a, b]).refresh).toEqual(['b']);
  });

  it('starts no second one while that probe (or a launch at the new heads) is still preparing', () => {
    const probing = row({ id: 'b', status: 'env-preparing', refreshStartedAt: ago(1), preparedCommit: MOVED });
    expect(refresh([a, probing], ['a'])).toEqual({ refresh: [], skip: [], held: [] });
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
  const input = { rows: [a], stoppedRows: ['a'], current: { ok: true as const, hash: 'h1', heads: MOVED }, blocked: false, intervalMs: 60 * 60_000, now: NOW };

  it('starts no refresh in a tick that launches a box at the new heads, until a box has prepared at them', () => {
    expect(planEnvPoolRefresh({ ...input, launched: 1 }).refresh).toEqual([]);
    expect(planEnvPoolRefresh({ ...input, launched: 0 }).refresh).toEqual(['a']);
  });

  it('lets the refreshes go with a launch once a box has prepared at the new heads', () => {
    const proven = row({ id: 'p', preparedAt: ago(5), preparedCommit: MOVED });
    expect(planEnvPoolRefresh({ ...input, rows: [a, proven], launched: 1 }).refresh).toEqual(['a']);
  });
});

describe('planEnvPoolRefresh holds a blocked row due (Bugbot on #1455)', () => {
  const MOVED = { 'e2e-org/envdemo': 'b'.repeat(40) };
  it("leaves a row a failed setup holds back unchecked, so it refreshes as soon as the hold lifts, not an interval later", () => {
    const a = row({ id: 'a', preparedAt: ago(200) });
    const input = { rows: [a], stoppedRows: ['a'], intervalMs: 60 * 60_000, now: NOW };
    const held = planEnvPoolRefresh({ ...input, current: { ok: true, hash: 'h1', heads: MOVED }, blocked: true });
    expect(held.skip).toEqual([]);
    expect(held.held).toEqual(['a']);
    // The broken commit is fixed: new heads, no hold, and the row is still due.
    const fixed = planEnvPoolRefresh({ ...input, current: { ok: true, hash: 'h1', heads: { 'e2e-org/envdemo': 'c'.repeat(40) } }, blocked: false, now: new Date(NOW.getTime() + 60_000) });
    expect(fixed.refresh).toEqual(['a']);
  });
});
