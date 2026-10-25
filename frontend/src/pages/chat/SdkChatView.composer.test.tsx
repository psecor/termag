// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';

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
  id: 'p1', name: 'web', instanceId: null, repoUrl: null, setupStatus: 'ready', setupError: null, role: 'owner',
} as unknown as Project;

function historyOn(model: string) {
  return {
    chatKey: 'p1--main', workstream: 'main', sessionId: 's1', running: false, queued: 0, checkoutReady: true,
    entries: [], turns: [], model, trust: { trusted: true, reason: 'trusted', mode: 'bypassPermissions' }, canTrust: true,
  };
}

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

function unmount() {
  act(() => root.unmount());
  container.remove();
}

async function type(text: string) {
  const input = document.querySelector('textarea.chat-input') as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const send = () => document.querySelector('form.chat-composer button[aria-label="Send"]') as HTMLButtonElement | null;
const actions = () => [...document.querySelectorAll('form.chat-composer .chat-compose-actions > button')].map(b => b.getAttribute('aria-label'));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  sessionStorage.clear();
  mocks.history.mockReset();
  mocks.send.mockReset();
  mocks.send.mockResolvedValue({ queued: false, turnId: 't1' });
});

afterEach(() => { if (container?.isConnected) unmount(); });

describe('SdkChatView composer', () => {
  it('shows Send only while there is something to send', async () => {
    mocks.history.mockResolvedValue(historyOn('sonnet'));
    await render();
    expect(send()).toBeNull();
    await type('hello');
    expect(send()).not.toBeNull();
    expect(send()!.disabled).toBe(false);
    await type('   ');
    expect(send()).toBeNull();
  });

  it('keeps the model, attach and send inside one composer, with send last', async () => {
    mocks.history.mockResolvedValue({ ...historyOn('sonnet'), imageInput: true });
    await render();
    expect(document.querySelector('form.chat-composer textarea.chat-input')).not.toBeNull();
    expect(document.querySelector('form.chat-composer .chat-composer-bar .chat-compose-model-btn')).not.toBeNull();
    expect(actions()).toEqual(['Attach images']);
    await type('look at this');
    expect(actions()).toEqual(['Attach images', 'Send']);
  });

  it('shows Stop while Claude works, and Send after it once there is a message', async () => {
    mocks.history.mockResolvedValue({ ...historyOn('sonnet'), running: true });
    await render();
    expect(actions()).toEqual(['Stop']);
    await type('and then this');
    expect(actions()).toEqual(['Stop', 'Send']);
  });
});
