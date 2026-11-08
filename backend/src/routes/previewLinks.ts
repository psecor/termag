/**
 * Preview links' publish routes:
 * a port of a workstream's box at <name>.<preview domain>.
 *
 *   GET    /api/projects/:id/preview-links                     owner, collaborator: live and recently ended links,
 *                                                               with viewers, and pending agent requests
 *   GET    /api/projects/:id/preview-links/listeners?workstream=   owner, collaborator: the box's listening ports,
 *                                                               with port-guard's verdict (agent RPC preview-listeners)
 *   POST   /api/projects/:id/preview-links                     owner, collaborator: { workstream, port, name, audience,
 *                                                               emails?, ttlHours?, hostMode?, requestId? }; renews when the
 *                                                               name is this workstream's live link (P5)
 *   POST   /api/preview-links/:id/extend                       the project's owner, the link's creator: { ttlHours }
 *   DELETE /api/preview-links/:id                              the project's owner, the link's creator: revoke (L2)
 *   DELETE /api/preview-links/:id/viewers/:userId              the project's owner, the link's creator: remove a viewer (A3)
 *   POST   /api/preview-link-requests/:id/decline              owner, collaborator: decline an agent's ask
 *
 * All behind the browser session (requireAuth), mounted after the session
 * middleware: a box token never reaches req.user here, so it gets 401 on
 * every one of them (SR5, previewLinks.routes.test.ts). The CLI's device
 * sign-in reaches the same service through routes/cliPreviewLinks.ts. With
 * `preview-links-enabled` off for the project's owner and box, each answers
 * 404 `not_found`. The logic is services/previewLinks.ts's.
 */
import { Router, type Request, type RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { rateLimit } from '../middleware/rateLimit';
import {
  declinePreviewLinkRequestFor, defaultPreviewLinkDeps, extendPreviewLinkFor, listPreviewLinksFor, previewListenersFor, publishPreviewLinkFor,
  removePreviewLinkViewerFor, revokePreviewLinkFor, type PreviewLinkCaller, type PreviewLinkDeps,
} from '../services/previewLinks';
import { sendResult, type RouteResult } from './routeResult';

export function previewLinksRouter(deps: PreviewLinkDeps = defaultPreviewLinkDeps): Router {
  const router = Router();
  // Per person: each publish asks the box for its listeners.
  const perPerson = () => rateLimit({ capacity: 30, perMinute: 60, keyOf: req => req.user?.id ?? req.ip ?? 'anon' });
  const handle = (fn: (req: Request, caller: PreviewLinkCaller) => Promise<RouteResult>): RequestHandler =>
    asyncHandler(async (req, res) => { sendResult(res, await fn(req, req.user!)); });
  const authed = [requireAuth, perPerson()];

  router.get('/projects/:id/preview-links', ...authed, handle((req, caller) => listPreviewLinksFor(deps, caller, req.params.id)));
  router.get('/projects/:id/preview-links/listeners', ...authed, handle((req, caller) => previewListenersFor(deps, caller, req.params.id, req.query)));
  router.post('/projects/:id/preview-links', ...authed, handle((req, caller) => publishPreviewLinkFor(deps, caller, req.params.id, req.body)));
  router.post('/preview-links/:id/extend', ...authed, handle((req, caller) => extendPreviewLinkFor(deps, caller, req.params.id, req.body)));
  router.delete('/preview-links/:id', ...authed, handle((req, caller) => revokePreviewLinkFor(deps, caller, req.params.id)));
  router.delete('/preview-links/:id/viewers/:userId', ...authed, handle((req, caller) => removePreviewLinkViewerFor(deps, caller, req.params.id, req.params.userId)));
  router.post('/preview-link-requests/:id/decline', ...authed, handle((req, caller) => declinePreviewLinkRequestFor(deps, caller, req.params.id)));
  return router;
}
