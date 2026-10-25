// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxRow } from '../../mobile/inbox';
import { ChatSearch } from './ChatSearch';

vi.mock('../../observability', () => ({ trackEvent: () => {} }));
vi.mock('../../hooks/useRecents', () => ({ useRecents: () => ({ rows: [], loading: false, refresh: () => {} }) }));
vi.mock('../../services/api', () => ({
  sessionsApi: { search: vi.fn() },
  prsApi: {
    list: () => Promise.resolve({
      connected: true, viewer: 'psecor', prod: { sha: null, source: 'unknown' }, boxes: 0,
      lanes: [{ id: 'mine', label: 'Mine', rows: [{
        kind: 'pr', lane: 'mine', repo: 'example-org/termag', number: 612, title: 'Box pills', url: 'https://github.com/example-org/termag/pull/612',
        author: 'psecor', headRefName: 'box-pills', baseRefName: 'main', at: null, badges: [], failingChecks: [], pendingChecks: [],
        waitingOn: [], blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, workstream: null, requestedAt: null, reviewTarget: null,
      }] }],
    }),
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function row(projectId: string, workstream: string, instanceId: string): InboxRow {
  return {
    key: `${projectId}|${workstream}`, projectId, projectName: 'sysadmin', workstream, owner: 'psecor', shared: false,
    provider: 'claude', instanceId, kind: 'normal', pinned: false, status: 'idle', waitingReason: null,
    updatedAt: new Date().toISOString(), message: null, contextTokens: null, rateLimited: null, review: null, ring: null, band: 'other',
  };
}
const rows = [row('p1', 'main', 'box-a'), row('p2', 'ops', 'box-b')];
const names: Record<string, string> = { 'box-a': 'psecor-dev02', 'box-b': 'psecor-dev03' };
const boxNameOf = (r: InboxRow) => (r.instanceId ? names[r.instanceId] ?? null : null);

let path = '';
function Probe() {
  const l = useLocation();
  path = `${l.pathname}${l.search}`;
  return null;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn(); // jsdom has no layout
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(
    <MemoryRouter initialEntries={['/chat']}><ChatSearch rows={rows} now={Date.now()} boxNameOf={boxNameOf} /><Probe /></MemoryRouter>,
  ));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const input = () => document.querySelector<HTMLInputElement>('.palette-input');
function type(text: string) {
  const el = input()!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => { (input() ?? window).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init })); });
const open = async () => { await act(async () => { press('k', { metaKey: true }); await Promise.resolve(); }); };

describe('ChatSearch', () => {
  it('finds a session by its box name, shows the pill, and opens it in the simple UI', async () => {
    await open();
    type('dev03');
    const results = [...document.querySelectorAll('.palette-scroll .recents-item')].filter(b => b.querySelector('.recents-name'));
    expect(results).toHaveLength(1);
    expect(results[0].querySelector('.recents-box')?.textContent).toBe('psecor-dev03');
    press('Enter');
    expect(path).toBe('/chat/p/p2?ws=ops');
    expect(input()).toBeNull();
  });

  it('tells two sessions with one name apart by their pills', async () => {
    await open();
    type('sysadmin');
    const pills = [...document.querySelectorAll('.palette-scroll .recents-box')].map(p => p.textContent);
    expect(pills).toEqual(['psecor-dev02', 'psecor-dev03']);
  });

  it('opens a pull request on GitHub, not the PR overlay', async () => {
    const openWin = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      await open();
      await act(async () => { await Promise.resolve(); });
      type('pills');
      press('Enter');
      expect(openWin).toHaveBeenCalledWith('https://github.com/example-org/termag/pull/612', '_blank', 'noopener');
      expect(path).toBe('/chat');
    } finally {
      openWin.mockRestore();
    }
  });
});
