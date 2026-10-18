import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));

const { applyLinks, earlierLinks, parsePrUrl, recordCreatedLink, replaces } = await import('./workstreamPrs');
type Row = Parameters<typeof applyLinks>[0][number];

const MINE = { projectId: 'p1', projectName: 'termag', workstream: 'termag-pr-dash' };
const OTHER = { projectId: 'p1', projectName: 'termag', workstream: 'termag-metaterm' };

function row(over: Partial<Row> = {}): Row {
  return { kind: 'pr', repo: 'example-org/termag', number: 7, lane: 'checks', workstream: null, reviewTarget: null, ...over };
}
const link = (source: 'created' | 'branch' | 'manual', workstream = MINE) => ({ repo: 'example-org/termag', number: 7, source, workstream });

describe('applyLinks', () => {
  it('fills an unlinked PR from its stored link, matching the repo in any case', () => {
    const [r] = applyLinks([row({ repo: 'Example-Org/Termag' })], [link('created')]);
    expect(r).toMatchObject({ workstream: MINE, linkedBy: 'created' });
  });
  it('lets the live checkout beat a created or branch link, but not a manual one', () => {
    expect(applyLinks([row({ workstream: OTHER })], [link('created')])[0]).toMatchObject({ workstream: OTHER, linkedBy: 'checkout' });
    expect(applyLinks([row({ workstream: OTHER })], [link('manual')])[0]).toMatchObject({ workstream: MINE, linkedBy: 'manual' });
  });
  it('reviews a PR under review where it is linked', () => {
    const [r] = applyLinks([row({ lane: 'needs_my_review', reviewTarget: { ...MINE, workstream: 'main' } })], [link('manual')]);
    expect(r.reviewTarget).toEqual(MINE);
  });
  it('leaves branch rows and other PRs alone, and does not touch the shared rows', () => {
    const shared = [row({ kind: 'branch', number: null }), row({ number: 8 })];
    const out = applyLinks(shared, [link('manual')]);
    expect(out.map(r => r.workstream)).toEqual([null, null]);
    expect(shared[1]).not.toHaveProperty('linkedBy');
  });
});

describe('replaces', () => {
  it('keeps the first link unless the new one is by hand', () => {
    expect(replaces(null, 'branch')).toBe(true);
    expect(replaces('created', 'branch')).toBe(false);
    expect(replaces('branch', 'created')).toBe(false);
    expect(replaces('manual', 'created')).toBe(false);
    expect(replaces('created', 'manual')).toBe(true);
  });
});

describe('parsePrUrl', () => {
  it('reads GitHub PR URLs only', () => {
    expect(parsePrUrl('https://github.com/example-org/termag/pull/363')).toEqual({ repo: 'example-org/termag', number: 363 });
    expect(parsePrUrl('https://github.com/example-org/termag/issues/3')).toBeNull();
    expect(parsePrUrl('https://evil.example/example-org/termag/pull/3')).toBeNull();
    expect(parsePrUrl(null)).toBeNull();
  });
});

describe('recordCreatedLink', () => {
  const URL = 'https://github.com/example-org/termag/pull/363';
  it('stores the PR against the session\'s workstream', async () => {
    const record = vi.fn(async () => true);
    const resolve = vi.fn(async () => ({ userId: 'u1', instanceId: 'i1', projectId: 'p1', workstream: 'termag-pr-dash' }));
    expect(await recordCreatedLink('psecor-termag-termag-pr-dash-agent', 'i1', URL, { resolve, store: { record, list: vi.fn(), detach: vi.fn() } })).toBe(true);
    expect(resolve).toHaveBeenCalledWith('psecor-termag-termag-pr-dash-agent', 'i1');
    expect(record).toHaveBeenCalledWith('u1', { repo: 'example-org/termag', number: 363 }, { projectId: 'p1', workstream: 'termag-pr-dash' }, 'created');
  });
  it('records nothing without a PR URL, or for a session with no workstream', async () => {
    const record = vi.fn(async () => true);
    const store = { record, list: vi.fn(), detach: vi.fn() };
    expect(await recordCreatedLink('s', null, null, { resolve: vi.fn(), store })).toBe(false);
    expect(await recordCreatedLink('s', null, URL, { resolve: vi.fn(async () => ({ ambiguous: true as const })), store })).toBe(false);
    expect(await recordCreatedLink('s', null, URL, { resolve: vi.fn(async () => ({ userId: 'u1', instanceId: null, projectId: null, workstream: null })), store })).toBe(false);
    expect(await recordCreatedLink('s', null, URL, { resolve: vi.fn(async () => null), store })).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });
});

describe('earlierLinks', () => {
  it('lists stored links no lane has, newest first, up to the limit', () => {
    const links = [
      { ...link('created'), number: 1, at: '2026-10-01T00:00:00Z' },
      { ...link('branch'), number: 2, at: '2026-10-03T00:00:00Z' },
      { ...link('manual'), number: 7, at: '2026-10-04T00:00:00Z' },
      { ...link('created', OTHER), number: 3, at: '2026-10-02T00:00:00Z' },
    ];
    const out = earlierLinks([row({ repo: 'Example-Org/Termag', number: 7 }), row({ kind: 'branch', number: null })], links, '2026-10-05T00:00:00Z');
    expect(out.map(e => [e.number, e.workstream.workstream])).toEqual([[2, 'termag-pr-dash'], [3, 'termag-metaterm'], [1, 'termag-pr-dash']]);
    expect(earlierLinks([], links, null, 2).map(e => e.number)).toEqual([7, 2]);
    expect(links.map(l => l.number)).toEqual([1, 2, 7, 3]);
  });
  it('leaves out a link stored since the lanes were read, unless it was made by hand (Bugbot)', () => {
    const fresh = [
      { ...link('created'), number: 363, at: '2026-10-14T12:00:30Z' },
      { ...link('manual'), number: 12, at: '2026-10-14T12:00:40Z' },
      { ...link('created'), number: 5, at: '2026-10-14T11:00:00Z' },
    ];
    expect(earlierLinks([], fresh, '2026-10-14T12:00:00Z').map(e => e.number)).toEqual([12, 5]);
  });
});
