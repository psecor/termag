// @vitest-environment jsdom
// The sidebar's Archived list: as it was with the chrome refresh off, and drawn
// like the refresh's sidebar with it on (ArchivedRows.tsx,
// docs/simple-ui-chrome-refresh.md "Archived").
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchivedChat } from '../../services/api';
import { clearRunningBox, saveRunningBox } from '../../chat/archive';
import { resetSidebarViewForTests, SIDEBAR_VIEW_KEY } from '../../chat/sidebarView';
import { ArchivedChats } from './ArchivedChats';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';

const api = vi.hoisted(() => ({
  archived: vi.fn<() => Promise<unknown[]>>(),
  reopen: vi.fn(),
  remove: vi.fn(),
}));
const up = vi.hoisted(() => ({
  on: false,
  list: null as null | Array<{ id: string; name: string; archived: boolean }>,
  settled: true,
  update: vi.fn(async () => ({})),
  reload: vi.fn(async () => {}),
}));
vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  return { ...actual, chatsApi: { ...actual.chatsApi, ...api }, userProjectsApi: { ...actual.userProjectsApi, update: up.update } };
});
vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (key === 'user-projects-enabled' ? up.on as T : fallback) };
});
vi.mock('./simpleData', () => ({ useSimpleDataIfAny: () => ({ userProjects: { list: up.list, failed: false, settled: up.settled, reload: up.reload } }) }));
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ reloadProjects: async () => {} }) }));
vi.mock('../../services/boxFeed', () => ({
  boxFeed: { reload: async () => {}, getSnapshot: () => [], upsert: () => {}, subscribe: () => () => {} },
}));

const chat = (id: string, status: string | null, extra: Partial<ArchivedChat> = {}): ArchivedChat => ({
  id, name: id, repoUrl: `https://github.com/example-org/${id}`, archivedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  box: status ? { id: `box-${id}`, name: `box-${id}`, kind: 'ec2', status: status as NonNullable<ArchivedChat['box']>['status'], hibernationConfigured: true } : null,
  otherProjects: 0, ...extra,
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // React Aria's Modal reads a CSP nonce through CSS.escape, which jsdom lacks.
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (!css?.escape) (globalThis as { CSS?: unknown }).CSS = { ...css, escape: (v: string) => v.replace(/[^\w-]/g, c => `\\${c}`) };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  localStorage.clear();
  resetSidebarViewForTests();
  api.archived.mockReset();
  up.on = false;
  up.list = null;
  up.settled = true;
  up.update.mockClear();
  up.reload.mockClear();
  api.reopen.mockReset();
  api.remove.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearRunningBox('webapp');
  vi.useRealTimers();
});

async function show(chrome: Partial<ChatChrome>, at = '/chat') {
  const value: ChatChrome = { mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, ...chrome };
  await act(async () => {
    root.render(<ChatChromeProvider value={value}><MemoryRouter initialEntries={[at]}><div className="chat-root"><ArchivedChats /></div></MemoryRouter></ChatChromeProvider>);
  });
}

const press = async (el: Element | null | undefined) => {
  if (!el) throw new Error('nothing to press');
  await act(async () => { (el as HTMLElement).click(); });
};
const menuLabels = () => [...document.querySelectorAll('[role="menuitem"]')].map(i => i.querySelector('[slot="label"]')?.textContent);
const menuItem = (label: string) => [...document.querySelectorAll('[role="menuitem"]')].find(i => i.querySelector('[slot="label"]')?.textContent === label);
const rows = () => [...host.querySelectorAll<HTMLElement>('.chat-archived-item')];

