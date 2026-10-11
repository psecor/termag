/**
 * /termag/auth/cli/authorize — the browser half of `termag login`.
 *
 * Unlike /api/cli, this path is NOT bypassed at the ALB: the browser passes
 * Okta and device trust exactly as for the web UI, and the page uses the
 * normal cookie session. Approving issues a one-time code and redirects to
 * the CLI's loopback listener (services/cliAuth.ts has the flow).
 */
import express, { Request, Response, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import {
  AuthCodeStore,
  approvalPageHeaders,
  isSameOriginPost,
  loopbackRedirect,
  messagePageHeaders,
  parseAuthorizeParams,
  renderApprovalPage,
  renderMessagePage,
} from '../services/cliAuth';

export interface CliAuthorizeDeps {
  codes: AuthCodeStore;
  basePath: string;
  frontendUrl: string;
  /**
   * The edge-verified identity's email (okta mode), or null when there is no
   * edge identity. A mismatch with the session user means the browser carries
   * someone else's session, e.g. a cookie tossed from a sibling host (audit
   * F4), and a token must not be minted for it.
   */
  edgeIdentityEmail?: (req: Request) => Promise<string | null>;
  /**
   * Stash `url` so the sign-in flow returns to it (auth/postLoginReturn.ts),
   * resolving once it is saved. When set, an anonymous GET is sent to sign in
   * instead of being asked to. Leave unset in okta mode, where a request
   * without a session never came through the ALB and would loop.
   */
  rememberReturnTo?: (req: Request, url: string) => Promise<boolean>;
}

function sendMessage(res: Response, status: number, title: string, message: string, link?: { href: string; text: string }) {
  res.status(status).set(messagePageHeaders).type('html').send(renderMessagePage(title, message, link?.href, link?.text));
}

function originOf(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

export function cliAuthorizeRouter(deps: CliAuthorizeDeps): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false, limit: '4kb' }));

  async function identityMatches(req: Request): Promise<boolean> {
    if (!deps.edgeIdentityEmail) return true;
    let email: string | null;
    try { email = await deps.edgeIdentityEmail(req); } catch { return false; }
    return email === null || email.toLowerCase() === req.user!.googleEmail.toLowerCase();
  }

  function requireSignedIn(req: Request, res: Response): boolean {
    if (req.user) return true;
    sendMessage(res, 401, 'Sign in to termag first',
      'Sign in to the termag web UI in this browser, then run `termag login` again.',
      { href: `${deps.basePath}/auth/login`, text: 'Sign in' });
    return false;
  }

  router.get('/authorize', asyncHandler(async (req, res) => {
    const params = parseAuthorizeParams(req.query as Record<string, unknown>);
    if ('error' in params) { sendMessage(res, 400, 'Invalid sign-in request', params.error); return; }
    if (!req.user && deps.rememberReturnTo && await deps.rememberReturnTo(req, req.originalUrl)) {
      res.redirect(303, `${deps.basePath}/auth/login`);
      return;
    }
    if (!requireSignedIn(req, res)) return;
    if (!(await identityMatches(req))) {
      sendMessage(res, 403, 'Account mismatch', 'This browser\'s termag session is for a different account than your sign-in. Sign out of termag and try again.');
      return;
    }
    res.status(200).set(approvalPageHeaders(params.port)).type('html').send(renderApprovalPage({
      ...params,
      email: req.user!.googleEmail,
      action: `${deps.basePath}/auth/cli/authorize`,
    }));
  }));

  router.post('/authorize', asyncHandler(async (req, res) => {
    const allowed = [originOf(`${req.protocol}://${req.get('host')}`), originOf(deps.frontendUrl)]
      .filter((o): o is string => o !== null);
    const secFetchSite = req.get('sec-fetch-site');
    if (!isSameOriginPost({ secFetchSite, origin: req.get('origin') }, allowed)) {
      sendMessage(res, 403, 'Request refused', 'This approval did not come from the termag sign-in page.');
      return;
    }
    const params = parseAuthorizeParams((req.body ?? {}) as Record<string, unknown>);
    if ('error' in params) { sendMessage(res, 400, 'Invalid sign-in request', params.error); return; }
    if (!requireSignedIn(req, res)) return;
    if (!(await identityMatches(req))) {
      sendMessage(res, 403, 'Account mismatch', 'This browser\'s termag session is for a different account than your sign-in. Sign out of termag and try again.');
      return;
    }
    if (req.body.decision !== 'approve') {
      res.redirect(303, loopbackRedirect(params.port, { error: 'access_denied', state: params.state }));
      return;
    }
    const code = deps.codes.issue({
      userId: req.user!.id,
      deviceName: params.deviceName,
      codeChallenge: params.codeChallenge,
    });
    res.redirect(303, loopbackRedirect(params.port, { code, state: params.state }));
  }));

  // This router owns the whole /auth/cli prefix: nothing under it may fall
  // through to authRouter, so no second CLI sign-in flow can be mounted there.
  router.use((_req, res) => {
    sendMessage(res, 404, 'Unknown sign-in link',
      'This termag only signs in the CLI through `termag login`. Update your termag CLI and run `termag login` again.');
  });

  return router;
}
