/**
 * The confirm page for a preview link change asked for from a box
 * (services/previewLinkConfirmations.ts):
 *
 *   GET  /termag/previews/confirm/:id   what was asked, with Publish and Decline
 *   POST /termag/previews/confirm/:id   decision=publish|decline, csrf
 *
 * Server-rendered like the landing page, on the main host behind the termag
 * session (Okta at the ALB, then the session bridge): an agent on the box
 * that asked holds the sign-in's token, never this session. No script; the
 * same strict CSP as the preview pages, `X-Frame-Options: DENY` (it is a
 * one-click grant, so it must never be framed), `Referrer-Policy: no-referrer`
 * (the URL is the request's secret). Only the person who asked sees it; anyone
 * else, an unknown id and a used one get the same not-found page.
 *
 * Mounted ahead of the preview landing (`/termag/previews/:name`), so
 * `confirm` never reaches it as a name; `confirm` is a reserved name too
 * (services/previewLinkRules.ts).
 */
import express, { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../middleware/errors';
import { rateLimit } from '../middleware/rateLimit';
import {
  confirmPageFor, decideConfirmationFor, defaultConfirmationDeps, type ConfirmationDeps, type ConfirmPageView,
} from '../services/previewLinkConfirmations';
import { pageDocument } from '../previewPages/style';

export interface ConfirmRouteDeps {
  confirm: ConfirmationDeps;
  userOf(req: Request): { id: string; googleEmail: string } | null;
  /** Where to send someone not signed in (a login URL that brings them back), or null for a 401 page. */
  signIn?(req: Request): Promise<string | null>;
}

/** The Share dialog's warning for a wider audience (frontend/src/previewLinks/PublishPreviewLink.tsx, LINK_WARNING). */
export const WIDER_WARNING = "Anyone you send this to can use the app as you've set it up, including its data.";

const AUDIENCE_TEXT: Record<string, string> = {
  owner: "you and the project's collaborators",
  people: "the people named, you and the project's collaborators",
  link: 'anyone signed in to termag who has the link',
};

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function send(res: Response, status: number, title: string, body: string): void {
  res.status(status)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
    .set('X-Frame-Options', 'DENY')
    .set('Referrer-Policy', 'no-referrer')
    .set('X-Content-Type-Options', 'nosniff')
    .set('Cache-Control', 'no-store')
    .send(pageDocument(title, body, esc));
}

/**
 * A redirect off this page, with the page's own headers: the URL holds the
 * id, so the next request (the sign-in, or the page again) must not carry it
 * as its Referer, nor any cache keep it.
 */
function redirect(res: Response, status: 302 | 303, to: string): void {
  res.set('Referrer-Policy', 'no-referrer').set('Cache-Control', 'no-store').redirect(status, to);
}

const NOT_FOUND = '<h1>Not found</h1><p>This confirmation doesn\'t exist, isn\'t yours, or was already used.</p>';

export function confirmPageBody(v: ConfirmPageView, action: string): string {
  const who = v.audience === 'people' && v.emails.length
    ? `${esc(AUDIENCE_TEXT.people)}: ${v.emails.map(e => `<code>${esc(e)}</code>`).join(', ')}`
    : esc(AUDIENCE_TEXT[v.audience] ?? v.audience);
  const what = v.kind === 'extend' ? 'Extend a preview link' : 'Publish a preview link';
  const facts = [
    ['Project', esc(v.projectName)],
    ...(v.workstream ? [['Workstream', esc(v.workstream)]] : []),
    ['Box', esc(v.boxName ?? '-')],
    ...(v.port !== null ? [['Port', esc(v.port)]] : []),
    ...(v.name ? [['Name', `<code>${esc(v.name)}</code>`]] : []),
    ['Who can open it', who],
    ['Lifetime', v.ttlHours ? `${esc(v.ttlHours)} hours` : 'the default'],
    ['Asked from', `a sign-in made on the box <code>${esc(v.fromBoxName ?? 'unknown')}</code>`],
  ].map(([k, d]) => `<dt>${k}</dt><dd>${d}</dd>`).join('');
  if (v.state === 'pending') {
    return `<h1>${what}?</h1>`
      + '<p class="warn">This was asked from a box. Anything running there, an agent included, can ask in your name, so it waits for you. Publish only if you asked for it.</p>'
      + `<dl>${facts}</dl>`
      + (v.audience !== 'owner' ? `<p class="warn">${esc(WIDER_WARNING)}</p>` : '')
      + '<div class="actions">'
      + `<form method="post" action="${esc(action)}"><input type="hidden" name="csrf" value="${esc(v.csrf)}"><input type="hidden" name="decision" value="publish"><button type="submit" class="primary">Publish</button></form>`
      + `<form method="post" action="${esc(action)}"><input type="hidden" name="csrf" value="${esc(v.csrf)}"><input type="hidden" name="decision" value="decline"><button type="submit">Decline</button></form>`
      + '</div>'
      + `<p class="fine">This request expires at ${esc(v.expiresAt.toISOString().slice(0, 16).replace('T', ' '))} UTC.</p>`;
  }
  const outcome: Record<string, string> = {
    confirmed: `<h1>Published</h1><p>Done. The terminal that asked shows the link.${v.shareUrl ? ` Share this link (shown once): <code>${esc(v.shareUrl)}</code>` : ''}</p>`,
    applying: '<h1>Publishing…</h1><p>Reload in a moment.</p>',
    declined: '<h1>Declined</h1><p>Nothing was published.</p>',
    expired: '<h1>Expired</h1><p>This request is more than 10 minutes old, so nothing was published. Ask again from the terminal.</p>',
    failed: `<h1>Not published</h1><p>${esc(v.failure ?? 'The publish was refused.')}</p>`,
    interrupted: `<h1>Not published</h1><p>${esc(v.failure ?? 'The publish was interrupted.')}</p>`,
  };
  return `${outcome[v.state] ?? NOT_FOUND}<dl>${facts}</dl>`;
}

export function previewLinkConfirmRouter(basePath: string, deps: ConfirmRouteDeps = { confirm: defaultConfirmationDeps, userOf: req => req.user ?? null }): Router {
  const router = Router();
  router.use(rateLimit({ capacity: 30, perMinute: 30, keyOf: req => deps.userOf(req)?.id ?? req.ip ?? 'anon' }));
  router.use(express.urlencoded({ extended: false, limit: '4kb' }));

  const signedIn = async (req: Request, res: Response) => {
    const user = deps.userOf(req);
    if (user) return user;
    const to = deps.signIn ? await deps.signIn(req) : null;
    if (to) redirect(res, 302, to);
    else send(res, 401, 'Sign in', '<h1>Sign in to termag</h1><p>Sign in, then open this link again.</p>');
    return null;
  };

  router.get('/:id', asyncHandler(async (req, res) => {
    const user = await signedIn(req, res);
    if (!user) return;
    const view = await confirmPageFor(deps.confirm, user.id, req.params.id);
    if (!view) { send(res, 404, 'Not found', NOT_FOUND); return; }
    send(res, 200, 'Confirm a preview link', confirmPageBody(view, `${basePath}/previews/confirm/${req.params.id}`));
  }));

  router.post('/:id', asyncHandler(async (req, res) => {
    const user = await signedIn(req, res);
    if (!user) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const out = await decideConfirmationFor(deps.confirm, user, req.params.id, body.decision, body.csrf);
    if (!out.ok && out.status === 404) { send(res, 404, 'Not found', NOT_FOUND); return; }
    if (!out.ok && out.reason === 'csrf') { send(res, 403, 'Refused', '<h1>Refused</h1><p>This form is stale. Open the link again from the terminal.</p>'); return; }
    // Post/redirect/get: the page shows where it ended up.
    redirect(res, 303, `${basePath}/previews/confirm/${req.params.id}`);
  }));
  return router;
}
