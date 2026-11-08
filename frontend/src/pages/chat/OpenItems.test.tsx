// @vitest-environment jsdom
import React, { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useMatch } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceTree } from '../../services/api';
import type { Project } from '../../types';
import { newTabId, openItemsKey } from '../../chat/openItems';
import { statusKey } from '../../utils/statusKey';
import { sessionName } from '../../utils/sessionName';
import { spaceColor } from '../../chat/spaceColors';
import { ChatSidebar } from './ChatSidebar';
import { FileExplorer } from './FileExplorer';
import { AgentsTab } from './AgentsExplorer';
import { SpaceFileView } from './SpaceFileView';
import { ChatRoute } from './ChatRoute';
import { SidePanel } from './SidePanel';
import { SimpleDataProvider, useSimpleData } from './simpleData';
import { resetUnfoldedRuns } from '../../chat/automationRunGroups';
import { rowKey as inboxRowKey } from '../../mobile/inbox';

function project(id: string, lastActiveAt: string): Project {
  return {
    id, name: id, instanceId: `box-${id}`, archived: false, pinned: false, lastActiveAt,
    workflows: [{ type: 'agent' }], workstreams: [],
  } as unknown as Project;
}

/** A chat the server fixed to `spaceId` (backend services/chatSpace.ts), or to none. */
function fixedTo(p: Project, spaceId: string | null): Project {
  return { ...p, workstreams: [{ id: `ws-${p.id}`, name: 'main', archived: false, spaceId, spaceFixedAt: '2026-10-27T00:00:00Z' }] } as unknown as Project;
}

const TREE: Record<string, SpaceTree> = {
  '': { prefix: '', nextCursor: null, dirs: [{ name: 'docs', path: 'docs/' }], files: [{ name: 'README.md', path: 'README.md', size: 1, modifiedAt: null }] },
  'docs/': { prefix: 'docs/', nextCursor: null, dirs: [], files: [{ name: 'q3.pdf', path: 'docs/q3.pdf', size: 1, modifiedAt: null }] },
};

const mocks = vi.hoisted(() => ({
  projects: [] as Project[],
  spaces: true,
  spacesLoaded: true,
  /** The index is loaded for the current boxes (useChatSpaces' current); null: as loaded. */
  current: null as boolean | null,
  list: [] as Array<{ id: string; name: string; role: string; readOnly: boolean; memberCount?: number }>,
  index: new Map<string, string[]>(),
  links: [] as Array<{ projectId: string; workstream: string; parentProjectId: string; parentWorkstream: string }>,
  open: vi.fn(),
  tree: null as null | ((space: string, prefix: string) => Promise<SpaceTree>),
  /** chat-session-references-enabled. */
  refs: false,
  members: vi.fn(),
  status: {} as Record<string, { status: string }>,
  /** Review sessions (reviewsData's sessionKeys), by mobile/inbox rowKey. */
  reviewKeys: new Set<string>(),
}));

// A new tab's id is random (newTabId); a test that asserts one names it first with
// nextTabId, so it can say exactly which tab opened instead of "any but e1".
vi.mock('../../chat/openItems', async importOriginal => {
  const actual = await importOriginal<typeof import('../../chat/openItems')>();
  return { ...actual, newTabId: vi.fn(actual.newTabId) };
});
/** The next new tab's id: one that starts like the tab it is opened from, which a pattern on the id can't tell apart. */
const nextTabId = (id = 'e1next') => { vi.mocked(newTabId).mockReturnValueOnce(id); return id; };
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', unixUsername: 'ada' } }) }));
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ projects: mocks.projects, projectsLoaded: true, statusMap: mocks.status }) }));
vi.mock('../../chat/useChatSpaces', () => ({
  useSharedChatSpaces: () => ({ enabled: mocks.spaces, loaded: mocks.spacesLoaded, current: mocks.current ?? mocks.spacesLoaded, spaces: mocks.spaces && mocks.spacesLoaded ? mocks.list : [], index: mocks.index, colorOf: spaceColor }),
}));
vi.mock('../../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    chatsApi: { ...actual.chatsApi, archived: async () => [] },
    spacesApi: {
      ...actual.spacesApi,
      tree: async (s: string, prefix: string) => mocks.tree ? mocks.tree(s, prefix) : TREE[prefix] ?? { prefix, nextCursor: null, dirs: [], files: [] },
      view: async () => ({ url: 'https://bucket.test/x', expiresAt: '', size: 1, contentType: null, view: null }),
      members: mocks.members,
      boxes: async () => ({ boxes: [] }),
    },
    spawnsApi: { ...actual.spawnsApi, parents: async () => ({ links: mocks.links }) },
    automationsApi: { ...actual.automationsApi, list: async () => [] },
  };
});
vi.mock('./reviewsData', async importOriginal => {
  const actual = await importOriginal<typeof import('./reviewsData')>();
  return { ...actual, useReviewsData: () => ({ ...actual.useReviewsData(), sessionKeys: mocks.reviewKeys }) };
});
vi.mock('./SdkChatView', () => ({ SdkChatView: () => <section className="chat-conv" data-testid="chat" /> }));
vi.mock('./ChatView', () => ({ ChatView: () => <section className="chat-conv" data-testid="chat" /> }));
vi.mock('../../services/spaceTransfer', () => ({ downloadFile: vi.fn(), errorMessage: (_e: unknown, f: string) => f }));
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return {
    ...actual,
    useFlag: <T,>(key: string, fallback: T) => (key === 'chat-session-references-enabled' ? mocks.refs as T : fallback),
  };
});

let root: Root;
let host: HTMLDivElement;
let location = '';

function Probe() {
  const l = useLocation();
  location = l.pathname + l.search;
  return null;
}

/** Every commit that changes the tabs or the route: each group's tabs, and the one highlighted. */
let commits: Array<{ order: string[]; active: string | null }> = [];
function CommitProbe() {
  useSimpleData();
  useLocation();
  useLayoutEffect(() => {
    const rows = [...document.querySelectorAll<HTMLAnchorElement>('.chat-group[data-group="notes"] a.chat-item')];
    commits.push({
      order: rows.map(a => a.querySelector('.chat-item-name')!.textContent!),
      active: rows.find(a => a.getAttribute('aria-current') === 'page')?.querySelector('.chat-item-name')!.textContent ?? null,
    });
  });
  return null;
}

/** The side panel open on Files, given what ChatApp gives it for the route. */
function FilesPanel() {
  const file = useMatch('/chat/f/:space/*');
  const newTab = useMatch('/chat/files/:space');
  const agents = useMatch('/chat/agents');
  const chat = useMatch('/chat/p/:projectId');
  const project = chat ? mocks.projects.find(p => p.id === chat.params.projectId) : undefined;
  const files = project ? { agent: project } : agents ? { space: '(none)' } : (file ?? newTab) ? { space: (file ?? newTab)!.params.space!, path: file?.params['*'] } : null;
  if (!files) return null;
  return <SidePanel project={project} workstream="main" files={files} state={{ open: true, tab: 'files', width: 480 }} onChange={() => {}} onClose={() => {}} overlay={false} />;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  commits = [];
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal('open', mocks.open);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.querySelectorAll('.chat-ctx-popover').forEach(m => m.remove());
  vi.unstubAllGlobals();
});

const space = (name: string, role = 'owner') => ({ id: `id-${name}`, name, role, readOnly: false });
const groups = () => [...host.querySelectorAll('.chat-group')].map(g => [
  g.querySelector('.chat-group-name')!.textContent,
  [...g.querySelectorAll('.chat-item-name')].map(n => n.textContent),
]);
const groupNames = () => [...host.querySelectorAll('.chat-group .chat-item-name')].map(n => n.textContent);
const settle = () => act(async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)); });
/** React Aria moves focus a frame late: into a menu a virtual click opened, and back out of one that closed. */
const nextFrame = () => act(async () => { await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))); });
async function render(path = '/chat') {
  await act(async () => root.render(
    <MemoryRouter initialEntries={[path]}>
      <SimpleDataProvider>
        <ChatSidebar />
        <Routes>
          <Route path="/chat/files/:space" element={<FileExplorer />} />
          <Route path="/chat/agents" element={<AgentsTab />} />
          <Route path="/chat/f/:space/*" element={<SpaceFileView />} />
          <Route path="/chat/p/:projectId" element={<ChatRoute />} />
          <Route path="*" element={null} />
        </Routes>
        <FilesPanel />
        <Probe />
        <CommitProbe />
      </SimpleDataProvider>
    </MemoryRouter>,
  ));
  await settle();
}
/** A group's ⋮: its one menu (New agent, New tab, then its tab actions). */
const groupDots = (name: string) => [...host.querySelectorAll<HTMLElement>('.chat-group-head')]
  .find(h => h.querySelector('.chat-group-name')?.textContent === name)!.querySelector<HTMLButtonElement>('.chat-group-menu')!;
