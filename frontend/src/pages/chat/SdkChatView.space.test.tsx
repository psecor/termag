// @vitest-environment jsdom
// A chat belongs to one space, fixed when it started (plan-outbox #38): a
// message names no space, since the server loads the chat's own, and the
// header chip shows that space, not its tab's or its box's first.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  send: vi.fn(),
  models: vi.fn(),
  noBoxes: [] as unknown[],
}));

vi.mock('../../flags', async importOriginal => {
  const actual = await importOriginal<typeof import('../../flags')>();
  return { ...actual, useFlag: <T,>(_key: string, fallback: T) => fallback };
});

vi.mock('../../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  chatApi: { history: mocks.history, send: mocks.send, reclaim: vi.fn(), interrupt: vi.fn(), openInTerminal: vi.fn(), trust: vi.fn() },
  providersApi: { models: mocks.models },
  activityApi: { heartbeat: () => Promise.resolve() },
  visitsApi: { record: () => Promise.resolve() },
}));
vi.mock('../../contexts/ProjectContext', async importOriginal => ({
  ...(await importOriginal<typeof import('../../contexts/ProjectContext')>()),
  useProjects: () => ({ settleProjectClone: vi.fn(), reloadProjects: vi.fn() }),
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
// The tabs: this session's, opened in `design`.
const simple = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('./simpleData', () => ({ useSimpleDataIfAny: () => simple.value }));

import { SdkChatView } from './SdkChatView';
import { ChatSpacesProvider, type SharedChatSpaces } from '../../chat/useChatSpaces';
import { spaceColor } from '../../chat/spaceColors';
import { ChatChromeProvider } from './chatChrome';
import { resetBackendChoicesForTests } from '../../providers/useBackendChoices';

const project = {
  id: 'p1', name: 'web', instanceId: null, repoUrl: null, setupStatus: 'ready', setupError: null, role: 'owner', workflows: [], workstreams: [],
} as unknown as Project;

function historyOn(model: string, backend?: string) {
  return {
    ...(backend ? { backend } : {}),
    chatKey: 'p1--main', workstream: 'main', sessionId: 's1', running: false, queued: 0, checkoutReady: true,
    entries: [], turns: [], model, trust: { trusted: true, reason: 'trusted', mode: 'bypassPermissions' }, canTrust: true,
  };
}

let root: Root;
let container: HTMLDivElement;

async function flush() {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}

const sp = (id: string, name: string) => ({ id, name, description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role: 'owner' as const, readOnly: false });
const shared: SharedChatSpaces = {
  loaded: true, current: true, spaces: [sp('s1', 'alpha'), sp('s2', 'beta')],
  index: new Map([['box1', ['alpha', 'beta']]]), colorOf: spaceColor,
};

async function render(phone?: boolean, p: Project = project) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const view = <MemoryRouter><ChatSpacesProvider value={shared}><SdkChatView project={p} workstream="main" /></ChatSpacesProvider></MemoryRouter>;
  await act(async () => {
    root.render(phone
      ? (
        <ChatChromeProvider value={{ mode: 'drawer', historyOpen: false, openHistory: () => {}, closeHistory: () => {} }}>{view}</ChatChromeProvider>
      )
      : view);
  });
  await flush();
}

function unmount() {
  act(() => root.unmount());
  container.remove();
}

function modelButton(): HTMLButtonElement {
  return document.querySelector('.chat-composer-bar .chat-compose-model-btn') as HTMLButtonElement;
}

async function pickModel(label: string) {
  await act(async () => { modelButton().click(); });
  const option = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent === label) as HTMLButtonElement;
  await act(async () => { option.click(); });
}

async function typeAndSend(text: string) {
  const input = document.querySelector('textarea.chat-input') as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const send = document.querySelector('button[type="submit"][aria-label="Send"]') as HTMLButtonElement;
  await act(async () => { send.click(); });
  await flush();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  sessionStorage.clear();
  mocks.history.mockReset();
  mocks.send.mockReset();
  mocks.send.mockResolvedValue({ queued: false, turnId: 't1' });
  mocks.models.mockReset();
  mocks.models.mockResolvedValue({ providers: {} });
  resetBackendChoicesForTests();
});

afterEach(() => { if (container?.isConnected) unmount(); });

describe('SdkChatView space memory', () => {
  const tabs = (space?: string) => ({
    items: { noteSent: vi.fn(), state: { seeded: true, items: [{ kind: 'chat', id: 't1', projectId: 'p1', workstream: 'main', openedAt: 1, ...(space ? { space } : {}) }] } },
    activeTab: 't1',
  });

  it('a message names no space, whatever space its tab was opened from: the server loads the chat\'s own', async () => {
    simple.value = tabs('design');
    mocks.history.mockResolvedValue(historyOn('sonnet'));
    await render();
    await typeAndSend('hello');
    expect(mocks.send).toHaveBeenLastCalledWith('p1', 'main', 'hello', [], null);
    unmount();
    simple.value = null;
    await render();
    await typeAndSend('again');
    expect(mocks.send).toHaveBeenLastCalledWith('p1', 'main', 'again', [], null);
  });

  it('the header chip shows the chat\'s own space, which is the one its memory loads, not its box\'s first', async () => {
    simple.value = tabs('alpha');
    mocks.history.mockResolvedValue(historyOn('sonnet'));
    const inBeta = { ...project, instanceId: 'box1', workstreams: [{ id: 'ws1', name: 'main', spaceId: 's2', spaceFixedAt: '2026-10-27T00:00:00Z' }] } as unknown as Project;
    await render(false, inBeta);
    expect(document.querySelector('.chat-title-space')?.textContent).toBe('beta');
    unmount();
    const inNone = { ...inBeta, workstreams: [{ id: 'ws1', name: 'main', spaceId: null, spaceFixedAt: '2026-10-27T00:00:00Z' }] } as unknown as Project;
    await render(false, inNone);
    expect(document.querySelector('.chat-title-space')?.textContent).toBe('No space');
  });
});
