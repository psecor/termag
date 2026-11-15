/**
 * `termag preview publish|list|revoke` under /api/cli/v1:
 * the browser routes' service
 * (services/previewLinks.ts) for a CLI bearer.
 *
 *   GET    /preview-links?project=<id>      the project's links and pending requests; without project, your own live links
 *   POST   /preview-links                   { project, workstream, port, name, audience, emails?, ttlHours?, hostMode? }
 *   POST   /preview-links/:id/extend        { ttlHours }
 *   GET    /preview-links/confirmations/:id the state of a confirm this sign-in was handed
 *   DELETE /preview-links/:id               revoke
 *   DELETE /preview-links/:id/viewers/:userId   remove a viewer
 *   POST   /preview-link-requests           { project, workstream?, port, note? }: an agent asks (box token only)
 *
 * A sign-in made on a box (its token is readable by every process there, an
 * agent's included) publishes, renews and extends "only me" links at once,
 * but one that would let more people see the app answers 202
 * `confirm_in_browser` with a one-time URL instead, and nothing applies until
 * the person confirms it in their termag session
 * (services/previewLinkConfirmations.ts). Revoke and remove-viewer only narrow
 * access, so they apply from anywhere.
 *
 * A device sign-in's only, as `termag forward` is: a box's own token gets 403
 * `forbidden`. Anything on a box can read that token, so this keeps the
 * browser routes' rule that an agent can't publish a port (SR5, P4). Each
 * route's refusal says what was refused and names only ways that exist and
 * fit (BOX_REFUSED). An agent may only ask (`termag preview request`,
 * services/previewLinkRequests.ts), the one route here a box's token may
 * call, and a device sign-in may not: a person publishes. Past that the service's
 * own answers apply: 404 `not_found` with `preview-links-enabled` off for the
 * project's owner and box, as if the route weren't there. The service behind
 * it is routes/cliPreviewLinksPrisma.ts's, so the CLI router (routes/cliApi.ts)
 * loads no prisma for it.
 */
