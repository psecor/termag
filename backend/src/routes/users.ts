/**
 * People, for the person picker in the share and space dialogs:
 *
 *   GET /api/users/search?q=<text>   up to 8 { email, displayName }, best first
 *
 * A signed-in user only (the session; agent tokens never reach it), never
 * themselves, and rate-limited per user. Fewer than 2 characters answer [].
 * services/userSearch.ts says what matches. The desktop app's share dialog
 * asks the same through its CLI mirror (routes/cliPreviewShares.ts), a device
 * sign-in's only.
 */
import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { asyncHandler } from '../middleware/errors';
import { PEOPLE_MAX_QUERY, searchPeople, type Person } from '../services/userSearch';
import { sendResult, type RouteResult } from './routeResult';

export interface UsersRouteDeps {
  search(query: string, selfId: string): Promise<Person[]>;
}

export async function searchPeopleFor(deps: UsersRouteDeps, selfId: string, rawQuery: unknown): Promise<RouteResult> {
  const q = typeof rawQuery === 'string' ? rawQuery : '';
  if (q.length > PEOPLE_MAX_QUERY) return { status: 400, body: { error: `q is at most ${PEOPLE_MAX_QUERY} characters` } };
  return { status: 200, body: { people: await deps.search(q, selfId) } };
}

export function usersRouter(deps: UsersRouteDeps = { search: searchPeople }): Router {
  const router = Router();
  const limit = rateLimit({ capacity: 30, perMinute: 60, keyOf: req => req.user?.id ?? req.ip ?? 'anon' });
  router.get('/search', requireAuth, limit, asyncHandler(async (req: Request, res: Response) => {
    sendResult(res, await searchPeopleFor(deps, req.user!.id, req.query.q));
  }));
  return router;
}
