// @vitest-environment jsdom
// The sidebar's rows under the chrome refresh:
// a state mark from the live status, the age, the title alone, a count per space.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import { statusKey } from '../../utils/statusKey';
import { sessionName } from '../../utils/sessionName';
import { spaceColor } from '../../chat/spaceColors';
import { ChatSidebar } from './ChatSidebar';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';
import { SimpleDataProvider, useSimpleData } from './simpleData';
import { resetSidebarViewForTests, setSidebarView, SIDEBAR_VIEW_KEY } from '../../chat/sidebarView';
import { openItemsKey } from '../../chat/openItems';
import { SEEN_STOPS_KEY } from '../../utils/unseenStops';

const mocks = vi.hoisted(() => ({
  projects: [] as Project[],
  status: {} as Record<string, { status: string; waitingReason?: string; updatedAt?: string; stoppedAt?: string }>,
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', unixUsername: 'ada' } }) }));
vi.mock('../../contexts/ProjectContext', () => ({
  useProjects: () => ({ projects: mocks.projects, projectsLoaded: true, statusMap: mocks.status }),
  LAST_ACTIVE_PROJECT_KEY: 'k',
}));
vi.mock('../../chat/useChatSpaces', () => ({
  useSharedChatSpaces: () => ({
    loaded: true, current: true,
    spaces: [{ id: 'id-notes', name: 'notes', role: 'owner', readOnly: false }],
    index: new Map([['box-a', ['notes']], ['box-b', ['notes']], ['box-c', ['notes']]]),
    colorOf: spaceColor,
  }),
}));
vi.mock('../../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    chatsApi: { ...actual.chatsApi, archived: async () => [] },
    spawnsApi: { ...actual.spawnsApi, parents: async () => ({ links: [] }) },
  };
});
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: <T,>(_key: string, fallback: T) => fallback };
});

function project(id: string, lastActiveAt: string): Project {
  return {
    id, name: id, instanceId: `box-${id}`, archived: false, pinned: false, lastActiveAt,
    workflows: [{ type: 'agent' }], workstreams: [],
  } as unknown as Project;
}
const key = (id: string) => statusKey(`box-${id}`, sessionName('ada', id, 'agent', 'main'));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  resetSidebarViewForTests();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const now = Date.now();
  mocks.projects = [project('a', new Date(now - 60_000).toISOString()), project('b', new Date(now - 120_000).toISOString()), project('c', new Date(now - 180_000).toISOString())];
  mocks.status = {
    [key('a')]: { status: 'working', updatedAt: new Date(now - 5 * 60_000).toISOString() },
    [key('b')]: { status: 'waiting', waitingReason: 'approval', updatedAt: new Date(now - 2 * 3600_000).toISOString() },
  };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(refresh: boolean) {
  const chrome: ChatChrome = { mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, refresh };
  await act(async () => root.render(
    <ChatChromeProvider value={chrome}><MemoryRouter initialEntries={['/chat']}><SimpleDataProvider><ChatSidebar /></SimpleDataProvider></MemoryRouter></ChatChromeProvider>,
  ));
  await act(async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)); });
}

const item = (name: string) => [...host.querySelectorAll<HTMLAnchorElement>('a.chat-item')].find(a => a.querySelector('.chat-item-name')!.textContent === name)!;

describe('sidebar rows under the chrome refresh', () => {
  it('keeps the agent icon, and has no marks, ages or counts, with the refresh off', async () => {
    await render(false);
    expect(item('a').querySelector('.chat-agent-icon')).not.toBeNull();
    expect(host.querySelector('.chat-status-mark, .chat-item-age, .chat-group-count')).toBeNull();
  });

  it("marks each agent's state from its live status, with the words beside it for screen readers", async () => {
    await render(true);
    const mark = (name: string) => item(name).querySelector('.chat-status-mark')!;
    expect(item('a').dataset.state).toBe('working');
    expect(mark('a').querySelector('[role="progressbar"]')).not.toBeNull();
    expect(item('b').dataset.state).toBe('approval');
    expect(mark('b').querySelector('.chat-status-dot')).not.toBeNull();
    expect(item('c').dataset.state).toBe('off');
    expect(mark('c').childElementCount).toBe(0);
    expect(mark('a').getAttribute('aria-hidden')).toBe('true');
    expect(item('b').querySelector('.chat-sr')!.textContent).toBe(', Needs approval');
    expect(item('a').querySelector('.chat-agent-icon')).toBeNull();
  });

  it('shows how long each has been in its state, and how many tabs a space has', async () => {
    await render(true);
    expect(item('a').querySelector('.chat-item-age')!.textContent).toBe('5m');
    expect(item('b').querySelector('.chat-item-age')!.textContent).toBe('2h');
    expect(host.querySelector('.chat-group[data-group="notes"] .chat-group-count')!.textContent).toBe('3');
  });
});

