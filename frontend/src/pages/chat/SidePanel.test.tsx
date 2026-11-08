// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import { DEFAULT_SIDE_PANEL, type SidePanelState } from '../../chat/sidePanel';

vi.mock('../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { unixUsername: 'ada' } }) }));
vi.mock('../../hooks/useSetupContext', () => ({ useSetupContext: () => ({}) }));
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  const on = (_key: string) => false;
  return { ...actual, useFlag: (key: string, fallback: unknown) => (on(key) ? true : fallback) };
});
vi.mock('../../components/Terminal', () => ({
  Terminal: ({ sessionName }: { sessionName: string }) => <div data-testid="terminal">{sessionName}</div>,
}));
vi.mock('../../components/BrowserPane', () => ({
  BrowserPane: (p: { openShare?: { shareId: string; at: string | null } | null; onOpenShareUsed?: () => void }) => (
    <button type="button" data-testid="browser" data-share={p.openShare?.shareId ?? ''} data-at={p.openShare?.at ?? ''} onClick={p.onOpenShareUsed} />
  ),
}));
vi.mock('./ShareTab', () => ({
  ShareTab: (p: { projectId: string; workstream: string }) => <div data-testid="share" data-project={p.projectId} data-ws={p.workstream} />,
}));
vi.mock('./FileExplorer', () => ({
  ExplorerPanel: (p: { space: string; activePath?: string; activeAgent?: { projectId: string }; onPicked?: () => void }) => (
    <button type="button" data-testid="files" data-space={p.space} data-path={p.activePath ?? ''} data-agent={p.activeAgent?.projectId ?? ''} onClick={p.onPicked} />
  ),
}));
vi.mock('./AgentsExplorer', () => ({
  AgentsPanel: (p: { activeAgent?: { projectId: string }; onPicked?: () => void }) => (
    <button type="button" data-testid="agents" data-agent={p.activeAgent?.projectId ?? ''} onClick={p.onPicked} />
  ),
}));
const spacesMock = vi.hoisted(() => ({ current: true, index: new Map<string, string[]>([['box-1', ['notes']]]), rows: [] as Array<{ instanceId: string }> }));
vi.mock('./simpleData', () => ({
  useSimpleDataIfAny: () => ({
    items: { state: { items: [] } }, activeTab: null, rows: spacesMock.rows,
    spaces: { loaded: true, current: spacesMock.current, spaces: [{ name: 'notes' }], index: spacesMock.index },
  }),
}));

import { SidePanel } from './SidePanel';

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'sample',
    instanceId: 'box-1',
    setupStatus: null,
    workflows: [{ id: 'w1', type: 'agent', provider: 'claude', workstreamId: 'ws1' }],
    workstreams: [{ id: 'ws1', name: 'main' }],
    ...over,
  } as unknown as Project;
}

let root: Root;
let host: HTMLElement;
let observers: Array<() => void> = [];
let mainWidth = 1200;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  observers = [];
  globalThis.ResizeObserver = class {
    private cb: () => void;
    constructor(cb: () => void) { this.cb = cb; observers.push(() => this.cb()); }
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  // The panel's parent stands in for .chat-main.
  host = document.createElement('main');
  host.getBoundingClientRect = () => ({ width: mainWidth } as DOMRect);
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(p: Project | undefined, state: SidePanelState, extra: Partial<React.ComponentProps<typeof SidePanel>> = {}) {
  act(() => root.render(
    <SidePanel project={p} workstream="main" state={state} onChange={() => {}} onClose={() => {}} overlay={false} {...extra} />,
  ));
}

const tabs = () => [...host.querySelectorAll('[role="tab"]')].map(t => `${t.textContent}${t.getAttribute('aria-selected') === 'true' ? '*' : ''}`);

const panelWidth = () => (host.querySelector('#chat-side-panel') as HTMLElement).style.width;

describe('SidePanel width', () => {
  it('clamps a remembered width to the main column, and again when it resizes', () => {
    mainWidth = 744; // a 1024 px window beside the 280 px list
    render(project(), { ...DEFAULT_SIDE_PANEL, open: true, width: 480 });
    expect(panelWidth()).toBe(`${744 - 360}px`);
    mainWidth = 1400;
    act(() => observers.forEach(fire => fire()));
    expect(panelWidth()).toBe('480px');
  });
});

describe('SidePanel setup hold', () => {
  it('mounts neither the browser nor the terminal while the session is set up', () => {
    mainWidth = 1400;
    render(project({ setupStatus: 'cloning' }), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'browser' });
    expect(host.querySelector('[data-testid="browser"]')).toBeNull();
    expect(host.textContent).toContain('The browser opens once the session is set up.');
    render(project({ setupStatus: 'cloning' }), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' });
    expect(host.querySelector('[data-testid="terminal"]')).toBeNull();
  });

  it('mounts no browser for a session with no agent workflow', () => {
    render(project({ workflows: [] }), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'browser' });
    expect(host.querySelector('[data-testid="browser"]')).toBeNull();
    expect(host.textContent).toContain('This session has no terminal or browser.');
  });

  it('mounts the browser and the ctrl terminal once it is ready', () => {
    render(project(), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'browser' });
    expect(host.querySelector('[data-testid="browser"]')).not.toBeNull();
    render(project(), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' });
    expect(host.querySelector('[data-testid="terminal"]')?.textContent).toBe('ada-sample-ctrl');
  });
});

