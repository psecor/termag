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
import { readQueued, writeQueued } from '../../chat/newChat';

const project = {
  id: 'p1', name: 'web', instanceId: null, repoUrl: null, setupStatus: 'ready', setupError: null, role: 'owner', workflows: [], workstreams: [],
} as unknown as Project;

// A chat read from the store: its box was terminated.
const storedChat = {
  chatKey: 'p1--main', workstream: 'main', sessionId: 's1', running: false, queued: 0, checkoutReady: true,
  turns: [], model: 'opus', imageInput: true,
  trust: { trusted: true, reason: 'trusted', mode: 'bypassPermissions' }, canTrust: true, stored: true,
  entries: [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'earlier question' } }],
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

const statusText = () => document.querySelector('.chat-status')?.textContent ?? '';
const composer = () => document.querySelector('textarea.chat-input') as HTMLTextAreaElement | null;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  sessionStorage.clear();
  forgetChrome();
  mocks.history.mockReset();
  mocks.send.mockReset();
});

afterEach(() => { if (container?.isConnected) unmount(); });

describe('SdkChatView: a chat whose box is gone carries on when its owner sends (docs/chat-resume.md)', () => {
  it('reads like any chat, with no Continue button, and the composer works', async () => {
    mocks.history.mockResolvedValue(storedChat);
    await render();
    expect(document.body.textContent).toContain('earlier question');
    expect(document.body.textContent).not.toContain('Continue on a new box');
    expect(composer()?.disabled).toBe(false);
  });

  it('while the new box comes up and restores, the status line says so and the history stays readable', async () => {
    mocks.history.mockResolvedValue({ ...storedChat, continuation: { phase: 'starting-box', held: [{ id: 'm1', text: 'pick up where we left off', error: null }] } });
    await render();
    expect(statusText()).toContain('Starting a new box for this chat…');
    expect(document.body.textContent).toContain('earlier question');
    expect(document.body.textContent).toContain('pick up where we left off');
    expect(composer()?.disabled).toBe(false);
    unmount();
    mocks.history.mockResolvedValue({ ...storedChat, continuation: { phase: 'restoring' } });
    await render();
    expect(statusText()).toContain('Restoring this conversation…');
  });

  it('someone other than the owner reads it, with the composer off and who can continue it', async () => {
    mocks.history.mockResolvedValue({ ...storedChat, continuation: { sendRefusal: { code: 'owner-only', reason: 'Only Pat can continue this chat' } } });
    await render();
    expect(composer()?.disabled).toBe(true);
    expect(composer()?.placeholder).toBe('Only Pat can continue this chat');
  });

  it('a message queued before the history came goes out once it says the chat takes sends, and stays when it does not', async () => {
    writeQueued(localStorage, 'p1', 'pick up where we left off');
    mocks.send.mockResolvedValue({ queued: true, held: true, phase: 'starting-box' });
    mocks.history.mockResolvedValue({ ...storedChat, continuation: { takesSends: true } });
    await render();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]).toEqual(expect.arrayContaining(['p1', 'main']));
    unmount();
    mocks.send.mockReset();
    writeQueued(localStorage, 'p1', 'are you there?');
    mocks.history.mockResolvedValue({ ...storedChat, continuation: { sendRefusal: { code: 'owner-only', reason: 'Only Pat can continue this chat' } } });
    await render();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(readQueued(localStorage, 'p1')).toBe('are you there?');
  });

  it('a switch to another chat drops the last one\'s phase and refusal before its own history comes', async () => {
    mocks.history.mockResolvedValue({ ...storedChat, continuation: { phase: 'starting-box', sendRefusal: { code: 'owner-only', reason: 'Only Pat can continue this chat' } } });
    await render();
    expect(statusText()).toContain('Starting a new box for this chat…');
    expect(composer()?.placeholder).toBe('Only Pat can continue this chat');
    mocks.history.mockReturnValue(new Promise(() => {}));
    // The same view, not remounted: the hook keeps per-chat state itself (ChatRoute's key is not the only guard).
    await act(async () => {
      root.render(<MemoryRouter><SdkChatView project={project} workstream="docs" /></MemoryRouter>);
    });
    await flush();
    expect(statusText()).not.toContain('Starting a new box for this chat…');
    expect(composer()?.placeholder).not.toBe('Only Pat can continue this chat');
  });
});
