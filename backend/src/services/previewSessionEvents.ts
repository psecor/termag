/**
 * Preview sessions this process revoked (a link revoked or ended, a viewer
 * removed, a renew that narrowed the audience), for the relay to close their
 * WebSockets with 1008 and drop them from its 30 s cache at once.
 * The publish service fires
 * it (PreviewLinkDeps.onSessionsRevoked) and the sweep; the preview host
 * listens. Another process finds out at its next 30 s recheck.
 */
type Listener = (linkId: string, idHashes: readonly string[]) => void;

const listeners = new Set<Listener>();

/** Listen; the return value stops listening. */
export function onPreviewSessionsRevoked(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Tell the listeners. Never throws: a revoke has already happened in the database. */
export function previewSessionsRevoked(linkId: string, idHashes: readonly string[]): void {
  for (const fn of listeners) {
    try { fn(linkId, idHashes); } catch (err) { console.warn('[PREVIEW-LINK] a revoke listener failed:', (err as Error).message); }
  }
}
