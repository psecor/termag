/**
 * termag's own pages on a preview host, and the landing page on the main host
 * ("Errors, as termag pages on the preview
 * host" and "The landing page"). Static HTML: no script, no termag asset, a
 * CSP that allows nothing but inline style, and no framing (SR22). A preview
 * host never loads termag's JavaScript, and none of these is ever relayed
 * from the app. Their look is previewPages/style.ts (inline only); the words
 * and statuses are settled here.
 */
import type { ServerResponse } from 'http';
import { pageDocument } from './style';

export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export type PreviewPageKind =
  | 'not_found'
  | 'not_running'
  | 'port_refused'
  | 'asleep'
  | 'try_again'
  | 'busy'
  | 'refresh_needed'
  | 'bad_request'
  | 'path_refused'
  | 'cross_site'
  | 'too_large'
  | 'rate_limited';

interface PageText { status: number; title: string; body: string; retryAfter?: number }

/** Every page's status and words. A refusal never says which check failed (A4). */
export const PREVIEW_PAGES: Readonly<Record<PreviewPageKind, PageText>> = {
  not_found: { status: 404, title: 'This preview isn\'t available', body: 'The link may have ended, or it isn\'t shared with you. Ask whoever sent it for a new one.' },
  not_running: { status: 502, title: 'The app isn\'t running right now', body: 'Nothing is answering on this preview\'s port on the box. Try again once its owner has started it.' },
  port_refused: { status: 502, title: 'This port can\'t be shared any more', body: 'The box refused to share this port. Its owner can see why in the link\'s events.' },
  asleep: { status: 503, title: 'This preview is asleep', body: 'The box it runs on is stopped. Try again once its owner has started it.' },
  try_again: { status: 503, title: 'Try again in a moment', body: 'The box this preview runs on isn\'t ready yet.', retryAfter: 5 },
  busy: { status: 429, title: 'This preview is busy', body: 'Too many connections are open to this box right now. Try again in a moment.', retryAfter: 5 },
  refresh_needed: { status: 401, title: 'Your preview session needs refreshing', body: 'Go back and reload the page, then submit again.' },
  bad_request: { status: 400, title: 'Bad request', body: 'This request can\'t be sent to a preview.' },
  path_refused: { status: 403, title: 'This path isn\'t available through a preview link', body: 'Editor launches, files outside the project and debugger sockets are never shared.' },
  cross_site: { status: 403, title: 'Request refused', body: 'Changes to a preview can only come from the preview\'s own pages.' },
  too_large: { status: 413, title: 'Request too large', body: 'A preview takes request bodies of up to 100 MB.' },
  rate_limited: { status: 429, title: 'Slow down', body: 'Too many requests from your address. Try again in a moment.', retryAfter: 5 },
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function document(title: string, inner: string, head = ''): string {
  return pageDocument(title, inner, escapeHtml, head);
}

/** The headers every termag page carries, on the preview host and the main host alike. */
export function pageHeaders(extra: Record<string, string | number> = {}): Record<string, string | number> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': PAGE_CSP,
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex',
    ...extra,
  };
}

export function renderPage(kind: PreviewPageKind): { status: number; headers: Record<string, string | number>; html: string } {
  const p = PREVIEW_PAGES[kind];
  const html = document(p.title, `<h1>${escapeHtml(p.title)}</h1><p>${escapeHtml(p.body)}</p>`);
  return {
    status: p.status,
    headers: pageHeaders({ 'content-length': Buffer.byteLength(html), ...(p.retryAfter ? { 'retry-after': p.retryAfter } : {}) }),
    html,
  };
}

/** Answer with a termag page, unless the response has already started. HEAD gets the headers alone. */
export function sendPage(res: ServerResponse, kind: PreviewPageKind, method?: string): void {
  if (res.headersSent) { res.destroy(); return; }
  const page = renderPage(kind);
  res.writeHead(page.status, page.headers);
  res.end(method === 'HEAD' ? undefined : page.html);
}

/**
 * The landing page's hand-off (step 4): who runs the app, then a refresh to
 * the preview host's code exchange. No script: a meta refresh, and a link
 * for a browser that doesn't follow one.
 */
export function renderHandoff(ownerName: string, target: string): string {
  const owner = escapeHtml(ownerName);
  const url = escapeHtml(target);
  return document(
    `Opening ${ownerName}'s preview`,
    `<h1>You're opening an app running on ${owner}'s box</h1>`
      + '<p>It runs as they set it up, with their data. termag never asks you to sign in on a preview\'s page.</p>'
      + `<p><a class="continue" href="${url}">Continue</a></p>`,
    `<meta http-equiv="refresh" content="1;url=${url}">`,
  );
}

/** The landing page when the preview can't be opened (A4), or previews are off. */
export function renderLandingRefusal(kind: 'not_found' | 'asleep' | 'off'): { status: number; html: string } {
  if (kind === 'off') return { status: 404, html: document('Previews are off', '<h1>Previews are off</h1><p>Preview links aren\'t turned on here.</p>') };
  const p = PREVIEW_PAGES[kind];
  return { status: p.status, html: document(p.title, `<h1>${escapeHtml(p.title)}</h1><p>${escapeHtml(p.body)}</p>`) };
}