const openMenu = (name: string) => act(() => groupDots(name).click());
const SPACE_MENU = ['New agent', 'New tab', 'Share space', 'Close all tabs', 'Close file tabs'];
// No space has no Share space (chat/spaceShare.ts spaceShareActions).
const NO_SPACE_MENU = SPACE_MENU.filter(l => l !== 'Share space');
const menuLabels = () => [...document.querySelectorAll('.chat-ctx-menu .chat-add-label')].map(n => n.textContent);
const menuItem = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.chat-ctx-menu [role=menuitem]')].find(b => b.textContent?.startsWith(label))!;
const tab = (name: string) => [...host.querySelectorAll<HTMLAnchorElement>('a.chat-item')].find(a => a.querySelector('.chat-item-name')!.textContent === name)!;
const panelRow = (name: string) => [...host.querySelectorAll<HTMLElement>('.fx-panel .fx-row')].find(r => r.querySelector('.fx-name')?.textContent === name)!;
const key = (el: Element, k: string, extra: KeyboardEventInit = {}) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra })); });
const touch = (el: Element, type: string, x = 40, y = 60) => {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 1 });
  Object.defineProperty(e, 'pointerType', { value: 'touch' });
  el.dispatchEvent(e);
};
/** A tap: a touch pointerdown, then the click, which (as in Safari) is a plain MouseEvent with no pointerType. */
const tap = (el: Element) => act(() => {
  touch(el, 'pointerdown');
  touch(el, 'pointerup');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
});
/** A finger held on `el` for a second, then lifted (and the click a lift makes). */
async function holdFinger(el: Element) {
  act(() => touch(el, 'pointerdown'));
  await act(async () => { await new Promise(r => setTimeout(r, 1000)); });
  act(() => { touch(el, 'pointerup'); touch(el, 'click'); });
}
/** A tab's X, beside its ⋮. */
const close = (name: string) => host.querySelector<HTMLButtonElement>(`button.chat-item-close[aria-label="Close ${name}"]`)!;
/** A key pressed and let go on `el`, as React Aria's press reads one. */
const press = (el: Element, k: string) => act(() => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true }));
});
const dots = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="Options for ${name}"]`)!;
const rightClick = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })); });
const stored = () => JSON.parse(localStorage.getItem(openItemsKey('u1'))!) as { items: Array<{ id: string; kind: string; path?: string }> };

describe('tabs sidebar', () => {
  beforeEach(() => {
    mocks.spaces = true;
    mocks.list = [space('notes'), space('assets', 'viewer')];
    mocks.index = new Map([['box-a', ['notes']]]);
    mocks.links = [];
    mocks.open.mockClear();
  });

  it('shows Loading and no groups until the spaces load, so no tab starts under No space', async () => {
    mocks.list = [space('notes')];
    mocks.projects = [project('a', '2026-10-20T00:00:00Z')];
    mocks.index = new Map([['box-a', ['notes']]]);
    mocks.spacesLoaded = false;
    try {
      await render();
      expect(host.querySelector('.chat-items')!.textContent).toBe('Loading…');
      expect(groups()).toEqual([]);
    } finally {
      mocks.spacesLoaded = true;
    }
  });

  it('groups agents by their box\'s space, most recently active first on first load, under New session', async () => {
    mocks.projects = [project('a', '2026-10-01T00:00:00Z'), project('b', '2026-10-20T00:00:00Z'), project('loose', '2026-10-10T00:00:00Z')];
    mocks.index = new Map([['box-a', ['notes']], ['box-b', ['notes']]]);
    await render();
    expect(groups()).toEqual([['assets', []], ['notes', ['b', 'a']], ['No space', ['loose']]]);
    const start = host.querySelector<HTMLAnchorElement>('.chat-sidebar-head .chat-new')!;
    expect(start.getAttribute('aria-label')).toBe('New session');
    // The shortcut is in the title too, as well as muted beside the button.
    expect(start.getAttribute('title')).toMatch(/^New session \((Ctrl\+Shift\+O|⌘⇧O)\)$/);
    expect(start.getAttribute('href')).toBe('/chat/new');
    expect(host.querySelector('button[aria-label="New in No space"]')).toBeNull();
    expect(stored().items.every(i => /^[a-z0-9]+$/.test(i.id))).toBe(true);
  });

  it('gives each space\'s head one ⋮, in place of its +: New agent, New tab, Share space, Close all tabs, Close file tabs; every New tab is another tab on top', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z')];
    await render();
    expect(host.querySelector('.chat-group-add, button[aria-label="New in notes"]')).toBeNull();
    const dots = groupDots('notes');
    expect(dots.getAttribute('aria-label')).toBe('Options for notes');
    expect(dots.getAttribute('aria-haspopup')).toBe('menu');
    expect(dots.getAttribute('aria-expanded')).toBe('false');
    openMenu('notes');
    expect(dots.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.chat-ctx-menu')!.getAttribute('aria-label')).toBe('notes');
    expect(menuLabels()).toEqual(SPACE_MENU);
    expect(menuItem('New agent').getAttribute('aria-disabled') === 'true').toBe(false);
    act(() => menuItem('New tab').click());
    await settle();
    expect(location).toMatch(/^\/chat\/files\/notes\?tab=[a-z0-9]+$/);
    expect(groups()).toContainEqual(['notes', ['New tab', 'a']]);
    expect(tab('New tab').getAttribute('aria-current')).toBe('page');
    openMenu('notes');
    act(() => menuItem('New tab').click());
    await settle();
    expect(groups()).toContainEqual(['notes', ['New tab', 'New tab', 'a']]);
  });

  it('closes a tab from its ⋮, which opens the right-click menu; one line per tab: an agent icon and its name', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z')];
    await render();
    const item = tab('a');
    expect(item.querySelector('.chat-agent-icon')).not.toBeNull();
    expect(item.querySelector('.chat-row-age, .chat-item-detail')).toBeNull();
    expect(item.hasAttribute('title')).toBe(false);
    rightClick(item);
    const viaRightClick = menuLabels();
    await nextFrame();
    key(document.activeElement!, 'Escape');
    expect(dots('a').getAttribute('aria-haspopup')).toBe('menu');
    expect(dots('a').getAttribute('aria-expanded')).toBe('false');
    act(() => dots('a').click());
    expect(dots('a').getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.chat-ctx-menu')!.getAttribute('aria-label')).toBe('a');
    expect(menuLabels()).toEqual(viaRightClick);
    expect(menuLabels()).toEqual(['Duplicate tab', 'Open in new browser tab', 'Open in termag desktop', 'Close tab', 'Close other tabs', 'Close tabs below']);
    expect(menuItem('Close other tabs').getAttribute('aria-disabled') === 'true').toBe(true);
    expect(menuItem('Close tabs below').getAttribute('aria-disabled') === 'true').toBe(true);
    expect(location).toBe('/chat');
    act(() => menuItem('Close tab').click());
    expect(groups()).toEqual([['assets', []], ['notes', []]]);
  });

  it('gives every tab an X right after its ⋮, named for the tab; space heads keep only their ⋮', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z')];
    await render('/chat/f/notes/README.md');
    expect(groups()).toContainEqual(['notes', ['README.md', 'a']]);
    for (const name of ['README.md', 'a']) {
      const li = tab(name).closest('li')!;
      const buttons = [...li.querySelectorAll(':scope > button')];
      expect(buttons.map(b => b.getAttribute('aria-label'))).toEqual([`Options for ${name}`, `Close ${name}`]);
      expect(buttons[1].classList.contains('chat-item-close')).toBe(true);
      expect(buttons[1].getAttribute('data-tip')).toBe('Close tab');
      expect(buttons[1].hasAttribute('aria-haspopup')).toBe(false);
    }
    expect(host.querySelector('.chat-group-head .chat-item-close, .chat-group-head button[aria-label^="Close"]')).toBeNull();
  });

  it('closes a tab from its X as Close tab does: with no tab shown before, the open one goes to the next tab in its space; the session and file stay', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z'), project('b', '2026-10-10T00:00:00Z')];
    mocks.index = new Map([['box-a', ['notes']], ['box-b', ['notes']]]);
    await render('/chat/f/notes/README.md');
    expect(groups()).toContainEqual(['notes', ['README.md', 'a', 'b']]);
    // A tab that isn't open: it goes, and the route stays.
    act(() => close('b').click());
    await settle();
    expect(groups()).toContainEqual(['notes', ['README.md', 'a']]);
    expect(location).toBe('/chat/f/notes/README.md');
    // The open file's tab: it goes, and the sidebar goes to a, the first left in its space.
    act(() => close('README.md').click());
    await settle();
    expect(groups()).toContainEqual(['notes', ['a']]);
    expect(location).toMatch(/^\/chat\/p\/a\?tab=/);
    expect(document.querySelector('.chat-ctx-menu')).toBeNull();
    expect(stored().items.map(i => i.kind)).toEqual(['chat']);
    expect(mocks.projects.map(p => p.id)).toEqual(['a', 'b']);
  });

  it('closes a tab from its X by keyboard, Enter or Space, and gives focus to the tab that takes its place', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z'), project('b', '2026-10-15T00:00:00Z'), project('c', '2026-10-10T00:00:00Z')];
    mocks.index = new Map([['box-a', ['notes']], ['box-b', ['notes']], ['box-c', ['notes']]]);
    await render();
    expect(groups()).toContainEqual(['notes', ['a', 'b', 'c']]);
    act(() => close('a').focus());
    press(close('a'), 'Enter');
    await settle();
    expect(groups()).toContainEqual(['notes', ['b', 'c']]);
    expect(document.activeElement).toBe(tab('b'));
    // The last one gives focus to the one above it.
    act(() => close('c').focus());
    press(close('c'), ' ');
    await settle();
    expect(groups()).toContainEqual(['notes', ['b']]);
    expect(document.activeElement).toBe(tab('b'));
  });

  it('leads a tab with Claude\'s title for its session, the project after it', async () => {
    const titled = (title: string | null) => [{
      ...project('a', '2026-10-20T00:00:00Z'),
      workstreams: [{ id: 'w1', projectId: 'a', name: 'main', branch: 'main', archived: false, sessionTitle: title }],
    } as unknown as Project];
    mocks.projects = titled('Login rate limiting');
    await render();
    expect(groups()).toEqual([['assets', []], ['notes', ['Login rate limiting · a']]]);
    expect(host.querySelector('.chat-item-name .chat-row-ws')!.textContent).toBe(' · a');
    expect(dots('Login rate limiting · a')).not.toBeNull();

    // No title yet: the project.
    mocks.projects = titled(null);
    await render();
    expect(groups()).toEqual([['assets', []], ['notes', ['a']]]);
  });

  it('opens the menu from ⋮ by keyboard, and Escape gives focus back to ⋮', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z')];
    await render();
    act(() => dots('a').focus());
    key(dots('a'), 'Enter');
    expect(document.activeElement).toBe(menuItem('Duplicate tab'));
    key(document.activeElement!, 'Escape');
    expect(document.querySelector('.chat-ctx-menu')).toBeNull();
    await nextFrame();
    expect(document.activeElement).toBe(dots('a'));
  });

  it('moves a tab within its space with Alt+Up/Down, keeps it there, and says when it can go no further', async () => {
    mocks.projects = [project('a', '2026-10-01T00:00:00Z'), project('b', '2026-10-20T00:00:00Z'), project('c', '2026-10-10T00:00:00Z')];
    mocks.index = new Map([['box-a', ['notes']], ['box-b', ['notes']], ['box-c', ['notes']]]);
    await render();
    expect(groups()).toContainEqual(['notes', ['b', 'c', 'a']]);
    act(() => tab('a').focus());
    key(tab('a'), 'ArrowUp', { altKey: true });
    expect(groups()).toContainEqual(['notes', ['b', 'a', 'c']]);
    expect(document.activeElement).toBe(tab('a'));
    expect(host.querySelector('[aria-live]')!.textContent).toBe('a moved to position 2 of 3 in notes');
    key(tab('a'), 'ArrowUp', { altKey: true });
    key(tab('a'), 'ArrowUp', { altKey: true });
    expect(groups()).toContainEqual(['notes', ['a', 'b', 'c']]);
    expect(host.querySelector('[aria-live]')!.textContent).toBe('a is already first in notes. Tabs stay in their space.');
    await render();
    expect(groups()).toContainEqual(['notes', ['a', 'b', 'c']]);
  });

  it('puts a chat\'s tab under its own space, not its box\'s first, and refuses a drag of it to the space its box reaches (plan-outbox #38)', async () => {
    mocks.projects = [fixedTo(project('a', '2026-10-01T00:00:00Z'), 'id-assets'), project('b', '2026-10-20T00:00:00Z'), fixedTo(project('c', '2026-10-10T00:00:00Z'), null)];
    // c's box reaches two spaces: with one, its seeded tab would be placed in it (openItems.placeUnplacedItems).
    mocks.index = new Map([['box-a', ['notes', 'assets']], ['box-b', ['notes']], ['box-c', ['notes', 'assets']]]);
    await render();
    expect(groups()).toEqual([['assets', ['a']], ['notes', ['b']], ['No space', ['c']]]);
    const dt = { setData() {}, effectAllowed: '', dropEffect: '' };
    const drag = (type: string, el: Element) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: dt });
      act(() => { el.dispatchEvent(e); });
    };
    const group = (name: string) => [...host.querySelectorAll('.chat-group')].find(g => g.querySelector('.chat-group-name')!.textContent === name)!;
    drag('dragstart', tab('a').closest('li')!);
    drag('dragover', group('notes').querySelector('.chat-group-head')!);
    expect(dt.dropEffect).toBe('none');
    expect(host.querySelector('[aria-live]')!.textContent).toBe("Can't move a to notes. Tabs stay in their space.");
    drag('drop', group('notes').querySelector('.chat-group-head')!);
    expect(groups()).toEqual([['assets', ['a']], ['notes', ['b']], ['No space', ['c']]]);
  });

  it("puts a reference to a session's tab on its drag with chat-session-references-enabled, and the tab still moves", async () => {
    mocks.projects = [project('a', '2026-10-01T00:00:00Z'), project('b', '2026-10-20T00:00:00Z')];
    mocks.index = new Map([['box-a', ['notes']], ['box-b', ['notes']]]);
    const dragStart = () => {
      const data: Record<string, string> = {};
      const dt = { setData: (t: string, v: string) => { data[t] = v; }, effectAllowed: '', dropEffect: '' };
      const e = new Event('dragstart', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: dt });
      act(() => { tab('a').closest('li')!.dispatchEvent(e); });
      act(() => { window.dispatchEvent(new Event('dragend')); });
      return { data, dt };
    };
    try {
      await render();
      const off = dragStart();
      expect(off.data).toEqual({ 'text/plain': 'a' });
      expect(off.dt.effectAllowed).toBe('move');
      mocks.refs = true;
      await render();
      const on = dragStart();
      // Box a isn't one of this person's listed boxes here, so the drag carries why it can't be messaged.
      expect(JSON.parse(on.data['application/x-termag-session-ref'])).toEqual({ refusal: "a isn't on a box of yours, so it can't be messaged." });
      expect(on.data['text/plain']).toBe('a');
      expect(on.dt.effectAllowed).toBe('copyMove');
    } finally {
      mocks.refs = false;
    }
  });

  it('keeps a chat\'s space through a reload and a grant of another space to its box', async () => {
    mocks.projects = [fixedTo(project('a', '2026-10-01T00:00:00Z'), 'id-notes')];
    mocks.index = new Map([['box-a', ['notes']]]);
    await render();
    expect(groups()).toContainEqual(['notes', ['a']]);
    act(() => root.unmount());
    root = createRoot(host);
    mocks.index = new Map([['box-a', ['assets', 'notes']]]);
    await render();
    expect(groups()).toEqual([['assets', []], ['notes', ['a']]]);
  });

  it('drops a dragged tab on its own space, and refuses another space with a note', async () => {
    mocks.projects = [project('a', '2026-10-01T00:00:00Z'), project('b', '2026-10-20T00:00:00Z'), project('c', '2026-10-10T00:00:00Z')];
    mocks.index = new Map([['box-a', ['notes']], ['box-b', ['notes']], ['box-c', ['notes']]]);
    await render();
    const dt = { setData() {}, effectAllowed: '', dropEffect: '' };
    const drag = (type: string, el: Element) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: dt });
      act(() => { el.dispatchEvent(e); });
    };
    const li = (name: string) => tab(name).closest('li')!;
    const group = (name: string) => [...host.querySelectorAll('.chat-group')].find(g => g.querySelector('.chat-group-name')!.textContent === name)!;
    drag('dragstart', li('a'));
    drag('dragover', group('assets').querySelector('.chat-group-head')!);
    expect(dt.dropEffect).toBe('none');
    expect(group('assets').classList.contains('drop-denied')).toBe(true);
    expect(group('assets').querySelector('.chat-drop-note')!.textContent).toBe('Tabs stay in their space');
    expect(host.querySelector('[aria-live]')!.textContent).toBe("Can't move a to assets. Tabs stay in their space.");
    drag('drop', group('assets').querySelector('.chat-group-head')!);
    expect(groups()).toContainEqual(['notes', ['b', 'c', 'a']]);
    expect(group('assets').classList.contains('drop-denied')).toBe(false);
    drag('dragstart', li('a'));
    drag('dragover', group('notes').querySelector('.chat-group-head')!);
    expect(dt.dropEffect).toBe('move');
    drag('drop', group('notes').querySelector('.chat-group-head')!);
    expect(groups()).toContainEqual(['notes', ['a', 'b', 'c']]);
  });

  // #743 with #742: a space's window counts places, a top-level tab with everything nested under it,
  // so a parent and its children show and hide together and a child is never cut off on its own.
  it('windows a space by top-level tabs, keeping each parent with its nested tabs', async () => {
    const names = Array.from({ length: 11 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    mocks.projects = [...names.map((n, i) => project(n, `2026-10-${String(30 - i).padStart(2, '0')}T00:00:00Z`)), project('kid', '2026-10-01T00:00:00Z')];
    mocks.index = new Map([...names, 'kid'].map(n => [`box-${n}`, ['notes']]));
    mocks.links = [{ projectId: 'kid', workstream: 'main', parentProjectId: 'p09', parentWorkstream: 'main' }];
    await render('/chat');
    // Ten places: p00..p09, with kid under p09 although it is stored last; p10 waits behind Show more.
    expect(groups()).toContainEqual(['notes', [...names.slice(0, 10), 'kid']]);
    expect(host.querySelector('.chat-group-more .chat-sr')!.textContent).toBe(': 1 of 1 more in notes');
    act(() => host.querySelector<HTMLButtonElement>('.chat-group-more')!.click());
    expect(groups()).toContainEqual(['notes', [...names.slice(0, 10), 'kid', 'p10']]);
    mocks.links = [];
  });

  // Bugbot on #743: a row's drop index is its place in the tree order, but the drop used the stored order.
  it('drops a tab where it shows in the tree, with a child stored away from its parent', async () => {
    mocks.projects = [project('boss', '2026-10-20T00:00:00Z'), project('x', '2026-10-19T00:00:00Z'), project('kid', '2026-10-18T00:00:00Z'), project('y', '2026-10-17T00:00:00Z')];
    mocks.index = new Map([['box-boss', ['notes']], ['box-x', ['notes']], ['box-kid', ['notes']], ['box-y', ['notes']]]);
    mocks.links = [{ projectId: 'kid', workstream: 'main', parentProjectId: 'boss', parentWorkstream: 'main' }];
    await render();
    // Stored [boss, x, kid, y]; shown with kid under boss.
    expect(groups()).toContainEqual(['notes', ['boss', 'kid', 'x', 'y']]);
    const dt = { setData() {}, effectAllowed: '', dropEffect: '' };
    const drag = (type: string, el: Element) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: dt });
      act(() => { el.dispatchEvent(e); });
    };
    const li = (name: string) => tab(name).closest('li')!;
    // jsdom's rows have no height, so over a row is always "below it": y goes right after kid.
    drag('dragstart', li('y'));
    drag('dragover', li('kid'));
    drag('drop', li('kid'));
    expect(groups()).toContainEqual(['notes', ['boss', 'kid', 'y', 'x']]);
    mocks.links = [];
  });

  it('opens a tab\'s menu with Shift+F10: Duplicate tab puts a copy below it and shows it', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z')];
    await render('/chat/f/notes/README.md');
    expect(groups()).toContainEqual(['notes', ['README.md', 'a']]);
    act(() => tab('README.md').focus());
    key(tab('README.md'), 'F10', { shiftKey: true });
    expect(document.querySelector('.chat-ctx-menu')!.getAttribute('aria-label')).toBe('README.md');
    expect(menuLabels()).toEqual(['Duplicate tab', 'Open in new browser tab', 'Close tab', 'Close other tabs', 'Close tabs below']);
    expect(document.activeElement).toBe(menuItem('Duplicate tab'));
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(menuItem('Open in new browser tab'));
    key(document.activeElement!, 'Escape');
    expect(document.querySelector('.chat-ctx-menu')).toBeNull();
    await nextFrame();
    expect(document.activeElement).toBe(tab('README.md'));
    act(() => { tab('README.md').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })); });
    act(() => menuItem('Duplicate tab').click());
    await settle();
    expect(groups()).toContainEqual(['notes', ['README.md', 'README.md', 'a']]);
    const [first, copy] = stored().items;
    expect(location).toBe(`/chat/f/notes/README.md?tab=${copy.id}`);
    expect(first.id).not.toBe(copy.id);
    const tabs = [...host.querySelectorAll<HTMLAnchorElement>('a.chat-item')];
    expect(tabs[1].getAttribute('aria-current')).toBe('page');
    expect(tabs[0].getAttribute('aria-current')).toBeNull();
    act(() => { tabs[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })); });
    act(() => menuItem('Open in new browser tab').click());
    expect(mocks.open).toHaveBeenCalledWith('/chat/f/notes/README.md', '_blank', 'noopener');
  });

  it('opens a tab\'s menu from ⋮ on a touch screen, without following the tab, and Close tab closes it', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z'), project('b', '2026-10-10T00:00:00Z')];
    mocks.index = new Map([['box-a', ['notes']], ['box-b', ['notes']]]);
    await render('/chat');
    expect(groups()).toContainEqual(['notes', ['a', 'b']]);
    tap(dots('b'));
    expect(location).toBe('/chat');
    const menu = document.querySelector<HTMLElement>('.chat-ctx-menu')!;
    expect(menu.getAttribute('aria-label')).toBe('b');
    await nextFrame();
    expect(document.activeElement).toBe(menu);
    act(() => menuItem('Close tab').click());
    expect(groups()).toContainEqual(['notes', ['a']]);
  });

  it('opens nothing on a held finger: ⋮ is the menu on a touch screen, and there is no drag', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)', media: q, addEventListener: () => {}, removeEventListener: () => {} }));
    mocks.projects = [project('a', '2026-10-20T00:00:00Z')];
    await render('/chat/f/notes/README.md');
    await holdFinger(tab('a'));
    expect(document.querySelector('.chat-ctx-menu')).toBeNull();
    expect(location).toMatch(/^\/chat\/p\/a\?tab=/);
    expect(tab('a').closest('li')!.getAttribute('draggable')).toBe('false');
  });

  it('closes the tabs below one, or the others in its space, going to the one acted on; never the session or file', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z'), project('b', '2026-10-19T00:00:00Z'), project('c', '2026-10-18T00:00:00Z'), project('d', '2026-10-17T00:00:00Z')];
    mocks.index = new Map([['box-a', ['notes']], ['box-b', ['notes']], ['box-c', ['notes']], ['box-d', ['notes']]]);
    await render('/chat');
    act(() => tab('d').click());
    expect(groups()).toContainEqual(['notes', ['a', 'b', 'c', 'd']]);
    act(() => dots('b').click());
    expect(menuItem('Close tabs below').getAttribute('aria-disabled') === 'true').toBe(false);
    act(() => menuItem('Close tabs below').click());
    await settle();
    expect(groups()).toContainEqual(['notes', ['a', 'b']]);
    // d was open, so the sidebar goes to b, the tab acted on.
    expect(location).toMatch(/^\/chat\/p\/b\?tab=/);
    expect(host.querySelector('[aria-live="polite"]')!.textContent).toBe('Closed 2 tabs in notes');
    rightClick(tab('a'));
    act(() => menuItem('Close other tabs').click());
    await settle();
    expect(groups()).toContainEqual(['notes', ['a']]);
    expect(location).toMatch(/^\/chat\/p\/a\?tab=/);
    // Only the tabs went: every session is still there to open again.
    expect(stored().items.map(i => i.kind)).toEqual(['chat']);
    expect(mocks.projects.map(p => p.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('opens the same ⋮ menu from a right click, Shift+F10 or the menu key on the head, and its tab actions close every tab or the file tabs', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z')];
    localStorage.setItem(openItemsKey('u1'), JSON.stringify({ v: 2, seeded: false, items: [
      { kind: 'file', space: 'notes', path: 'docs/q3.pdf', id: 'f1', openedAt: 2 },
      { kind: 'file', space: 'notes', path: 'README.md', id: 'f2', openedAt: 1 },
    ] }));
    await render('/chat');
    expect(groups()).toContainEqual(['notes', ['q3.pdf', 'README.md', 'a']]);
    const head = host.querySelector<HTMLElement>('.chat-group[data-group="notes"] .chat-group-head')!;
    const toggle = head.querySelector<HTMLButtonElement>('.chat-group-toggle')!;
    // The fold toggle's tooltip no longer points at a right click; the ⋮ is the way to the menu.
    expect(toggle.getAttribute('data-tip')).toBe('Fold notes');
    expect(head.hasAttribute('data-tip')).toBe(false);
    rightClick(head);
    // The same menu as the ⋮'s, hung from the ⋮.
    expect(document.querySelectorAll('.chat-ctx-menu')).toHaveLength(1);
    expect(document.querySelector('.chat-ctx-menu')!.getAttribute('aria-label')).toBe('notes');
    expect(menuLabels()).toEqual(SPACE_MENU);
    expect(groupDots('notes').getAttribute('aria-expanded')).toBe('true');
    act(() => menuItem('Close file tabs').click());
    await settle();
    expect(groups()).toContainEqual(['notes', ['a']]);
    // The keyboard: Shift+F10 or the context menu key on the head's focused fold toggle, and Escape gives focus back to it.
    act(() => toggle.focus());
    key(toggle, 'F10', { shiftKey: true });
    expect(menuLabels()).toEqual(SPACE_MENU);
    expect(groupDots('notes').getAttribute('aria-expanded')).toBe('true');
    expect(menuItem('Close file tabs').getAttribute('aria-disabled') === 'true').toBe(true);
    key(document.activeElement!, 'Escape');
    await nextFrame();
    expect(document.activeElement).toBe(toggle);
    key(toggle, 'ContextMenu');
    act(() => menuItem('Close all tabs').click());
    await settle();
    expect(groups()).toEqual([['assets', []], ['notes', []]]);
    rightClick(head);
    expect(menuItem('Close all tabs').getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('opens a long press\'s menu in touch mode, as a tap on the ⋮ does: the menu has focus, and a pick moves no focus', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z')];
    await render('/chat');
    const head = host.querySelector<HTMLElement>('.chat-group[data-group="notes"] .chat-group-head')!;
    await holdFinger(head);
    const menu = document.querySelector<HTMLElement>('.chat-ctx-menu')!;
    expect(menuLabels()).toEqual(SPACE_MENU);
    // No item looks keyboard-selected: the menu itself has focus.
    await nextFrame();
    expect(document.activeElement).toBe(menu);
    act(() => menuItem('Close all tabs').click());
    await settle();
    expect(document.querySelector('.chat-ctx-menu')).toBeNull();
    expect(document.activeElement).not.toBe(head.querySelector('.chat-group-toggle'));
    expect(document.activeElement).not.toBe(groupDots('notes'));
  });

  it('opens the same ⋮ menu on a long press on the head, without following the click its lift makes', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z')];
    await render('/chat');
    const head = host.querySelector<HTMLElement>('.chat-group[data-group="notes"] .chat-group-head')!;
    await holdFinger(head);
    expect(document.querySelector('.chat-ctx-menu')!.getAttribute('aria-label')).toBe('notes');
    expect(menuLabels()).toEqual(SPACE_MENU);
    expect(groupDots('notes').getAttribute('aria-expanded')).toBe('true');
    expect(location).toBe('/chat');
    await nextFrame();
    key(document.activeElement!, 'Escape');
    // A short tap is no long press.
    tap(head);
    expect(document.querySelector('.chat-ctx-menu')).toBeNull();
  });

  it('leaves the next tap alone after a long press whose lift makes no click (iOS, Android)', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z'), project('b', '2026-10-19T00:00:00Z')];
    mocks.index = new Map([['box-a', ['notes']], ['box-b', ['notes']]]);
    await render('/chat');
    const head = host.querySelector<HTMLElement>('.chat-group[data-group="notes"] .chat-group-head')!;
    act(() => touch(head, 'pointerdown'));
    await act(async () => { await new Promise(r => setTimeout(r, 700)); });
    act(() => touch(head, 'pointerup'));
    expect(menuLabels()).toEqual(SPACE_MENU);
    // The finger's next tap, on the menu it just opened, picks the item.
    act(() => menuItem('Close all tabs').click());
    await settle();
    expect(groups()).toContainEqual(['notes', []]);
  });

  it('captures the held finger once a long press fires, and not for a tap', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z')];
    await render('/chat');
    const head = host.querySelector<HTMLElement>('.chat-group[data-group="notes"] .chat-group-head')!;
    const capture = vi.fn();
    Object.defineProperty(head, 'setPointerCapture', { value: capture, configurable: true });
    const down = () => {
      const e = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 40, clientY: 60, detail: 1 });
      Object.defineProperty(e, 'pointerType', { value: 'touch' });
      Object.defineProperty(e, 'pointerId', { value: 7 });
      head.dispatchEvent(e);
    };
    act(down);
    act(() => touch(head, 'pointerup'));
    expect(capture).not.toHaveBeenCalled();
    act(down);
    await act(async () => { await new Promise(r => setTimeout(r, 700)); });
    expect(capture).toHaveBeenCalledWith(7);
    act(() => touch(head, 'pointerup'));
  });

  it('gives focus back to the ⋮ when Shift+F10 or the menu key on the focused ⋮ opened its menu', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z')];
    await render('/chat');
    const dots = groupDots('notes');
    act(() => dots.focus());
    key(dots, 'F10', { shiftKey: true });
    expect(menuLabels()).toEqual(SPACE_MENU);
    expect(dots.getAttribute('aria-expanded')).toBe('true');
    key(document.activeElement!, 'Escape');
    await nextFrame();
    expect(document.activeElement).toBe(dots);
    key(dots, 'ContextMenu');
    expect(menuLabels()).toEqual(SPACE_MENU);
    key(document.activeElement!, 'Escape');
    await nextFrame();
    expect(document.activeElement).toBe(dots);
  });

  it('names the ⋮ neutrally, so its tooltip stays right whatever the menu holds', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z'), project('loose', '2026-10-10T00:00:00Z')];
    await render('/chat');
    expect(groupDots('notes').getAttribute('data-tip')).toBe('Options for notes');
    expect(groupDots('No space').getAttribute('data-tip')).toBe('Options for No space');
  });

  it('gives No space the ⋮ of a space without Share space: New agent, New tab (its agents) and the tab actions', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z'), project('loose', '2026-10-10T00:00:00Z')];
    await render('/chat');
    const head = host.querySelector<HTMLElement>('.chat-group[data-space="none"] .chat-group-head')!;
    expect([...head.querySelectorAll('button')].map(b => b.className)).toEqual(['chat-group-toggle', 'item-menu-btn chat-group-menu']);
    openMenu('No space');
    expect(document.querySelector('.chat-ctx-menu')!.getAttribute('aria-label')).toBe('No space');
    expect(menuLabels()).toEqual(NO_SPACE_MENU);
    key(document.activeElement!, 'Escape');
    rightClick(head);
    expect(menuLabels()).toEqual(NO_SPACE_MENU);
    act(() => menuItem('Close all tabs').click());
    await settle();
    expect(groups()).toEqual([['assets', []], ['notes', ['a']]]);
    openMenu('notes');
    act(() => menuItem('New agent').click());
    await settle();
    expect(location).toBe('/chat/new?space=notes');
  });

  it('shows a space\'s first 10 tabs, Show more 10 at a time, and the row goes once all show; hidden tabs stay open', async () => {
    const names = Array.from({ length: 25 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    mocks.projects = names.map((n, i) => project(n, new Date(Date.UTC(2026, 9, 30) - i * 3600_000).toISOString()));
    mocks.index = new Map(names.map(n => [`box-${n}`, ['notes']]));
    await render('/chat');
    const more = () => host.querySelector<HTMLButtonElement>('.chat-group[data-group="notes"] .chat-group-more');
    expect(groups()).toContainEqual(['notes', names.slice(0, 10)]);
    expect(stored().items).toHaveLength(25);
    expect(more()!.firstChild!.textContent).toBe('Show more');
    act(() => more()!.focus());
    act(() => more()!.click());
    expect(groups()).toContainEqual(['notes', names.slice(0, 20)]);
    // Still more to show: focus stays on the row.
    expect(document.activeElement).toBe(more());
    act(() => more()!.click());
    // Everything shows, so the row disappears, with no Show less, and focus goes to the last tab it revealed.
    expect(groups()).toContainEqual(['notes', names]);
    expect(more()).toBeNull();
    expect(host.textContent).not.toContain('Show less');
    expect(document.activeElement).toBe(tab('p24'));
    expect(stored().items).toHaveLength(25);
    // Only a reload takes the list back to its first 10, and the open tab shows past them.
    act(() => tab('p22').click());
    act(() => root.unmount());
    root = createRoot(host);
    await render('/chat/p/p22');
    expect(groups()).toContainEqual(['notes', [...names.slice(0, 10), 'p22']]);
    expect(more()!.firstChild!.textContent).toBe('Show more');
    expect(stored().items).toHaveLength(25);
  });

  it('shows the last tabs without moving focus when the row wasn\'t focused (a click that doesn\'t focus, as in Safari)', async () => {
    const names = Array.from({ length: 15 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    mocks.projects = names.map((n, i) => project(n, new Date(Date.UTC(2026, 9, 30) - i * 3600_000).toISOString()));
    mocks.index = new Map(names.map(n => [`box-${n}`, ['notes']]));
    await render('/chat');
    act(() => host.querySelector<HTMLButtonElement>('.chat-group[data-group="notes"] .chat-group-more')!.click());
    expect(groups()).toContainEqual(['notes', names]);
    expect(host.querySelector('.chat-group-more')).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('a folded space moves only what it shows: the open tab, never the hidden window behind the fold', async () => {
    const names = Array.from({ length: 25 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    mocks.projects = names.map((n, i) => project(n, new Date(Date.UTC(2026, 9, 30) - i * 3600_000).toISOString()));
    mocks.index = new Map(names.map(n => [`box-${n}`, ['notes']]));
    await render('/chat/p/p22');
    const head = () => host.querySelector<HTMLButtonElement>('.chat-group[data-group="notes"] .chat-group-toggle')!;
    const live = () => host.querySelector('[aria-live]')!.textContent;
    const order = () => stored().items.map((i: { id: string }) => i.id);
    const before = order();
    act(() => head().click());
    expect(groups()).toContainEqual(['notes', ['p22']]);
    act(() => tab('p22').focus());
    key(tab('p22'), 'ArrowDown', { altKey: true });
    // Folded, p22 is the only tab on screen: no "Show more" (that row is folded away), and nothing moves.
    expect(live()).toBe('p22 is already last in notes. Tabs stay in their space.');
    key(tab('p22'), 'ArrowUp', { altKey: true });
    expect(live()).toBe('p22 is already first in notes. Tabs stay in their space.');
    expect(order()).toEqual(before);
    expect(groups()).toContainEqual(['notes', ['p22']]);
  });

  it('moves tabs among the ones shown: never into the hidden range, and the open tab past the window next to the row above it', async () => {
    const names = Array.from({ length: 25 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    mocks.projects = names.map((n, i) => project(n, new Date(Date.UTC(2026, 9, 30) - i * 3600_000).toISOString()));
    mocks.index = new Map(names.map(n => [`box-${n}`, ['notes']]));
    await render('/chat');
    const shown = () => groups().find(g => g[0] === 'notes')![1];
    const live = () => host.querySelector('[aria-live]')!.textContent;
    // The 10th shown tab can't go down into the hidden ones by itself.
    act(() => tab('p09').focus());
    key(tab('p09'), 'ArrowDown', { altKey: true });
    expect(shown()).toEqual(names.slice(0, 10));
    expect(live()).toBe('p09 is the last one shown in notes. Show more to move it further.');
    // The open tab, shown after the window, goes above the row shown above it, and that row stays shown.
    const more = () => host.querySelector<HTMLButtonElement>('.chat-group[data-group="notes"] .chat-group-more')!;
    act(() => more().click());
    act(() => more().click());
    act(() => tab('p22').click());
    // Back to the first 10 is a reload, with p22 open.
    act(() => root.unmount());
    root = createRoot(host);
    await render('/chat/p/p22');
    expect(shown()).toEqual([...names.slice(0, 10), 'p22']);
    act(() => tab('p22').focus());
    key(tab('p22'), 'ArrowUp', { altKey: true });
    expect(shown()).toEqual([...names.slice(0, 9), 'p22', 'p09']);
    expect(live()).toBe('p22 moved to position 10 of 11 in notes');
    key(tab('p22'), 'ArrowDown', { altKey: true });
    expect(shown()).toEqual([...names.slice(0, 10), 'p22']);
    // A drop after the last row shown lands right after it, not past the hidden ones.
    const dt = { setData() {}, effectAllowed: '', dropEffect: '' };
    const drag = (type: string, el: Element, clientY?: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: dt });
      if (clientY != null) Object.defineProperty(e, 'clientY', { value: clientY });
      act(() => { el.dispatchEvent(e); });
    };
    const li = (name: string) => tab(name).closest('li')!;
    drag('dragstart', li('p03'));
    // jsdom lays nothing out: every row is at 0 high, so a clientY of 1 is its lower half.
    drag('dragover', li('p22'), 1);
    drag('drop', li('p22'), 1);
    expect(shown()).toEqual([...names.slice(0, 3), ...names.slice(4, 10), 'p22', 'p03']);
    expect(stored().items).toHaveLength(25);
  });

  it('gives No space the same window, and a list that fits no row under it', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `loose${String(i).padStart(2, '0')}`);
    mocks.projects = [project('a', '2026-10-30T00:00:00Z'), ...names.map((n, i) => project(n, new Date(Date.UTC(2026, 9, 29) - i * 3600_000).toISOString()))];
    mocks.index = new Map([['box-a', ['notes']]]);
    await render('/chat');
    expect(groups()).toContainEqual(['No space', names.slice(0, 10)]);
    expect(host.querySelector('.chat-group[data-group="notes"] .chat-group-more')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('.chat-group[data-space="none"] .chat-group-more')!.click());
    expect(groups()).toContainEqual(['No space', names]);
  });

  it('folds a space from its head by click or arrow keys, remembers it, and keeps the open tab showing', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z'), project('b', '2026-10-10T00:00:00Z')];
    mocks.index = new Map([['box-a', ['notes']], ['box-b', ['notes']]]);
    await render('/chat');
    const head = () => host.querySelector<HTMLButtonElement>('.chat-group[data-group="notes"] .chat-group-toggle')!;
    expect(head().getAttribute('aria-expanded')).toBe('true');
    // No tab count on the head, folded or not.
    expect(head().textContent).toBe('notes');
    expect(host.querySelector('.chat-group-count')).toBeNull();
    act(() => head().click());
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(groups()).toContainEqual(['notes', []]);
    expect(head().textContent).toBe('notes');
    expect(JSON.parse(localStorage.getItem('termag.chat.collapsedSpaces')!)).toEqual(['notes']);
    key(head(), 'ArrowRight');
    expect(groups()).toContainEqual(['notes', ['a', 'b']]);
    key(head(), 'ArrowLeft');
    expect(groups()).toContainEqual(['notes', []]);
    // A reload keeps it folded; the tab on screen still shows in its folded space.
    act(() => root.unmount());
    root = createRoot(host);
    await render('/chat/p/b');
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(groups()).toContainEqual(['notes', ['b']]);
    act(() => head().click());
    expect(groups()).toContainEqual(['notes', ['a', 'b']]);
    expect(localStorage.getItem('termag.chat.collapsedSpaces')).toBe('[]');
  });

  it('says how many agents need you on a folded space, and nothing when none do', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z'), project('b', '2026-10-10T00:00:00Z'), project('c', '2026-10-05T00:00:00Z')];
    mocks.index = new Map([['box-a', ['notes']], ['box-b', ['notes']], ['box-c', ['notes']]]);
    const waiting = (id: string) => [statusKey(`box-${id}`, sessionName('ada', id, 'agent', 'main')), { status: 'waiting' }] as const;
    mocks.status = Object.fromEntries([waiting('a'), waiting('b')]);
    try {
      await render('/chat');
      const head = () => host.querySelector<HTMLButtonElement>('.chat-group[data-group="notes"] .chat-group-toggle')!;
      expect(head().querySelector('.chat-group-attn')).toBeNull();
      act(() => head().click());
      expect(head().querySelector('.chat-group-attn')!.textContent).toBe('2 need you');
      expect(head().textContent).toBe('notes2 need you');
    } finally {
      mocks.status = {};
    }
  });

  it('folds No space the same way: its head, the arrow keys, and across a reload', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z'), project('loose', '2026-10-10T00:00:00Z')];
    await render('/chat');
    const head = () => host.querySelector<HTMLButtonElement>('.chat-group[data-space="none"] .chat-group-toggle')!;
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(head().querySelector('.chat-group-caret')).not.toBeNull();
    expect(head().textContent).toBe('No space');
    expect(groups()).toContainEqual(['No space', ['loose']]);
    act(() => head().click());
    expect(groups()).toContainEqual(['No space', []]);
    expect(groups()).toContainEqual(['notes', ['a']]);
    expect(JSON.parse(localStorage.getItem('termag.chat.collapsedSpaces')!)).toEqual(['(none)']);
    key(head(), 'ArrowRight');
    expect(groups()).toContainEqual(['No space', ['loose']]);
    key(head(), 'ArrowLeft');
    act(() => root.unmount());
    root = createRoot(host);
    await render('/chat');
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(groups()).toContainEqual(['No space', []]);
  });

  it('gives a user with no spaces the very No space group a user with spaces has: head, fold, ⋮ with New tab, order, Close tab', async () => {
    mocks.projects = [project('a', '2026-10-01T00:00:00Z'), project('b', '2026-10-20T00:00:00Z')];
    // Someone with spaces, whose two sessions are in no space.
    mocks.index = new Map();
    const noSpaceGroup = () => host.querySelector<HTMLElement>('.chat-group[data-space="none"]')!;
    // React Aria numbers its buttons' ids (each tab's X) per render; the rest must match to the byte.
    const markup = () => noSpaceGroup().outerHTML.replace(/ id="react-aria-[^"]*"/g, '');
    await render();
    const withSpaces = markup();
    act(() => root.unmount());
    root = createRoot(host);
    mocks.list = [];
    await render();
    expect(host.querySelector('.chat-row')).toBeNull();
    expect(markup()).toBe(withSpaces);
    expect(groups()).toEqual([['No space', ['b', 'a']]]);
    const head = noSpaceGroup().querySelector<HTMLElement>('.chat-group-head')!;
    expect([...head.querySelectorAll('button')].map(b => b.className)).toEqual(['chat-group-toggle', 'item-menu-btn chat-group-menu']);
    expect(head.querySelector('.space-swatch')!.getAttribute('data-space')).toBe('none');

    openMenu('No space');
    expect(menuLabels()).toEqual(NO_SPACE_MENU);
    key(document.activeElement!, 'Escape');

    const toggle = () => head.querySelector<HTMLButtonElement>('.chat-group-toggle')!;
    act(() => toggle().click());
    expect(groups()).toEqual([['No space', []]]);
    expect(JSON.parse(localStorage.getItem('termag.chat.collapsedSpaces')!)).toEqual(['(none)']);
    act(() => toggle().click());

    act(() => tab('a').focus());
    key(tab('a'), 'ArrowUp', { altKey: true });
    expect(groups()).toEqual([['No space', ['a', 'b']]]);
    expect(host.querySelector('[aria-live]')!.textContent).toBe('a moved to position 1 of 2 in No space');

    rightClick(tab('a'));
    act(() => menuItem('Close tab').click());
    expect(groups()).toEqual([['No space', ['b']]]);
  });

  it('folds an automation\'s run tabs into one row: its latest run\'s status and run count, unfolded newest first or when a run is open', async () => {
    const ws = (name: string) => ({ id: name, name, archived: false, createdAt: '2026-10-28T10:00:00Z' });
    mocks.list = [];
    mocks.index = new Map();
    mocks.projects = [
      project('a', '2026-10-28T00:00:00Z'),
      { ...project('babysit', '2026-10-28T18:30:00Z'), name: 'pr-babysitter', kind: 'automation',
        workstreams: [ws('main'), ws('run-20261028-1800'), ws('run-20261028-1830'), ws('run-20261028-1730')] } as unknown as Project,
    ];
    mocks.status = { [statusKey('box-babysit', sessionName('ada', 'pr-babysitter', 'agent', 'run-20261028-1830'))]: { status: 'working' } };
    resetUnfoldedRuns();
    try {
      await render();
      const head = () => host.querySelector<HTMLButtonElement>('.chat-runs-item')!;
      expect(groups()).toEqual([['No space', ['pr-babysitter', 'a']]]);
      expect(head().getAttribute('aria-expanded')).toBe('false');
      expect(head().querySelector('.chat-agent-icon')!.getAttribute('data-status')).toBe('working');
      expect(head().querySelector('.chat-group-count')!.textContent).toBe('3');
      act(() => head().click());
      expect(groups()[0][1].slice(1, 4)).toEqual([expect.stringMatching(/18:30$/), expect.stringMatching(/18:00$/), expect.stringMatching(/17:30$/)]);
      // The automation's row is one place in the drag order: the other tab moves past it whole.
      act(() => tab('a').focus());
      key(tab('a'), 'ArrowUp', { altKey: true });
      expect(host.querySelector('[aria-live]')!.textContent).toBe('a moved to position 1 of 2 in No space');
      expect(groups()[0][1][0]).toBe('a');
      expect(groups()[0][1][1]).toBe('pr-babysitter');

      act(() => root.unmount());
      root = createRoot(host);
      resetUnfoldedRuns();
      await render('/chat/p/babysit?ws=run-20261028-1730');
      expect(head().getAttribute('aria-expanded')).toBe('true');
    } finally {
      mocks.status = {};
    }
  });

  // Bugbot on #1024: an X's close looked for its neighbour among tab links only, so focus left the list
  // when that neighbour was an automation's row, or when the closed tab was one of its runs.
  it('keeps focus in the list when an X closes a tab next to an automation\'s row, or one of its run tabs', async () => {
    const ws = (name: string) => ({ id: name, name, archived: false, createdAt: '2026-10-28T10:00:00Z' });
    mocks.list = [];
    mocks.index = new Map();
    mocks.projects = [
      project('a', '2026-10-28T00:00:00Z'),
      { ...project('babysit', '2026-10-28T18:30:00Z'), name: 'pr-babysitter', kind: 'automation',
        workstreams: [ws('main'), ws('run-20261028-1730'), ws('run-20261028-1800')] } as unknown as Project,
    ];
    localStorage.setItem(openItemsKey('u1'), JSON.stringify({ v: 2, seeded: true, items: [
      { kind: 'chat', projectId: 'babysit', workstream: 'run-20261028-1800', id: 'r1', openedAt: 3 },
      { kind: 'chat', projectId: 'babysit', workstream: 'run-20261028-1730', id: 'r2', openedAt: 2 },
      { kind: 'chat', projectId: 'a', workstream: 'main', id: 'ta', openedAt: 1 },
    ] }));
    resetUnfoldedRuns();
    await render();
    const head = () => host.querySelector<HTMLButtonElement>('.chat-runs-item')!;
    act(() => head().click());
    // A run tab's X, by its tab: its label is the session's, not the run's time on screen.
    const xOf = (id: string) => host.querySelector<HTMLAnchorElement>(`a.chat-item[data-tab="${id}"]`)!.closest('li')!.querySelector<HTMLButtonElement>('.chat-item-close')!;
    // A run's own tab: focus goes to the row after it, here the other run's tab.
    act(() => xOf('r1').focus());
    press(xOf('r1'), 'Enter');
    await settle();
    expect(stored().items.map(i => i.id)).toEqual(['r2', 'ta']);
    expect(document.activeElement).toBe(host.querySelector('a.chat-item[data-tab="r2"]'));
    // Folded, the row above a is the automation's row itself, which takes focus when a's X closes it.
    act(() => head().click());
    expect(head().getAttribute('aria-expanded')).toBe('false');
    act(() => close('a').focus());
    press(close('a'), 'Enter');
    await settle();
    expect(stored().items.map(i => i.id)).toEqual(['r2']);
    expect(document.activeElement).toBe(head());
  });

  // Bugbot on #1024: a folded space shows only its open tab, so the X found no neighbour on screen.
  it('gives focus to the tab that takes the open one\'s place in a folded space when its X closes it', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z'), project('b', '2026-10-10T00:00:00Z')];
    mocks.index = new Map([['box-a', ['notes']], ['box-b', ['notes']]]);
    await render('/chat');
    act(() => tab('a').click());
    await settle();
    const toggle = [...host.querySelectorAll<HTMLButtonElement>('.chat-group-toggle')].find(b => b.textContent?.includes('notes'))!;
    act(() => toggle.click());
    expect(groups()).toContainEqual(['notes', ['a']]);
    act(() => close('a').focus());
    press(close('a'), 'Enter');
    await settle();
    expect(groups()).toContainEqual(['notes', ['b']]);
    expect(location).toMatch(/^\/chat\/p\/b\?tab=/);
    expect(document.activeElement).toBe(tab('b'));
  });

  // The babysitter's row listed only the runs open as tabs (3 of 6), while the explorer listed every one.
  it('counts and lists every run of an automation, not only its run tabs, and a run that starts shows up without a reload', async () => {
    const ws = (name: string) => ({ id: name, name, archived: false, createdAt: '2026-10-28T10:00:00Z' });
    const babysit = (runs: string[]) => ({ ...project('babysit', '2026-10-28T18:30:00Z'), name: 'pr-babysitter', kind: 'automation',
      workstreams: [ws('main'), ...runs.map(ws)] } as unknown as Project);
    mocks.list = [];
    mocks.index = new Map();
    mocks.projects = [babysit(['run-20261028-1700', 'run-20261028-1730', 'run-20261028-1800', 'run-20261028-1830'])];
    localStorage.setItem(openItemsKey('u1'), JSON.stringify({ v: 2, seeded: true, items: [
      { kind: 'chat', projectId: 'babysit', workstream: 'run-20261028-1730', id: 'r1', openedAt: 2 },
      { kind: 'chat', projectId: 'babysit', workstream: 'run-20261028-1700', id: 'r2', openedAt: 1 },
    ] }));
    resetUnfoldedRuns();
    await render();
    const head = () => host.querySelector<HTMLButtonElement>('.chat-runs-item')!;
    expect(head().querySelector('.chat-group-count')!.textContent).toBe('4');
    act(() => head().click());
    const runNames = () => groupNames().slice(1);
    expect(runNames()).toEqual([expect.stringMatching(/18:30$/), expect.stringMatching(/18:00$/), expect.stringMatching(/17:30$/), expect.stringMatching(/17:00$/)]);
    expect(host.querySelectorAll('a.chat-run-link')).toHaveLength(2);

    // The next run starts: the row has it on top, with no reload.
    mocks.projects = [babysit(['run-20261028-1700', 'run-20261028-1730', 'run-20261028-1800', 'run-20261028-1830', 'run-20261028-1900'])];
    await render();
    expect(head().querySelector('.chat-group-count')!.textContent).toBe('5');
    expect(runNames()[0]).toMatch(/19:00$/);

    // A run with no tab opens in one.
    const newest = host.querySelector<HTMLAnchorElement>('a.chat-run-link')!;
    act(() => newest.click());
    await settle();
    expect(location).toMatch(/^\/chat\/p\/babysit\?ws=run-20261028-1900/);
    expect(stored().items.map(i => (i as { workstream?: string }).workstream)).toContain('run-20261028-1900');
    expect(head().querySelector('.chat-group-count')!.textContent).toBe('5');
  });

  // Bugbot on #894: run tabs were left out of the drag order, so a move put them after every other tab.
  it('moves a tab past an automation\'s row as one place, and leaves the row where it was', async () => {
    const ws = (name: string) => ({ id: name, name, archived: false, createdAt: '2026-10-28T10:00:00Z' });
    mocks.list = [];
    mocks.index = new Map();
    mocks.projects = [
      project('b', '2026-10-28T20:00:00Z'),
      { ...project('babysit', '2026-10-28T18:30:00Z'), name: 'pr-babysitter', kind: 'automation',
        workstreams: [ws('main'), ws('run-20261028-1800'), ws('run-20261028-1830')] } as unknown as Project,
      project('a', '2026-10-28T00:00:00Z'),
    ];
    resetUnfoldedRuns();
    await render();
    expect(groups()).toEqual([['No space', ['b', 'pr-babysitter', 'a']]]);
    act(() => tab('a').focus());
    key(tab('a'), 'ArrowUp', { altKey: true });
    expect(groups()).toEqual([['No space', ['b', 'a', 'pr-babysitter']]]);
    expect(host.querySelector('[aria-live]')!.textContent).toBe('a moved to position 2 of 3 in No space');
    key(tab('a'), 'ArrowUp', { altKey: true });
    expect(groups()).toEqual([['No space', ['a', 'b', 'pr-babysitter']]]);
    // Every run's tab is still open, in the order it had.
    const runs = stored().items.filter(i => (i as { projectId?: string }).projectId === 'babysit').map(i => (i as { workstream?: string }).workstream);
    expect(runs).toHaveLength(2);
  });

  // Bugbot on #894: a run's asks and spawned agents were left after the group, out of their run.
  it('keeps the tab of an agent a run started under that run, inside the automation\'s row', async () => {
    const ws = (name: string) => ({ id: name, name, archived: false, createdAt: '2026-10-28T10:00:00Z' });
    mocks.list = [];
    mocks.index = new Map();
    mocks.projects = [
      { ...project('babysit', '2026-10-28T18:30:00Z'), name: 'pr-babysitter', kind: 'automation',
        workstreams: [ws('main'), ws('run-20261028-1800'), ws('run-20261028-1830')] } as unknown as Project,
      { ...project('kid', '2026-10-28T19:00:00Z'), name: 'helper' } as unknown as Project,
    ];
    mocks.links = [{ projectId: 'kid', workstream: 'main', parentProjectId: 'babysit', parentWorkstream: 'run-20261028-1800' }];
    resetUnfoldedRuns();
    try {
      await render();
      expect(groups()).toEqual([['No space', ['pr-babysitter']]]);
      act(() => host.querySelector<HTMLButtonElement>('.chat-runs-item')!.click());
      const depths = [...host.querySelectorAll<HTMLElement>('.chat-group-list > li')].map(li => `${li.style.getPropertyValue('--chat-depth') || '0'} ${li.querySelector('.chat-item-name')?.textContent}`);
      expect(depths).toEqual(['0 pr-babysitter', expect.stringMatching(/^1 .*18:30$/), expect.stringMatching(/^1 .*18:00$/), '2 helper']);
    } finally {
      mocks.links = [];
    }
  });

  // Bugbot on #1005: an ask's tab open without its run's counted as one more run.
  it('counts a run\'s ask open as a tab without its run as no run, and lists it under that run', async () => {
    const ws = (name: string) => ({ id: name, name, archived: false, createdAt: '2026-10-28T10:00:00Z' });
    mocks.list = [];
    mocks.index = new Map();
    mocks.projects = [{ ...project('babysit', '2026-10-28T18:30:00Z'), name: 'pr-babysitter', kind: 'automation',
      workstreams: [ws('main'), ws('run-20261028-1800'), ws('run-20261028-1830'), ws('ask-1')] } as unknown as Project];
    mocks.links = [{ projectId: 'babysit', workstream: 'ask-1', parentProjectId: 'babysit', parentWorkstream: 'run-20261028-1800' }];
    localStorage.setItem(openItemsKey('u1'), JSON.stringify({ v: 2, seeded: true, items: [
      { kind: 'chat', projectId: 'babysit', workstream: 'ask-1', id: 'a1', openedAt: 1 },
    ] }));
    resetUnfoldedRuns();
    try {
      await render();
      const head = host.querySelector<HTMLButtonElement>('.chat-runs-item')!;
      expect(head.querySelector('.chat-group-count')!.textContent).toBe('2');
      act(() => head.click());
      const depths = [...host.querySelectorAll<HTMLElement>('.chat-group-list > li')].map(li => li.style.getPropertyValue('--chat-depth') || '0');
      expect(depths).toEqual(['0', '1', '1', '2']);
      expect(host.querySelectorAll('a.chat-run-link')).toHaveLength(2);
      expect(host.querySelector('.chat-runs-all')?.textContent ?? '').not.toMatch(/Show all/);
    } finally {
      mocks.links = [];
    }
  });

  it('says there are no sessions yet to a user with no spaces and nothing open', async () => {
    mocks.projects = [];
    mocks.list = [];
    await render();
    expect(groups()).toEqual([]);
    expect(host.querySelector('.chat-items .chat-list-empty')!.textContent).toBe('No sessions yet.');
  });

});

describe('the agents explorer, for no space', () => {
  const panelNames = () => [...host.querySelectorAll('.fx-panel .fx-tree > li > a.fx-row .fx-name')].map(n => n.textContent);

  beforeEach(() => {
    mocks.spaces = true;
    mocks.list = [];
    mocks.index = new Map();
    mocks.projects = [project('boss', '2026-10-20T00:00:00Z'), project('kid', '2026-10-19T00:00:00Z'), project('solo', '2026-10-18T00:00:00Z')];
    mocks.links = [{ projectId: 'kid', workstream: 'main', parentProjectId: 'boss', parentWorkstream: 'main' }];
    mocks.tree = (space: string) => Promise.reject(new Error(`listed ${space}`));
  });
  afterEach(() => { mocks.tree = null; });

  it('opens from No space\'s ⋮ > New tab: recent agents, and every agent in Agents, nested, with no files', async () => {
    await render();
    openMenu('No space');
    act(() => menuItem('New tab').click());
    await settle();
    expect(location).toMatch(/^\/chat\/agents\?tab=/);
    expect(groups()).toEqual([['No space', ['New tab', 'boss', 'kid', 'solo']]]);
    expect(host.querySelector('.chat-title-name')!.textContent).toBe('New tab');
    expect([...host.querySelectorAll('.nt-list .nt-name')].map(n => n.textContent)).toEqual(['boss', 'kid', 'solo']);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('Agents');
    expect(panelNames()).toEqual(['boss', 'solo']);
    expect(host.querySelector('.fx-dir, .fx-file:not(.fx-agent)')).toBeNull();
    // Shown until its starter is folded, as in a space's explorer.
    expect(panelRow('kid').closest('.fx-children')).not.toBeNull();
  });

  it('finds a session started elsewhere, which is no tab yet, and opens it as a tab in the new tab', async () => {
    await render('/chat/agents?tab=e1');
    act(() => root.unmount());
    root = createRoot(host);
    mocks.projects = [...mocks.projects, project('late', '2026-10-21T00:00:00Z')];
    await render('/chat/agents?tab=e1');
    expect(groups()[0][1]).not.toContain('late');
    act(() => panelRow('late').click());
    await settle();
    expect(location).toBe('/chat/p/late?tab=e1');
    expect(groups()[0][1][0]).toBe('late');
    expect(host.querySelector('.chat-item.active .chat-item-name')!.textContent).toBe('late');
  });

  it('keeps every agent in Agents for someone with no spaces while a new box\'s spaces reload', async () => {
    await render('/chat/agents?tab=e1');
    expect(panelNames()).toEqual(['boss', 'solo']);
    mocks.projects = [...mocks.projects, { ...project('late', '2026-10-21T00:00:00Z'), instanceId: 'box-new' } as Project];
    mocks.current = false;
    try {
      await render('/chat/agents?tab=e1');
      expect(panelNames()).toEqual(['boss', 'late', 'solo']);
      expect([...host.querySelectorAll('.nt-list .nt-name')].map(n => n.textContent)).toContain('boss');
    } finally {
      mocks.current = null;
    }
  });

  it('keeps the agents in no space, and leaves out only the new box, while a new box\'s spaces reload for someone with spaces', async () => {
    mocks.list = [space('notes')];
    mocks.index = new Map([['box-boss', ['notes']]]);
    await render('/chat/agents?tab=e1');
    expect(panelNames()).toEqual(['kid', 'solo']);
    mocks.projects = [...mocks.projects, { ...project('fresh', '2026-10-21T00:00:00Z'), instanceId: 'box-fresh' } as Project];
    mocks.current = false;
    try {
      await render('/chat/agents?tab=e1');
      expect(panelNames()).toEqual(['kid', 'solo']);
      // The reload has it in notes: still not in Agents.
      mocks.index = new Map([['box-boss', ['notes']], ['box-fresh', ['notes']]]);
      mocks.current = null;
      await render('/chat/agents?tab=e1');
      expect(panelNames()).toEqual(['kid', 'solo']);
    } finally {
      mocks.current = null;
    }
  });

  it('knows the boxes in no space from the sidebar alone, when Agents first opens during a reload', async () => {
    mocks.list = [space('notes')];
    mocks.projects = [project('p-in', '2026-10-20T00:00:00Z'), project('p-out', '2026-10-19T00:00:00Z')];
    mocks.index = new Map([['box-p-in', ['notes']]]);
    mocks.links = [];
    await render('/chat');
    act(() => root.unmount());
    root = createRoot(host);
    mocks.projects = [...mocks.projects, project('p-new', '2026-10-21T00:00:00Z')];
    mocks.current = false;
    try {
      await render('/chat/agents?tab=e1');
      expect(panelNames()).toEqual(['p-out']);
    } finally {
      mocks.current = null;
    }
  });

  it('is the Agents tab beside an agent with no space, for someone with spaces too, listing only the agents in no space', async () => {
    mocks.list = [space('notes')];
    mocks.index = new Map([['box-boss', ['notes']]]);
    await render('/chat/p/solo');
    expect(host.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('Agents');
    expect(host.querySelector('.fx-panel-title')!.textContent).toBe('No space');
    expect(panelNames()).toEqual(['kid', 'solo']);
    expect(panelRow('solo').classList.contains('active')).toBe(true);
  });

  it('leaves a space\'s explorer as it was for someone with spaces', async () => {
    mocks.list = [space('notes')];
    mocks.index = new Map([['box-boss', ['notes']], ['box-kid', ['notes']]]);
    mocks.tree = null;
    await render('/chat/files/notes?tab=e1');
    expect(host.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('Files');
    expect(host.querySelector('.fx-panel-title')!.textContent).toBe('notes');
    expect(host.querySelector('.fx-panel')!.textContent).not.toContain('solo');
  });
});

describe('the explorer', () => {
  /** Since the last mark, no commit showed an order without the tab `name` highlighted once it was on top. */
  const firstCommitShows = (from: number, name: string) => {
    const after = commits.slice(from).filter(c => c.order[0] === name);
    expect(after.length).toBeGreaterThan(0);
    expect(after.map(c => c.active)).toEqual(after.map(() => name));
    expect(commits.slice(from).every(c => c.active !== null)).toBe(true);
  };

  beforeEach(() => {
    mocks.spaces = true;
    mocks.list = [space('notes'), space('design')];
    mocks.projects = [project('boss', '2026-10-20T00:00:00Z'), project('kid', '2026-10-19T00:00:00Z'), project('far', '2026-10-18T00:00:00Z')];
    mocks.index = new Map([['box-boss', ['notes']], ['box-kid', ['notes']], ['box-far', ['design']]]);
    mocks.links = [{ projectId: 'kid', workstream: 'main', parentProjectId: 'boss', parentWorkstream: 'main' }];
  });

  // The person on #743: an untitled ask's tab shows its thread id, nothing derived.
  it('names an untitled ask tab by its thread id, a titled one by its title', async () => {
    mocks.projects = [
      { ...project('boss', '2026-10-20T00:00:00Z'), workstreams: [{ id: 'm', name: 'main', archived: false }] },
      { ...project('kid', '2026-10-19T00:00:00Z'), workstreams: [{ id: 'a1', name: 'ask-cmvpvqxse19rwex4apfh334ld', archived: false, askThread: { id: 'cmvpvqxse19rwex4apfh334ld', title: null, parentProjectId: 'boss', parentWorkstream: 'main' } }] },
      { ...project('far', '2026-10-18T00:00:00Z'), workstreams: [{ id: 'a2', name: 'ask-cmvpvqyum19sbex4axk6m62o8', archived: false, askThread: { id: 'cmvpvqyum19sbex4axk6m62o8', title: 'Members-only file composer (#765)', parentProjectId: 'boss', parentWorkstream: 'main' } }] },
    ] as unknown as Project[];
    mocks.index = new Map([['box-boss', ['notes']], ['box-kid', ['notes']], ['box-far', ['notes']]]);
    await render('/chat');
    const names = [...host.querySelectorAll('.chat-item-name')].map(n => n.textContent);
    expect(names).toContain('ask-cmvpvqxse19rwex4apfh334ld');
    expect(names).toContain('Members-only file composer (#765)');
  });

  // The person on #743: a nested tab is the same one-line row as any tab (icon and name), indented.
  it('shows a nested agent as the same one-line tab, indented', async () => {
    await render('/chat');
    const li = (name: string) => tab(name).closest('li')!;
    expect(li('kid').style.getPropertyValue('--chat-depth')).toBe('1');
    for (const name of ['boss', 'kid']) {
      expect(li(name).querySelectorAll('.chat-item')).toHaveLength(1);
      expect(li(name).querySelector('.chat-row-state, .chat-row-msg, .chat-row-where')).toBeNull();
      expect([...li(name).querySelector('.chat-item')!.children].map(c => c.className)).toEqual(
        [expect.stringContaining('chat-agent-icon'), 'chat-item-name', 'chat-sr']);
    }
  });

  // Bugbot on #743: a parent folded in storage stays open while its child is the open tab;
  // its caret must say what is shown (open), not what is stored.
  it("a folded parent kept open for the open child's tab shows as open", async () => {
    localStorage.setItem('termag.chat.foldedAgents', JSON.stringify(['boss|main']));
    await render('/chat/p/kid');
    const twisty = host.querySelector<HTMLButtonElement>('.chat-items .chat-twisty')!;
    expect(tab('kid')).toBeDefined();
    expect(twisty.getAttribute('aria-expanded')).toBe('true');
    expect(twisty.getAttribute('data-tip')).not.toContain('folded');
  });

  it('lists the space\'s agents beside its files, a subagent under the agent that started it, and no agent from elsewhere', async () => {
    await render('/chat/files/notes?tab=e1');
    const names = () => [...host.querySelectorAll('.fx-panel .fx-tree > li > .fx-row .fx-name, .fx-panel .fx-tree > li > a.fx-row .fx-name')].map(n => n.textContent);
    expect(names()).toEqual(['boss', 'docs', 'README.md']);
    expect(panelRow('boss').querySelector('.chat-agent-icon')).not.toBeNull();
    // A subagent shows under its starter from the start, and folds away with it.
    expect(panelRow('kid').closest('.fx-children')).not.toBeNull();
    const twisty = host.querySelector<HTMLButtonElement>('.fx-twisty')!;
    expect(twisty.getAttribute('aria-label')).toBe('Hide the agents boss started');
    act(() => twisty.click());
    expect(host.querySelector('.fx-panel .fx-children')).toBeNull();
    act(() => twisty.click());
    expect(panelRow('kid').closest('.fx-children')).not.toBeNull();
    expect(host.querySelector('.fx-panel')!.textContent).not.toContain('far');
    expect(host.querySelector('.chat-title-name')!.textContent).toBe('New tab');
  });

  it('keeps a Refresh\'s listing when a listing from before it arrives later', async () => {
    mocks.list = [space('fresh')];
    mocks.index = new Map([['box-boss', ['fresh']]]);
    const replies: Array<(t: SpaceTree) => void> = [];
    mocks.tree = () => new Promise<SpaceTree>(r => { replies.push(r); });
    const listing = (name: string): SpaceTree => ({ prefix: '', nextCursor: null, dirs: [], files: [{ name, path: name, size: 1, modifiedAt: null }] });
    try {
      await render('/chat/files/fresh?tab=e1');
      act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Refresh fresh"]')!.click());
      await settle();
      expect(replies).toHaveLength(2);
      await act(async () => { replies[1](listing('new.md')); });
      await act(async () => { replies[0](listing('old.md')); });
      await settle();
      expect(panelRow('new.md')).toBeDefined();
      expect(panelRow('old.md')).toBeUndefined();
    } finally {
      mocks.tree = null;
    }
  });

  it('shows a pick instead of the new tab it came from, opens a tab for the next, and goes back to a file\'s tab on top', async () => {
    const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    await render('/chat/files/notes?tab=e1');
    expect(groups()).toContainEqual(['notes', ['New tab', 'boss', 'kid']]);
    click(panelRow('README.md'));
    await settle();
    expect(location).toBe('/chat/f/notes/README.md?tab=e1');
    expect(groups()).toContainEqual(['notes', ['README.md', 'boss', 'kid']]);
    expect(stored().items.filter(i => i.id === 'e1')).toEqual([expect.objectContaining({ kind: 'file', path: 'README.md' })]);
    if (panelRow('docs').getAttribute('aria-expanded') !== 'true') act(() => panelRow('docs').click());
    await settle();
    const fresh = nextTabId();
    click(panelRow('q3.pdf'));
    await settle();
    expect(location).toBe(`/chat/f/notes/docs/q3.pdf?tab=${fresh}`);
    expect(groups()).toContainEqual(['notes', ['q3.pdf', 'README.md', 'boss', 'kid']]);
    click(panelRow('README.md'));
    await settle();
    expect(location).toBe('/chat/f/notes/README.md?tab=e1');
    expect(groups()).toContainEqual(['notes', ['README.md', 'q3.pdf', 'boss', 'kid']]);
  });

  it('moves a picked tab to the top and highlights it in the same commit', async () => {
    const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    await render('/chat/files/notes?tab=e1');
    click(panelRow('README.md'));
    await settle();
    if (panelRow('docs').getAttribute('aria-expanded') !== 'true') act(() => panelRow('docs').click());
    await settle();
    let mark = commits.length;
    click(panelRow('q3.pdf'));
    await settle();
    firstCommitShows(mark, 'q3.pdf');
    mark = commits.length;
    click(panelRow('README.md'));
    await settle();
    firstCommitShows(mark, 'README.md');
    mark = commits.length;
    act(() => tab('q3.pdf').focus());
    key(tab('q3.pdf'), 'F10', { shiftKey: true });
    act(() => menuItem('Duplicate tab').click());
    await settle();
    expect(commits.slice(mark).every(c => c.active !== null)).toBe(true);
    mark = commits.length;
    openMenu('notes');
    act(() => menuItem('New tab').click());
    await settle();
    firstCommitShows(mark, 'New tab');
    mark = commits.length;
    act(() => tab('New tab').focus());
    key(tab('New tab'), 'F10', { shiftKey: true });
    act(() => menuItem('Close tab').click());
    await settle();
    expect(commits.slice(mark).length).toBeGreaterThan(0);
    expect(commits.slice(mark).every(c => c.active !== null && !c.order.includes('New tab'))).toBe(true);
  });

  it('keeps a tab moved by hand where it is on sidebar clicks, until the explorer opens it again', async () => {
    const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    await render('/chat/files/notes?tab=e1');
    click(panelRow('README.md'));
    await settle();
    expect(groups()).toContainEqual(['notes', ['README.md', 'boss', 'kid']]);
    act(() => tab('README.md').focus());
    key(tab('README.md'), 'ArrowDown', { altKey: true });
    key(tab('README.md'), 'ArrowDown', { altKey: true });
    expect(groups()).toContainEqual(['notes', ['boss', 'kid', 'README.md']]);
    click(tab('boss'));
    await settle();
    click(tab('README.md'));
    await settle();
    expect(location).toBe('/chat/f/notes/README.md?tab=e1');
    expect(groups()).toContainEqual(['notes', ['boss', 'kid', 'README.md']]);
    click(panelRow('README.md'));
    await settle();
    expect(groups()).toContainEqual(['notes', ['README.md', 'boss', 'kid']]);
  });

  it('opens an item in a new tab from its menu, leaving this tab as it is', async () => {
    await render('/chat/files/notes?tab=e1');
    act(() => panelRow('README.md').focus());
    key(panelRow('README.md'), 'ContextMenu');
    expect(menuLabels()).toEqual(['Open', 'Open in new tab', 'Open in new browser tab']);
    const fresh = nextTabId();
    act(() => menuItem('Open in new tab').click());
    await settle();
    expect(groups()).toContainEqual(['notes', ['README.md', 'New tab', 'boss', 'kid']]);
    expect(location).toBe(`/chat/f/notes/README.md?tab=${fresh}`);
    expect(stored().items.find(i => i.id === 'e1')).toMatchObject({ kind: 'explorer', space: 'notes' });
  });

  it('opens an item\'s menu from its ⋮ without opening the item, the same menu as a right click', async () => {
    await render('/chat/files/notes?tab=e1');
    tap(dots('README.md'));
    expect(location).toBe('/chat/files/notes?tab=e1');
    expect(dots('README.md').getAttribute('aria-expanded')).toBe('true');
    expect(menuLabels()).toEqual(['Open', 'Open in new tab', 'Open in new browser tab']);
    key(document.activeElement!, 'Escape');
    rightClick(panelRow('README.md'));
    expect(menuLabels()).toEqual(['Open', 'Open in new tab', 'Open in new browser tab']);
    key(document.activeElement!, 'Escape');
    expect(dots('boss')).not.toBeNull();
    expect(host.querySelector('.fx-dir + .item-menu-btn')).toBeNull();
  });

  it('closes a menu on a press outside it without opening what was pressed', async () => {
    await render('/chat/files/notes?tab=e1');
    rightClick(panelRow('README.md'));
    const docs = panelRow('docs');
    const was = docs.getAttribute('aria-expanded');
    // Outside the menu, a press lands on the popover's underlay, which covers the page, so nothing under it gets the click.
    const underlay = document.querySelector('[data-testid=underlay]')!;
    act(() => { for (const type of ['mousedown', 'mouseup', 'click']) underlay.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, detail: 1 })); });
    await settle();
    expect(document.querySelector('.chat-ctx-menu')).toBeNull();
    expect(docs.getAttribute('aria-expanded')).toBe(was);
    expect(location).toBe('/chat/files/notes?tab=e1');
    act(() => docs.click());
    expect(docs.getAttribute('aria-expanded')).not.toBe(was);
  });

  it('opens a chat of another space from this space\'s explorer in a tab of its own space, and scrolls the sidebar there (plan-outbox #38)', async () => {
    const scrolled: string[] = [];
    const was = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.querySelector('.chat-item-name')?.textContent ?? ''); };
    try {
      // `far2`'s box reaches notes too, so notes' explorer lists it; the chat belongs to design.
      mocks.projects = [...mocks.projects, fixedTo(project('far2', '2026-10-17T00:00:00Z'), 'id-design')];
      mocks.index = new Map([...mocks.index, ['box-far2', ['notes', 'design']]]);
      await render('/chat/files/notes?tab=e1');
      act(() => { panelRow('far2').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
      await settle();
      expect(location).toMatch(/^\/chat\/p\/far2\?tab=/);
      const design = groups().find(g => g[0] === 'design')!;
      expect(design[1]).toContain('far2');
      // The New tab it was picked from stays notes', as it was.
      expect(groups().find(g => g[0] === 'notes')![1]).toContain('New tab');
      expect(groups().find(g => g[0] === 'notes')![1]).not.toContain('far2');
      expect(scrolled).toContain('far2');
    } finally {
      Element.prototype.scrollIntoView = was;
    }
  });

  describe('an agent in no space of its own, that this space\'s explorer lists', () => {
    // Ask threads the server fixed to "No space" (their box was granted notes after their first use).
    const click = (name: string) => act(() => { panelRow(name).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    const groupOf = (name: string) => groups().find(g => (g[1] as string[]).includes(name))?.[0];
    beforeEach(() => {
      mocks.projects = [...mocks.projects, fixedTo(project('ask1', '2026-10-17T00:00:00Z'), null), fixedTo(project('ask2', '2026-10-16T00:00:00Z'), null)];
      mocks.index = new Map([...mocks.index, ['box-ask1', ['notes']], ['box-ask2', ['notes']]]);
      localStorage.setItem(openItemsKey('u1'), JSON.stringify({ v: 2, seeded: true, items: [] }));
    });

    it('opens under this space, in the new tab it was picked from or a tab of its own, with this space\'s Files beside it', async () => {
      await render('/chat/files/notes?tab=e1');
      click('ask1');
      await settle();
      expect(location).toBe('/chat/p/ask1?tab=e1');
      click('ask2');
      await settle();
      expect(groups()).toEqual([['design', []], ['notes', ['ask2', 'ask1']]]);
      expect(host.querySelector('.fx-panel')!.getAttribute('aria-label')).toBe('Explorer for notes');
    });

    it('stays under No space when opened from No space\'s explorer, and opening it again from a space moves no tab', async () => {
      await render('/chat/agents?tab=a1');
      click('ask1');
      await settle();
      expect(groupOf('ask1')).toBe('No space');
      act(() => root.unmount());
      root = createRoot(host);
      await render('/chat/files/notes?tab=e1');
      click('ask1');
      await settle();
      expect(location).toBe('/chat/p/ask1?tab=a1');
      expect(groupOf('ask1')).toBe('No space');
      // And the other way round: one opened in notes stays there when No space's explorer opens it.
      act(() => root.unmount());
      root = createRoot(host);
      await render('/chat/files/notes?tab=e2');
      click('ask2');
      await settle();
      expect(groupOf('ask2')).toBe('notes');
      act(() => root.unmount());
      root = createRoot(host);
      await render('/chat/agents?tab=a2');
      click('ask2');
      await settle();
      expect(groupOf('ask2')).toBe('notes');
    });

    it('moves a tab from before to the one space whose explorer lists it on load, and leaves one two spaces list', async () => {
      mocks.index = new Map([...mocks.index, ['box-ask2', ['notes', 'design']]]);
      localStorage.setItem(openItemsKey('u1'), JSON.stringify({ v: 2, seeded: true, items: [
        { kind: 'chat', projectId: 'ask1', workstream: 'main', id: 'o1', openedAt: 2 },
        { kind: 'chat', projectId: 'ask2', workstream: 'main', id: 'o2', openedAt: 1 },
      ] }));
      await render();
      expect(groups()).toEqual([['design', []], ['notes', ['ask1']], ['No space', ['ask2']]]);
      expect(stored().items.map(i => [i.id, (i as { openedIn?: string | null }).openedIn])).toEqual([['o1', 'notes'], ['o2', null]]);
      // Placed once: a grant that leaves notes the only space for ask2 moves it no more.
      mocks.index = new Map([...mocks.index, ['box-ask2', ['notes']]]);
      act(() => root.unmount());
      root = createRoot(host);
      await render();
      expect(groupOf('ask2')).toBe('No space');
    });
  });

  it('goes to an agent\'s tab from the explorer without moving it, the explorer beside it with the agent highlighted and its starter open', async () => {
    await render('/chat/files/notes?tab=e1');
    const tabOf = (projectId: string) => stored().items.find(i => i.kind === 'chat' && (i as { projectId?: string }).projectId === projectId)!.id;
    const twisty = host.querySelector<HTMLButtonElement>('.fx-twisty')!;
    if (twisty.getAttribute('aria-expanded') !== 'true') act(() => twisty.click());
    act(() => { panelRow('kid').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    await settle();
    expect(location).toBe(`/chat/p/kid?tab=${tabOf('kid')}`);
    expect(groups()).toContainEqual(['notes', ['New tab', 'boss', 'kid']]);
    expect(host.querySelector('[data-testid=chat]')).not.toBeNull();
    expect(host.querySelector('.fx-panel')!.getAttribute('aria-label')).toBe('Explorer for notes');
    expect(panelRow('kid').getAttribute('aria-current')).toBe('page');
    expect(panelRow('kid').closest('.fx-children')).not.toBeNull();
    act(() => { panelRow('boss').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    await settle();
    expect(location).toBe(`/chat/p/boss?tab=${tabOf('boss')}`);
    expect(panelRow('boss').getAttribute('aria-current')).toBe('page');
    expect(groups()).toContainEqual(['notes', ['New tab', 'boss', 'kid']]);
  });

  it('shows Files on an agent\'s box\'s space when it was opened from the sidebar, and no column beside the chat', async () => {
    await render('/chat/p/boss');
    expect(host.querySelector('[data-testid=chat]')).not.toBeNull();
    expect(host.querySelectorAll('.fx-panel')).toHaveLength(1);
    expect(host.querySelector('.fx-panel')!.closest('#chat-side-panel')).not.toBeNull();
    expect(host.querySelector('.fx-panel')!.getAttribute('aria-label')).toBe('Explorer for notes');
  });

  it('searches agents and files together', async () => {
    await render('/chat/files/notes?tab=e1');
    const input = host.querySelector<HTMLInputElement>('.fx-search input')!;
    expect(input.placeholder).toBe('Search agents and files');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'kid');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    const hits = [...host.querySelectorAll('.fx-hit')];
    expect(hits.map(h => h.querySelector('.fx-name')!.textContent)).toEqual(['kid']);
    expect(hits[0].querySelector('.fx-where')!.textContent).toBe('under boss');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'far');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect(host.querySelectorAll('.fx-hit')).toHaveLength(0);
  });

  it('a viewer can\'t start agents in a space', async () => {
    mocks.list = [space('notes', 'viewer')];
    await render('/chat/files/notes?tab=e1');
    openMenu('notes');
    expect(menuItem('New agent').getAttribute('aria-disabled') === 'true').toBe(true);
    expect(menuItem('New agent').textContent).toContain("You can't start agents in notes");
    expect(menuItem('New tab').getAttribute('aria-disabled') === 'true').toBe(false);
  });

  describe('sharing a space', () => {
    beforeEach(() => {
      mocks.projects = [project('a', '2026-10-20T00:00:00Z'), project('loose', '2026-10-19T00:00:00Z')];
      mocks.list = [space('notes'), space('assets', 'viewer')];
      mocks.index = new Map([['box-a', ['notes']]]);
    });

    const hints = () => [...document.querySelectorAll('.chat-ctx-menu [role=menuitem]')].map(b => [b.querySelector('.chat-add-label')!.textContent, b.querySelector('.chat-add-hint')?.textContent ?? null, b.getAttribute('aria-disabled') === 'true']);

    it('puts Share space third in the space head\'s ⋮ menu, between New tab and the tab actions', async () => {
      mocks.members.mockResolvedValue({ members: [{ userId: 'u1', email: 'ada@example.com', displayName: 'Ada', role: 'owner', addedAt: '' }], invites: [] });
      await render();
      act(() => dots('notes').click());
      expect(menuLabels()).toEqual(['New agent', 'New tab', 'Share space', 'Close all tabs', 'Close file tabs']);
      expect(hints()[2]).toEqual(['Share space', 'People and boxes with access to notes', false]);
      act(() => menuItem('Share space').click());
      await settle();
      const dialog = document.querySelector('.chat-share-dialog')!;
      expect(dialog.querySelector('.chat-share-title')!.textContent).toBe('Share notes');
      expect(dialog.querySelector<HTMLInputElement>('.chat-share-link input')!.value).toBe(`${window.location.origin}/chat/files/notes`);
    });

    it('opens the same five items from a right click on the head; no other share control', async () => {
      await render();
      const head = host.querySelector('.chat-group[data-group="notes"] .chat-group-head')!;
      rightClick(head);
      expect(menuLabels()).toEqual(['New agent', 'New tab', 'Share space', 'Close all tabs', 'Close file tabs']);
      expect([...head.querySelectorAll('button')].filter(b => /share/i.test(`${b.textContent} ${b.getAttribute('aria-label') ?? ''}`))).toEqual([]);
    });

    it('keeps Share space for a viewer, with New agent disabled and why', async () => {
      await render();
      act(() => dots('assets').click());
      expect(hints().slice(0, 3)).toEqual([
        ['New agent', 'You can\'t start agents in assets', true],
        ['New tab', 'Browse assets\'s agents and files', false],
        ['Share space', 'People and boxes with access to assets', false],
      ]);
    });

    it('has no Share space for "No space"', async () => {
      await render();
      act(() => dots('No space').click());
      expect(menuLabels()).not.toContain('Share space');
    });

    it('marks no space as shared: a shared space\'s head is its name, fold toggle and ⋮ only', async () => {
      mocks.list = [{ ...space('notes'), memberCount: 3 }, { ...space('assets', 'viewer'), memberCount: 2 }];
      await render();
      for (const name of ['notes', 'assets']) {
        const toggle = host.querySelector(`.chat-group[data-group="${name}"] .chat-group-toggle`)!;
        expect(toggle.querySelector('.chat-group-shared, [role="img"], svg:not(.chat-group-caret)')).toBeNull();
        expect(toggle.textContent).toBe(name);
        expect(toggle.getAttribute('data-tip')).toBe(`Fold ${name}`);
      }
      expect(host.textContent).not.toMatch(/Shared with/);
    });
  });
});


describe('closing the open tab goes back to the tab shown before it', () => {
  beforeEach(() => {
    mocks.spaces = true;
    mocks.list = [space('notes')];
    mocks.projects = [project('a', '2026-10-20T00:00:00Z'), project('b', '2026-10-10T00:00:00Z')];
    mocks.index = new Map([['box-a', ['notes']], ['box-b', ['notes']]]);
    mocks.links = [];
    localStorage.setItem(openItemsKey('u1'), JSON.stringify({ v: 2, seeded: true, items: [
      { kind: 'file', space: 'notes', path: 'README.md', id: 'tf', openedAt: 3 },
      { kind: 'chat', projectId: 'a', workstream: 'main', id: 'ta', openedAt: 2 },
      { kind: 'chat', projectId: 'b', workstream: 'main', id: 'tb', openedAt: 1 },
    ] }));
  });
  const headerBack = () => host.querySelector<HTMLButtonElement>('header.chat-header button.chat-page-back')!;

  it('is a back arrow, the first control of the header, before its title, named Close and go back', async () => {
    await render('/chat/f/notes/README.md?tab=tf');
    const back = headerBack();
    const header = back.closest('header')!;
    expect(header.firstElementChild).toBe(back);
    expect(back.compareDocumentPosition(header.querySelector('.chat-title')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(back.getAttribute('aria-label')).toBe('Close and go back');
    expect(back.getAttribute('data-tip')).toBe('Close and go back');
    expect(back.getAttribute('aria-keyshortcuts')).toBeNull();
    // No X in the actions any more.
    expect(header.querySelector('.chat-header-actions .chat-page-close, .chat-header-actions .chat-page-back')).toBeNull();
  });

  it('is the same button as Reload in the header: the element, its classes but Reload\'s own, and a 14px icon', async () => {
    await render('/chat/f/notes/README.md?tab=tf');
    const back = headerBack();
    const reload = host.querySelector<HTMLButtonElement>('header.chat-header button.fv-reload')!;
    expect(back.tagName).toBe(reload.tagName);
    const classes = (b: Element, own: string) => [...b.classList].filter(c => c !== own).sort();
    expect(classes(back, 'chat-page-back')).toEqual(classes(reload, 'fv-reload'));
    const icon = (b: Element) => b.querySelector('svg')!;
    for (const a of ['width', 'height', 'viewBox']) expect(icon(back).getAttribute(a)).toBe(icon(reload).getAttribute(a));
    expect(back.childElementCount).toBe(1);
  });

  it.each([['a space\'s explorer', '/chat/files/notes'], ['No space\'s explorer', '/chat/agents']])('is the first control of %s\'s header too, before its title', async (_name, path) => {
    await render(path);
    const back = headerBack();
    expect(back.closest('header')!.firstElementChild).toBe(back);
    expect(back.nextElementSibling!.classList.contains('chat-title')).toBe(true);
    expect([...back.classList].sort()).toEqual(['btn-ghost', 'chat-page-back', 'fv-icon-btn']);
  });

  it('closes a space file\'s tab and goes back to the chat tab shown before it, not the next in its space', async () => {
    await render('/chat/p/b?tab=tb');
    act(() => tab('README.md').click());
    await settle();
    expect(location).toBe('/chat/f/notes/README.md?tab=tf');
    act(() => headerBack().click());
    await settle();
    expect(location).toBe('/chat/p/b?tab=tb');
    expect(groups()).toContainEqual(['notes', ['a', 'b']]);
    expect(stored().items.map(i => i.id)).toEqual(['ta', 'tb']);
  });

  it('goes back past a tab closed since', async () => {
    await render('/chat/p/b?tab=tb');
    act(() => tab('a').click());
    await settle();
    act(() => tab('README.md').click());
    await settle();
    act(() => close('a').click());
    await settle();
    act(() => headerBack().click());
    await settle();
    expect(location).toBe('/chat/p/b?tab=tb');
  });

  it('closed from the sidebar\'s X, goes back to the tab shown before it too', async () => {
    await render('/chat/p/b?tab=tb');
    act(() => tab('README.md').click());
    await settle();
    act(() => close('README.md').click());
    await settle();
    expect(location).toBe('/chat/p/b?tab=tb');
    expect(stored().items.map(i => i.id)).toEqual(['ta', 'tb']);
  });

  it('closed from the tab\'s menu, Close tab goes back to the tab shown before it too', async () => {
    await render('/chat/p/b?tab=tb');
    act(() => tab('README.md').click());
    await settle();
    rightClick(tab('README.md'));
    act(() => menuItem('Close tab').click());
    await settle();
    expect(location).toBe('/chat/p/b?tab=tb');
  });

  it('goes back to an open review session, which is in Reviews rather than its space', async () => {
    mocks.projects = [...mocks.projects, project('r', '2026-10-05T00:00:00Z')];
    mocks.index = new Map([...mocks.index, ['box-r', ['notes']]]);
    mocks.reviewKeys = new Set([inboxRowKey('r', 'main')]);
    const raw = JSON.parse(localStorage.getItem(openItemsKey('u1'))!) as { items: unknown[] };
    localStorage.setItem(openItemsKey('u1'), JSON.stringify({ ...raw, items: [...raw.items, { kind: 'chat', projectId: 'r', workstream: 'main', id: 'tr', openedAt: 0 }] }));
    try {
      await render('/chat/p/r?tab=tr');
      act(() => tab('README.md').click());
      await settle();
      act(() => headerBack().click());
      await settle();
      expect(location).toBe('/chat/p/r?tab=tr');
    } finally {
      mocks.reviewKeys = new Set();
    }
  });

  it('with no tab shown before, goes where the tab strip\'s X goes: the first left in its space', async () => {
    await render('/chat/f/notes/README.md?tab=tf');
    act(() => headerBack().click());
    await settle();
    expect(location).toBe('/chat/p/a?tab=ta');
  });

  it('is on a space\'s explorer tab too, and closes it', async () => {
    await render('/chat/p/b?tab=tb');
    act(() => groupDots('notes').click());
    act(() => menuItem('New tab').click());
    await settle();
    expect(location).toMatch(/^\/chat\/files\/notes\?tab=/);
    act(() => headerBack().click());
    await settle();
    expect(location).toBe('/chat/p/b?tab=tb');
    expect(stored().items.some(i => i.kind === 'explorer')).toBe(false);
  });
});
