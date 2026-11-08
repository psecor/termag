// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  send: vi.fn(),
  interrupt: vi.fn(),
  noBoxes: [] as unknown[],
}));

vi.mock('../../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  chatApi: { history: mocks.history, send: mocks.send, reclaim: vi.fn(), interrupt: mocks.interrupt, openInTerminal: vi.fn(), trust: vi.fn() },
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

// React Aria's popover reads a CSP nonce through CSS.escape, which jsdom lacks.
const css = globalThis as { CSS?: { escape?: (s: string) => string } };
css.CSS ??= {};
css.CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);

import { SdkChatView } from './SdkChatView';
import { ChatChromeProvider } from './chatChrome';

const project = {
  id: 'p1', name: 'web', instanceId: null, repoUrl: null, setupStatus: 'ready', setupError: null, role: 'owner', workflows: [], workstreams: [],
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

async function render(refresh = false) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const view = <MemoryRouter><SdkChatView project={project} workstream="main" /></MemoryRouter>;
  await act(async () => {
    root.render(refresh
      ? <ChatChromeProvider value={{ mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, refresh: true }}>{view}</ChatChromeProvider>
      : view);
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
// Stop and Send sit in their own slot at the end (.chat-compose-end), so the ring before them never moves.
const actions = () => [...document.querySelectorAll('form.chat-composer .chat-compose-actions > button, form.chat-composer .chat-compose-actions > .chat-compose-end > button')].map(b => b.getAttribute('aria-label'));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  sessionStorage.clear();
  mocks.history.mockReset();
  mocks.send.mockReset();
  mocks.send.mockResolvedValue({ queued: false, turnId: 't1' });
  mocks.interrupt.mockReset();
  mocks.interrupt.mockResolvedValue({});
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
    expect(actions()).toEqual(['Attach files']);
    await type('look at this');
    expect(actions()).toEqual(['Attach files', 'Send']);
  });

  it('shows the messages queued behind the turn again after switching away and back', async () => {
    mocks.history.mockResolvedValue({ ...historyOn('sonnet'), running: true, queued: 2, waiting: [{ text: 'and the tests?' }, { text: 'then push' }] });
    await render();
    const queued = () => [...document.querySelectorAll('.sdk-user-bubble')].map(b => b.textContent);
    expect(queued()).toEqual(['and the tests?', 'then push']);
    expect([...document.querySelectorAll('.sdk-user-note')].map(n => n.textContent)).toEqual(['queued', 'queued']);
    unmount();
    await render();
    expect(queued()).toEqual(['and the tests?', 'then push']);
  });

  it('shows Stop while Claude works, and Send after it once there is a message', async () => {
    mocks.history.mockResolvedValue({ ...historyOn('sonnet'), running: true });
    await render();
    expect(actions()).toEqual(['Stop']);
    await type('and then this');
    expect(actions()).toEqual(['Stop', 'Send']);
  });

  it('keeps Stop and Send in one slot as wide as a button, after the ring', async () => {
    mocks.history.mockResolvedValue({ ...historyOn('sonnet') });
    await render();
    const end = document.querySelector('form.chat-composer .chat-compose-actions > .chat-compose-end');
    expect(end).not.toBeNull();
    expect(end?.children.length).toBe(0);
    expect(end?.previousElementSibling?.classList.contains('chat-ring') || [...(end?.parentElement?.children ?? [])].some(c => c.classList.contains('chat-ring'))).toBe(true);
  });
});

// A live turn (the box takes a turn-only stop) with these background tasks running.
function runningWith(tasks: Array<{ description: string; subagent?: boolean }>) {
  return {
    ...historyOn('sonnet'), running: true, liveInput: true, stopsTurn: true,
    turn: {
      turnId: 't1',
      events: [
        { seq: 1, event: { type: 'turn-start', text: 'go', live: true } },
        { seq: 2, event: { type: 'system', subtype: 'background_tasks_changed', tasks: tasks.map((t, i) => ({ task_id: `b${i}`, task_type: t.subagent ? 'local_agent' : 'local_bash', description: t.description })) } },
      ],
    },
  };
}

describe('SdkChatView composer, with the chrome refresh', () => {
  const stopButton = () => document.querySelector('form.chat-composer button[aria-label="Stop"]') as HTMLButtonElement | null;
  // A bare click is React Aria's virtual press (jsdom has no PointerEvent).
  const press = async (el: Element) => {
    await act(async () => { (el as HTMLElement).click(); });
    await flush();
  };

  it('holds no room for Stop or Send while neither shows', async () => {
    mocks.history.mockResolvedValue(historyOn('sonnet'));
    await render(true);
    expect(document.querySelector('form.chat-composer .chat-compose-end')?.children.length).toBe(0);
  });

  it('keeps one round Stop, with no split, that stops at once when nothing runs in the background', async () => {
    mocks.history.mockResolvedValue(runningWith([]));
    await render(true);
    expect(document.querySelector('.chat-stop-split, .chat-stop-caret, .chat-stop-wide')).toBeNull();
    await press(stopButton()!);
    expect(mocks.interrupt).toHaveBeenCalledWith('p1', 'main', 'turn');
    expect(document.querySelector('[role="menu"], [role="alertdialog"], [role="dialog"]')).toBeNull();
  });

  it('asks which stop when background commands run, and does the one picked', async () => {
    mocks.history.mockResolvedValue(runningWith([{ description: 'Run the test suite' }, { description: 'Review the diff', subagent: true }]));
    await render(true);
    await press(stopButton()!);
    expect(mocks.interrupt).not.toHaveBeenCalled();
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.map(i => i.querySelector('[slot="label"]')?.textContent)).toEqual(['Stop Claude', 'Stop Claude and background tasks']);
    expect(items[0].querySelector('[slot="description"]')?.textContent).toBe('Its background task keeps running; the background subagent ends');
    await press(items[1]);
    expect(mocks.interrupt).toHaveBeenCalledWith('p1', 'main', 'all');
  });

  it('opens the same menu on Escape, rather than stopping', async () => {
    mocks.history.mockResolvedValue(runningWith([{ description: 'Run the test suite' }]));
    await render(true);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await flush();
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    expect(mocks.interrupt).not.toHaveBeenCalled();
  });

  it('puts its notes above the composer, and keeps no line under it', async () => {
    mocks.history.mockResolvedValue(historyOn('sonnet'));
    await render(true);
    const above = document.querySelector('.chat-bottom > .chat-composer-notes[data-above]');
    expect(above).not.toBeNull();
    expect(above!.compareDocumentPosition(document.querySelector('form.chat-composer')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelectorAll('.chat-composer-notes')).toHaveLength(1);
  });

  it('is unchanged without it: the notes under the composer', async () => {
    mocks.history.mockResolvedValue(historyOn('sonnet'));
    await render();
    expect(document.querySelector('.chat-composer-notes[data-above]')).toBeNull();
    expect(document.querySelector('form.chat-composer + .chat-composer-notes')).not.toBeNull();
  });
});
