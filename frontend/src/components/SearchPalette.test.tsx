// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRecentSearches } from '../mobile/recentSearches';
import { OPEN_PALETTE_EVENT, type PaletteAction } from '../utils/searchPalette';
import { SearchPalette } from './SearchPalette';

const mocks = vi.hoisted(() => ({
  trackEvent: vi.fn(),
  openTarget: vi.fn(),
  prs: null as unknown,
}));
vi.mock('../contexts/ConnectionContext', () => ({ useConnection: () => ({ state: 'online' }) }));
vi.mock('../observability', () => ({ trackEvent: mocks.trackEvent }));
vi.mock('../hooks/useRecents', () => ({ useRecents: () => ({ rows: [], loading: false, refresh: () => {} }) }));
vi.mock('../mobile/useHome', () => ({ useHome: () => ({ rows: [], now: 0 }) }));
vi.mock('../services/api', () => ({ sessionsApi: { search: vi.fn() }, prsApi: { list: () => Promise.resolve(mocks.prs) } }));
vi.mock('./SessionList', () => ({ useOpenTarget: () => mocks.openTarget, SessionItem: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

let search = '';
function Probe() {
  search = useLocation().search;
  return null;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn(); // jsdom has no layout
  localStorage.clear();
  mocks.prs = { connected: false };
  mocks.trackEvent.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(actions: PaletteAction[]) {
  act(() => root.render(<MemoryRouter initialEntries={['/?project=p1']}><SearchPalette actions={actions} /><Probe /></MemoryRouter>));
}

const input = () => document.querySelector<HTMLInputElement>('.palette-input');

// A React-controlled input only sees a value set through the native setter.
function type(text: string) {
  const el = input()!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => { (input() ?? window).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init })); });
}

