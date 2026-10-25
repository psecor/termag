// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useMatch } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceTree } from '../../services/api';
import type { Project } from '../../types';
import { openItemsKey } from '../../chat/openItems';
import { spaceColor } from '../../chat/spaceColors';
import { ChatSidebar } from './ChatSidebar';
import { FileExplorer } from './FileExplorer';
import { SpaceFileView } from './SpaceFileView';
import { ChatRoute } from './ChatRoute';
import { SidePanel } from './SidePanel';
import { SimpleDataProvider } from './simpleData';

function project(id: string, lastActiveAt: string): Project {
  return {
    id, name: id, instanceId: `box-${id}`, archived: false, pinned: false, lastActiveAt,
    workflows: [{ type: 'agent' }], workstreams: [],
  } as unknown as Project;
}

const TREE: Record<string, SpaceTree> = {
  '': { prefix: '', nextCursor: null, dirs: [{ name: 'docs', path: 'docs/' }], files: [{ name: 'README.md', path: 'README.md', size: 1, modifiedAt: null }] },
  'docs/': { prefix: 'docs/', nextCursor: null, dirs: [], files: [{ name: 'q3.pdf', path: 'docs/q3.pdf', size: 1, modifiedAt: null }] },
};

const mocks = vi.hoisted(() => ({
  projects: [] as Project[],
  spaces: true,
  spacesLoaded: true,
  list: [] as Array<{ id: string; name: string; role: string; readOnly: boolean }>,
  index: new Map<string, string[]>(),
  links: [] as Array<{ projectId: string; workstream: string; parentProjectId: string; parentWorkstream: string }>,
  open: vi.fn(),
  tree: null as null | ((space: string, prefix: string) => Promise<SpaceTree>),
  titles: false,
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', unixUsername: 'ada' } }) }));
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ projects: mocks.projects, projectsLoaded: true, statusMap: {} }) }));
vi.mock('../../chat/useChatSpaces', () => ({
  useSharedChatSpaces: () => ({ enabled: mocks.spaces, loaded: mocks.spacesLoaded, current: mocks.spacesLoaded, spaces: mocks.spaces && mocks.spacesLoaded ? mocks.list : [], index: mocks.index, colorOf: spaceColor }),
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
    },
    spawnsApi: { ...actual.spawnsApi, parents: async () => ({ links: mocks.links }) },
  };
});
vi.mock('./SdkChatView', () => ({ SdkChatView: () => <section className="chat-conv" data-testid="chat" /> }));
vi.mock('./ChatView', () => ({ ChatView: () => <section className="chat-conv" data-testid="chat" /> }));
vi.mock('../../services/spaceTransfer', () => ({ downloadFile: vi.fn(), errorMessage: (_e: unknown, f: string) => f }));
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return {
    ...actual,
    useFlag: <T,>(key: string, fallback: T) => (key === 'simple-ui-side-panel-enabled' ? true as T : key === 'simple-ui-session-titles-enabled' ? mocks.titles as T : fallback),
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

/** The side panel open on Files, given what ChatApp gives it for the route. */
function FilesPanel() {
  const file = useMatch('/chat/f/:space/*');
  const newTab = useMatch('/chat/files/:space');
  const chat = useMatch('/chat/p/:projectId');
  const project = chat ? mocks.projects.find(p => p.id === chat.params.projectId) : undefined;
  const files = project ? { agent: project } : (file ?? newTab) ? { space: (file ?? newTab)!.params.space!, path: file?.params['*'] } : null;
  if (!files) return null;
  return <SidePanel project={project} workstream="main" files={files} state={{ open: true, tab: 'files', width: 480 }} onChange={() => {}} onClose={() => {}} overlay={false} />;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  document.body.querySelectorAll('.chat-add-menu').forEach(m => m.remove());
  vi.unstubAllGlobals();
});