describe('an agent that finished since you looked (docs/unseen-stops.md)', () => {
  beforeEach(() => {
    const now = Date.now();
    // This browser's baseline is an hour ago: c stopped after it, a before it.
    localStorage.setItem(SEEN_STOPS_KEY, JSON.stringify({ since: now - 3600_000, seen: {} }));
    mocks.status = {
      [key('a')]: { status: 'idle', stoppedAt: new Date(now - 2 * 3600_000).toISOString() },
      [key('c')]: { status: 'idle', stoppedAt: new Date(now - 60_000).toISOString() },
    };
  });

  it('has a blue dot, with the words for it, until you open it', async () => {
    await render(true);
    expect(item('c').dataset.state).toBe('unread');
    expect(item('c').querySelector('.chat-status-dot')).not.toBeNull();
    expect(item('c').querySelector('.chat-sr')!.textContent).toBe(', Ready · unseen');
    expect(item('c').dataset.tip).toContain('Ready · unseen');
    expect(item('a').dataset.state).toBe('done');

    await act(async () => { item('c').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    expect(item('c').dataset.state).toBe('done');
    expect(JSON.parse(localStorage.getItem(SEEN_STOPS_KEY)!).seen['c:main']).toBeGreaterThan(Date.now() - 60_000);

    // Seen stays seen once you have moved on.
    await act(async () => { item('a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    expect(item('c').dataset.state).toBe('done');
  });

  it('has none when the Lab already saw it, since both keep one store', async () => {
    const seen = JSON.parse(localStorage.getItem(SEEN_STOPS_KEY)!);
    localStorage.setItem(SEEN_STOPS_KEY, JSON.stringify({ ...seen, seen: { 'c:main': Date.now() } }));
    await render(true);
    expect(item('c').dataset.state).toBe('done');
  });

  it("never counts an automation's run, which finishes on its schedule", async () => {
    let unseen: ReadonlySet<string> = new Set();
    function Probe() { unseen = useSimpleData().unseen; return null; }
    await act(async () => root.render(<MemoryRouter initialEntries={['/chat']}><SimpleDataProvider><Probe /></SimpleDataProvider></MemoryRouter>));
    expect([...unseen]).toEqual(['c|main']);
    mocks.projects = mocks.projects.map(p => (p.id === 'c' ? { ...p, kind: 'automation' } as Project : p));
    await act(async () => root.render(<MemoryRouter initialEntries={['/chat']}><SimpleDataProvider><Probe /></SimpleDataProvider></MemoryRouter>));
    expect([...unseen]).toEqual([]);
  });
});

describe("the space groups under the chrome refresh, as the mock drew them", () => {
  it("draws a file's and a new tab's icon with LaunchPad's, and keeps the hand-drawn ones with the refresh off", async () => {
    localStorage.setItem(openItemsKey('u1'), JSON.stringify({ v: 2, seeded: false, items: [
      { kind: 'file', space: 'notes', path: 'docs/q3.pdf', id: 'f1', openedAt: 2 },
      { kind: 'explorer', space: 'notes', id: 'e1', openedAt: 1 },
    ] }));
    await render(true);
    const icon = (name: string) => item(name).querySelector('.chat-item-icon')!;
    expect(icon('q3.pdf').querySelector('use')!.getAttribute('href')).toBe('#lp-icon-file');
    expect(icon('New tab').querySelector('use')!.getAttribute('href')).toBe('#lp-icon-folders');
    expect(icon('q3.pdf').getAttribute('aria-hidden')).toBe('true');
    await render(false);
    expect(icon('q3.pdf').querySelector('use')).toBeNull();
    expect(icon('q3.pdf').querySelector('svg')).not.toBeNull();
  });

  it("keeps a space's head folding it, with its count and its ⋮, and their names, though the caret and the ⋮ only show on hover or focus", async () => {
    await render(true);
    const group = () => host.querySelector('.chat-group[data-group="notes"]')!;
    const toggle = group().querySelector<HTMLButtonElement>('.chat-group-head .chat-group-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe('chat-items-s-notes');
    expect(toggle.querySelector('.chat-group-caret')!.getAttribute('aria-hidden')).toBe('true');
    expect(toggle.querySelector('.chat-group-count')!.getAttribute('aria-hidden')).toBe('true');
    expect(group().querySelector('.chat-group-menu')!.getAttribute('aria-label')).toBe('Options for notes');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(group().hasAttribute('data-folded')).toBe(true);
    act(() => toggle.click());
    expect(group().hasAttribute('data-folded')).toBe(false);
  });
});

describe("a session's agents as a tree under the chrome refresh", () => {
  beforeEach(() => {
    // An ask that a sent, on c's box so it is in the same space.
    const ask = { id: 'k1', name: 'ask-t1', archived: false, askThread: { id: 't1', title: 'kid ask', parentProjectId: 'a', parentWorkstream: 'main' } };
    mocks.projects = [...mocks.projects, { ...project('k', new Date().toISOString()), instanceId: 'box-c', workstreams: [ask] } as unknown as Project];
  });
  const parent = () => item('a').closest('li')!;
  const fold = () => act(() => parent().querySelector<HTMLButtonElement>('.chat-twisty')!.click());

  it('counts what a folded parent hides right after its name, in both densities', async () => {
    await render(true);
    expect(item('kid ask').closest('li')!.style.getPropertyValue('--chat-depth')).toBe('1');
    expect(host.querySelector('.chat-item-folded')).toBeNull();
    fold();
    expect(item('kid ask')).toBeUndefined();
    const count = item('a').querySelector('.chat-item-folded')!;
    expect(count.textContent).toBe('+1');
    // The caret's label says it for screen readers.
    expect(count.getAttribute('aria-hidden')).toBe('true');
    expect(parent().querySelector('.chat-twisty')!.getAttribute('aria-label')).toBe('Show the 1 agent a started');
    expect([...item('a').children].map(c => c.className)).toEqual(['chat-status-mark', 'chat-item-name', 'chat-item-folded', 'chat-item-age', 'chat-sr']);
    act(() => setSidebarView({ density: 'standard' }));
    expect(item('a').querySelector('.chat-item-top .chat-item-folded')!.textContent).toBe('+1');
    fold();
    expect(item('kid ask')).toBeDefined();
    expect(host.querySelector('.chat-item-folded')).toBeNull();
  });

  it('shows no count with the refresh off, where the caret stays in view', async () => {
    await render(true);
    fold();
    await render(false);
    expect(parent().querySelector('.chat-twisty')!.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.chat-item-folded')).toBeNull();
  });
});

describe('the view options under the chrome refresh', () => {
  const groupNames = () => [...host.querySelectorAll('.chat-group')].map(g => [
    g.querySelector('.chat-group-name')!.textContent,
    [...g.querySelectorAll('.chat-item-name')].map(n => n.textContent),
  ]);

  it('offers the view options beside Search only with the refresh on', async () => {
    await render(false);
    expect(host.querySelector('.chat-view-button')).toBeNull();
    await render(true);
    expect(host.querySelector('.chat-search-row .chat-view-button')?.getAttribute('aria-label')).toBe('View options');
  });

  it("ignores a kept view with the refresh off", async () => {
    localStorage.setItem(SIDEBAR_VIEW_KEY, JSON.stringify({ density: 'standard', groupBy: 'status', showIdle: false }));
    await render(false);
    expect(groupNames()).toEqual([['notes', ['b', 'a', 'c']]]);
    expect(host.querySelector('[data-density="standard"]')).toBeNull();
  });

  it('groups by state, with no space menu, no drag and no swatch on a state group', async () => {
    await render(true);
    act(() => setSidebarView({ groupBy: 'status' }));
    expect(groupNames()).toEqual([['Needs you', ['b']], ['Working', ['a']], ['Not running', ['c']]]);
    const needsYou = host.querySelector('.chat-group[data-state-group="needs-you"]')!;
    expect(needsYou.querySelector('.chat-group-menu, .space-swatch')).toBeNull();
    expect(needsYou.querySelector('li.chat-item-li')!.getAttribute('draggable')).toBe('false');
    expect(localStorage.getItem(SIDEBAR_VIEW_KEY)).toContain('"groupBy":"status"');
  });

  it("hides agents that aren't running, and keeps a space that the filter emptied from saying Nothing open", async () => {
    mocks.status = {};
    await render(true);
    act(() => setSidebarView({ showIdle: false }));
    expect(groupNames()).toEqual([['notes', []]]);
    expect(host.querySelector('.chat-group-empty')).toBeNull();
  });

  it('draws Standard rows: the title and age, then the state, then the last words', async () => {
    await render(true);
    act(() => setSidebarView({ density: 'standard' }));
    const b = item('b');
    expect(b.dataset.density).toBe('standard');
    expect(b.querySelector('.chat-item-top .chat-item-age')!.textContent).toBe('2h');
    expect(b.querySelector('.chat-item-sub')!.getAttribute('data-status')).toBe('approval');
    expect(b.querySelector('.chat-item-state')!.textContent).toBe('Needs approval');
    expect(b.querySelector('.chat-item-state')!.getAttribute('aria-hidden')).toBe('true');
  });

  it("closes every tab in the space from its menu, the view's filters notwithstanding", async () => {
    mocks.status = { ...mocks.status };
    await render(true);
    act(() => setSidebarView({ showIdle: false }));
    expect(groupNames()).toEqual([['notes', ['b', 'a']]]);
    const dots = host.querySelector<HTMLElement>('.chat-group[data-group="notes"] .chat-group-menu')!;
    act(() => dots.click());
    const close = [...document.querySelectorAll<HTMLButtonElement>('.chat-ctx-menu [role=menuitem]')].find(b => b.textContent?.startsWith('Close all tabs'))!;
    expect(close).toBeTruthy();
    act(() => close.click());
    await act(async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)); });
    act(() => setSidebarView({ showIdle: true }));
    expect(groupNames()).toEqual([['notes', []]]);
  });
});
