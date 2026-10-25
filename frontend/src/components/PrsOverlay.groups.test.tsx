// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrGroupMember, PrLane, PrPipelineResponse, PrReviewGroup, PrRow } from '../services/api';
import { PrsOverlay } from './PrsOverlay';

// The overlay with review groups.
const mocks = vi.hoisted(() => ({
  data: null as unknown, groupsOn: true, defer: vi.fn(async () => ({})), start: vi.fn(async () => ({ ok: true })),
  createGroup: vi.fn(async () => ({ id: 'g9' })), setGroupMembers: vi.fn(async () => ({ ok: true })), dismissSuggestion: vi.fn(async () => undefined),
}));

vi.mock('../pages/dashboard/useDashboardData', () => ({
  usePolled: () => ({ data: mocks.data, loading: false, error: null, refresh: () => {} }),
}));
vi.mock('../pages/dashboard/PrOverviewDialog', () => ({ PrDetail: () => null }));
vi.mock('../pages/dashboard/AttentionSection', () => ({ projectHref: () => '/' }));
vi.mock('./PrWorkstreamPicker', () => ({ PrWorkstreamPicker: () => null }));
vi.mock('./SharePrPreview', () => ({ SharePrPreview: () => null }));
vi.mock('../services/api', () => ({ prsApi: { defer: mocks.defer, createGroup: mocks.createGroup, setGroupMembers: mocks.setGroupMembers, dismissSuggestion: mocks.dismissSuggestion }, reviewApi: { start: mocks.start } }));
vi.mock('../flags', () => ({
  FLAGS: { prReviewGroups: 'pr-review-groups-enabled' },
  useFlag: (key: string, fallback: boolean) => (key === 'pr-review-groups-enabled' ? mocks.groupsOn : fallback),
}));

function row(over: Partial<PrRow>): PrRow {
  return {
    kind: 'pr', lane: 'needs_my_review', repo: 'example-org/termag', number: 1, title: 't', url: 'u', author: 'ana',
    headRefName: 'feat', baseRefName: 'main', at: null, badges: [], failingChecks: [], checksFailed: false, pendingChecks: [], waitingOn: [],
    blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, workstream: null, requestedAt: null, reviewTarget: null, askedYou: true,
    ...over,
  };
}
const lane = (id: PrLane['id'], rows: PrRow[]): PrLane => ({ id, label: id, rows });
const member = (r: PrRow, over: Partial<PrGroupMember> = {}): PrGroupMember => ({
  repo: r.repo!, number: r.number!, note: null, title: r.title, url: 'u', author: r.author, state: 'open',
  yourReview: null, askedYou: r.askedYou !== false, checked: false, row: r, inLane: true, ...over,
});

const BRIDGE = row({ number: 646, title: 'bridge' });
const AGENT = row({ number: 647, title: 'agent' });
const OTHER = row({ number: 700, title: 'unrelated review' });
const MINE = row({ lane: 'checks', number: 648, title: 'my installer', author: 'me', failingChecks: ['ci'], askedYou: undefined });
// In no lane: a team review elsewhere, built for the card.
const ALB = row({ lane: 'team_review', repo: 'example-org/terraform', number: 28576, title: 'alb', askedYou: false });
const GROUP: PrReviewGroup = {
  id: 'g1', name: 'Desktop bridge', closedAt: null, createdAt: '2026-10-24T00:00:00Z', done: false,
  members: [member(BRIDGE), member(ALB, { inLane: false, askedYou: false }), member(AGENT), member(MINE, { askedYou: false })],
};
const RES = {
  connected: true, viewer: 'me', prod: { sha: null, source: 'unknown' }, boxes: 0, fetchedAt: new Date().toISOString(), notes: [],
  lanes: [lane('checks', [MINE]), lane('needs_my_review', [BRIDGE, AGENT, OTHER])],
  groups: [GROUP],
} as unknown as PrPipelineResponse;

let search = '';
function Probe() { search = useLocation().search; return null; }
let host: HTMLDivElement;
let root: Root;
function render(url: string) {
  act(() => {
    window.history.replaceState(null, '', url);
    root.render(<BrowserRouter><PrsOverlay /><Probe /></BrowserRouter>);
  });
}
const listTitles = () => [...document.querySelectorAll('.prso-row-title')].map(e => e.textContent);
const cardLabels = () => [...document.querySelectorAll('.prg-member .prso-label')].map(e => e.textContent);
const tabCount = (label: string) => [...document.querySelectorAll('.prs-lane')]
  .find(t => t.querySelector('.prs-lane-label')?.textContent === label)?.querySelector('.prs-lane-count')?.textContent;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = vi.fn();
  mocks.data = RES;
  mocks.groupsOn = true;
  mocks.defer.mockClear();
  mocks.start.mockClear();
  mocks.createGroup.mockClear();
  mocks.setGroupMembers.mockClear();
  mocks.dismissSuggestion.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

