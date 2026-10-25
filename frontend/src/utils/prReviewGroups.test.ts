import { describe, expect, it } from 'vitest';
import type { PrGroupMember, PrPipelineResponse, PrReviewGroup, PrRow } from '../services/api';
import {
  closedGroups, groupKey, groupPill, groupPlaces, groupProgress, groupReviewBody, groupReviewPlan, groupSize, isCardView, memberRows, memberStatus, moved, nextMember,
  openGroups, parseGroupPr, acceptSuggestion, suggestionWhy, suggestionsOf,
} from './prReviewGroups';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const row = (over: Partial<PrRow> = {}): PrRow => ({
  kind: 'pr', lane: 'needs_my_review', repo: 'example-org/termag', number: 646, title: 'Bridge', url: 'u', author: 'dev',
  headRefName: 'b', baseRefName: 'main', at: null, badges: [], failingChecks: [], checksFailed: false, pendingChecks: [], waitingOn: [],
  blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, workstream: null, requestedAt: null, reviewTarget: null, ...over,
});
const member = (over: Partial<PrGroupMember> = {}): PrGroupMember => ({
  repo: 'example-org/termag', number: 646, note: null, title: 'Bridge', url: 'u', author: 'dev', state: 'open',
  yourReview: null, askedYou: true, checked: false, row: row(), inLane: true, ...over,
});
const group = (members: PrGroupMember[], over: Partial<PrReviewGroup> = {}): PrReviewGroup => ({
  id: 'g1', name: 'Desktop bridge', closedAt: null, createdAt: '2026-10-24T00:00:00Z', members,
  done: members.length > 0 && members.every(m => m.checked), ...over,
});
const res = (groups: PrReviewGroup[]): PrPipelineResponse => ({
  connected: true, viewer: 'me', lanes: [], prod: { sha: null, source: 'unknown' }, boxes: 0, fetchedAt: '2026-10-24T12:00:00Z', notes: [], groups,
});

describe('parseGroupPr', () => {
  it('reads a URL, owner/name#N and name#N, the owner from a known repository', () => {
    expect(parseGroupPr('https://github.com/example-org/terraform/pull/28576')).toEqual({ repo: 'example-org/terraform', number: 28576 });
    expect(parseGroupPr(' example-org/termag#646 ')).toEqual({ repo: 'example-org/termag', number: 646 });
    expect(parseGroupPr('Labs-Thing#3', ['example-team/labs-thing'])).toEqual({ repo: 'example-team/labs-thing', number: 3 });
    expect(parseGroupPr('terraform#28576')).toEqual({ repo: 'example-org/terraform', number: 28576 });
  });
  it('refuses a bare number or anything else', () => {
    expect(parseGroupPr('646')).toBeNull();
    expect(parseGroupPr('#646')).toBeNull();
    expect(parseGroupPr('https://github.com/example-org/termag/issues/1')).toBeNull();
  });
});

describe('memberStatus', () => {
  it('says why each member waits, or what checked it off', () => {
    expect(memberStatus(member(), 'me', NOW)).toBe('needs your review');
    expect(memberStatus(member({ yourReview: 'APPROVED' }), 'me', NOW)).toBe('asks for your review again');
    expect(memberStatus(member({ askedYou: false, checked: true, yourReview: 'APPROVED' }), 'me', NOW)).toBe('approved by you');
    expect(memberStatus(member({ askedYou: false, checked: true, yourReview: 'COMMENTED' }), 'me', NOW)).toBe('you reviewed it');
    expect(memberStatus(member({ askedYou: false, author: 'someone', row: row({ lane: 'team_review', askedYou: false }), inLane: false }), 'me', NOW))
      .toBe('by someone · not asked of you');
    expect(memberStatus(member({ state: 'merged', checked: true }), 'me', NOW)).toBe('merged');
    expect(memberStatus(member({ state: 'closed', checked: true }), 'me', NOW)).toBe('closed without merging');
    expect(memberStatus(member({ state: 'unknown', row: null }), 'me', NOW)).toBe('could not read it from GitHub');
    expect(memberStatus(member({ state: 'missing', row: null }), 'me', NOW)).toBe('not on GitHub (or not visible to you)');
  });
  it('gives your own PR its lane and detail', () => {
    const mine = member({ author: 'Me', askedYou: false, row: row({ lane: 'checks', author: 'Me', pendingChecks: ['ci'] }) });
    expect(memberStatus(mine, 'me', NOW)).toBe('yours · Checks: running: ci');
  });
});