const space = (name: string, role = 'owner') => ({ id: `id-${name}`, name, role, readOnly: false });
const groups = () => [...host.querySelectorAll('.chat-group')].map(g => [
  g.querySelector('.chat-group-name')!.textContent,
  [...g.querySelectorAll('.chat-item-name')].map(n => n.textContent),
]);
const settle = () => act(async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)); });
async function render(path = '/chat') {
  await act(async () => root.render(
    <MemoryRouter initialEntries={[path]}>
      <SimpleDataProvider>
        <ChatSidebar />
        <Routes>
          <Route path="/chat/files/:space" element={<FileExplorer />} />
          <Route path="/chat/f/:space/*" element={<SpaceFileView />} />
          <Route path="/chat/p/:projectId" element={<ChatRoute />} />
          <Route path="*" element={null} />
        </Routes>
        <FilesPanel />
        <Probe />
      </SimpleDataProvider>
    </MemoryRouter>,
  ));
  await settle();
}
const openMenu = (name: string) => act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="New in ${name}"]`)!.click());
const menuLabels = () => [...document.querySelectorAll('.chat-add-menu .chat-add-label')].map(n => n.textContent);
const menuItem = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.chat-add-menu [role=menuitem]')].find(b => b.textContent?.startsWith(label))!;
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
    expect(start.firstChild?.textContent).toBe('New session');
    // The shortcut is in the title too, for when its chip doesn't fit beside the label.
    expect(start.getAttribute('title')).toMatch(/^New session \((Ctrl\+Shift\+O|⌘⇧O)\)$/);
    expect(start.getAttribute('href')).toBe('/chat/new');
    expect(host.querySelector('button[aria-label="New in No space"]')).toBeNull();
    expect(stored().items.every(i => /^[a-z0-9]+$/.test(i.id))).toBe(true);
  });

  it('offers New agent and New tab on each space\'s +; every New tab is another tab on top', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z')];
    await render();
    openMenu('notes');
    expect(menuLabels()).toEqual(['New agent', 'New tab']);
    expect(menuItem('New agent').disabled).toBe(false);
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
    expect(host.querySelector('.chat-item-x, button[aria-label="Close a"]')).toBeNull();
    rightClick(item);
    const viaRightClick = menuLabels();
    key(document.activeElement!, 'Escape');
    expect(dots('a').getAttribute('aria-haspopup')).toBe('menu');
    expect(dots('a').getAttribute('aria-expanded')).toBe('false');
    act(() => dots('a').click());
    expect(dots('a').getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.chat-ctx-menu')!.getAttribute('aria-label')).toBe('a');
    expect(menuLabels()).toEqual(viaRightClick);
    expect(menuLabels()).toEqual(['Duplicate tab', 'Open in new browser tab', 'Close tab']);
    expect(location).toBe('/chat');
    act(() => menuItem('Close tab').click());
    expect(groups()).toEqual([['assets', []], ['notes', []]]);
  });

  it('leads a tab with Claude\'s title for its session when titles are on, the project after it', async () => {
    const titled = (title: string | null) => [{
      ...project('a', '2026-10-20T00:00:00Z'),
      workstreams: [{ id: 'w1', projectId: 'a', name: 'main', branch: 'main', archived: false, sessionTitle: title }],
    } as unknown as Project];
    mocks.projects = titled('Login rate limiting');
    mocks.titles = true;
    try {
      await render();
      expect(groups()).toEqual([['assets', []], ['notes', ['Login rate limiting · a']]]);
      expect(host.querySelector('.chat-item-name .chat-row-ws')!.textContent).toBe(' · a');
      expect(dots('Login rate limiting · a')).not.toBeNull();

      // No title yet: the project, as with titles off.
      mocks.projects = titled(null);
      await render();
      expect(groups()).toEqual([['assets', []], ['notes', ['a']]]);
    } finally {
      mocks.titles = false;
    }
    mocks.projects = titled('Login rate limiting');
    await render();
    expect(groups()).toEqual([['assets', []], ['notes', ['a']]]);
  });

  it('opens the menu from ⋮ by keyboard, and Escape gives focus back to ⋮', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z')];
    await render();
    act(() => dots('a').focus());
    act(() => { dots('a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })); });
    expect(document.activeElement).toBe(menuItem('Duplicate tab'));
    key(document.activeElement!, 'Escape');
    expect(document.querySelector('.chat-ctx-menu')).toBeNull();
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

  it('opens a tab\'s menu with Shift+F10: Duplicate tab puts a copy below it and shows it', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z')];
    await render('/chat/f/notes/README.md');
    expect(groups()).toContainEqual(['notes', ['README.md', 'a']]);
    act(() => tab('README.md').focus());
    key(tab('README.md'), 'F10', { shiftKey: true });
    expect(document.querySelector('.chat-ctx-menu')!.getAttribute('aria-label')).toBe('README.md');
    expect(menuLabels()).toEqual(['Duplicate tab', 'Open in new browser tab', 'Close tab']);
    expect(document.activeElement).toBe(menuItem('Duplicate tab'));
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(menuItem('Open in new browser tab'));
    key(document.activeElement!, 'Escape');
    expect(document.querySelector('.chat-ctx-menu')).toBeNull();
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

  it('keeps the plain session list for a user with no spaces, or with spaces off', async () => {
    mocks.projects = [project('a', '2026-10-20T00:00:00Z')];
    mocks.list = [];
    await render();
    expect(host.querySelector('.chat-new')).not.toBeNull();
    expect(host.querySelector('.chat-item')).toBeNull();
    mocks.spaces = false;
    await render();
    expect(host.querySelector('.chat-new')).not.toBeNull();
  });
});

describe('the explorer', () => {
  beforeEach(() => {
    mocks.spaces = true;
    mocks.list = [space('notes'), space('design')];
    mocks.projects = [project('boss', '2026-10-20T00:00:00Z'), project('kid', '2026-10-19T00:00:00Z'), project('far', '2026-10-18T00:00:00Z')];
    mocks.index = new Map([['box-boss', ['notes']], ['box-kid', ['notes']], ['box-far', ['design']]]);
    mocks.links = [{ projectId: 'kid', workstream: 'main', parentProjectId: 'boss', parentWorkstream: 'main' }];
  });

  it('lists the space\'s agents beside its files, a subagent under the agent that started it, and no agent from elsewhere', async () => {
    await render('/chat/files/notes?tab=e1');
    const names = () => [...host.querySelectorAll('.fx-panel .fx-tree > li > .fx-row .fx-name, .fx-panel .fx-tree > li > a.fx-row .fx-name')].map(n => n.textContent);
    expect(names()).toEqual(['boss', 'docs', 'README.md']);
    expect(panelRow('boss').querySelector('.chat-agent-icon')).not.toBeNull();
    const twisty = host.querySelector<HTMLButtonElement>('.fx-twisty')!;
    expect(twisty.getAttribute('aria-label')).toBe('Show the agents boss started');
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

  it('shows a picked file in the same tab, not a new one', async () => {
    await render('/chat/files/notes?tab=e1');
    expect(groups()).toContainEqual(['notes', ['New tab', 'boss', 'kid']]);
    act(() => { panelRow('README.md').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    await settle();
    expect(location).toBe('/chat/f/notes/README.md?tab=e1');
    expect(groups()).toContainEqual(['notes', ['README.md', 'boss', 'kid']]);
    expect(stored().items.filter(i => i.id === 'e1')).toEqual([expect.objectContaining({ kind: 'file', path: 'README.md' })]);
    act(() => panelRow('docs').click());
    await settle();
    act(() => { panelRow('q3.pdf').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    await settle();
    expect(location).toBe('/chat/f/notes/docs/q3.pdf?tab=e1');
    expect(groups()).toContainEqual(['notes', ['q3.pdf', 'boss', 'kid']]);
  });

  it('opens an item in a new tab from its menu, leaving this tab as it is', async () => {
    await render('/chat/files/notes?tab=e1');
    act(() => panelRow('README.md').focus());
    key(panelRow('README.md'), 'ContextMenu');
    expect(menuLabels()).toEqual(['Open', 'Open in new tab', 'Open in new browser tab']);
    act(() => menuItem('Open in new tab').click());
    await settle();
    expect(groups()).toContainEqual(['notes', ['README.md', 'New tab', 'boss', 'kid']]);
    expect(location).toMatch(/^\/chat\/f\/notes\/README\.md\?tab=(?!e1)[a-z0-9]+$/);
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
    act(() => { docs.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); docs.click(); });
    await settle();
    expect(document.querySelector('.chat-ctx-menu')).toBeNull();
    expect(docs.getAttribute('aria-expanded')).toBe(was);
    expect(location).toBe('/chat/files/notes?tab=e1');
    act(() => docs.click());
    expect(docs.getAttribute('aria-expanded')).not.toBe(was);
  });

  it('keeps the explorer beside an agent opened from it, with the agent highlighted and its starter open', async () => {
    await render('/chat/files/notes?tab=e1');
    const twisty = host.querySelector<HTMLButtonElement>('.fx-twisty')!;
    if (twisty.getAttribute('aria-expanded') !== 'true') act(() => twisty.click());
    act(() => { panelRow('kid').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    await settle();
    expect(location).toBe('/chat/p/kid?tab=e1');
    expect(groups()).toContainEqual(['notes', ['kid', 'boss', 'kid']]);
    expect(host.querySelector('[data-testid=chat]')).not.toBeNull();
    expect(host.querySelector('.fx-panel')!.getAttribute('aria-label')).toBe('Explorer for notes');
    expect(panelRow('kid').getAttribute('aria-current')).toBe('page');
    expect(panelRow('kid').closest('.fx-children')).not.toBeNull();
    act(() => { panelRow('boss').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    await settle();
    expect(location).toBe('/chat/p/boss?tab=e1');
    expect(panelRow('boss').getAttribute('aria-current')).toBe('page');
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
    expect(menuItem('New agent').disabled).toBe(true);
  });
});
