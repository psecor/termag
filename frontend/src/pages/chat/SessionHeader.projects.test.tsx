// @vitest-environment jsdom
// A session's header under user-projects-enabled:
// project ▸ title, the branch and PR chips, no space, checkout or repo chip; the project
// reveals its group in the sidebar; a session with no project yet reads as before.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import { REVEAL_PROJECT_EVENT } from '../../chat/revealProject';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';
import { ProjectCrumb, SessionHeader, type SessionHeaderProps } from './SessionHeader';

const mocks = vi.hoisted(() => ({
  on: true,
  own: { 'p1': { id: 'up-1', name: 'Termag web' } } as Record<string, { id: string; name: string }>,
  pr: null as null | { repo: string; number: number; title: string; url: string | null },
  prOn: [] as boolean[],
}));
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (key === 'user-projects-enabled' ? mocks.on as T : fallback) };
});
vi.mock('./simpleData', () => ({
  useSimpleDataIfAny: () => ({ userProjectOf: (id: string) => mocks.own[id] ?? null }),
}));
vi.mock('./useSessionPr', () => ({
  useSessionPrRow: (_p: string, _w: string, on: boolean) => { mocks.prOn.push(on); return on ? mocks.pr : null; },
}));
vi.mock('../../chat/useChatSpaces', () => ({
  useSharedChatSpaces: () => ({ loaded: true, current: true, spaces: [{ id: 's-notes', name: 'notes' }], index: new Map([['box-1', ['notes']]]), colorOf: () => '#888888' }),
}));
vi.mock('../../components/BoxPill', () => ({ BoxPill: ({ label }: { label: string }) => <span className="box-pill">{label}</span> }));

const project = {
  id: 'p1', name: 'termag-1', instanceId: 'box-1', role: 'owner', ownerUsername: 'ada', repoUrl: 'https://github.com/example-org/termag.git',
  repoDefaultBranch: 'main',
  workstreams: [{ name: 'main', sessionTitle: 'Sidebar groups by project', spaceId: 's-notes' }, { name: 'fix', branch: 'fix-pills', sessionTitle: 'Fix the PR pills' }],
} as unknown as Project;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (!css?.escape) (globalThis as { CSS?: unknown }).CSS = { ...css, escape: (v: string) => v.replace(/[^\w-]/g, c => `\\${c}`) };
  mocks.on = true;
  mocks.pr = null;
  mocks.prOn = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function show(props: Partial<SessionHeaderProps> = {}, chrome: Partial<ChatChrome> = {}) {
  const value: ChatChrome = {
    mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, refresh: true,
    sidePanel: { open: false, toggle: () => {} }, ...chrome,
  };
  const all: SessionHeaderProps = {
    project, workstream: 'main', repo: 'example-org/termag', box: { name: 'box-1' }, working: false, opening: false, onOpenFull: () => {},
    archive: null, ...props,
  };
  act(() => root.render(<ChatChromeProvider value={value}><header><SessionHeader {...all} /></header></ChatChromeProvider>));
}

const press = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };

describe('SessionHeader under user-projects-enabled', () => {
  it('reads project ▸ title, with no space, checkout or repo chip, and the box on the right', () => {
    show();
    const title = host.querySelector('.chat-title')!;
    expect(title.querySelector('.chat-title-crumb')?.textContent).toBe('Termag web');
    expect(title.querySelector('.chat-crumb-chevron')?.textContent).toBe('▸');
    expect(title.querySelector('.chat-title-name')?.textContent).toBe('Sidebar groups by project');
    expect(title.querySelector('.chat-title-space')).toBeNull();
    expect(title.querySelector('.chat-title-repo')).toBeNull();
    expect(title.textContent).not.toContain('termag-1');
    expect(host.querySelector('.chat-header-actions .box-pill')?.textContent).toBe('box-1');
  });

  it("shows the branch when it isn't the default, and the session's PR, which opens its pull request tab", async () => {
    mocks.pr = { repo: 'example-org/termag', number: 1801, title: 'Sidebar groups by project', url: 'https://github.com/example-org/termag/pull/1801' };
    const show2 = vi.fn();
    show({ workstream: 'fix' }, { sidePanel: { open: false, toggle: () => {}, show: show2 } });
    expect(host.querySelector('.chat-title-branch')?.textContent).toBe('fix-pills');
    const pr = host.querySelector('.chat-title-pr')!;
    expect(pr.textContent).toBe('termag#1801');
    expect(pr.getAttribute('aria-label')).toBe('Pull request termag#1801: Sidebar groups by project');
    await press(pr);
    expect(show2).toHaveBeenCalledWith('pr');
    expect(mocks.prOn.every(Boolean)).toBe(true);
  });

  it('reveals the project in the sidebar, opening it first where it is a drawer', async () => {
    const revealed: string[] = [];
    const onReveal = (e: Event) => revealed.push((e as CustomEvent<{ userProjectId: string }>).detail.userProjectId);
    window.addEventListener(REVEAL_PROJECT_EVENT, onReveal);
    try {
      const openHistory = vi.fn();
      show({}, { openHistory });
      await press(host.querySelector('.chat-title-crumb')!);
      expect(revealed).toEqual(['up-1']);
      expect(openHistory).not.toHaveBeenCalled();
      act(() => root.render(
        <ChatChromeProvider value={{ mode: 'drawer', historyOpen: false, openHistory, closeHistory: () => {} }}>
          <ProjectCrumb project={{ id: 'up-1', name: 'Termag web' }} />
        </ChatChromeProvider>,
      ));
      await press(host.querySelector('.chat-title-crumb')!);
      expect(openHistory).toHaveBeenCalledTimes(1);
      expect(revealed).toEqual(['up-1', 'up-1']);
    } finally {
      window.removeEventListener(REVEAL_PROJECT_EVENT, onReveal);
    }
  });

  it('reveals the project in the one list, a kept Tabs notwithstanding (the redesign has no Tabs view), and the list takes the reveal as it mounts', async () => {
    const { setSidebarView, resetSidebarViewForTests } = await import('../../chat/sidebarView');
    const { takePendingReveal } = await import('../../chat/revealProject');
    localStorage.clear();
    resetSidebarViewForTests();
    setSidebarView({ show: 'tabs' });
    show();
    await press(host.querySelector('.chat-title-crumb')!);
    // Under the flag a kept Tabs is every session already: nothing to switch.
    expect(JSON.parse(localStorage.getItem('termag.chat.sidebarView')!).show).toBe('tabs');
    expect(takePendingReveal()).toBe('up-1');
    expect(takePendingReveal()).toBeNull();
    resetSidebarViewForTests();
    localStorage.clear();
  });

  it('reads as before for a session with no project yet, and with the flag off, reading no PR', () => {
    for (const setup of [() => { mocks.own = {}; }, () => { mocks.own = { p1: { id: 'up-1', name: 'Termag web' } }; mocks.on = false; }]) {
      setup();
      mocks.prOn = [];
      show();
      expect(host.querySelector('.chat-title-crumb')).toBeNull();
      expect(host.querySelector('.chat-title-space')?.textContent).toContain('notes');
      expect(host.querySelector('.chat-title-repo')?.textContent).toBe('example-org/termag');
      expect(host.querySelector('.chat-title-project')?.textContent).toBe('termag-1');
      expect(mocks.prOn.some(Boolean)).toBe(false);
    }
    mocks.own = { p1: { id: 'up-1', name: 'Termag web' } };
  });
});
