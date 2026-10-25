import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));
const {
  MAX_MEMBERS, assembleGroups, finishedGroups, parseCreateInput, parseMembers, parsePatchInput,
} = await import('./prReviewGroups');
const { openRow } = await import('./prPipeline');
type NumberedPr = import('./prPipelineGithub').NumberedPr;
type OpenPr = import('./prPipeline').OpenPr;

const open = (over: Partial<OpenPr> = {}): OpenPr => ({
  repo: 'example-org/termag', number: 646, title: 'Bridge', url: 'https://github.com/example-org/termag/pull/646', author: 'dev',
  isDraft: false, headRefName: 'desktop-bridge', baseRefName: 'main', updatedAt: '2026-10-24T00:00:00Z', reviewDecision: 'REVIEW_REQUIRED',
  mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', autoMerge: false, checkRollup: 'SUCCESS', checks: [], requestedReviewers: ['me'],
  requestedAt: null, requestedYou: true, ...over,
});
const numbered = (over: Partial<NumberedPr> = {}): NumberedPr => {
  const o = over.open === undefined ? open({ repo: over.repo ?? 'example-org/termag', number: over.number ?? 646 }) : over.open;
  return {
    repo: 'example-org/termag', number: 646, found: true, state: 'OPEN', open: o, title: o?.title ?? 'Bridge', url: o?.url ?? 'u', author: o?.author ?? 'dev',
    headRefName: 'desktop-bridge', baseRefName: 'main', mergedAt: null, closedAt: null, yourReview: null, ...over,
  };
};
const group = (members: { repo: string; number: number; note?: string | null; title?: string }[], over: Partial<{ id: string; closedAt: string | null }> = {}) => ({
  id: over.id ?? 'g1', name: 'Desktop bridge', closedAt: over.closedAt ?? null, createdAt: '2026-10-24T00:00:00Z',
  members: members.map((m, i) => ({ repo: m.repo, number: m.number, position: i, note: m.note ?? null, title: m.title ?? '' })),
});
const fetched = (...prs: NumberedPr[]) => new Map(prs.map(p => [`${p.repo.toLowerCase()}#${p.number}`, p]));

describe('parseMembers', () => {
  it('lowercases the repository, trims notes and keeps the order', () => {
    expect(parseMembers([
      { repo: 'Example-Org/Termag', number: 646, note: '  the   contract ' },
      { repo: 'example-org/terraform', number: 28576, note: '' },
    ])).toEqual([
      { repo: 'example-org/termag', number: 646, note: 'the contract' },
      { repo: 'example-org/terraform', number: 28576, note: null },
    ]);
  });
  it('refuses a PR listed twice, whatever the case', () => {
    expect(() => parseMembers([{ repo: 'o/r', number: 1 }, { repo: 'O/R', number: 1 }])).toThrow('o/r#1 is in the list twice');
  });
  it('refuses more than MAX_MEMBERS, a bad repo, a bad number or a long note', () => {
    expect(() => parseMembers(Array.from({ length: MAX_MEMBERS + 1 }, (_, i) => ({ repo: 'o/r', number: i + 1 })))).toThrow(/at most 20/);
    expect(() => parseMembers([{ repo: 'just-a-name', number: 1 }])).toThrow('repo must be owner/name');
    expect(() => parseMembers([{ repo: 'o/r', number: 0 }])).toThrow('number must be a PR number');
    expect(() => parseMembers([{ repo: 'o/r', number: 1.5 }])).toThrow('number must be a PR number');
    expect(() => parseMembers([{ repo: 'o/r', number: 1, note: 'x'.repeat(201) }])).toThrow(/at most 200/);
    expect(() => parseMembers('o/r#1')).toThrow('members must be a list');
  });
});

