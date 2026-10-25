// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';

const mocks = vi.hoisted(() => ({ open: vi.fn(), tree: vi.fn() }));
const row = (projectId: string, projectName: string, instanceId: string) => ({
  key: `${projectId}|main`, projectId, projectName, workstream: 'main', owner: 'ada', shared: false, provider: 'claude', instanceId,
  kind: 'normal', pinned: false, status: 'idle', waitingReason: null, updatedAt: null, message: null, contextTokens: null,
  rateLimited: null, review: null, ring: null, band: 'idle',
});
vi.mock('./simpleData', () => {
  const data = () => ({
    items: { open: mocks.open, state: { items: [{ id: 't1', kind: 'file', space: 'notes', path: 'docs/plan.md', openedAt: 5 }] } },
    rows: [row('a', 'review-notes', 'box-n'), row('b', 'landing', 'box-d')],
    live: new Map(), setupOf: new Map(), links: [], activeTab: 't9', itemsShown: true,
    spaces: { enabled: true, loaded: true, spaces: [{ name: 'notes' }, { name: 'design' }], index: new Map([['box-n', ['notes']], ['box-d', ['design']]]) },
  });
  return { WithSimpleData: ({ children }: { children: React.ReactNode }) => children, useSimpleData: data, useSimpleDataIfAny: data };
});
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ projects: [{ id: 'a', lastActiveAt: '2026-10-23T10:00:00Z' }] }) }));
vi.mock('../../services/api', () => ({ spacesApi: { tree: mocks.tree } }));

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
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  mocks.open.mockReset();
});

function render(chrome: Partial<ChatChrome>) {
  const value: ChatChrome = { mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, ...chrome };
  act(() => root.render(
    <ChatChromeProvider value={value}>
      <MemoryRouter initialEntries={['/chat/files/notes?tab=t9']}>
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

  it('shows a pick in this tab', () => {
    render({});
    act(() => (host.querySelectorAll<HTMLAnchorElement>('.nt-row')[1]).click());
    expect(mocks.open).toHaveBeenCalledWith({ kind: 'chat', projectId: 'a', workstream: 'main', space: 'notes' }, 't9');
    expect(location).toBe('/chat/p/a?tab=t9');
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
});
