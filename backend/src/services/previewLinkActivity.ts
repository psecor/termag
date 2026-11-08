/**
 * What of a preview link's traffic counts as using its box (the idle sweep's
 * activity clock, services/boxActivity.ts), under preview shares' rule: a
 * viewer's input counts as the owner's box activity, an open connection
 * doesn't. So a background tab holding an HMR socket or
 * polling an API never keeps a box up; a person clicking through the app does.
 * An open preview tunnel is no busy signal either: index.ts's `tunnels` check
 * reads `port` tunnels only.
 *
 * Over HTTP the relay sees requests, not keystrokes, so input is what the
 * browser marks as a person's doing: a top-level navigation
 * (`Sec-Fetch-Mode: navigate`, a link or a form) or a request a user
 * gesture started (`Sec-Fetch-User: ?1`). Subresources, fetches, polling and
 * WebSocket frames (Vite's HMR pings among them) never count. The relay
 * (PR 2, services/previewRelay.ts) calls notePreviewViewerActivity on each
 * request it relays to a live link; the write is noteBoxActivity's,
 * throttled to one a minute per box and only for a ready box.
 */
import type { IncomingHttpHeaders } from 'http';
import { noteBoxActivity } from './boxActivity';

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Whether a relayed request is a viewer's input, by the browser's own Fetch Metadata. */
export function isViewerInput(headers: IncomingHttpHeaders): boolean {
  return header(headers, 'sec-fetch-mode') === 'navigate' || header(headers, 'sec-fetch-user') === '?1';
}

/** A request relayed to the link's box: the box's activity clock moves when it is a viewer's input. Never throws. */
export function notePreviewViewerActivity(instanceId: string | null | undefined, headers: IncomingHttpHeaders, now: number = Date.now()): boolean {
  if (!isViewerInput(headers)) return false;
  noteBoxActivity(instanceId, now);
  return true;
}
