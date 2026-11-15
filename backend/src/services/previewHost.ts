/**
 * The preview host:
 * every request and upgrade nginx's
 * preview server block hands the backend, for `<name>.<PREVIEW_LINKS_DOMAIN>`.
 *
 * `previewHostDispatch` is index.ts's first middleware, ahead of the request
 * surface, CORS, the body parsers, sessions and albSessionBridge, and the
 * upgrade handler's first check. For a preview host it **never calls
 * `next()`** (SR3): a preview's `/termag/api/…` is the app's path, never
 * termag's, and a host in the preview domain that nginx didn't vouch for is a
 * bare 404. A test mounts a sentinel route after it (previewHost.test.ts).
 *
 * On a preview host:
 *
 *   /__termag/auth?code=   the code exchange: a session and its cookie, then a 302 to `next`
 *   /__termag/clean?next=  a first open's clear (SR19), on its own cookie-free step, then a 302 to `next`
 *   /__termag/*            nothing else: termag's pages are answers, never relayed
 *   anything else          the session check, then the relay (services/previewRelay.ts)
 *
 * Before a session there are only two answers, both rate-limited per address
 * and both constant work, one database read at most (SR4): the exchange, and
 * the redirect to the landing page on the main host. Identity here is the
 * preview session alone; no `x-amzn-oidc-*` header is ever read (SR17).
 *
 * The session check (`verify`) runs per request through a 30 s in-process
 * cache (L3): the cookie's HMAC, the row, the link this host serves, the
 * flags for the project's owner and box (`preview-links-enabled` on and the
 * kill switch off), the basis the viewer was let in on, and termag access
 * (A2: the user still exists and ALLOWED_USERS still has them). A basis or
 * access that no longer holds revokes the session. Once the last landing
 * check is an hour old, a navigation goes back through it (the reverify
 * round trip); past two hours nothing else is served.
 */
import type { NextFunction, Request, Response } from 'express';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import type { Duplex } from 'stream';
import type { Instance, User } from '@prisma/client';
import { basisHolds, isAccessBasis, type AccessBasis } from './previewLinkAccess';
import { PREVIEW_LINK_CAPABILITY } from './previewLinkFlags';
import { isLive, previewHostLabel } from './previewLinkRules';
import {
  classifyHost, cleanNextSig, cleanNextValid, CODE_TTL_MS, codeHash, cookieSecretFrom, crossSiteRefusal, framingRefusal, sameSiteRefusal, isNavigation, newSecret, pathOf,
  PREVIEW_BODY_LIMIT, previewOrigin, reverifyState, safeNext, sessionCookieValue, sessionExpiry, sessionIdHash, sessionSetCookie,
  signSessionCookie, linkMarkerSetCookie, markerNamesLink, targetRefusal, TERMAG_PREFIX, verifySessionCookie, viewerIp, type HostVerdict,
} from './previewHostRules';
import { pathRefusal } from './devServerPaths';
import { accessAudienceOf, served, type CodeRow, type HostLinkContext, type HostUser, type PreviewHostStore, type SessionRow } from './previewHostStore';
import { PreviewRelay, rawStatus, type PreviewTunnels, type RelayContext } from './previewRelay';
import { sendPage } from '../previewPages';
import { takeToken, type Bucket } from '../middleware/rateLimit';
import { audit, handoffBounced, linkRefused, refused } from './previewLinkTelemetry';
import { endUpgrade } from '../routes/cliT3';
import type { WebSocket, WebSocketServer } from 'ws';

/** How long a session check is trusted in this process (L3). */
export const SESSION_CACHE_MS = 30_000;
/**
 * What a first open clears (SR19): storage, Service Workers included, never cookies. Not "cache": each link
 * has its own origin, so a new link's has no HTTP cache to clear, and Chrome's cache clear is the slow part
 * that held the first navigation for seconds (decided 2026-11-12).
 */
export const CLEAR_SITE_DATA = '"storage"';
/** Pre-auth answers per address: a burst, then two a second. */
const PREAUTH_CAPACITY = 60;
const PREAUTH_PER_SEC = 2;
const PARKED = new Set(['stopping', 'stopped', 'starting', 'hibernating', 'hibernated']);
const CLEAN_PATH = `${TERMAG_PREFIX}clean`;

