// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrLane, PrPipelineResponse, PrRow } from '../services/api';
import { PrsOverlay } from './PrsOverlay';
import { OPEN_PALETTE_EVENT } from '../utils/searchPalette';

const mocks = vi.hoisted(() => ({ data: null as unknown }));

vi.mock('../pages/dashboard/useDashboardData', () => ({
  usePolled: () => ({ data: mocks.data, loading: false, error: null, refresh: () => {} }),
}));
vi.mock('../pages/dashboard/PrOverviewDialog', () => ({ PrDetail: () => null }));
vi.mock('../pages/dashboard/AttentionSection', () => ({ projectHref: () => '/' }));
vi.mock('./PrWorkstreamPicker', () => ({ PrWorkstreamPicker: () => null }));
vi.mock('../services/api', () => ({ prsApi: {}, reviewApi: {} }));

function row(over: Partial<PrRow>): PrRow {
  return {
    kind: 'pr', lane: 'checks', repo: 'example-org/termag', number: 1, title: 't', url: 'u', author: 'me',
    headRefName: 'feat', baseRefName: 'main', at: null, badges: [], failingChecks: ['ci'], pendingChecks: [], waitingOn: [],
    blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, workstream: null, requestedAt: null, reviewTarget: null,
    ...over,
  };
}
const lane = (id: PrLane['id'], rows: PrRow[]): PrLane => ({ id, label: id, rows });

const RES = {
  connected: true, viewer: 'me', prod: { sha: null, source: 'unknown' }, boxes: 0, fetchedAt: new Date().toISOString(), notes: [],
  lanes: [lane('checks', [
    row({ number: 1, title: 'termag one' }),
    row({ number: 2, title: 'webapp two', repo: 'example-org/webapp' }),
    row({ number: 3, title: 'termag three' }),
  ])],
} as unknown as PrPipelineResponse;

let search = '';
let nav: NavigateFunction;
function Probe() {
  search = useLocation().search;
  nav = useNavigate();
  return null;
}

let host: HTMLDivElement;
let root: Root;

function render(url: string) {
  act(() => {
    // A real history: the overlay builds its next URL from window.location, as in the app.
    window.history.replaceState(null, '', url);
    root.render(<BrowserRouter><PrsOverlay /><Probe /></BrowserRouter>);
  });
}
const titles = () => [...document.querySelectorAll('.prso-row-title')].map(e => e.textContent);
const chip = () => document.querySelector<HTMLElement>('.prso-repo-chip');
const tabCount = (label: string) => [...document.querySelectorAll('.prs-lane')]
  .find(t => t.querySelector('.prs-lane-label')?.textContent === label)?.querySelector('.prs-lane-count')?.textContent;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = vi.fn(); // jsdom has no layout
  mocks.data = RES;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

describe('PrsOverlay repositories', () => {
  // Reviews asked of you, by name and by team only, in two repos: what the Needs you number counts.
  beforeEach(() => {
    mocks.data = { ...RES, lanes: [...(RES as { lanes: PrLane[] }).lanes, lane('needs_my_review', [
      row({ lane: 'needs_my_review', number: 10, title: 'termag review', author: 'ana', askedYou: true }),
      row({ lane: 'needs_my_review', number: 11, title: 'termag team review', author: 'ana', askedYou: false }),
      row({ lane: 'needs_my_review', number: 12, title: 'webapp review', repo: 'example-org/webapp', author: 'ana', askedYou: true }),
    ])] };
  });

  it('shows every repository, with no repo picker', () => {
    render('/?prs=checks');
    expect(document.querySelector('select')).toBeNull();
    expect(chip()).toBeNull();
    expect(titles()).toEqual(['termag one', 'webapp two', 'termag three']);
    expect(tabCount('Checks')).toBe('3');
    // Reviews asked of you by name: not the team-only one, nor the failing checks it lists.
    expect(tabCount('Needs you')).toBe('2');
  });

  it('a link naming a repository narrows rows and counts, and says so in a chip', () => {
    render('/?prs=checks&prs_repo=example-org%2Ftermag');
    expect(chip()?.textContent).toContain('only termag');
    expect(titles()).toEqual(['termag one', 'termag three']);
    expect(tabCount('Checks')).toBe('2');
    expect(tabCount('Needs you')).toBe('1');
  });

  it("the chip's ✕ goes back to every repository, keeping the page's own parameters", () => {
    render('/?project=p1&prs=checks&prs_repo=example-org%2Fwebapp');
    expect(titles()).toEqual(['webapp two']);
    act(() => chip()!.querySelector('button')!.click());
    const q = new URLSearchParams(search);
    expect(q.has('prs_repo')).toBe(false);
    expect(q.get('project')).toBe('p1');
    expect(chip()).toBeNull();
    expect(titles()).toEqual(['termag one', 'webapp two', 'termag three']);
  });

  it('says the filtered view is empty', () => {
    render('/?prs=checks&prs_repo=example-org%2Fgone');
    expect(titles()).toEqual([]);
    expect(document.querySelector('.prso-empty')?.textContent).toContain('Nothing from example-org/gone in checks.');
  });
});

describe('PrsOverlay search', () => {
  const opened: unknown[] = [];
  const onOpen = (e: Event) => opened.push((e as CustomEvent).detail);
  beforeEach(() => { opened.length = 0; window.addEventListener(OPEN_PALETTE_EVENT, onOpen); });
  afterEach(() => { window.removeEventListener(OPEN_PALETTE_EVENT, onOpen); });

  it('has one search, the ⌘K palette: no find box of its own', () => {
    render('/?prs=checks');
    expect(document.querySelector('input[type="search"]')).toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('.prso-search')!.click());
    expect(opened).toEqual([{ via: 'prs-overlay' }]);
  });

  it('/ opens the palette too', () => {
    render('/?prs=checks');
    act(() => { document.querySelector<HTMLElement>('.prso')!.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true })); });
    expect(opened).toEqual([{ via: 'prs-overlay' }]);
  });

  it('picking the selected deferred row again (⌘K), after folding the list, opens it again', () => {
    const key = 'example-org/terraform#28280';
    mocks.data = {
      ...RES,
      lanes: [...(RES as { lanes: PrLane[] }).lanes, lane('needs_my_review', [row({ lane: 'needs_my_review', repo: 'example-org/terraform', number: 28280, title: 'Envoy route', failingChecks: [] })])],
      deferred: [{ key, until: new Date(Date.now() + 3_600_000).toISOString() }],
    };
    const url = `/?prs=needs_my_review&pr=${encodeURIComponent(key)}`;
    render(url);
    const toggle = () => document.querySelector<HTMLButtonElement>('.prso-deferred-toggle')!;
    act(() => toggle().click());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    // ⌘K's pick: a navigation to the same URL.
    act(() => nav(url, { replace: true }));
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('a deferred row named in the URL (⌘K, a link) opens the Deferred list', () => {
    mocks.data = {
      ...RES,
      lanes: [...(RES as { lanes: PrLane[] }).lanes, lane('needs_my_review', [row({ lane: 'needs_my_review', repo: 'example-org/terraform', number: 28280, title: 'Envoy route', failingChecks: [] })])],
      deferred: [{ key: 'example-org/terraform#28280', until: new Date(Date.now() + 3_600_000).toISOString() }],
    };
    render('/?prs=needs_my_review&pr=example-org%2Fterraform%2328280');
    expect(document.querySelector('.prso-deferred-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.prso-row.active .prso-row-title')?.textContent).toBe('Envoy route');
  });
});
