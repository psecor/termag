import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
vi.mock('../db', () => ({ prisma: {} }));
const { bodySources, keyHash, parseRefs, stackEdges, suggestGroups, unknownRefs } = await import('./prGroupSuggestions');
type SuggestInput = import('./prGroupSuggestions').SuggestInput;
import type { PrRow } from './prPipeline';

const row = (over: Partial<PrRow>): PrRow => ({
  kind: 'pr', lane: 'needs_my_review', repo: 'example-org/termag', number: 1, title: 't', url: 'u', author: 'dev',
  headRefName: `h${over.number ?? 1}`, baseRefName: 'main', at: null, badges: [], failingChecks: [], checksFailed: false, pendingChecks: [], waitingOn: [],
  blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, workstream: null, requestedAt: null, reviewTarget: null, askedYou: true, ...over,
});
const input = (over: Partial<SuggestInput>): SuggestInput => ({
  rows: [], bodies: new Map(), others: new Map(), grouped: new Map(), dismissed: new Set(), ...over,
});
const keys = (s: { members: { repo: string; number: number }[] }) => s.members.map(m => `${m.repo}#${m.number}`);

describe('parseRefs', () => {
  it('reads PR URLs, owner/name#N and #N in the same repository, without itself or repeats', () => {
    const body = [
      'In production, the dial-back also needs example-org/infra#1234 (platform-team).',
      '#646 adds the orchestrator half; see https://github.com/example-org/termag/pull/647 and #646 again.',
      'This is #648 itself.',
    ].join('\n');
    expect(parseRefs(body, 'example-org/termag', 648)).toEqual([
      { repo: 'example-org/termag', number: 647 },
      { repo: 'example-org/infra', number: 1234 },
      { repo: 'example-org/termag', number: 646 },
    ]);
  });
  it('is not fooled by entities, fragments, line anchors or a URL\'s own path', () => {
    const body = 'Smart quote &#8217; · see docs#section · file.ts#L12 · https://github.com/o/r/pull/5#issuecomment-1 · a#1b';
    expect(parseRefs(body, 'o/r')).toEqual([{ repo: 'o/r', number: 5 }]);
  });
  it('stops at MAX_REFS_PER_BODY', () => {
    const body = Array.from({ length: 40 }, (_, i) => `#${i + 1}`).join(' ');
    expect(parseRefs(body, 'o/r')).toHaveLength(30);
  });
});

describe('stacks and sources', () => {
  it('links a PR based on another\'s branch, in the same repository only', () => {
    const rows = [
      row({ number: 661, headRefName: 'e2e-real-github', lane: 'checks', author: 'me' }),
      row({ number: 662, headRefName: 'desktop-dev-loop', baseRefName: 'e2e-real-github', lane: 'checks', author: 'me' }),
      row({ repo: 'o/other', number: 9, baseRefName: 'e2e-real-github' }),
      row({ number: 700, baseRefName: 'desktop-dev-loop', lane: 'merged' }),
    ];
    expect(stackEdges(rows)).toEqual([{ parent: 'example-org/termag#661', child: 'example-org/termag#662' }]);
  });
  it('reads descriptions of reviews asked of you by name only', () => {
    const rows = [row({ number: 1 }), row({ number: 2, askedYou: false }), row({ number: 3, lane: 'team_review', askedYou: false }), row({ number: 4, lane: 'checks' })];
    expect(bodySources(rows).map(r => r.number)).toEqual([1]);
  });
});

