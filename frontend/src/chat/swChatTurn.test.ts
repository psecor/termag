// public/sw.js run in a fake worker global: the chat-turn branch of `push`
// and the window `notificationclick` picks.
import { describe, expect, it } from 'vitest';
import SOURCE from '../../public/sw.js?raw';
const ORIGIN = 'https://termag.example.com';

interface FakeWindow { url: string; focused: boolean; visibilityState: string; messages: unknown[] }

function worker(windows: FakeWindow[]) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const self = {
    location: { origin: ORIGIN },
    navigator: {},
    addEventListener: (type: string, fn: (e: unknown) => void) => { handlers[type] = fn; },
    skipWaiting: () => {},
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); },
      getNotifications: async () => [],
    },
    clients: {
      claim: async () => {},
      matchAll: async () => windows.map(w => ({
        ...w,
        postMessage: (m: unknown) => { w.messages.push(m); },
        focus: async () => w,
      })),
      openWindow: async () => null,
    },
  };
  new Function('self', 'URL', 'console', 'indexedDB', SOURCE)(self, URL, console, undefined);

  async function dispatch(type: string, event: Record<string, unknown>): Promise<void> {
    let done: Promise<unknown> = Promise.resolve();
    handlers[type]({ ...event, waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
  }
  return {
    shown,
    push: (payload: unknown) => dispatch('push', { data: { json: () => payload } }),
    pushSafari: (notification: unknown) => dispatch('push', { notification, data: null }),
    click: (url: string) => dispatch('notificationclick', { notification: { close: () => {}, tag: 't', data: { url } } }),
  };
}

const CHAT_URL = `${ORIGIN}/termag/chat/p/p1`;
const chatPush = (navigate = CHAT_URL) => ({
  web_push: 8030,
  mutable: true,
  notification: { title: 'orchestrator', body: 'Your turn · done', navigate, tag: 'chat-turn:p1:main', data: { key: 'chat-turn:p1:main', kind: 'chat-turn' } },
});
const win = (path: string, focused = true, visibilityState = 'visible'): FakeWindow => ({ url: `${ORIGIN}${path}`, focused, visibilityState, messages: [] });

describe('sw.js chat-turn push', () => {
  it('shows it under the chat tag when nobody is looking at that chat', async () => {
    const w = worker([win('/termag/chat/p/p2'), win('/termag/chat/p/p1', false, 'hidden')]);
    await w.push(chatPush());
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0].title).toBe('orchestrator');
    expect(w.shown[0].options).toMatchObject({ tag: 'chat-turn:p1:main', renotify: true, body: 'Your turn · done', data: { url: CHAT_URL } });
    // A Chrome that honours `navigate` would handle the click itself, never routing the open window.
    expect(w.shown[0].options).not.toHaveProperty('navigate');
  });

  it('skips it when a focused, visible window shows that chat', async () => {
    const w = worker([win('/termag/chat/p/p1')]);
    await w.push(chatPush());
    expect(w.shown).toEqual([]);
  });

  it('tells workstreams apart', async () => {
    const w = worker([win('/termag/chat/p/p1?ws=feat')]);
    await w.push(chatPush());
    expect(w.shown).toHaveLength(1);
  });

  it('always shows it on Safari, which revokes a push that shows nothing', async () => {
    const w = worker([win('/termag/chat/p/p1')]);
    await w.pushSafari({ title: 'orchestrator', body: 'Done · your turn', navigate: CHAT_URL, data: { key: 'chat-turn:p1:main', kind: 'chat-turn' } });
    expect(w.shown).toHaveLength(1);
    // One notification per chat: not the per-push tag the phone's waiting pushes use.
    expect(w.shown[0].options.tag).toBe('chat-turn:p1:main');
    // Safari may never run notificationclick for a live app: it navigates itself.
    expect(w.shown[0].options.navigate).toBe(CHAT_URL);
  });
});

describe('sw.js notificationclick', () => {
  it('routes a chat in a simple-UI window, a session in a phone window', async () => {
    const phone = win('/termag/m');
    const chat = win('/termag/chat');
    const w = worker([phone, chat]);
    await w.click(CHAT_URL);
    expect(chat.messages).toEqual([{ type: 'termag:navigate', url: CHAT_URL }]);
    await w.click(`${ORIGIN}/termag/m/p/p1`);
    expect(phone.messages).toEqual([{ type: 'termag:navigate', url: `${ORIGIN}/termag/m/p/p1` }]);
  });
});