describe('parseCreateInput and parsePatchInput', () => {
  it('needs a name, squeezed and at most 80 characters', () => {
    expect(parseCreateInput({ name: '  Desktop   bridge ' })).toEqual({ name: 'Desktop bridge', members: [] });
    expect(() => parseCreateInput({ name: '   ' })).toThrow('name required');
    expect(() => parseCreateInput({ name: 'x'.repeat(81) })).toThrow(/at most 80/);
  });
  it('takes a rename, a close or a reopen, and refuses nothing at all', () => {
    expect(parsePatchInput({ name: 'B' })).toEqual({ name: 'B' });
    expect(parsePatchInput({ closed: false })).toEqual({ closed: false });
    expect(() => parsePatchInput({ closed: 'yes' })).toThrow('closed must be true or false');
    expect(() => parsePatchInput({})).toThrow('nothing to change');
  });
});

describe('assembleGroups', () => {
  const TERRAFORM = { repo: 'example-org/terraform', number: 28576 };
  const BRIDGE = { repo: 'example-org/termag', number: 646 };

  it('uses the lane row when a lane lists the member, else builds one for the card', () => {
    const laneRow = { ...openRow(open(), 'needs_my_review'), workstream: { projectId: 'p1', projectName: 'termag', workstream: 'pr646' } };
    const tf = numbered({ ...TERRAFORM, open: open({ ...TERRAFORM, title: 'ALB', requestedYou: false, requestedReviewers: ['someone'] }), yourReview: { state: 'COMMENTED', submittedAt: null } });
    const [g] = assembleGroups([group([BRIDGE, TERRAFORM])], fetched(numbered(BRIDGE), tf), [laneRow], 'me');
    expect(g.members[0]).toMatchObject({ inLane: true, row: laneRow, askedYou: true, checked: false, state: 'open' });
    // Not asked of you and not yours: a team-review row (Review with Devin works), not counted as asking.
    expect(g.members[1]).toMatchObject({ inLane: false, askedYou: false, yourReview: 'COMMENTED', checked: true, title: 'ALB' });
    expect(g.members[1].row).toMatchObject({ lane: 'team_review', askedYou: false, repo: 'example-org/terraform', number: 28576 });
    expect(g.done).toBe(false);
  });
  it('checks a member off by your review unless a request names you again, or by a merge or close', () => {
    const reviewed = { state: 'APPROVED', submittedAt: '2026-10-24T01:00:00Z' };
    const members = [{ repo: 'o/r', number: 1 }, { repo: 'o/r', number: 2 }, { repo: 'o/r', number: 3 }, { repo: 'o/r', number: 4 }, { repo: 'o/r', number: 5 }];
    const [g] = assembleGroups([group(members)], fetched(
      numbered({ repo: 'o/r', number: 1, open: open({ repo: 'o/r', number: 1, requestedYou: false }), yourReview: reviewed }),
      numbered({ repo: 'o/r', number: 2, open: open({ repo: 'o/r', number: 2, requestedYou: true }), yourReview: reviewed }),
      numbered({ repo: 'o/r', number: 3, state: 'MERGED', open: null, mergedAt: '2026-10-24T02:00:00Z' }),
      numbered({ repo: 'o/r', number: 4, state: 'CLOSED', open: null, closedAt: '2026-10-24T02:00:00Z' }),
      numbered({ repo: 'o/r', number: 5, open: open({ repo: 'o/r', number: 5, requestedYou: true }) }),
    ), [], 'me');
    expect(g.members.map(m => [m.number, m.state, m.checked])).toEqual([
      [1, 'open', true], [2, 'open', false], [3, 'merged', true], [4, 'closed', true], [5, 'open', false],
    ]);
  });
  it('never checks off your own open PR on a comment you left on it (Bugbot)', () => {
    const o = open({ repo: 'o/r', number: 9, author: 'Me', requestedYou: false });
    const mine = numbered({ repo: 'o/r', number: 9, open: o, author: 'Me', yourReview: { state: 'COMMENTED', submittedAt: null } });
    const [g] = assembleGroups([group([{ repo: 'o/r', number: 9 }])], fetched(mine), [], 'me');
    expect(g.members[0]).toMatchObject({ checked: false, yourReview: 'COMMENTED' });
    expect(g.done).toBe(false);
    const merged = numbered({ repo: 'o/r', number: 9, author: 'Me', state: 'MERGED', open: null, mergedAt: 'x', yourReview: { state: 'COMMENTED', submittedAt: null } });
    expect(assembleGroups([group([{ repo: 'o/r', number: 9 }])], fetched(merged), [], 'me')[0].done).toBe(true);
  });
  it('puts your own PR in its authored lane, checked off only once merged or closed', () => {
    const mine = numbered({ repo: 'o/r', number: 9, open: open({ repo: 'o/r', number: 9, author: 'Me', requestedYou: false, reviewDecision: 'APPROVED' }) });
    const [g] = assembleGroups([group([{ repo: 'o/r', number: 9 }])], fetched(mine), [], 'me');
    expect(g.members[0].row?.lane).toBe('ready_to_merge');
    expect(g.members[0].row?.askedYou).toBeUndefined();
    expect(g.members[0].checked).toBe(false);
  });
  it('is done once every member is checked off, and an empty group never is', () => {
    const merged = numbered({ ...BRIDGE, state: 'MERGED', open: null, mergedAt: '2026-10-24T02:00:00Z' });
    expect(assembleGroups([group([BRIDGE])], fetched(merged), [], 'me')[0].done).toBe(true);
    expect(assembleGroups([group([])], fetched(), [], 'me')[0].done).toBe(false);
  });
  it('keeps the stored title, a GitHub link and no row when GitHub could not be read', () => {
    const [g] = assembleGroups([group([{ ...TERRAFORM, title: 'ALB (stored)' }])], null, [], 'me');
    expect(g.members[0]).toMatchObject({
      state: 'unknown', checked: false, row: null, title: 'ALB (stored)', url: 'https://github.com/example-org/terraform/pull/28576',
    });
  });
  it('takes what a lane row says when GitHub could not be read (Devin)', () => {
    const asking = openRow(open(), 'needs_my_review');
    const merged = { ...openRow(open({ number: 7 }), 'needs_my_review'), lane: 'merged' as const, mergedAt: 'x' };
    const [g] = assembleGroups([group([BRIDGE, { repo: 'example-org/termag', number: 7 }, TERRAFORM])], null, [asking, merged], 'me');
    expect(g.members.map(m => [m.number, m.state, m.askedYou, m.checked, m.inLane])).toEqual([
      [646, 'open', true, false, true], [7, 'merged', false, true, true], [28576, 'unknown', false, false, false],
    ]);
  });
  it('says a PR GitHub does not have is missing', () => {
    const [g] = assembleGroups([group([{ repo: 'o/r', number: 999 }])], fetched(numbered({ repo: 'o/r', number: 999, found: false, state: null, open: null })), [], 'me');
    expect(g.members[0]).toMatchObject({ state: 'missing', checked: false, row: null });
  });
  it('matches members whatever the case GitHub answers in', () => {
    const laneRow = openRow(open({ repo: 'Example-Org/Termag' }), 'needs_my_review');
    const [g] = assembleGroups([group([BRIDGE])], fetched(numbered(BRIDGE)), [laneRow], 'me');
    expect(g.members[0].inLane).toBe(true);
  });
});

describe('finishedGroups', () => {
  it('lists open groups whose members are all merged or closed', () => {
    const merged = numbered({ repo: 'o/r', number: 1, state: 'MERGED', open: null, mergedAt: 'x' });
    const reviewed = numbered({ repo: 'o/r', number: 2, yourReview: { state: 'APPROVED', submittedAt: null }, open: open({ repo: 'o/r', number: 2, requestedYou: false }) });
    const groups = assembleGroups([
      group([{ repo: 'o/r', number: 1 }], { id: 'all-merged' }),
      // Done (every member checked off) but not finished: the card waits for Close group.
      group([{ repo: 'o/r', number: 1 }, { repo: 'o/r', number: 2 }], { id: 'done-not-merged' }),
      group([{ repo: 'o/r', number: 1 }], { id: 'already-closed', closedAt: '2026-10-20T00:00:00Z' }),
      group([], { id: 'empty' }),
    ], fetched(merged, reviewed), [], 'me');
    expect(groups[1].done).toBe(true);
    expect(finishedGroups(groups)).toEqual(['all-merged']);
  });
});
