/**
 * The preview links' landing page on the main host,
 * server-rendered:
 *
 *   GET /previews/:name[/:token][?next=]   who may open it, then a one-time code and the hand-off
 *   GET /previews/:name/reverify?ticket=   the hourly re-check a preview host sends a navigation through
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
import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../middleware/errors';
import { takeToken, type Bucket } from '../middleware/rateLimit';
import { decide, basisHolds, isAccessBasis } from '../services/previewLinkAccess';
import { LINK_TOKEN_RE, PREVIEW_NAME_RE, previewHostLabel } from '../services/previewLinkRules';
import { CODE_TTL_MS, codeHash, newSecret, safeNext } from '../services/previewHostRules';
import type { PreviewHostDeps } from '../services/previewHost';
import { accessAudienceOf, served, type HostLinkContext } from '../services/previewHostStore';
import { pageHeaders, renderHandoff, renderLandingRefusal } from '../previewPages';
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
    // A ticket is one session's, redeemed only by that session's termag user (SR10).
    if (!ticket || !ticket.sessionIdHash) return refuse(res, ctx, name, who, 'no_ticket', 'reverify');
    if (!ctx || ctx.link.id !== ticket.linkId) return refuse(res, ctx, name, who, 'wrong_host', 'reverify');
    if (ticket.userId !== who.id) return refuse(res, ctx, name, who, 'other_user', 'reverify');
    if (!deps.allowed(who.googleEmail)) return refuse(res, ctx, name, who, 'termag_access', 'reverify');
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
    res.redirect(302, handoffUrl(ctx.link, domain, code));
  }));

  const open = asyncHandler(async (req: Request, res: Response) => {
    // The token never leaves in a Referer (SR11), and nothing here is cached.
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
    const who = await viewer(req, res);
    if (!who) return;
    const name = req.params.name;
    const token = (req.params as { token?: string }).token ?? null;
    const domain = deps.domain();
    if (!domain || !deps.cookieSecret()) { page(res, 'off'); return; }
    if (!PREVIEW_NAME_RE.test(name) || (token !== null && !LINK_TOKEN_RE.test(token))) { page(res, 'not_found'); return; }
    const ctx = served(await deps.store.resolveName(name));
    if (!ctx) return refuse(res, null, name, who, 'no_link', 'landing');
    if (!deps.allowed(who.googleEmail)) return refuse(res, ctx, name, who, 'termag_access', 'landing');
    const t = now();
    const [facts, flags] = await Promise.all([deps.store.viewer(ctx.link, who.id, t), deps.flags(ctx.project.owner, ctx.project.instance)]);
    const decision = decide(accessAudienceOf(ctx.link), ctx.link, { isProjectOwner: ctx.project.userId === who.id, ...facts }, token, flags, t);
    if (!decision.ok) return refuse(res, ctx, name, who, decision.reason, 'landing');
    // Asleep: wake from here is phase 3 (preview-links-wake-enabled, PR 6).
    const status = ctx.project.instanceId ? await deps.boxStatus(ctx.project.instanceId) : null;
    if (status && PARKED.has(status)) { page(res, 'asleep'); return; }

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
  return router;
}
