// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrGroupMember, PrLane, PrPipelineResponse, PrReviewGroup, PrRow } from '../../services/api';
import { Prs } from './Prs';

// The phone's PR screen with review groups.
const mocks = vi.hoisted(() => ({
  data: null as unknown,
  groupsOn: true,
  start: vi.fn(async () => ({ ok: true })),
  setGroupMembers: vi.fn(async () => ({ ok: true })),
  createGroup: vi.fn(async () => ({ id: 'g9' })),
  dismissSuggestion: vi.fn(async () => undefined),
  overview: null as unknown,
}));
vi.mock('../dashboard/useDashboardData', () => ({
  usePolled: () => ({ data: mocks.data, loading: false, error: null, refresh: () => {} }),
}));
vi.mock('../dashboard/PrOverviewDialog', () => ({
  PrOverviewDialog: ({ row }: { row: PrRow }) => { mocks.overview = row; return <div className="overview">{`${row.repo}#${row.number}`}</div>; },
}));
vi.mock('./PullScroll', () => ({ PullScroll: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('../../services/api', () => ({
  prsApi: { setGroupMembers: mocks.setGroupMembers, createGroup: mocks.createGroup, dismissSuggestion: mocks.dismissSuggestion },
  reviewApi: { start: mocks.start },
}));
vi.mock('../../flags', () => ({
  FLAGS: { prReviewGroups: 'pr-review-groups-enabled' },
  useFlag: (key: string, fallback: boolean) => (key === 'pr-review-groups-enabled' ? mocks.groupsOn : fallback),
}));

const TERMAG = { projectId: 'p1', projectName: 'termag', workstream: 'main' };
function row(over: Partial<PrRow>): PrRow {
  return {
    kind: 'pr', lane: 'needs_my_review', repo: 'example-org/termag', number: 1, title: 't', url: 'u', author: 'ana',
    headRefName: 'feat', baseRefName: 'main', at: null, badges: [], failingChecks: [], checksFailed: false, pendingChecks: [], waitingOn: [],
    blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, workstream: null, requestedAt: null, reviewTarget: TERMAG, askedYou: true,
    ...over,
  };
}
const lane = (id: PrLane['id'], rows: PrRow[]): PrLane => ({ id, label: id, rows });
const member = (r: PrRow, over: Partial<PrGroupMember> = {}): PrGroupMember => ({
  repo: r.repo!, number: r.number!, note: null, title: r.title, url: `https://github.com/${r.repo}/pull/${r.number}`, author: r.author, state: 'open',
  yourReview: null, askedYou: true, checked: false, row: r, inLane: true, ...over,
});
const BRIDGE = row({ number: 646, title: 'bridge' });
const AGENT = row({ number: 647, title: 'agent' });
const OTHER = row({ number: 700, title: 'unrelated review' });
const MINE = row({ lane: 'checks', number: 648, title: 'my installer', author: 'me', failingChecks: ['ci'], askedYou: undefined, reviewTarget: null });
const GROUP: PrReviewGroup = {
  id: 'g1', name: 'Desktop bridge', closedAt: null, createdAt: '2026-10-24T00:00:00Z', done: false,
  members: [member(BRIDGE, { checked: true, askedYou: false, yourReview: 'APPROVED' }), member(AGENT, { note: 'box side' }), member(MINE, { askedYou: false })],
};
const RES = {
  connected: true, viewer: 'me', prod: { sha: null, source: 'unknown' }, boxes: 0, fetchedAt: new Date().toISOString(), notes: [],
  lanes: [lane('checks', [MINE]), lane('needs_my_review', [BRIDGE, AGENT, OTHER])],
  groups: [GROUP],
} as unknown as PrPipelineResponse;

let path = '';
function Probe() { const l = useLocation(); path = l.pathname + l.search; return null; }
let host: HTMLDivElement;
let root: Root;
function render(url: string) {
  act(() => {
    root.render(<MemoryRouter initialEntries={[url]}><Routes><Route path="/m/prs" element={<Prs />} /><Route path="*" element={null} /></Routes><Probe /></MemoryRouter>);
  });
}
const titles = () => [...document.querySelectorAll('.m-pr-row:not(.m-prg-head) .m-row-title')].map(e => e.textContent);
const button = (text: string | RegExp) => [...document.querySelectorAll('button')].find(b => (typeof text === 'string' ? b.textContent === text : text.test(b.textContent ?? ''))) as HTMLButtonElement | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = vi.fn();
  mocks.data = RES;
  mocks.groupsOn = true;
  mocks.overview = null;
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

describe('the phone\'s PR screen with review groups', () => {
  it('heads My review with a folded card, its grouped rows left to it', () => {
    render('/m/prs?lane=needs_my_review');
    expect(document.querySelector('.m-prg-head')?.textContent).toContain('Desktop bridge');
    expect(document.querySelector('.m-prg-head')?.textContent).toContain('3 PRs · 1 repo · 1 of 3 to review');
    expect(document.querySelector('.m-prg-body')).toBeNull();
    expect(titles()).toEqual(['unrelated review']);
  });
  it('opens to the ordered list; a member opens its overview, and Review next the next one', () => {
    render('/m/prs?lane=needs_my_review');
    act(() => document.querySelector<HTMLButtonElement>('.m-prg-head')!.click());
    const members = [...document.querySelectorAll('.m-prg-member')];
    expect(members.map(m => m.querySelector('.m-prg-mark')?.textContent)).toEqual(['✓', '→', '3']);
    expect(members[1].querySelector('.m-row-preview')?.textContent).toBe('termag#647 · needs your review · box side');
    act(() => (members[0] as HTMLElement).click());
    expect((mocks.overview as PrRow).number).toBe(646);
    act(() => button('Review next · termag#647')!.click());
    expect((mocks.overview as PrRow).number).toBe(647);
  });
  it('Review all with Devin confirms, starts one review of what is left, and lands on its tab', async () => {
    render('/m/prs?lane=needs_my_review');
    act(() => document.querySelector<HTMLButtonElement>('.m-prg-head')!.click());
    act(() => button('Review all with Devin (1)…')!.click());
    expect(document.querySelector('.m-sheet-message')?.textContent).toContain('Start one Devin review of the 1 PR left in Desktop bridge (termag#647), in order, in termag?');
    await act(async () => { button('Start review')!.click(); });
    expect(mocks.start).toHaveBeenCalledWith('p1', {
      workstream: 'main', pr: 647, url: 'https://github.com/example-org/termag/pull/647',
      group: { name: 'Desktop bridge', members: [{ repo: 'example-org/termag', number: 647, note: 'box side' }] },
    });
    expect(path).toBe('/m/p/p1?role=review');
  });
  it('names a grouped row\'s place elsewhere, and its ⋯ offers the group', async () => {
    render('/m/prs?lane=checks');
    expect(document.querySelector('.m-prg-pill')?.textContent).toBe(' · Desktop bridge 3/3');
    act(() => document.querySelector<HTMLButtonElement>('.m-more')!.click());
    act(() => button('Review group: Desktop bridge 3/3…')!.click());
    await act(async () => { button('Take it out of Desktop bridge')!.click(); });
    expect(mocks.setGroupMembers).toHaveBeenCalledWith('g1', [
      { repo: 'example-org/termag', number: 646, note: null },
      { repo: 'example-org/termag', number: 647, note: 'box side' },
    ]);
  });
  it('gives each card member its ⋯, so a PR only the card shows can leave the group (Bugbot)', async () => {
    render('/m/prs?lane=needs_my_review');
    act(() => document.querySelector<HTMLButtonElement>('.m-prg-head')!.click());
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Actions for termag#647"]')!.click());
    act(() => button('Review group: Desktop bridge 2/3…')!.click());
    await act(async () => { button('Take it out of Desktop bridge')!.click(); });
    expect(mocks.setGroupMembers).toHaveBeenCalledWith('g1', [
      { repo: 'example-org/termag', number: 646, note: null },
      { repo: 'example-org/termag', number: 648, note: null },
    ]);
  });
  it('gives a member GitHub could not read a ⋯ too: open it there, or take it out (Devin)', async () => {
    const bare = member(row({ repo: 'example-org/terraform', number: 28576 }), { row: null, state: 'unknown', title: '' });
    mocks.data = { ...RES, groups: [{ ...GROUP, members: [...GROUP.members, bare] }] };
    render('/m/prs?lane=needs_my_review');
    act(() => document.querySelector<HTMLButtonElement>('.m-prg-head')!.click());
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Actions for terraform#28576"]')!.click());
    expect(button('Open on GitHub')).toBeDefined();
    await act(async () => { button('Take it out of Desktop bridge')!.click(); });
    expect(mocks.setGroupMembers).toHaveBeenCalledWith('g1', [
      { repo: 'example-org/termag', number: 646, note: null },
      { repo: 'example-org/termag', number: 647, note: 'box side' },
      { repo: 'example-org/termag', number: 648, note: null },
    ]);
  });
  it('drops the confirm and says why when a refresh leaves nothing to start (Devin)', () => {
    render('/m/prs?lane=needs_my_review');
    act(() => document.querySelector<HTMLButtonElement>('.m-prg-head')!.click());
    act(() => button('Review all with Devin (1)…')!.click());
    expect(document.querySelector('.m-sheet-message')).not.toBeNull();
    // The last member left is checked off meanwhile.
    mocks.data = { ...RES, groups: [{ ...GROUP, members: GROUP.members.map(m => (m.number === 647 ? { ...m, checked: true, askedYou: false } : m)) }] };
    // The next poll's answer: tapping the lane re-renders the screen with it.
    act(() => document.querySelector<HTMLButtonElement>('[data-lane="needs_my_review"][role="tab"]')!.click());
    expect(document.querySelector('.m-sheet-message')).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Nothing left to review in this group');
  });
  it('adds an ungrouped row to a group, or to a new one', async () => {
    render('/m/prs?lane=needs_my_review');
    act(() => document.querySelector<HTMLButtonElement>('.m-more')!.click());
    act(() => button('Add to group…')!.click());
    await act(async () => { button('Add to Desktop bridge (3)')!.click(); });
    expect(mocks.setGroupMembers).toHaveBeenCalledWith('g1', [
      { repo: 'example-org/termag', number: 646, note: null },
      { repo: 'example-org/termag', number: 647, note: 'box side' },
      { repo: 'example-org/termag', number: 648, note: null },
      { repo: 'example-org/termag', number: 700, note: null },
    ]);
    act(() => document.querySelector<HTMLButtonElement>('.m-more')!.click());
    act(() => button('Add to group…')!.click());
    const input = document.querySelector<HTMLInputElement>('[aria-label="New group name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Reviews');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button('New group')!.click(); });
    expect(mocks.createGroup).toHaveBeenCalledWith('Reviews', [{ repo: 'example-org/termag', number: 700, note: null }]);
  });
  it('shows nothing of groups with the flag off', () => {
    mocks.groupsOn = false;
    render('/m/prs?lane=needs_my_review');
    expect(document.querySelector('.m-prg')).toBeNull();
    expect(titles()).toEqual(['bridge', 'agent', 'unrelated review']);
    act(() => document.querySelector<HTMLButtonElement>('.m-more')!.click());
    expect(button('Add to group…')).toBeUndefined();
  });
});

describe('suggested groups on the phone (phase 3)', () => {
  const SUGG = {
    key: 'k1', name: 'Unrelated review', reason: 'stack' as const, target: null,
    members: [{ repo: 'example-org/termag', number: 700, title: 'unrelated review', url: 'u', author: 'ana' }, { repo: 'example-org/termag', number: 701, title: 'stacked', url: 'u', author: 'ana' }],
  };
  it('lists a suggestion atop My review; its sheet makes the group or dismisses it', async () => {
    mocks.data = { ...RES, suggestions: [SUGG] };
    render('/m/prs?lane=needs_my_review');
    const head = document.querySelector('.m-prg-suggestion')!;
    expect(head.textContent).toContain('Suggested group');
    expect(head.textContent).toContain("2 PRs · one is based on another's branch · termag#700, termag#701");
    act(() => (head.querySelector('button') as HTMLButtonElement).click());
    expect([...document.querySelectorAll('.m-sheet-steps li')].map(l => l.textContent)).toEqual(['termag#700 · unrelated review', 'termag#701 · stacked']);
    await act(async () => { button('Make the group')!.click(); });
    expect(mocks.createGroup).toHaveBeenCalledWith('Unrelated review', [
      { repo: 'example-org/termag', number: 700, note: null }, { repo: 'example-org/termag', number: 701, note: null },
    ]);
    act(() => (document.querySelector('.m-prg-suggestion button') as HTMLButtonElement).click());
    await act(async () => { button('Not these')!.click(); });
    expect(mocks.dismissSuggestion).toHaveBeenCalledWith('k1');
  });
  it('shows no empty-lane line beside a suggestion (Bugbot)', () => {
    mocks.data = { ...RES, lanes: [{ id: 'needs_my_review', label: 'needs_my_review', rows: [] }], groups: [], suggestions: [SUGG] };
    render('/m/prs?lane=needs_my_review');
    expect(document.querySelector('.m-prg-suggestion')).not.toBeNull();
    expect(document.querySelector('.m-empty')).toBeNull();
  });
  it('shows none with the flag off', () => {
    mocks.data = { ...RES, suggestions: [SUGG] };
    mocks.groupsOn = false;
    render('/m/prs?lane=needs_my_review');
    expect(document.querySelector('.m-prg-suggestion')).toBeNull();
  });
});

