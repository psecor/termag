import { describe, expect, it, vi } from 'vitest';

const updates = vi.hoisted(() => [] as unknown[]);
vi.mock('../db', () => ({ prisma: { workstream: { updateMany: vi.fn(async (args: unknown) => { updates.push(args); return { count: 1 }; }) } } }));

import { chatHolderOf, saveChatHolder } from './chatHolder';

const SESSION = '5109190e-c0d2-4f72-9c15-3c4c57fb126c';

describe('chatHolderOf', () => {
  it("reads a box's notice that the desktop's thread took the session, or the runner took it back", () => {
    expect(chatHolderOf({ type: 'chat-holder', holder: 't3', threadId: 'import:claude:abc', sessionId: SESSION }))
      .toEqual({ holder: 't3', threadId: 'import:claude:abc', sessionId: SESSION });
    expect(chatHolderOf({ type: 'chat-holder', holder: 'runner', threadId: 't1', sessionId: null }))
      .toEqual({ holder: 'runner', threadId: 't1', sessionId: null });
  });

  it('takes no thread for the desktop without a usable id, and no bad session id', () => {
    expect(chatHolderOf({ type: 'chat-holder', holder: 't3', threadId: 'a b' })).toBeNull();
    expect(chatHolderOf({ type: 'chat-holder', holder: 't3' })).toBeNull();
    expect(chatHolderOf({ type: 'chat-holder', holder: 'runner', sessionId: '../x' })).toEqual({ holder: 'runner', threadId: null, sessionId: null });
  });

  it('is nothing for any other event', () => {
    for (const e of [null, 'chat-holder', { type: 'turn-end' }, { type: 'chat-holder', holder: 'pane' }]) expect(chatHolderOf(e)).toBeNull();
  });
});

describe('saveChatHolder', () => {
  const at = new Date('2026-10-31T06:00:00Z');
  const data = () => (updates.at(-1) as { data: Record<string, unknown> }).data;

  it('leaves the chat on exactly the session the box named, none included', async () => {
    await saveChatHolder('p1', 'ws1', { holder: 't3', threadId: 't1', sessionId: SESSION }, at);
    expect(data()).toEqual({ chatHolder: 't3', chatHolderAt: at, t3ThreadId: 't1', chatSessionId: SESSION });
    // A chat the desktop made: held before its thread's first turn, so no earlier session lingers.
    await saveChatHolder('p1', 'ws1', { holder: 't3', threadId: 't2', sessionId: null }, at);
    expect(data()).toEqual({ chatHolder: 't3', chatHolderAt: at, t3ThreadId: 't2', chatSessionId: null });
  });

  it("keeps the desktop's thread when the runner takes the session back", async () => {
    await saveChatHolder('p1', 'ws1', { holder: 'runner', threadId: 't1', sessionId: SESSION }, at);
    expect(data()).toEqual({ chatHolder: 'runner', chatHolderAt: at, chatSessionId: SESSION });
  });
});
