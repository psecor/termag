// @vitest-environment jsdom
// A message sent from a space file's composer ends with "(viewing space:path)":
// the conversation draws that line quieter, from the history and live alike.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import { chatEvents } from '../../chat/chatEvents';

const mocks = vi.hoisted(() => ({ history: vi.fn(), noBoxes: [] as unknown[] }));
vi.mock('../../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  chatApi: { history: mocks.history, send: vi.fn(), reclaim: vi.fn(), interrupt: vi.fn(), openInTerminal: vi.fn(), trust: vi.fn() },
  activityApi: { heartbeat: () => Promise.resolve() },
  visitsApi: { record: () => Promise.resolve() },
}));
vi.mock('../../contexts/ProjectContext', async importOriginal => ({
  ...(await importOriginal<typeof import('../../contexts/ProjectContext')>()),
  useProjects: () => ({ settleProjectClone: vi.fn(), reloadProjects: vi.fn() }),
}));
vi.mock('../../services/boxFeed', () => ({
  boxFeed: { subscribe: () => () => {}, getSnapshot: () => mocks.noBoxes, hasLoaded: () => true, isGone: () => false, lookFor: () => {} },
}));
vi.mock('../../chat/ClaudeLoginCard', () => ({ ClaudeLoginCard: () => null }));

import { SdkChatView } from './SdkChatView';

const project = { id: 'p1', name: 'termag-5', instanceId: null, repoUrl: null, setupStatus: 'ready', setupError: null, role: 'owner', workflows: [], workstreams: [] } as unknown as Project;
const MESSAGE = 'mark 755 ready\n\n(viewing improve-termag:pr-outbox.md)';

let root: Root;
let host: HTMLDivElement;
afterEach(() => { act(() => root.unmount()); host.remove(); mocks.history.mockReset(); });

async function render(entries: unknown[]) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.history.mockResolvedValue({ chatKey: 'k', workstream: 'main', sessionId: 's', running: false, queued: 0, checkoutReady: true, entries, turns: [], model: 'opus' });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(<MemoryRouter><SdkChatView project={project} workstream="main" /></MemoryRouter>); });
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}

const bubbles = () => [...host.querySelectorAll('.sdk-user-bubble')];

describe('the viewing line in the conversation', () => {
  it('is quieter in a message from the history', async () => {
    await render([{ type: 'user', message: { role: 'user', content: MESSAGE } }]);
    const b = bubbles()[0];
    expect(b.querySelector('.sdk-user-context')?.textContent).toBe('(viewing improve-termag:pr-outbox.md)');
    expect(b.firstChild?.textContent).toBe('mark 755 ready');
  });

  it('is quieter in a message that arrives live', async () => {
    await render([]);
    act(() => chatEvents.publish({ type: 'chat', projectId: 'p1', workstream: 'main', turnId: null, event: { type: 'turn-start', text: MESSAGE } }));
    expect(bubbles()[0]?.querySelector('.sdk-user-context')?.textContent).toBe('(viewing improve-termag:pr-outbox.md)');
  });

  it('leaves an ordinary message as it was', async () => {
    await render([{ type: 'user', message: { role: 'user', content: 'hello' } }]);
    expect(bubbles()[0].textContent).toBe('hello');
    expect(host.querySelector('.sdk-user-context')).toBeNull();
  });
});
