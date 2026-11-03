// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatItem } from '../../chat/sdkChat';
import type { AskView } from '../../chat/asks';

const api = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock('../../services/api', () => ({ chatApi: { history: api.history } }));

import { AskTab, askTurns } from './AskTab';
import { askStore, askTabId } from '../../chat/askStore';
import { subagentStore } from '../../chat/subagentStore';

const T1 = 'cmvtr5x6r0i0lafsfuclk9ed5';
const chat = 'p2|main';
const project = { id: 'p2', name: 'titanic-research', workflows: [] } as never;

const view = (over: Partial<AskView> = {}): AskView => ({
  thread: T1, title: 'Titanic wreck: discovery', target: 'box-1/sample', chat: { projectId: 'p1', workstream: `ask-${T1}` },
  state: 'working', turns: 1, error: null, startedAt: new Date(Date.now() - 30_000).toISOString(), completedAt: null,
  waiting: 'nobody', noWait: true, reply: 'pending', prs: [], known: true, ...over,
});

const user = (text: string, key: string): ChatItem => ({ kind: 'user', key, text });
const text = (t: string, key: string): ChatItem => ({ kind: 'text', key, text: t, streaming: false });

describe('askTurns', () => {
  const items = [user('Research the discovery.', 'u1'), text('Searching first.', 't1'), text('Found 1 Sep 1985.', 't2'), user('Add who found it.', 'u2'), text('Ballard and Michel.', 't3')];
  it('splits the ask\'s chat into turns at each message that started one, and takes a finished ask\'s last words as its answer', () => {
    const { turns, answer } = askTurns(items, true);
    expect(turns.map(t => [t.brief, t.items.map(i => i.key)])).toEqual([['Research the discovery.', ['t1', 't2']], ['Add who found it.', []]]);
    expect(answer).toBe('Ballard and Michel.');
  });
  it('has no answer while the ask is going', () => {
    expect(askTurns(items, false).answer).toBeNull();
  });
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  root = createRoot(host);
  vi.clearAllMocks();
  api.history.mockResolvedValue({ entries: [], sessionId: null });
});
afterEach(() => { act(() => root.unmount()); askStore.publish(chat, null); });

const render = async (v: AskView) => {
  askStore.publish(chat, new Map([[v.thread, v]]));
  await act(async () => {
    root.render(<MemoryRouter><AskTab project={project} workstream="main" agent={{ chat, id: askTabId(v.thread), title: v.title }} /></MemoryRouter>);
  });
};

describe('the ask tab', () => {
  it('says plainly that Claude isn\'t waiting for a --no-wait ask, and reads the ask\'s own session', async () => {
    await render(view());
    expect(host.querySelector('.agent-panel-title')?.textContent).toBe('Titanic wreck: discovery');
    expect(host.querySelector('.ask-waiting-note')?.textContent).toContain('Claude isn’t waiting for a reply.');
    expect(host.querySelector('.ask-waiting-note')?.textContent).toContain('--no-wait');
    expect(api.history).toHaveBeenCalledWith('p1', `ask-${T1}`);
    // The chat's row says its tab is on screen.
    expect(subagentStore.shown(chat)).toBe(askTabId(T1));
  });

  it('shows the brief and, once it is done, the answer and that it wasn\'t sent back', async () => {
    api.history.mockResolvedValue({
      sessionId: 's1',
      entries: [
        { type: 'user', message: { role: 'user', content: 'Research how the wreck was found.' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Found on 1 September 1985 by Ballard and Michel.' }] } },
      ],
    });
    await render(view({ state: 'done', completedAt: new Date().toISOString(), reply: 'dropped' }));
    expect(host.querySelector('.agent-brief-text')?.textContent).toBe('Research how the wreck was found.');
    expect(host.querySelector('.agent-result')?.textContent).toContain('Found on 1 September 1985');
    expect(host.querySelector('.ask-waiting-note')?.textContent).toContain('Not sent back to Claude.');
  });

  it('says Claude is waiting while a call waits for it', async () => {
    await render(view({ waiting: 'claude', noWait: false }));
    expect(host.querySelector('.ask-waiting-note')?.getAttribute('data-tone')).toBe('waiting');
    expect(host.querySelector('.ask-waiting-note')?.textContent).toContain('Claude is waiting.');
  });

  it('waits for the chat\'s views, and says so', async () => {
    await act(async () => {
      root.render(<MemoryRouter><AskTab project={project} workstream="main" agent={{ chat, id: askTabId(T1), title: 'Titanic wreck: discovery' }} /></MemoryRouter>);
    });
    expect(host.textContent).toContain('Its session is loading…');
    expect(api.history).not.toHaveBeenCalled();
  });
});

describe('the ask tab before and after its views', () => {
  it('is looking the ask up, not saying it had no session, until the asks route answers', async () => {
    await render(view({ known: false, chat: null, state: 'starting' }));
    expect(host.textContent).toContain('Looking up this ask…');
    expect(host.textContent).not.toContain('ran without a session');
    expect(api.history).not.toHaveBeenCalled();
  });

  it('says the ask is gone once the chat publishes none', async () => {
    askStore.publish(chat, new Map());
    await act(async () => {
      root.render(<MemoryRouter><AskTab project={project} workstream="main" agent={{ chat, id: askTabId(T1), title: 'Titanic wreck: discovery' }} /></MemoryRouter>);
    });
    expect(host.textContent).toContain('This ask is no longer in the session.');
  });

  it('leads with a delivered reply even while the call that got it is still returning', async () => {
    await render(view({ state: 'done', completedAt: new Date().toISOString(), reply: 'delivered', waiting: 'claude', noWait: false }));
    expect(host.querySelector('.ask-waiting-note')?.textContent).toBe('Returned to Claude. A command in the chat got its reply.');
  });
});
