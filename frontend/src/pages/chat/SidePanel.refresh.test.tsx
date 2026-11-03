// @vitest-environment jsdom
// The side panel's tabs under the chrome refresh (PanelTabs.tsx).
import React, { act, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import { DEFAULT_SIDE_PANEL, type SidePanelState, type SidePanelTab } from '../../chat/sidePanel';
import { PANEL_TABS_KEY } from '../../chat/panelTabs';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';
import { useToolAsk } from './PanelTabs';

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { unixUsername: 'ada' } }) }));
vi.mock('../../hooks/useSetupContext', () => ({ useSetupContext: () => ({}) }));
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: (key: string, fallback: unknown) => (key === actual.FLAGS.browserPane ? true : fallback) };
});
vi.mock('../../components/Terminal', () => ({ Terminal: () => <div data-testid="terminal" /> }));
vi.mock('../../components/BrowserPane', () => ({ BrowserPane: () => <div data-testid="browser" /> }));
vi.mock('./ShareTab', () => ({ ShareTab: () => <div data-testid="share" /> }));
vi.mock('./FileExplorer', () => ({ ExplorerPanel: () => <div data-testid="files" /> }));
vi.mock('./AgentsExplorer', () => ({ AgentsPanel: () => <div data-testid="agents" /> }));
const spaces = vi.hoisted(() => ({ loaded: true }));
vi.mock('./simpleData', () => ({
  useSimpleDataIfAny: () => ({
    items: { state: { items: [] } }, activeTab: null,
    spaces: { loaded: spaces.loaded, current: true, spaces: [{ name: 'notes' }], index: spaces.loaded ? new Map([['box-1', ['notes']]]) : new Map() },
  }),
}));

import { SidePanel } from './SidePanel';

const project = {
  id: 'p1', name: 'sample', instanceId: 'box-1', setupStatus: null,
  workflows: [{ id: 'w1', type: 'agent', provider: 'claude', workstreamId: 'ws1' }], workstreams: [{ id: 'ws1', name: 'main' }],
} as unknown as Project;

let root: Root;
let host: HTMLElement;
let seen: SidePanelState[] = [];
let panelProject = project;
let setFromOutside: (s: SidePanelState) => void = () => {};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (!css?.escape) (globalThis as { CSS?: unknown }).CSS = { ...css, escape: (v: string) => v.replace(/[^\w-]/g, c => `\\${c}`) };
  localStorage.clear();
  // Someone who has used the panel before: a Terminal tab kept. A fresh panel is its own test.
  localStorage.setItem(PANEL_TABS_KEY, JSON.stringify([{ id: 'kept-t', kind: 'terminal' }]));
  spaces.loaded = true;
  panelProject = project;
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

/** The panel as ChatApp holds it: its state kept by the parent. */
function Panel({ initial, refresh, ask, onAskUsed, overlay = false }: {
  initial: SidePanelState; refresh: boolean; ask?: { tab: SidePanelTab; n: number } | null; onAskUsed?: () => void; overlay?: boolean;
}) {
  const [state, setState] = useState(initial);
  setFromOutside = setState;
  const chrome: ChatChrome = { mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, refresh };
  return (
    <ChatChromeProvider value={chrome}>
      <SidePanel project={panelProject} workstream="main" files={{ agent: panelProject }} state={state}
        onChange={s => { seen.push(s); setState(s); }} onClose={() => {}} overlay={overlay} ask={ask} onAskUsed={onAskUsed} />
    </ChatChromeProvider>
  );
}

function render(refresh = true, initial: SidePanelState = { ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' }) {
  act(() => root.render(<Panel initial={initial} refresh={refresh} />));
}

const press = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); };
const tabs = () => [...host.querySelectorAll('.chat-side-tab')].map(t => `${t.querySelector('.chat-side-tab-label')!.textContent}${t.hasAttribute('data-selected') ? '*' : ''}`);
const tabNamed = (name: string) => [...host.querySelectorAll('.chat-side-tab')].find(t => t.querySelector('.chat-side-tab-label')!.textContent === name)!;
const shown = () => host.querySelector('.chat-side-body [data-testid]')?.getAttribute('data-testid') ?? (host.querySelector('.chat-launcher') ? 'launcher' : null);

