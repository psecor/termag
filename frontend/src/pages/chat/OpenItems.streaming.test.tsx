// @vitest-environment jsdom
// The sidebar's menus stay open while an agent streams: its status and title
// arrive through the projects context and its output scrolls the chat's
// transcript, and neither closes a menu (ContextMenu.tsx). Escape still does.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import { statusKey } from '../../utils/statusKey';
import { sessionName } from '../../utils/sessionName';
import { spaceColor } from '../../chat/spaceColors';
import { useFollowBottom } from '../../chat/useFollowBottom';
import { ChatSidebar } from './ChatSidebar';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';
import { SimpleDataProvider } from './simpleData';
import { resetSidebarViewForTests } from '../../chat/sidebarView';

const mocks = vi.hoisted(() => ({
  projects: [] as Project[],
  status: {} as Record<string, { status: string; updatedAt?: string }>,
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
    index: new Map([['box-a', ['notes']], ['box-b', ['notes']]]),
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
  const on = new Set<string>();
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (on.has(key) ? true as T : fallback) };
});

function project(id: string, title: string | null): Project {
  return {
    id, name: id, instanceId: `box-${id}`, archived: false, pinned: false, lastActiveAt: '2026-10-30T12:00:00Z',
    workflows: [{ type: 'agent' }],
    workstreams: [{ id: `w-${id}`, projectId: id, name: 'main', branch: 'main', archived: false, sessionTitle: title }],
  } as unknown as Project;
}
const key = (id: string) => statusKey(`box-${id}`, sessionName('ada', id, 'agent', 'main'));

/** The open chat's transcript, kept at its newest line as a chat's is (useFollowBottom). */
function Transcript({ lines }: { lines: string[] }) {
  const { scroller, onScroll } = useFollowBottom(lines.length, 'chat-a');
  return <div ref={scroller} className="chat-transcript" onScroll={onScroll}>{lines.map((l, i) => <p key={i}>{l}</p>)}</div>;
}

let root: Root;
let host: HTMLDivElement;
let lines: string[];

async function render() {
  const chrome: ChatChrome = { mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, refresh: true };
  await act(async () => root.render(
    <ChatChromeProvider value={chrome}>
      <MemoryRouter initialEntries={['/chat']}>
        <SimpleDataProvider><ChatSidebar /><Transcript lines={lines} /></SimpleDataProvider>
      </MemoryRouter>
    </ChatChromeProvider>,
  ));
  await act(async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)); });
}

/**
 * The agent prints another message: its status moves on, its session gets a
 * title, and the transcript grows and follows it down (a real browser fires
 * the scroll that follows; jsdom has no layout, so the test fires it).
 */
async function stream(n: number) {
  for (let i = 0; i < n; i++) {
    lines = [...lines, `step ${lines.length + 1}`];
    mocks.status = { ...mocks.status, [key('a')]: { status: 'working', updatedAt: new Date(Date.now() - i).toISOString() } };
    mocks.projects = [project('a', `Survey, step ${lines.length}`), project('b', null)];
    await render();
    act(() => { host.querySelector('.chat-transcript')!.dispatchEvent(new Event('scroll')); });
  }
}

const menu = () => document.querySelector('.chat-ctx-menu');
const item = (name: string) => [...host.querySelectorAll<HTMLAnchorElement>('a.chat-item')].find(a => a.querySelector('.chat-item-name')!.textContent?.startsWith(name))!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  resetSidebarViewForTests();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  lines = ['step 1'];
  mocks.projects = [project('a', null), project('b', null)];
  mocks.status = { [key('a')]: { status: 'working', updatedAt: new Date().toISOString() } };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the sidebar's menus while an agent streams", () => {
  const opens: Array<[string, () => void, string]> = [
    ["a space's ⋮", () => host.querySelector<HTMLElement>('.chat-group[data-group="notes"] .chat-group-menu')!.click(), 'notes'],
    ["a tab's ⋮", () => host.querySelector<HTMLElement>('button[aria-label="Options for b"]')!.click(), 'b'],
    ["a tab's right click", () => item('b').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })), 'b'],
  ];

  for (const [what, open, label] of opens) {
    it(`keeps ${what} menu open through new output`, async () => {
      await render();
      act(open);
      expect(menu()!.getAttribute('aria-label')).toBe(label);
      const row = menu()!;
      await stream(5);
      // The same menu, never closed and reopened.
      expect(menu()).toBe(row);
      // And the sidebar did take the updates: a's row has its session's newest title.
      expect(item('Survey, step 6')).toBeTruthy();
      act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
      expect(menu()).toBeNull();
    });
  }
});
