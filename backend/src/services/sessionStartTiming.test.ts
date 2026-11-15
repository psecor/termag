import { beforeEach, describe, expect, it, vi } from 'vitest';

/** session.start.timed (services/sessionStartTiming.ts): once per New session, create to first words, with the phases that applied. */

const events = vi.hoisted(() => [] as Array<{ name: string; keys: unknown; detail: Record<string, unknown> }>);
vi.mock('./productEvents', () => ({ recordProductEvent: (name: string, keys: unknown, detail: Record<string, unknown>) => { events.push({ name, keys, detail }); } }));

const { claimedJustNow, noteBoxUp, noteFirstText, noteSessionCreated, noteSetupDone, placementFor, resetSessionStartTiming } = await import('./sessionStartTiming');

const T = 1_000_000;
beforeEach(() => { events.length = 0; resetSessionStartTiming(); });

describe('session.start.timed', () => {
  it('starts the clock when the create was asked for, and keeps a checkout that finished inside it', () => {
    noteSessionCreated('p0', 'main', { userId: 'u1', boxId: 'b0', placement: 'reuse', provider: null, boxUp: true, setupDone: true }, T, T + 3_000);
    noteFirstText('p0', 'main', T + 10_000);
    expect(events[0].detail).toEqual({ placement: 'reuse', provider: null, cloneMs: 3_000, firstTextMs: 7_000, totalMs: 10_000 });
  });

  it('takes a claimed pool box that is already connected as up from the start, with no launchMs', () => {
    noteSessionCreated('p9', 'main', { userId: 'u1', boxId: 'b9', placement: 'pool', provider: null, boxUp: true }, T);
    noteFirstText('p9', 'main', T + 5_000);
    expect(events[0].detail).toEqual({ placement: 'pool', provider: null, firstTextMs: 5_000, totalMs: 5_000 });
  });

  it('times a session on a parked box: the wake, the clone and the first words', () => {
    noteSessionCreated('p1', 'main', { userId: 'u1', boxId: 'b1', placement: 'wake', provider: 'claude-chat' }, T);
    noteBoxUp('b1', T + 40_000);
    noteSetupDone('p1', T + 55_000);
    noteFirstText('p1', 'main', T + 70_000);
    expect(events).toEqual([{
      name: 'session.start.timed', keys: { user: 'u1', box: 'b1' },
      detail: { placement: 'wake', provider: 'claude-chat', wakeMs: 40_000, cloneMs: 15_000, firstTextMs: 15_000, totalMs: 70_000 },
    }]);
  });

  it('times a cold launch and a pool claim as launchMs, and a reused box with neither', () => {
    noteSessionCreated('p2', 'main', { userId: 'u1', boxId: 'b2', placement: 'cold', provider: null }, T);
    noteBoxUp('b2', T + 120_000);
    noteFirstText('p2', 'main', T + 150_000);
    expect(events[0].detail).toEqual({ placement: 'cold', provider: null, launchMs: 120_000, firstTextMs: 30_000, totalMs: 150_000 });

    noteSessionCreated('p3', 'main', { userId: 'u1', boxId: 'b3', placement: 'reuse', provider: null }, T);
    noteBoxUp('b3', T + 1_000);
    noteFirstText('p3', 'main', T + 9_000);
    expect(events[1].detail).toEqual({ placement: 'reuse', provider: null, firstTextMs: 9_000, totalMs: 9_000 });
  });

  it('sends once per session, only for one it saw made, and a worktree by its own workstream', () => {
    noteFirstText('nobody', 'main', T);
    noteSessionCreated('p4', 'fix-login', { userId: 'u1', boxId: 'b4', placement: 'worktree', provider: null }, T);
    noteFirstText('p4', 'main', T + 1);
    noteFirstText('p4', 'fix-login', T + 5_000);
    noteFirstText('p4', 'fix-login', T + 6_000);
    expect(events.map(e => e.detail.placement)).toEqual(['worktree']);
  });

  it('drops a session that never says anything after an hour', () => {
    noteSessionCreated('p5', 'main', { userId: 'u1', boxId: 'b5', placement: 'reuse', provider: null }, T);
    noteSessionCreated('p6', 'main', { userId: 'u1', boxId: 'b6', placement: 'reuse', provider: null }, T + 61 * 60_000);
    noteFirstText('p5', 'main', T + 62 * 60_000);
    expect(events).toEqual([]);
  });

  it('reads the placement from the box at the create', () => {
    expect(placementFor('ready', true)).toBe('pool');
    expect(placementFor('stopped', false)).toBe('wake');
    expect(placementFor('starting', undefined)).toBe('wake');
    expect(placementFor('provisioning', false)).toBe('cold');
    expect(placementFor('ready', false)).toBe('reuse');
    expect(placementFor('stopped', true)).toBe('wake');
    expect(claimedJustNow(new Date(T - 60_000), 0, T)).toBe(true);
    // A box claimed a minute ago that already has a session: this one reuses it.
    expect(claimedJustNow(new Date(T - 60_000), 1, T)).toBe(false);
    expect(claimedJustNow(new Date(T - 20 * 60_000), 0, T)).toBe(false);
    expect(claimedJustNow(null, 0, T)).toBe(false);
  });
});
