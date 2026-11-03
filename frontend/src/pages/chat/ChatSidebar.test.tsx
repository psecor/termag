// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceView } from '../../services/api';
import type { AgentStatus, Project } from '../../types';
import { sessionName } from '../../utils/sessionName';
import { statusKey } from '../../utils/statusKey';
import { publishChatStatus } from '../../chat/chatLiveStatus';
import { COLLAPSED_SPACES_KEY } from '../../chat/chatSpaces';
import { spaceColor } from '../../chat/spaceColors';
import { setFlagValues } from '../../flags';
import { resetUnfoldedRuns } from '../../chat/automationRunGroups';
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
  statusMap: {} as Record<string, AgentStatus>,
  links: [] as Array<{ projectId: string; workstream: string; parentProjectId: string; parentWorkstream: string }>,
  boxes: [] as Array<{ id: string; name: string }>,
}));

vi.mock('../../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  spawnsApi: { parents: async () => ({ links: mocks.links }) },
  automationsApi: { list: async () => [] },
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { unixUsername: 'ada' } }) }));
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ projects: mocks.projects, statusMap: mocks.statusMap }) }));
vi.mock('../../services/boxFeed', () => ({
  boxFeed: { subscribe: () => () => {}, getSnapshot: () => mocks.boxes },
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
  mocks.statusMap = {};
  mocks.links = [];
  mocks.boxes = [];
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
    expect(host.querySelector('.chat-new')?.getAttribute('aria-label')).toBe('New session');
    expect(host.querySelector('.chat-list-empty')?.textContent).toBe('No sessions yet.');
  });

  it('keeps the three-line list for a user with no spaces while simple-ui-side-panel-enabled is off', () => {
    mocks.projects = [project('a', 'box-a')];
    mocks.spaces = [];
    mocks.index = new Map();
    act(() => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));
    expect(host.querySelector('.chat-items')).toBeNull();
    expect(host.querySelector('.chat-row .chat-row-state')).not.toBeNull();
  });

  it('offers + only on spaces a new chat can go in', () => {
    mocks.projects = [project('a', 'box-a'), project('b', 'box-b'), project('c', 'box-c')];
    mocks.spaces = [space('mine', 'editor'), space('theirs', 'viewer'), space('frozen', 'owner', true)];
    mocks.index = new Map([['box-a', ['mine']], ['box-b', ['theirs']], ['box-c', ['frozen']]]);
    act(() => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));

    const plus = [...host.querySelectorAll('a.chat-group-new')].map(a => a.getAttribute('aria-label'));
    expect(plus).toEqual(['New session in mine']);
    // New session is an icon button named for screen readers, its shortcut's hint beside it,
    // outside the button and hidden from screen readers (chat/shortcuts.ts).
    const start = host.querySelector('.chat-new')!;
    expect(start.getAttribute('aria-label')).toBe('New session');
    expect(start.textContent).toBe('');
    expect(start.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const kbd = host.querySelector('.chat-new-wrap > .chat-new-kbd')!;
    expect(kbd.getAttribute('aria-hidden')).toBe('true');
    expect(kbd.nextElementSibling).toBe(start);
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

  it('puts a reference to the session on a row\'s drag with chat-session-references-enabled', () => {
    mocks.projects = [{
      ...project('termag', 'box-a'),
      workstreams: [{ id: 'termag-fix', projectId: 'termag', name: 'fix-auth', branch: 'fix-auth', archived: false, sessionTitle: 'Login rate limiting' }],
    } as unknown as Project];
    mocks.spaces = [];
    mocks.index = new Map();
    mocks.boxes = [{ id: 'box-a', name: 'devbox' }];
    const dragStart = () => {
      const data: Record<string, string> = {};
      const e = new Event('dragstart', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: { setData: (t: string, v: string) => { data[t] = v; } } });
      act(() => { host.querySelector('a.chat-row')!.dispatchEvent(e); });
      return data;
    };
    act(() => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));
    expect(dragStart()).toEqual({});
    setFlagValues({ 'chat-session-references-enabled': true, 'simple-ui-session-titles-enabled': true });
    try {
      act(() => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));
      expect(JSON.parse(dragStart()['application/x-termag-session-ref'])).toEqual({ text: '@"Login rate limiting" (termag ask devbox/termag@fix-auth)' });
    } finally {
      setFlagValues(undefined);
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

  it('nests an ask under the session that sent it, by its title, and folds it', () => {
    const ws = (name: string, askThread?: unknown) => ({ id: name, name, archived: false, createdAt: '2026-10-26T10:00:00Z', askThread });
    mocks.projects = [
      { ...project('orch', 'box-a'), name: 'termag-3', workstreams: [ws('main')] },
      { ...project('b2', 'box-b'), name: 'termag-3', workstreams: [ws('ask-cmvpvqxse19rwex4apfh334ld', { id: 'cmvpvqxse19rwex4apfh334ld', title: 'Readable names', parentProjectId: 'orch', parentWorkstream: 'main' })] },
      { ...project('old', 'box-c'), name: 'termag-3', workstreams: [ws('ask-cmvpvqyum19sbex4axk6m62o8', { id: 'cmvpvqyum19sbex4axk6m62o8', title: 'Before parents', parentProjectId: null, parentWorkstream: null })] },
    ] as unknown as Project[];
    mocks.spaces = [];
    mocks.index = new Map();
    act(() => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));
    const rows = () => [...host.querySelectorAll('.chat-list > li')].map(li => `${(li as HTMLElement).style.getPropertyValue('--chat-depth') || '0'} ${li.querySelector('.chat-row-name')?.textContent}`);
    expect(rows()).toContain('1 Readable names');
    expect(rows()).toContain('0 Before parents');
    expect(rows().indexOf('1 Readable names')).toBe(rows().indexOf('0 termag-3') + 1);
    const twisty = host.querySelector<HTMLButtonElement>('.chat-twisty')!;
    expect(twisty.getAttribute('aria-expanded')).toBe('true');
    act(() => twisty.click());
    expect(rows()).not.toContain('1 Readable names');
    expect(host.querySelector('.chat-row-folded')?.textContent).toBe('1 folded');
  });

  it('folds an automation\'s runs into one row, with the latest run\'s status, unfolded when a run is open', () => {
    const ws = (name: string) => ({ id: name, name, archived: false, createdAt: '2026-10-28T10:00:00Z' });
    mocks.projects = [
      { ...project('t5', 'box-a'), name: 'termag-5', workstreams: [ws('main')] },
      { ...project('babysit', 'box-a'), name: 'pr-babysitter', kind: 'automation', workstreams: [ws('main'), ws('run-20261028-1800'), ws('run-20261028-1830')] },
    ] as unknown as Project[];
    mocks.spaces = [];
    mocks.index = new Map();
    mocks.statusMap = {
      [statusKey('box-a', sessionName('ada', 'pr-babysitter', 'agent', 'run-20261028-1830'))]: { status: 'working', updatedAt: '2026-10-28T18:30:00Z' } as AgentStatus,
    };
    const names = () => [...host.querySelectorAll('.chat-list > li')].map(li => `${(li as HTMLElement).style.getPropertyValue('--chat-depth') || '0'} ${li.querySelector('.chat-row-name')?.textContent ?? li.textContent}`);
    const head = () => host.querySelector<HTMLButtonElement>('.chat-runs-head')!;
    act(() => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));
    expect(names()).toEqual(expect.arrayContaining(['0 pr-babysitter', '0 termag-5']));
    expect(names().some(n => n.includes('run-2026'))).toBe(false);
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(head().querySelector('.chat-glyph')!.getAttribute('data-status')).toBe('working');
    expect(head().querySelector('.chat-group-count')!.textContent).toBe('2');
    act(() => head().click());
    expect(names().filter(n => n.startsWith('1 '))).toHaveLength(2);

    resetUnfoldedRuns();
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<MemoryRouter initialEntries={['/chat/p/babysit?ws=run-20261028-1800']}><ChatSidebar /></MemoryRouter>));
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.chat-row.active')?.closest('li')?.style.getPropertyValue('--chat-depth')).toBe('1');
  });

  // Bugbot on #894: a run's asks and spawned agents were left after the group, out of their run.
  it('keeps an agent a run started under that run, inside the automation\'s row', async () => {
    const ws = (name: string) => ({ id: name, name, archived: false, createdAt: '2026-10-28T10:00:00Z' });
    mocks.projects = [
      { ...project('kid', 'box-b'), name: 'helper', workstreams: [ws('main')] },
      { ...project('babysit', 'box-a'), name: 'pr-babysitter', kind: 'automation', workstreams: [ws('main'), ws('run-20261028-1800'), ws('run-20261028-1830')] },
    ] as unknown as Project[];
    mocks.spaces = [];
    mocks.index = new Map();
    mocks.links = [{ projectId: 'kid', workstream: 'main', parentProjectId: 'babysit', parentWorkstream: 'run-20261028-1800' }];
    resetUnfoldedRuns();
    const names = () => [...host.querySelectorAll('.chat-list > li')].map(li => `${(li as HTMLElement).style.getPropertyValue('--chat-depth') || '0'} ${li.querySelector('.chat-row-name')?.textContent ?? li.textContent}`);
    await act(async () => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    // Folded, the automation's row holds the run and what it started.
    expect(names()).toEqual(['0 pr-babysitter']);
    act(() => host.querySelector<HTMLButtonElement>('.chat-runs-head')!.click());
    expect(names()).toEqual(['0 pr-babysitter', expect.stringMatching(/^1 .*18:30$/), expect.stringMatching(/^1 .*18:00$/), '2 helper']);
  });

  // Bugbot on #743: in the space groups the tree is built over { row, alsoIn }, and the folded
  // parent read those wrappers as rows, so it never said how many of its sessions need you.
  it.each([
    ['in the plain list', [] as SpaceView[]],
    ['in a space group', [space('mine', 'editor')]],
  ])('a folded parent says how many of the sessions it hides need you, %s', (_where, spaces) => {
    const ws = (name: string, askThread?: unknown) => ({ id: name, name, archived: false, createdAt: '2026-10-26T10:00:00Z', askThread });
    const ask = (id: string, title: string) => ws(`ask-${id}`, { id, title, parentProjectId: 'orch', parentWorkstream: 'main' });
    mocks.projects = [
      { ...project('orch', 'box-a'), name: 'termag-3', workstreams: [ws('main')] },
      { ...project('b2', 'box-b'), name: 'termag-3', workstreams: [ask('cmvpvqxse19rwex4apfh334ld', 'Waits on you')] },
      { ...project('b3', 'box-c'), name: 'termag-3', workstreams: [ask('cmvpvqyum19sbex4axk6m62o8', 'Just working')] },
    ] as unknown as Project[];
    mocks.spaces = spaces;
    mocks.index = new Map(spaces.length ? [['box-a', ['mine']], ['box-b', ['mine']], ['box-c', ['mine']]] : []);
    const at = '2026-10-26T10:05:00Z';
    mocks.statusMap = {
      [statusKey('box-b', sessionName('ada', 'termag-3', 'agent', 'ask-cmvpvqxse19rwex4apfh334ld'))]: { status: 'waiting', waitingReason: 'approval', updatedAt: at } as AgentStatus,
      [statusKey('box-c', sessionName('ada', 'termag-3', 'agent', 'ask-cmvpvqyum19sbex4axk6m62o8'))]: { status: 'working', updatedAt: at } as AgentStatus,
    };
    act(() => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));
    const twisty = host.querySelector<HTMLButtonElement>('.chat-twisty')!;
    act(() => twisty.click());
    expect(host.querySelector('.chat-row-folded')?.textContent).toBe('2 folded · 1 needs you');
  });

  // Bugbot on #743: a parent folded in storage stays open while one of its children is the open
  // session. Nothing is hidden then, so the row must not say "N folded" and its caret is open.
  it.each([
    ['in the plain list', [] as SpaceView[]],
    ['in a space group', [space('mine', 'editor')]],
  ])('a folded parent kept open for the open child says nothing is folded, %s', (_where, spaces) => {
    const ws = (name: string, askThread?: unknown) => ({ id: name, name, archived: false, createdAt: '2026-10-26T10:00:00Z', askThread });
    const ask = (id: string, title: string) => ws(`ask-${id}`, { id, title, parentProjectId: 'orch', parentWorkstream: 'main' });
    mocks.projects = [
      { ...project('orch', 'box-a'), name: 'termag-3', workstreams: [ws('main')] },
      { ...project('b2', 'box-b'), name: 'termag-3', workstreams: [ask('cmvpvqxse19rwex4apfh334ld', 'The open one')] },
      { ...project('b3', 'box-c'), name: 'termag-3', workstreams: [ask('cmvpvqyum19sbex4axk6m62o8', 'Its sibling')] },
    ] as unknown as Project[];
    mocks.spaces = spaces;
    mocks.index = new Map(spaces.length ? [['box-a', ['mine']], ['box-b', ['mine']], ['box-c', ['mine']]] : []);
    localStorage.setItem('termag.chat.foldedAgents', JSON.stringify(['orch|main']));
    act(() => root.render(<MemoryRouter initialEntries={['/chat/p/b2?ws=ask-cmvpvqxse19rwex4apfh334ld']}><ChatSidebar /></MemoryRouter>));
    const names = [...host.querySelectorAll('.chat-row-name')].map(n => n.textContent);
    expect(names).toContain('The open one');
    expect(names).toContain('Its sibling');
    expect(host.querySelector('.chat-row-folded')).toBeNull();
    expect(host.querySelector('.chat-twisty')!.getAttribute('aria-expanded')).toBe('true');
  });

  // The person on #743: nested rows stay compact. Main's top-level rows here keep their state and
  // preview lines; an ask or spawned agent under its sender is one line (glyph and title), with its
  // status, last message and box in the tooltip.
  it.each([
    ['in the plain list', [] as SpaceView[]],
    ['in a space group', [space('mine', 'editor')]],
  ])('nests asks as one-line rows with the details in the tooltip, %s', (_where, spaces) => {
    const ws = (name: string, askThread?: unknown, sessionTitle?: string) => ({ id: name, name, archived: false, createdAt: '2026-10-26T10:00:00Z', askThread, sessionTitle });
    const ask = (id: string, title: string, parent = 'orch', parentWs = 'main', sessionTitle?: string) =>
      ws(`ask-${id}`, { id, title, parentProjectId: parent, parentWorkstream: parentWs }, sessionTitle);
    mocks.projects = [
      { ...project('orch', 'box-a'), name: 'termag-3', workstreams: [ws('main')] },
      { ...project('b2', 'box-b'), name: 'termag-3', workstreams: [ask('cmvpvqxse19rwex4apfh334ld', 'Waits on you', 'orch', 'main', 'Claude says')] },
      { ...project('b3', 'box-c'), name: 'termag-3', workstreams: [ask('cmvpvqyum19sbex4axk6m62o8', 'Nested deeper', 'b2', 'ask-cmvpvqxse19rwex4apfh334ld')] },
    ] as unknown as Project[];
    mocks.spaces = spaces;
    mocks.index = new Map(spaces.length ? [['box-a', ['mine']], ['box-b', ['mine']], ['box-c', ['mine']]] : []);
    mocks.statusMap = {
      [statusKey('box-b', sessionName('ada', 'termag-3', 'agent', 'ask-cmvpvqxse19rwex4apfh334ld'))]: { status: 'waiting', waitingReason: 'approval', updatedAt: '2026-10-26T10:05:00Z', message: 'May I run npm test?' } as AgentStatus,
    };
    setFlagValues({ 'simple-ui-session-titles-enabled': true });
    act(() => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));
    const li = (name: string) => [...host.querySelectorAll<HTMLElement>('li.chat-tree-li')].find(l => l.querySelector('.chat-row-name')?.textContent === name)!;
    const top = li('termag-3');
    expect(top.querySelector('.chat-row-state')).not.toBeNull();
    for (const name of ['Waits on you', 'Nested deeper']) {
      const row = li(name);
      expect(row.style.getPropertyValue('--chat-depth')).not.toBe('');
      expect(row.querySelector('.chat-row')!.classList.contains('chat-row-compact')).toBe(true);
      expect(row.querySelector('.chat-row-state, .chat-row-msg, .chat-row-where, .chat-row-also')).toBeNull();
    }
    const tip = li('Waits on you').querySelector('.chat-row')!.getAttribute('title')!;
    expect(tip).toContain('Waits on you');
    expect(tip).toContain('Claude says');
    expect(tip).toContain('May I run npm test?');
    expect(tip).toContain('ask thread cmvpvqxse19rwex4apfh334ld');
    // The status stays on the glyph, as on a top-level row.
    expect(li('Waits on you').querySelector('.chat-glyph')!.getAttribute('data-status')).toBe('waiting');
    setFlagValues(undefined);
  });

  // The person on #743: an untitled ask shows its thread id, at the top and nested, with or without session titles.
  it.each([[true], [false]])('shows an untitled ask by its thread id (session titles %s)', titles => {
    const ws = (name: string, askThread?: unknown, sessionTitle?: string) => ({ id: name, name, archived: false, createdAt: '2026-10-26T10:00:00Z', askThread, sessionTitle });
    mocks.projects = [
      { ...project('orch', 'box-a'), name: 'termag-3', workstreams: [ws('main')] },
      { ...project('b2', 'box-b'), name: 'termag-3', workstreams: [ws('ask-cmvpvqxse19rwex4apfh334ld', { id: 'cmvpvqxse19rwex4apfh334ld', title: null, parentProjectId: 'orch', parentWorkstream: 'main' }, 'Claude named it')] },
      { ...project('b3', 'box-c'), name: 'termag-3', workstreams: [ws('ask-cmvpvqyum19sbex4axk6m62o8', { id: 'cmvpvqyum19sbex4axk6m62o8', title: null, parentProjectId: null, parentWorkstream: null })] },
    ] as unknown as Project[];
    mocks.spaces = [];
    mocks.index = new Map();
    setFlagValues(titles ? { 'simple-ui-session-titles-enabled': true } : undefined);
    act(() => root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>));
    const names = [...host.querySelectorAll('.chat-row-name')].map(n => n.textContent);
    expect(names).toContain('ask-cmvpvqxse19rwex4apfh334ld');
    expect(names).toContain('ask-cmvpvqyum19sbex4axk6m62o8');
    expect(names).not.toContain('Claude named it');
    setFlagValues(undefined);
  });

  // Bugbot on #743: a row led by Claude's session title must still name its box in the tooltip,
  // at the top and nested, since that is what tells same-named sessions on different boxes apart.
  it('names the box in the tooltip of a session-titled row, top-level and nested', async () => {
    const ws = (name: string, sessionTitle: string) => ({ id: name, name, archived: false, createdAt: '2026-10-26T10:00:00Z', sessionTitle });
    mocks.projects = [
      { ...project('p1', 'box-a'), name: 'termag-3', workstreams: [ws('main', 'Review the space sidebar')] },
      { ...project('p2', 'box-b'), name: 'termag-3', workstreams: [ws('main', 'Spawned helper')] },
    ] as unknown as Project[];
    mocks.boxes = [{ id: 'box-a', name: 'devbox' }, { id: 'box-b', name: 'helperbox' }];
    mocks.links = [{ projectId: 'p2', workstream: 'main', parentProjectId: 'p1', parentWorkstream: 'main' }];
    mocks.spaces = [];
    mocks.index = new Map();
    setFlagValues({ 'simple-ui-session-titles-enabled': true });
    await act(async () => { root.render(<MemoryRouter><ChatSidebar /></MemoryRouter>); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const li = (name: string) => [...host.querySelectorAll<HTMLElement>('li.chat-tree-li')].find(l => l.querySelector('.chat-row-name')?.textContent === name)!;
    expect(li('Review the space sidebar').querySelector('.chat-row-name')!.getAttribute('title')).toContain('on devbox');
    const nested = li('Spawned helper');
    expect(nested.style.getPropertyValue('--chat-depth')).toBe('1');
    expect(nested.querySelector('.chat-row')!.getAttribute('title')).toContain('on helperbox');
    setFlagValues(undefined);
  });
});