describe('ArchivedChats with the chrome refresh off', () => {
  it('is the list it was: a toggle, then each chat with its buttons', async () => {
    api.archived.mockResolvedValue([chat('webapp', 'stopped'), chat('js-core', 'terminated')]);
    await show({});
    const toggle = host.querySelector('.chat-archived-toggle')!;
    expect(toggle.textContent).toBe('▸ Archived 2');
    expect(host.querySelector('.chat-archived-group')).toBeNull();
    await press(toggle);
    const list = [...host.querySelectorAll('.chat-archived-row')];
    expect(list.map(r => r.querySelector('.chat-archived-meta')?.textContent)).toEqual(['example-org/webapp · box stopped', 'example-org/js-core · box gone']);
    expect([...list[0].querySelectorAll('button')].map(b => b.textContent)).toEqual(['Reopen', 'Delete forever…']);
    expect(list[1].querySelector<HTMLButtonElement>('.chat-archived-reopen')!.disabled).toBe(true);
  });

  it('confirms a delete in the old dialog', async () => {
    api.archived.mockResolvedValue([chat('webapp', 'stopped')]);
    api.remove.mockResolvedValue({});
    await show({});
    await press(host.querySelector('.chat-archived-toggle'));
    await press(host.querySelector('.chat-archived-delete'));
    expect(document.querySelector('.confirm-message')?.textContent).toContain('Delete webapp permanently?');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await press(document.querySelector('.confirm-btn-confirm'));
    expect(api.remove).toHaveBeenCalledWith('webapp');
  });

  it('is hidden with nothing archived', async () => {
    api.archived.mockResolvedValue([]);
    await show({});
    expect(host.querySelector('.chat-archived')).toBeNull();
  });
});

