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
 * browser routes' rule that an agent can't publish a port (SR5, P4); an agent
 * may only ask (`termag preview request`, phase 3). Past that the service's
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
}

const BOX_REFUSED = {
  error: "A box's own credentials can't publish a preview link; sign in on the box with `termag login --device <name>`, or ask the owner with `termag preview request`",
  code: 'forbidden',
};

function cliAuth(res: { locals: Record<string, unknown> }): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

/** After the bearer: a device sign-in goes on, a box's own token gets 403 `forbidden`. */
const deviceOnly: RequestHandler = (_req, res, next) => {
  if (cliAuth(res).credential.kind !== 'device') { res.status(403).json(BOX_REFUSED); return; }
  next();
};

export function mountCliPreviewLinkRoutes(router: Router, links: CliPreviewLinks, bearer: RequestHandler): void {
  // The browser routes' limit, per person: the bearer has said who by now.
  const perPerson = rateLimit({ capacity: 30, perMinute: 60, keyOf: req => (req.res?.locals.cliAuth as CliAuth | undefined)?.user.id ?? req.ip ?? 'anon' });
  const guard = [bearer, deviceOnly, perPerson];
  const handle = (fn: (req: Request, user: CliUser, origin: CliOrigin) => Promise<RouteResult>): RequestHandler =>
    asyncHandler(async (req, res) => {
      const { user, credential } = cliAuth(res);
      sendResult(res, await fn(req, user, { issuedOnBoxId: credential.kind === 'device' ? credential.issuedOnBoxId ?? null : null }));
    });

  router.get('/preview-links', ...guard, handle((req, user) => links.list(user, req.query)));
  // These two may widen who sees the app: from a sign-in made on a box, a
  // `people` or `link` audience waits for the person's confirm in the browser.
  router.post('/preview-links', ...guard, handle((req, user, origin) => links.publish(user, req.body, origin)));
  router.post('/preview-links/:id/extend', ...guard, handle((req, user, origin) => links.extend(user, req.params.id, req.body, origin)));
  router.get('/preview-links/confirmations/:id', ...guard, handle((req, user) => links.confirmation(user, req.params.id)));
  // These only narrow it, so they apply from anywhere.
  router.delete('/preview-links/:id', ...guard, handle((req, user) => links.revoke(user, req.params.id)));
  router.delete('/preview-links/:id/viewers/:userId', ...guard, handle((req, user) => links.removeViewer(user, req.params.id, req.params.userId)));
}
