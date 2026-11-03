// @vitest-environment jsdom
// A stored chat whose box is down (chat/storedOpen.ts): it opens on the stored
// transcript and leaves the box alone; a send or Start box brings it back.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, InstanceStatus, Project } from '../../types';
import { readQueued } from '../../chat/newChat';
import { readStoredOpen } from '../../chat/storedOpen';

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  send: vi.fn(),
  start: vi.fn(),
  reload: vi.fn(async () => {}),
  boxes: [] as unknown[],
  listeners: new Set<() => void>(),
}));

vi.mock('../../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  chatApi: { history: mocks.history, send: mocks.send, reclaim: vi.fn(), interrupt: vi.fn(), openInTerminal: vi.fn(), trust: vi.fn() },
  instancesApi: { start: mocks.start },
  activityApi: { heartbeat: () => Promise.resolve() },
  visitsApi: { record: () => Promise.resolve() },
}));
vi.mock('../../contexts/ProjectContext', async importOriginal => ({
  ...(await importOriginal<typeof import('../../contexts/ProjectContext')>()),
  useProjects: () => ({ settleProjectClone: vi.fn(), reloadProjects: vi.fn(async () => {}) }),
}));
vi.mock('../../services/boxFeed', () => ({
  boxFeed: {
    subscribe: (l: () => void) => { mocks.listeners.add(l); return () => { mocks.listeners.delete(l); }; },
    getSnapshot: () => mocks.boxes,
    hasLoaded: () => true,
    isGone: () => false,
    lookFor: () => {},
    reload: mocks.reload,
  },
}));
vi.mock('../../chat/chatEvents', () => ({
  chatEvents: { subscribe: () => () => {}, subscribeReconnect: () => () => {} },
}));
vi.mock('../../chat/ClaudeLoginCard', () => ({ ClaudeLoginCard: () => null }));

import { SdkChatView } from './SdkChatView';

const project = {
  id: 'p1', name: 'web', instanceId: 'b1', repoUrl: null, setupStatus: 'ready', setupError: null, role: 'owner', workflows: [], workstreams: [],
} as unknown as Project;

const entries = [
  { type: 'user', message: { role: 'user', content: 'what is in the readme?' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'It explains how to run the stack.' }] } },
];
// What routes/chat.ts storedHistoryFor answers when the box can't.
const storedHistory = {
  chatKey: 'p1--main', workstream: 'main', sessionId: 's1', running: false, queued: 0, liveInput: false, parked: false, turn: null,
  checkoutReady: true, sendsLive: false, imageInput: false, stopsTurn: false,
  entries, turns: [], model: 'sonnet', trust: { trusted: true, reason: 'trusted', mode: 'bypassPermissions' }, canTrust: true,
  stored: true,
};
const liveHistory = { ...storedHistory, stored: undefined };

const box = (status: InstanceStatus) => ({ id: 'b1', name: 'cp-tools-10261', kind: 'ec2', ec2InstanceId: 'i-b1', status }) as Instance;
const setBox = (status: InstanceStatus) => act(() => { mocks.boxes = [box(status)]; mocks.listeners.forEach(l => l()); });

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

const statusLine = () => container.querySelector('.chat-status')?.textContent ?? '';
// Sending is the only way this view wakes the box (#900 review): there is no Start box.
const startButton = () => [...container.querySelectorAll('button')].find(b => /start box/i.test(b.textContent ?? '')) ?? null;
const transcript = () => container.textContent ?? '';

async function type(text: string) {
  const input = container.querySelector('textarea') as HTMLTextAreaElement;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  const form = container.querySelector('form.chat-composer') as HTMLFormElement;
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await flush();
}

async function send(text = 'and the tests?') {
  await type(text);
  await submit();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  sessionStorage.clear();
  mocks.history.mockReset();
  mocks.send.mockReset().mockResolvedValue({ queued: false, turnId: 't1' });
  mocks.start.mockReset().mockResolvedValue({ ok: true, status: 'starting' });
  mocks.reload.mockReset().mockResolvedValue(undefined);
  mocks.boxes = [box('stopped')];
});

afterEach(() => {
  if (container?.isConnected) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
});

