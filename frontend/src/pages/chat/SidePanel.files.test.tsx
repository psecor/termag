// @vitest-environment jsdom
// Files open in the side panel (project-files-enabled): the place's file tabs after the tools, the file
// page's own view in them, the tool again when its tab is picked, and Open in main panel.
import React, { act, useReducer, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import { DEFAULT_SIDE_PANEL, type SidePanelState } from '../../chat/sidePanel';
import { PANEL_TABS_KEY } from '../../chat/panelTabs';
import type { OpenItem, PanelFileItem } from '../../chat/openItems';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { unixUsername: 'ada', myFilesSpace: 'ada-my-files' } }) }));
vi.mock('../../hooks/useSetupContext', () => ({ useSetupContext: () => ({}) }));
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: (key: string, fallback: unknown) => fallback };
});
vi.mock('../../components/Terminal', () => ({ Terminal: () => <div data-testid="terminal" /> }));
vi.mock('../../components/BrowserPane', () => ({ BrowserPane: () => <div data-testid="browser" /> }));
vi.mock('./ShareTab', () => ({ ShareTab: () => <div data-testid="share" /> }));
vi.mock('./FileExplorer', () => ({ ExplorerPanel: () => <div data-testid="files" /> }));
vi.mock('./AgentsExplorer', () => ({ AgentsPanel: () => <div data-testid="agents" /> }));
vi.mock('./SpaceFileView', () => ({
  SpaceFileView: ({ file, inPanel }: { file: { space: string; path: string }; inPanel: { openInMain: () => void } }) => (
    <div data-testid="file" data-file={`${file.space}:${file.path}`}><button type="button" className="main" onClick={inPanel.openInMain}>main</button></div>
  ),
}));
const data = vi.hoisted(() => ({ items: [] as PanelFileItem[], tabs: [] as OpenItem[], bump: () => {}, dismiss: vi.fn(), arrange: vi.fn() }));
vi.mock('./simpleData', () => ({
  useSimpleDataIfAny: () => ({
    items: {
      state: { items: data.tabs, panel: data.items },
      dismiss: (id: string) => { data.dismiss(id); data.items = data.items.filter(i => i.id !== id); data.bump(); },
      arrangePanel: (place: string, order: string[]) => {
        data.arrange(place, order);
        const mine = new Map(data.items.filter(i => i.panel === place).map(i => [i.id, i]));
        let n = 0;
        data.items = data.items.map(i => (i.panel === place ? mine.get(order[n++])! : i));
        data.bump();
      },
    },
    activeTab: null,
    userProjects: { list: [{ id: 'up1', name: 'Scratch', repos: [], filesSpace: { name: 'scratch-files' }, icon: { choice: 'auto', imageId: null, src: null } }] },
    spaces: { loaded: true, current: true, spaces: [{ name: 'notes' }], index: new Map([['box-1', ['notes']]]) },
  }),
}));

import { SidePanel } from './SidePanel';

const PLACE = 'session:p1|main';
const project = {
  id: 'p1', name: 'sample', instanceId: 'box-1', setupStatus: null,
  workflows: [{ id: 'w1', type: 'agent', provider: 'claude', workstreamId: 'ws1' }], workstreams: [{ id: 'ws1', name: 'main' }],
} as unknown as Project;
const fileItem = (id: string, space: string, path: string, panel: string): PanelFileItem => ({ kind: 'file', space, path, panel, id, openedAt: 1 });

let root: Root;
let host: HTMLElement;
let seen: SidePanelState[] = [];
const openInMain = vi.fn();

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
  localStorage.clear();
  localStorage.setItem(PANEL_TABS_KEY, JSON.stringify([{ id: 'kept-t', kind: 'terminal' }]));
  data.items = [
    fileItem('f1', 'scratch-files', 'docs/plan.md', PLACE),
    fileItem('f2', 'ada-my-files', 'todo.md', PLACE),
    fileItem('o1', 'scratch-files', 'other.md', 'space:scratch-files'),
  ];
  data.tabs = [{ kind: 'file', space: 'scratch-files', path: 'main.md', id: 'm1', openedAt: 1 }];
  data.dismiss.mockReset();
  data.arrange.mockReset();
  openInMain.mockReset();
  seen = [];
  host = document.createElement('main');
  host.getBoundingClientRect = () => ({ width: 1200 } as DOMRect);
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function Panel({ initial, overlay, place }: { initial: SidePanelState; overlay: boolean; place: string | null }) {
  const [state, setState] = useState(initial);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  data.bump = bump;
  const chrome: ChatChrome = {
    mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, refresh: true,
    sidePanel: { open: true, toggle: () => {}, place, showFile: id => setState(s => ({ ...s, file: id })), openInMain },
  };
  return (
    <ChatChromeProvider value={chrome}>
      <SidePanel project={project} workstream="main" files={{ agent: project }} state={state} overlay={overlay}
        onChange={s => { seen.push(s); setState(s); }} onFile={id => setState(s => ({ ...s, file: id }))} onClose={() => {}} />
    </ChatChromeProvider>
  );
}

