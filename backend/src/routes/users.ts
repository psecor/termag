/**
 * People, for the person picker in the share and space dialogs:
 *
 *   GET /api/users/search?q=<text>   up to 8 { email, displayName }, best first
 *
 * A signed-in user only (the session; agent tokens never reach it), never
 * themselves, and rate-limited per user. Fewer than 2 characters answer [].
 * services/userSearch.ts says what matches.
 */
import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { asyncHandler } from '../middleware/errors';
import { PEOPLE_MAX_QUERY, searchPeople, type Person } from '../services/userSearch';

export interface UsersRouteDeps {
  search(query: string, selfId: string): Promise<Person[]>;
}

export function usersRouter(deps: UsersRouteDeps = { search: searchPeople }): Router {
  const router = Router();
  const limit = rateLimit({ capacity: 30, perMinute: 60, keyOf: req => req.user?.id ?? req.ip ?? 'anon' });
  router.get('/search', requireAuth, limit, asyncHandler(async (req: Request, res: Response) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (q.length > PEOPLE_MAX_QUERY) { res.status(400).json({ error: `q is at most ${PEOPLE_MAX_QUERY} characters` }); return; }
    res.json({ people: await deps.search(q, req.user!.id) });
  }));
  return router;
}