describe('PrsOverlay review groups', () => {
  it('heads Needs my review with the card, leaving its members out of the list, the counts unchanged', () => {
    render('/?prs=needs_my_review');
    expect(cardLabels()).toEqual(['termag#646', 'terraform#28576', 'termag#647', 'termag#648']);
    expect(listTitles()).toEqual(['unrelated review']);
    expect(tabCount('My review')).toBe('3');
    expect(tabCount('Needs you')).toBe('3');
  });
  it('does the same on Needs you, with the closed groups folded at its foot', () => {
    mocks.data = { ...RES, groups: [GROUP, { ...GROUP, id: 'g2', name: 'Old', closedAt: new Date(Date.now() - 86_400_000).toISOString(), members: [] }] };
    render('/?prs=needs_you');
    expect(cardLabels()).toEqual(['termag#646', 'terraform#28576', 'termag#647', 'termag#648']);
    expect(listTitles()).toEqual(['unrelated review']);
    expect(document.querySelectorAll('.prg-card')).toHaveLength(1);
    expect([...document.querySelectorAll('.prso-deferred-toggle')].map(b => b.textContent)).toContain('▸ Closed groups (1)');
  });
  it('picks a member no lane lists, so it opens in the detail pane', () => {
    render('/?prs=needs_my_review');
    act(() => (document.querySelectorAll('.prg-member')[1] as HTMLElement).click());
    expect(new URLSearchParams(search).get('pr')).toBe('example-org/terraform#28576');
    expect(document.querySelector('.prso-detail-head .pro-label')?.textContent).toBe('terraform#28576');
  });
  it('keeps a grouped row in other lanes, with its place in the group as a pill', () => {
    render('/?prs=checks');
    expect(listTitles()).toEqual(['my installer']);
    expect(document.querySelector('.prg-pill')?.textContent).toBe('Desktop bridge 4/4');
    expect(document.querySelectorAll('.prg-card')).toHaveLength(0);
  });
  it('j/k walk the card members first, then the list', () => {
    render('/?prs=needs_my_review&pr=example-org%2Ftermag%23646');
    const press = (key: string) => act(() => { document.querySelector<HTMLElement>('.prso')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
    const at = () => new URLSearchParams(search).get('pr');
    press('j');
    expect(at()).toBe('example-org/terraform#28576');
    press('j'); press('j');
    expect(at()).toBe('example-org/termag#648');
    press('j');
    expect(at()).toBe('example-org/termag#700');
    press('k');
    expect(at()).toBe('example-org/termag#648');
  });
  it('offers no Defer on a card member, and d does nothing there (Devin)', () => {
    render('/?prs=needs_my_review&pr=example-org%2Ftermag%23647');
    expect([...document.querySelectorAll('.prso-detail-head button')].map(b => b.textContent)).not.toContain('Defer a day');
    act(() => { document.querySelector<HTMLElement>('.prso')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true })); });
    expect(mocks.defer).not.toHaveBeenCalled();
  });
  it('still defers a row in the list', () => {
    render('/?prs=needs_my_review&pr=example-org%2Ftermag%23700');
    expect([...document.querySelectorAll('.prso-detail-head button')].map(b => b.textContent)).toContain('Defer a day');
    act(() => { document.querySelector<HTMLElement>('.prso')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true })); });
    expect(mocks.defer).toHaveBeenCalledWith('example-org/termag#700');
  });
  it('offers Add to group on the shown PR', () => {
    render('/?prs=needs_my_review&pr=example-org%2Ftermag%23700');
    expect([...document.querySelectorAll('.prso-detail-head button')].map(b => b.textContent)).toContain('Add to group…');
  });
  it('Review all with Devin starts one review of the members left, after a confirm', async () => {
    const termag = { projectId: 'p1', projectName: 'termag', workstream: 'main' };
    const withPane = (m: PrGroupMember) => (m.row && m.repo === 'example-org/termag' ? { ...m, row: { ...m.row, reviewTarget: termag } } : m);
    mocks.data = { ...RES, groups: [{ ...GROUP, members: GROUP.members.map(withPane) }] };
    render('/?prs=needs_my_review');
    const button = [...document.querySelectorAll('.prg-card button')].find(b => b.textContent === 'Review all with Devin') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    act(() => button.click());
    expect(document.body.textContent).toContain('Start one Devin review of the 3 PRs left in Desktop bridge (termag#646, terraform#28576, termag#647), in order, in termag?');
    await act(async () => { [...document.querySelectorAll('button')].find(b => b.textContent === 'Start review')!.click(); });
    expect(mocks.start).toHaveBeenCalledWith('p1', {
      workstream: 'main', pr: 646, url: 'u',
      group: { name: 'Desktop bridge', members: [
        { repo: 'example-org/termag', number: 646, note: null },
        { repo: 'example-org/terraform', number: 28576, note: null },
        { repo: 'example-org/termag', number: 647, note: null },
      ] },
    });
  });
  it('drops the confirm and says why when a refresh leaves nothing to start (Devin, #668)', () => {
    const termag = { projectId: 'p1', projectName: 'termag', workstream: 'main' };
    const withPane = (m: PrGroupMember) => ({ ...m, pane: termag });
    mocks.data = { ...RES, groups: [{ ...GROUP, members: GROUP.members.map(withPane) }] };
    render('/?prs=needs_my_review');
    act(() => ([...document.querySelectorAll('.prg-card button')].find(b => b.textContent === 'Review all with Devin') as HTMLButtonElement).click());
    expect(document.body.textContent).toContain('Start one Devin review');
    mocks.data = { ...RES, groups: [{ ...GROUP, members: GROUP.members.map(m => ({ ...withPane(m), checked: true, askedYou: false })) }] };
    render('/?prs=needs_my_review');
    expect(document.body.textContent).not.toContain('Start one Devin review');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Nothing left to review in this group');
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('disables Review all with Devin, saying why, when no member has a pane', () => {
    render('/?prs=needs_my_review');
    const button = [...document.querySelectorAll('.prg-card button')].find(b => b.textContent === 'Review all with Devin') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('No checkout to review from: make a project for one of these repositories');
  });
  it('shows nothing of groups with the flag off', () => {
    mocks.groupsOn = false;
    render('/?prs=needs_my_review');
    expect(document.querySelectorAll('.prg-card')).toHaveLength(0);
    expect(listTitles()).toEqual(['bridge', 'agent', 'unrelated review']);
    expect([...document.querySelectorAll('.prso-detail-head button')].map(b => b.textContent)).not.toContain('Add to group…');
  });
});

