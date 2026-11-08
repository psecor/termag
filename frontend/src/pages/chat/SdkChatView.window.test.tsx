// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  earlier: vi.fn(),
  send: vi.fn(),
  noBoxes: [] as unknown[],
}));

vi.mock('../../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  chatApi: { history: mocks.history, earlier: mocks.earlier, send: mocks.send, reclaim: vi.fn(), interrupt: vi.fn(), openInTerminal: vi.fn(), trust: vi.fn() },
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
// Counts every markdown render, to see which groups a load draws.
const drawn = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock('../../chat/Markdown', () => ({ Markdown: ({ text }: { text: string }) => { drawn.texts.push(text); return <div>{text}</div>; } }));

import { SdkChatView } from './SdkChatView';

const project = {
  id: 'p1', name: 'web', instanceId: null, repoUrl: null, setupStatus: 'ready', setupError: null, role: 'owner', workflows: [], workstreams: [],
} as unknown as Project;

// A long chat: `turns` prompts and replies, 2 groups each (a window of 40 groups is 20 questions).
function longHistory(turns: number) {
  const entries = [];
  for (let i = 0; i < turns; i++) {
    entries.push({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `question ${i}` } });
    entries.push({ type: 'assistant', message: { id: `m${i}`, content: [{ type: 'text', text: `answer ${i}` }] } });
  }
  return {
    chatKey: 'p1--main', workstream: 'main', sessionId: 's1', running: false, queued: 0, checkoutReady: true,
    entries, turns: [], model: 'sonnet', trust: { trusted: true, reason: 'trusted', mode: 'bypassPermissions' }, canTrust: true,
  };
}

let root: Root;
let container: HTMLDivElement;
const ROW_PX = 50;
const VIEW_PX = 600;

async function flush() {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}

// jsdom lays nothing out: every user bubble and reply is ROW_PX tall, the transcript VIEW_PX.
function fakeLayout() {
  const rows = () => document.querySelectorAll('.sdk-user, .sdk-reply').length;
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.classList?.contains('chat-transcript') ? rows() * ROW_PX : 0; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList?.contains('chat-transcript') ? VIEW_PX : 0; } });
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