export interface PreviewHostDeps {
  store: PreviewHostStore;
  /** PREVIEW_LINKS_DOMAIN; null: no preview host serves anything. */
  domain(): string | null;
  /** PREVIEW_LINKS_COOKIE_SECRET as a key; null: no preview host serves anything. */
  cookieSecret(): Buffer | null;
  /** The landing page's base: FRONTEND_URL + BASE_PATH. */
  siteBase(): string;
  /** `preview-links-enabled` and the kill switch, for the project's owner and box. */
  flags(owner: User, box: Instance | null): Promise<{ enabled: boolean; killSwitch: boolean }>;
  /** ALLOWED_USERS still lets this email in (A2). */
  allowed(email: string): boolean;
  tunnels: PreviewTunnels;
  box: {
    /** Instance.status. */
    status(boxId: string): Promise<string | null>;
    connected(boxId: string): boolean;
    capabilities(boxId: string): string[];
  };
  /** The workstream checkout the link was made for: the only place `/@fs/` may read (SR9). */
  checkoutDir(ctx: HostLinkContext): string;
  /**
   * Every request relayed to a live link, for the owner's box's idle clock:
   * previewLinkActivity.notePreviewViewerActivity, which counts only a viewer's
   * input (a navigation, a user-activated request), as preview shares count a
   * guest's. WebSocket messages and an open tunnel never count.
   */
  noteActivity?: (boxId: string, headers: IncomingHttpHeaders) => void;
  /** False while this process drains: 503, try again. */
  isServing(): boolean;
  /** A noServer WebSocketServer built with previewRelayServerOptions(). */
  wss: WebSocketServer;
  heartbeat?: (ws: WebSocket) => void;
  now?: () => Date;
  random?: (n: number) => Buffer;
  cacheMs?: number;
  recheckMs?: number;
  poolIdleMs?: number;
}

/** A session the check let through, and what serving it needs. */
export interface VerifiedSession {
  session: SessionRow;
  ctx: HostLinkContext;
  user: HostUser;
}

export type Verdict =
  | { kind: 'ok'; v: VerifiedSession }
  /** No cookie, a bad HMAC, no such session, or one that ended: sign in again through the landing page. */
  | { kind: 'none' }
  /** A session that no longer holds: the not-found page (A4). */
  | { kind: 'refused'; reason: string };

interface Cached { at: number; v: VerifiedSession }

export interface PreviewHost {
  /** Express middleware: the first one. On a preview host it never calls next(). */
  dispatch(req: Request, res: Response, next: NextFunction): void;
  /** The upgrade handler's first check: true when it took the upgrade (preview host, or refused). */
  dispatchUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  handle(req: IncomingMessage, res: ServerResponse, name: string, suffix: string | null): Promise<void>;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, name: string, suffix: string | null): Promise<void>;
  verify(name: string, suffix: string | null, cookie: string | null, opts?: { fresh?: boolean }): Promise<Verdict>;
  /** Sessions revoked in this process: drop them from the cache, close their sockets and pools. */
  revoked(linkId: string, idHashes: readonly string[]): void;
  relay: PreviewRelay;
  closeAll(code: number, reason: string): void;
  stop(): void;
}

