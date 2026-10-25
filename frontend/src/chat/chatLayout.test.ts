import { describe, expect, it } from 'vitest';
import { CHAT_NARROW_QUERY, chatHistoryMode, historyListHidden } from './chatLayout';

describe('chatHistoryMode', () => {
  it('keeps the list docked beside the chat on a wide screen', () => {
    expect(chatHistoryMode('/chat', false)).toBe('docked');
    expect(chatHistoryMode('/chat/p/abc', false)).toBe('docked');
    expect(chatHistoryMode('/chat/new', false)).toBe('docked');
  });

  it('makes the list the page at /chat on a phone', () => {
    expect(chatHistoryMode('/chat', true)).toBe('page');
    expect(chatHistoryMode('/chat/', true)).toBe('page');
    expect(chatHistoryMode('/termag/chat', true)).toBe('page');
  });

  it('overlays the list on a conversation or new chat so the thread keeps the width', () => {
    expect(chatHistoryMode('/chat/p/abc', true)).toBe('drawer');
    expect(chatHistoryMode('/chat/p/abc/', true)).toBe('drawer');
    expect(chatHistoryMode('/termag/chat/p/abc', true)).toBe('drawer');
    expect(chatHistoryMode('/chat/new', true)).toBe('drawer');
  });

  it('hides a closed phone drawer from keyboard and assistive tech', () => {
    expect(historyListHidden('drawer', false)).toBe(true);
    expect(historyListHidden('drawer', true)).toBe(false);
    expect(historyListHidden('docked', false)).toBe(false);
    expect(historyListHidden('page', false)).toBe(false);
  });

  it('names the phone breakpoint the chat stylesheet media query uses', () => {
    // pages/chat/chat.css `@media (max-width: 767px)` must stay this string,
    // including the New chat safe-area padding for the Chats control.
    expect(CHAT_NARROW_QUERY).toBe('(max-width: 767px)');
  });
});
