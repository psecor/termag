// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceView } from '../../services/api';
import type { Project } from '../../types';
import { publishChatStatus } from '../../chat/chatLiveStatus';
import { COLLAPSED_SPACES_KEY } from '../../chat/chatSpaces';
import { spaceColor } from '../../chat/spaceColors';
import { setFlagValues } from '../../flags';
import { ChatSidebar } from './ChatSidebar';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';

function space(name: string, role: SpaceView['role'], readOnly = false): SpaceView {
  return { id: `id-${name}`, name, description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role, readOnly };
}

function project(id: string, instanceId: string): Project {
  return {
    id, name: id, instanceId, archived: false, pinned: false, lastActiveAt: null,
    workflows: [{ type: 'agent' }], workstreams: [],
  } as unknown as Project;
}

const mocks = vi.hoisted(() => ({
  projects: [] as Project[],
  spaces: [] as SpaceView[],
  index: new Map<string, string[]>(),
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { unixUsername: 'ada' } }) }));
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ projects: mocks.projects, statusMap: {} }) }));
const noBoxes: never[] = [];
vi.mock('../../services/boxFeed', () => ({
  boxFeed: { subscribe: () => () => {}, getSnapshot: () => noBoxes },
}));
vi.mock('../../chat/useChatSpaces', () => ({
  useSharedChatSpaces: () => ({ enabled: true, loaded: true, current: true, spaces: mocks.spaces, index: mocks.index, colorOf: spaceColor }),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  root = createRoot(host);
  localStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
});

describe('ChatSidebar', () => {
  it('names the list Sessions and offers a new one when none exist', () => {
    mocks.projects = [];
    mocks.spaces = [];
    mocks.index = new Map();
    act(() => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));
    expect(host.querySelector('nav')?.getAttribute('aria-label')).toBe('Sessions');
    expect(host.querySelector('.chat-new')?.firstChild?.textContent).toBe('New session');
    expect(host.querySelector('.chat-list-empty')?.textContent).toBe('No sessions yet.');
  });

  it('offers + only on spaces a new chat can go in', () => {
    mocks.projects = [project('a', 'box-a'), project('b', 'box-b'), project('c', 'box-c')];
    mocks.spaces = [space('mine', 'editor'), space('theirs', 'viewer'), space('frozen', 'owner', true)];
    mocks.index = new Map([['box-a', ['mine']], ['box-b', ['theirs']], ['box-c', ['frozen']]]);
    act(() => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));

    const plus = [...host.querySelectorAll('a.chat-group-new')].map(a => a.getAttribute('aria-label'));
    expect(plus).toEqual(['New session in mine']);
    expect(host.querySelector('.chat-new')?.firstChild?.textContent).toBe('New session');
    // The shortcut's hint sits in the button, hidden from screen readers (chat/shortcuts.ts).
    expect(host.querySelector('.chat-new .chat-new-kbd')?.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('nav')?.getAttribute('aria-label')).toBe('Sessions');
    const heads = [...host.querySelectorAll('.chat-group-name')].map(n => n.textContent);
    expect(heads).toEqual(['frozen', 'mine', 'theirs']);
  });

  it('titles each one-line subtitle with its full text', () => {
    mocks.projects = [project('a', 'box-a')];
    mocks.spaces = [space('mine', 'editor'), space('theirs', 'editor')];
    mocks.index = new Map([['box-a', ['mine', 'theirs']]]);
    const state = 'Thinking about the migration and every table it touches…';
    const preview = 'I will start with the users table, then the sessions.';
    publishChatStatus('a|main', { tone: 'working', text: state, preview });
    try {
      act(() => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));
      const title = (sel: string) => host.querySelector(sel)?.getAttribute('title');
      expect(title('.chat-row-state')).toBe(state);
      expect(title('.chat-row-msg')).toBe(preview);
      expect(title('.chat-row-also')).toBe('also in theirs');
    } finally {
      act(() => publishChatStatus('a|main', null));
    }
  });

  it('leads with Claude\'s title for the session when titles are on, the project and workstream under it', () => {
    const titled = (id: string, ws: string, title: string | null) => ({
      ...project(id, 'box-a'),
      workstreams: [{ id: `${id}-${ws}`, projectId: id, name: ws, branch: ws, archived: false, sessionTitle: title }],
    } as unknown as Project);
    mocks.projects = [titled('termag', 'fix-auth', 'Login rate limiting'), titled('notes', 'main', null)];
    mocks.spaces = [];
    mocks.index = new Map();
    const rows = () => [...host.querySelectorAll('.chat-row')].map(r => [
      r.querySelector('.chat-row-name')!.textContent, r.querySelector('.chat-row-where')?.textContent ?? null,
    ]);
    setFlagValues({ 'simple-ui-session-titles-enabled': true });
    try {
      act(() => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));
      expect(rows()).toEqual([['Login rate limiting', 'termag · fix-auth'], ['notes', null]]);
      expect(host.querySelector('.chat-row-name')?.getAttribute('title')).toBe('Login rate limiting');
      expect(host.querySelector('.chat-row-where')?.getAttribute('title')).toBe('termag · fix-auth');
    } finally {
      setFlagValues(undefined);
    }
    act(() => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));
    expect(rows()).toEqual([['termag · fix-auth', null], ['notes', null]]);
  });

  it('keeps a docked list in the tab order and drops a closed phone drawer', () => {
    mocks.projects = [project('a', 'box-a')];
    mocks.spaces = [];
    mocks.index = new Map();
    const chrome = (mode: ChatChrome['mode'], historyOpen: boolean): ChatChrome => ({
      mode, historyOpen, openHistory: () => {}, closeHistory: () => {},
    });
    act(() => root.render(
      <ChatChromeProvider value={chrome('docked', false)}><MemoryRouter><ChatSidebar /></MemoryRouter></ChatChromeProvider>,
    ));
    const nav = () => host.querySelector('nav')!;
    expect(nav().hasAttribute('inert')).toBe(false);
    expect(nav().getAttribute('aria-hidden')).toBeNull();

    act(() => root.render(
      <ChatChromeProvider value={chrome('drawer', false)}><MemoryRouter><ChatSidebar /></MemoryRouter></ChatChromeProvider>,
    ));
    expect(nav().hasAttribute('inert')).toBe(true);
    expect(nav().getAttribute('aria-hidden')).toBe('true');

    act(() => root.render(
      <ChatChromeProvider value={chrome('drawer', true)}><MemoryRouter><ChatSidebar /></MemoryRouter></ChatChromeProvider>,
    ));
    expect(nav().hasAttribute('inert')).toBe(false);
    expect(nav().getAttribute('aria-hidden')).toBeNull();
  });

  it('colours each space group, and marks No space neutral', () => {
    mocks.projects = [project('a', 'box-a'), project('b', 'box-b')];
    mocks.spaces = [space('mine', 'editor')];
    mocks.index = new Map([['box-a', ['mine']]]);
    act(() => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));
    const [mine, none] = [...host.querySelectorAll<HTMLElement>('.chat-group')];
    expect(mine.style.getPropertyValue('--space-color')).toBe(spaceColor('mine').hex);
    expect(mine.querySelector('.space-swatch')?.hasAttribute('data-space')).toBe(false);
    expect(none.dataset.space).toBe('none');
    expect(none.style.getPropertyValue('--space-color')).toBe('');
    expect(none.querySelector('.space-swatch')?.getAttribute('data-space')).toBe('none');
    expect(none.querySelector('.chat-group-count')?.textContent).toBe('1');
  });

  it('folds a group, remembers it, and keeps the open session showing', () => {
    mocks.projects = [project('a', 'box-a'), project('b', 'box-a'), project('c', 'box-c')];
    mocks.spaces = [space('mine', 'editor')];
    mocks.index = new Map([['box-a', ['mine']]]);
    const names = () => [...host.querySelectorAll('.chat-row-name')].map(n => n.textContent);
    act(() => root.render(<MemoryRouter initialEntries={['/chat/p/b']}><ChatSidebar /></MemoryRouter>));
    expect(names()).toEqual(['a', 'b', 'c']);

    const toggle = host.querySelector<HTMLButtonElement>('.chat-group-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(names()).toEqual(['b', 'c']);
    expect(JSON.parse(localStorage.getItem(COLLAPSED_SPACES_KEY)!)).toEqual(['mine']);

    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));
    expect(names()).toEqual(['c']);
    expect(host.querySelector('#chat-group-s-mine')?.hasAttribute('hidden')).toBe(true);
  });
});
