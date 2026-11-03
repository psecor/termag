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
import { forgetChrome } from '../../chat/composerChrome';

const project = {
  id: 'p1', name: 'web', instanceId: null, repoUrl: null, setupStatus: 'ready', setupError: null, role: 'owner', workflows: [], workstreams: [],
} as unknown as Project;

// An untrusted chat on a box that takes images: the trust note and the attach button come from this answer.
const untrusted = {
  chatKey: 'p1--main', workstream: 'main', sessionId: 's1', running: false, queued: 0, checkoutReady: true,
  entries: [], turns: [], model: 'opus', imageInput: true,
  trust: { trusted: false, reason: null, mode: 'default' }, canTrust: true,
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

function unmount() {
  act(() => root.unmount());
  container.remove();
}

const trustNote = () => document.querySelector('.chat-bottom .chat-trust') as HTMLElement | null;
const attach = () => document.querySelector('form.chat-composer .chat-attach') as HTMLButtonElement | null;
const modelLabel = () => document.querySelector('form.chat-composer .chat-compose-model-btn')?.textContent ?? '';
// A history answer that has not come back yet, as on a switch to a large chat.
const pending = () => new Promise<never>(() => {});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  sessionStorage.clear();
  forgetChrome();
  mocks.history.mockReset();
});

afterEach(() => { if (container?.isConnected) unmount(); });

describe('SdkChatView composer chrome while the history loads', () => {
  it('reserves the trust note and attach button on a first open, and fills them in place', async () => {
    mocks.history.mockImplementation(pending);
    await render();
    expect(trustNote()?.dataset.reserved).toBe('true');
    expect(trustNote()?.getAttribute('aria-hidden')).toBe('true');
    expect(attach()?.dataset.reserved).toBe('true');
    unmount();

    mocks.history.mockResolvedValue(untrusted);
    await render();
    expect(trustNote()?.dataset.reserved).toBeUndefined();
    expect(trustNote()?.getAttribute('role')).toBe('note');
    expect(attach()?.dataset.reserved).toBeUndefined();
    expect(attach()?.disabled).toBe(false);
  });

  it('draws what it kept on a switch back before the history answers, then lets the answer correct it', async () => {
    mocks.history.mockResolvedValue(untrusted);
    await render();
    const before = modelLabel();
    expect(before).not.toBe('…');
    unmount();

    let answer: (h: unknown) => void = () => {};
    mocks.history.mockImplementation(() => new Promise(r => { answer = r; }));
    await render();
    expect(trustNote()?.dataset.reserved).toBeUndefined();
    expect(trustNote()?.textContent).toContain("can't run commands");
    expect(attach()?.dataset.reserved).toBeUndefined();
    expect(attach()?.disabled).toBe(true);
    expect(modelLabel()).toBe(before);

    // Trusted meanwhile, and the box no longer takes images: the answer wins.
    await act(async () => { answer({ ...untrusted, imageInput: false, trust: { trusted: true, reason: 'trusted', mode: 'bypassPermissions' } }); });
    await flush();
    expect(trustNote()).toBeNull();
    expect(attach()).toBeNull();
  });

  it('keeps Trust disabled on a switch back until the history answers, so a stale answer cannot undo a trust', async () => {
    mocks.history.mockResolvedValue(untrusted);
    await render();
    const trustButton = () => trustNote()?.querySelector('button') as HTMLButtonElement | null;
    expect(trustButton()?.disabled).toBe(false);
    unmount();

    let answer: (h: unknown) => void = () => {};
    mocks.history.mockImplementation(() => new Promise(r => { answer = r; }));
    await render();
    expect(trustNote()?.textContent).toContain("can't run commands");
    expect(trustButton()?.disabled).toBe(true);
    await act(async () => { answer(untrusted); });
    await flush();
    expect(trustButton()?.disabled).toBe(false);
  });

  it('reserves nothing once the history answered a trusted chat without image input', async () => {
    mocks.history.mockResolvedValue({ ...untrusted, imageInput: false, trust: { trusted: true, reason: 'trusted', mode: 'bypassPermissions' } });
    await render();
    expect(trustNote()).toBeNull();
    expect(attach()).toBeNull();
  });
});