export function createPreviewHost(deps: PreviewHostDeps): PreviewHost {
  const now = deps.now ?? (() => new Date());
  const cacheMs = deps.cacheMs ?? SESSION_CACHE_MS;
  const recheckMs = deps.recheckMs ?? SESSION_CACHE_MS;
  const relay = new PreviewRelay({ tunnels: deps.tunnels, wss: deps.wss, heartbeat: deps.heartbeat, idleMs: deps.poolIdleMs, now: () => now().getTime() });
  const cache = new Map<string, Cached>();
  const buckets = new Map<string, Bucket>();
  const pruner = setInterval(() => {
    const t = now().getTime();
    for (const [k, c] of cache) if (t - c.at >= cacheMs) cache.delete(k);
    for (const [k, b] of buckets) if (t - b.updatedAt > 10 * 60_000) buckets.delete(k);
  }, 60_000);
  pruner.unref();

  const preauthAllowed = (req: IncomingMessage): boolean =>
    takeToken(buckets, viewerIp(req.headers, req.socket?.remoteAddress) ?? 'anon', PREAUTH_CAPACITY, PREAUTH_PER_SEC, now().getTime());

  const landing = (name: string, next: string): string =>
    `${deps.siteBase()}/previews/${name}${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`;

  const boxOf = (ctx: HostLinkContext) => ctx.project.instanceId;

  /** The viewer's standing on the link now, as basisHolds reads it. */
  async function standing(ctx: HostLinkContext, userId: string) {
    const facts = await deps.store.viewer(ctx.link, userId, now());
    return { isProjectOwner: ctx.project.userId === userId, ...facts };
  }

  async function holds(ctx: HostLinkContext, userId: string, basis: AccessBasis, tokenHash: string | null) {
    const [viewer, flags] = await Promise.all([standing(ctx, userId), deps.flags(ctx.project.owner, ctx.project.instance)]);
    return basisHolds(basis, tokenHash, accessAudienceOf(ctx.link), ctx.link, viewer, flags, now());
  }

  async function verify(name: string, suffix: string | null, cookie: string | null, opts: { fresh?: boolean } = {}): Promise<Verdict> {
    const secret = deps.cookieSecret();
    if (!secret || !cookie) return { kind: 'none' };
    const id = verifySessionCookie(secret, name, cookie);
    if (!id) return { kind: 'none' };
    const idHash = sessionIdHash(id);
    const t = now();
    const hit = cache.get(idHash);
    if (hit && !opts.fresh && t.getTime() - hit.at < cacheMs && hit.v.ctx.link.name === name && hit.v.ctx.link.hostSuffix === suffix) return { kind: 'ok', v: hit.v };
    cache.delete(idHash);
    const session = await deps.store.findSession(idHash);
    if (!session || session.revokedAt || session.expiresAt.getTime() <= t.getTime()) return { kind: 'none' };
    const ctx = served(await deps.store.resolveName(name));
    // The cookie is this host's (its HMAC names it), and the session must be for the link the name serves
    // now, on that link's own host: a bare name or another link's suffix is no session here (SR19).
    if (!ctx || ctx.link.id !== session.linkId || ctx.link.hostSuffix !== suffix) return { kind: 'none' };
    const user = await deps.store.user(session.userId);
    if (!user) return { kind: 'none' };
    const deny = async (reason: string, revoke: boolean): Promise<Verdict> => {
      if (revoke) {
        await deps.store.revokeSession(idHash, t);
        relay.dropSession(idHash);
      }
      audit({ step: 'session', decision: 'deny', reason, viewer: user.googleEmail, linkId: ctx.link.id, name, boxId: boxOf(ctx) });
      linkRefused(user.id, boxOf(ctx), { reason, step: 'session' });
      return { kind: 'refused', reason };
    };
    if (!deps.allowed(user.googleEmail)) return deny('termag_access', true);
    if (!isAccessBasis(session.basis)) return deny('bad_basis', true);
    const held = await holds(ctx, user.id, session.basis, session.tokenHash);
    if (!held.ok) {
      // The flags refuse without ending anything, so turning them back restores it.
      return deny(held.reason, held.reason === 'removed' || held.reason === 'no_access');
    }
    const v: VerifiedSession = { session, ctx, user };
    cache.set(idHash, { at: t.getTime(), v });
    return { kind: 'ok', v };
  }

  function relayContext(v: VerifiedSession, req: IncomingMessage, domain: string): RelayContext {
    const { ctx } = v;
    return {
      sessionIdHash: v.session.idHash,
      linkId: ctx.link.id,
      boxId: ctx.project.instanceId!,
      ownerId: ctx.link.ownerId,
      port: ctx.link.port,
      // Wider audiences run confined to the checkout on the box (SR9, PR 5); the agent refuses them until then.
      confine: ctx.link.audience === 'owner' ? null : { checkout: deps.checkoutDir(ctx) },
      target: { name: previewHostLabel(ctx.link.name, ctx.link.hostSuffix), domain, port: ctx.link.port, hostMode: ctx.link.hostMode, viewerIp: viewerIp(req.headers, req.socket?.remoteAddress) },
    };
  }

  /** Why the box can't take a tunnel now, as a page; null when it can. */
  async function boxRefusal(ctx: HostLinkContext): Promise<'asleep' | 'try_again' | null> {
    const boxId = ctx.project.instanceId;
    // A project without a box (the orchestrator's own host) has no preview tunnels.
    if (!boxId) return 'try_again';
    if (!deps.isServing()) return 'try_again';
    const status = await deps.box.status(boxId);
    if (status && PARKED.has(status)) return 'asleep';
    if (!deps.box.connected(boxId)) return 'try_again';
    if (!deps.box.capabilities(boxId).includes(PREVIEW_LINK_CAPABILITY)) return 'try_again';
    return null;
  }

  /**
   * No session: back through the landing page, for every well-formed name alike. Whether the name is a live
   * link the flags allow is the landing page's to say, after sign-in, with its one not-found page (A4):
   * answering it here, before any sign-in, would tell anyone which names are published.
   */
  function toLanding(req: IncomingMessage, res: ServerResponse, name: string): void {
    if (!preauthAllowed(req)) { refused('rate_limited'); sendPage(res, 'rate_limited', req.method); return; }
    redirect(res, landing(name, safeNext(req.url)));
  }

  function redirect(res: ServerResponse, to: string, cookie?: string | string[], extra: Record<string, string> = {}): void {
    res.writeHead(302, {
      location: to,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-length': 0,
      ...(cookie ? { 'set-cookie': cookie } : {}),
      ...extra,
    });
    res.end();
  }

  /**
   * Where a browser with a session goes: the app, once this browser was cleared for this link (its marker
   * says so); else the clear first (SR19).
   */
  const toApp = (req: IncomingMessage, name: string, linkId: string, sessionIdHash: string, next: string): string =>
    markerNamesLink(deps.cookieSecret()!, name, req.headers.cookie, linkId) ? next : cleanUrl(linkId, sessionIdHash, next);

  /**
   * The clean step, then `next`: a `next` other than the root is signed for this link and session, for a
   * minute (cleanNextSig). Mint one only for a destination termag chose or the viewer's own first-party
   * navigation asked for, never for a path from another site's link.
   */
  function cleanUrl(linkId: string, sessionIdHash: string, next: string): string {
    if (next === '/') return CLEAN_PATH;
    const exp = now().getTime() + CODE_TTL_MS;
    return `${CLEAN_PATH}?next=${encodeURIComponent(next)}&exp=${exp}&sig=${cleanNextSig(deps.cookieSecret()!, linkId, sessionIdHash, next, exp)}`;
  }

  /** Back through the main host's landing check with a one-time ticket: a reverify, or a rebound (spent). */
  async function ticketBack(res: ServerResponse, name: string, c: Pick<CodeRow, 'linkId' | 'userId' | 'basis' | 'tokenHash' | 'sessionIdHash' | 'next'>): Promise<void> {
    const ticket = newSecret(deps.random);
    await deps.store.createCode({
      codeHash: codeHash('ticket', ticket)!, linkId: c.linkId, userId: c.userId, basis: c.basis, tokenHash: c.tokenHash,
      sessionIdHash: c.sessionIdHash, next: safeNext(c.next), expiresAt: new Date(now().getTime() + CODE_TTL_MS),
    });
    redirect(res, `${deps.siteBase()}/previews/${name}/reverify?ticket=${ticket}`);
  }

  /**
   * A code that's used or gone, most often the hand-off page's second navigation to it (Continue, Back, a
   * repeated refresh). A browser that holds the session it made goes on to the app: sending it to the landing
   * page would mint another code and, for a link audience, show the hand-off page again, round and round (#1742,
   * bug cmwe2jg59). Else, in the code's minute, its rebound buys one ticket back
   * through the landing page, redeemed only by the same termag user: a link audience's landing URL without
   * its token lets no one in, so a plain bounce strands its viewer. The token itself never leaves the landing.
   */
  async function spent(req: IncomingMessage, res: ServerResponse, ctx: HostLinkContext, name: string, suffix: string | null, raw: string, nextParam: string | null): Promise<void> {
    const next = safeNext(nextParam);
    const hash = codeHash('rebound', raw);
    const rebound = hash ? await deps.store.takeCode(hash, now()) : null;
    const mine = rebound && rebound.linkId === ctx.link.id ? rebound : null;
    const held = await verify(name, suffix, sessionCookieValue(req.headers.cookie));
    // Where the code itself was headed, never the URL's `next`: any site can send a browser with a session here,
    // and a same-origin hop to a path it chose would reach the app as an in-app navigation, with the app's
    // SameSite=Strict cookies (Cursor Security). No rebound left (a stale bookmark, a made-up code): the app's root.
    if (held.kind === 'ok') { redirect(res, toApp(req, name, ctx.link.id, held.v.session.idHash, safeNext(mine?.next))); return; }
    // A used code back in its minute is a hand-off that went round again; a stale bookmark or an unknown
    // code is not, and isn't counted.
    if (mine) {
      handoffBounced({ viewer: (await deps.store.user(mine.userId))?.googleEmail ?? null, linkId: ctx.link.id, name, boxId: boxOf(ctx) });
      await ticketBack(res, name, mine);
      return;
    }
    redirect(res, landing(name, next));
  }

  /**
   * GET /__termag/clean?next=: a first open's clear (SR19), and the marker that says it was done, on a
   * response that carries no session cookie. Chrome holds a redirect with Clear-Site-Data until the clear
   * is done, seconds on a full profile, and stores none of its cookies if the navigation is dropped
   * meanwhile; the session's cookie came on the exchange's response before this one.
   */
  async function clean(req: IncomingMessage, res: ServerResponse, name: string, suffix: string | null): Promise<void> {
    if (!preauthAllowed(req)) { refused('rate_limited'); sendPage(res, 'rate_limited', req.method); return; }
    if (req.method === 'HEAD') { res.writeHead(204, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return; }
    if (req.method !== 'GET') { sendPage(res, 'bad_request', req.method); return; }
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const ctx = served(await deps.store.resolveName(name));
    if (!ctx || ctx.link.hostSuffix !== suffix) { redirect(res, landing(name, '/')); return; }
    // Only a browser with a session on this link: the exchange sends its new session here, and handle() a
    // session whose browser has no marker. Anyone else is sent through sign-in, as the app would send them.
    const v = await verify(name, suffix, sessionCookieValue(req.headers.cookie), { fresh: true });
    if (v.kind !== 'ok') { redirect(res, landing(name, '/')); return; }
    // Only a `next` termag signed for this link and session, in its minute; anything else is the app's root, so
    // another site can't use this same-origin 302 to land a viewer on a path it chose (Cursor Security).
    const asked = safeNext(q.get('next'));
    const next = asked !== '/' && cleanNextValid(deps.cookieSecret()!, ctx.link.id, v.v.session.idHash, asked, Number(q.get('exp')), q.get('sig') ?? '', now().getTime()) ? asked : '/';
    // A check for this step alone: the app's first request makes its own, as it did before this step.
    cache.delete(v.v.session.idHash);
    // Anyone can be sent here, so a browser already cleared for this link is never cleared again: a crafted
    // link can't wipe an established viewer's app data. One not yet cleared for it holds nothing of this link's.
    if (markerNamesLink(deps.cookieSecret()!, name, req.headers.cookie, ctx.link.id)) { redirect(res, next); return; }
    // Never "cookies": that would drop the session cookie and this marker.
    redirect(res, next, linkMarkerSetCookie(deps.cookieSecret()!, name, ctx.link.id), { 'clear-site-data': CLEAR_SITE_DATA });
  }

  /** GET /__termag/auth?code=: the landing page's code becomes a session (or refreshes one). */
  async function exchange(req: IncomingMessage, res: ServerResponse, name: string, suffix: string | null): Promise<void> {
    if (!preauthAllowed(req)) { refused('rate_limited'); sendPage(res, 'rate_limited', req.method); return; }
    // Only a GET uses the code up: a HEAD (a prefetch, a link checker, a proxy) must not burn it before the viewer's own GET.
    if (req.method === 'HEAD') { res.writeHead(204, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return; }
    if (req.method !== 'GET') { sendPage(res, 'bad_request', req.method); return; }
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const raw = q.get('code') ?? '';
    const hash = codeHash('code', raw);
    const t = now();
    // Only on the live link's own host is a code redeemed, so a Service Worker an earlier link's app left
    // under the name, on that link's origin, never gets one (SR19). Elsewhere it isn't used up: the landing
    // page sends the viewer to the right host.
    const ctx = served(await deps.store.resolveName(name));
    if (!ctx || ctx.link.hostSuffix !== suffix) { redirect(res, landing(name, safeNext(q.get('next')))); return; }
    // For the rest of its minute the code leaves a rebound (spent, above), in the same statement that takes it.
    const code = hash ? await deps.store.takeCode(hash, t, { rebound: codeHash('rebound', raw)! }) : null;
    if (!code) { refused('code_gone'); await spent(req, res, ctx, name, suffix, raw, q.get('next')); return; }
    const user = await deps.store.user(code.userId);
    const deny = (reason: string) => {
      audit({ step: 'exchange', decision: 'deny', reason, viewer: user?.googleEmail ?? null, linkId: code.linkId, name, boxId: ctx ? boxOf(ctx) : null });
      linkRefused(code.userId, ctx ? boxOf(ctx) : null, { reason, step: 'exchange' });
      sendPage(res, 'not_found', req.method);
    };
    // Bound to one name: a code for another link is nobody's here.
    if (!ctx || ctx.link.id !== code.linkId) return deny('wrong_host');
    if (!user || !deps.allowed(user.googleEmail)) return deny('termag_access');
    if (!isAccessBasis(code.basis)) return deny('bad_basis');
    // The link may have changed in the last 60 s.
    const held = await holds(ctx, user.id, code.basis, code.tokenHash);
    if (!held.ok) return deny(held.reason);
    const next = safeNext(code.next);
    if (code.sessionIdHash) {
      // A reverify: the session this code refreshes, not a new one.
      const s = await deps.store.findSession(code.sessionIdHash);
      if (!s || s.revokedAt || s.userId !== code.userId || s.linkId !== code.linkId || !(await deps.store.markVerified(s.idHash, t))) {
        redirect(res, landing(name, next));
        return;
      }
      cache.delete(s.idHash);
      audit({ step: 'exchange', decision: 'grant', reason: `reverify:${code.basis}`, viewer: user.googleEmail, linkId: ctx.link.id, name, boxId: boxOf(ctx) });
      redirect(res, next);
      return;
    }
    const id = newSecret(deps.random);
    const expiresAt = sessionExpiry(t, ctx.link.expiresAt);
    await deps.store.createSession({
      idHash: sessionIdHash(id), linkId: ctx.link.id, userId: user.id, basis: code.basis, tokenHash: code.tokenHash, verifiedAt: t, expiresAt, createdAt: t,
    });
    audit({ step: 'exchange', decision: 'grant', reason: code.basis, viewer: user.googleEmail, linkId: ctx.link.id, name, boxId: boxOf(ctx) });
    const value = signSessionCookie(deps.cookieSecret()!, name, id);
    // This browser's first session on this link: whatever an earlier link on this name left in it for
    // this origin (storage, a Service Worker, the HTTP cache) goes before the new app runs (SR19), on
    // the clean step after this response, never on it (clean, above). Decided per browser, from its
    // HttpOnly marker, so a code an old worker took and redeemed elsewhere never stops this browser's clear.
    redirect(res, toApp(req, name, ctx.link.id, sessionIdHash(id), next), sessionSetCookie(value, (expiresAt.getTime() - t.getTime()) / 1000));
  }

  /** Send a navigation back through the main host's landing check (A2), with a ticket bound to this session. */
  function reverify(res: ServerResponse, v: VerifiedSession, url: string): Promise<void> {
    return ticketBack(res, v.ctx.link.name, { linkId: v.ctx.link.id, userId: v.session.userId, basis: v.session.basis, tokenHash: v.session.tokenHash, sessionIdHash: v.session.idHash, next: url });
  }

  async function handle(req: IncomingMessage, res: ServerResponse, name: string, suffix: string | null): Promise<void> {
    // Express's own header; the app's response is the app's.
    res.removeHeader('x-powered-by');
    const domain = deps.domain();
    if (!domain || !deps.cookieSecret()) { sendPage(res, 'not_found', req.method); return; }
    if (targetRefusal(req.url) || framingRefusal(req.headers)) { refused('bad_request'); sendPage(res, 'bad_request', req.method); return; }
    // A sibling preview's fetch, iframe or preflight: never served, before any other work (SR13).
    if (sameSiteRefusal(req.headers)) { refused('same_site'); sendPage(res, 'cross_site', req.method); return; }
    const url = req.url!;
    const path = pathOf(url);
    if (path.toLowerCase().startsWith(TERMAG_PREFIX) || path.toLowerCase() === TERMAG_PREFIX.slice(0, -1)) {
      if (path === '/__termag/auth') { await exchange(req, res, name, suffix); return; }
      if (path === CLEAN_PATH) { await clean(req, res, name, suffix); return; }
      sendPage(res, 'not_found', req.method);
      return;
    }
    let verdict = await verify(name, suffix, sessionCookieValue(req.headers.cookie));
    if (verdict.kind === 'none') { toLanding(req, res, name); return; }
    if (verdict.kind === 'refused') { sendPage(res, 'not_found', req.method); return; }
    let state = reverifyState(verdict.v.session.verifiedAt, now());
    if (state !== 'fresh' && isNavigation(req.method, req.headers)) {
      // The cache may predate a reverify another process just finished.
      verdict = await verify(name, suffix, sessionCookieValue(req.headers.cookie), { fresh: true });
      if (verdict.kind === 'none') { toLanding(req, res, name); return; }
      if (verdict.kind === 'refused') { sendPage(res, 'not_found', req.method); return; }
      state = reverifyState(verdict.v.session.verifiedAt, now());
      // A HEAD (a prefetch, a link checker) never mints a ticket: it gets headers alone, as a non-navigation would.
      if (state !== 'fresh' && req.method === 'HEAD') { res.writeHead(204, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return; }
      if (state !== 'fresh') { await reverify(res, verdict.v, url); return; }
    }
    // Never re-sent as a GET: a form POST past two hours is told to reload (SR18).
    if (state === 'overdue') { refused('reverify_overdue'); sendPage(res, 'refresh_needed', req.method); return; }
    const v = verdict.v;
    // A first open whose clear was dropped with its navigation: the clear before any of the app (SR19).
    if (isNavigation(req.method, req.headers) && !markerNamesLink(deps.cookieSecret()!, name, req.headers.cookie, v.ctx.link.id)) {
      // The path it asked for only when the viewer's own browser asked from this origin or the address bar; from
      // another site, the app's root, so this hop never turns a cross-site link into an in-app one (Cursor Security).
      const site = String(req.headers['sec-fetch-site'] ?? '').trim().toLowerCase();
      redirect(res, cleanUrl(v.ctx.link.id, v.session.idHash, site === 'same-origin' || site === 'none' ? safeNext(url) : '/'));
      return;
    }
    if (crossSiteRefusal(req.method, req.headers, previewOrigin(previewHostLabel(name, v.ctx.link.hostSuffix), domain))) { refused('cross_site'); sendPage(res, 'cross_site', req.method); return; }
    const why = pathRefusal(path, deps.checkoutDir(v.ctx));
    if (why) { refused(why); sendPage(res, 'path_refused', req.method); return; }
    const length = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(length) && length > PREVIEW_BODY_LIMIT) { refused('too_large'); sendPage(res, 'too_large', req.method); return; }
    const box = await boxRefusal(v.ctx);
    if (box) { refused(box === 'asleep' ? 'box_parked' : 'box_not_ready'); sendPage(res, box, req.method); return; }
    deps.noteActivity?.(v.ctx.project.instanceId!, req.headers);
    relay.relayHttp(req, res, relayContext(v, req, domain));
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, name: string, suffix: string | null): Promise<void> {
    socket.on('error', () => { /* 'close' follows */ });
    const domain = deps.domain();
    if (!domain || !deps.cookieSecret()) { endUpgrade(socket, rawStatus(404)); return; }
    if (targetRefusal(req.url)) { refused('bad_request'); endUpgrade(socket, rawStatus(400)); return; }
    if (sameSiteRefusal(req.headers)) { refused('same_site'); endUpgrade(socket, rawStatus(403)); return; }
    const path = pathOf(req.url!);
    if (path.toLowerCase().startsWith(TERMAG_PREFIX)) { endUpgrade(socket, rawStatus(404)); return; }
    const cookie = sessionCookieValue(req.headers.cookie);
    // A socket with no session is pre-auth work like any other request without one (SR4): no cookie is
    // counted before anything else; a cookie that verifies to nothing is counted once its HMAC fails.
    if (!cookie && !preauthAllowed(req)) { refused('rate_limited'); endUpgrade(socket, rawStatus(429)); return; }
    const verdict = await verify(name, suffix, cookie);
    if (verdict.kind === 'none' && cookie && !preauthAllowed(req)) { refused('rate_limited'); endUpgrade(socket, rawStatus(429)); return; }
    // Nothing to redirect a socket to.
    if (verdict.kind === 'none') { refused('no_session'); endUpgrade(socket, rawStatus(401)); return; }
    if (verdict.kind === 'refused') { endUpgrade(socket, rawStatus(404)); return; }
    const v = verdict.v;
    if (reverifyState(v.session.verifiedAt, now()) === 'overdue') { refused('reverify_overdue'); endUpgrade(socket, rawStatus(401)); return; }
    if (req.headers.origin !== previewOrigin(previewHostLabel(name, v.ctx.link.hostSuffix), domain)) { refused('cross_site'); endUpgrade(socket, rawStatus(403)); return; }
    if (pathRefusal(path, deps.checkoutDir(v.ctx), true)) { refused('path'); endUpgrade(socket, rawStatus(403)); return; }
    const box = await boxRefusal(v.ctx);
    if (box) { refused(box === 'asleep' ? 'box_parked' : 'box_not_ready'); endUpgrade(socket, rawStatus(503, 'Retry-After: 5\r\n')); return; }
    audit({ step: 'upgrade', decision: 'grant', reason: v.session.basis, viewer: v.user.googleEmail, linkId: v.ctx.link.id, name, boxId: boxOf(v.ctx) });
    await relay.relayUpgrade(req, socket, head, relayContext(v, req, domain), {
      recheckMs,
      stillValid: async () => (await verify(name, suffix, cookie)).kind === 'ok',
    });
  }

  function refuseRaw(res: ServerResponse): void {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': 10 });
    res.end('Not Found\n');
  }

  function verdictFor(req: IncomingMessage): HostVerdict {
    return classifyHost(req.headers, deps.domain());
  }

  return {
    dispatch(req, res, next) {
      const verdict = verdictFor(req);
      if (verdict.kind === 'main') { next(); return; }
      if (verdict.kind === 'refuse') { refuseRaw(res); return; }
      handle(req, res, verdict.name, verdict.suffix).catch((err) => {
        console.error('[PREVIEW-LINK] request failed:', (err as Error).message);
        sendPage(res, 'try_again', req.method);
      });
    },
    dispatchUpgrade(req, socket, head) {
      const verdict = verdictFor(req);
      if (verdict.kind === 'main') return false;
      if (verdict.kind === 'refuse') { endUpgrade(socket, rawStatus(404)); return true; }
      handleUpgrade(req, socket, head, verdict.name, verdict.suffix).catch((err) => {
        console.error('[PREVIEW-LINK] upgrade failed:', (err as Error).message);
        endUpgrade(socket, rawStatus(503));
      });
      return true;
    },
    handle,
    handleUpgrade,
    verify,
    revoked(_linkId, idHashes) {
      for (const id of idHashes) {
        cache.delete(id);
        relay.dropSession(id);
      }
    },
    relay,
    closeAll(code, reason) { relay.closeAll(code, reason); },
    stop() { clearInterval(pruner); relay.stop(); },
  };
}
