// @vitest-environment jsdom
// The context popover's actions in the view (SdkChatView runContextAction).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  send: vi.fn(),
  context: vi.fn(),
  noBoxes: [] as unknown[],
  subs: [] as Array<(frame: unknown) => void>,
}));

vi.mock('../../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  chatApi: { history: mocks.history, send: mocks.send, context: mocks.context, reclaim: vi.fn(), interrupt: vi.fn(), openInTerminal: vi.fn(), trust: vi.fn() },
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
  chatEvents: { subscribe: (fn: (frame: unknown) => void) => { mocks.subs.push(fn); return () => {}; }, subscribeReconnect: () => () => {} },
}));
vi.mock('../../chat/ClaudeLoginCard', () => ({ ClaudeLoginCard: () => null }));

import { SdkChatView } from './SdkChatView';

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


const reply = { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'one' }], usage: { input_tokens: 50_000 } } };
const history = () => ({
  ...historyOn('sonnet'), contextActions: 'ready',
  entries: [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }, reply],
});
const frame = (seq: number, event: unknown) => ({ projectId: 'p1', workstream: 'main', turnId: 't9', seq, event });
const push = async (f: unknown) => { await act(async () => { for (const s of mocks.subs) s(f); }); await flush(); };
const clearBtn = () => document.querySelector('.chat-ring-clear') as HTMLButtonElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  mocks.subs.length = 0;
  mocks.history.mockReset();
  mocks.context.mockReset();
});
afterEach(() => unmount());

describe('SdkChatView: Compact stays busy until its turn starts (Bugbot #738)', () => {
  it('keeps Compact and Clear disabled between the POST returning and the turn-start frame', async () => {
    mocks.history.mockResolvedValue(history());
    await render();
    await act(async () => { (document.querySelector('button.chat-ring-btn') as HTMLButtonElement).click(); });
    expect(clearBtn().disabled).toBe(false);
    mocks.context.mockResolvedValue({ compacting: true, turnId: 't9' });
    await act(async () => { (document.querySelector('.chat-ring-compact') as HTMLButtonElement).click(); });
    await flush();
    expect(mocks.context).toHaveBeenCalledWith('p1', 'main', 'compact');
    // The POST is back, the compact's turn-start is not: a second click must not land.
    expect(clearBtn().disabled).toBe(true);
    expect((document.querySelector('.chat-ring-compact') as HTMLButtonElement).disabled).toBe(true);
    await push(frame(1, { type: 'turn-start', text: '/compact', compact: true }));
    expect(clearBtn().disabled).toBe(true);
    await push(frame(2, { type: 'system', subtype: 'compact_boundary', uuid: 'b1', compact_metadata: { pre_tokens: 50_000 } }));
    await push(frame(3, { type: 'result', subtype: 'success', result: '', local_command: 'compact', total_cost_usd: 0.4 }));
    await push(frame(4, { type: 'turn-end', exitCode: 0 }));
    // The turn is over: Clear is a plain enabled button again.
    expect(clearBtn().disabled).toBe(false);
  });

  it('lets go when the compact is refused', async () => {
    mocks.history.mockResolvedValue(history());
    await render();
    await act(async () => { (document.querySelector('button.chat-ring-btn') as HTMLButtonElement).click(); });
    mocks.context.mockRejectedValue({ response: { data: { error: 'busy', code: 'chat-busy' } } });
    await act(async () => { (document.querySelector('.chat-ring-compact') as HTMLButtonElement).click(); });
    await flush();
    expect(clearBtn().disabled).toBe(false);
  });
});