describe('ArchivedChats under the chrome refresh', () => {
  it('heads the section like a space, folded, with its count', async () => {
    api.archived.mockResolvedValue([chat('webapp', 'stopped'), chat('js-core', 'hibernated')]);
    await show({ refresh: true });
    const section = host.querySelector('.chat-archived-group')!;
    expect(section.getAttribute('data-folded')).toBe('true');
    expect(host.querySelector('.chat-archived')).toBeNull();
    const fold = section.querySelector('.chat-group-head .chat-group-toggle')!;
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(fold.querySelector('.chat-group-caret')).not.toBeNull();
    expect(fold.querySelector('.chat-group-name')?.textContent).toBe('Archived');
    expect(fold.querySelector('.chat-group-count')?.textContent).toBe('2');
    expect(fold.textContent).toContain('2 sessions');
    expect(rows()).toEqual([]);
    await press(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(fold.getAttribute('aria-controls')).toBe('chat-archived-rows');
    expect(section.hasAttribute('data-folded')).toBe(false);
  });

  it('draws each chat as a one-line row: the name, then its box in a word', async () => {
    api.archived.mockResolvedValue([chat('webapp', 'stopped'), chat('js-core', 'terminated')]);
    await show({ refresh: true });
    await press(host.querySelector('.chat-archived-fold'));
    const [a, b] = rows();
    expect(a.closest('li')?.classList.contains('chat-item-li')).toBe(true);
    expect(a.classList.contains('chat-item')).toBe(true);
    expect(a.getAttribute('data-state')).toBe('off');
    expect(a.querySelector('.chat-item-name')?.textContent).toBe('webapp');
    expect(a.querySelector('.chat-item-age')?.textContent).toBe('Stopped');
    expect(b.querySelector('.chat-item-age')?.textContent).toBe('Gone');
    expect(a.getAttribute('aria-label')).toBe('webapp, box stopped');
    expect(a.getAttribute('data-tip')).toBe('webapp\nexample-org/webapp\nBox stopped\nArchived 2h ago');
    expect(a.getAttribute('aria-haspopup')).toBe('true');
    // No buttons of the old list: the actions are in the row's menu.
    expect(host.querySelector('.chat-archived-reopen, .chat-archived-delete, .btn-tiny')).toBeNull();
  });

  it('draws a Standard row as the session rows do: the name and age, then where and the box', async () => {
    localStorage.setItem(SIDEBAR_VIEW_KEY, JSON.stringify({ density: 'standard' }));
    resetSidebarViewForTests();
    api.archived.mockResolvedValue([chat('webapp', 'hibernated')]);
    await show({ refresh: true });
    await press(host.querySelector('.chat-archived-fold'));
    const [a] = rows();
    expect(a.getAttribute('data-density')).toBe('standard');
    expect(a.querySelector('.chat-item-top .chat-item-age')?.textContent).toBe('2h');
    expect(a.querySelector('.chat-item-where')?.textContent).toBe('example-org/webapp');
    expect(a.querySelector('.chat-item-state')?.textContent).toBe('Box hibernated');
  });

  it('marks the chat on screen as the selected row', async () => {
    api.archived.mockResolvedValue([chat('webapp', 'ready'), chat('js-core', 'stopped')]);
    await show({ refresh: true }, '/chat/p/webapp');
    await press(host.querySelector('.chat-archived-fold'));
    expect(rows().map(r => r.classList.contains('active'))).toEqual([true, false]);
    expect(rows()[0].getAttribute('aria-current')).toBe('page');
  });

  it('opens Reopen and Delete forever… from the row, and Reopen reopens it', async () => {
    api.archived.mockResolvedValue([chat('webapp', 'stopped')]);
    api.reopen.mockResolvedValue({ reopened: false, pending: true, box: null });
    await show({ refresh: true });
    await press(host.querySelector('.chat-archived-fold'));
    await press(rows()[0]);
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Actions for webapp');
    expect(menuLabels()).toEqual(['Reopen', 'Delete forever…']);
    expect(menuItem('Reopen')?.querySelector('[slot="description"]')?.textContent).toBe('Start the box again and open the session');
    await press(menuItem('Reopen'));
    expect(api.reopen).toHaveBeenCalledWith('webapp');
    // The box is starting: the row says so with the spinner, and the note says why it stays archived.
    expect(rows()[0].querySelector('.chat-status-mark[data-status="working"] [role="progressbar"]')).not.toBeNull();
    expect(host.querySelector('.chat-archived-note[role="status"]')?.textContent).toMatch(/stays archived until its agent connects/);
  });

  it('cannot reopen a chat whose box is gone, and says why', async () => {
    api.archived.mockResolvedValue([chat('webapp', 'terminated')]);
    await show({ refresh: true });
    await press(host.querySelector('.chat-archived-fold'));
    await press(rows()[0]);
    expect(menuItem('Reopen')?.getAttribute('aria-disabled')).toBe('true');
    expect(menuItem('Reopen')?.querySelector('[slot="description"]')?.textContent).toBe('Its box is gone, and its history with it');
  });

  it('offers Box still running for a chat this tab archived while its box stayed up', async () => {
    saveRunningBox({ projectId: 'webapp', projectName: 'webapp', instanceId: 'box-webapp', message: 'still up', retry: 'stop', announced: false });
    api.archived.mockResolvedValue([chat('webapp', 'ready')]);
    await show({ refresh: true });
    await press(host.querySelector('.chat-archived-fold'));
    await press(rows()[0]);
    expect(menuLabels()).toEqual(['Reopen', 'Box still running', 'Delete forever…']);
  });

  it('confirms Delete forever… in LaunchPad\'s alert dialog, then deletes', async () => {
    api.archived.mockResolvedValue([chat('webapp', 'stopped')]);
    api.remove.mockResolvedValue({});
    await show({ refresh: true });
    await press(host.querySelector('.chat-archived-fold'));
    await press(rows()[0]);
    await press(menuItem('Delete forever…'));
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Delete webapp permanently?');
    expect(dialog.textContent).toContain('Its box is terminated');
    expect(document.querySelector('.confirm-message')).toBeNull();
    const buttons = [...dialog.querySelectorAll('button')];
    expect(buttons.map(b => b.textContent)).toEqual(['Cancel', 'Delete permanently']);
    await press(buttons[0]);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(api.remove).not.toHaveBeenCalled();
    await press(rows()[0]);
    await press(menuItem('Delete forever…'));
    await press([...document.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent === 'Delete permanently'));
    expect(api.remove).toHaveBeenCalledWith('webapp');
  });
});

describe("ArchivedChats: the person's archived projects", () => {
  it('lists them first under the flag, each with Unarchive, which brings the project back', async () => {
    up.on = true;
    up.list = [{ id: 'up-1', name: 'Termag web', archived: true }, { id: 'up-2', name: 'Live one', archived: false }];
    api.archived.mockResolvedValue([chat('webapp', 'stopped')]);
    await show({ refresh: true });
    const fold = host.querySelector('.chat-archived-group .chat-group-toggle')!;
    expect(fold.querySelector('.chat-group-count')?.textContent).toBe('2');
    expect(fold.textContent).toContain('1 project, 1 session');
    await press(fold);
    const project = host.querySelector('[data-archived="project"] .chat-archived-item')!;
    expect(project.querySelector('.chat-item-name')?.textContent).toBe('Termag web');
    expect(project.querySelector('.chat-item-age')?.textContent).toBe('Project');
    expect(rows().map(r => r.querySelector('.chat-item-name')?.textContent)).toEqual(['Termag web', 'webapp']);
    await press(project);
    expect(menuLabels()).toEqual(['Unarchive']);
    await press(menuItem('Unarchive'));
    expect(up.update).toHaveBeenCalledWith('up-1', { archived: false });
    expect(up.reload).toHaveBeenCalled();
  });

  it("waits for the archived sessions before showing archived projects, so the count isn't short", async () => {
    up.on = true;
    up.list = [{ id: 'up-1', name: 'Termag web', archived: true }];
    api.archived.mockReturnValue(new Promise(() => {}));
    await show({ refresh: true });
    expect(host.querySelector('.chat-archived-group')).toBeNull();
  });

  it("waits for the person's projects too under the flag, so archived ones don't pop in after the sessions", async () => {
    up.on = true;
    up.settled = false;
    api.archived.mockResolvedValue([chat('webapp', 'stopped')]);
    await show({ refresh: true });
    expect(host.querySelector('.chat-archived-group')).toBeNull();
    up.settled = true;
    up.list = [{ id: 'up-1', name: 'Termag web', archived: true }];
    await show({ refresh: true });
    expect(host.querySelector('.chat-archived-group .chat-group-count')?.textContent).toBe('2');
  });

  it('shows the section for an archived project with no archived session, and nothing of it with the flag off', async () => {
    up.on = true;
    up.list = [{ id: 'up-1', name: 'Termag web', archived: true }];
    api.archived.mockResolvedValue([]);
    await show({ refresh: true });
    expect(host.querySelector('.chat-archived-group .chat-group-count')?.textContent).toBe('1');
    up.on = false;
    await show({ refresh: true });
    expect(host.querySelector('.chat-archived-group')).toBeNull();
  });
});

describe('ArchivedChats when the list fails to load', () => {
  it('asks again after a failure the orchestrator caused, so the section comes back', async () => {
    vi.useFakeTimers();
    api.archived
      .mockRejectedValueOnce({ response: { status: 502 } })
      .mockResolvedValue([chat('webapp', 'stopped')]);
    await show({ refresh: true });
    expect(host.querySelector('.chat-archived-group')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(api.archived).toHaveBeenCalledTimes(2);
    expect(host.querySelector('.chat-archived-group .chat-group-count')?.textContent).toBe('1');
  });

  it('does not ask again after a refusal, nor once the sidebar is gone', async () => {
    vi.useFakeTimers();
    api.archived.mockRejectedValue({ response: { status: 403 } });
    await show({});
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.archived).toHaveBeenCalledTimes(1);

    api.archived.mockReset();
    api.archived.mockRejectedValue(new Error('Network Error'));
    act(() => root.unmount());
    root = createRoot(host);
    await show({});
    expect(api.archived).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.archived).toHaveBeenCalledTimes(1);
  });
});

