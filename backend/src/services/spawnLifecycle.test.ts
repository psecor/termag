import { describe, expect, it } from 'vitest';
import { branchStateFromRpc, lifecycleLabel, lifecycleStep, retireCheck, retireNow } from './spawnLifecycle';

const now = Date.parse('2026-10-18T12:00:00Z');
const MIN = 60_000;
const row = (over = {}) => ({
  relationship: 'delegate', state: 'done', reportedAt: new Date(now - 60 * MIN), parkedAt: null as Date | null,
  retiredAt: null, endedAt: null, ...over,
});
const ctx = (over = {}) => ({ paneStatus: 'idle', paneSince: now - 45 * MIN, parkIdleMs: 30 * MIN, now, ...over });

describe('retireCheck', () => {
  it('keeps uncommitted work, unpushed commits, and anything it cannot count', () => {
    expect(retireCheck(null)).toMatchObject({ ok: false });
    expect(retireCheck({ dirty: true, upstream: 'origin/x', ahead: 0, aheadOfBase: 0 })).toEqual({ ok: false, reason: 'uncommitted changes' });
    expect(retireCheck({ dirty: false, upstream: 'origin/x', ahead: 2, aheadOfBase: 5 })).toEqual({ ok: false, reason: '2 commits not pushed' });
    expect(retireCheck({ dirty: false, upstream: null, ahead: 0, aheadOfBase: 1 })).toEqual({ ok: false, reason: '1 commit never pushed' });
    expect(retireCheck({ dirty: false, upstream: null, ahead: 0, aheadOfBase: null })).toMatchObject({ ok: false });
  });

  it('lets go of a checkout with nothing beyond its base, or everything pushed', () => {
    expect(retireCheck({ dirty: false, upstream: null, ahead: 0, aheadOfBase: 0 })).toEqual({ ok: true, why: 'nothing_beyond_base' });
    // Squash-merged and pushed: still ahead of base, and safe once origin confirms it holds HEAD.
    expect(retireCheck({ dirty: false, upstream: 'origin/x', ahead: 0, aheadOfBase: 4, remoteContainsHead: true })).toEqual({ ok: true, why: 'pushed' });
  });

  it('never counts as pushed what origin itself has not confirmed', () => {
    const s = { dirty: false, upstream: 'origin/x', ahead: 0, aheadOfBase: 4 };
    // A stale tracking ref after the branch was deleted on the server: "ahead 0", origin says no.
    expect(retireCheck({ ...s, remoteContainsHead: false })).toMatchObject({ ok: false, reason: expect.stringMatching(/origin does not have/) });
    // An older agent, or origin unreachable: it cannot be told, so it is kept.
    expect(retireCheck(s)).toMatchObject({ ok: false, reason: 'could not confirm its branch is on origin' });
    expect(retireCheck({ ...s, remoteContainsHead: null })).toMatchObject({ ok: false });
  });

  it('reads the RPC strictly: a gone upstream (no ahead/behind line) is never pushed', () => {
    expect(branchStateFromRpc({ dirty: false, upstream: 'origin/x', ahead: 0, abKnown: false, aheadOfBase: 2, remoteContainsHead: true }))
      .toEqual({ dirty: false, upstream: null, ahead: 0, aheadOfBase: 2, remoteContainsHead: true });
    expect(retireCheck(branchStateFromRpc({ dirty: false, upstream: 'origin/x', ahead: 0, abKnown: false, aheadOfBase: 2 }))).toMatchObject({ ok: false });
    expect(branchStateFromRpc({ dirty: 'no', ahead: 0 })).toBeNull();
    expect(branchStateFromRpc(null)).toBeNull();
  });
});

describe('lifecycleStep', () => {
  it('parks a delegate done and idle past the threshold', () => {
    expect(lifecycleStep(row(), ctx())).toBe('park');
    expect(lifecycleStep(row(), ctx({ paneSince: now - 10 * MIN }))).toBe('none');
    expect(lifecycleStep(row({ reportedAt: new Date(now - 5 * MIN) }), ctx())).toBe('none');
  });

  it('never parks one that is working, waiting on someone, failed, or already gone', () => {
    expect(lifecycleStep(row(), ctx({ paneStatus: 'working' }))).toBe('none');
    for (const state of ['blocked', 'needs_input', 'failed', 'running']) expect(lifecycleStep(row({ state }), ctx())).toBe('none');
    expect(lifecycleStep(row({ endedAt: new Date() }), ctx())).toBe('none');
  });

  it('never retires a parked spawn whose pane is live again', () => {
    for (const paneStatus of ['working', 'waiting', 'idle']) {
      expect(lifecycleStep(row({ parkedAt: new Date(now - 5 * 24 * 60 * MIN) }), ctx({ paneStatus }))).toBe('none');
    }
  });

  it('parks peers but only considers delegates for retiring', () => {
    expect(lifecycleStep(row({ relationship: 'peer' }), ctx())).toBe('park');
    expect(lifecycleStep(row({ relationship: 'peer', parkedAt: new Date(now - 5 * 24 * 60 * MIN) }), ctx())).toBe('none');
    expect(lifecycleStep(row({ parkedAt: new Date(now - MIN) }), ctx({ paneStatus: 'not_running' }))).toBe('retire');
    expect(lifecycleStep(row({ parkedAt: new Date(), retiredAt: new Date() }), ctx())).toBe('none');
  });
});

