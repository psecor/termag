// The hot-box note a New session leaves for its chat (chat/boxPlacement.ts
// hotBoxNote), keyed by project and workstream: written at Send, shown at the
// end of the transcript until it's dismissed. localStorage, so a reload keeps it.
const PREFIX = 'termag-chat-hot-box:';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null | undefined;

export function writeHotBoxNotice(store: Store, chatId: string, text: string): void {
  try { store?.setItem(PREFIX + chatId, text); } catch { /* a full or blocked store keeps nothing */ }
}

export function readHotBoxNotice(store: Store, chatId: string): string | null {
  try { return store?.getItem(PREFIX + chatId) || null; } catch { return null; }
}

export function dismissHotBoxNotice(store: Store, chatId: string): void {
  try { store?.removeItem(PREFIX + chatId); } catch { /* ignore */ }
}
