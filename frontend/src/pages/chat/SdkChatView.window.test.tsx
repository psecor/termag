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
});
