import { describe, it, expect } from 'vitest';
import { syncRepo, pauseBelow, type PrNode, type Page, type SyncState } from './sync';

const node = (n: number, updatedAt: string): PrNode => ({
  id: `pr${n}`, number: n, state: 'MERGED', isDraft: false, createdAt: updatedAt, updatedAt, mergedAt: updatedAt, closedAt: updatedAt,
  baseRefName: 'main', additions: 1, deletions: 1, changedFiles: 1, body: '', author: { login: 'ada-dev', __typename: 'User' }, commits: { nodes: [] },
});

/** A fake repo: PRs kept newest-updated first, served in pages by an index cursor. */
function fakeRepo(prs: PrNode[], pageSize = 2, remaining = 5000) {
  const list = [...prs];
  const sort = () => list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  sort();
  const calls: Array<string | null> = [];
  return {
    calls,
    touch(n: number, updatedAt: string) { const p = list.find(x => x.number === n)!; p.updatedAt = updatedAt; sort(); },
    add(p: PrNode) { list.push(p); sort(); },
    async fetchPage(after: string | null): Promise<Page> {
      calls.push(after);
      const i = after === null ? 0 : Number(after);
      const nodes = list.slice(i, i + pageSize);
      return { visibility: 'internal', nodes, hasNextPage: i + pageSize < list.length, endCursor: String(i + pageSize), rateLimit: { remaining, limit: 5000, resetAt: '' } };
    },
  };
}

const fresh: SyncState = { backfillCursor: null, backfillTop: null, backfillDone: false, highWater: null };

function sink() {
  const seen = new Map<number, string>();
  return { seen, write: async (nodes: PrNode[]) => { for (const n of nodes) seen.set(n.number, n.updatedAt); } };
}

describe('syncRepo first pass', () => {
  const prs = [node(1, '2026-10-10T00:00:00Z'), node(2, '2026-10-09T00:00:00Z'), node(3, '2026-10-08T00:00:00Z'), node(4, '2026-10-01T00:00:00Z'), node(5, '2025-01-01T00:00:00Z')];
  const horizon = new Date('2026-09-01T00:00:00Z');

  it('pages down to the horizon, keeps nothing older, and sets the high-water mark', async () => {
    const repo = fakeRepo(prs); const s = sink();
    const r = await syncRepo(fresh, horizon, 10, { fetchPage: a => repo.fetchPage(a), write: s.write, shouldPause: () => false });
    expect([...s.seen.keys()].sort()).toEqual([1, 2, 3, 4]);
    expect(r.state).toEqual({ backfillCursor: null, backfillTop: new Date('2026-10-10T00:00:00Z'), backfillDone: true, highWater: new Date('2026-10-10T00:00:00Z') });
    expect(r.pages).toBe(3);
  });

  it('resumes from the saved cursor when the page budget runs out', async () => {
    const repo = fakeRepo(prs); const s = sink();
    const deps = { fetchPage: (a: string | null) => repo.fetchPage(a), write: s.write, shouldPause: () => false };
    const first = await syncRepo(fresh, horizon, 1, deps);
    expect(first.state).toMatchObject({ backfillDone: false, backfillCursor: '2' });
    const second = await syncRepo(first.state, horizon, 10, deps);
    expect(second.state.backfillDone).toBe(true);
    expect(repo.calls).toEqual([null, '2', '4']);
    expect([...s.seen.keys()].sort()).toEqual([1, 2, 3, 4]);
  });

  it('pauses on the rate limit and keeps its place', async () => {
    const repo = fakeRepo(prs, 2, 100); const s = sink();
    const r = await syncRepo(fresh, horizon, 10, { fetchPage: a => repo.fetchPage(a), write: s.write, shouldPause: pauseBelow(0.2) });
    expect(r).toMatchObject({ paused: true, pages: 1, state: { backfillDone: false, backfillCursor: '2' } });
  });
});

describe('syncRepo head pass', () => {
  it('picks up new PRs and PRs updated during the first pass, then advances the mark', async () => {
    const repo = fakeRepo([node(1, '2026-10-10T00:00:00Z'), node(2, '2026-10-09T00:00:00Z'), node(3, '2026-10-08T00:00:00Z')]);
    const s = sink(); const deps = { fetchPage: (a: string | null) => repo.fetchPage(a), write: s.write, shouldPause: () => false };
    const horizon = new Date('2026-09-01T00:00:00Z');
    const a = await syncRepo(fresh, horizon, 1, deps); // page 1 seen, cursor at 2
    repo.touch(3, '2026-10-11T00:00:00Z'); // PR 3 merged while the first pass ran: it jumps above the cursor
    const b = await syncRepo(a.state, horizon, 10, deps);
    expect(b.state.backfillDone).toBe(true);
    expect(s.seen.has(3)).toBe(false); // the first pass never saw it: it moved above the cursor…
    expect(b.state.highWater).toEqual(new Date('2026-10-10T00:00:00Z'));
    repo.add(node(4, '2026-10-12T00:00:00Z'));
    const c = await syncRepo(b.state, horizon, 10, deps);
    expect(s.seen.get(3)).toBe('2026-10-11T00:00:00Z'); // …and the head pass caught it
    expect(s.seen.has(4)).toBe(true);
    expect(c.state.highWater).toEqual(new Date('2026-10-12T00:00:00Z'));
  });

  it('stops at the mark on the first page when nothing changed', async () => {
    const repo = fakeRepo([node(1, '2026-10-10T00:00:00Z'), node(2, '2026-10-09T00:00:00Z'), node(3, '2026-10-08T00:00:00Z')]);
    const s = sink();
    const done: SyncState = { backfillCursor: null, backfillTop: null, backfillDone: true, highWater: new Date('2026-10-10T00:00:00Z') };
    const r = await syncRepo(done, new Date(0), 10, { fetchPage: a => repo.fetchPage(a), write: s.write, shouldPause: () => false });
    expect(r).toMatchObject({ pages: 1, written: 0 });
    expect(r.state.highWater).toEqual(new Date('2026-10-10T00:00:00Z'));
  });

  it('does not advance the mark when the budget cuts the pass short', async () => {
    const repo = fakeRepo([node(5, '2026-10-15T00:00:00Z'), node(4, '2026-10-14T00:00:00Z'), node(3, '2026-10-13T00:00:00Z'), node(2, '2026-10-01T00:00:00Z')]);
    const s = sink();
    const done: SyncState = { backfillCursor: null, backfillTop: null, backfillDone: true, highWater: new Date('2026-10-02T00:00:00Z') };
    const r = await syncRepo(done, new Date(0), 1, { fetchPage: a => repo.fetchPage(a), write: s.write, shouldPause: () => false });
    expect(r.state.highWater).toEqual(new Date('2026-10-02T00:00:00Z'));
    expect([...s.seen.keys()]).toEqual([5, 4]);
  });
});
