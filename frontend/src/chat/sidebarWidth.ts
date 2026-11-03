// The simple UI's sidebar width under the chrome refresh:
// dragged or stepped with the keyboard
// between a floor and a ceiling, and kept per browser. Pure, for the tests;
// pages/chat/SidebarResize.tsx is the handle.

export const SIDEBAR_WIDTH_KEY = 'termag.chat.sidebarWidth';
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 440;
export const SIDEBAR_DEFAULT = 264;
/** One arrow key press; with Shift, three. */
export const SIDEBAR_STEP = 16;

interface ReadStorage { getItem(key: string): string | null }
interface WriteStorage { setItem(key: string, value: string): void }

export function clampSidebarWidth(width: number): number {
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
}

/** The kept width, or the default when there is none or it is not a number. */
export function readSidebarWidth(storage: ReadStorage | null): number {
  let raw: string | null = null;
  try { raw = storage?.getItem(SIDEBAR_WIDTH_KEY) ?? null; } catch { /* storage blocked */ }
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? clampSidebarWidth(n) : SIDEBAR_DEFAULT;
}

export function writeSidebarWidth(storage: WriteStorage | null, width: number): void {
  try { storage?.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width))); } catch { /* private mode, full storage */ }
}

/** The width after a key press on the handle, or null for a key it ignores. */
export function sidebarWidthForKey(width: number, key: string, shift: boolean): number | null {
  const step = shift ? SIDEBAR_STEP * 3 : SIDEBAR_STEP;
  switch (key) {
    case 'ArrowLeft': return clampSidebarWidth(width - step);
    case 'ArrowRight': return clampSidebarWidth(width + step);
    case 'Home': return SIDEBAR_MIN;
    case 'End': return SIDEBAR_MAX;
    case 'Enter': return SIDEBAR_DEFAULT;
    default: return null;
  }
}
