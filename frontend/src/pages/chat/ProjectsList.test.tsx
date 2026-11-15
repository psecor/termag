// @vitest-environment jsdom
// The sidebar's Projects view: its states and folds.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxRow } from '../../mobile/inbox';
import type { Project } from '../../types';
import { resetSidebarViewForTests, setSidebarView, SIDEBAR_VIEW_KEY } from '../../chat/sidebarView';
import { PROJECT_FOLDS_KEY } from '../../chat/sidebarGroups';
import { revealProject } from '../../chat/revealProject';
import { ChatChromeProvider } from './chatChrome';
import { ProjectsList } from './ProjectsList';
import { statusKey } from '../../utils/statusKey';
import { sessionName } from '../../utils/sessionName';
import { chatsApi, workstreamsApi } from '../../services/api';
import { snackbarQueue } from '@launchpad-ui/components';
import { useRailProjects } from '../../chat/sidebarRail';
import { chatLiveKey } from '../../chat/chatLiveStatus';
import { NOT_RUNNING_SECTION } from '../../chat/sidebarLayout';

const noBoxes: never[] = [];
vi.mock('../../services/boxFeed', () => ({ boxFeed: { subscribe: () => () => {}, getSnapshot: () => noBoxes, reload: async () => {} } }));

interface ProjectsState {
  projects: Project[];
  statusMap?: Record<string, unknown>;
  projectsLoaded: boolean;
  projectsLoadFailed?: boolean;
  projectsRefreshFailed?: boolean;
  reloadProjects: () => Promise<void>;
}
let projectsState: ProjectsState;
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ statusMap: {}, ...projectsState }) }));

const automationIndex = new Map<string, { timezone?: string }>();
vi.mock('../../chat/automationRunGroups', () => ({ useAutomationIndex: () => automationIndex }));

const mocks = vi.hoisted(() => ({
  projectsOn: false,
  userProjects: null as null | Array<{ id: string; name: string; archived: boolean; lastActiveAt: string; checkouts?: Array<{ sessions: number; archived: boolean }> }>,
  prs: null as unknown,
}));
vi.mock('../../flags', async importOriginal => {
  const actual = await importOriginal<typeof import('../../flags')>();
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (key === 'user-projects-enabled' ? mocks.projectsOn as T : fallback) };
});
vi.mock('../dashboard/useDashboardData', () => ({
  usePolled: () => ({ data: mocks.prs, loading: false, error: null, refresh: () => {} }),
}));

// The server's pins (chat/sessionPins.ts), and Archived as the bottom row's section, stand in here.
const pinned = vi.hoisted(() => ({
  pins: [] as Array<{ workstreamId: string; projectId: string; workstream: string; pinnedAt: string }>,
  pin: vi.fn(async () => true),
  unpin: vi.fn(async () => true),
  archived: 0,
  settled: true,
}));
vi.mock('../../chat/sessionPins', () => ({
  useSessionPins: () => ({
    enabled: mocks.projectsOn, pins: pinned.pins, settled: pinned.settled, failed: false, offOnServer: false,
    isPinned: (id: string | null | undefined) => pinned.pins.some(p => p.workstreamId === id),
    pin: pinned.pin, unpin: pinned.unpin, reload: async () => {},
  }),
}));
vi.mock('./ArchivedChats', async () => {
  const React = await import('react');
  return {
    ArchivedChats: ({ dock }: { dock?: { open: boolean; onCount: (n: number) => void; sessions?: React.ReactNode[] } }) => {
      const count = dock?.onCount;
      React.useEffect(() => { count?.(pinned.archived); }, [count]);
      return dock?.open ? React.createElement('ul', { className: 'archived-stub' }, ...(dock.sessions ?? [])) : null;
    },
  };
});

let rows: InboxRow[];
const spacesMock = vi.hoisted(() => ({ spaces: [] as Array<{ id: string; name: string; role: string }>, loaded: true }));
// The asks and spawns the sessions nest by (simpleData.tsx links).
const linksMock = vi.hoisted(() => ({
  links: [] as Array<{ projectId: string; workstream: string; parentProjectId: string; parentWorkstream: string }>,
  setUnseen: vi.fn(),
}));
// The open chats' live statuses (chat/chatLiveStatus.ts), by chatLiveKey; empty unless a test sets one.
const liveMock = vi.hoisted(() => ({ map: new Map<string, { tone: string; text: string; preview: string | null }>() }));
const simpleData = () => ({
    items: { state: { items: [] }, open: () => {} }, rows, live: liveMock.map, setupOf: new Map(), links: linksMock.links, setUnseen: linksMock.setUnseen, unseen: new Set(), activeTab: null,
    spaces: { loaded: spacesMock.loaded, spaces: spacesMock.spaces, index: new Map(), current: true, colorOf: () => null },
    userProjects: { list: mocks.userProjects, failed: false, settled: true, reload: async () => {} },
  });
vi.mock('./simpleData', () => ({ useSimpleData: () => simpleData(), useSimpleDataIfAny: () => simpleData() }));

// Touched a minute ago, for the sessions Older (chat/sidebarLayout.ts) must leave where they are.
const JUST_NOW = new Date(Date.now() - 60_000).toISOString();

function project(id: string, repoKeys: string[], provider = 'claude-chat', lastActiveAt = '2026-11-10T12:00:00Z'): Project {
  return {
    id, name: id, archived: false, repoKeys, lastActiveAt,
    workstreams: [{ id: `${id}-main`, name: 'main', lastActiveAt: '2026-11-10T12:00:00Z' }],
    workflows: [{ id: `${id}-wf`, type: 'agent', provider, workstreamId: `${id}-main` }],
  } as unknown as Project;
}

function row(projectId: string, status: InboxRow['status'] = 'idle'): InboxRow {
  return {
    key: `${projectId}|main`, projectId, projectName: projectId, workstream: 'main', owner: 'ada', shared: false,
    provider: 'claude-chat', instanceId: 'box-1', kind: 'normal', pinned: false, status, waitingReason: null,
    updatedAt: '2026-11-10T12:00:00Z', message: null, contextTokens: null, rateLimited: null, review: null, ring: null, band: 'other',
  } as InboxRow;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.projectsOn = false;
  mocks.userProjects = null;
  mocks.prs = null;
  pinned.pins = [];
  pinned.archived = 0;
  pinned.settled = true;
  spacesMock.spaces = [];
  spacesMock.loaded = true;
  linksMock.links = [];
  pinned.pin.mockClear();
  localStorage.clear();
  resetSidebarViewForTests();
  // The fixture's sessions are days old: Older moves nothing unless a test asks it to.
  setSidebarView({ olderDays: 0 });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  rows = [row('termag'), row('scratch')];
  projectsState = {
    // termag was active last, so its group comes first.
    projects: [project('termag', ['example-org/termag'], 'claude-chat', '2026-11-10T12:30:00Z'), project('scratch', [], 'claude')],
    projectsLoaded: true,
    reloadProjects: vi.fn(async () => {}),
  };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

let at = '';
function Where() { const l = useLocation(); at = `${l.pathname}${l.search}`; return null; }

function show(path = '/chat') {
  act(() => root.render(
    <ChatChromeProvider value={{ mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, refresh: true }}>
      <MemoryRouter initialEntries={[path]}><ProjectsList /><Where /></MemoryRouter>
    </ChatChromeProvider>,
  ));
}

const text = () => host.textContent ?? '';
// A group's name: today's head (flag off), or the redesign's (user-projects-enabled).
const groupNames = () => [...host.querySelectorAll('.chat-group-name, .pj-name')].map(n => n.textContent);
// A row's name: the tabs' own row (flag off), or a card's title (user-projects-enabled).
const rowNames = () => [...host.querySelectorAll('.chat-item .chat-item-name, .sc .sc-title')].map(n => n.textContent);
const button = (name: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === name)!;
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });

describe('ProjectsList', () => {
  it('shows the loading row while the list loads, never "No sessions"', () => {
    projectsState = { ...projectsState, projects: [], projectsLoaded: false };
    rows = [];
    show();
    expect(text()).toContain('Loading…');
    expect(text()).not.toContain('No sessions');
  });

  it('says there are no sessions yet, with New session, once the list loads empty', () => {
    projectsState = { ...projectsState, projects: [] };
    rows = [];
    show();
    expect(text()).toContain('No sessions yet');
    expect(button('New session')).toBeTruthy();
    expect(text()).not.toContain('Loading…');
  });

  it("keeps the last list under a one-line alert when a refresh fails, and Retry reloads", () => {
    projectsState = { ...projectsState, projectsRefreshFailed: true };
    show();
    expect(text()).toContain("Couldn't refresh your sessions");
    expect(rowNames()).toEqual(['termag', 'scratch']);
    click(button('Retry'));
    expect(projectsState.reloadProjects).toHaveBeenCalledTimes(1);
  });

  it('shows the alert and Retry alone when no list ever loaded', () => {
    projectsState = { ...projectsState, projects: [], projectsLoaded: false, projectsLoadFailed: true };
    rows = [];
    show();
    expect(text()).toContain("Couldn't refresh your sessions");
    expect(button('Retry')).toBeTruthy();
    expect(text()).not.toContain('Loading…');
    expect(text()).not.toContain('No sessions yet');
    expect(groupNames()).toEqual([]);
  });

  it("says Nothing running when the filter hides every session, and its link turns the filter back on", () => {
    rows = [row('termag', 'not_running'), row('scratch', 'not_running')];
    setSidebarView({ show: 'projects', showIdle: false });
    show();
    expect(text()).toContain('Nothing running');
    expect(groupNames()).toEqual([]);
    const link = [...host.querySelectorAll('[role="link"], a')].find(a => a.textContent === "Show sessions that aren't running")!;
    click(link);
    expect(JSON.parse(localStorage.getItem(SIDEBAR_VIEW_KEY)!).showIdle).toBe(true);
    expect(groupNames()).toEqual(['termag', 'No repo']);
  });

  it('keeps a fold across a re-render and a reload, and still shows the open session', () => {
    show();
    click(host.querySelector('[data-group="repos:example-org/termag"] .chat-group-toggle')!);
    expect(rowNames()).toEqual(['scratch']);
    rows = [row('termag'), row('scratch'), { ...row('scratch'), key: 'scratch|two', workstream: 'two' }];
    show();
    expect(host.querySelector('[data-group="repos:example-org/termag"]')?.hasAttribute('data-folded')).toBe(true);
    expect(JSON.parse(localStorage.getItem(PROJECT_FOLDS_KEY)!)).toEqual({ 'repos:example-org/termag': true });
    act(() => root.unmount());
    root = createRoot(host);
    show('/chat/p/termag');
    expect(rowNames()).toContain('termag');
    expect(host.querySelector('.chat-item.active')?.getAttribute('aria-current')).toBe('page');
  });

  it("names an untitled automation run by its automation and the run's time in the automation's zone", () => {
    automationIndex.set('nightly', { timezone: 'America/Los_Angeles' });
    rows = [{ ...row('nightly'), key: 'nightly|run-20261110-0900', workstream: 'run-20261110-0900', kind: 'automation' }];
    projectsState = { ...projectsState, projects: [project('nightly', [])] };
    localStorage.setItem(PROJECT_FOLDS_KEY, JSON.stringify({ automations: false }));
    show();
    // 09:00 UTC is 01:00 in Los Angeles in November, as Tabs says.
    expect(rowNames()).toEqual([expect.stringMatching(/^nightly · .*01:00/)]);
    automationIndex.clear();
  });

  it('gives each group its own list id, however alike their repositories read', () => {
    rows = [row('a'), row('b')];
    projectsState = { ...projectsState, projects: [project('a', ['foo-bar/baz']), project('b', ['foo/bar-baz'])] };
    show();
    const ids = [...host.querySelectorAll('.chat-group-list')].map(l => l.id);
    expect(new Set(ids).size).toBe(2);
    for (const t of host.querySelectorAll('.chat-group-toggle')) expect(ids).toContain(t.getAttribute('aria-controls'));
  });

  it('scrolls the open session into view once its row arrives, after a reload', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    rows = [];
    projectsState = { ...projectsState, projects: [], projectsLoaded: false };
    show('/chat/p/termag');
    expect(scroll).not.toHaveBeenCalled();
    rows = [row('termag'), row('scratch')];
    projectsState = { ...projectsState, projects: [project('termag', ['example-org/termag']), project('scratch', [])], projectsLoaded: true };
    show('/chat/p/termag');
    expect(scroll).toHaveBeenCalledTimes(1);
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("tags a session Lab's agent pane drives, and links every row to its chat", () => {
    show();
    const scratch = [...host.querySelectorAll('.chat-item')].find(a => a.querySelector('.chat-item-name')?.textContent === 'scratch')!;
    expect(scratch.querySelector('.chat-item-tag')?.textContent).toBe('Lab');
    expect(scratch.getAttribute('href')).toBe('/chat/p/scratch');
    const termag = [...host.querySelectorAll('.chat-item')].find(a => a.querySelector('.chat-item-name')?.textContent === 'termag')!;
    expect(termag.querySelector('.chat-item-tag')).toBeNull();
  });
});

describe('ProjectsList under user-projects-enabled', () => {
  const withProject = (p: Project, userProjectId: string) => ({ ...p, userProjectId }) as Project;
  const pr = (projectId: string, number: number, mergedAt: string | null = null) => ({
    kind: 'pr', repo: 'example-org/termag', number, mergedAt, workstream: { projectId, workstream: 'main' },
  });

  beforeEach(() => {
    mocks.projectsOn = true;
    projectsState = {
      ...projectsState,
      projects: [withProject(project('termag', ['example-org/termag'], 'claude-chat', '2026-11-10T12:30:00Z'), 'up-t'), project('scratch', [], 'claude')],
    };
  });

  it("keeps the repository sets' names until the projects are read, then names the groups by project", () => {
    show();
    expect(groupNames()).toEqual(['termag', 'No repo']);
    mocks.userProjects = [{ id: 'up-t', name: 'Termag web', archived: false, lastActiveAt: '2026-11-10T12:30:00Z' }];
    show();
    expect(groupNames()).toEqual(['Termag web', 'No repo']);
    expect(host.querySelector('[data-group="userproject:up-t"]')).toBeTruthy();
  });

  it('shows a project with no sessions yet as its head alone, which starts a session in it', () => {
    mocks.userProjects = [
      { id: 'up-t', name: 'Termag web', archived: false, lastActiveAt: '2026-11-10T12:30:00Z' },
      { id: 'up-new', name: 'Brand new', archived: false, lastActiveAt: '2026-11-10T11:00:00Z' },
      { id: 'up-old', name: 'Put away', archived: true, lastActiveAt: '2026-11-10T13:00:00Z' },
    ];
    show();
    expect(groupNames()).toEqual(['Termag web', 'No repo', 'Brand new']);
    const fresh = host.querySelector('[data-group="userproject:up-new"]')!;
    // No "No sessions yet" row and no count: the head says it to a screen reader, and shows its + always.
    expect(fresh.querySelector('.pj-head')?.hasAttribute('data-empty')).toBe(true);
    expect(fresh.querySelector('.pj-count')).toBeNull();
    expect(fresh.querySelector('.pj-lone')).toBeTruthy();
    expect(fresh.querySelector('.pj-fold')?.textContent).toContain('no sessions yet: start one');
    expect(fresh.textContent).not.toContain('New session here');
    click(fresh.querySelector('.pj-fold')!);
    expect(at).toBe('/chat/new?project=up-new');
    // A fold kept from before (an empty project has nothing to fold) doesn't take that away.
    localStorage.setItem(PROJECT_FOLDS_KEY, JSON.stringify({ 'userproject:up-new': true }));
    act(() => root.unmount());
    root = createRoot(host);
    show();
    const kept = host.querySelector('[data-group="userproject:up-new"]')!;
    expect(kept.querySelector('.pj-head')?.hasAttribute('data-empty')).toBe(true);
    expect(kept.querySelector('.pj-folded-mark')).toBeNull();
    click(kept.querySelector('.pj-fold')!);
    expect(at).toBe('/chat/new?project=up-new');
  });

  it("doesn't call a project with sessions empty while the project list hasn't put them under it", () => {
    projectsState = { ...projectsState, projects: [project('termag', ['example-org/termag'], 'claude-chat', '2026-11-10T12:30:00Z'), project('scratch', [], 'claude')] };
    mocks.userProjects = [{ id: 'up-t', name: 'Termag web', archived: false, lastActiveAt: '2026-11-10T12:30:00Z', checkouts: [{ sessions: 1, archived: false }] }];
    show();
    expect(groupNames()).toEqual(['termag', 'No repo']);
    expect(host.querySelector('.pj-head[data-empty]')).toBeNull();
  });

  it("offers projects without sessions instead of the empty list's New session", () => {
    rows = [];
    projectsState = { ...projectsState, projects: [] };
    mocks.userProjects = [{ id: 'up-new', name: 'Brand new', archived: false, lastActiveAt: '2026-11-10T11:00:00Z' }];
    show();
    expect(groupNames()).toEqual(['Brand new']);
    expect(host.querySelector('.chat-projects-empty')).toBeNull();
  });

  it("shows a project's open PRs, and the count opens the session with one", () => {
    mocks.userProjects = [{ id: 'up-t', name: 'Termag web', archived: false, lastActiveAt: '2026-11-10T12:30:00Z' }];
    mocks.prs = { connected: true, lanes: [{ id: 'mine', label: 'Mine', rows: [pr('termag', 1), pr('termag', 2), pr('termag', 3, '2026-11-10T10:00:00Z')] }] };
    show();
    const head = host.querySelector('[data-group="userproject:up-t"] .pj-head')!;
    const count = head.querySelector<HTMLButtonElement>('.chat-group-prs')!;
    expect(count.textContent).toBe('2 PRs');
    expect(count.getAttribute('aria-label')).toBe('2 PRs open in Termag web: open the latest session with one');
    click(count);
    expect(at).toBe('/chat/p/termag');
    expect(host.querySelector('[data-group="no-repo"] .chat-group-prs')).toBeNull();
  });

  it("unfolds, shows and focuses a project's group when the header reveals it", async () => {
    mocks.userProjects = [{ id: 'up-t', name: 'Termag web', archived: false, lastActiveAt: '2026-11-10T12:30:00Z' }];
    localStorage.setItem(PROJECT_FOLDS_KEY, JSON.stringify({ 'userproject:up-t': true }));
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    show();
    expect(host.querySelector('[data-group="userproject:up-t"]')?.hasAttribute('data-folded')).toBe(true);
    await act(async () => { revealProject('up-t'); });
    const group = host.querySelector('[data-group="userproject:up-t"]')!;
    expect(group.hasAttribute('data-folded')).toBe(false);
    expect(document.activeElement).toBe(group.querySelector('.chat-projects-fold'));
    expect(scroll).toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(PROJECT_FOLDS_KEY)!)).toEqual({ 'userproject:up-t': false });
    // One with no group to show does nothing.
    await act(async () => { revealProject('up-gone'); });
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('takes a reveal sent before it was shown (the header switched the sidebar from Tabs)', () => {
    mocks.userProjects = [{ id: 'up-t', name: 'Termag web', archived: false, lastActiveAt: '2026-11-10T12:30:00Z' }];
    localStorage.setItem(PROJECT_FOLDS_KEY, JSON.stringify({ 'userproject:up-t': true }));
    revealProject('up-t');
    show();
    const group = host.querySelector('[data-group="userproject:up-t"]')!;
    expect(group.hasAttribute('data-folded')).toBe(false);
    expect(document.activeElement).toBe(group.querySelector('.chat-projects-fold'));
  });

  it("gives a project's head its menu, from its ⋯ or a right click, and a repository set's none", async () => {
    mocks.userProjects = [{ id: 'up-t', name: 'Termag web', archived: false, lastActiveAt: '2026-11-10T12:30:00Z' }];
    show();
    const head = host.querySelector('[data-group="userproject:up-t"] .pj-head')!;
    expect(head.querySelector('.chat-project-menu')?.getAttribute('aria-label')).toBe('Options for Termag web');
    expect(host.querySelector('[data-group="no-repo"] .chat-project-menu')).toBeNull();
    await act(async () => { head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    expect([...document.querySelectorAll('[role="menuitem"]')].map(i => i.querySelector('[slot="label"]')?.textContent))
      .toEqual(['New session here', 'Rename project…', 'Change icon…', 'Archive project…']);
  });

  it("keeps a project's dialog open when its group goes away (an archive takes it)", async () => {
    mocks.userProjects = [{ id: 'up-t', name: 'Termag web', archived: false, lastActiveAt: '2026-11-10T12:30:00Z' }];
    show();
    const head = host.querySelector('[data-group="userproject:up-t"] .pj-head')!;
    await act(async () => { head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    await act(async () => { ([...document.querySelectorAll('[role="menuitem"]')][1] as HTMLElement).click(); });
    expect(document.querySelector('.chat-project-dialog')).toBeTruthy();
    // The project archived: its group is gone, the dialog stays.
    mocks.userProjects = [{ id: 'up-t', name: 'Termag web', archived: true, lastActiveAt: '2026-11-10T12:30:00Z' }];
    show();
    expect(host.querySelector('[data-group="userproject:up-t"]')).toBeNull();
    expect(document.querySelector('.chat-project-dialog')).toBeTruthy();
  });

  describe('Pinned, Older and the bottom row (chat/sidebarLayout.ts)', () => {
    const ws = (projectId: string, workstream: string, status: InboxRow['status'] = 'not_running') =>
      ({ ...row(projectId, status), key: `${projectId}|${workstream}`, workstream, workstreamId: `t-${workstream}` });
    // main was touched just now; a, b and c days ago.
    const termag = () => ({ ...project('termag', ['example-org/termag'], 'claude-chat', '2026-11-10T12:30:00Z'), userProjectId: 'up-t',
      workstreams: ['main', 'a', 'b', 'c'].map(name => ({ id: `t-${name}`, name, lastActiveAt: name === 'main' ? JUST_NOW : '2026-11-01T12:00:00Z' })) }) as unknown as Project;

    beforeEach(() => {
      mocks.userProjects = [{ id: 'up-t', name: 'Termag web', archived: false, lastActiveAt: '2026-11-10T12:30:00Z' }];
      projectsState = { ...projectsState, projects: [termag()] };
      rows = [ws('termag', 'main', 'working'), ws('termag', 'a'), ws('termag', 'b'), ws('termag', 'c')];
      setSidebarView({ olderDays: 3 });
    });
    const group = (key = 'userproject:up-t') => host.querySelector(`[data-group="${key}"]`)!;
    const names = (key?: string) => [...(group(key)?.querySelectorAll('.sc .sc-title') ?? [])].map(n => n.textContent);
    const dockButton = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('.sb-dock button')].find(b => b.getAttribute('aria-label')?.startsWith(name));

    it("moves what you haven't touched in 3 days to Older, behind its button in the bottom row", () => {
      show();
      expect(names()).toEqual(['termag']);
      // A head counts what it lists.
      expect(group().querySelector('.pj-count')?.textContent).toBe('1');
      expect(dockButton('Older')?.getAttribute('aria-label')).toBe('Older, 3');
      expect(host.querySelector('[data-dock="older"]')).toBeNull();
    });

    it("goes by how recently a session was active, not when it was started: one used today stays, a box parking moves nothing out", () => {
      const fiveAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      const own = (r: InboxRow) => [statusKey(r.instanceId, sessionName(r.owner, r.projectName, 'agent', r.workstream)), { status: r.status, updatedAt: r.updatedAt }];
      // All three started on 11-01. a finished a turn five minutes ago; b's box parked five minutes ago, its last
      // turn on 11-01; c has no status of its own.
      const a = { ...ws('termag', 'a', 'idle'), updatedAt: fiveAgo, statusSince: fiveAgo, stoppedAt: fiveAgo };
      const b = { ...ws('termag', 'b'), updatedAt: fiveAgo, statusSince: fiveAgo, stoppedAt: '2026-11-01T13:00:00Z' };
      rows = [ws('termag', 'main', 'working'), a, b, ws('termag', 'c')];
      projectsState = { ...projectsState, statusMap: Object.fromEntries([a, b].map(own)) };
      show();
      expect(names()).toEqual(['termag', 'a']);
      expect(dockButton('Older')?.getAttribute('aria-label')).toBe('Older, 2');
      click(dockButton('Older')!);
      expect(names('older')).toEqual(['b', 'c']);
    });

    it('opens Older at the end of the list from its button, and keeps it open in this browser', () => {
      show();
      click(dockButton('Older')!);
      expect(names('older')).toEqual(['a', 'b', 'c']);
      expect(group('older').querySelector('.pj-name')?.textContent).toBe('Older');
      expect(JSON.parse(localStorage.getItem('termag.chat.sidebarDock')!)).toEqual(['older']);
      act(() => root.unmount());
      root = createRoot(host);
      show();
      expect(names('older')).toHaveLength(3);
      // Its head puts it away again.
      click(group('older').querySelector('.pj-fold')!);
      expect(host.querySelector('[data-dock="older"]')).toBeNull();
    });

    it('never moves the session on screen, and moves nothing after Never', () => {
      show('/chat/p/termag?ws=b');
      expect(names()).toHaveLength(2);
      expect(dockButton('Older')?.getAttribute('aria-label')).toBe('Older, 2');
      setSidebarView({ olderDays: 0 });
      show();
      expect(names()).toHaveLength(4);
      expect(dockButton('Older')).toBeUndefined();
    });

    it("keeps today's list with the flag off: no Older, no bottom row", () => {
      mocks.projectsOn = false;
      show();
      expect(host.querySelector('.sb-dock')).toBeNull();
      expect(host.querySelectorAll('.chat-item')).toHaveLength(4);
    });

    it("puts pins above Needs you, in the server's order, and a pinned session never in Older", () => {
      pinned.pins = [
        { workstreamId: 't-c', projectId: 'termag', workstream: 'c', pinnedAt: '2026-11-13T10:00:00Z' },
        { workstreamId: 't-a', projectId: 'termag', workstream: 'a', pinnedAt: '2026-11-13T11:00:00Z' },
      ];
      rows = [...rows, { ...ws('termag', 'q', 'waiting'), waitingReason: 'approval' }];
      show();
      expect(groupNames().slice(0, 2)).toEqual(['Pinned', 'Needs you']);
      expect([...group('pinned').querySelectorAll('.sc')].map(c => c.getAttribute('href'))).toEqual(['/chat/p/termag?ws=c', '/chat/p/termag?ws=a']);
      expect(dockButton('Older')?.getAttribute('aria-label')).toBe('Older, 1');
    });

    it('waits for the server\'s pins before placing anything, so nothing jumps into Pinned', () => {
      pinned.settled = false;
      show();
      expect(text()).toContain('Loading…');
      expect(host.querySelector('.sc')).toBeNull();
      // Nor the empty states beside it, with nothing listed at all.
      rows = [];
      projectsState = { ...projectsState, projects: [] };
      mocks.userProjects = [];
      show();
      expect(text()).toContain('Loading…');
      expect(text()).not.toContain('No sessions yet');
      pinned.settled = true;
      show();
      expect(text()).toContain('No sessions yet');
      expect(host.querySelector('.sb-dock')).toBeNull();
    });

    it("pins and unpins from a card's menu", async () => {
      show();
      const card = () => [...host.querySelectorAll('.sc-li')].find(li => li.querySelector('.sc')?.getAttribute('href') === '/chat/p/termag')!;
      await act(async () => { card().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
      const item = (text: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(i => i.textContent?.includes(text));
      await act(async () => { item('Pin to top')!.click(); });
      expect(pinned.pin).toHaveBeenCalledWith({ workstreamId: 't-main', projectId: 'termag', workstream: 'main' });
      pinned.pins = [{ workstreamId: 't-main', projectId: 'termag', workstream: 'main', pinnedAt: '2026-11-13T10:00:00Z' }];
      show();
      await act(async () => { card().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
      await act(async () => { item('Unpin')!.click(); });
      expect(pinned.unpin).toHaveBeenCalledWith('t-main');
    });

    it('moves Shared with me, Automations and Archived to the bottom row, each opening its section', () => {
      pinned.archived = 2;
      rows = [...rows, { ...ws('peter', 'main', 'idle'), shared: true, owner: 'peter' }];
      projectsState = { ...projectsState, projects: [termag(), project('peter', ['example-org/termag'])] };
      show();
      expect(host.querySelector('[data-project-group="shared"]')).toBeNull();
      expect(dockButton('Shared with me')?.getAttribute('aria-label')).toBe('Shared with me, 1');
      expect(dockButton('Archived')?.getAttribute('aria-label')).toBe('Archived, 2');
      click(dockButton('Archived')!);
      expect(host.querySelector('[data-dock="archived"] .pj-name')?.textContent).toBe('Archived');
      // Its head lists nothing itself (ArchivedRows does), so nothing of it is "up in Needs you".
      expect(host.querySelector('[data-dock="archived"] .pj-head .chat-sr')?.textContent).toBe(', 2 archived');
      expect(host.querySelector('.archived-stub')).toBeTruthy();
      click(dockButton('Shared with me')!);
      expect(host.querySelector('[data-dock="shared"] .sc')).toBeTruthy();
    });

    it('groups by Status: Working and Idle in their colours, with Pinned and Needs you as they are, and Not running in the bottom row', () => {
      setSidebarView({ olderDays: 0, groupBy: 'status' });
      rows = [ws('termag', 'main', 'working'), ws('termag', 'a', 'idle'), ws('termag', 'b'), { ...ws('termag', 'q', 'waiting'), waitingReason: 'approval' }];
      show();
      expect(groupNames()).toEqual(['Needs you', 'Working', 'Idle']);
      expect([...host.querySelectorAll('.pj-head')].map(h => h.getAttribute('data-tone'))).toEqual(['needs', 'working', 'idle']);
      expect(names('status:recent')).toEqual(['a']);
    });

    // From review: "not running should go in the bottom button bar when it's collapsed".
    it("folds Group by Status's Not running into the bottom row, opens it at the list's end, and folds it back", () => {
      setSidebarView({ olderDays: 0, groupBy: 'status' });
      rows = [ws('termag', 'main', 'working'), ws('termag', 'a', 'idle'), ws('termag', 'b'), ws('termag', 'c')];
      show();
      // Folded to start: a button with its count, between Automations and Older, and no section in the list.
      expect(host.querySelector(`[data-group="${NOT_RUNNING_SECTION}"]`)).toBeNull();
      expect(dockButton('Not running')?.getAttribute('aria-label')).toBe('Not running, 2');
      expect(dockButton('Not running')?.querySelector('[data-icon], svg')).toBeTruthy();
      click(dockButton('Not running')!);
      // Open: its section at the end of the list, in its own colour, and the button pressed.
      expect(groupNames()).toEqual(['Working', 'Idle', 'Not running']);
      expect(group(NOT_RUNNING_SECTION).getAttribute('data-dock')).toBe('not-running');
      expect(group(NOT_RUNNING_SECTION).querySelector('.pj-head')?.getAttribute('data-tone')).toBe('off');
      expect(names(NOT_RUNNING_SECTION)).toEqual(['b', 'c']);
      expect(dockButton('Not running')?.getAttribute('aria-pressed')).toBe('true');
      expect(JSON.parse(localStorage.getItem('termag.chat.sidebarDock')!)).toEqual(['not-running']);
      // Its head's fold sends it back to the button.
      click(group(NOT_RUNNING_SECTION).querySelector('.pj-fold')!);
      expect(host.querySelector(`[data-group="${NOT_RUNNING_SECTION}"]`)).toBeNull();
      expect(dockButton('Not running')?.getAttribute('aria-label')).toBe('Not running, 2');
      // Folded, it still shows the session on screen, as Older does.
      act(() => root.unmount());
      root = createRoot(host);
      show('/chat/p/termag?ws=b');
      expect(names(NOT_RUNNING_SECTION)).toEqual(['b']);
    });

    it('has no Not running button under Group by Project, where not running is only a mark', () => {
      setSidebarView({ olderDays: 0, groupBy: 'project' });
      rows = [ws('termag', 'main', 'working'), ws('termag', 'b')];
      show();
      expect(dockButton('Not running')).toBeUndefined();
      expect(names()).toEqual(['termag', 'b']);
    });

    it("groups by Space: each space, an empty one as a head that starts a session in it, then No space; a space's head has + and its menu", () => {
      setSidebarView({ olderDays: 0, groupBy: 'space' });
      spacesMock.spaces = [{ id: 'sp-1', name: 'Simple UI', role: 'owner' }, { id: 'sp-2', name: 'Desktop', role: 'owner' }];
      rows = [{ ...ws('termag', 'main', 'working'), spaceId: 'sp-1', spaceFixed: true }, ws('termag', 'a', 'idle')];
      show();
      expect(groupNames()).toEqual(['Desktop', 'Simple UI', 'No space']);
      expect(group('space:Simple UI').querySelector('.pj-over [aria-label="New session in Simple UI"]')).toBeTruthy();
      expect(group('space:Simple UI').querySelector('.pj-space-menu')).toBeTruthy();
      const desktop = group('space:Desktop').querySelector('.pj-head')!;
      expect(desktop.hasAttribute('data-empty')).toBe(true);
      click(desktop.querySelector('.pj-fold')!);
      expect(at).toBe('/chat/new?space=Desktop');
      expect(names('space:(none)')).toEqual(['a']);
      // Until the spaces are read, nothing is placed (it would all be under No space, then move).
      spacesMock.loaded = false;
      show();
      expect(text()).toContain('Loading…');
      expect(host.querySelector('.sc')).toBeNull();
      spacesMock.loaded = true;
      // A space's session up in Needs you counts on its head; with sessions that aren't running hidden, an empty space goes.
      rows = [{ ...ws('termag', 'q', 'waiting'), waitingReason: 'approval', spaceId: 'sp-2', spaceFixed: true }, ws('termag', 'a', 'idle')];
      show();
      expect(group('space:Desktop').querySelector('.pj-fold')?.textContent).toContain('1 elsewhere');
      // A space you only view can't start one, and still says where its sessions are, with no 0 on its head.
      spacesMock.spaces = [{ id: 'sp-1', name: 'Simple UI', role: 'owner' }, { id: 'sp-2', name: 'Desktop', role: 'viewer' }];
      show();
      expect(group('space:Desktop').querySelector('.pj-fold')?.textContent).toContain('none here, 1 elsewhere');
      expect(group('space:Desktop').querySelector('.pj-count')).toBeNull();
      spacesMock.spaces = [{ id: 'sp-1', name: 'Simple UI', role: 'owner' }, { id: 'sp-2', name: 'Desktop', role: 'owner' }];
      setSidebarView({ showIdle: false });
      show();
      expect(group('space:Desktop')).toBeNull();
      setSidebarView({ showIdle: true });
      show();
      // No space has its menu but no +: New session with no space named would preselect the last one used.
      expect(group('space:(none)').querySelector('.pj-over [aria-label="New session in No space"]')).toBeNull();
      expect(group('space:(none)').querySelector('.pj-space-menu')).toBeTruthy();
    });

    it("switches to Group by Project when the header reveals a project, and shows New session when there's nothing", async () => {
      setSidebarView({ olderDays: 0, groupBy: 'status' });
      show();
      await act(async () => { revealProject('up-t'); });
      expect(JSON.parse(localStorage.getItem(SIDEBAR_VIEW_KEY)!).groupBy).toBe('project');
      expect(group('userproject:up-t')).toBeTruthy();
      // Only an empty project, grouped by Status: there are no heads, so the empty state shows.
      setSidebarView({ groupBy: 'status' });
      rows = [];
      projectsState = { ...projectsState, projects: [] };
      mocks.userProjects = [{ id: 'up-new', name: 'Brand new', archived: false, lastActiveAt: '2026-11-10T11:00:00Z' }];
      show();
      expect(host.querySelector('.chat-projects-empty')).toBeTruthy();
      // Nor does a space you only view stand in for it.
      setSidebarView({ groupBy: 'space' });
      mocks.userProjects = [];
      spacesMock.spaces = [{ id: 'sp-1', name: 'docs', role: 'viewer' }];
      show();
      expect(host.querySelector('.chat-projects-empty')).toBeTruthy();
    });

    it("shows the session on screen in its section while the section is closed, and counts only what a section lists", () => {
      rows = [...rows, { ...ws('peter', 'main', 'idle'), shared: true, owner: 'peter' }, { ...ws('peter', 'aurora', 'idle'), shared: true, owner: 'peter' }];
      projectsState = { ...projectsState, projects: [termag(), project('peter', ['example-org/termag'])] };
      pinned.pins = [{ workstreamId: 't-aurora', projectId: 'peter', workstream: 'aurora', pinnedAt: '2026-11-13T10:00:00Z' }];
      show('/chat/p/peter');
      // One shared session is pinned: Shared lists the other, and says one.
      expect(dockButton('Shared with me')?.getAttribute('aria-label')).toBe('Shared with me, 1');
      // Closed, Shared still shows the one on screen.
      expect([...group('shared').querySelectorAll('.sc')].map(c => c.getAttribute('aria-current'))).toEqual(['page']);
      expect(dockButton('Shared with me')?.getAttribute('aria-pressed')).not.toBe('true');
      // Its head says the rest are still put away.
      expect(group('shared').querySelector('.pj-fold')?.getAttribute('aria-expanded')).toBe('false');
      expect(group('shared').hasAttribute('data-folded')).toBe(true);
    });
  });

  it('shows no PR count, and names by repository, with the flag off', () => {
    mocks.projectsOn = false;
    mocks.userProjects = [{ id: 'up-t', name: 'Termag web', archived: false, lastActiveAt: '2026-11-10T12:30:00Z' }];
    mocks.prs = { connected: true, lanes: [{ id: 'mine', label: 'Mine', rows: [pr('termag', 1)] }] };
    show();
    expect(groupNames()).toEqual(['termag', 'No repo']);
    expect(host.querySelector('.chat-group-prs')).toBeNull();
  });
});

describe('ProjectsList: session cards (user-projects-enabled)', () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
  // The session's own status, as the status socket keeps it (a row's statusSince comes only from one).
  const ownStatusOf = (list: InboxRow[]) => Object.fromEntries(list.map(r => [
    statusKey(r.instanceId, sessionName(r.owner, r.projectName, 'agent', r.workstream)), { status: r.status, updatedAt: r.updatedAt },
  ]));
  beforeEach(() => {
    rows = [{ ...row('termag'), statusSince: minutesAgo(14) }];
    // Touched just now, so the quiet fold (chat/quietFold.ts) leaves it out.
    const recent = project('termag', ['example-org/termag']);
    recent.workstreams = recent.workstreams.map(w => ({ ...w, lastActiveAt: minutesAgo(14) }));
    projectsState = { ...projectsState, projects: [recent], statusMap: ownStatusOf(rows) };
  });

  // an open chat on a parked box read Not running, so Group by Status filed a session that waits on you there.
  it("keeps a parked open chat that waits on you in Needs you, with its own words and clock, not Not running's", () => {
    mocks.projectsOn = true;
    // The agent came to rest 4 hours ago; its review finished (or asked) 9 minutes ago and waits on you. The box has
    // since parked. The chip counts from the review, as it does for a chat that isn't open.
    const parked = { tone: 'off', text: 'Not running · box is stopped, sending a message starts it', preview: null };
    const reviews = [{ ring: 'done', review: { pr: 12, doneAt: minutesAgo(9) } }, { ring: 'waiting', review: { pr: 12, at: minutesAgo(9) } }] as const;
    try {
      setSidebarView({ groupBy: 'status', showIdle: true, olderDays: 0 });
      for (const r of reviews) {
        rows = [{ ...row('termag'), statusSince: minutesAgo(240), updatedAt: minutesAgo(240), ring: r.ring, band: 'attention',
          review: r.review as unknown as InboxRow['review'] }];
        projectsState = { ...projectsState, statusMap: ownStatusOf(rows) };
        liveMock.map.set(chatLiveKey('termag', 'main'), parked);
        show('/chat/p/termag');
        expect(groupNames(), r.ring).toEqual(['Needs you']);
        const card = host.querySelector<HTMLElement>('[data-group="needs-you"] .sc')!;
        expect(card.querySelector('.sc-chip')?.textContent, r.ring).toBe('9m');
        expect(card.dataset.tip, r.ring).toContain('Needs you · ');
        expect(card.dataset.tip, r.ring).not.toContain('Not running');
      }
      // With the box up the open chat's live line still leads, as before.
      liveMock.map.set(chatLiveKey('termag', 'main'), { tone: 'idle', text: 'Idle · your turn', preview: null });
      show('/chat/p/termag');
      expect(host.querySelector('[data-group="needs-you"] .sc')).toBeNull();
    } finally {
      liveMock.map.clear();
    }
  });

  it("never shows its project's time: a session with no status of its own has no time on its chip", () => {
    mocks.projectsOn = true;
    // buildRows gives a row with no status its project's lastActiveAt, a minute ago here.
    rows = [{ ...row('termag', 'not_running'), updatedAt: minutesAgo(1), statusSince: null }];
    projectsState = { ...projectsState, statusMap: {} };
    setSidebarView({ showIdle: true });
    show();
    const card = host.querySelector<HTMLElement>('.sc')!;
    expect(card.querySelector('.sc-chip')?.getAttribute('data-kind')).toBe('off');
    expect(card.querySelector('.sc-chip-time')).toBeNull();
    expect(card.dataset.tip).toContain('Not running: ');
    expect(card.dataset.tip).not.toContain('Not running for');
  });

  it('draws a session as a card: the project icon with the model mark, the title, the time in its status', () => {
    mocks.projectsOn = true;
    show();
    const card = host.querySelector<HTMLElement>('.sc')!;
    expect(card.querySelector('.sc-title')?.textContent).toBe('termag');
    expect(card.querySelector('.sc-chip')?.textContent).toBe('14m');
    // The time is its own box beside the mark's, so the two centre on one line (sessionCard.css).
    expect(card.querySelector('.sc-chip > .sc-chip-mark + .sc-chip-time')?.textContent).toBe('14m');
    expect(card.querySelector('.sc-chip')?.getAttribute('data-kind')).toBe('done');
    expect(card.querySelector('.pg-letter')?.textContent).toBe('T');
    expect(card.querySelector('.sc-mark')?.getAttribute('data-tip')).toBe('Claude');
    expect(card.dataset.tip).toContain('Idle for 14m: it finished its turn');
    // Compact is the first line alone; the tabs' rows are gone.
    expect(card.querySelector('.sc-l2')).toBeNull();
    expect(host.querySelector('.chat-item')).toBeNull();
  });

  it("adds Standard's line: the branch and the PR", () => {
    mocks.projectsOn = true;
    mocks.prs = { connected: true, lanes: [{ id: 'mine', label: 'Mine', rows: [
      { kind: 'pr', repo: 'example-org/termag', number: 1802, mergedAt: null, workstream: { projectId: 'termag', workstream: 'main' } },
    ] }] };
    setSidebarView({ density: 'standard' });
    show();
    const card = host.querySelector('.sc')!;
    expect(card.getAttribute('data-density')).toBe('standard');
    expect(card.querySelector('.sc-branch')?.textContent).toBe('main');
    expect(card.querySelector('.sc-pr')?.textContent).toBe('#1802');
  });

  it("counts a project's open PRs, two on one session as two, in its icon's tooltip", () => {
    mocks.projectsOn = true;
    const open = (number: number) => ({ kind: 'pr', repo: 'example-org/termag', number, mergedAt: null, workstream: { projectId: 'termag', workstream: 'main' } });
    mocks.prs = { connected: true, lanes: [{ id: 'mine', label: 'Mine', rows: [open(1802), open(1803)] }] };
    show();
    expect(host.querySelector('.sc .pg')?.getAttribute('data-tip')).toContain('1 session · 2 PRs');
  });

  it('marks the open session with aria-current, and nests what it started', () => {
    mocks.projectsOn = true;
    show('/chat/p/termag');
    expect(host.querySelector('.sc')?.getAttribute('aria-current')).toBe('page');
  });

  it("draws heads: Needs you in its colour, a project's icon, name and count, and its controls over its end", () => {
    mocks.projectsOn = true;
    mocks.userProjects = [{ id: 'up-t', name: 'Termag web', archived: false, lastActiveAt: '2026-11-10T12:30:00Z' }];
    const recent = projectsState.projects[0];
    projectsState = { ...projectsState, projects: [{ ...recent, userProjectId: 'up-t' } as Project] };
    rows = [{ ...row('termag', 'waiting'), waitingReason: 'approval', statusSince: minutesAgo(3) }, { ...rows[0], key: 'termag|b', workstream: 'b' }];
    show();
    expect(host.querySelector('[data-group="needs-you"] .pj-head')?.getAttribute('data-tone')).toBe('needs');
    const head = host.querySelector('[data-group="userproject:up-t"] .pj-head')!;
    expect(head.querySelector('.pj-name')?.textContent).toBe('Termag web');
    // It counts what it lists: the session up in Needs you is counted there.
    expect(head.querySelector('.pj-count')?.textContent).toBe('1');
    expect(head.querySelector('.pj-icon .pg-letter')?.textContent).toBe('T');
    expect(head.querySelector('.pj-over [aria-label="New session in Termag web"]')).toBeTruthy();
    expect(head.querySelector('.pj-over .chat-project-menu')).toBeTruthy();
    expect(head.querySelector('.pj-over .pj-chev')).toBeTruthy();
    // Today's head is gone under the flag.
    expect(host.querySelector('.chat-group-head')).toBeNull();
  });

  it("keeps the tabs' own rows with the flag off", () => {
    show();
    expect(host.querySelector('.sc')).toBeNull();
    expect(rowNames()).toEqual(['termag']);
    expect(host.querySelector('.chat-item .chat-status-mark, .chat-item [class*="status"]')).toBeTruthy();
    expect(host.querySelector('.chat-group-head .chat-group-count')).toBeTruthy();
    expect(host.querySelector('.pj-head')).toBeNull();
  });
});

describe('ProjectsList: Sort by recent activity (user-projects-enabled, chat/sidebarSort.ts)', () => {
  const T = (hhmm: string) => `2026-11-10T${hhmm}:00Z`;
  // termag's sessions started at 10:00 (a), 11:00 (b) and 09:00 (c); its checkout was last active at 12:45.
  const termag = () => ({ ...project('termag', ['example-org/termag'], 'claude-chat', T('12:45')),
    workstreams: [['a', '10:00'], ['b', '11:00'], ['c', '09:00']].map(([name, at]) => ({ id: `t-${name}`, name, lastActiveAt: T(at) })) }) as unknown as Project;
  const scratch = (lastActiveAt = T('12:00')) => ({ ...project('scratch', [], 'claude', lastActiveAt),
    workstreams: [{ id: 's-main', name: 'main', lastActiveAt: T('08:00') }] }) as unknown as Project;
  // A session; with `since`, it has a status of its own that entered its state then. Without, it reads its
  // project's time, as buildRows gives a session no status has been posted for.
  const ws = (projectId: string, workstream: string, status: InboxRow['status'] = 'idle', since?: string, stoppedAt?: string): InboxRow => ({
    ...row(projectId, status), key: `${projectId}|${workstream}`, workstream, workstreamId: `${projectId}-${workstream}`,
    updatedAt: since ?? (projectId === 'termag' ? T('12:45') : T('12:00')), statusSince: since ?? null, stoppedAt: stoppedAt ?? null,
  });
  const ownStatus = (r: InboxRow) => r.statusSince != null;
  const setRows = (list: InboxRow[]) => {
    rows = list;
    projectsState = {
      ...projectsState,
      statusMap: Object.fromEntries(list.filter(ownStatus).map(r => [statusKey(r.instanceId, sessionName(r.owner, r.projectName, 'agent', r.workstream)), { status: r.status, updatedAt: r.updatedAt }])),
    };
  };
  const group = (key: string) => host.querySelector(`[data-group="${key}"]`);
  const names = (key: string) => [...(group(key)?.querySelectorAll('.sc .sc-title') ?? [])].map(n => n.textContent);
  const list = () => host.querySelector('.chat-projects')!;
  const pointer = (type: 'pointerover' | 'pointerout') => act(() => { list().dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: document.body })); });
  const TERMAG = 'repos:example-org/termag';

  beforeEach(() => {
    mocks.projectsOn = true;
    setSidebarView({ olderDays: 0, sort: 'recent' });
    projectsState = { ...projectsState, projects: [termag(), scratch()] };
    setRows([ws('termag', 'a', 'idle', T('12:30')), ws('termag', 'b'), ws('termag', 'c', 'idle', T('12:10')), ws('scratch', 'main', 'idle', T('12:20'))]);
  });

  it("puts each session by its own activity, never its project's, where Created has the newest started first", () => {
    show();
    // b has no status of its own: its row carries its project's 12:45, which is a's or c's, not b's.
    expect(names(TERMAG)).toEqual(['a', 'c', 'b']);
    act(() => setSidebarView({ sort: 'created' }));
    expect(names(TERMAG)).toEqual(['b', 'a', 'c']);
  });

  it('orders the groups by their most recently active session, a working one first', () => {
    show();
    expect(groupNames()).toEqual(['termag', 'No repo']);
    setRows([...rows.slice(0, 3), ws('scratch', 'main', 'working', T('08:30'))]);
    show();
    expect(groupNames()).toEqual(['No repo', 'termag']);
    // Created: by the checkouts' activity, as before.
    act(() => setSidebarView({ sort: 'created' }));
    expect(groupNames()).toEqual(['termag', 'No repo']);
  });

  it("orders Group by Status's sections by their newest session too", () => {
    setSidebarView({ groupBy: 'status' });
    // c's last turn ended at 12:40, and its box parked at 12:50.
    setRows([ws('termag', 'a', 'idle', T('12:30')), ws('termag', 'b', 'not_running'), ws('termag', 'c', 'not_running', T('12:50'), T('12:40')), ws('scratch', 'main', 'idle', T('12:20'))]);
    show();
    // Not running is the bottom row's (opened here at the list's end), and still sorts its own sessions by activity.
    act(() => { [...host.querySelectorAll<HTMLButtonElement>('.sb-dock button')].find(b => b.getAttribute('aria-label')?.startsWith('Not running'))!.click(); });
    expect(groupNames()).toEqual(['Idle', 'Not running']);
    expect(names('status:off')).toEqual(['c', 'b']);
    // scratch's main is called by its project.
    expect(names('status:recent')).toEqual(['a', 'scratch']);
    act(() => setSidebarView({ sort: 'created' }));
    expect(groupNames()).toEqual(['Idle', 'Not running']);
  });

  it("doesn't count a box parking as activity: a session that stopped running keeps its last turn's time", () => {
    // b's box parked just now; its last turn ended at 10:30, before a's (12:30) and c's (12:10).
    setRows([rows[0], ws('termag', 'b', 'not_running', T('12:59'), T('10:30')), rows[2], rows[3]]);
    show();
    expect(names(TERMAG)).toEqual(['a', 'c', 'b']);
  });

  it('keeps Needs you longest wait first', () => {
    setRows([{ ...ws('termag', 'a', 'waiting', T('12:30')), waitingReason: 'approval' }, { ...ws('termag', 'c', 'waiting', T('12:10')), waitingReason: 'approval' }, ws('termag', 'b')]);
    show();
    expect(names('needs-you')).toEqual(['c', 'a']);
  });

  it('holds the order while the pointer is over the list, and applies it once the pointer leaves', () => {
    show();
    pointer('pointerover');
    setRows([rows[0], ws('termag', 'b', 'idle', T('12:50')), rows[2], rows[3]]);
    show();
    expect(names(TERMAG)).toEqual(['a', 'c', 'b']);
    // A new session slots in beside its neighbour, and nothing else moves.
    projectsState = { ...projectsState, projects: [termag(), scratch()].map(p => (p.id === 'termag'
      ? { ...p, workstreams: [...p.workstreams, { id: 't-d', name: 'd', lastActiveAt: T('12:55') }] } as Project : p)) };
    setRows([...rows, ws('termag', 'd', 'idle', T('12:55'))]);
    show();
    expect(names(TERMAG)).toEqual(['d', 'a', 'c', 'b']);
    pointer('pointerout');
    expect(names(TERMAG)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('holds the order while keyboard focus is in the list', () => {
    show();
    const card = group(TERMAG)!.querySelector<HTMLElement>('.sc')!;
    act(() => { card.focus(); card.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })); });
    setRows([rows[0], ws('termag', 'b', 'idle', T('12:50')), rows[2], rows[3]]);
    show();
    expect(names(TERMAG)).toEqual(['a', 'c', 'b']);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    act(() => { outside.focus(); });
    expect(names(TERMAG)).toEqual(['b', 'a', 'c']);
    outside.remove();
  });

  it('holds the order while a menu from the list is open', async () => {
    show();
    click(group(TERMAG)!.querySelector('.chat-item-menu')!);
    setRows([rows[0], ws('termag', 'b', 'idle', T('12:50')), rows[2], rows[3]]);
    show();
    expect(names(TERMAG)).toEqual(['a', 'c', 'b']);
    expect(host.ownerDocument.querySelector('.chat-ctx-menu')).toBeTruthy();
    // React Aria moves focus into a menu a click with no pointer opened a frame late.
    await act(async () => { await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))); });
    act(() => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(host.ownerDocument.querySelector('.chat-ctx-menu')).toBeNull();
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    expect(names(TERMAG)).toEqual(['b', 'a', 'c']);
  });

  it('never moves the open session for its own activity', () => {
    show('/chat/p/termag?ws=c');
    expect(names(TERMAG)).toEqual(['a', 'c', 'b']);
    // Working in it would put it first; it keeps its place. Another session's activity still moves that one.
    setRows([rows[0], rows[1], ws('termag', 'c', 'working', T('12:58')), rows[3]]);
    show();
    expect(names(TERMAG)).toEqual(['a', 'c', 'b']);
    setRows([rows[0], ws('termag', 'b', 'idle', T('12:50')), rows[2], rows[3]]);
    show();
    expect(names(TERMAG)).toEqual(['b', 'a', 'c']);
  });

  it('changes nothing under Created: no hold while the pointer is over the list', () => {
    setSidebarView({ sort: 'created' });
    show();
    pointer('pointerover');
    projectsState = { ...projectsState, projects: [termag(), scratch(T('13:00'))] };
    show();
    expect(groupNames()).toEqual(['No repo', 'termag']);
  });
});

describe('ProjectsList: archived sessions (user-projects-enabled)', () => {
  // An archived worktree session (Workstream.explorerArchivedAt), beside a live one in the same project.
  const archived = (status: InboxRow['status'] = 'idle'): InboxRow => ({
    ...row('termag', status), key: 'termag|cmdk', workstream: 'cmdk', workstreamId: 'termag-cmdk', sessionTitle: '⌘K on phones', explorerArchived: true,
  });
  const titles = (sel: string) => [...host.querySelectorAll(`${sel} .sc .sc-title`)].map(n => n.textContent);
  const archivedButton = () => [...host.querySelectorAll<HTMLButtonElement>('.sb-dock button')].find(b => b.getAttribute('aria-label')?.startsWith('Archived'));
  beforeEach(() => {
    projectsState = { ...projectsState, projects: [project('termag', ['example-org/termag'])] };
  });

  it('leaves its project for Archived, counted on the bottom row, with Unarchive on its card', async () => {
    mocks.projectsOn = true;
    pinned.archived = 1;
    rows = [row('termag'), archived()];
    const spy = vi.spyOn(workstreamsApi, 'explorerArchive').mockResolvedValue({ id: 'termag-cmdk', explorerArchivedAt: null });
    show();
    expect(titles('[data-project-group="project"]')).toEqual(['termag']);
    // One archived chat (ArchivedChats counts it) and this session.
    expect(archivedButton()?.getAttribute('aria-label')).toBe('Archived, 2');
    act(() => { archivedButton()!.click(); });
    expect(titles('.archived-stub')).toEqual(['⌘K on phones']);
    const unarchive = host.querySelector<HTMLButtonElement>('.archived-stub [aria-label^="Unarchive ⌘K on phones"]')!;
    await act(async () => { unarchive.click(); });
    expect(spy).toHaveBeenCalledWith('termag', 'termag-cmdk', false);
    spy.mockRestore();
  });

  it('stays where it is while it works or needs you, as Files shows it', () => {
    mocks.projectsOn = true;
    rows = [row('termag'), archived('working')];
    show();
    expect(titles('[data-project-group="project"]')).toEqual(expect.arrayContaining(['⌘K on phones']));
  });

  it('stays where it is while it is open', () => {
    mocks.projectsOn = true;
    rows = [row('termag'), archived()];
    show('/chat/p/termag?ws=cmdk');
    expect(titles('[data-project-group="project"]')).toEqual(expect.arrayContaining(['⌘K on phones']));
  });

  it("stays where it is when it's shared: only its owner can unarchive it", () => {
    mocks.projectsOn = true;
    rows = [{ ...archived(), shared: true, owner: 'peter' }];
    show();
    // Nothing goes to Archived; it's still under Shared with me.
    expect(host.querySelector('.sb-dock [aria-label^="Archived"]')).toBeNull();
    expect(host.querySelector('.sb-dock [aria-label^="Shared with me"]')?.getAttribute('aria-label')).toBe('Shared with me, 1');
  });

  it('stays with an ask under it that works', () => {
    mocks.projectsOn = true;
    const ask = (status: InboxRow['status']): InboxRow => ({
      ...row('termag', status), key: 'termag|ask-1', workstream: 'ask-1', workstreamId: 'termag-ask-1', sessionTitle: 'Survey the callers',
      askParent: { projectId: 'termag', workstream: 'cmdk' },
    });
    rows = [row('termag'), archived(), ask('working')];
    linksMock.links = [{ projectId: 'termag', workstream: 'ask-1', parentProjectId: 'termag', parentWorkstream: 'cmdk' }];
    show();
    expect(titles('[data-project-group="project"]')).toEqual(expect.arrayContaining(['⌘K on phones', 'Survey the callers']));
  });

  it('takes the sessions under it to Archived, nested there, with Unarchive only on the archived one', () => {
    mocks.projectsOn = true;
    const ask: InboxRow = {
      ...row('termag'), key: 'termag|ask-1', workstream: 'ask-1', workstreamId: 'termag-ask-1', sessionTitle: 'Survey the callers',
      askParent: { projectId: 'termag', workstream: 'cmdk' },
    };
    rows = [row('termag'), archived(), ask];
    linksMock.links = [{ projectId: 'termag', workstream: 'ask-1', parentProjectId: 'termag', parentWorkstream: 'cmdk' }];
    show();
    expect(titles('[data-project-group="project"]')).toEqual(['termag']);
    act(() => { archivedButton()!.click(); });
    expect(titles('.archived-stub')).toEqual(['⌘K on phones', 'Survey the callers']);
    expect(host.querySelectorAll('.archived-stub [aria-label^="Unarchive"]')).toHaveLength(1);
  });

  it('offers no Unarchive on a session under an archived one, even one archived itself: it comes back with its parent', async () => {
    mocks.projectsOn = true;
    const ask: InboxRow = {
      ...row('termag'), key: 'termag|ask-1', workstream: 'ask-1', workstreamId: 'termag-ask-1', sessionTitle: 'Survey the callers',
      askParent: { projectId: 'termag', workstream: 'cmdk' }, explorerArchived: true,
    };
    rows = [row('termag'), archived(), ask];
    linksMock.links = [{ projectId: 'termag', workstream: 'ask-1', parentProjectId: 'termag', parentWorkstream: 'cmdk' }];
    show();
    act(() => { archivedButton()!.click(); });
    expect([...host.querySelectorAll('.archived-stub [aria-label^="Unarchive"]')].map(b => b.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/^Unarchive ⌘K on phones/),
    ]);
    // Its Unarchive clears both marks, so the pair comes back together.
    const spy = vi.spyOn(workstreamsApi, 'explorerArchive').mockResolvedValue({ id: 'x', explorerArchivedAt: null });
    await act(async () => { host.querySelector<HTMLButtonElement>('.archived-stub [aria-label^="Unarchive"]')!.click(); });
    expect(spy.mock.calls.map(c => c[1]).sort()).toEqual(['termag-ask-1', 'termag-cmdk']);
    spy.mockRestore();
  });

  it('stays where it is with the flag off', () => {
    rows = [row('termag'), archived()];
    show();
    expect([...host.querySelectorAll('.chat-item-name')].map(n => n.textContent)).toContain('⌘K on phones');
  });
});

describe('ProjectsList: a card\'s hover actions (user-projects-enabled)', () => {
  const worktree = (): InboxRow => ({ ...row('termag'), key: 'termag|cmdk', workstream: 'cmdk', workstreamId: 'termag-cmdk', sessionTitle: '⌘K on phones' });
  const over = (title: string) => host.querySelector<HTMLElement>(`.sc-wrap:has([data-tip*="${title}"]) .sc-over`)
    ?? [...host.querySelectorAll<HTMLElement>('.sc-wrap')].find(w => w.querySelector('.sc-title')?.textContent === title)?.querySelector<HTMLElement>('.sc-over') ?? null;
  const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
  // The toasts are LaunchPad's one snackbar queue: none carries over to the next test.
  afterEach(() => { act(() => { for (const t of snackbarQueue.visibleToasts) snackbarQueue.close(t.key); }); });
  beforeEach(() => {
    mocks.projectsOn = true;
    const p = project('termag', ['example-org/termag']);
    p.workstreams = [...p.workstreams, { id: 'termag-cmdk', name: 'cmdk', lastActiveAt: '2026-11-10T12:00:00Z' } as never];
    projectsState = { ...projectsState, projects: [p, project('solo', ['example-org/solo'])] };
  });

  it('offers Pin, Archive and ⋯, in that order, floating over the card', () => {
    rows = [row('termag'), worktree()];
    show();
    const labels = [...over('⌘K on phones')!.querySelectorAll('button')].map(b => b.getAttribute('aria-label'));
    expect(labels).toEqual([expect.stringMatching(/^Pin .* to top$/), expect.stringMatching(/^Archive /), expect.stringMatching(/^Options for /)]);
  });

  it('pins from the card', () => {
    rows = [row('termag'), worktree()];
    show();
    act(() => { over('⌘K on phones')!.querySelector<HTMLButtonElement>('[aria-label^="Pin "]')!.click(); });
    expect(pinned.pin).toHaveBeenCalledWith({ workstreamId: 'termag-cmdk', projectId: 'termag', workstream: 'cmdk' });
  });

  it("archives a worktree session with its archive mark, in one click, and never asks", async () => {
    rows = [row('termag'), worktree()];
    const mark = vi.spyOn(workstreamsApi, 'explorerArchive').mockResolvedValue({ id: 'termag-cmdk', explorerArchivedAt: 'now' });
    const plan = vi.spyOn(chatsApi, 'archivePlan');
    show();
    await act(async () => { over('⌘K on phones')!.querySelector<HTMLButtonElement>('[aria-label^="Archive "]')!.click(); });
    await flush();
    expect(mark).toHaveBeenCalledWith('termag', 'termag-cmdk', true);
    expect(plan).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Archived “⌘K on phones”');
    // Undo clears the mark.
    const undo = [...document.querySelectorAll<HTMLButtonElement>('.sb-toast button')].find(b => b.textContent === 'Undo')!;
    await act(async () => { undo.click(); });
    await flush();
    expect(mark).toHaveBeenLastCalledWith('termag', 'termag-cmdk', false);
    mark.mockRestore(); plan.mockRestore();
  });

  it("archives a checkout's last session through the chat archive, asking only when its dry run says the box stops", async () => {
    rows = [{ ...row('solo'), workstreamId: 'solo-main' }];
    const plan = vi.spyOn(chatsApi, 'archivePlan').mockResolvedValue({ box: { action: null, reason: 'other projects still use this box' } });
    const archive = vi.spyOn(chatsApi, 'archive').mockResolvedValue({ archived: true, box: { action: null, reason: 'other projects still use this box' } });
    show();
    await act(async () => { over('solo')!.querySelector<HTMLButtonElement>('[aria-label^="Archive "]')!.click(); });
    await flush();
    expect(plan).toHaveBeenCalledWith('solo');
    expect(archive).toHaveBeenCalledWith('solo');
    expect(document.querySelector('.chat-archived-confirm-dialog')).toBeNull();
    expect(document.body.textContent).toContain('Archived “solo”');

    archive.mockClear();
    plan.mockResolvedValue({ box: { action: 'stop', id: 'b1', name: 'demo-box' } });
    await act(async () => { over('solo')!.querySelector<HTMLButtonElement>('[aria-label^="Archive "]')!.click(); });
    await flush();
    expect(archive).not.toHaveBeenCalled();
    expect(document.querySelector('.chat-archived-confirm-dialog')?.textContent).toContain('the only thing on its box, demo-box');
    plan.mockRestore(); archive.mockRestore();
  });

  it("undoes a chat archive by reopening it once the list has it back, and says so while its box comes back", async () => {
    rows = [{ ...row('solo'), workstreamId: 'solo-main' }];
    const reload = vi.fn(async () => {});
    projectsState = { ...projectsState, reloadProjects: reload };
    const plan = vi.spyOn(chatsApi, 'archivePlan').mockResolvedValue({ box: { action: null, reason: 'a self-managed host is not powered from termag' } });
    const archive = vi.spyOn(chatsApi, 'archive').mockResolvedValue({ archived: true, box: { action: null, reason: 'a self-managed host is not powered from termag' } });
    const reopen = vi.spyOn(chatsApi, 'reopen').mockResolvedValue({ reopened: false, pending: true, box: null });
    show();
    await act(async () => { over('solo')!.querySelector<HTMLButtonElement>('[aria-label^="Archive "]')!.click(); });
    await flush();
    const undo = () => [...document.querySelectorAll<HTMLButtonElement>('.sb-toast button')].find(b => b.textContent === 'Undo')!;
    reload.mockClear();
    await act(async () => { undo().click(); });
    await flush();
    expect(reopen).toHaveBeenCalledWith('solo');
    // Still pending (the box's agent isn't back): it says so, and the list isn't read yet.
    expect(document.body.textContent).toContain('Bringing “solo” back');
    expect(reload).not.toHaveBeenCalled();
    plan.mockRestore(); archive.mockRestore(); reopen.mockRestore();
  });

  it("undoes a chat archive: reopened, the list read again, the session opened again when it was on screen", async () => {
    rows = [{ ...row('solo'), workstreamId: 'solo-main' }];
    const reload = vi.fn(async () => {});
    projectsState = { ...projectsState, reloadProjects: reload };
    const plan = vi.spyOn(chatsApi, 'archivePlan').mockResolvedValue({ box: { action: null, reason: 'other projects still use this box' } });
    const archive = vi.spyOn(chatsApi, 'archive').mockResolvedValue({ archived: true, box: { action: null, reason: 'other projects still use this box' } });
    const reopen = vi.spyOn(chatsApi, 'reopen').mockResolvedValue({ reopened: true, box: null });
    show('/chat/p/solo');
    await act(async () => { over('solo')!.querySelector<HTMLButtonElement>('[aria-label^="Archive "]')!.click(); });
    await flush();
    // It was on screen, so it left for the home.
    expect(at).toBe('/chat');
    reload.mockClear();
    const undo = [...document.querySelectorAll<HTMLButtonElement>('.sb-toast button')].find(b => b.textContent === 'Undo')!;
    await act(async () => { undo.click(); });
    await flush();
    expect(reopen).toHaveBeenCalledWith('solo');
    expect(reload).toHaveBeenCalled();
    expect(at).toBe('/chat/p/solo');
    plan.mockRestore(); archive.mockRestore(); reopen.mockRestore();
  });

  it("doesn't take the person back to an undone session once they've gone somewhere else", async () => {
    rows = [row('termag'), worktree()];
    const mark = vi.spyOn(workstreamsApi, 'explorerArchive').mockResolvedValue({ id: 'termag-cmdk', explorerArchivedAt: null });
    show('/chat/p/termag?ws=cmdk');
    await act(async () => { over('⌘K on phones')!.querySelector<HTMLButtonElement>('[aria-label^="Archive "]')!.click(); });
    await flush();
    expect(at).toBe('/chat');
    // They open another session before pressing Undo.
    await act(async () => { host.querySelector<HTMLAnchorElement>('.sc[href$="/chat/p/termag"]')!.click(); });
    expect(at).toBe('/chat/p/termag');
    const undo = [...document.querySelectorAll<HTMLButtonElement>('.sb-toast button')].find(b => b.textContent === 'Undo')!;
    await act(async () => { undo.click(); });
    await flush();
    expect(mark).toHaveBeenLastCalledWith('termag', 'termag-cmdk', false);
    expect(at).toBe('/chat/p/termag');
    mark.mockRestore();
  });

  it("asks before archiving when the dry run can't be read, since the box may stop", async () => {
    rows = [{ ...row('solo'), workstreamId: 'solo-main' }];
    const plan = vi.spyOn(chatsApi, 'archivePlan').mockRejectedValue(new Error('503'));
    const archive = vi.spyOn(chatsApi, 'archive');
    show();
    await act(async () => { over('solo')!.querySelector<HTMLButtonElement>('[aria-label^="Archive "]')!.click(); });
    await flush();
    expect(archive).not.toHaveBeenCalled();
    expect(document.querySelector('.chat-archived-confirm-dialog')?.textContent).toContain("Couldn't check");
    plan.mockRestore(); archive.mockRestore();
  });

  it('lets go of a card whose confirm another one replaced', async () => {
    rows = [{ ...row('solo'), workstreamId: 'solo-main' }, { ...row('duo'), workstreamId: 'duo-main' }];
    projectsState = { ...projectsState, projects: [...projectsState.projects, project('duo', ['example-org/duo'])] };
    const plan = vi.spyOn(chatsApi, 'archivePlan').mockResolvedValue({ box: { action: 'stop', id: 'b1', name: 'demo-box' } });
    show();
    const archiveOf = (title: string) => over(title)!.querySelector<HTMLButtonElement>('[aria-label^="Archive "]')!;
    await act(async () => { archiveOf('solo').click(); archiveOf('duo').click(); });
    await flush();
    // duo's confirm replaced solo's: solo's Archive works again.
    expect(archiveOf('solo').disabled).toBe(false);
    plan.mockRestore();
  });

  it("archives once however fast it's clicked", async () => {
    rows = [row('termag'), worktree()];
    let land: () => void = () => {};
    const mark = vi.spyOn(workstreamsApi, 'explorerArchive').mockImplementation(() => new Promise(r => { land = () => r({ id: 'termag-cmdk', explorerArchivedAt: 'now' }); }));
    show();
    const button = over('⌘K on phones')!.querySelector<HTMLButtonElement>('[aria-label^="Archive "]')!;
    act(() => { button.click(); button.click(); });
    expect(mark).toHaveBeenCalledTimes(1);
    await act(async () => { land(); });
    mark.mockRestore();
  });

  it("uses the session's own mark, not the chat archive, beside a sibling that's archived but still working", () => {
    rows = [{ ...row('termag'), workstreamId: 'termag-main' }, { ...worktree(), status: 'working', explorerArchived: true }];
    const plan = vi.spyOn(chatsApi, 'archivePlan');
    const mark = vi.spyOn(workstreamsApi, 'explorerArchive').mockResolvedValue({ id: 'termag-main', explorerArchivedAt: 'now' });
    show();
    act(() => { over('termag')!.querySelector<HTMLButtonElement>('[aria-label^="Archive "]')!.click(); });
    expect(plan).not.toHaveBeenCalled();
    expect(mark).toHaveBeenCalledWith('termag', 'termag-main', true);
    plan.mockRestore(); mark.mockRestore();
  });

  it("offers no Archive on a session that isn't the person's", () => {
    rows = [{ ...worktree(), shared: true, owner: 'peter' }];
    show();
    expect(host.querySelector('.sc-over [aria-label^="Archive "]')).toBeNull();
  });
});

describe("ProjectsList: a card's session menu (user-projects-enabled)", () => {
  const worktree = (over: Partial<InboxRow> = {}): InboxRow => ({
    ...row('termag'), key: 'termag|cmdk', workstream: 'cmdk', workstreamId: 'termag-cmdk', sessionTitle: '⌘K on phones',
    stoppedAt: new Date(Date.now() - 10 * 60_000).toISOString(), ...over,
  });
  const card = () => [...host.querySelectorAll<HTMLElement>('.sc-wrap')].find(w => w.querySelector('.sc-title')?.textContent === '⌘K on phones')!;
  const openMenu = () => act(() => { card().querySelector<HTMLButtonElement>('.item-menu-btn')!.click(); });
  const items = () => [...document.querySelectorAll('.chat-ctx-menu [role="menuitem"]')].map(i => i.querySelector('.chat-add-label')?.textContent);
  const pick = (label: string) => act(() => {
    [...document.querySelectorAll<HTMLElement>('.chat-ctx-menu [role="menuitem"]')].find(i => i.querySelector('.chat-add-label')?.textContent === label)!.click();
  });
  beforeEach(() => {
    mocks.projectsOn = true;
    linksMock.setUnseen.mockClear();
    const p = project('termag', ['example-org/termag']);
    p.workstreams = [...p.workstreams, { id: 'termag-cmdk', name: 'cmdk', lastActiveAt: '2026-11-10T12:00:00Z' } as never];
    projectsState = { ...projectsState, projects: [p] };
  });

  it('is about the session: Rename, Pin, Mark as unread, Copy link, Archive, and no tab words', () => {
    rows = [row('termag'), worktree()];
    show();
    openMenu();
    expect(items()).toEqual(['Rename…', 'Pin to top', 'Mark as unread', 'Copy link', 'Archive']);
  });

  it('marks it unread, and read again', () => {
    rows = [row('termag'), worktree()];
    show();
    openMenu();
    pick('Mark as unread');
    expect(linksMock.setUnseen).toHaveBeenCalledWith(expect.objectContaining({ key: 'termag|cmdk' }), true);
  });

  it('renames it from a dialog, as a person\'s title', async () => {
    rows = [row('termag'), worktree()];
    const rename = vi.spyOn(chatsApi, 'rename').mockResolvedValue({ title: 'Phone ⌘K', titleAt: 'now', titleSource: 'person' });
    show();
    openMenu();
    pick('Rename…');
    const input = document.querySelector<HTMLInputElement>('.chat-project-name-field input')!;
    expect(input.value).toBe('⌘K on phones');
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'Phone ⌘K');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { document.querySelector<HTMLFormElement>('.chat-project-dialog form')!.requestSubmit(); });
    expect(rename).toHaveBeenCalledWith('termag', 'cmdk', 'Phone ⌘K');
    rename.mockRestore();
  });

  it("keeps a title as it is but makes it the person's, so Claude's next one doesn't replace it", async () => {
    rows = [row('termag'), worktree({ sessionTitleSource: 'claude' })];
    const rename = vi.spyOn(chatsApi, 'rename').mockResolvedValue({ title: '⌘K on phones', titleAt: 'now', titleSource: 'person' });
    show();
    openMenu();
    pick('Rename…');
    await act(async () => { document.querySelector<HTMLFormElement>('.chat-project-dialog form')!.requestSubmit(); });
    expect(rename).toHaveBeenCalledWith('termag', 'cmdk', '⌘K on phones');
    rename.mockRestore();
  });

  it('copies its link', async () => {
    rows = [row('termag'), worktree()];
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    show();
    openMenu();
    await act(async () => { pick('Copy link'); });
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/chat\/p\/termag\?ws=cmdk$/));
  });

  it("can't mark the session on screen unread: looking at it marks it seen", () => {
    rows = [row('termag'), worktree()];
    show('/chat/p/termag?ws=cmdk');
    openMenu();
    const unread = [...document.querySelectorAll<HTMLElement>('.chat-ctx-menu [role="menuitem"]')].find(i => i.querySelector('.chat-add-label')?.textContent === 'Mark as unread')!;
    expect(unread.getAttribute('aria-disabled')).toBe('true');
    expect(unread.textContent).toContain("It's on screen");
  });

  it("can't mark a working session unread yet, and says why", () => {
    rows = [row('termag'), worktree({ status: 'working' })];
    show();
    openMenu();
    const unread = [...document.querySelectorAll<HTMLElement>('.chat-ctx-menu [role="menuitem"]')].find(i => i.querySelector('.chat-add-label')?.textContent === 'Mark as unread')!;
    expect(unread.getAttribute('aria-disabled')).toBe('true');
    expect(unread.textContent).toContain('Once it has finished its turn');
  });
});