function render({ file = null, overlay = false, place = PLACE }: { file?: string | null; overlay?: boolean; place?: string | null } = {}) {
  act(() => root.render(<Panel initial={{ ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal', file }} overlay={overlay} place={place} />));
}

const press = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); };
const tabs = () => [...host.querySelectorAll('.chat-side-tab')].map(t => `${t.querySelector('.chat-side-tab-label')!.textContent}${t.hasAttribute('data-selected') ? '*' : ''}`);
const tabNamed = (name: string) => [...host.querySelectorAll('.chat-side-tab')].find(t => t.querySelector('.chat-side-tab-label')!.textContent === name)!;
const menuItems = () => [...document.querySelectorAll<HTMLElement>('.chat-side-tab-menu [role=menuitem]')];
const order = () => JSON.parse(localStorage.getItem(PANEL_TABS_KEY) ?? '[]').map((t: { id: string }) => t.id);
const shown = () => {
  const el = host.querySelector('.chat-side-body [data-testid]');
  return el?.getAttribute('data-file') ?? el?.getAttribute('data-testid') ?? null;
};

describe('files open in the side panel', () => {
  it("has the place's file tabs after the tools, named by their files and marked with where they live", () => {
    render();
    expect(tabs()).toEqual(['Terminal*', 'plan.md', 'todo.md']);
    expect(shown()).toBe('terminal');
    expect(tabNamed('plan.md').querySelector('.chat-side-tab-main')!.getAttribute('data-tip')).toBe("docs/plan.md · Scratch's files");
    expect(tabNamed('todo.md').querySelector('.chat-side-tab-main')!.getAttribute('data-tip')).toBe('todo.md · My files');
    expect(tabNamed('plan.md').querySelector('.chat-side-tab-mark')).not.toBeNull();
  });

  it('shows a file over the tool, and the tool again when its tab is picked', async () => {
    render();
    await press(tabNamed('plan.md').querySelector('.chat-side-tab-main'));
    expect(tabs()).toEqual(['Terminal', 'plan.md*', 'todo.md']);
    expect(shown()).toBe('scratch-files:docs/plan.md');
    await press(tabNamed('Terminal').querySelector('.chat-side-tab-main'));
    expect(tabs()).toEqual(['Terminal*', 'plan.md', 'todo.md']);
    expect(shown()).toBe('terminal');
    // Another tool shows in one change, the file gone with it.
    await press(tabNamed('todo.md').querySelector('.chat-side-tab-main'));
    expect(shown()).toBe('ada-my-files:todo.md');
    await press(host.querySelector('.chat-side-add'));
    await press([...host.querySelectorAll('.chat-launcher-tile')].find(t => t.textContent?.includes('Browser'))!);
    expect(shown()).toBe('browser');
    expect(seen[seen.length - 1]).toMatchObject({ tab: 'browser', file: null });
  });

  it('opens on the file tab the place last showed', () => {
    render({ file: 'f2' });
    expect(tabs()).toEqual(['Terminal', 'plan.md', 'todo.md*']);
    expect(shown()).toBe('ada-my-files:todo.md');
  });

  it('closes the file on screen to its neighbour, and one behind it leaves it on screen', async () => {
    render({ file: 'f2' });
    await press(tabNamed('todo.md').querySelector('.chat-side-tab-close'));
    expect(data.dismiss).toHaveBeenCalledWith('f2');
    expect(tabs()).toEqual(['Terminal', 'plan.md*']);
    expect(shown()).toBe('scratch-files:docs/plan.md');
    await press(tabNamed('Terminal').querySelector('.chat-side-tab-close'));
    expect(shown()).toBe('scratch-files:docs/plan.md');
  });

  it("has Open in main panel in a file tab's menu and in its view, which close the tab and open the file's page", async () => {
    render({ file: 'f1' });
    act(() => { tabNamed('todo.md').querySelector('.chat-side-tab-main')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    const items = menuItems();
    expect(items.map(i => i.textContent)).toEqual(['Move left', 'Move right', 'Open in main panel', 'Close']);
    await press(items[2]);
    expect(data.dismiss).toHaveBeenCalledWith('f2');
    expect(openInMain).toHaveBeenCalledWith({ space: 'ada-my-files', path: 'todo.md' });
    await press(host.querySelector('[data-testid="file"] .main'));
    expect(data.dismiss).toHaveBeenCalledWith('f1');
    expect(openInMain).toHaveBeenLastCalledWith({ space: 'scratch-files', path: 'docs/plan.md' });
    expect(shown()).toBe('terminal');
  });

  it('has no file tabs with project-files-enabled off (no place)', () => {
    render({ place: null, file: 'f1' });
    expect(tabs()).toEqual(['Terminal*']);
    expect(shown()).toBe('terminal');
  });

  it("gives a phone's overlay the same file tabs, each with a close", async () => {
    render({ overlay: true });
    const names = () => [...host.querySelectorAll('[role="tab"]')].map(t => `${t.textContent}${t.getAttribute('aria-selected') === 'true' ? '*' : ''}`);
    expect(names()).toEqual(['Files', 'Terminal*', 'Browser', 'Share', 'plan.md', 'todo.md']);
    await press([...host.querySelectorAll('[role="tab"]')].find(t => t.textContent === 'plan.md')!);
    expect(names()).toEqual(['Files', 'Terminal', 'Browser', 'Share', 'plan.md*', 'todo.md']);
    expect(shown()).toBe('scratch-files:docs/plan.md');
    await press(host.querySelector('[aria-label="Close plan.md"]'));
    expect(data.dismiss).toHaveBeenCalledWith('f1');
    expect(names()).toEqual(['Files', 'Terminal*', 'Browser', 'Share', 'todo.md']);
  });

  it('moves any tab left or right from its menu, by the keyboard too, and keeps that one order', async () => {
    render();
    act(() => { tabNamed('plan.md').querySelector('.chat-side-tab-main')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); });
    let items = menuItems();
    expect(items.map(i => `${i.textContent}${i.getAttribute('aria-disabled') === 'true' ? ' (off)' : ''}`)).toEqual(['Move left', 'Move right', 'Open in main panel', 'Close']);
    await press(items[0]);
    expect(tabs()).toEqual(['plan.md', 'Terminal*', 'todo.md']);
    expect(order()).toEqual(['f1', 'kept-t', 'f2']);
    expect(host.querySelector('.chat-side-tabs [role="status"]')!.textContent).toBe('Moved plan.md to 1 of 3');
    // The first can't go further left; Terminal goes right past the last file.
    act(() => { tabNamed('plan.md').querySelector('.chat-side-tab-main')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    expect(menuItems()[0].getAttribute('aria-disabled')).toBe('true');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    act(() => { tabNamed('Terminal').querySelector('.chat-side-tab-main')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    items = menuItems();
    expect(items.map(i => i.textContent)).toEqual(['Move left', 'Move right', 'Close']);
    await press(items[1]);
    expect(tabs()).toEqual(['plan.md', 'todo.md', 'Terminal*']);
    // The Open list follows the files' order (unchanged here: plan.md was first of the two already).
    await press(tabNamed('todo.md').querySelector('.chat-side-tab-main'));
    act(() => { tabNamed('todo.md').querySelector('.chat-side-tab-main')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    await press(menuItems()[0]);
    expect(tabs()).toEqual(['todo.md*', 'plan.md', 'Terminal']);
    expect(data.arrange).toHaveBeenLastCalledWith(PLACE, ['f2', 'f1']);
  });

  it('drags a tab to where its drop line is', async () => {
    render();
    // Each tab 100px wide, side by side.
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const i = [...(this.parentElement?.children ?? [])].filter(c => c.classList.contains('chat-side-tab')).indexOf(this);
      return (this.classList.contains('chat-side-tab') ? { left: i * 100, right: i * 100 + 100, width: 100, top: 0, bottom: 32 } : { left: 0, right: 600, width: 600, top: 0, bottom: 32 }) as DOMRect;
    });
    try {
      const types: string[] = [];
      const dataTransfer = { types, setData: (t: string) => { types.push(t); }, effectAllowed: '', dropEffect: '' };
      const fire = (el: Element, type: string, clientX = 0) => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(e, { dataTransfer, clientX });
        act(() => { el.dispatchEvent(e); });
      };
      const todo = tabNamed('todo.md');
      expect(todo.getAttribute('draggable')).toBe('true');
      fire(todo, 'dragstart');
      const strip = host.querySelector('.chat-side-tabs')!;
      fire(strip, 'dragover', 30);
      expect(host.querySelector<HTMLElement>('.chat-side-drop')!.style.left).toBe('1px');
      // Over its own place: no line, and a drop there moves nothing.
      fire(strip, 'dragover', 260);
      expect(host.querySelector('.chat-side-drop')).toBeNull();
      fire(strip, 'dragover', 30);
      fire(strip, 'drop', 30);
      expect(tabs()).toEqual(['todo.md', 'Terminal*', 'plan.md']);
      expect(host.querySelector('.chat-side-drop')).toBeNull();
      expect(data.arrange).toHaveBeenLastCalledWith(PLACE, ['f2', 'f1']);
    } finally {
      rect.mockRestore();
    }
  });

  it("doesn't move tabs with project-files-enabled off", () => {
    render({ place: null });
    const t = tabNamed('Terminal');
    expect(t.hasAttribute('draggable')).toBe(false);
    act(() => { t.querySelector('.chat-side-tab-main')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    expect(menuItems()).toEqual([]);
  });

  it('moves the tabs as the strip shows them, the ones in "N more" staying there, by a drag or the menu', async () => {
    localStorage.setItem(PANEL_TABS_KEY, JSON.stringify([{ id: 'kept-t', kind: 'terminal' }, { id: 'kept-b', kind: 'browser' }]));
    // A strip so narrow that only Terminal and todo.md (on screen) show; Browser and plan.md are in "N more".
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('chat-side-tabs') ? 120 : 0;
    });
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const i = [...(this.parentElement?.children ?? [])].filter(c => c.classList.contains('chat-side-tab')).indexOf(this);
      return (this.classList.contains('chat-side-tab') ? { left: i * 100, right: i * 100 + 100, width: 100, top: 0, bottom: 32 } : { left: 0, right: 600, width: 600, top: 0, bottom: 32 }) as DOMRect;
    });
    try {
      render({ file: 'f2' });
      expect(tabs()).toEqual(['Terminal', 'todo.md*']);
      const types: string[] = [];
      const dataTransfer = { types, setData: (t: string) => { types.push(t); }, effectAllowed: '', dropEffect: '' };
      const fire = (el: Element, type: string, clientX = 0) => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(e, { dataTransfer, clientX });
        act(() => { el.dispatchEvent(e); });
      };
      // Terminal dropped just left of todo.md, where it is: no line, nothing moves (not past the tabs in "N more").
      fire(tabNamed('Terminal'), 'dragstart');
      const strip = host.querySelector('.chat-side-tabs')!;
      fire(strip, 'dragover', 110);
      expect(host.querySelector('.chat-side-drop')).toBeNull();
      fire(strip, 'drop', 110);
      expect(tabs()).toEqual(['Terminal', 'todo.md*']);
      // todo.md before Terminal: both stay on the strip, and the tabs in "N more" come after them.
      fire(tabNamed('todo.md'), 'dragstart');
      fire(strip, 'dragover', 30);
      fire(strip, 'drop', 30);
      expect(tabs()).toEqual(['todo.md*', 'Terminal']);
      expect(order()).toEqual(['f2', 'kept-t', 'kept-b', 'f1']);
      // The menu swaps with the tab beside it on the strip.
      act(() => { tabNamed('Terminal').querySelector('.chat-side-tab-main')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
      expect(menuItems()[1].getAttribute('aria-disabled')).toBe('true');
      await press(menuItems()[0]);
      expect(tabs()).toEqual(['Terminal', 'todo.md*']);
      expect(host.querySelector('.chat-side-tabs [role="status"]')!.textContent).toBe('Moved Terminal to 1 of 2');
      expect(tabNamed('Terminal').getAttribute('draggable')).toBe('true');
      // Narrower still, the tab shown is the strip's only one: nothing to drag it past.
      width.mockImplementation(function (this: HTMLElement) { return this.classList.contains('chat-side-tabs') ? 60 : 0; });
      act(() => root.unmount());
      root = createRoot(host);
      render({ file: 'f2' });
      expect(tabs()).toEqual(['todo.md*']);
      expect(tabNamed('todo.md').hasAttribute('draggable')).toBe(false);
    } finally {
      width.mockRestore();
      rect.mockRestore();
    }
  });

  it('keeps the menu of a file tab that is the only tab, its moves off', () => {
    localStorage.setItem(PANEL_TABS_KEY, JSON.stringify([{ id: 'kept-r', kind: 'review' }]));
    data.items = [fileItem('f1', 'scratch-files', 'docs/plan.md', PLACE)];
    // The tool last shown here (Review) isn't offered beside this session, so the file is all there is.
    act(() => root.render(<Panel initial={{ ...DEFAULT_SIDE_PANEL, open: true, tab: 'review', file: 'f1' }} overlay={false} place={PLACE} />));
    expect(tabs()).toEqual(['plan.md*']);
    expect(tabNamed('plan.md').hasAttribute('draggable')).toBe(false);
    act(() => { tabNamed('plan.md').querySelector('.chat-side-tab-main')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); });
    expect(menuItems().map(i => `${i.textContent}${i.getAttribute('aria-disabled') === 'true' ? ' (off)' : ''}`))
      .toEqual(['Move left (off)', 'Move right (off)', 'Open in main panel', 'Close']);
  });
});

