import { describe, expect, it, vi } from 'vitest';

const updates = vi.hoisted(() => [] as unknown[]);
vi.mock('../db', () => ({ prisma: { workstream: { updateMany: vi.fn(async (args: unknown) => { updates.push(args); return { count: 1 }; }) } } }));

import { chatHolderOf, runnerSessionOf, saveChatHolder, saveRunnerSession } from './chatHolder';

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

describe('runnerSessionOf', () => {
  it("reads the session a runner turn's init names", () => {
    expect(runnerSessionOf({ type: 'system', subtype: 'init', session_id: SESSION, cwd: '/home/u/p' })).toBe(SESSION);
  });

  it('is nothing for another event or a bad id', () => {
    for (const e of [
      null, 'init', { type: 'system', subtype: 'compact_boundary', session_id: SESSION },
      { type: 'assistant', session_id: SESSION }, { type: 'system', subtype: 'init', session_id: '../x' },
      { type: 'system', subtype: 'init' },
      // A pi turn's init (agent/pi-events.js) names a pi session, not a Claude one.
      { type: 'system', subtype: 'init', engine: 'pi', session_id: SESSION },
      // Nor a Cursor turn's (agent/cursor-events.js), a Devin turn's (agent/devin-events.js, its id Devin's name
      // behind devin-), or one from an engine this backend doesn't know.
      { type: 'system', subtype: 'init', engine: 'cursor', session_id: SESSION },
      { type: 'system', subtype: 'init', engine: 'devin', session_id: SESSION },
      { type: 'system', subtype: 'init', engine: 'devin', session_id: 'devin-vanilla-afternoon' },
      { type: 'system', subtype: 'init', engine: 'codex', session_id: SESSION },
    ]) expect(runnerSessionOf(e)).toBeNull();
    expect(runnerSessionOf({ type: 'system', subtype: 'init', engine: 'claude', session_id: SESSION })).toBe(SESSION);
  });
});

describe('saveRunnerSession', () => {
  it("names the chat's session at once, only when it changed and the runner holds it", async () => {
    await expect(saveRunnerSession('p1', 'ws1', SESSION)).resolves.toBe(true);
    expect(updates.at(-1)).toEqual({
      where: {
        id: 'ws1', projectId: 'p1',
        AND: [
          { OR: [{ chatSessionId: null }, { chatSessionId: { not: SESSION } }] },
          // While the desktop's thread holds it, its hand-over names the session.
          { OR: [{ chatHolder: null }, { chatHolder: 'runner' }] },
        ],
      },
      data: { chatSessionId: SESSION },
    });
  });
});
