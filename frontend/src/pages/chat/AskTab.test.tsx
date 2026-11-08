// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatItem } from '../../chat/sdkChat';
import type { AskView } from '../../chat/asks';

const api = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock('../../services/api', () => ({ chatApi: { history: api.history } }));

import { AskTab, askTurns, waitingNote } from './AskTab';
import { askStore, askTabId } from '../../chat/askStore';
import { subagentStore } from '../../chat/subagentStore';

const T1 = 'cmvtr5x6r0i0lafsfuclk9ed5';
const chat = 'p2|main';
const projectOf = (provider: string) => ({
  id: 'p2', name: 'titanic-research', workstreams: [{ id: 'w1', name: 'main' }],
  workflows: [{ id: 'f1', type: 'agent', workstreamId: 'w1', provider }],
}) as never;
const project = projectOf('claude-chat');

const view = (over: Partial<AskView> = {}): AskView => ({
  thread: T1, title: 'Titanic wreck: discovery', target: 'box-1/sample', chat: { projectId: 'p1', workstream: `ask-${T1}` },
  state: 'working', turns: 1, error: null, startedAt: new Date(Date.now() - 30_000).toISOString(), completedAt: null,
  waiting: 'nobody', noWait: true, reply: 'pending', notice: 'none', prs: [], known: true, ...over,
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

const render = async (v: AskView, p = project) => {
  askStore.publish(chat, new Map([[v.thread, v]]));
  await act(async () => {
    root.render(<MemoryRouter><AskTab project={p} workstream="main" agent={{ chat, id: askTabId(v.thread), title: v.title }} /></MemoryRouter>);
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

  it('shows the note\'s command as code', async () => {
    await render(view({ state: 'done', completedAt: new Date().toISOString(), reply: 'stored' }));
    expect(host.querySelector('.ask-waiting-note code')?.textContent).toBe('termag ask --reply');
  });

  it('names the chat\'s own agent: who asked, whose brief, and who is waiting', async () => {
    api.history.mockResolvedValue({ sessionId: 's1', entries: [{ type: 'user', message: { role: 'user', content: 'Research how the wreck was found.' } }] });
    await render(view({ notice: 'due' }), projectOf('codex'));
    expect(host.textContent).toContain('Asked by Codex');
    expect(host.querySelector('.agent-brief-head')?.textContent).toContain('Codex’s brief');
    expect(host.querySelector('.ask-waiting-note')?.textContent).toBe('Codex is told when it finishes. Codex sent it with --no-wait and carried on. '
      + 'When the ask finishes, termag tells the chat, and Codex reads its reply then.');
    expect(host.textContent).not.toContain('Claude');
  });

  it('says the agent where the chat\'s provider is unknown', async () => {
    await render(view(), { id: 'p2', name: 'titanic-research', workstreams: [], workflows: [] } as never);
    expect(host.textContent).toContain('Asked by the agent');
    expect(host.querySelector('.ask-waiting-note strong')?.textContent).toBe('The agent isn’t waiting for a reply.');
  });

  it('says Claude is waiting while a call waits for it', async () => {
    await render(view({ waiting: 'agent', noWait: false }));
    expect(host.querySelector('.ask-waiting-note')?.getAttribute('data-tone')).toBe('waiting');
    expect(host.querySelector('.ask-waiting-note')?.textContent).toContain('Claude is waiting.');
  });

  it('has no Show in chat for a pane chat\'s ask, which has no row there', async () => {
    await render(view({ noRow: true }));
    expect(host.querySelector('.agent-panel-jump')).toBeNull();
    await render(view());
    expect(host.querySelector('.agent-panel-jump')?.textContent).toContain('Show in chat');
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
    await render(view({ state: 'done', completedAt: new Date().toISOString(), reply: 'delivered', waiting: 'agent', noWait: false }));
    expect(host.querySelector('.ask-waiting-note')?.textContent).toBe('Returned to Claude. A command in the chat got its reply.');
  });
});

describe('waitingNote', () => {
  const ended = (over: Partial<AskView>) => view({ state: 'done', completedAt: '2026-10-29T13:25:48.000Z', ...over });
  const note = (v: AskView, agent = 'Claude') => { const n = waitingNote(v, agent); return n && `${n.lead}. ${n.text}`; };

  it('says a --no-wait ask whose sender gets a finish notice is read when the notice comes', () => {
    expect(note(view({ notice: 'due' }))).toBe('Claude is told when it finishes. Claude sent it with --no-wait and carried on. '
      + 'When the ask finishes, termag tells the chat, and Claude reads its reply then.');
    expect(note(ended({ notice: 'due', reply: 'stored' }))).toBe('Telling Claude it finished. The ask has finished, and termag tells the chat in a moment. Claude reads its reply then.');
  });

  it('says the notice was sent, and whether Claude has read the reply since', () => {
    expect(note(ended({ notice: 'sent', reply: 'stored' }))).toBe('Claude was told it finished. termag told the chat the ask finished. '
      + 'Claude hasn’t read its reply yet, and `termag ask --reply` reads it for 14 days. Its answer is below.');
    expect(note(ended({ notice: 'sent', reply: 'delivered' }))).toBe('Returned to Claude. A command in the chat got its reply.');
    expect(note(ended({ state: 'failed', error: 'box_offline', notice: 'sent', reply: 'none' }))).toBe('Claude was told it ended. termag told the chat the ask ended.');
  });

  it('says nobody is waiting only when no notice goes, and that the reply is kept', () => {
    expect(note(view())).toBe('Claude isn’t waiting for a reply. Claude sent it with --no-wait and carried on, and nothing tells the chat when it finishes. '
      + 'Its reply is kept for 14 days: `termag ask --reply` reads it, and its answer shows here.');
    expect(note(ended({ reply: 'stored' }))).toBe('Not sent back to Claude. Claude sent it with --no-wait and carried on, so nothing has read its reply. '
      + 'It is kept for 14 days, and `termag ask --reply` reads it. Its answer is below.');
    expect(note(ended({ reply: 'stored', notice: 'unsent' }))).toBe('Not sent back to Claude. Claude sent it with --no-wait and carried on, and termag’s finish notice couldn’t reach the chat. '
      + 'Its reply is kept for 14 days, and `termag ask --reply` reads it. Its answer is below.');
    expect(note(ended({ reply: 'dropped', noWait: false }))).toBe('Not sent back to Claude. Nothing in the chat is waiting for it any more, so nothing got the reply, and it is no longer kept. Its answer is below.');
    for (const n of [note(view()), note(ended({ reply: 'stored' }))]) expect(n).not.toContain('goes to nobody');
  });

  it('names a Codex chat\'s agent in the lead and the text', () => {
    expect(note(view({ notice: 'due' }), 'Codex')).toBe('Codex is told when it finishes. Codex sent it with --no-wait and carried on. '
      + 'When the ask finishes, termag tells the chat, and Codex reads its reply then.');
    expect(note(ended({ notice: 'sent', reply: 'stored' }), 'Codex')).toBe('Codex was told it finished. termag told the chat the ask finished. '
      + 'Codex hasn’t read its reply yet, and `termag ask --reply` reads it for 14 days. Its answer is below.');
    expect(note(view(), 'Codex')).toBe('Codex isn’t waiting for a reply. Codex sent it with --no-wait and carried on, and nothing tells the chat when it finishes. '
      + 'Its reply is kept for 14 days: `termag ask --reply` reads it, and its answer shows here.');
    expect(note(view({ waiting: 'agent', noWait: false }), 'Codex')).toBe('Codex is waiting. A command in the chat is waiting for its reply, and Codex reads it when the ask finishes.');
    expect(note(ended({ reply: 'delivered' }), 'Codex')).toBe('Returned to Codex. A command in the chat got its reply.');
  });

  it('never says whether a command in a pane chat waits, which it can\'t tell', () => {
    const pane = (over: Partial<AskView>) => ({ noRow: true, noWait: false, ...over });
    expect(note(view(pane({ notice: 'due' })))).toBe('Claude is told when it finishes. When the ask finishes, termag tells the chat, and Claude reads its reply then.');
    expect(note(view(pane({})))).toBeNull();
    expect(note(ended(pane({ reply: 'stored' })))).toBe('Not sent back to Claude. Nothing has read its reply. It is kept for 14 days, and `termag ask --reply` reads it. Its answer is below.');
    expect(note(ended(pane({ reply: 'stored', notice: 'unsent' })))).toBe('Not sent back to Claude. termag’s finish notice couldn’t reach the chat. '
      + 'Its reply is kept for 14 days, and `termag ask --reply` reads it. Its answer is below.');
    expect(note(ended(pane({ reply: 'dropped' })))).toBe('Not sent back to Claude. Nothing got the reply, and it is no longer kept. Its answer is below.');
  });

  it('starts a sentence about an unknown agent with a capital', () => {
    expect(note(view({ notice: 'due' }), 'the agent')).toBe('The agent is told when it finishes. The agent sent it with --no-wait and carried on. '
      + 'When the ask finishes, termag tells the chat, and the agent reads its reply then.');
  });

  it('says Claude is waiting while a call waits for it, whatever the notice', () => {
    expect(note(view({ waiting: 'agent', noWait: false, notice: 'due' }))).toBe('Claude is waiting. A command in the chat is waiting for its reply, and Claude reads it when the ask finishes.');
  });
});
