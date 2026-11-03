import { describe, expect, it } from 'vitest';
import { capPatches, fetchPrThreads, parseFilesPage, parseThreads } from './prFiles';

describe('parseFilesPage', () => {
  it('reads each file of a page, its rename and patch, and skips what is not a file', () => {
    expect(parseFilesPage([
      { filename: 'agent/tunnel-dial.js', status: 'modified', additions: 38, deletions: 6, patch: '@@ -1 +1 @@\n-a\n+b' },
      { filename: 'docs/new.md', previous_filename: 'docs/old.md', status: 'renamed', additions: 0, deletions: 0 },
      { status: 'added' },
      null,
    ])).toEqual([
      { path: 'agent/tunnel-dial.js', previousPath: null, status: 'modified', additions: 38, deletions: 6, patch: '@@ -1 +1 @@\n-a\n+b' },
      { path: 'docs/new.md', previousPath: 'docs/old.md', status: 'renamed', additions: 0, deletions: 0, patch: null },
    ]);
    expect(parseFilesPage({ message: 'Not Found' })).toEqual([]);
  });
});

describe('parseThreads', () => {
  const data = (threads: unknown[]) => ({ repository: { pullRequest: { reviewThreads: { nodes: threads } } } });
  const comment = { id: 'c1', author: { login: 'cursor', __typename: 'Bot' }, body: 'Rounds attach any linked workstream', createdAt: '2026-10-30T00:40:00Z', url: 'https://github.com/x' };

  it('reads each thread with its line, side, state and comments', () => {
    expect(parseThreads(data([{ id: 't1', path: 'frontend/src/chat/reviews.ts', line: 145, originalLine: 140, diffSide: 'RIGHT', isResolved: false, isOutdated: false, comments: { nodes: [comment] } }]))).toEqual([{
      id: 't1', path: 'frontend/src/chat/reviews.ts', line: 145, side: 'RIGHT', resolved: false, outdated: false,
      comments: [{ id: 'c1', author: 'cursor', bot: true, body: 'Rounds attach any linked workstream', createdAt: '2026-10-30T00:40:00Z', url: 'https://github.com/x' }],
      total: 1,
    }]);
  });

  it("says how many comments a long thread has past the ones it lists", () => {
    const [t] = parseThreads(data([{ id: 't3', path: 'a.ts', line: 3, diffSide: 'RIGHT', comments: { totalCount: 140, nodes: [comment] } }]));
    expect(t).toMatchObject({ total: 140, comments: [expect.objectContaining({ id: 'c1' })] });
  });

  it("leaves an outdated thread off the diff's lines rather than guessing one from its older blob", () => {
    const [t] = parseThreads(data([{ id: 't2', path: 'a.ts', line: null, originalLine: 12, diffSide: 'RIGHT', isResolved: false, isOutdated: true, comments: { nodes: [comment] } }]));
    expect(t).toMatchObject({ line: null, outdated: true });
  });

  it('answers none for anything without the shape', () => {
    expect(parseThreads(null)).toEqual([]);
    expect(parseThreads(data([{ id: 3, path: 'a.ts' }, null]))).toEqual([]);
  });
});

describe('fetchPrThreads', () => {
  const thread = (id: string) => ({ id, path: 'a.ts', line: 1, diffSide: 'RIGHT', comments: { totalCount: 0, nodes: [] } });
  const page = (ids: string[], next: string | null) => ({
    ok: true, status: 200,
    json: async () => ({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes: ids.map(thread) } } } } }),
  });

  it('reads every page, the later rounds on the later ones included', async () => {
    const calls: unknown[] = [];
    const pages = [page(['t1', 't2'], 'c2'), page(['t3'], null)];
    const fetchImpl = (async (_url: string, init: { body: string }) => { calls.push(JSON.parse(init.body).variables.after); return pages.shift(); }) as never;
    const threads = await fetchPrThreads('gho_x', { owner: 'example-org', name: 'termag', number: 1 }, fetchImpl);
    expect(threads.map(t => t.id)).toEqual(['t1', 't2', 't3']);
    expect(calls).toEqual([null, 'c2']);
  });

  it('fails the read on a page GitHub answered with errors or without its threads, rather than end the list there', async () => {
    const ref = { owner: 'example-org', name: 'termag', number: 1 };
    const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    for (const later of [
      answer({ data: { repository: { pullRequest: { reviewThreads: null } } }, errors: [{ message: 'timeout' }] }),
      answer({ data: { repository: { pullRequest: { reviewThreads: null } } } }),
    ]) {
      const pages = [page(['t1'], 'c1'), later];
      await expect(fetchPrThreads('gho_x', ref, (async () => pages.shift()) as never)).rejects.toThrow('could not read the review threads');
    }
  });

  it('fails the read past the pages it reads, rather than answer the first thousand threads as all of them', async () => {
    const fetchImpl = (async () => page(['t'], 'more')) as never;
    await expect(fetchPrThreads('gho_x', { owner: 'example-org', name: 'termag', number: 1 }, fetchImpl)).rejects.toThrow('more than termag reads');
  });

  it('fails the read when a later page fails, rather than answer part of the threads', async () => {
    const pages = [page(['t1'], 'c1'), { ok: false, status: 502, json: async () => ({}) }];
    const fetchImpl = (async () => pages.shift()) as never;
    await expect(fetchPrThreads('gho_x', { owner: 'example-org', name: 'termag', number: 1 }, fetchImpl)).rejects.toThrow('HTTP 502');
  });
});

describe('capPatches', () => {
  const file = (path: string, size: number) => ({ path, previousPath: null, status: 'modified' as const, additions: 1, deletions: 0, patch: 'x'.repeat(size) });
  it('leaves out only a patch that does not fit, and keeps later ones that still do', () => {
    const { files, truncated } = capPatches([file('a', 40), file('big', 80), file('b', 50)], 100);
    expect(files.map(f => [f.path, f.patch?.length ?? null, !!f.capped])).toEqual([['a', 40, false], ['big', null, true], ['b', 50, false]]);
    expect(truncated).toBe(true);
  });
  it('keeps every patch under the cap', () => {
    expect(capPatches([file('a', 40), file('b', 50)], 100)).toMatchObject({ truncated: false });
  });
});
