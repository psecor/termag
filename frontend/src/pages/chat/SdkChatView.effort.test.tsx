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
}));

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

const STOPS = ['Low', 'Medium', 'High', 'Extra high', 'Max'];
const effortRange = () => document.querySelector('.chat-effort input[type="range"]') as HTMLInputElement;

/** Opens the menu if needed and moves the effort slider to a stop, or presses Default. */
async function pickEffort(label: string) {
  if (!effortRange()) await act(async () => { modelButton().click(); });
  if (label === 'Default') {
    await act(async () => { (document.querySelector('.chat-effort-default') as HTMLButtonElement).click(); });
    return;
  }
  const input = effortRange();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(STOPS.indexOf(label)));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function closeMenu() {
  if (effortRange()) await act(async () => { modelButton().click(); });
}

describe('SdkChatView effort', () => {
  it('writes a picked model and effort for New session to open on', async () => {
    mocks.history.mockResolvedValue({ ...historyOn('opus'), effortInput: true });
    await render();
    await pickEffort('Extra high');
    await closeMenu();
    await pickModel('Sonnet 5.5');
    expect(JSON.parse(localStorage.getItem('termag-chat-last-pick') ?? '{}')).toEqual({ model: 'sonnet', effort: 'xhigh' });
  });

  it('offers an Effort section where the history says effortInput, and sends the choice with every message', async () => {
    mocks.history.mockResolvedValue({ ...historyOn('opus'), effortInput: true });
    await render();
    await act(async () => { modelButton().click(); });
    expect(effortRange()).not.toBeNull();
    expect(document.querySelector('.chat-effort-default')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.chat-effort')?.hasAttribute('data-default')).toBe(true);

    await pickEffort('Medium');
    expect(modelButton().textContent).toBe('Opus 5.5 · Medium');
    // The slider moves the effort in place: the menu stays open, and says which level and why.
    expect(effortRange()).not.toBeNull();
    expect(effortRange().getAttribute('aria-valuetext')).toBe('Medium');
    expect(document.querySelector('.chat-effort-readout')?.textContent).toBe('MediumQuick, with some thought');
    await pickEffort('High');
    expect(modelButton().textContent).toBe('Opus 5.5 · High');
    await closeMenu();
    await typeAndSend('think about it');
    expect(mocks.send).toHaveBeenLastCalledWith('p1', 'main', 'think about it', [], null, 'high');
    await typeAndSend('and this');
    expect(mocks.send).toHaveBeenLastCalledWith('p1', 'main', 'and this', [], null, 'high');
    expect(localStorage.getItem('termag.chatEffort.p1|main')).toBe('high');
  });

  it('says a change waits for the next message once one has gone at another effort', async () => {
    mocks.history.mockResolvedValue({ ...historyOn('opus'), effortInput: true });
    await render();
    await typeAndSend('first');
    expect(document.querySelector('.chat-composer-bar')?.textContent).not.toContain('From your next message');
    await pickEffort('Max');
    await closeMenu();
    expect(document.querySelector('.chat-composer-bar')?.textContent).toContain('From your next message');
    await typeAndSend('second');
    expect(mocks.send).toHaveBeenLastCalledWith('p1', 'main', 'second', [], null, 'max');
    expect(document.querySelector('.chat-composer-bar')?.textContent).not.toContain('From your next message');
  });

  it('counts the queued first message (New session\'s) as sent at its effort', async () => {
    localStorage.setItem('termag-chat-queued:p1', 'first from New session');
    localStorage.setItem('termag.chatEffort.p1|main', 'high');
    mocks.history.mockResolvedValue({ ...historyOn('opus'), effortInput: true });
    await render();
    await flush();
    expect(mocks.send).toHaveBeenLastCalledWith('p1', 'main', 'first from New session', [], null, 'high', expect.stringMatching(/^[A-Za-z0-9-]{8,64}$/));
    expect(document.querySelector('.chat-composer-bar')?.textContent).not.toContain('From your next message');
    await pickEffort('Max');
    await closeMenu();
    expect(document.querySelector('.chat-composer-bar')?.textContent).toContain('From your next message');
  });

  it('from Default, Enter on the resting thumb picks that stop', async () => {
    mocks.history.mockResolvedValue({ ...historyOn('opus'), effortInput: true });
    await render();
    await act(async () => { modelButton().click(); });
    expect(effortRange().getAttribute('aria-valuetext')).toBe('Default');
    await act(async () => { effortRange().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(modelButton().textContent).toBe('Opus 5.5 · High');
    expect(document.querySelector('.chat-effort')?.hasAttribute('data-default')).toBe(false);
  });

  it('back on Default sends no effort', async () => {
    localStorage.setItem('termag.chatEffort.p1|main', 'low');
    mocks.history.mockResolvedValue({ ...historyOn('opus'), effortInput: true });
    await render();
    expect(modelButton().textContent).toBe('Opus 5.5 · Low');
    await pickEffort('Default');
    await closeMenu();
    expect(modelButton().textContent).toBe('Opus 5.5');
    await typeAndSend('plain');
    expect(mocks.send).toHaveBeenLastCalledWith('p1', 'main', 'plain', [], null);
  });

  it('offers none, and sends none, where the history does not say effortInput', async () => {
    localStorage.setItem('termag.chatEffort.p1|main', 'max');
    mocks.history.mockResolvedValue(historyOn('opus'));
    await render();
    expect(modelButton().textContent).toBe('Opus 5.5');
    await act(async () => { modelButton().click(); });
    expect(document.querySelector('[role="listbox"][aria-label="Model"]')).not.toBeNull();
    expect(effortRange()).toBeNull();
    await act(async () => { modelButton().click(); });
    await typeAndSend('no effort here');
    expect(mocks.send).toHaveBeenLastCalledWith('p1', 'main', 'no effort here', [], null);
  });
});