const transcript = () => document.querySelector('.chat-transcript') as HTMLDivElement;
const questions = () => [...document.querySelectorAll('.sdk-user-bubble')].map(b => b.textContent);
async function scrollTo(top: number) {
  await act(async () => {
    transcript().scrollTop = top;
    transcript().dispatchEvent(new Event('scroll'));
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  sessionStorage.clear();
  mocks.history.mockReset();
  mocks.earlier.mockReset();
  fakeLayout();
});

afterEach(() => {
  if (container?.isConnected) { act(() => root.unmount()); container.remove(); }
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

async function sendMessage(text: string) {
  const input = document.querySelector('textarea.chat-input') as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { (document.querySelector('form.chat-composer') as HTMLFormElement).requestSubmit(); });
  await flush();
}

describe('SdkChatView long transcripts', () => {
  it('keeps a chat that fits in the window whole when a message is sent', async () => {
    mocks.send.mockResolvedValue({ queued: false, turnId: 't1' });
    // 20 turns: exactly 40 groups, all drawn.
    mocks.history.mockResolvedValue(longHistory(20));
    await render();
    expect(questions()[0]).toBe('question 0');
    await sendMessage('one more');
    expect(questions()[0]).toBe('question 0');
    expect(questions()[questions().length - 1]).toBe('one more');
    expect(document.querySelector('.chat-earlier')).toBeNull();
  });

  it('keeps the oldest drawn group where it is when a message is sent after scrolling up', async () => {
    mocks.send.mockResolvedValue({ queued: false, turnId: 't1' });
    mocks.history.mockResolvedValue(longHistory(100));
    await render();
    await scrollTo(1000);
    await scrollTo(100);
    expect(questions()[0]).toBe('question 60');
    const shown = questions().length;
    await sendMessage('one more');
    expect(questions()[0]).toBe('question 60');
    expect(questions()).toHaveLength(shown + 1);
  });

  it('draws only the earlier groups a load brings in, not the ones already on screen', async () => {
    mocks.history.mockResolvedValue(longHistory(100));
    await render();
    await scrollTo(1000);
    drawn.texts = [];
    await scrollTo(100);
    expect(questions()).toHaveLength(40);
    expect(drawn.texts).toHaveLength(20);
    expect(drawn.texts[0]).toBe('answer 60');
    expect(drawn.texts[drawn.texts.length - 1]).toBe('answer 79');
  });

  it('corrects the fraction of a pixel the whole-pixel scrollHeight leaves out, from the first group drawn before', async () => {
    mocks.history.mockResolvedValue(longHistory(100));
    await render();
    await scrollTo(1000);
    // The group that was first on screen sits 0.6px lower after the load than scrollHeight says.
    const first = document.querySelector('.sdk-transcript > .sdk-user') as HTMLElement;
    let shift = 0;
    first.getBoundingClientRect = () => ({ top: 10 + shift } as DOMRect);
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')!.get!;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() {
      const h = height.call(this);
      if (this.classList?.contains('chat-transcript') && h > 40 * ROW_PX) shift = 0.6;
      return h;
    } });
    await scrollTo(100);
    expect(transcript().scrollTop).toBeCloseTo(100 + 40 * ROW_PX + 0.6, 5);
  });

  it('opens on the newest groups at the bottom, without loading earlier ones', async () => {
    mocks.history.mockResolvedValue(longHistory(100));
    await render();
    expect(questions()).toHaveLength(20);
    expect(questions()[0]).toBe('question 80');
    expect(transcript().scrollTop).toBe(40 * ROW_PX);
    // The open's own scroll event at the bottom, and even one at the very top first, load nothing.
    await scrollTo(transcript().scrollTop);
    expect(questions()).toHaveLength(20);
  });

  it('loads the next earlier groups on a scroll up to the top, anchored, until everything is shown', async () => {
    mocks.history.mockResolvedValue(longHistory(100));
    await render();
    await scrollTo(1000);
    await scrollTo(100);
    expect(questions()).toHaveLength(40);
    expect(questions()[0]).toBe('question 60');
    // What was 100px from the top is still there: 40 groups came in above it.
    expect(transcript().scrollTop).toBe(100 + 40 * ROW_PX);
    // The anchoring jump down loads nothing; neither does scrolling down.
    await scrollTo(transcript().scrollTop + 10);
    expect(questions()).toHaveLength(40);
    // Each scroll up to the top brings in 40 more, until the first question.
    for (let i = 0; i < 3; i++) {
      await scrollTo(1000);
      await scrollTo(10);
    }
    expect(questions()).toHaveLength(100);
    expect(questions()[0]).toBe('question 0');
    expect(document.querySelector('.chat-earlier')).toBeNull();
  });

  it('keeps the button as a fallback: out of sight where scrolling loads, shown where the transcript cannot scroll', async () => {
    const button = () => document.querySelector('.chat-earlier') as HTMLButtonElement | null;
    mocks.history.mockResolvedValue(longHistory(100));
    await render();
    expect(button()?.dataset.fallback).toBe('true');
    act(() => root.unmount());
    container.remove();

    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList?.contains('chat-transcript') ? 100_000 : 0; } });
    await render();
    expect(button()?.dataset.fallback).toBeUndefined();
    await act(async () => { button()!.click(); });
    expect(questions()).toHaveLength(40);
    for (let i = 0; i < 3; i++) await act(async () => { button()!.click(); });
    expect(questions()).toHaveLength(100);
    expect(button()).toBeNull();
  });

  it('pages older history in from the box once the window reaches the top, anchored, until the first question', async () => {
    // The box sends the newest 40 questions and says there are more; each page is 30 more, the last one done.
    const all = longHistory(100).entries;
    const from = (i: number) => all.findIndex(e => (e as { uuid?: string }).uuid === `u${i}`);
    mocks.history.mockImplementation(async () => ({ ...longHistory(0), entries: all.slice(from(60)), more: true }));
    mocks.earlier.mockImplementation(async (_p: string, _w: string, before: string) => {
      const end = all.findIndex(e => (e as { uuid?: string }).uuid === before);
      const begin = Math.max(0, end - 60);
      return { entries: all.slice(begin, end), done: begin === 0 };
    });
    await render();
    for (let i = 0; i < 20 && questions()[0] !== 'question 0'; i++) {
      await scrollTo(1000);
      await scrollTo(100);
      await flush();
    }
    expect(questions()[0]).toBe('question 0');
    expect(questions()).toHaveLength(100);
    expect(new Set(questions()).size).toBe(100);
    expect(mocks.earlier.mock.calls.map(c => c[2])).toEqual(['u60', 'u30']);
    expect(document.querySelector('.chat-earlier')).toBeNull();
  });

  it('keeps what is on screen where it was when a page comes in', async () => {
    const all = longHistory(40).entries;
    mocks.history.mockImplementation(async () => ({ ...longHistory(0), entries: all.slice(40), more: true }));
    mocks.earlier.mockResolvedValue({ entries: all.slice(0, 40), done: true });
    await render();
    expect(questions()).toHaveLength(20);
    await scrollTo(500);
    await scrollTo(100);
    await flush();
    expect(mocks.earlier).toHaveBeenCalledWith('p1', 'main', 'u20', undefined);
    expect(questions()[0]).toBe('question 0');
    // 40 groups came in above what was 100px from the top.
    expect(transcript().scrollTop).toBe(100 + 40 * ROW_PX);
  });

  it('offers older history as a button when the transcript is too short to scroll', async () => {
    const all = longHistory(3).entries;
    mocks.history.mockImplementation(async () => ({ ...longHistory(0), entries: all.slice(2), more: true }));
    mocks.earlier.mockResolvedValue({ entries: all.slice(0, 2), done: true });
    await render();
    const button = document.querySelector('.chat-earlier') as HTMLButtonElement;
    expect(button.textContent).toBe('Show earlier messages');
    await act(async () => { button.click(); });
    await flush();
    expect(questions()).toEqual(['question 0', 'question 1', 'question 2']);
    expect(document.querySelector('.chat-earlier')).toBeNull();
  });

  it('says why older history did not come, offers it again only when asking again can help', async () => {
    const all = longHistory(3).entries;
    mocks.history.mockImplementation(async () => ({ ...longHistory(0), entries: all.slice(2), more: true }));
    const refusal = (status: number, code: string, error: string) => Object.assign(new Error(error), { response: { status, data: { code, error } } });
    mocks.earlier.mockRejectedValueOnce(refusal(503, 'box-away', "The session's box isn't connected"));
    await render();
    await act(async () => { (document.querySelector('.chat-earlier') as HTMLButtonElement).click(); });
    await flush();
    expect(document.querySelector('.chat-earlier-error')?.textContent).toBe("The session's box isn't connected");
    expect(document.querySelector('.chat-earlier')?.textContent).toBe('Try again');
    mocks.earlier.mockRejectedValueOnce(refusal(409, 'runner-update', "This box's agent needs an update before it can show older history"));
    await act(async () => { (document.querySelector('.chat-earlier') as HTMLButtonElement).click(); });
    await flush();
    expect(document.querySelector('.chat-earlier-error')?.textContent).toBe("This box's agent needs an update before it can show older history");
    expect(document.querySelector('.chat-earlier')).toBeNull();
    expect(questions()).toEqual(['question 1', 'question 2']);
  });

  it('keeps paging open on an empty page that is not done', async () => {
    const all = longHistory(3).entries;
    mocks.history.mockImplementation(async () => ({ ...longHistory(0), entries: all.slice(2), more: true }));
    mocks.earlier.mockResolvedValueOnce({ entries: [], done: false });
    await render();
    await act(async () => { (document.querySelector('.chat-earlier') as HTMLButtonElement).click(); });
    await flush();
    expect(document.querySelector('.chat-earlier-error')?.textContent).toBe('Could not load earlier messages');
    expect(document.querySelector('.chat-earlier')?.textContent).toBe('Try again');
  });

  it('starts another chat with paging open, whatever the last one ended on', async () => {
    const all = longHistory(3).entries;
    mocks.history.mockImplementation(async () => ({ ...longHistory(0), entries: all.slice(2), more: true }));
    mocks.earlier.mockRejectedValueOnce(Object.assign(new Error('old'), { response: { status: 409, data: { code: 'runner-update', error: 'needs an update' } } }));
    await render();
    await act(async () => { (document.querySelector('.chat-earlier') as HTMLButtonElement).click(); });
    await flush();
    expect(document.querySelector('.chat-earlier')).toBeNull();
    await act(async () => {
      root.render(<MemoryRouter><SdkChatView project={project} workstream="other" /></MemoryRouter>);
    });
    await flush();
    expect(document.querySelector('.chat-earlier-error')).toBeNull();
    expect(document.querySelector('.chat-earlier')?.textContent).toBe('Show earlier messages');
  });
});
