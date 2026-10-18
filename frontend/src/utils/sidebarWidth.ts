/**
 * The sidebar's width: dragged on its right edge, remembered per browser.
 * Pure helpers so the clamp and the storage round trip are testable without
 * a DOM; App.tsx owns the pointer handling.
 */
export const SIDEBAR_WIDTH_KEY = 'termag-sidebar-width';
export const SIDEBAR_WIDTH_DEFAULT = 220;
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 480;
/** What the terminals keep whatever width was saved, so a wide sidebar from a desktop never swallows a phone. */
export const TERMINALS_MIN_WIDTH = 320;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.round(Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, px)));
}

/** The remembered width, or the default when nothing valid is stored (or storage is unavailable). */
export function readSidebarWidth(storage: StorageLike | null): number {
  try {
    const raw = storage?.getItem(SIDEBAR_WIDTH_KEY);
    const n = raw == null ? NaN : parseFloat(raw);
    return Number.isFinite(n) ? clampSidebarWidth(n) : SIDEBAR_WIDTH_DEFAULT;
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

export function writeSidebarWidth(storage: StorageLike | null, px: number): void {
  try { storage?.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(px))); } catch { /* private mode */ }
}

/**
 * The width the sidebar actually takes on this viewport: the saved width,
 * capped so the terminals keep TERMINALS_MIN_WIDTH, never below the minimum.
 * On a 400px phone a saved 480 becomes 180, and the handle stays reachable.
 */
export function effectiveSidebarWidth(saved: number, viewportWidth: number): number {
  const cap = Math.max(SIDEBAR_WIDTH_MIN, viewportWidth - TERMINALS_MIN_WIDTH);
  return Math.min(clampSidebarWidth(saved), cap);
}