describe('a stored chat whose box is down', () => {
  it('shows the stored transcript and "Box is stopped · sending a message starts it", with no Start box, and starts nothing', async () => {
    mocks.history.mockResolvedValue(storedHistory);
    await render();
    expect(transcript()).toContain('what is in the readme?');
    expect(transcript()).toContain('It explains how to run the stack.');
    expect(statusLine()).toBe('Box is stopped · sending a message starts it');
    expect(startButton()).toBeNull();
    expect(mocks.start).not.toHaveBeenCalled();
    // The open-start hook's answer (hooks/useStartParkedBoxOnOpen.ts): leave the box alone.
    expect(readStoredOpen('p1|main')).toBe('stored');
  });

  it('a hibernated box reads the same, and is left hibernated', async () => {
    mocks.boxes = [box('hibernated')];
    mocks.history.mockResolvedValue(storedHistory);
    await render();
    expect(statusLine()).toBe('Box is hibernated · sending a message starts it');
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('a send starts the box, waits for it as "sent when it is ready", and goes in once the box answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.history.mockResolvedValue(storedHistory);
    // The route marks the box starting before it answers 202, so the reload after it says so.
    mocks.reload.mockImplementation(async () => { mocks.boxes = [box('starting')]; mocks.listeners.forEach(l => l()); });
    await render();
    await send();
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledWith('b1');
    expect(statusLine()).toBe('Starting the box…');
    // Not sent to a box that is not there: queued in this browser, shown as waiting.
    expect(mocks.send).not.toHaveBeenCalled();
    expect(readQueued(localStorage, 'p1')).toBe('and the tests?');
    expect(transcript()).toContain('sent as soon as Claude is ready');
    // The box comes up and answers the history itself: the queued message goes.
    mocks.history.mockResolvedValue(liveHistory);
    setBox('ready');
    await act(async () => { vi.advanceTimersByTime(2500); });
    await flush();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0].slice(0, 3)).toEqual(['p1', 'main', 'and the tests?']);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(readStoredOpen('p1|main')).toBe('none');
  });

  it('a send while the box is still stopping starts it once it has stopped', async () => {
    mocks.boxes = [box('stopping')];
    mocks.history.mockResolvedValue(storedHistory);
    await render();
    expect(statusLine()).toBe('Box is stopping · sending a message starts it');
    await send();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(statusLine()).toBe('Box is stopping · it starts once it has stopped');
    setBox('stopped');
    await flush();
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('a start the route refuses says so, and the next send tries again', async () => {
    mocks.start.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Box is not stopped' } } });
    mocks.history.mockResolvedValue(storedHistory);
    await render();
    await send();
    expect(transcript()).toContain('Box is not stopped');
    expect(statusLine()).toBe('Box is stopped · sending a message starts it');
    await send('once more');
    expect(mocks.start).toHaveBeenCalledTimes(2);
  });

  it('a start the route took but whose box is still down after it lets the next send start it again', async () => {
    mocks.history.mockResolvedValue(storedHistory);
    await render();
    await send();
    expect(mocks.start).toHaveBeenCalledTimes(1);
    // The reload after the 202 still says stopped: the box did not come up.
    expect(statusLine()).toBe('Box is stopped · sending a message starts it');
    expect(transcript()).toContain('did not come up');
    await send('once more');
    expect(mocks.start).toHaveBeenCalledTimes(2);
  });

  it('a box that came up and went down again before the chat was live says so, and the next send starts it again', async () => {
    mocks.history.mockResolvedValue(storedHistory);
    mocks.reload.mockImplementation(async () => { mocks.boxes = [box('starting')]; mocks.listeners.forEach(l => l()); });
    await render();
    await send();
    expect(statusLine()).toBe('Starting the box…');
    setBox('stopped');
    await flush();
    expect(statusLine()).toBe('Box is stopped · sending a message starts it');
    expect(transcript()).toContain('did not come up');
    await send('once more');
    expect(mocks.start).toHaveBeenCalledTimes(2);
  });

  it('a start that never answers lets go after 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.start.mockImplementation(() => new Promise(() => {}));
    mocks.history.mockResolvedValue(storedHistory);
    await render();
    await send();
    expect(statusLine()).toBe('Starting the box…');
    await act(async () => { vi.advanceTimersByTime(31_000); });
    await flush();
    expect(statusLine()).toBe('Box is stopped · sending a message starts it');
    expect(transcript()).toContain('no answer');
  });

  it('a send the backend holds itself (chat-resume, continuation.takesSends) goes straight to it, with no start from here', async () => {
    mocks.history.mockResolvedValue({ ...storedHistory, continuation: { takesSends: true } });
    mocks.send.mockResolvedValue({ held: true });
    await render();
    await send();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('nothing stored (the box is offline and the store has no copy): the open-start hook is told to start it', async () => {
    mocks.history.mockRejectedValue({ response: { status: 503, data: { code: 'offline', error: 'The box is offline' } } });
    await render();
    expect(readStoredOpen('p1|main')).toBe('none');
    expect(statusLine()).not.toContain('sending a message starts it');
  });

  it('a box that is up says nothing about starting it', async () => {
    mocks.boxes = [box('ready')];
    mocks.history.mockResolvedValue(liveHistory);
    await render();
    expect(statusLine()).not.toContain('Box is');
  });
});

describe('a start the route refuses with a real axios error', () => {
  it('shows the route\'s words, not axios\'s', async () => {
    const err = Object.assign(new Error('Request failed with status code 409'), { response: { status: 409, data: { error: 'Box is not stopped' } } });
    mocks.start.mockRejectedValue(err);
    mocks.history.mockResolvedValue(storedHistory);
    await render();
    await send();
    expect(transcript()).toContain('Box is not stopped');
    expect(transcript()).not.toContain('status code 409');
  });
});