describe('the card\'s numbers', () => {
  it('counts what is left to review, and the PRs and repositories', () => {
    const g = group([member({ checked: true }), member({ number: 647 }), member({ repo: 'example-org/terraform', number: 28576, askedYou: false })]);
    expect(groupProgress(g, 'me')).toBe('2 of 3 to review');
    expect(groupSize(g)).toBe('3 PRs · 2 repos');
    expect(nextMember(g, 'me')?.number).toBe(647);
    expect(groupProgress(group([member({ checked: true })]), 'me')).toBe('done');
    expect(groupProgress(group([]), 'me')).toBe('no pull requests yet');
    expect(nextMember(group([member({ checked: true })]), 'me')).toBeNull();
  });
  it('leaves your own PRs out of the count and out of next (Devin)', () => {
    const mine = member({ number: 648, author: 'Me', askedYou: false, row: null });
    const g = group([mine, member({ number: 647 })]);
    expect(groupProgress(g, 'me')).toBe('1 of 2 to review');
    expect(nextMember(g, 'me')?.number).toBe(647);
    // Only yours left, not yet merged: nothing to review, but not done either.
    const onlyMine = group([member({ checked: true }), mine]);
    expect(onlyMine.done).toBe(false);
    expect(groupProgress(onlyMine, 'me')).toBe('nothing left to review');
    expect(nextMember(onlyMine, 'me')).toBeNull();
  });
});

describe('places and pills', () => {
  it('maps each open group\'s members by lowercased key to their place, closed groups left out', () => {
    const g = group([member({ repo: 'Example-Org/Termag', number: 646 }), member({ repo: 'example-org/terraform', number: 28576 })]);
    const closed = group([member({ number: 1 })], { id: 'g2', closedAt: '2026-10-20T00:00:00Z' });
    const places = groupPlaces(res([g, closed]));
    expect(groupPill(places.get(groupKey(row({ repo: 'example-org/terraform', number: 28576 }))!))).toBe('Desktop bridge 2/2');
    expect(places.get('example-org/termag#646')?.index).toBe(1);
    expect(places.has('example-org/termag#1')).toBe(false);
    expect(openGroups(res([g, closed])).map(x => x.id)).toEqual(['g1']);
    expect(closedGroups(res([g, closed])).map(x => x.id)).toEqual(['g2']);
    expect(groupPill(undefined)).toBeNull();
  });
  it('lists every member row for selection, skipping unread ones', () => {
    const g = group([member(), member({ number: 9, row: null, state: 'unknown' })]);
    expect(memberRows(res([g])).map(r => r.number)).toEqual([646]);
    expect(memberRows({ connected: false })).toEqual([]);
  });
  it('knows the card views', () => {
    expect(isCardView('needs_you')).toBe(true);
    expect(isCardView('needs_my_review')).toBe(true);
    expect(isCardView('team_review')).toBe(false);
  });
});

