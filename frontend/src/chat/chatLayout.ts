// How the simple UI's conversation list sits next to a chat. Desktop keeps
// the list docked. On a phone the list is the page at /chat, and a drawer
// over a conversation or New chat, so it never squeezes the thread into a
// sliver. The stylesheet's phone rules use the same query (pages/chat/chat.css).

/** Phone widths. Matched by `@media (max-width: 767px)` in chat.css. */
export const CHAT_NARROW_QUERY = '(max-width: 767px)';

export type ChatHistoryMode = 'docked' | 'page' | 'drawer';

/**
 * `docked` — sidebar beside the chat (desktop).
 * `page` — the list is the whole screen (`/chat` on a phone).
 * `drawer` — the list overlays the chat; the conversation keeps the width.
 */
export function chatHistoryMode(pathname: string, narrow: boolean): ChatHistoryMode {
  if (!narrow) return 'docked';
  const path = pathname.replace(/^\/termag(?=\/|$)/, '').replace(/\/+$/, '') || '/';
  return path === '/chat' ? 'page' : 'drawer';
}

/** A closed phone drawer is off-screen but still in the tree. Hide it from
 *  keyboard and assistive tech until Chats opens it. Docked and page lists stay. */
export function historyListHidden(mode: ChatHistoryMode, historyOpen: boolean): boolean {
  return mode === 'drawer' && !historyOpen;
}
