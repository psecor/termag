// @vitest-environment jsdom
// Haiku's tool-group headings in the open chat (chat/toolGroupHeadings.ts):
// pushed as frames while it is open, and back from the history on a reload.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  listeners: [] as Array<(frame: unknown) => void>,
  noBoxes: [] as unknown[],
}));

vi.mock('../../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  chatApi: { history: mocks.history, send: vi.fn(), reclaim: vi.fn(), interrupt: vi.fn(), openInTerminal: vi.fn(), trust: vi.fn() },
  activityApi: { heartbeat: () => Promise.resolve() },
  visitsApi: { record: () => Promise.resolve() },
}));
vi.mock('../../flags', async importOriginal => {
  const real = await importOriginal<typeof import('../../flags')>();
  return { ...real, useFlag: (_key: string, fallback: boolean) => fallback };
});
vi.mock('../../contexts/ProjectContext', async importOriginal => ({
  ...(await importOriginal<typeof import('../../contexts/ProjectContext')>()),
  useProjects: () => ({ settleProjectClone: vi.fn(), reloadProjects: vi.fn() }),
}));
vi.mock('../../services/boxFeed', () => ({
  boxFeed: { subscribe: () => () => {}, getSnapshot: () => mocks.noBoxes, hasLoaded: () => true, isGone: () => false, lookFor: () => {} },
}));
vi.mock('../../chat/chatEvents', () => ({
  chatEvents: {
    subscribe: (l: (frame: unknown) => void) => { mocks.listeners.push(l); return () => { mocks.listeners = mocks.listeners.filter(x => x !== l); }; },
    subscribeReconnect: () => () => {},
  },
}));
vi.mock('../../chat/ClaudeLoginCard', () => ({ ClaudeLoginCard: () => null }));

import { SdkChatView } from './SdkChatView';

const project = {
  id: 'p1', name: 'web', instanceId: null, repoUrl: null, setupStatus: 'ready', setupError: null, role: 'owner', workflows: [], workstreams: [],
} as unknown as Project;

const call = (id: string, command: string, description: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command, description } });
const done = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false });
// A finished turn: a message, a lead-in, two calls, an answer.
const entries = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'does the login test pass?' } },
  { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Let me run the login test.' }] } },
  { type: 'assistant', uuid: 'a2', message: { id: 'm1', role: 'assistant', content: [call('t1', 'npm test -- login', 'Run the login test'), call('t2', 'git log -3', 'Show recent commits')] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: [done('t1'), done('t2')] } },
  { type: 'assistant', uuid: 'a3', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'It passes.' }] } },
];
const history = (extra = {}) => ({
  chatKey: 'p1--main', workstream: 'main', sessionId: 's1', running: false, queued: 0, liveInput: false, parked: false, turn: null,
  checkoutReady: true, sendsLive: false, imageInput: false, stopsTurn: false, entries, turns: [], model: 'sonnet',
  trust: { trusted: true, reason: 'trusted', mode: 'bypassPermissions' }, canTrust: true, ...extra,
});

let root: Root;
let container: HTMLDivElement;

async function flush() {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}
async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<MemoryRouter><SdkChatView project={project} workstream="main" /></MemoryRouter>); });
  await flush();
}
function unmount() {
  if (container?.isConnected) {
    act(() => root.unmount());
    container.remove();
  }
}
const runTitle = () => container.querySelector('.sdk-run-title');
const runSource = () => container.querySelector('.sdk-run')?.getAttribute('data-source');

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  sessionStorage.clear();
  mocks.history.mockReset();
  mocks.listeners = [];
});
afterEach(unmount);

describe('SdkChatView: tool-group headings', () => {
  // A running turn replayed from the box's log: its turn-start says whether the box asks for headings.
  const runningTurn = (headings: boolean) => history({
    running: true, entries: [],
    turn: {
      turnId: 'turn-1',
      events: [
        { seq: 1, event: { type: 'turn-start', text: 'does the login test pass?', ...(headings && { headings: true }) } },
        ...entries.slice(1, 4).map((event, i) => ({ seq: i + 2, event })),
      ],
    },
  });

  it('a running turn whose box is not asking (an ask, an older box) never shows the placeholder', async () => {
    mocks.history.mockResolvedValue(runningTurn(false));
    await render();
    expect(runSource()).toBe('lead-in');
    expect(container.querySelector('.sdk-run-placeholder')).toBeNull();
  });

  it('holds a placeholder in a running turn, shows the pushed heading once, and a reload shows the same at once', async () => {
    mocks.history.mockResolvedValue(runningTurn(true));
    await render();
    expect(runSource()).toBe('pending');
    const push = async (event: unknown) => {
      await act(async () => { for (const l of mocks.listeners) l({ projectId: 'p1', workstream: 'main', turnId: 'turn-1', seq: null, event }); });
    };
    await push({ type: 'tool-group-heading', runKey: 'run:tool:t1', heading: 'Check the login test passes' });
    expect(runTitle()?.textContent).toBe('Check the login test passes');
    expect(runSource()).toBe('model');
    expect(runTitle()?.hasAttribute('data-swapped')).toBe(true);
    await push({ type: 'tool-group-heading', runKey: 'run:tool:t1', heading: 'A second answer' });
    expect(runTitle()?.textContent).toBe('Check the login test passes');

    // Reload: the box's history carries the heading it kept.
    unmount();
    mocks.history.mockResolvedValue(history({ headings: { 'run:tool:t1': { heading: 'Check the login test passes' } } }));
    await render();
    expect(runTitle()?.textContent).toBe('Check the login test passes');
    expect(runTitle()?.hasAttribute('data-swapped')).toBe(false);
  });

  it('a finished run with no kept answer takes its lead-in once, and a late frame does not change it', async () => {
    mocks.history.mockResolvedValue(history());
    await render();
    expect(runTitle()?.textContent).toBe('Run the login test');
    expect(runSource()).toBe('lead-in');
    await act(async () => {
      for (const l of mocks.listeners) l({ projectId: 'p1', workstream: 'main', turnId: 'turn-1', seq: null, event: { type: 'tool-group-heading', runKey: 'run:tool:t1', heading: 'Too late' } });
    });
    expect(runTitle()?.textContent).toBe('Run the login test');
  });

  it('a frame for another chat leaves the lead-in', async () => {
    mocks.history.mockResolvedValue(history());
    await render();
    await act(async () => {
      for (const l of mocks.listeners) l({ projectId: 'p2', workstream: 'main', turnId: 'x', seq: null, event: { type: 'tool-group-heading', runKey: 'run:tool:t1', heading: 'Not this chat' } });
    });
    expect(runSource()).toBe('lead-in');
  });
});