describe('moved', () => {
  it('moves one item, and leaves the list alone out of range', () => {
    expect(moved(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moved(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    const list = ['a'];
    expect(moved(list, 0, 3)).toBe(list);
  });
});

describe('groupReviewPlan (Review all with Devin)', () => {
  const termagMain = { projectId: 'p1', projectName: 'termag', workstream: 'main' };
  const tfMain = { projectId: 'p9', projectName: 'terraform', workstream: 'main' };
  it('takes the members left to review, in order, into the first one\'s pane', () => {
    const g = group([
      member({ number: 646, checked: true, row: row({ number: 646, reviewTarget: termagMain }) }),
      member({ repo: 'example-org/terraform', number: 28576, askedYou: false, row: row({ repo: 'example-org/terraform', number: 28576, reviewTarget: null }) }),
      member({ number: 647, row: row({ number: 647, reviewTarget: termagMain }) }),
      member({ number: 648, author: 'me', askedYou: false, row: row({ number: 648, lane: 'checks', reviewTarget: null }) }),
    ]);
    const plan = groupReviewPlan(g, 'me');
    // Checked off and your own are left out; terraform has no pane, so the review runs in termag's, and still covers it.
    expect(plan).toEqual({ members: [g.members[1], g.members[2]], target: termagMain });
    expect(groupReviewBody(g, (plan as { members: PrGroupMember[] }).members)).toEqual({
      name: 'Desktop bridge',
      members: [{ repo: 'example-org/terraform', number: 28576, note: null }, { repo: 'example-org/termag', number: 647, note: null }],
    });
  });
  it('prefers the first member\'s own pane when it has one', () => {
    const g = group([
      member({ repo: 'example-org/terraform', number: 28576, row: row({ repo: 'example-org/terraform', number: 28576, reviewTarget: tfMain }) }),
      member({ number: 647, row: row({ number: 647, reviewTarget: termagMain }) }),
    ]);
    expect(groupReviewPlan(g, 'me')).toMatchObject({ target: tfMain });
  });
  it('falls back to a pane of a member already checked off, or yours (Bugbot)', () => {
    const g = group([
      member({ number: 646, checked: true, row: row({ number: 646, reviewTarget: termagMain }) }),
      member({ repo: 'example-org/terraform', number: 28576, askedYou: false, row: row({ repo: 'example-org/terraform', number: 28576, reviewTarget: null }) }),
    ]);
    expect(groupReviewPlan(g, 'me')).toEqual({ members: [g.members[1]], target: termagMain });
  });
  it('runs the rest in a merged or own member\'s pane, whose row has no reviewTarget (Devin)', () => {
    const merged = member({ number: 646, state: 'merged', checked: true, pane: termagMain, row: row({ number: 646, lane: 'merged', reviewTarget: null }) });
    const tf = member({ repo: 'example-org/terraform', number: 28576, askedYou: false, pane: null, row: row({ repo: 'example-org/terraform', number: 28576, lane: 'team_review', reviewTarget: null }) });
    expect(groupReviewPlan(group([merged, tf]), 'me')).toEqual({ members: [tf], target: termagMain });
    const mine = member({ number: 648, author: 'me', askedYou: false, pane: termagMain, row: row({ number: 648, lane: 'checks', reviewTarget: null }) });
    expect(groupReviewPlan(group([mine, tf]), 'me')).toEqual({ members: [tf], target: termagMain });
  });
  it('says why not: nothing left, or nowhere to review from', () => {
    expect(groupReviewPlan(group([member({ checked: true })]), 'me')).toEqual({ reason: 'Nothing left to review in this group' });
    expect(groupReviewPlan(group([member({ row: row({ reviewTarget: null }) })]), 'me'))
      .toEqual({ reason: 'No checkout to review from: make a project for one of these repositories' });
  });
});

describe('suggested groups', () => {
  const sugg = (over: Partial<import('../services/api').PrGroupSuggestion> = {}) => ({
    key: 'k', name: 'feat(desktop): bridge', reason: 'references' as const, target: null,
    members: [{ repo: 'example-org/termag', number: 646, title: 'Bridge', url: 'u', author: 'dev' }, { repo: 'example-org/terraform', number: 28576, title: 'ALB', url: 'u', author: 'dev' }],
    ...over,
  });
  it('says why, and reads them off the answer', () => {
    expect(suggestionWhy(sugg())).toBe('2 PRs · their descriptions name each other');
    expect(suggestionWhy(sugg({ reason: 'stack' }))).toBe('2 PRs · one is based on another\'s branch');
    expect(suggestionsOf({ connected: false })).toEqual([]);
    expect(suggestionsOf(res([]))).toEqual([]);
  });
  it('makes a new group of the members, or adds them after a target\'s own', () => {
    expect(acceptSuggestion(sugg(), [])).toEqual({ create: { name: 'feat(desktop): bridge', members: [
      { repo: 'example-org/termag', number: 646, note: null }, { repo: 'example-org/terraform', number: 28576, note: null },
    ] } });
    const g = group([member({ number: 647, note: 'box' })]);
    expect(acceptSuggestion(sugg({ target: { id: 'g1', name: 'Desktop bridge' } }), [g])).toEqual({ set: { id: 'g1', members: [
      { repo: 'example-org/termag', number: 647, note: 'box' }, { repo: 'example-org/termag', number: 646, note: null }, { repo: 'example-org/terraform', number: 28576, note: null },
    ] } });
    expect(acceptSuggestion(sugg({ target: { id: 'gone', name: 'x' } }), [g])).toEqual({ gone: true });
  });
});