describe('retireNow', () => {
  const days = (n: number) => n * 24 * 60 * MIN;
  it('retires at once when the work landed, after the delay when it is only pushed', () => {
    expect(retireNow({ ok: true, why: 'nothing_beyond_base' }, { prMerged: false, parkedForMs: MIN, retireAfterMs: days(3) })).toEqual({ retire: true });
    expect(retireNow({ ok: true, why: 'pushed' }, { prMerged: true, parkedForMs: MIN, retireAfterMs: days(3) })).toEqual({ retire: true });
    expect(retireNow({ ok: true, why: 'pushed' }, { prMerged: false, parkedForMs: days(1), retireAfterMs: days(3) })).toEqual({ retire: false, kept: null });
    expect(retireNow({ ok: true, why: 'pushed' }, { prMerged: false, parkedForMs: days(3), retireAfterMs: days(3) })).toEqual({ retire: true });
  });

  it('keeps work that would be lost, however long it has been parked', () => {
    expect(retireNow({ ok: false, reason: 'uncommitted changes' }, { prMerged: true, parkedForMs: days(30), retireAfterMs: days(3) }))
      .toEqual({ retire: false, kept: 'uncommitted changes' });
  });
});

describe('lifecycleLabel', () => {
  it('names parked, kept and retired', () => {
    expect(lifecycleLabel({ parkedAt: null, retiredAt: null, endedAt: null })).toBeNull();
    expect(lifecycleLabel({ parkedAt: new Date(), retiredAt: null, endedAt: null })).toBe('parked');
    expect(lifecycleLabel({ parkedAt: new Date(), retiredAt: null, endedAt: null, keptReason: '2 commits not pushed' })).toBe('parked · kept: 2 commits not pushed');
    expect(lifecycleLabel({ parkedAt: new Date(), retiredAt: new Date(), endedAt: null })).toBe('retired');
    expect(lifecycleLabel({ parkedAt: new Date(), retiredAt: null, endedAt: new Date() })).toBe('ended · parked');
  });
});

describe('retireCheck for a local-only project (#453)', () => {
  it('retires a clean checkout with nothing beyond the commit it was spawned from', () => {
    const st = branchStateFromRpc({ dirty: false, upstream: null, ahead: 0, aheadOfBase: 0, origin: null, baseLocal: 'spawn-base' });
    expect(st).toMatchObject({ localOnly: true, aheadOfBase: 0, spawnBaseCounted: true });
    expect(retireCheck(st)).toEqual({ ok: true, why: 'nothing_beyond_base' });
  });

  it('keeps one with commits of its own, or uncommitted work, and says it is local-only', () => {
    expect(retireCheck(branchStateFromRpc({ dirty: false, upstream: null, ahead: 0, aheadOfBase: 2, origin: null, baseLocal: 'spawn-base' })))
      .toEqual({ ok: false, reason: '2 commits of its own (a local-only project: nothing to push to)' });
    expect(retireCheck(branchStateFromRpc({ dirty: true, upstream: null, ahead: 0, aheadOfBase: 0, origin: null, baseLocal: 'spawn-base' })))
      .toEqual({ ok: false, reason: 'uncommitted changes' });
  });

  it('keeps one counted any other way, or not at all: only the spawn base decides', () => {
    const kept = { ok: false, reason: 'a local-only project (no remote), and nothing records the commit it was spawned from to count against' };
    // No count (no recorded base; an agent that predates the local count).
    expect(retireCheck(branchStateFromRpc({ dirty: false, upstream: null, ahead: 0, aheadOfBase: null, origin: null }))).toEqual(kept);
    // A 0 that did not come from the spawn base (an agent that counted against a branch): never trusted.
    expect(retireCheck(branchStateFromRpc({ dirty: false, upstream: null, ahead: 0, aheadOfBase: 0, origin: null, baseLocal: 'branch' }))).toEqual(kept);
  });

  it('treats an answer without an origin field as a remote checkout, as before', () => {
    expect(branchStateFromRpc({ dirty: false, upstream: null, ahead: 0, aheadOfBase: null })?.localOnly).toBeUndefined();
    expect(retireCheck(branchStateFromRpc({ dirty: false, upstream: null, ahead: 0, aheadOfBase: null }))).toEqual({ ok: false, reason: 'its commits could not be counted' });
  });
});