describe('ArchivedChats as a section of the bottom row (the sidebar redesign)', () => {
  async function showDocked(open: boolean, onCount: (n: number) => void, sessions?: React.ReactNode[]) {
    const value: ChatChrome = { mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, refresh: true };
    await act(async () => {
      root.render(<ChatChromeProvider value={value}><MemoryRouter initialEntries={['/chat']}><div className="chat-root"><ArchivedChats dock={{ open, onCount, sessions }} /></div></MemoryRouter></ChatChromeProvider>);
    });
  }
  // The redesign's cards: each one's title.
  const cardTitles = () => [...host.querySelectorAll('.chat-archived-li .sc-title, .chat-archived-li .session-stub')].map(n => n.textContent);

  it('counts every archived session and project for its button, and draws nothing until it is open', async () => {
    up.on = true;
    up.list = [{ id: 'up-1', name: 'Old project', archived: true }, { id: 'up-2', name: 'Live', archived: false }];
    api.archived.mockResolvedValue([chat('webapp', 'stopped'), chat('js-core', 'terminated')]);
    const onCount = vi.fn();
    await showDocked(false, onCount);
    expect(onCount).toHaveBeenLastCalledWith(3);
    expect(host.querySelector('.chat-archived-group')).toBeNull();
    await showDocked(true, onCount);
    // Open: the list alone, under the head the sidebar draws, with no fold of its own.
    expect(host.querySelector('.chat-archived-group')?.hasAttribute('data-bare')).toBe(true);
    expect(host.querySelector('.chat-archived-fold')).toBeNull();
    expect(cardTitles()).toEqual(['Old project', 'webapp', 'js-core']);
  });

  it("draws each as a session card: its session's title, a ring and how long ago it was archived, the box's state in its tooltip", async () => {
    api.archived.mockResolvedValue([chat('webapp', 'stopped', { sessionTitle: 'Flag health endpoint', sessionTitleSource: 'claude' })]);
    await showDocked(true, vi.fn());
    const card = host.querySelector<HTMLElement>('[data-archived="chat"] .sc')!;
    expect(card.querySelector('.sc-title')?.textContent).toBe('Flag health endpoint');
    expect(card.querySelector('.sc-chip')?.getAttribute('data-kind')).toBe('off');
    expect(card.querySelector('.sc-chip-time')?.textContent).toBe('2h');
    expect(card.dataset.tip).toBe('Flag health endpoint\nwebapp\nexample-org/webapp\nArchived 2h ago\nBox stopped');
    // The model's mark, Claude unless the chat ran elsewhere.
    expect(card.querySelector('.sc-mark')?.getAttribute('data-tip')).toBe('Claude');
  });

  it('reopens from the Reopen floating over the card', async () => {
    api.archived.mockResolvedValue([chat('webapp', 'stopped')]);
    api.reopen.mockResolvedValue({ reopened: false, pending: true, box: null });
    await showDocked(true, vi.fn());
    const reopen = host.querySelector<HTMLButtonElement>('[data-archived="chat"] .sc-over [aria-label="Reopen webapp"]')!;
    await act(async () => { reopen.click(); });
    expect(api.reopen).toHaveBeenCalledWith('webapp');
  });

  it("shows the archived sessions it's handed even while the archived chats can't be read, and counts what it draws", async () => {
    up.on = true;
    up.list = [{ id: 'up-1', name: 'Old project', archived: true }];
    api.archived.mockRejectedValue({ response: { status: 403 } });
    const onCount = vi.fn();
    await showDocked(true, onCount, [<li key="s" className="chat-archived-li"><span className="session-stub">⌘K on phones</span></li>]);
    expect(cardTitles()).toEqual(['Old project', '⌘K on phones']);
    // The project it draws; ProjectsList adds the sessions.
    expect(onCount).toHaveBeenLastCalledWith(1);
  });

  it('shows the archived projects it has read even when the archived chats fail and it has no sessions', async () => {
    up.on = true;
    up.list = [{ id: 'up-1', name: 'Old project', archived: true }];
    api.archived.mockRejectedValue({ response: { status: 403 } });
    const onCount = vi.fn();
    await showDocked(true, onCount);
    expect(cardTitles()).toEqual(['Old project']);
    expect(onCount).toHaveBeenLastCalledWith(1);
  });

  it("lists the person's archived sessions after the projects, and shows with only those", async () => {
    up.on = true;
    up.list = [{ id: 'up-1', name: 'Old project', archived: true }];
    api.archived.mockResolvedValue([]);
    await showDocked(true, vi.fn(), [<li key="s" className="chat-archived-li"><span className="session-stub">⌘K on phones</span></li>]);
    expect(cardTitles()).toEqual(['Old project', '⌘K on phones']);
    up.list = [];
    await showDocked(true, vi.fn(), [<li key="s" className="chat-archived-li"><span className="session-stub">⌘K on phones</span></li>]);
    expect(cardTitles()).toEqual(['⌘K on phones']);
  });
});