describe('suggested groups in the overlay (phase 3)', () => {
  const SUGG = {
    key: 'example-org/termag#700 example-org/termag#701', name: 'Unrelated review', reason: 'references' as const, target: null,
    members: [{ repo: 'example-org/termag', number: 700, title: 'unrelated review', url: 'u', author: 'ana' }, { repo: 'example-org/termag', number: 701, title: 'its follow-up', url: 'u', author: 'ana' }],
  };
  const press = async (text: string) => { await act(async () => { [...document.querySelectorAll('button')].find(b => b.textContent === text)!.click(); }); };

  it('offers a suggestion above the cards: make a group after naming it, or Not these', async () => {
    mocks.data = { ...RES, suggestions: [SUGG] };
    render('/?prs=needs_my_review');
    const card = document.querySelector('.prg-suggestion')!;
    expect(card.textContent).toContain('Suggested group');
    expect(card.textContent).toContain('2 PRs · their descriptions name each other');
    expect([...card.querySelectorAll('.prso-label')].map(e => e.textContent)).toEqual(['termag#700', 'termag#701']);
    await press('Make a group…');
    const input = document.querySelector<HTMLInputElement>('.prg-suggestion [aria-label="Group name"]')!;
    expect(input.value).toBe('Unrelated review');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Follow-ups');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press('Make the group');
    expect(mocks.createGroup).toHaveBeenCalledWith('Follow-ups', [
      { repo: 'example-org/termag', number: 700, note: null }, { repo: 'example-org/termag', number: 701, note: null },
    ]);
    await press('Not these');
    expect(mocks.dismissSuggestion).toHaveBeenCalledWith(SUGG.key);
  });
  it('adds to the group that holds some, after its own members', async () => {
    mocks.data = { ...RES, suggestions: [{ ...SUGG, target: { id: 'g1', name: 'Desktop bridge' } }] };
    render('/?prs=needs_you');
    expect(document.querySelector('.prg-suggestion')?.textContent).toContain('Suggested for Desktop bridge');
    await press('Add 2 to Desktop bridge');
    expect(mocks.setGroupMembers).toHaveBeenCalledWith('g1', [
      { repo: 'example-org/termag', number: 646, note: null }, { repo: 'example-org/terraform', number: 28576, note: null },
      { repo: 'example-org/termag', number: 647, note: null }, { repo: 'example-org/termag', number: 648, note: null },
      { repo: 'example-org/termag', number: 700, note: null }, { repo: 'example-org/termag', number: 701, note: null },
    ]);
  });
  it('says nothing needs you only when no suggestion is shown either (Bugbot)', () => {
    mocks.data = { ...RES, lanes: [], groups: [], suggestions: [SUGG] };
    render('/?prs=needs_you');
    expect(document.querySelector('.prg-suggestion')).not.toBeNull();
    expect(document.body.textContent).not.toContain('needs you right now');
    mocks.data = { ...RES, lanes: [], groups: [], suggestions: [] };
    render('/?prs=needs_you');
    expect(document.body.textContent).toContain('Nothing needs you right now.');
  });
  it('shows no suggestion in other lanes, or with the flag off', () => {
    mocks.data = { ...RES, suggestions: [SUGG] };
    render('/?prs=checks');
    expect(document.querySelector('.prg-suggestion')).toBeNull();
    mocks.groupsOn = false;
    render('/?prs=needs_my_review');
    expect(document.querySelector('.prg-suggestion')).toBeNull();
  });
});

