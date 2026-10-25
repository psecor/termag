// What a chat composer sends into a pane, shared by the phone and desktop chats.

/** The send-keys route's limit. */
export const MAX_KEYS = 4000;

/**
 * A line feed is Enter at the terminal (`send-keys -l` delivers it verbatim),
 * so a multi-line draft would land as one submission per line. Pasted
 * newlines become single spaces and the result is trimmed; empty means
 * nothing to send.
 */
export function flattenForSend(text: string): string {
  return text.replace(/\s*(?:\r\n?|\n)\s*/g, ' ').trim();
}

/**
 * The draft once `sent` has gone into the pane. A send is a round trip, and
 * the composer stays editable meanwhile, so what was typed after it is kept:
 * clearing the box outright would drop those keys.
 */
export function draftAfterSend(current: string, sent: string): string {
  return current.startsWith(sent) ? current.slice(sent.length) : current;
}

/** The line shown under the composer for a failed send. */
export function sendErrorText(err: unknown): string {
  const e = err as { response?: { status?: number; data?: { error?: string } } } | null;
  return e?.response?.data?.error
    ?? (e?.response?.status === 429 ? 'Too fast. Try again in a moment.' : 'Send failed');
}

/**
 * Whether a key press in a multi-line message box sends it: Enter, with or
 * without Ctrl/Cmd, sends; Shift+Enter is a newline; a key that finishes an
 * IME composition never sends. The chat composer and New chat's first
 * message use the same rule.
 */
export function isSendKey(e: { key: string; shiftKey: boolean; isComposing?: boolean }): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing;
}