describe("ProjectsList: the list's keys (user-projects-enabled)", () => {
  const worktree = (name: string, title: string): InboxRow => ({ ...row('termag'), key: `termag|${name}`, workstream: name, workstreamId: `termag-${name}`, sessionTitle: title });
  const cardOf = (title: string) => [...host.querySelectorAll<HTMLElement>('.sc')].find(c => c.querySelector('.sc-title')?.textContent === title)!;
  const press = (key: string, at: Element = document.activeElement!) => act(() => { at.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
  const focused = () => document.activeElement?.querySelector('.sc-title')?.textContent;
  beforeEach(() => {
    mocks.projectsOn = true;
    const p = project('termag', ['example-org/termag']);
    p.workstreams = [...p.workstreams, ...['a', 'b'].map(n => ({ id: `termag-${n}`, name: n, lastActiveAt: '2026-11-10T12:00:00Z' } as never))];
    projectsState = { ...projectsState, projects: [p] };
    rows = [{ ...row('termag'), workstreamId: 'termag-main', sessionTitle: 'Main' }, worktree('a', 'Alpha'), worktree('b', 'Beta')];
  });

  it('moves focus with j and k, and only while focus is in the list', () => {
    show();
    const titles = [...host.querySelectorAll('.sc .sc-title')].map(t => t.textContent);
    cardOf(titles[0]!).focus();
    press('j');
    expect(focused()).toBe(titles[1]);
    press('ArrowDown');
    expect(focused()).toBe(titles[2]);
    press('k');
    expect(focused()).toBe(titles[1]);
    // Typed anywhere else, the keys do nothing.
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    press('j', input);
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it('archives the focused card with e, and pins it with p', async () => {
    const mark = vi.spyOn(workstreamsApi, 'explorerArchive').mockResolvedValue({ id: 'termag-a', explorerArchivedAt: 'now' });
    show();
    cardOf('Alpha').focus();
    await act(async () => { cardOf('Alpha').dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true })); });
    expect(mark).toHaveBeenCalledWith('termag', 'termag-a', true);
    // Focus stays on it until it has left the list (useListKeys.test.tsx follows it on from there).
    expect(focused()).toBe('Alpha');
    cardOf('Beta').focus();
    press('p');
    expect(pinned.pin).toHaveBeenCalledWith({ workstreamId: 'termag-b', projectId: 'termag', workstream: 'b' });
    mark.mockRestore();
  });

  it("goes no further than the ends from a head, and reaches the list's keys from a card's own buttons", () => {
    show();
    const titles = [...host.querySelectorAll('.sc .sc-title')].map(t => t.textContent);
    const head = host.querySelector<HTMLElement>('.pj-fold')!;
    head.focus();
    press('k');
    // Nothing above the first head: focus stays on it.
    expect(document.activeElement).toBe(head);
    // From a card's floating Pin (a React Aria button), j still moves on.
    const pin = [...host.querySelectorAll<HTMLElement>('.sc-wrap')].find(w => w.querySelector('.sc-title')?.textContent === titles[0])!.querySelector<HTMLElement>('.sc-pin')!;
    pin.focus();
    press('j');
    expect(focused()).toBe(titles[1]);
  });

  it('publishes the project heads it draws for the collapsed rail', () => {
    let seen: readonly string[] | null = null;
    function Probe() { seen = useRailProjects(); return null; }
    const probe = document.createElement('div');
    const probeRoot = createRoot(probe);
    act(() => probeRoot.render(<Probe />));
    mocks.userProjects = [{ id: 'up-t', name: 'termag', archived: false, lastActiveAt: '2026-11-10T12:00:00Z' }];
    projectsState.projects.forEach(p => { (p as { userProjectId?: string }).userProjectId = 'up-t'; });
    show();
    expect(seen).toEqual(['up-t']);
    act(() => probeRoot.unmount());
  });

  it('tells a screen reader the keys', () => {
    show();
    const list = host.querySelector('.chat-projects')!;
    expect(document.getElementById(list.getAttribute('aria-describedby')!)?.textContent).toContain('j and k move between sessions');
  });
});
