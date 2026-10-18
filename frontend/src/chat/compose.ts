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

/** The line shown under the composer for a failed send. */
export function sendErrorText(err: unknown): string {
  const e = err as { response?: { status?: number; data?: { error?: string } } } | null;
  return e?.response?.data?.error
    ?? (e?.response?.status === 429 ? 'Too fast. Try again in a moment.' : 'Send failed');
}
