// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import { readQueued, writeQueued } from '../../chat/newChat';

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  send: vi.fn(),
  noBoxes: [] as unknown[],
}));

vi.mock('../../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  chatApi: { history: mocks.history, send: mocks.send, reclaim: vi.fn(), interrupt: vi.fn(), openInTerminal: vi.fn(), trust: vi.fn() },
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

import { SdkChatView } from './SdkChatView';

const project = {
  id: 'p1', name: 'web', instanceId: null, repoUrl: null, setupStatus: 'ready', setupError: null, role: 'owner', workflows: [], workstreams: [],
} as unknown as Project;

// What routes/chat.ts storedHistoryFor answers when the box can't.
const storedHistory = {
  chatKey: 'p1--main', workstream: 'main', sessionId: 's1', running: false, queued: 0, liveInput: false, parked: false, turn: null,
  checkoutReady: true, sendsLive: false, imageInput: false, stopsTurn: false,
  entries: [], turns: [], model: 'sonnet', trust: { trusted: true, reason: 'trusted', mode: 'bypassPermissions' }, canTrust: true,
  stored: true,
};

let root: Root;
let container: HTMLDivElement;

async function flush() {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter><SdkChatView project={project} workstream="main" /></MemoryRouter>);
  });
  await flush();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  sessionStorage.clear();
  mocks.history.mockReset();
  mocks.send.mockReset();
  mocks.send.mockResolvedValue({ queued: false, turnId: 't1' });
});

afterEach(() => {
  if (container?.isConnected) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('SdkChatView on a stored transcript', () => {
  it('keeps a queued message queued: the box is not there to take it', async () => {
    writeQueued(localStorage, 'p1', 'hello');
    mocks.history.mockResolvedValue(storedHistory);
    await render();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(readQueued(localStorage, 'p1')).toBe('hello');
  });

  it('sends the queued message once the box answers the history itself', async () => {
    writeQueued(localStorage, 'p1', 'hello');
    mocks.history.mockResolvedValue({ ...storedHistory, stored: undefined });
    await render();
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});
