/**
 * The desktop app's preview shares under /api/cli/v1:
 * the owner's routes of routes/previewShares.ts and
 * the share dialog's people search (routes/users.ts), for a CLI bearer.
 *
 *   POST   /projects/:id/preview-shares                   { email | audience: 'link', workstream, recipe?, ttlHours? }
 *   GET    /projects/:id/preview-shares                   the project's shares
 *   GET    /projects/:id/preview-share-stack?workstream=  whether a reviewer of that workstream's dev stack would get in now
 *   PATCH  /projects/:id/preview-shares/:shareId          { ttlHours } from now
 *   DELETE /projects/:id/preview-shares/:shareId          stop sharing
 *   POST   /projects/:id/preview-shares/link              a PR's link share, { workstream, repo, number }
 *   GET    /users/search?q=                               people to share with
 *
 * A device sign-in's only: a box's own token gets 403 `forbidden`, as on the
 * desktop's box bridge (deviceOnly, routes/cliT3.ts). Anything on a box can
 * read that token, so this keeps the browser routes' rule that an agent can't
 * create, list or revoke a share. Behind `desktop-app-enabled`, for the owner
 * and the project's box (the person alone for the search): off, or a project
 * that isn't the caller's, and the route answers 404 `not_found` as if it
 * weren't there. Past that, the browser routes' own handlers answer
 * (routes/cliPreviewSharesPrisma.ts): their owner check, preview-share flags,
 * validation and JSON. The rate limit is theirs too, per person.
 */
import type { Request, RequestHandler, Response, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import { rateLimit } from '../middleware/rateLimit';
import type { CliUser } from '../services/cliStore';
import type { CliAuth } from './cliApi';
import { deviceOnly } from './cliT3';
import { sendResult, type RouteResult } from './routeResult';

export interface CliPreviewShares {
  create(user: CliUser, projectId: string, body: unknown): Promise<RouteResult>;
  list(user: CliUser, projectId: string): Promise<RouteResult>;
  stackCheck(user: CliUser, projectId: string, query: unknown): Promise<RouteResult>;
  extend(user: CliUser, projectId: string, shareId: string, body: unknown): Promise<RouteResult>;
  revoke(user: CliUser, projectId: string, shareId: string): Promise<RouteResult>;
  createLink(user: CliUser, projectId: string, body: unknown): Promise<RouteResult>;
  searchPeople(user: CliUser, query: unknown): Promise<RouteResult>;
}

function cliUser(res: Response): CliUser {
  return (res.locals.cliAuth as CliAuth).user;
}

export function mountCliPreviewShareRoutes(router: Router, shares: CliPreviewShares, bearer: RequestHandler): void {
  // The browser routes' limits, each per person: the bearer has said who by now.
  const perPerson = () => rateLimit({ capacity: 30, perMinute: 60, keyOf: req => (req.res?.locals.cliAuth as CliAuth | undefined)?.user.id ?? req.ip ?? 'anon' });
  const share = [bearer, deviceOnly, perPerson()];
  const search = [bearer, deviceOnly, perPerson()];
  const handle = (fn: (req: Request, user: CliUser) => Promise<RouteResult>): RequestHandler =>
    asyncHandler(async (req, res) => { sendResult(res, await fn(req, cliUser(res))); });

  router.post('/projects/:id/preview-shares', ...share, handle((req, user) => shares.create(user, req.params.id, req.body)));
  router.get('/projects/:id/preview-shares', ...share, handle((req, user) => shares.list(user, req.params.id)));
  router.get('/projects/:id/preview-share-stack', ...share, handle((req, user) => shares.stackCheck(user, req.params.id, req.query)));
  router.post('/projects/:id/preview-shares/link', ...share, handle((req, user) => shares.createLink(user, req.params.id, req.body)));
  router.patch('/projects/:id/preview-shares/:shareId', ...share, handle((req, user) => shares.extend(user, req.params.id, req.params.shareId, req.body)));
  router.delete('/projects/:id/preview-shares/:shareId', ...share, handle((req, user) => shares.revoke(user, req.params.id, req.params.shareId)));
  router.get('/users/search', ...search, handle((req, user) => shares.searchPeople(user, req.query.q)));
}
