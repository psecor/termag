// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import { DEFAULT_SIDE_PANEL, type SidePanelState } from '../../chat/sidePanel';

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { unixUsername: 'ada' } }) }));
vi.mock('../../hooks/useSetupContext', () => ({ useSetupContext: () => ({}) }));
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: (key: string, fallback: unknown) => (key === actual.FLAGS.browserPane ? true : fallback) };
});
vi.mock('../../components/Terminal', () => ({
  Terminal: ({ sessionName }: { sessionName: string }) => <div data-testid="terminal">{sessionName}</div>,
}));
vi.mock('../../components/BrowserPane', () => ({ BrowserPane: () => <div data-testid="browser" /> }));
vi.mock('./FileExplorer', () => ({
  ExplorerPanel: (p: { space: string; activePath?: string; activeAgent?: { projectId: string }; onPicked?: () => void }) => (
    <button type="button" data-testid="files" data-space={p.space} data-path={p.activePath ?? ''} data-agent={p.activeAgent?.projectId ?? ''} onClick={p.onPicked} />
  ),
}));
vi.mock('./simpleData', () => ({
  useSimpleDataIfAny: () => ({
    items: { state: { items: [] } }, activeTab: null,
    spaces: { loaded: true, spaces: [{ name: 'notes' }], index: new Map([['box-1', ['notes']]]) },
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
    expect(tabs()).toEqual(['Files*', 'Terminal', 'Browser']);
    expect(host.querySelector('[data-testid="files"]')?.getAttribute('data-agent')).toBe('p1');
    render(project(), { ...DEFAULT_SIDE_PANEL, open: true, tab: 'terminal' }, { files: { agent: project() } });
    expect(tabs()).toEqual(['Files', 'Terminal*', 'Browser']);
  });

  it('has no Files beside an agent with no space, and shows Terminal for a remembered Files', () => {
    const lone = project({ instanceId: 'box-9' });
    render(lone, { ...DEFAULT_SIDE_PANEL, open: true, tab: 'files' }, { files: { agent: lone } });
    expect(tabs()).toEqual(['Terminal*', 'Browser']);
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