describe('suggestGroups', () => {
  // The desktop bridge, 2026-10-24: four termag PRs and a terraform one, all based on main.
  const rows = [
    row({ number: 646, title: 'feat(desktop): bridge' }),
    row({ number: 647, title: 'feat(agent): t3-v1' }),
    row({ number: 648, title: 'feat(deploy): t3 server' }),
    row({ number: 700, title: 'unrelated' }),
    row({ number: 645, lane: 'merged', title: 'flag' }),
  ];
  const bodies = new Map([
    ['example-org/termag#646', 'The dial-back needs example-org/terraform#28576. Flag: #645 (merged).'],
    ['example-org/termag#647', '#646 adds the orchestrator half. It does not depend on #645 or #646.'],
    ['example-org/termag#648', 'The desktop bridge (#646, #647) needs a t3 server. Fixes #12.'],
    ['example-org/termag#700', 'Nothing to do with the others.'],
  ]);
  const others = new Map([
    ['example-org/terraform#28576', { repo: 'example-org/terraform', number: 28576, title: 'ALB path past Okta', url: 'u', author: 'dev', open: true }],
  ]);

  it('groups the PRs whose descriptions link them, the most named first', () => {
    const [s, ...rest] = suggestGroups(input({ rows, bodies, others }));
    expect(rest).toEqual([]);
    // #646 is named by #647 and #648; #647 and terraform#28576 once each (repository order); #648 by none.
    expect(keys(s)).toEqual(['example-org/termag#646', 'example-org/termag#647', 'example-org/terraform#28576', 'example-org/termag#648']);
    expect(s).toMatchObject({ reason: 'references', target: null, name: 'feat(desktop): bridge' });
    expect(s.key).toBe('example-org/termag#646 example-org/termag#647 example-org/termag#648 example-org/terraform#28576');
  });
  it('drops links to merged, closed or unknown PRs and issues', () => {
    const closed = new Map([['example-org/terraform#28576', { ...others.get('example-org/terraform#28576')!, open: false }]]);
    const [s] = suggestGroups(input({ rows, bodies, others: closed }));
    expect(keys(s)).not.toContain('example-org/terraform#28576');
    expect(keys(s)).not.toContain('example-org/termag#645');
    expect(keys(s)).not.toContain('example-org/termag#12');
  });
  it('suggests adding the rest to the group that already holds some', () => {
    const grouped = new Map([['example-org/termag#646', { id: 'g1', name: 'Desktop bridge', size: 1 }]]);
    const [s] = suggestGroups(input({ rows, bodies, others, grouped }));
    expect(s.target).toEqual({ id: 'g1', name: 'Desktop bridge' });
    expect(keys(s)).toEqual(['example-org/termag#647', 'example-org/terraform#28576', 'example-org/termag#648']);
    expect(s.key.startsWith('g1:')).toBe(true);
    // All grouped already: nothing to suggest.
    const all = new Map(['646', '647', '648'].map(n => [`example-org/termag#${n}`, { id: 'g1', name: 'Desktop bridge', size: 1 }]));
    all.set('example-org/terraform#28576', { id: 'g1', name: 'Desktop bridge', size: 1 });
    expect(suggestGroups(input({ rows, bodies, others, grouped: all }))).toEqual([]);
  });
  it('offers only what fits beside the group\'s own members, and nothing when it is full (Bugbot)', () => {
    const at = (size: number) => new Map([['example-org/termag#646', { id: 'g1', name: 'Desktop bridge', size }]]);
    expect(keys(suggestGroups(input({ rows, bodies, others, grouped: at(18) }))[0])).toEqual(['example-org/termag#647', 'example-org/terraform#28576']);
    expect(suggestGroups(input({ rows, bodies, others, grouped: at(20) }))).toEqual([]);
  });
  it('stays dismissed until its set of PRs changes', () => {
    const [s] = suggestGroups(input({ rows, bodies, others }));
    expect(suggestGroups(input({ rows, bodies, others, dismissed: new Set([keyHash(s.key)]) }))).toEqual([]);
    const more = new Map(bodies);
    more.set('example-org/termag#700', 'Builds on #648.');
    expect(suggestGroups(input({ rows, bodies: more, others, dismissed: new Set([keyHash(s.key)]) }))).toHaveLength(1);
  });
  it('suggests your own stack, base first, and says when both signals link a group', () => {
    const stack = [
      row({ number: 662, headRefName: 'loop', baseRefName: 'e2e', lane: 'checks', author: 'me' }),
      row({ number: 661, headRefName: 'e2e', lane: 'checks', author: 'me' }),
    ];
    const [s] = suggestGroups(input({ rows: stack }));
    expect(keys(s)).toEqual(['example-org/termag#661', 'example-org/termag#662']);
    expect(s.reason).toBe('stack');
    const both = [row({ number: 661, headRefName: 'e2e' }), row({ number: 662, baseRefName: 'e2e' })];
    const [b] = suggestGroups(input({ rows: both, bodies: new Map([['example-org/termag#662', 'Stacked on #661.']]) }));
    expect(b.reason).toBe('both');
  });
  it('names no group of one, and survives a cycle', () => {
    expect(suggestGroups(input({ rows: [row({ number: 1 })], bodies: new Map([['example-org/termag#1', 'See #1.']]) }))).toEqual([]);
    const cyc = [row({ number: 1 }), row({ number: 2 })];
    const [s] = suggestGroups(input({ rows: cyc, bodies: new Map([['example-org/termag#1', 'After #2.'], ['example-org/termag#2', 'After #1.']]) }));
    expect(keys(s)).toEqual(['example-org/termag#1', 'example-org/termag#2']);
  });
});

describe('unknownRefs', () => {
  it('lists linked PRs no lane knows, at most `limit`, skipping lane PRs and merged ones', () => {
    const rows = [row({ number: 646 }), row({ number: 645, lane: 'merged' })];
    const bodies = new Map([['example-org/termag#646', 'example-org/terraform#28576 #645 #647 #646']]);
    expect(unknownRefs(rows, bodies)).toEqual([{ repo: 'example-org/terraform', number: 28576 }, { repo: 'example-org/termag', number: 647 }]);
    expect(unknownRefs(rows, bodies, 1)).toHaveLength(1);
  });
});