describe('the side panel under the chrome refresh', () => {
  it('keeps the fixed tabs with the refresh off', () => {
    render(false);
    expect(host.querySelector('.chat-side-add, .chat-side-tab-close')).toBeNull();
    expect([...host.querySelectorAll('[role="tab"]')].map(t => t.textContent)).toEqual(['Files', 'Terminal', 'Browser']);
  });

  it("opens on a new tab's launcher when nothing is kept, never on a tool it picks", () => {
    localStorage.removeItem(PANEL_TABS_KEY);
    render();
    expect(tabs()).toEqual(['New tab*']);
    expect(shown()).toBe('launcher');
  });

  it('opens on the tool last shown, as one tab', () => {
    render();
    expect(tabs()).toEqual(['Terminal*']);
    expect(shown()).toBe('terminal');
  });

  it('adds a launcher with +, which becomes the tool picked by click or by its number', async () => {
    render();
    await press(host.querySelector('.chat-side-add'));
    expect(tabs()).toEqual(['Terminal', 'New tab*']);
    expect(shown()).toBe('launcher');
    expect([...host.querySelectorAll('.chat-launcher-name')].map(n => n.textContent)).toEqual(['Files', 'Terminal', 'Browser', 'Pull request']);
    await press([...host.querySelectorAll('.chat-launcher-tile')][2]);
    expect(tabs()).toEqual(['Terminal', 'Browser*']);
    expect(shown()).toBe('browser');
    expect(seen[seen.length - 1]?.tab).toBe('browser');

    await press(host.querySelector('.chat-side-add'));
    act(() => { host.querySelector('.chat-launcher')!.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })); });
    expect(tabs()).toEqual(['Terminal', 'Browser', 'Files*']);
    expect(JSON.parse(localStorage.getItem(PANEL_TABS_KEY)!).map((t: { kind: string }) => t.kind)).toEqual(['terminal', 'browser', 'files']);
  });

  it('never opens a second Terminal: picking it again shows the one there is', async () => {
    render();
    await press(host.querySelector('.chat-side-add'));
    await press([...host.querySelectorAll('.chat-launcher-tile')][1]);
    expect(tabs()).toEqual(['Terminal*']);
    expect(host.querySelectorAll('[data-testid="terminal"]').length).toBe(1);
  });

  it('closes a tab to its neighbour, and the last one closed leaves a launcher', async () => {
    render();
    await press(host.querySelector('.chat-side-add'));
    await press([...host.querySelectorAll('.chat-launcher-tile')][0]);
    await press(tabNamed('Files').querySelector('.chat-side-tab-close'));
    expect(tabs()).toEqual(['Terminal*']);
    await press(tabNamed('Terminal').querySelector('.chat-side-tab-close'));
    expect(tabs()).toEqual(['New tab*']);
    expect(shown()).toBe('launcher');
  });

  it('shows a tool asked for from outside the strip, opening its tab', () => {
    render();
    // A share link opening Browser sets the panel's tool from outside (ChatApp's openBrowser).
    act(() => setFromOutside({ ...DEFAULT_SIDE_PANEL, open: true, tab: 'browser' }));
    expect(tabs()).toEqual(['Terminal', 'Browser*']);
    expect(shown()).toBe('browser');
    act(() => setFromOutside({ ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' }));
    expect(tabs()).toEqual(['Terminal*', 'Browser']);
  });

  it('never adds a Terminal tab while the spaces load and a kept Files tab is not offered yet', () => {
    localStorage.setItem(PANEL_TABS_KEY, JSON.stringify([{ id: 'f', kind: 'files' }]));
    spaces.loaded = false;
    render(true, { ...DEFAULT_SIDE_PANEL, open: true, tab: 'files' });
    // A new tab's launcher stands in, not a tool picked for you, and nothing is kept.
    expect(tabs()).toEqual(['New tab*']);
    expect(shown()).toBe('launcher');
    expect(JSON.parse(localStorage.getItem(PANEL_TABS_KEY)!)).toEqual([{ id: 'f', kind: 'files' }]);
    spaces.loaded = true;
    act(() => setFromOutside({ ...DEFAULT_SIDE_PANEL, open: true, tab: 'files' }));
    expect(tabs()).toEqual(['Files*']);
    expect(JSON.parse(localStorage.getItem(PANEL_TABS_KEY)!)).toEqual([{ id: 'f', kind: 'files' }]);
  });

  it('leaves a launcher when the last tab shown closes, with a hidden one kept', async () => {
    localStorage.setItem(PANEL_TABS_KEY, JSON.stringify([{ id: 'f', kind: 'files' }, { id: 't', kind: 'terminal' }]));
    spaces.loaded = false;
    render(true, { ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' });
    expect(tabs()).toEqual(['Terminal*']);
    await press(tabNamed('Terminal').querySelector('.chat-side-tab-close'));
    expect(tabs()).toEqual(['New tab*']);
    expect(shown()).toBe('launcher');
  });

  it("shows a new tab's launcher beside a file when the kept tab is a session tool, keeping nothing", async () => {
    localStorage.setItem(PANEL_TABS_KEY, JSON.stringify([{ id: 't', kind: 'terminal' }]));
    const chrome: ChatChrome = { mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, refresh: true };
    act(() => root.render(
      <ChatChromeProvider value={chrome}>
        <SidePanel workstream="main" files={{ space: 'notes', path: 'README.md' }} state={{ ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' }}
          onChange={() => {}} onClose={() => {}} overlay={false} />
      </ChatChromeProvider>,
    ));
    expect(tabs()).toEqual(['New tab*']);
    expect(shown()).toBe('launcher');
    expect([...host.querySelectorAll('.chat-launcher-name')].map(n => n.textContent)).toEqual(['Files']);
    expect(JSON.parse(localStorage.getItem(PANEL_TABS_KEY)!)).toEqual([{ id: 't', kind: 'terminal' }]);
  });

  it('shows the agents in no space as the Files tool beside a session in no space, and its launcher says so', async () => {
    panelProject = { ...project, instanceId: 'box-9' } as Project;
    render(true, { ...DEFAULT_SIDE_PANEL, open: true, tab: 'files' });
    expect(shown()).toBe('agents');
    expect(host.querySelector('.chat-side-body')!.getAttribute('data-tool')).toBe('files');
    await press(host.querySelector('.chat-side-add'));
    expect(shown()).toBe('launcher');
    expect(host.querySelector('.chat-launcher-sub')!.textContent).toBe('For sample in no space');
  });

  it('opens on a tool asked for from outside (a share link, a folder, the context card), even with nothing kept', () => {
    localStorage.removeItem(PANEL_TABS_KEY);
    const initial = { ...DEFAULT_SIDE_PANEL, open: true, tab: 'files' as const };
    act(() => root.render(<Panel initial={initial} refresh ask={{ tab: 'files', n: 1 }} />));
    expect(tabs()).toEqual(['Files*']);
    expect(shown()).toBe('files');
  });

  it('opens a tool asked for while the panel is open, and leaves a plain open on the launcher', () => {
    localStorage.removeItem(PANEL_TABS_KEY);
    const initial = { ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' as const };
    act(() => root.render(<Panel initial={initial} refresh ask={null} />));
    expect(tabs()).toEqual(['New tab*']);
    act(() => root.render(<Panel initial={initial} refresh ask={{ tab: 'pr', n: 1 }} />));
    expect(tabs()).toEqual(['Pull request*']);
  });

  it('says once that an ask was shown, so the asker can forget it and a remount opens as usual', () => {
    localStorage.removeItem(PANEL_TABS_KEY);
    const used = vi.fn();
    const initial = { ...DEFAULT_SIDE_PANEL, open: true, tab: 'pr' as const };
    act(() => root.render(<Panel initial={initial} refresh ask={{ tab: 'pr', n: 1 }} onAskUsed={used} />));
    expect(tabs()).toEqual(['Pull request*']);
    expect(used).toHaveBeenCalledTimes(1);
  });

  it('shows an ask that came while the tabs were off once they come on', () => {
    localStorage.removeItem(PANEL_TABS_KEY);
    const used = vi.fn();
    const initial = { ...DEFAULT_SIDE_PANEL, open: true, tab: 'files' as const };
    act(() => root.render(<Panel initial={initial} refresh overlay ask={{ tab: 'files', n: 1 }} onAskUsed={used} />));
    expect(used).not.toHaveBeenCalled();
    act(() => root.render(<Panel initial={initial} refresh ask={{ tab: 'files', n: 1 }} onAskUsed={used} />));
    expect(tabs()).toEqual(['Files*']);
    expect(used).toHaveBeenCalledTimes(1);
  });

  it('opens the next ask after one was forgotten, though it asks for the same tool', async () => {
    localStorage.removeItem(PANEL_TABS_KEY);
    let askTool: (tab: SidePanelTab) => void = () => {};
    function Asker() {
      const t = useToolAsk();
      askTool = t.askTool;
      return <Panel initial={{ ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' }} refresh ask={t.ask} onAskUsed={t.forget} />;
    }
    act(() => root.render(<Asker />));
    act(() => askTool('pr'));
    expect(tabs()).toEqual(['Pull request*']);
    await press(tabNamed('Pull request').querySelector('.chat-side-tab-close'));
    expect(tabs()).toEqual(['New tab*']);
    act(() => askTool('pr'));
    expect(tabs()).toEqual(['Pull request*']);
  });
});

describe('the side panel tab strip, fitted to the panel', () => {
  const restore: (() => void)[] = [];
  /** The strip `strip` px wide and the tab on screen `tab` px, as a browser would lay them out (jsdom lays out nothing). */
  function widths(strip: number, tab: number) {
    const stub = (proto: object, prop: string, get: (el: HTMLElement) => number) => {
      const own = Object.getOwnPropertyDescriptor(proto, prop);
      Object.defineProperty(proto, prop, { configurable: true, get() { return get(this as HTMLElement); } });
      restore.push(() => { if (own) Object.defineProperty(proto, prop, own); else delete (proto as Record<string, unknown>)[prop]; });
    };
    stub(HTMLElement.prototype, 'clientWidth', el => (el.classList.contains('chat-side-tabs') ? strip : 0));
    stub(HTMLElement.prototype, 'offsetWidth', el => (el.classList.contains('chat-side-tab') ? tab : 0));
  }
  afterEach(() => { restore.splice(0).reverse().forEach(r => r()); });
  beforeEach(() => {
    localStorage.setItem(PANEL_TABS_KEY, JSON.stringify([
      { id: 'f', kind: 'files' }, { id: 't', kind: 'terminal' }, { id: 'b', kind: 'browser' }, { id: 'p', kind: 'pr' },
      { id: 'l1', kind: 'launcher' }, { id: 'l2', kind: 'launcher' },
    ]));
  });
  const compact = () => [...host.querySelectorAll('.chat-side-tab')].map(t => t.hasAttribute('data-compact'));

  it('labels every tab while they have room', () => {
    widths(700, 120);
    render();
    expect(tabs()).toEqual(['Files', 'Terminal*', 'Browser', 'Pull request', 'New tab', 'New tab']);
    expect(compact()).toEqual([false, false, false, false, false, false]);
    expect(host.querySelector('.chat-side-more')).toBeNull();
  });

  it('shows the others as icons, named by their tooltips, with only the tab on screen keeping its label and ×', () => {
    widths(330, 120);
    render();
    expect(compact()).toEqual([true, false, true, true, true, true]);
    expect(tabNamed('Files').querySelector('.chat-side-tab-close')).toBeNull();
    expect(tabNamed('Files').querySelector('[role="tab"]')!.getAttribute('data-tip')).toBe('Files');
    expect(tabNamed('Terminal').querySelector('.chat-side-tab-close')).not.toBeNull();
    expect(host.querySelector('.chat-side-more')).toBeNull();
  });

  it('puts the tabs that still do not fit in a menu, and shows the one picked from it', async () => {
    widths(270, 120);
    render();
    expect(tabs()).toEqual(['Files', 'Terminal*', 'Browser']);
    expect(host.querySelector('.chat-side-more')!.textContent).toBe('3');
    await press(host.querySelector('.chat-side-more'));
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map(i => i.textContent)).toEqual(['Pull request', 'New tab', 'New tab']);
    await press(items[1]);
    expect(tabs()).toEqual(['Files', 'Terminal', 'New tab*']);
    expect(shown()).toBe('launcher');
  });

  it("leaves the phone overlay's fixed tabs out of the fitted strip's styles", () => {
    act(() => root.render(<Panel initial={{ ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' }} refresh overlay />));
    expect(host.querySelector('.chat-side-tabs[data-fit]')).toBeNull();
    expect(host.querySelector('.chat-side-tab')).not.toBeNull();
    render();
    expect(host.querySelector('.chat-side-tabs[data-fit]')).not.toBeNull();
  });

  it('closes a tab with a middle click', async () => {
    widths(330, 120);
    render();
    await act(async () => { tabNamed('Browser').querySelector('[role="tab"]')!.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })); });
    expect(tabs()).toEqual(['Files', 'Terminal*', 'Pull request', 'New tab', 'New tab']);
  });
});
