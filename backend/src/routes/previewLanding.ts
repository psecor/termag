/**
 * The preview links' landing page on the main host,
 * server-rendered:
 *
 *   GET /previews/:name[/:token][?next=]   who may open it, then a one-time code and the hand-off
 *   GET /previews/:name/reverify?ticket=   the hourly re-check a preview host sends a navigation through,
 *                                          or a rebound: a used code's way back to a fresh one (no session yet)
 *
 * Mounted like any termag page, after the session middleware and
 * albSessionBridge: only a termag user reaches it (A2). In okta mode the
 * bridge has verified `x-amzn-oidc-data` and ALLOWED_USERS and answered 403
 * to anyone else; in google and oidc mode someone not signed in goes through
 * termag's sign-in and comes back. A missing, ended or expired link, an
 * unauthorized or removed viewer, and previews being off for the link's
 * owner all get the same 404 (A4); the audit line says which.
 *
 * Minimal on purpose: PR 3 gives it termag's look.
 */
import express, { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { asyncHandler } from '../middleware/errors';
import { takeToken, type Bucket } from '../middleware/rateLimit';
import { decide, basisHolds, isAccessBasis } from '../services/previewLinkAccess';
import { LINK_TOKEN_RE, PREVIEW_NAME_RE, previewHostLabel } from '../services/previewLinkRules';
import { CODE_TTL_MS, codeHash, newSecret, safeNext } from '../services/previewHostRules';
import type { PreviewHostDeps } from '../services/previewHost';
import { accessAudienceOf, served, type HostLinkContext } from '../services/previewHostStore';
import { pageHeaders, renderAsleep, renderHandoff, renderLandingRefusal, renderWaking } from '../previewPages';
import { defaultLinkWakeDeps, LINK_WAKE_MESSAGES, linkWakeRefusal, wakeLinkBox, type LinkWakeDeps } from '../services/previewLinkWake';
import { audit, linkOpened, linkRefused } from '../services/previewLinkTelemetry';

const PARKED = new Set(['stopping', 'stopped', 'starting', 'hibernating', 'hibernated']);
const PER_USER_CAPACITY = 30;
const PER_USER_PER_SEC = 1;

export interface PreviewLandingDeps extends Pick<PreviewHostDeps, 'store' | 'domain' | 'cookieSecret' | 'flags' | 'allowed' | 'now' | 'random'> {
  /** The signed-in termag user, or null. */
  user(req: Request): { id: string; googleEmail: string } | null;
  /** Where to send someone not signed in (google and oidc mode), with the way back stashed; null: a 401 page. */
  signIn?(req: Request): Promise<string | null>;
  /**
   * Whether the viewer's termag sign-in is recent enough to open a preview
   * (google and oidc mode: from the last 12 hours, auth/signInAge.ts; SR18).
   * Unset (okta mode, where the ALB's Okta action re-checks): any sign-in is.
   * A stale one goes back through signIn, as someone not signed in does.
   */
  signInFresh?(req: Request): boolean;
  boxStatus(boxId: string): Promise<string | null>;
  /** Waking a parked box (row 6b, services/previewLinkWake.ts); unset: the real one. */
  wake?: LinkWakeDeps;
}

function page(res: Response, kind: 'not_found' | 'asleep' | 'off'): void {
  const p = renderLandingRefusal(kind);
  res.status(p.status).set(pageHeaders()).send(p.html);
}

export function previewLandingRouter(deps: PreviewLandingDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const buckets = new Map<string, Bucket>();

  /** The signed-in viewer, or the response already sent (sign-in, 401, 429). */
  async function viewer(req: Request, res: Response): Promise<{ id: string; googleEmail: string } | null> {
    const user = deps.user(req);
    if (!user || (deps.signInFresh && !deps.signInFresh(req))) {
      const to = deps.signIn ? await deps.signIn(req) : null;
      if (to) res.redirect(302, to);
      else res.status(401).set(pageHeaders()).send('<!doctype html><title>Sign in</title><p>Sign in to termag to open this preview.</p>');
      return null;
    }
    if (!takeToken(buckets, user.id, PER_USER_CAPACITY, PER_USER_PER_SEC, now().getTime())) {
      res.status(429).set(pageHeaders({ 'retry-after': 5 })).send('<!doctype html><title>Slow down</title><p>Too many previews opened. Try again in a moment.</p>');
      return null;
    }
    return user;
  }

  // The link's own host (SR19): only there is the code redeemed, so an earlier link's Service Worker
  // under this name, on that link's origin, never sees it.
  const handoffUrl = (link: { name: string; hostSuffix: string }, domain: string, code: string, next?: string) =>
    `https://${previewHostLabel(link.name, link.hostSuffix)}.${domain}/__termag/auth?code=${code}${next && next !== '/' ? `&next=${encodeURIComponent(next)}` : ''}`;

  function refuse(res: Response, ctx: HostLinkContext | null, name: string, who: { id: string; googleEmail: string }, reason: string, step: 'landing' | 'reverify'): void {
    audit({ step, decision: 'deny', reason, viewer: who.googleEmail, linkId: ctx?.link.id ?? null, name, boxId: ctx?.project.instanceId ?? null });
    linkRefused(who.id, ctx?.project.instanceId ?? null, { reason, step });
    if (ctx) void deps.store.addEvent({ link: ctx.link, kind: 'refused', actorId: who.id, reason }).catch(() => {});
    page(res, 'not_found');
  }

  // A HEAD (a prefetch, a link checker, a proxy) never mints a code or uses a ticket up: Express would
  // otherwise run the GET handlers for it, and the viewer's own GET would find nothing left.
  router.head(['/:name', '/:name/reverify', '/:name/:token'], (_req: Request, res: Response) => {
    res.status(204).set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').end();
  });
  // Ahead of /:name/:token: a token is 22 characters, so it is never `reverify`.
  router.get('/:name/reverify', asyncHandler(async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
    const who = await viewer(req, res);
    if (!who) return;
    const name = req.params.name;
    const domain = deps.domain();
    if (!domain || !deps.cookieSecret()) { page(res, 'off'); return; }
    if (!PREVIEW_NAME_RE.test(name)) { page(res, 'not_found'); return; }
    const hash = codeHash('ticket', String(req.query.ticket ?? ''));
    const t = now();
    const ticket = hash ? await deps.store.takeCode(hash, t) : null;
    const ctx = served(await deps.store.resolveName(name));
    // A ticket is one session's or one code's, redeemed only by its termag user (SR10).
    if (!ticket) return refuse(res, ctx, name, who, 'no_ticket', 'reverify');
    if (!ctx || ctx.link.id !== ticket.linkId) return refuse(res, ctx, name, who, 'wrong_host', 'reverify');
    if (ticket.userId !== who.id) return refuse(res, ctx, name, who, 'other_user', 'reverify');
    if (!deps.allowed(who.googleEmail)) return refuse(res, ctx, name, who, 'termag_access', 'reverify');
    if (!ticket.sessionIdHash) {
      // A rebound: the browser lost the session a code of this viewer's made seconds ago. The basis that code
      // was granted on, a link token's hash included, must still hold; then a fresh code, as the landing gives.
      if (!isAccessBasis(ticket.basis)) return refuse(res, ctx, name, who, 'bad_basis', 'reverify');
      const [facts, flags] = await Promise.all([deps.store.viewer(ctx.link, who.id, t), deps.flags(ctx.project.owner, ctx.project.instance)]);
      const held = basisHolds(ticket.basis, ticket.tokenHash, accessAudienceOf(ctx.link), ctx.link, { isProjectOwner: ctx.project.userId === who.id, ...facts }, flags, t);
      if (!held.ok) return refuse(res, ctx, name, who, held.reason, 'reverify');
      const code = newSecret(deps.random);
      await deps.store.createCode({
        codeHash: codeHash('code', code)!, linkId: ctx.link.id, userId: who.id, basis: ticket.basis, tokenHash: ticket.tokenHash,
        sessionIdHash: null, next: safeNext(ticket.next), expiresAt: new Date(t.getTime() + CODE_TTL_MS),
      });
      audit({ step: 'reverify', decision: 'grant', reason: `rebound:${ticket.basis}`, viewer: who.googleEmail, linkId: ctx.link.id, name, boxId: ctx.project.instanceId });
      res.redirect(302, handoffUrl(ctx.link, domain, code, safeNext(ticket.next)));
      return;
    }
    const session = await deps.store.findSession(ticket.sessionIdHash);
    if (!session || session.revokedAt || session.expiresAt.getTime() <= t.getTime() || session.userId !== who.id || session.linkId !== ctx.link.id) {
      return refuse(res, ctx, name, who, 'session_gone', 'reverify');
    }
    if (!isAccessBasis(session.basis)) return refuse(res, ctx, name, who, 'bad_basis', 'reverify');
    // For a token session that means the link's token is still the one it proved: never asked for again.
    const [facts, flags] = await Promise.all([deps.store.viewer(ctx.link, who.id, t), deps.flags(ctx.project.owner, ctx.project.instance)]);
    const held = basisHolds(session.basis, session.tokenHash, accessAudienceOf(ctx.link), ctx.link, { isProjectOwner: ctx.project.userId === who.id, ...facts }, flags, t);
    if (!held.ok) return refuse(res, ctx, name, who, held.reason, 'reverify');
    const code = newSecret(deps.random);
    await deps.store.createCode({
      codeHash: codeHash('code', code)!, linkId: ctx.link.id, userId: who.id, basis: session.basis, tokenHash: session.tokenHash,
      sessionIdHash: session.idHash, next: safeNext(ticket.next), expiresAt: new Date(t.getTime() + CODE_TTL_MS),
    });
    audit({ step: 'reverify', decision: 'grant', reason: session.basis, viewer: who.googleEmail, linkId: ctx.link.id, name, boxId: ctx.project.instanceId });
    // `next` in the URL as well as the code: a repeat of this URL from a browser that holds the session goes
    // there, and the used code can't say where it was headed any more (Devin, #1742).
    res.redirect(302, handoffUrl(ctx.link, domain, code, safeNext(ticket.next)));
  }));

  const wakeDeps = deps.wake ?? defaultLinkWakeDeps;
  /** The wake form's CSRF token: this viewer, this link, this server (SameSite cookies are the first line). */
  const wakeCsrf = (userId: string, linkId: string) => createHmac('sha256', String(deps.cookieSecret())).update(`preview-wake:${userId}:${linkId}`).digest('base64url');
  const wakeCsrfOk = (userId: string, linkId: string, token: unknown) => {
    const want = Buffer.from(wakeCsrf(userId, linkId));
    const got = Buffer.from(typeof token === 'string' ? token : '');
    return got.length === want.length && timingSafeEqual(got, want);
  };
  /** The landing URL a wake form posts to and the waking page refreshes to: the path the viewer opened, `next` kept. */
  const landingPath = (req: Request) => `${req.baseUrl}${req.path}${typeof req.query.next === 'string' ? `?next=${encodeURIComponent(req.query.next)}` : ''}`;

  /**
   * Who may open it, as the landing decides: the context and the decision, or
   * the refusal already sent (the same 404 for every reason, A4). A wake goes
   * through this first, so a viewer without access never wakes a box.
   */
  async function admitted(req: Request, res: Response, who: { id: string; googleEmail: string }) {
    const name = req.params.name;
    const token = (req.params as { token?: string }).token ?? null;
    const domain = deps.domain();
    if (!domain || !deps.cookieSecret()) { page(res, 'off'); return null; }
    if (!PREVIEW_NAME_RE.test(name) || (token !== null && !LINK_TOKEN_RE.test(token))) { page(res, 'not_found'); return null; }
    const ctx = served(await deps.store.resolveName(name));
    if (!ctx) { refuse(res, null, name, who, 'no_link', 'landing'); return null; }
    if (!deps.allowed(who.googleEmail)) { refuse(res, ctx, name, who, 'termag_access', 'landing'); return null; }
    const t = now();
    const [facts, flags] = await Promise.all([deps.store.viewer(ctx.link, who.id, t), deps.flags(ctx.project.owner, ctx.project.instance)]);
    const decision = decide(accessAudienceOf(ctx.link), ctx.link, { isProjectOwner: ctx.project.userId === who.id, ...facts }, token, flags, t);
    if (!decision.ok) { refuse(res, ctx, name, who, decision.reason, 'landing'); return null; }
    return { ctx, decision, domain, name, t };
  }

  /** A parked box's page: waking (it's starting), "Wake it" where this viewer may, else asleep and why. */
  async function asleep(req: Request, res: Response, ctx: HostLinkContext, who: { id: string; googleEmail: string }, status: string): Promise<void> {
    const ownerName = ctx.project.owner.displayName || ctx.project.owner.googleEmail;
    if (status === 'starting') { const p = renderWaking(ownerName, landingPath(req)); res.status(p.status).set(p.headers).send(p.html); return; }
    // Asked first, so a box still going down promises nothing to a viewer who could never wake it: its owner, or
    // the wake flag off (Bugbot, #1570).
    const refusal = await linkWakeRefusal(wakeDeps, ctx, who.id);
    // Still going down: look again until it has stopped; whether this stop may be undone is known only then.
    if (refusal === null && (status === 'stopping' || status === 'hibernating')) { const p = renderWaking(ownerName, landingPath(req), 'settling'); res.status(p.status).set(p.headers).send(p.html); return; }
    const p = renderAsleep({
      ownerName,
      wake: refusal === null ? { action: landingPath(req), csrf: wakeCsrf(who.id, ctx.link.id) } : null,
      message: refusal === null ? null : LINK_WAKE_MESSAGES[refusal],
    });
    res.status(p.status).set(p.headers).send(p.html);
  }

  const open = asyncHandler(async (req: Request, res: Response) => {
    // The token never leaves in a Referer (SR11), and nothing here is cached.
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
    const who = await viewer(req, res);
    if (!who) return;
    const a = await admitted(req, res, who);
    if (!a) return;
    const { ctx, decision, domain, name, t } = a;
    // Asleep (U4): woken from here where the viewer may (row 6b).
    const status = ctx.project.instanceId ? await deps.boxStatus(ctx.project.instanceId) : null;
    if (status && PARKED.has(status)) { await asleep(req, res, ctx, who, status); return; }

    const code = newSecret(deps.random);
    await deps.store.createCode({
      codeHash: codeHash('code', code)!, linkId: ctx.link.id, userId: who.id, basis: decision.basis, tokenHash: decision.tokenHash,
      sessionIdHash: null, next: safeNext(req.query.next), expiresAt: new Date(t.getTime() + CODE_TTL_MS),
    });
    // After the code: an open that failed to hand one out isn't one, so the next try still gets the first-open page.
    const { firstOpen } = await deps.store.opened(ctx.link.audienceId, who.id, t);
    await deps.store.addEvent({ link: ctx.link, kind: 'opened', actorId: who.id, detail: { basis: decision.basis } });
    audit({ step: 'landing', decision: 'grant', reason: decision.basis, viewer: who.googleEmail, linkId: ctx.link.id, name, boxId: ctx.project.instanceId });
    linkOpened(who.id, ctx.project.instanceId, { basis: decision.basis, firstOpen, audience: ctx.link.audience });
    const target = handoffUrl(ctx.link, domain, code, safeNext(req.query.next));
    // Shown each time for a link audience, whose URL anyone may have sent; else only on first open (SR15).
    if (ctx.link.audience === 'link' || firstOpen) {
      res.status(200).set(pageHeaders()).send(renderHandoff(ctx.project.owner.displayName || ctx.project.owner.googleEmail, target));
      return;
    }
    res.redirect(302, target);
  });
  router.get('/:name', open);
  router.get('/:name/:token', open);

  // "Wake it" (row 6b): the same access decision as opening, then the wake, then back to the landing,
  // which shows the waking page until the box is up and then hands off as usual.
  const wake = asyncHandler(async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
    const who = await viewer(req, res);
    if (!who) return;
    const a = await admitted(req, res, who);
    if (!a) return;
    if (!wakeCsrfOk(who.id, a.ctx.link.id, (req.body as { csrf?: unknown } | undefined)?.csrf)) {
      res.status(403).set(pageHeaders()).send('<!doctype html><title>Refused</title><p>This page is out of date. Go back, reload it and try again.</p>');
      return;
    }
    const result = await wakeLinkBox(wakeDeps, { link: a.ctx.link, project: a.ctx.project }, who);
    audit({ step: 'landing', decision: result.ok ? 'grant' : 'deny', reason: result.ok ? 'woke' : `wake_${result.reason}`, viewer: who.googleEmail, linkId: a.ctx.link.id, name: a.name, boxId: a.ctx.project.instanceId });
    if (result.ok) { res.redirect(303, landingPath(req)); return; }
    const p = renderAsleep({ ownerName: a.ctx.project.owner.displayName || a.ctx.project.owner.googleEmail, wake: null, message: result.message });
    res.status(p.status).set(p.headers).send(p.html);
  });
  const form = express.urlencoded({ extended: false, limit: '2kb' });
  router.post('/:name', form, wake);
  router.post('/:name/:token', form, wake);
  return router;
}
