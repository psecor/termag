// @vitest-environment jsdom
// lab.opened {from} from the SDK chat's ways into Lab (chat/labOpened.ts).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  openInTerminal: vi.fn(),
  reloadProjects: vi.fn(),
  noBoxes: [] as unknown[],
  recorded: [] as Array<{ name: string; attributes: unknown }>,
}));

vi.mock('../../observability', async importOriginal => ({
  ...(await importOriginal<typeof import('../../observability')>()),
  recordProductEvent: (name: string, attributes: unknown) => { mocks.recorded.push({ name, attributes }); },
}));
vi.mock('../../flags', async importOriginal => {
  const actual = await importOriginal<typeof import('../../flags')>();
  return { ...actual, useFlag: <T,>(_key: string, fallback: T) => fallback };
});
vi.mock('../../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  chatApi: { history: mocks.history, send: vi.fn(), reclaim: vi.fn(), interrupt: vi.fn(), openInTerminal: mocks.openInTerminal, trust: vi.fn() },
  providersApi: { models: () => Promise.resolve({ providers: {} }) },
  activityApi: { heartbeat: () => Promise.resolve() },
  visitsApi: { record: () => Promise.resolve() },
}));
vi.mock('../../contexts/ProjectContext', async importOriginal => ({
  ...(await importOriginal<typeof import('../../contexts/ProjectContext')>()),
  useProjects: () => ({ settleProjectClone: vi.fn(), reloadProjects: mocks.reloadProjects }),
}));
vi.mock('../../services/boxFeed', () => ({
  boxFeed: {
    subscribe: () => () => {},
    getSnapshot: () => mocks.noBoxes,
    hasLoaded: () => true,
    isGone: () => false,
    lookFor: () => {},
  },
}));
vi.mock('../../chat/chatEvents', () => ({
  chatEvents: { subscribe: () => () => {}, subscribeReconnect: () => () => {} },
}));
vi.mock('../../chat/ClaudeLoginCard', () => ({ ClaudeLoginCard: () => null }));
vi.mock('../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));

import { SdkChatView } from './SdkChatView';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';
import { resetBackendChoicesForTests } from '../../providers/useBackendChoices';
import { clearRunningBox, saveRunningBox } from '../../chat/archive';

const project = {
  id: 'p1', name: 'web', instanceId: null, repoUrl: null, setupStatus: 'ready', setupError: null, role: 'owner', workflows: [], workstreams: [],
} as unknown as Project;

const history = {
  chatKey: 'p1--main', workstream: 'main', sessionId: 's1', running: false, queued: 0, checkoutReady: true,
  entries: [], turns: [], model: 'opus', trust: { trusted: true, reason: 'trusted', mode: 'bypassPermissions' }, canTrust: true,
};

let root: Root;
let container: HTMLDivElement;
let where = '';

function Where() {
  const { pathname, search } = useLocation();
  where = `${pathname}${search}`;
  return null;
}

async function flush() {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}

async function render(chrome: Partial<ChatChrome> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const value: ChatChrome = { mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, ...chrome };
  await act(async () => {
    root.render(
      <ChatChromeProvider value={value}>
        <MemoryRouter initialEntries={['/chat/p/p1']}><SdkChatView project={project} workstream="main" /><Where /></MemoryRouter>
      </ChatChromeProvider>,
    );
  });
  await flush();
}

const labOpened = () => mocks.recorded.filter(r => r.name === 'lab.opened').map(r => r.attributes);
const press = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const item = (selector: string, text: string) => [...document.querySelectorAll(selector)].find(el => el.textContent?.includes(text));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // React Aria escapes ids with CSS.escape, which jsdom lacks.
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (!css?.escape) (globalThis as { CSS?: unknown }).CSS = { ...css, escape: (v: string) => v.replace(/[^\w-]/g, c => `\\${c}`) };
  localStorage.clear();
  sessionStorage.clear();
  mocks.recorded.length = 0;
  mocks.history.mockReset();
  mocks.history.mockResolvedValue(history);
  mocks.openInTerminal.mockReset();
  mocks.openInTerminal.mockResolvedValue({});
  mocks.reloadProjects.mockReset();
  mocks.reloadProjects.mockResolvedValue(undefined);
  where = '';
  resetBackendChoicesForTests();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearRunningBox('p1');
});

describe('lab.opened from the SDK chat', () => {
  it('is session-menu from the refreshed header\'s ⋯ Open in Lab', async () => {
    await render({ refresh: true });
    await press(document.querySelector('.chat-session-more'));
    await press(item('[role="menuitem"]', 'Open in Lab'));
    expect(labOpened()).toEqual([{ 'termag.from': 'session-menu' }]);
    expect(where).toBe('/?project=p1&lab=1');
  });

  it('is session-menu from a phone\'s ⋯ Open in Lab', async () => {
    await render({ mode: 'drawer' });
    await press(document.querySelector('.chat-more-btn'));
    await press(item('.chat-ctx-menu [role=menuitem]', 'Open in Lab'));
    expect(labOpened()).toEqual([{ 'termag.from': 'session-menu' }]);
  });

  it('is header from the old header\'s Open in Lab', async () => {
    await render();
    await press(document.querySelector('.chat-header button.chat-full-ui'));
    expect(labOpened()).toEqual([{ 'termag.from': 'header' }]);
    expect(where).toBe('/?project=p1&lab=1');
  });

  it('sends nothing when Open in Lab is refused and the chat stays', async () => {
    mocks.openInTerminal.mockRejectedValue({ response: { data: { error: 'A turn is still running', code: 'turn-running' } } });
    await render();
    await press(document.querySelector('.chat-header button.chat-full-ui'));
    expect(labOpened()).toEqual([]);
    expect(where).toBe('/chat/p/p1');
  });

  it('is archived from an archived session\'s notice, only once the project list has reloaded', async () => {
    let reloaded!: () => void;
    mocks.reloadProjects.mockReturnValue(new Promise<void>(r => { reloaded = r; }));
    saveRunningBox({ projectId: 'p1', projectName: 'web', instanceId: 'box-1', message: 'Its box is still running.', retry: 'stop', announced: false });
    await render();
    await press(item('.chat-archived-error button', 'Open in Lab'));
    // The reload can still fail and leave the chat where it is, so nothing is counted yet.
    expect(labOpened()).toEqual([]);
    expect(where).toBe('/chat/p/p1');
    await act(async () => { reloaded(); });
    await flush();
    expect(labOpened()).toEqual([{ 'termag.from': 'archived' }]);
    expect(where).not.toBe('/chat/p/p1');
  });
});