describe('SidePanel on a phone', () => {
  it('gives the overlay\'s terminal a key bar, and the docked panel\'s none', () => {
    render(project(), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' });
    expect(host.querySelector('[data-testid="terminal"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Terminal keys"]')).toBeNull();
    render(project(), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' }, { overlay: true });
    expect(host.querySelector('[data-testid="terminal"]')?.textContent).toBe('ada-sample-ctrl');
    expect(host.querySelector('[aria-label="Terminal keys"]')).not.toBeNull();
  });

  it('follows the visual viewport only as an overlay', () => {
    const vv = Object.assign(new EventTarget(), { height: 480, offsetTop: 100 });
    const real = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    try {
      const panel = () => host.querySelector('#chat-side-panel') as HTMLElement;
      render(project(), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' });
      expect(panel().style.getPropertyValue('--chat-vvh')).toBe('');
      render(project(), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' }, { overlay: true });
      expect(panel().style.getPropertyValue('--chat-vvh')).toBe('480px');
      expect(panel().style.getPropertyValue('--chat-vvtop')).toBe('100px');
      render(project(), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' });
      expect(panel().style.getPropertyValue('--chat-vvh')).toBe('');
    } finally {
      if (real) Object.defineProperty(window, 'visualViewport', real);
      else delete (window as { visualViewport?: unknown }).visualViewport;
    }
  });
});

describe('SidePanel Browser', () => {
  it('hands a share link its owner opened to the browser, which says when its dial is ready', () => {
    const used = vi.fn();
    render(project(), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'browser' }, { openShare: { shareId: 'cshare0000000001', at: '/projects/x' }, onOpenShareUsed: used });
    const pane = host.querySelector('[data-testid="browser"]') as HTMLButtonElement;
    expect(pane.getAttribute('data-share')).toBe('cshare0000000001');
    expect(pane.getAttribute('data-at')).toBe('/projects/x');
    act(() => pane.click());
    expect(used).toHaveBeenCalled();
  });
});

describe('SidePanel Files', () => {
  it('beside a file offers only Files, on that file, whatever tab was remembered', () => {
    render(undefined, { ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' }, { files: { space: 'notes', path: 'docs/a.md' } });
    expect(tabs()).toEqual(['Files*']);
    const files = host.querySelector('[data-testid="files"]')!;
    expect(files.getAttribute('data-space')).toBe('notes');
    expect(files.getAttribute('data-path')).toBe('docs/a.md');
    expect(host.querySelector('[data-testid="terminal"]')).toBeNull();
    expect(host.querySelector('#chat-side-panel')?.getAttribute('aria-label')).toBe('Tools');
  });

  it('beside an agent in a space puts Files first and explores its space', () => {
    render(project(), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'files' }, { files: { agent: project() } });
    expect(tabs()).toEqual(['Files*', 'Terminal', 'Browser', 'Share']);
    expect(host.querySelector('[data-testid="files"]')?.getAttribute('data-agent')).toBe('p1');
    render(project(), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' }, { files: { agent: project() } });
    expect(tabs()).toEqual(['Files', 'Terminal*', 'Browser', 'Share']);
  });

  it('has Agents, the explorer of agents in no space, beside an agent with no space', () => {
    const lone = project({ id: 'lone', instanceId: 'box-9' });
    render(lone, { ...DEFAULT_SIDE_PANEL, open: true, tab: 'files' }, { files: { agent: lone } });
    expect(tabs()).toEqual(['Agents*', 'Terminal', 'Browser', 'Share']);
    expect(host.querySelector('[data-testid="files"]')).toBeNull();
    expect(host.querySelector('[data-testid="agents"]')!.getAttribute('data-agent')).toBe('lone');
  });

  it('waits for the spaces of a box the index doesn\'t have yet before deciding it is in no space', () => {
    const fresh = project({ id: 'fresh', instanceId: 'box-new' });
    spacesMock.current = false;
    try {
      render(fresh, { ...DEFAULT_SIDE_PANEL, open: true, tab: 'files' }, { files: { agent: fresh } });
      expect(tabs()).toEqual(['Terminal*', 'Browser', 'Share']);
      expect(host.querySelector('[data-testid="agents"]')).toBeNull();
      // The reload brings the box in a space: Files for that space, never Agents.
      spacesMock.index = new Map([['box-1', ['notes']], ['box-new', ['notes']]]);
      spacesMock.current = true;
      render(fresh, { ...DEFAULT_SIDE_PANEL, open: true, tab: 'files' }, { files: { agent: fresh } });
      expect(tabs()).toEqual(['Files*', 'Terminal', 'Browser', 'Share']);
      expect(host.querySelector('[data-testid="files"]')!.getAttribute('data-space')).toBe('notes');
    } finally {
      spacesMock.current = true;
      spacesMock.index = new Map([['box-1', ['notes']]]);
    }
  });

  it('keeps Agents beside an agent with no space while the spaces reload for another new box', () => {
    const lone = project({ id: 'lone', instanceId: 'box-9' });
    render(lone, { ...DEFAULT_SIDE_PANEL, open: true, tab: 'files' }, { files: { agent: lone } });
    expect(tabs()).toEqual(['Agents*', 'Terminal', 'Browser', 'Share']);
    spacesMock.current = false;
    try {
      render(lone, { ...DEFAULT_SIDE_PANEL, open: true, tab: 'files' }, { files: { agent: lone } });
      expect(tabs()).toEqual(['Agents*', 'Terminal', 'Browser', 'Share']);
    } finally {
      spacesMock.current = true;
    }
  });

  it('keeps Agents for a no-space session opened during a reload, after a session in a space was the one open', () => {
    const inSpace = project({ id: 'in', instanceId: 'box-1' });
    const lone = project({ id: 'lone77', instanceId: 'box-77' });
    spacesMock.rows = [{ instanceId: 'box-1' }, { instanceId: 'box-77' }];
    try {
      render(inSpace, { ...DEFAULT_SIDE_PANEL, open: true, tab: 'files' }, { files: { agent: inSpace } });
      expect(tabs()).toEqual(['Files*', 'Terminal', 'Browser', 'Share']);
      spacesMock.current = false;
      render(lone, { ...DEFAULT_SIDE_PANEL, open: true, tab: 'files' }, { files: { agent: lone } });
      expect(tabs()).toEqual(['Agents*', 'Terminal', 'Browser', 'Share']);
    } finally {
      spacesMock.current = true;
      spacesMock.rows = [];
    }
  });

  it('has Agents alone on a new tab on the agents in no space', () => {
    render(undefined, { ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' }, { files: { space: '(none)' } });
    expect(tabs()).toEqual(['Agents*']);
    expect(host.querySelector('[data-testid="agents"]')).not.toBeNull();
  });

  it('has no Files with none given (the side panel flag off is no panel at all), and shows Terminal for a remembered Files', () => {
    render(project(), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'files' }, { files: null });
    expect(tabs()).toEqual(['Terminal*', 'Browser', 'Share']);
    expect(host.querySelector('[data-testid="terminal"]')).not.toBeNull();
  });

  it('switches to Files from its tab, and says when something was picked', () => {
    const onChange = vi.fn();
    const onPicked = vi.fn();
    const state = { ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' as const };
    render(project(), state, { files: { agent: project() }, onChange, onPicked });
    act(() => (host.querySelector('[role="tab"]') as HTMLButtonElement).click());
    expect(onChange).toHaveBeenCalledWith({ ...state, tab: 'files' });
    render(project(), { ...state, tab: 'files' }, { files: { agent: project() }, onChange, onPicked });
    act(() => (host.querySelector('[data-testid="files"]') as HTMLButtonElement).click());
    expect(onPicked).toHaveBeenCalled();
  });
});

describe('SidePanel Share', () => {
  it('offers Share beside the owner\'s session, and mounts the share for its workstream', () => {
    render(project(), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'share' }, { workstream: 'feature-x' });
    expect(tabs()).toEqual(['Terminal', 'Browser', 'Share*']);
    const share = host.querySelector('[data-testid="share"]')!;
    expect(share.getAttribute('data-project')).toBe('p1');
    expect(share.getAttribute('data-ws')).toBe('feature-x');
    expect(host.querySelector('[data-testid="terminal"]')).toBeNull();
  });

  it('has no Share for a collaborator, and shows Terminal for a remembered Share', () => {
    render(project({ role: 'collaborator' }), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'share' });
    expect(tabs()).toEqual(['Terminal*', 'Browser']);
    expect(host.querySelector('[data-testid="share"]')).toBeNull();
  });

  it('shares nothing while the session is set up', () => {
    render(project({ setupStatus: 'cloning' }), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'share' });
    expect(host.querySelector('[data-testid="share"]')).toBeNull();
    expect(host.textContent).toContain('Sharing opens once the session is set up.');
  });

  it('switches to Share from its tab', () => {
    const onChange = vi.fn();
    const state = { ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' as const };
    render(project(), state, { onChange });
    act(() => ([...host.querySelectorAll('[role="tab"]')].find(t => t.textContent === 'Share') as HTMLButtonElement).click());
    expect(onChange).toHaveBeenCalledWith({ ...state, tab: 'share' });
  });
});
