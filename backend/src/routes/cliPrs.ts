/**
 * The PR pipeline's writes under /api/cli/v1, for the desktop app's pull
 * request page. Each runs the cookie
 * route's own handler (routes/prs.ts prsWrites):
 *
 *   PUT    /prs/deferrals                   defer a row for N days ({ key, days? })
 *   DELETE /prs/deferrals?key=…             bring a deferred row back
 *   POST   /prs/groups                      a new review group ({ name, members? })
 *   PATCH  /prs/groups/:id                  rename, close or reopen it ({ name?, closed? })
 *   PUT    /prs/groups/:id/members          its whole ordered member list
 *   DELETE /prs/groups/:id                  delete it
 *   POST   /prs/group-suggestions/dismiss   "Not these" on a suggested group ({ key })
 *   POST   /prs/bake                        Bake & deploy now: main's orchestrator image, as the user
 *   POST   /prs/:owner/:repo/:number/workstream  a termag workstream on the PR's own branch
 *                                          ({ projectId, name }): T3 Code's Work on PR on a termag project
 *
 * The list they change is GET /prs (routes/cliTui.ts). Like it, each is a
 * device sign-in's: a box's own token gets 403, since anything on the box can
 * read it. Failures carry
 * the CLI's `code` (tuiResult).
 */
import type { Request, RequestHandler, Response, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import type { CliUser } from '../services/cliStore';
import type { CliAuth } from './cliApi';
import { PRS_DEVICE_ONLY, tuiResult } from './cliTui';
import type { PrsWrites } from './prs';
import type { RouteResult } from './routeResult';

export interface CliPrs {
  writes: PrsWrites;
  /** Bake & deploy now (routes/prs.ts bakeNow). */
  bake(userId: string): Promise<RouteResult>;
  /**
   * A workstream on the PR's own branch (routes/prs.ts prWorkstreamFor), as
   * `POST /projects/:id/workstreams` answers: the worktree as the box sees it.
   */
  prWorkstream(user: CliUser, params: { owner: string; repo: string; number: string }, body: unknown): Promise<RouteResult>;
}

const NOT_FOUND = { error: 'No such CLI endpoint; this termag CLI may be newer than the orchestrator', code: 'not_found' };

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

export function mountCliPrsRoutes(router: Router, prs: CliPrs, bearer: RequestHandler): void {
  const desktopOnly: RequestHandler = asyncHandler(async (_req, res, next) => {
    const { user, credential } = cliAuth(res);
    if (credential.kind !== 'device') { res.status(403).json(PRS_DEVICE_ONLY); return; }
    next();
  });
  const route = (fn: (userId: string, req: Request, user: CliUser) => Promise<RouteResult>): RequestHandler[] => [
    bearer,
    desktopOnly,
    asyncHandler(async (req, res) => {
      const { user } = cliAuth(res);
      const result = tuiResult(await fn(user.id, req, user));
      res.status(result.status).json(result.body);
    }),
  ];

  router.put('/prs/deferrals', ...route((userId, req) => prs.writes.defer(userId, req.body)));
  router.delete('/prs/deferrals', ...route((userId, req) => prs.writes.undefer(userId, req.query.key)));
  router.post('/prs/groups', ...route((userId, req) => prs.writes.createGroup(userId, req.body)));
  router.patch('/prs/groups/:id', ...route((userId, req) => prs.writes.patchGroup(userId, req.params.id, req.body)));
  router.put('/prs/groups/:id/members', ...route((userId, req) => prs.writes.putMembers(userId, req.params.id, req.body)));
  router.delete('/prs/groups/:id', ...route((userId, req) => prs.writes.deleteGroup(userId, req.params.id)));
  router.post('/prs/group-suggestions/dismiss', ...route((userId, req) => prs.writes.dismissSuggestion(userId, req.body)));
  // A deploy of all of main, which the desktop's confirm says: a device sign-in's, never a box's.
  router.post('/prs/bake', ...route(userId => prs.bake(userId)));
  // A review the desktop posted to GitHub itself, recorded as termag's round (no GitHub write).
  router.post('/prs/:owner/:repo/:number/review-round', ...route((userId, req) =>
    prs.writes.recordReviewRound(userId, { owner: req.params.owner, repo: req.params.repo, number: req.params.number }, req.body)));
  router.post('/prs/:owner/:repo/:number/workstream', ...route((_userId, req, user) =>
    prs.prWorkstream(user, { owner: req.params.owner, repo: req.params.repo, number: req.params.number }, req.body)));
}
