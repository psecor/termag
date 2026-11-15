// @vitest-environment jsdom
// The redesigned sidebar collapsed to its rail (SidebarRail.tsx, chat/sidebarRail.ts).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishRailProjects, resetSidebarRailForTests } from '../../chat/sidebarRail';
import { resetSidebarViewForTests, setSidebarView } from '../../chat/sidebarView';
import { ChatSidebar } from './ChatSidebar';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { unixUsername: 'ada' } }) }));
const projects = [
  { id: 'c1', name: 'termag', userProjectId: 'up-t', workstreams: [], workflows: [] },
  { id: 'c2', name: 'webapp', userProjectId: 'up-g', workstreams: [], workflows: [] },
  { id: 'c3', name: 'quiet', userProjectId: 'up-q', workstreams: [], workflows: [] },
];
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ projects, statusMap: {}, reloadProjects: async () => {} }) }));
const noBoxes: never[] = [];
vi.mock('../../services/boxFeed', () => ({ boxFeed: { subscribe: () => () => {}, getSnapshot: () => noBoxes, reload: async () => {} } }));
vi.mock('../../chat/useChatSpaces', () => ({
  useSharedChatSpaces: () => ({ loaded: true, current: true, spaces: [], index: new Map(), colorOf: () => '' }),
}));
vi.mock('../../flags', async importOriginal => {
  const actual = await importOriginal<typeof import('../../flags')>();
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (key === 'user-projects-enabled' ? true as T : fallback) };
});
// The list, as far as the rail's Needs you needs it: a folded Needs you head.
const stub = vi.hoisted(() => ({ unfolded: 0 }));
vi.mock('./ProjectsList', () => ({
  ProjectsList: () => (
    <ul className="projects-stub chat-projects">
      <li data-group="needs-you"><button type="button" className="chat-projects-fold" aria-expanded="false" onClick={() => { stub.unfolded += 1; }}>Needs you</button></li>
    </ul>
  ),
}));
const row = (projectId: string, workstream: string, status: string, waitingReason: string | null = null) => ({
  key: `${projectId}|${workstream}`, projectId, projectName: projectId, workstream, owner: 'ada', shared: false, provider: 'claude-chat',
  instanceId: null, kind: 'normal', pinned: false, status, waitingReason, updatedAt: null, message: null, contextTokens: null,
  rateLimited: null, review: null, ring: null, band: status === 'waiting' ? 'attention' : 'other',
});
const data = {
  items: { state: { items: [] }, open: () => {} },
  rows: [
    row('c1', 'main', 'waiting', 'approval'), row('c1', 'a', 'working'), row('c2', 'main', 'idle'), row('c3', 'main', 'not_running'),
    // An automation's run in webapp's checkout: the list files it under Automations, so it doesn't light webapp.
    { ...row('c2', 'run-1', 'working'), kind: 'automation' },
  ],
  live: new Map(), setupOf: new Map(), links: [], unseen: new Set(), setUnseen: () => {}, activeTab: null,
  spaces: { loaded: true, spaces: [], index: new Map(), current: true, colorOf: () => null },
  userProjects: {
    list: [
      { id: 'up-t', name: 'termag', archived: false, repos: [{ repoKey: 'example-org/termag' }] },
      { id: 'up-g', name: 'webapp', archived: false, repos: [{ repoKey: 'example-org/webapp' }] },
      { id: 'up-q', name: 'quiet', archived: false, repos: [{ repoKey: 'example-org/quiet' }] },
    ],
    failed: false, settled: true, reload: async () => {},
  },
  userProjectOf: () => null,
};
vi.mock('./simpleData', () => ({
  WithSimpleData: ({ children }: { children: React.ReactNode }) => children,
  useSimpleData: () => data, useSimpleDataIfAny: () => data,
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  resetSidebarRailForTests();
  resetSidebarViewForTests();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function show(chrome: Partial<ChatChrome> = {}) {
  const value: ChatChrome = { mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, refresh: true, ...chrome };
  act(() => root.render(<ChatChromeProvider value={value}><MemoryRouter><ChatSidebar /></MemoryRouter></ChatChromeProvider>));
}
const nav = () => host.querySelector('nav')!;
const press = (el: Element) => act(() => { (el as HTMLElement).click(); });

describe('ChatSidebar collapsed to its rail', () => {
  it("collapses from the brand row's button to the rail: Needs you with its count, each project with its live dot", () => {
    show();
    press(host.querySelector('[aria-label="Hide the sidebar"]')!);
    expect(nav().hasAttribute('data-collapsed')).toBe(true);
    expect(nav().style.width).toBe('52px');
    // The list stays mounted under the rail (hidden by its CSS), so it keeps its state.
    expect(host.querySelector('.projects-stub')).not.toBeNull();
    const labels = [...host.querySelectorAll('.sb-rail button')].map(b => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Show the sidebar', 'New session', 'Search', 'Needs you, 1', 'termag, 1 needs you, 1 working', 'webapp', 'quiet']);
    expect([...host.querySelectorAll('.sb-rail-project')].map(b => b.querySelector('.sb-rail-dot')?.getAttribute('data-dot') ?? null)).toEqual(['needs', null, null]);
    // Kept for this browser.
    expect(localStorage.getItem('termag.chat.sidebarRail')).toBe('1');
    press(host.querySelector('[aria-label="Show the sidebar"]')!);
    expect(nav().hasAttribute('data-collapsed')).toBe(false);
    expect(host.querySelector('.projects-stub')).not.toBeNull();
  });

  it('keeps keyboard focus on the toggle: the button that takes the pressed one\'s place', async () => {
    show();
    press(host.querySelector('[aria-label="Hide the sidebar"]')!);
    await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); await new Promise(r => requestAnimationFrame(() => r(null))); });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Show the sidebar');
    press(host.querySelector('[aria-label="Show the sidebar"]')!);
    await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); await new Promise(r => requestAnimationFrame(() => r(null))); });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Hide the sidebar');
  });

  it('toggles with Ctrl+\\ (⌘\\ on a Mac), from anywhere on the page', () => {
    show();
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', ctrlKey: true })); });
    expect(nav().hasAttribute('data-collapsed')).toBe(true);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', ctrlKey: true })); });
    expect(nav().hasAttribute('data-collapsed')).toBe(false);
  });

  it("opens on a project's head from its icon", () => {
    show();
    press(host.querySelector('[aria-label="Hide the sidebar"]')!);
    press(host.querySelector('[aria-label="webapp"]')!);
    expect(nav().hasAttribute('data-collapsed')).toBe(false);
  });

  it('lists only the projects the list draws: one with nothing running is left off while those are hidden', () => {
    setSidebarView({ showIdle: false });
    show();
    press(host.querySelector('[aria-label="Hide the sidebar"]')!);
    expect([...host.querySelectorAll('.sb-rail-project')].map(b => b.getAttribute('aria-label'))).toEqual(['termag, 1 needs you, 1 working', 'webapp']);
  });

  it("shows exactly the project heads the list draws, in the list's order, once it has published them", () => {
    show();
    press(host.querySelector('[aria-label="Hide the sidebar"]')!);
    act(() => publishRailProjects(['up-g', 'up-t']));
    expect([...host.querySelectorAll('.sb-rail-project')].map(b => b.getAttribute('aria-label'))).toEqual(['webapp', 'termag, 1 needs you, 1 working']);
  });

  it('opens on Needs you unfolded', async () => {
    stub.unfolded = 0;
    show();
    press(host.querySelector('[aria-label="Hide the sidebar"]')!);
    press(host.querySelector('.sb-rail-needs')!);
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
    expect(stub.unfolded).toBe(1);
  });

  it("keeps a held shortcut's repeats from reaching the page below (a terminal would take Ctrl+\\ as SIGQUIT)", () => {
    show();
    const below = vi.fn();
    document.body.addEventListener('keydown', below);
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', ctrlKey: true, repeat: true, bubbles: true })); });
    expect(below).not.toHaveBeenCalled();
    document.body.removeEventListener('keydown', below);
  });

  it('toggles once per press of the shortcut, however long it is held', () => {
    show();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', ctrlKey: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', ctrlKey: true, repeat: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', ctrlKey: true, repeat: true }));
    });
    expect(nav().hasAttribute('data-collapsed')).toBe(true);
  });

  it("isn't offered on a phone's drawer, even when it was left collapsed", () => {
    localStorage.setItem('termag.chat.sidebarRail', '1');
    show({ mode: 'drawer', historyOpen: true });
    expect(nav().hasAttribute('data-collapsed')).toBe(false);
    expect(host.querySelector('[aria-label="Hide the sidebar"]')).toBeNull();
  });
});
