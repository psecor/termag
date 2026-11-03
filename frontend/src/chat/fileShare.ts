// Sharing a space file with anyone signed in to termag, from the simple UI's
// file view (pages/chat/SpaceFileView.tsx; backend services/spaces/sharedFiles.ts).
// Turning sharing on asks first; "Don't ask again" skips that for one space,
// in this browser, until Settings clears it.

export const SHARE_CONFIRM_SKIP_KEY = 'termag-share-confirm-skip';

type ReadStorage = Pick<Storage, 'getItem'> | null | undefined;
type WriteStorage = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

/** The spaces whose files are shared without asking, sorted. */
export function shareConfirmSkips(storage: ReadStorage): string[] {
  let raw: unknown;
  try { raw = JSON.parse(storage?.getItem(SHARE_CONFIRM_SKIP_KEY) ?? '[]'); } catch { return []; }
  return Array.isArray(raw) ? [...new Set(raw.filter((s): s is string => typeof s === 'string' && s !== ''))].sort() : [];
}

export function skipsShareConfirm(storage: ReadStorage, space: string): boolean {
  return shareConfirmSkips(storage).includes(space);
}

export function skipShareConfirm(storage: WriteStorage, space: string): void {
  const next = [...new Set([...shareConfirmSkips(storage), space])].sort();
  try { storage?.setItem(SHARE_CONFIRM_SKIP_KEY, JSON.stringify(next)); } catch { /* private mode: asked again next time */ }
}

export function clearShareConfirmSkips(storage: Pick<Storage, 'removeItem'> | null | undefined): void {
  try { storage?.removeItem(SHARE_CONFIRM_SKIP_KEY); } catch { /* nothing stored */ }
}

/** Fired on window when the file view shares or unshares a file, so the explorer's cached tree marks it. */
export const FILE_SHARE_EVENT = 'termag-space-file-share';
export interface FileShareChange { space: string; path: string; shared: boolean }

export function announceShared(space: string, path: string, shared: boolean): void {
  window.dispatchEvent(new CustomEvent<FileShareChange>(FILE_SHARE_EVENT, { detail: { space, path, shared } }));
}

/** Who a file's link opens for, for the link part's tooltip. */
export function linkAudience(shared: boolean): string {
  return shared ? 'anyone signed in to termag' : 'space members only';
}