describe('SdkChatView: a send waits for an in-flight Resume (Bugbot #738)', () => {
  it('sends only after the Resume answered, so the message goes into the resumed session', async () => {
    mocks.history.mockResolvedValue({
      ...history(), sessionId: null,
      entries: [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }, reply, { type: 'context-cleared', at: 'T1' }],
    });
    await render();
    await act(async () => { (document.querySelector('button.chat-ring-btn') as HTMLButtonElement).click(); });
    let answer: (v: unknown) => void = () => {};
    mocks.context.mockReturnValue(new Promise(resolve => { answer = resolve; }));
    const order: string[] = [];
    mocks.context.mockImplementation(() => { order.push('resume'); return new Promise(resolve => { answer = resolve; }); });
    mocks.send.mockImplementation(() => { order.push('send'); return Promise.resolve({ queued: false, turnId: 't2' }); });
    await act(async () => { (document.querySelector('.chat-ring-resume') as HTMLButtonElement).click(); });
    // Enter while the Resume is still out.
    const input = document.querySelector('textarea.chat-input') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'and then?');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await flush();
    expect(order).toEqual(['resume']);
    await act(async () => { answer({ resumed: true, at: 'T1', resumedAt: 'T2', sessionId: 's1' }); });
    await flush();
    expect(order).toEqual(['resume', 'send']);
  });
});

describe('SdkChatView: a send behind an in-flight Clear goes after its divider (Bugbot #738)', () => {
  it('draws the message below the divider, and Resume is not on offer for it', async () => {
    mocks.history.mockResolvedValue(history());
    await render();
    await act(async () => { (document.querySelector('button.chat-ring-btn') as HTMLButtonElement).click(); });
    let answer: (v: unknown) => void = () => {};
    mocks.context.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    mocks.send.mockResolvedValue({ queued: false, turnId: 't2' });
    await act(async () => { (document.querySelector('.chat-ring-clear') as HTMLButtonElement).click(); });
    const input = document.querySelector('textarea.chat-input') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'fresh start');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await flush();
    await act(async () => { answer({ reset: true, at: '2026-10-27T10:00:00.000Z' }); });
    await flush();
    expect(mocks.send).toHaveBeenCalled();
    // The divider, then the message the new session starts with.
    const transcript = document.querySelector('.chat-transcript') as HTMLElement;
    const divider = transcript.querySelector('.sdk-divider') as HTMLElement;
    const bubble = [...transcript.querySelectorAll('.sdk-user')].find(el => el.textContent?.includes('fresh start')) as HTMLElement;
    expect(divider).toBeTruthy();
    expect(bubble).toBeTruthy();
    expect(divider.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A message after the clear: nothing to resume any more, in the popover or on the divider.
    if (!document.querySelector('.chat-ring-pop')) await act(async () => { (document.querySelector('button.chat-ring-btn') as HTMLButtonElement).click(); });
    expect(document.querySelector('.chat-ring-resume')).toBeNull();
    expect(divider.querySelector('button')).toBeNull();
  });
});

describe('SdkChatView: costs from session totals', () => {
  it('shows each reply, the header, the menu and the popover from what each turn added, not a sum of totals', async () => {
    const said = (i: number, text: string) => [
      { type: 'user', uuid: `u${i}`, message: { role: 'user', content: text } },
      { type: 'assistant', message: { id: `m${i}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: `answer ${i}` }] } },
    ];
    const at = (h: number) => `2026-10-28T0${h}:00:00.000Z`;
    // An older agent's records: each turn's costUsd is the session's total so far; the clear started a new session.
    mocks.history.mockResolvedValue({
      ...historyOn('sonnet'), contextActions: 'ready', sessionId: 's2',
      entries: [...said(1, 'one'), ...said(2, 'two'), { type: 'context-cleared', at: at(3) }, ...said(3, 'three')],
      turns: [
        { turnId: 'a', userUuid: 'u1', prompt: 'one', costUsd: 167.51, durationMs: 1000, at: at(1) },
        { turnId: 'b', userUuid: 'u2', prompt: 'two', costUsd: 168.08, durationMs: 1000, at: at(2) },
        { turnId: 'c', userUuid: 'u3', prompt: 'three', costUsd: 0.4, durationMs: 1000, at: at(4) },
      ],
    });
    await render();
    const metas = [...document.querySelectorAll('.sdk-reply-meta')].map(e => e.textContent);
    expect(metas.map(m => m?.split(' ')[0])).toEqual(['$167.51', '$0.57', '$0.40']);
    expect(document.querySelector('.sdk-cost-total')?.textContent).toBe('$168.48 total');
    await act(async () => { (document.querySelector('button.chat-ring-btn') as HTMLButtonElement).click(); });
    expect(document.body.textContent).toContain('This chat · $0.40 since cleared$168.48');
    expect(document.body.textContent).not.toContain('$336');
  });
});