import type { Request, RequestHandler, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import { rateLimit } from '../middleware/rateLimit';
import type { CliUser } from '../services/cliStore';
import type { CliAuth } from './cliApi';
import { sendResult, type RouteResult } from './routeResult';

/** Where the device sign-in was made: a box's id, or null for anywhere else (CliCredential.issuedOnBoxId). */
export interface CliOrigin {
  issuedOnBoxId: string | null;
}

export interface CliPreviewLinks {
  list(user: CliUser, query: unknown): Promise<RouteResult>;
  publish(user: CliUser, body: unknown, origin: CliOrigin): Promise<RouteResult>;
  extend(user: CliUser, linkId: string, body: unknown, origin: CliOrigin): Promise<RouteResult>;
  revoke(user: CliUser, linkId: string): Promise<RouteResult>;
  removeViewer(user: CliUser, linkId: string, userId: string): Promise<RouteResult>;
  /** The CLI's poll of a confirm it was handed (202 confirm_in_browser). */
  confirmation(user: CliUser, id: string): Promise<RouteResult>;
  /** An agent on box `boxId` asks its owner for a link (`termag preview request`). */
  request(boxId: string, body: unknown): Promise<RouteResult>;
}

/** The route a box's own token was refused on; each refusal is worded for it. */
type BoxRefusedFor = 'list' | 'publish' | 'extend' | 'confirmation' | 'revoke' | 'removeViewer';

const WHY = '(anything on the box can use them)';
const SIGN_IN = 'sign in on the box with `termag login --device <name>`';

/**
 * What was refused, and only ways to do it that exist and fit: the owner's
 * Share dialog, the owner's own command where the CLI has one, a device
 * sign-in on the box where a command would then work, and for a publish the
 * agent's own ask (#1568's `termag preview request`). Removing one viewer
 * never points at revoke, which ends the link for everyone.
 */
const BOX_REFUSED: Record<BoxRefusedFor, string> = {
  list: `A box's own credentials can't read preview links ${WHY}; `
    + "ask the owner to look in termag's Share dialog or run their own `termag preview list`, or " + SIGN_IN,
  publish: `A box's own credentials can't publish a preview link ${WHY}; `
    + "the owner publishes from termag's Share dialog or their own `termag preview publish`; "
    + SIGN_IN + ', or ask the owner with `termag preview request`',
  extend: `A box's own credentials can't extend a preview link ${WHY}; `
    + "ask the owner to extend it with Extend in termag's Share dialog",
  confirmation: `A box's own credentials can't read a preview link's confirmation ${WHY}; `
    + 'the owner confirms or declines it in their browser, '
    + "and the `termag preview publish` that asked for it reads it with the owner's own sign-in",
  revoke: `A box's own credentials can't revoke a preview link ${WHY}; `
    + "ask the owner to revoke it from termag's Share dialog or their own `termag preview revoke`, or " + SIGN_IN,
  removeViewer: `A box's own credentials can't remove a preview link's viewer ${WHY}; `
    + "ask the owner to remove them with Remove beside their name in termag's Share dialog",
};

/** The 403 for a box's own token: anything on the box can read it, an agent included. */
export function boxRefused(what: BoxRefusedFor): { error: string; code: 'forbidden' } {
  return { error: BOX_REFUSED[what], code: 'forbidden' };
}

function cliAuth(res: { locals: Record<string, unknown> }): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

/** After the bearer: a device sign-in goes on, a box's own token gets 403 `forbidden`. */
function deviceOnly(what: BoxRefusedFor): RequestHandler {
  return (_req, res, next) => {
    if (cliAuth(res).credential.kind !== 'device') { res.status(403).json(boxRefused(what)); return; }
    next();
  };
}

const DEVICE_REFUSED = {
  error: '`termag preview request` is for an agent on a box, with the box\'s own credentials; signed in yourself, publish with `termag preview publish`',
  code: 'forbidden',
};

/** After the bearer: a box's own token goes on (with its box), anything else gets 403 `forbidden`. */
const boxOnly: RequestHandler = (_req, res, next) => {
  const c = cliAuth(res).credential;
  if (c.kind !== 'box' || !c.boxId) { res.status(403).json(DEVICE_REFUSED); return; }
  next();
};

export function mountCliPreviewLinkRoutes(router: Router, links: CliPreviewLinks, bearer: RequestHandler): void {
  // The browser routes' limit, per person: the bearer has said who by now.
  const perPerson = rateLimit({ capacity: 30, perMinute: 60, keyOf: req => (req.res?.locals.cliAuth as CliAuth | undefined)?.user.id ?? req.ip ?? 'anon' });
  const guard = (what: BoxRefusedFor) => [bearer, deviceOnly(what), perPerson];
  const handle = (fn: (req: Request, user: CliUser, origin: CliOrigin) => Promise<RouteResult>): RequestHandler =>
    asyncHandler(async (req, res) => {
      const { user, credential } = cliAuth(res);
      sendResult(res, await fn(req, user, { issuedOnBoxId: credential.kind === 'device' ? credential.issuedOnBoxId ?? null : null }));
    });

  router.get('/preview-links', ...guard('list'), handle((req, user) => links.list(user, req.query)));
  // These two may widen who sees the app: from a sign-in made on a box, a
  // `people` or `link` audience waits for the person's confirm in the browser.
  router.post('/preview-links', ...guard('publish'), handle((req, user, origin) => links.publish(user, req.body, origin)));
  router.post('/preview-links/:id/extend', ...guard('extend'), handle((req, user, origin) => links.extend(user, req.params.id, req.body, origin)));
  router.get('/preview-links/confirmations/:id', ...guard('confirmation'), handle((req, user) => links.confirmation(user, req.params.id)));
  // These only narrow it, so they apply from anywhere.
  router.delete('/preview-links/:id', ...guard('revoke'), handle((req, user) => links.revoke(user, req.params.id)));
  router.delete('/preview-links/:id/viewers/:userId', ...guard('removeViewer'), handle((req, user) => links.removeViewer(user, req.params.id, req.params.userId)));
  // An agent's ask: it publishes nothing, and the service holds each box to 10 an hour.
  // A flood guard only; the hourly rule (10 a box) is the service's, over its rows.
  const perBox = rateLimit({ capacity: 20, perMinute: 10, keyOf: req => {
    const c = (req.res?.locals.cliAuth as CliAuth | undefined)?.credential;
    return c && c.kind === 'box' && c.boxId ? `box:${c.boxId}` : req.ip ?? 'anon';
  } });
  router.post('/preview-link-requests', bearer, boxOnly, perBox, asyncHandler(async (req, res) => {
    const c = cliAuth(res).credential as { kind: 'box'; boxId: string };
    sendResult(res, await links.request(c.boxId, req.body));
  }));
}
