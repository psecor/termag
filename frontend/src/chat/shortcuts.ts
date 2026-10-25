// Keyboard shortcuts that work anywhere in the simple UI (pages/chat/ChatApp.tsx).

/**
 * New session: ⌘⇧O on a Mac, Ctrl+Shift+O elsewhere, as in ChatGPT. Browsers
 * keep ⌘N, ⌘T and ⌘W (and their Shift forms) and never pass them to a page;
 * Option with a letter types a character on a Mac, and Ctrl+Alt is AltGr on
 * many keyboards, so neither is used. Matched on `code`, which Shift and the
 * keyboard layout leave alone.
 */
export function isNewSessionShortcut(e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): boolean {
  return e.code === 'KeyO' && e.shiftKey && !e.altKey && (e.ctrlKey || e.metaKey);
}

export function newSessionShortcutLabel(platform: string | undefined): string {
  return /mac|iphone|ipad/i.test(platform ?? '') ? '⌘⇧O' : 'Ctrl+Shift+O';
}
