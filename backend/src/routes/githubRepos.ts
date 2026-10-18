import { Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import { requireAuth } from '../middleware/auth';
import { getCredentialStoreConfig } from '../services/credentialStore';
import { repoCache, type RepoCache } from '../services/githubRepoCache';

const STORE_OFF = 'The credential store is not configured on this orchestrator.';

export function githubReposRouter(cache: RepoCache = repoCache): Router {
  const router = Router();
  router.use(requireAuth);
  router.get('/repos', asyncHandler(async (req, res) => {
    if (!getCredentialStoreConfig()) {
      res.status(503).json({ error: STORE_OFF });
      return;
    }
    const body = await cache.getRepos(req.user!.id, { refresh: req.query.refresh === '1' });
    res.set('Cache-Control', 'no-store');
    res.json(body);
  }));
  return router;
}
