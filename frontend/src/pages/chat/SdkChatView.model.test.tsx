// @vitest-environment jsdom
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
  sidePanel: true,
}));

vi.mock('../../flags', async importOriginal => {
  const actual = await importOriginal<typeof import('../../flags')>();
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (key === actual.FLAGS.chatSidePanel ? mocks.sidePanel as T : fallback) };
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

import { SdkChatView } from './SdkChatView';
import { ChatChromeProvider } from './chatChrome';
import { resetBackendChoicesForTests } from '../../providers/useBackendChoices';

const project = {
  id: 'p1', name: 'web', instanceId: null, repoUrl: null, setupStatus: 'ready', setupError: null, role: 'owner',
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

async function render(phone?: boolean) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const view = <MemoryRouter><SdkChatView project={project} workstream="main" /></MemoryRouter>;
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

describe('SdkChatView model control', () => {
  it('does not show a guessed tier or take a choice before history reports the model', async () => {
    let resolveHistory!: (v: unknown) => void;
    mocks.history.mockReturnValue(new Promise(r => { resolveHistory = r; }));
    await render();
    expect(modelButton().disabled).toBe(true);
    expect(modelButton().textContent).toBe('…');
    // A click must not store a pick while the session's model is still unknown.
    await act(async () => { modelButton().click(); });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(localStorage.getItem('termag.chatModel.p1|main')).toBeNull();

    await act(async () => { resolveHistory(historyOn('sonnet')); });
    await flush();
    expect(modelButton().disabled).toBe(false);
    expect(modelButton().textContent).toBe('Sonnet 5.5');
  });

  it('shows the model the open session runs on', async () => {
    mocks.history.mockResolvedValue(historyOn('sonnet'));
    await render();
    expect(modelButton().textContent).toBe('Sonnet 5.5');
    expect(document.querySelector('.chat-composer-bar')?.textContent).not.toContain('From your next message');
  });

  it('sends a changed model with the next message only', async () => {
    mocks.history.mockResolvedValue(historyOn('sonnet'));
    await render();
    await pickModel('Haiku 4.5');
    expect(modelButton().textContent).toBe('Haiku 4.5');
    expect(document.querySelector('.chat-composer-bar')?.textContent).toContain('From your next message');

    await typeAndSend('switch to haiku');
    expect(mocks.send).toHaveBeenLastCalledWith('p1', 'main', 'switch to haiku', [], 'haiku');
    expect(modelButton().textContent).toBe('Haiku 4.5');
    expect(document.querySelector('.chat-composer-bar')?.textContent).not.toContain('From your next message');

    // The chat is on Haiku now: the message after carries no switch.
    await typeAndSend('and again');
    expect(mocks.send).toHaveBeenLastCalledWith('p1', 'main', 'and again', [], null);
  });

  it('keeps an unsent pick across a reload', async () => {
    mocks.history.mockResolvedValue(historyOn('sonnet'));
    await render();
    await pickModel('Opus 5.5');
    unmount();

    await render();
    expect(modelButton().textContent).toBe('Opus 5.5');
    await typeAndSend('after reload');
    expect(mocks.send).toHaveBeenLastCalledWith('p1', 'main', 'after reload', [], 'opus');
  });

  it('shows the sent model after a reload, from the history', async () => {
    mocks.history.mockResolvedValue(historyOn('sonnet'));
    await render();
    await pickModel('Haiku 4.5');
    await typeAndSend('switch');
    unmount();

    // The backend stored the switch on the project, so the reloaded history reports it.
    mocks.history.mockResolvedValue(historyOn('haiku'));
    await render();
    expect(modelButton().textContent).toBe('Haiku 4.5');
    expect(document.querySelector('.chat-composer-bar')?.textContent).not.toContain('From your next message');
  });

  it('a failed send keeps the pick for the next try', async () => {
    mocks.history.mockResolvedValue(historyOn('sonnet'));
    await render();
    await pickModel('Haiku 4.5');
    mocks.send.mockRejectedValueOnce(new Error('offline'));
    await typeAndSend('fails');
    expect(modelButton().textContent).toBe('Haiku 4.5');
    expect(document.querySelector('.chat-composer-bar')?.textContent).toContain('From your next message');
  });

  describe('with Fireworks on for the viewer', () => {
    const KIMI = 'accounts/fireworks/models/kimi-k3';
    beforeEach(() => {
      mocks.models.mockResolvedValue({ providers: { 'claude-chat': [
        { id: null, label: 'Default', models: [] },
        { id: 'fireworks', label: 'Fireworks', models: [{ id: KIMI, label: 'Kimi K3', context: 262144 }] },
      ] } });
    });

    it("offers the viewer's Fireworks models under their own heading, and sends the pick as one", async () => {
      mocks.history.mockResolvedValue(historyOn('sonnet'));
      await render();
      await act(async () => { modelButton().click(); });
      expect(document.querySelector('.chat-compose-option-group')?.textContent).toBe('Fireworks');
      await act(async () => { modelButton().click(); });
      await pickModel('Kimi K3');
      expect(modelButton().textContent).toBe('Kimi K3');
      await typeAndSend('try kimi');
      expect(mocks.send).toHaveBeenLastCalledWith('p1', 'main', 'try kimi', [], `fireworks:${KIMI}`);
    });

    it('shows a chat that runs on Fireworks by its model', async () => {
      mocks.history.mockResolvedValue(historyOn(KIMI, 'fireworks'));
      await render();
      expect(modelButton().textContent).toBe('Kimi K3');
    });
  });

  it('offers only the Claude tiers while Fireworks is off', async () => {
    mocks.history.mockResolvedValue(historyOn('sonnet'));
    await render();
    await act(async () => { modelButton().click(); });
    expect(document.querySelector('.chat-compose-option-group')).toBeNull();
    expect([...document.querySelectorAll('[role="option"]')].map(o => o.textContent)).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5']);
  });
});

describe('SdkChatView header on a phone', () => {
  const headerButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.chat-header button')].map(b => b.getAttribute('aria-label') ?? b.textContent);

  it('is one row: Sessions, the agent and its name, then ⋮ with Archive and Full UI', async () => {
    mocks.history.mockResolvedValue(historyOn('sonnet'));
    await render(true);
    expect(document.querySelector('.chat-header .chat-agent-icon')).not.toBeNull();
    expect(document.querySelector('.chat-header .chat-glyph')).toBeNull();
    expect(document.querySelector('.chat-header .chat-title-name')!.textContent).toBe('web');
    expect(headerButtons()).toEqual(['Sessions', 'More actions']);
    const more = document.querySelector<HTMLButtonElement>('.chat-more-btn')!;
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    await act(async () => { more.click(); });
    const items = [...document.querySelectorAll('.chat-ctx-menu [role=menuitem]')].map(b => b.textContent);
    expect(items).toEqual(['Archive', 'Open in full UI']);
    expect(more.getAttribute('aria-expanded')).toBe('true');
  });

  it('is main\'s header with simple-ui-side-panel-enabled off', async () => {
    mocks.history.mockResolvedValue(historyOn('sonnet'));
    mocks.sidePanel = false;
    try {
      await render(true);
      expect(document.querySelector('.chat-more-btn')).toBeNull();
      expect(document.querySelector('.chat-header')!.classList.contains('chat-header-agent')).toBe(false);
      expect(document.querySelector('.chat-header .chat-glyph')).not.toBeNull();
      expect([...document.querySelectorAll('.chat-header button')].some(b => b.textContent === 'Archive')).toBe(true);
    } finally {
      mocks.sidePanel = true;
    }
  });

  it('keeps the desktop header off a phone', async () => {
    mocks.history.mockResolvedValue(historyOn('sonnet'));
    await render();
    expect(document.querySelector('.chat-more-btn')).toBeNull();
    expect([...document.querySelectorAll('.chat-header button')].some(b => b.textContent === 'Archive')).toBe(true);
  });
});
