// The images New session's first message carries (pages/chat/NewChat.tsx),
// held until the chat sends that message (pages/chat/useSdkChat.ts
// sendQueued). The text waits in localStorage (chat/newChat.ts writeQueued),
// but four images are up to ~20 MB of base64, past any browser's storage
// quota, so the images wait in this page's memory and storage keeps only how
// many there are. A reload (or another tab sending the message) therefore
// finds a count with no images, and the send says so instead of quietly
// sending the text alone.
import { CHAT_PDF_TYPE, type PreparedImage } from './chatImageData';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null | undefined;

const COUNT_PREFIX = 'termag-chat-queued-images:';
const ONLY_PREFIX = 'termag-chat-queued-attachments-only:';

/**
 * The queued text of a first message that is attachments alone. The queue
 * holds text and drops an empty one, so this stands in for "no text". It is
 * read as the stand-in only at the start of a queue that storage marks as
 * attachments-only (queuedFirstText), so the same characters typed in a
 * message go as they are.
 */
export const ATTACHMENTS_ONLY = '[termag:attachments-only]';

/**
 * What New session queues under `key` for a first message: its text, or, for
 * attachments with none, ATTACHMENTS_ONLY with the mark that makes it read as
 * no text. Null when storage would not keep the mark: then the message is not
 * queued, and goes to the composer as a draft.
 */
export function queuedFirstText(store: Store, key: string, message: string, attachments: number): string | null {
  if (message.trim() || attachments === 0) return message;
  try {
    store?.setItem(ONLY_PREFIX + key, '1');
    if (store?.getItem(ONLY_PREFIX + key) !== '1') return null;
  } catch {
    return null;
  }
  return ATTACHMENTS_ONLY;
}

/**
 * A queued message under `key` as it is sent and shown. In a queue marked
 * attachments-only, the stand-in at its start goes, with the one space a
 * message queued behind it was joined with (useQueuedMessage enqueue); every
 * other character, newlines included, stays.
 */
export function firstMessageText(store: Store, key: string, queued: string): string {
  let marked = false;
  try { marked = store?.getItem(ONLY_PREFIX + key) === '1'; } catch { /* unmarked */ }
  if (!marked || !queued.startsWith(ATTACHMENTS_ONLY)) return queued;
  const rest = queued.slice(ATTACHMENTS_ONLY.length);
  return rest.startsWith(' ') ? rest.slice(1) : rest;
}

/** The queued first message under `key` went, or was dropped: its attachments-only mark goes with it. */
export function finishFirstMessage(store: Store, key: string): void {
  try { store?.removeItem(ONLY_PREFIX + key); } catch { /* nothing to drop */ }
}

const held = new Map<string, PreparedImage[]>();

/** Hold `images` for the first message queued under `key` (chat/newChat.ts queueKey). */
export function holdFirstImages(store: Store, key: string, images: readonly PreparedImage[]): void {
  if (!images.length) { releaseFirstImages(store, key); return; }
  held.set(key, [...images]);
  try { store?.setItem(COUNT_PREFIX + key, String(images.length)); } catch { /* the count is only for a reload */ }
}

/** What the first message under `key` carries: the images this page holds, and how many it was given but no longer has. */
export function firstImages(store: Store, key: string): { images: PreparedImage[]; lost: number } {
  const images = held.get(key) ?? [];
  let count = 0;
  try { count = Number(store?.getItem(COUNT_PREFIX + key) ?? 0) || 0; } catch { /* none recorded */ }
  return { images, lost: Math.max(0, count - images.length) };
}

/** The first message under `key` went, or will go without its images. */
export function releaseFirstImages(store: Store, key: string): void {
  held.delete(key);
  try { store?.removeItem(COUNT_PREFIX + key); } catch { /* nothing to drop */ }
}

/**
 * What a note calls the first message's attachments: "its image", "its 2 PDFs",
 * "its 3 attachments" for a mix, or for a count whose kinds this page no longer has.
 */
export function attachmentsPhrase(items: readonly { mediaType: string }[] | number): string {
  const n = typeof items === 'number' ? items : items.length;
  const pdfs = typeof items === 'number' ? -1 : items.filter(i => i.mediaType === CHAT_PDF_TYPE).length;
  const noun = pdfs === 0 ? 'image' : pdfs === n ? 'PDF' : 'attachment';
  return n === 1 ? `its ${noun}` : `its ${n} ${noun}s`;
}
