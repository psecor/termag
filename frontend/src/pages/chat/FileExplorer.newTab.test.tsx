// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';

const mocks = vi.hoisted(() => ({
  pick: vi.fn((_ref: unknown, _current: string | null) => 'p7'), tree: vi.fn(), get: vi.fn(), reload: vi.fn(),
  spaces: [{ name: 'notes' }, { name: 'design' }] as Array<{ name: string }>,
}));
const row = (projectId: string, projectName: string, instanceId: string) => ({
  key: `${projectId}|main`, projectId, projectName, workstream: 'main', owner: 'ada', shared: false, provider: 'claude', instanceId,
  kind: 'normal', pinned: false, status: 'idle', waitingReason: null, updatedAt: null, message: null, contextTokens: null,
  rateLimited: null, review: null, ring: null, band: 'idle',
});
vi.mock('./simpleData', () => {
  const data = () => ({
    items: { pick: mocks.pick, state: { items: [{ id: 't1', kind: 'file', space: 'notes', path: 'docs/plan.md', openedAt: 5 }] } },
    rows: [row('a', 'review-notes', 'box-n'), row('b', 'landing', 'box-d')],
    live: new Map(), setupOf: new Map(), links: [], activeTab: 't9', itemsShown: true,
    spaces: { loaded: true, spaces: mocks.spaces, reload: mocks.reload, index: new Map([['box-n', ['notes']], ['box-d', ['design']]]) },
  });
  return { WithSimpleData: ({ children }: { children: React.ReactNode }) => children, useSimpleData: data, useSimpleDataIfAny: data };
});
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ projects: [{ id: 'a', lastActiveAt: '2026-10-23T10:00:00Z' }] }) }));
vi.mock('../../services/api', () => ({ spacesApi: { tree: mocks.tree, get: mocks.get } }));

import { FileExplorer } from './FileExplorer';

let root: Root;
let host: HTMLDivElement;
let location = '';
function Probe() {
  const l = useLocation();
  location = l.pathname + l.search;
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.tree.mockResolvedValue({ prefix: '', dirs: [], files: [], nextCursor: null });
  mocks.get.mockRejectedValue({ response: { status: 404, data: { error: 'Not found' } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  mocks.pick.mockClear();
  mocks.get.mockReset();
  mocks.reload.mockReset();
});

function render(chrome: Partial<ChatChrome>, path = '/chat/files/notes?tab=t9') {
  const value: ChatChrome = { mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, ...chrome };
  act(() => root.render(
    <ChatChromeProvider value={value}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/chat/files/:space" element={<FileExplorer />} /></Routes>
        <Probe />
      </MemoryRouter>
    </ChatChromeProvider>,
  ));
}

describe('a new tab', () => {
  it('lists the space\'s recent files and agents, with Tools, and no explorer column', () => {
    render({ sidePanel: { open: true, toggle: () => {} } });
    expect(host.querySelector('.fx-panel')).toBeNull();
    expect([...host.querySelectorAll('.nt-name')].map(n => n.textContent)).toEqual(['plan.md', 'review-notes']);
    // An agent's state is its icon's dot, and words for a screen reader only.
    expect([...host.querySelectorAll('.nt-where')].map(n => n.textContent)).toEqual(['docs', 'Agent']);
    expect(host.querySelectorAll('.nt-row')[1].querySelector('.chat-sr')!.textContent).toBe(', Ready');
    expect(host.querySelector('.chat-side-toggle')).not.toBeNull();
  });

  it('shows a pick in the tab the store picks: its own, or this one', () => {
    render({});
    act(() => (host.querySelectorAll<HTMLAnchorElement>('.nt-row')[1]).click());
    expect(mocks.pick).toHaveBeenCalledWith({ kind: 'chat', projectId: 'a', workstream: 'main' }, 't9', undefined, 'notes');
    expect(location).toBe('/chat/p/a?tab=p7');
  });

  it('puts Show tools under ⋮ on a phone', () => {
    const toggle = vi.fn();
    render({ mode: 'drawer', sidePanel: { open: false, toggle } });
    expect(host.querySelector('.chat-side-toggle')).toBeNull();
    act(() => (host.querySelector('.chat-more-btn') as HTMLButtonElement).click());
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent === 'Show tools') as HTMLButtonElement;
    act(() => item.click());
    expect(toggle).toHaveBeenCalled();
  });

  const settle = () => act(async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)); });

  it('says so when the server has no such space for the user, and lists nothing', async () => {
    render({ sidePanel: { open: true, toggle: () => {} } }, '/chat/files/secret?tab=t9');
    await settle();
    expect(mocks.get).toHaveBeenCalledWith('secret');
    const note = host.querySelector('.nt-no-access')!;
    expect(note.getAttribute('role')).toBe('status');
    expect(note.querySelector('.nt-head')!.textContent).toBe('You don\'t have access to secret');
    expect(note.textContent).toContain('Ask its owner to add you, then open the link again.');
    expect(host.querySelector('.nt-list')).toBeNull();
  });

  it('asks the server about a space missing from a stale list, and reloads the list when it answers', async () => {
    // Added to the space after the sidebar loaded its spaces.
    mocks.get.mockResolvedValue({ space: { name: 'fresh', role: 'editor' } });
    render({ sidePanel: { open: true, toggle: () => {} } }, '/chat/files/fresh?tab=t9');
    await settle();
    expect(mocks.get).toHaveBeenCalledWith('fresh');
    expect(host.querySelector('.nt-no-access')).toBeNull();
    expect(host.querySelector('.nt-head')!.textContent).toBe('Recent in fresh');
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a network error', new Error('Network Error')],
    ['a 5xx', { response: { status: 503, data: { error: 'Spaces storage is unavailable right now' } } }],
  ])('never says no access when asking the server ends in %s', async (_what, err) => {
    mocks.get.mockRejectedValue(err);
    render({ sidePanel: { open: true, toggle: () => {} } }, '/chat/files/secret?tab=t9');
    await settle();
    expect(mocks.get).toHaveBeenCalledWith('secret');
    expect(host.querySelector('.nt-no-access')).toBeNull();
    expect(host.querySelector('.nt-head')!.textContent).toBe('Recent in secret');
  });

  it('doesn\'t take a failed or empty list for "no spaces": a space the list lacks is asked about', async () => {
    mocks.spaces.splice(0);
    try {
      mocks.get.mockResolvedValue({ space: { name: 'notes', role: 'owner' } });
      render({ sidePanel: { open: true, toggle: () => {} } });
      await settle();
      expect(host.querySelector('.nt-no-access')).toBeNull();
      expect(host.querySelector('.nt-head')!.textContent).toBe('Recent in notes');
    } finally {
      mocks.spaces.push({ name: 'notes' }, { name: 'design' });
    }
  });

  it('doesn\'t ask the server about a space the list has', async () => {
    render({ sidePanel: { open: true, toggle: () => {} } });
    await settle();
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

