import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { PrOverview, PrRow } from '../../services/api';
import { PrConversation, mergeLine, prState } from './PrConversation';

const pr = (over: Partial<PrOverview> = {}): PrOverview => ({
  repo: 'acme/widget', number: 7, title: 'Make it faster', url: 'https://github.com/acme/widget/pull/7', author: 'alice', viewer: 'bob',
  state: 'OPEN', isDraft: false, body: '<!-- template -->\n## What\n\nA **faster** path.\n\n- [x] tests', createdAt: null, updatedAt: '2026-11-02T12:00:00Z',
  headRefName: 'alice/fast', baseRefName: 'main', reviewDecision: null, mergeable: 'MERGEABLE', checkRollup: null,
  checks: [{ name: 'ci', state: 'passed' }], requestedReviewers: ['carol'], additions: 3, deletions: 1, changedFiles: 1,
  files: [{ path: 'src/fast.ts', additions: 3, deletions: 1, changeType: 'MODIFIED' }], filesTruncated: false,
  reviews: [{ author: 'dave', state: 'APPROVED', submittedAt: '2026-11-02T12:00:00Z' }], viewerReview: null, viewerCanReview: false,
  mergeStateStatus: 'BLOCKED', autoMerge: false, nodeId: null, headSha: null, autoMergeMethod: null,
  mergeSettings: { methods: [], defaultMethod: null, autoMergeAllowed: false }, viewerCanMerge: false,
  failedSuites: { runs: [], other: [] }, requestedUsers: ['carol'], requestedTeams: [],
  ...over,
} as PrOverview);

const row = { kind: 'pr', repo: 'acme/widget', number: 7, title: 'acme/widget#7', url: 'https://github.com/acme/widget/pull/7' } as PrRow & { repo: string; number: number };
const html = (p: PrOverview | null, error: string | null = null) => renderToStaticMarkup(
  <MemoryRouter><PrConversation row={row} pr={p} error={error} now={Date.parse('2026-11-02T13:00:00Z')} onChanged={() => {}} /></MemoryRouter>,
);

describe('prState', () => {
  it('reads merged, closed, draft and open', () => {
    expect(prState({ state: 'MERGED', isDraft: false })).toBe('merged');
    expect(prState({ state: 'CLOSED', isDraft: true })).toBe('closed');
    expect(prState({ state: 'OPEN', isDraft: true })).toBe('draft');
    expect(prState({ state: 'OPEN', isDraft: false })).toBe('open');
  });
});

describe('mergeLine', () => {
  const base = { state: 'OPEN' as const, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', autoMerge: false };
  it('says a conflict first, then a draft, then GitHub’s merge state', () => {
    expect(mergeLine({ ...base, mergeable: 'CONFLICTING' })?.tone).toBe('bad');
    expect(mergeLine({ ...base, isDraft: true })?.text).toMatch(/^Draft/);
    expect(mergeLine(base)).toMatchObject({ tone: 'ok', text: 'Ready to merge.' });
    expect(mergeLine({ ...base, mergeStateStatus: 'BLOCKED', autoMerge: true })?.text).toBe('Blocked until its required reviews and checks pass. Auto-merge is on.');
    expect(mergeLine({ ...base, mergeStateStatus: 'BEHIND' })?.tone).toBe('wait');
  });
  it('has nothing to say for a closed PR, or a state GitHub hasn’t worked out', () => {
    expect(mergeLine({ ...base, state: 'MERGED' })).toBeNull();
    expect(mergeLine({ ...base, mergeStateStatus: 'UNKNOWN' })).toBeNull();
  });
});

describe('PrConversation', () => {
  it('draws the description as markdown, without the template’s comment', () => {
    const out = html(pr());
    expect(out).toContain('<strong>faster</strong>');
    expect(out).toContain('type="checkbox"');
    expect(out).not.toContain('template');
    expect(out).not.toContain('## What');
  });

  it('shows the state, the branches and who reviews it', () => {
    const out = html(pr());
    expect(out).toContain('data-state="open"');
    expect(out).toContain('alice/fast');
    expect(out).toContain('dave');
    expect(out).toContain('carol');
    expect(out).toContain('1 check passed');
  });

  it('has no action card for a PR the viewer can neither review nor merge', () => {
    expect(html(pr())).not.toContain('prc-act');
    expect(html(pr({ viewerCanReview: true }))).toContain('Your review');
  });

  it('says it is reading, or why it could not', () => {
    expect(html(null)).toContain('Reading from GitHub');
    expect(html(null, 'GitHub said no')).toContain('GitHub said no');
  });
});