describe('SearchPalette actions', () => {
  it('⌘K b Enter runs the action, closes, and keeps no recent search', () => {
    const run = vi.fn();
    render([{ id: 'branch-off', label: 'Branch off…', detail: 'sample', run }]);

    press('k', { metaKey: true });
    expect(input()).not.toBeNull();
    expect(mocks.trackEvent).toHaveBeenCalledWith('palette-opened', { via: 'shortcut' });

    type('b');
    expect(document.querySelector('.palette-action')?.textContent).toContain('Branch off…');
    press('Enter');

    expect(run).toHaveBeenCalledTimes(1);
    expect(input()).toBeNull();
    expect(readRecentSearches(localStorage)).toEqual([]);
    expect(mocks.trackEvent).toHaveBeenCalledWith('palette-action', { action: 'branch-off', queryLength: 1 });
  });

  it('a one-letter query that is not the label start leaves Enter to the sessions', () => {
    const run = vi.fn();
    render([{ id: 'branch-off', label: 'Branch off…', keywords: ['new workstream'], run }]);
    act(() => { document.querySelector<HTMLButtonElement>('.search-trigger')!.click(); });
    expect(mocks.trackEvent).toHaveBeenCalledWith('palette-opened', { via: 'button' });

    type('w');
    expect(document.querySelector('.palette-action')).toBeNull();
    press('Enter');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('SearchPalette pull requests', () => {
  const tf = {
    kind: 'pr', lane: 'needs_my_review', repo: 'example-org/terraform', number: 28280, title: 'Envoy route', url: 'u', author: 'zane',
    headRefName: 'zane/envoy', baseRefName: 'main', at: null, badges: [], failingChecks: [], pendingChecks: [], waitingOn: [],
    blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, workstream: null, requestedAt: null, reviewTarget: null,
  };
  const open = async () => {
    render([]);
    // The PR list is read as the palette opens.
    await act(async () => { press('k', { metaKey: true }); await Promise.resolve(); });
  };

  it('lists matching PRs with their lane; Enter opens the PR overlay on that row', async () => {
    mocks.prs = { connected: true, viewer: 'me', lanes: [{ id: 'needs_my_review', label: 'Needs my review', rows: [tf] }] };
    await open();
    type('28280');
    const row = document.querySelector('.palette-pr');
    expect(row?.textContent).toContain('terraform#28280');
    expect(row?.textContent).toContain('My review');
    press('Enter');
    const q = new URLSearchParams(search);
    expect(q.get('prs')).toBe('needs_my_review');
    expect(q.get('pr')).toBe('example-org/terraform#28280');
    expect(q.get('project')).toBe('p1');
    expect(input()).toBeNull();
    expect(mocks.trackEvent).toHaveBeenCalledWith('palette-select', { kind: 'pr', queryLength: 5 });
  });

  it('without GitHub there is no Pull requests section', async () => {
    await open();
    type('28280');
    expect([...document.querySelectorAll('.palette-head')].map(h => h.textContent)).not.toContain('Pull requests');
  });
});

describe('SearchPalette opened from elsewhere', () => {
  it('gives the focus back to what had it when it closes', async () => {
    render([]);
    const before = document.createElement('button');
    document.body.appendChild(before);
    before.focus();
    await act(async () => { press('k', { metaKey: true }); await Promise.resolve(); });
    expect(document.activeElement).toBe(input());
    press('Escape');
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it('OPEN_PALETTE_EVENT opens it, empty, and records where from', async () => {
    render([]);
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT, { detail: { via: 'prs-overlay' } }));
      await Promise.resolve();
    });
    expect(input()?.value).toBe('');
    expect(mocks.trackEvent).toHaveBeenCalledWith('palette-opened', { via: 'prs-overlay' });
  });
});

describe('SearchPalette over the PR overlay', () => {
  const tf = {
    kind: 'pr', lane: 'needs_my_review', repo: 'example-org/terraform', number: 28280, title: 'Envoy route', url: 'u', author: 'zane',
    headRefName: 'zane/envoy', baseRefName: 'main', at: null, badges: [], failingChecks: [], pendingChecks: [], waitingOn: [],
    blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, workstream: null, requestedAt: null, reviewTarget: null,
  };
  const renderAt = async (url: string) => {
    act(() => root.render(<MemoryRouter initialEntries={[url]}><SearchPalette actions={[]} /><Probe /></MemoryRouter>));
    await act(async () => { press('k', { metaKey: true }); await Promise.resolve(); });
  };

  it('a PR from another repository drops a repo filter that would hide it', async () => {
    mocks.prs = { connected: true, viewer: 'me', lanes: [{ id: 'needs_my_review', label: 'Needs my review', rows: [tf] }] };
    await renderAt('/?project=p1&prs=checks&prs_repo=example-org%2Ftermag');
    type('terraform#28280');
    press('Enter');
    const q = new URLSearchParams(search);
    expect(q.get('pr')).toBe('example-org/terraform#28280');
    expect(q.has('prs_repo')).toBe(false);
    expect(q.get('project')).toBe('p1');
  });

  it('a PR in the filtered repository keeps the filter', async () => {
    mocks.prs = { connected: true, viewer: 'me', lanes: [{ id: 'needs_my_review', label: 'Needs my review', rows: [tf] }] };
    await renderAt('/?prs=checks&prs_repo=example-org%2Fterraform');
    type('28280');
    press('Enter');
    expect(new URLSearchParams(search).get('prs_repo')).toBe('example-org/terraform');
  });

  it('a pane hit closes the PR overlay, so the workstream it opens is not hidden under it', async () => {
    const { sessionsApi } = await import('../services/api');
    vi.mocked(sessionsApi.search).mockResolvedValue({ hits: [{ projectId: 'p2', projectName: 'webapp', owner: 'me', access: 'owner', workstream: 'main', role: 'agent', status: 'idle', matchCount: 1, matches: [{ line: 1, text: 'needle', before: [], after: [] }] }], searched: 1, unreachable: 0, skipped: 0 } as never);
    await renderAt('/?project=p1&prs=needs_you&pr=example-org%2Ftermag%231');
    type('needle');
    press('Enter'); // the "Search pane text" item
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => document.querySelector<HTMLButtonElement>('.palette-scroll button.recents-item:not(.palette-cta)')!.click());
    const q = new URLSearchParams(search);
    expect(q.has('prs')).toBe(false);
    expect(q.has('pr')).toBe(false);
    expect(q.get('project')).toBe('p1');
    expect(mocks.openTarget).toHaveBeenCalledWith({ kind: 'pane', projectId: 'p2', workstream: 'main', pane: 'agent' });
  });
});
