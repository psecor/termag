/**
 * The environment pool's GitHub credential ("The
 * pool's GitHub credential, through the broker"), set by an admin. Mounted
 * inside adminRouter, so requireAdmin and the audit row already apply.
 *
 *   GET    /pool-credential/github  what is stored: the GitHub login, when and by whom; never the value
 *   PUT    /pool-credential/github  { token }: GitHub checks it (GET /user), then it is stored sealed
 *   DELETE /pool-credential/github  removes it; pool boxes' fetches are refused from then on
 *
 * PUT and DELETE are session-only (requireAdminSession): an admin bearer token
 * is a read credential a model or a script holds, and this one decides what
 * every pool box clones as.
 */
import { Router } from 'express';
import { asyncHandler } from '../../middleware/errors';
import { requireAdminSession } from '../../middleware/admin';
import { CredentialInputError } from '../../services/githubCredential';
import {
  deletePoolCredential, poolCredentialSummary, PoolCredentialUnavailable, setPoolGithubCredential, type PoolCredentialDeps,
} from '../../services/poolCredential';

export function poolCredentialRouter(deps: PoolCredentialDeps = {}): Router {
  const router = Router();

  router.get('/pool-credential/github', asyncHandler(async (_req, res) => {
    res.json(await poolCredentialSummary('github', deps));
  }));

  router.put('/pool-credential/github', requireAdminSession, asyncHandler(async (req, res) => {
    const token = (req.body as { token?: unknown } | undefined)?.token;
    try {
      res.json(await setPoolGithubCredential(token, req.user!.id, deps));
    } catch (err) {
      if (err instanceof CredentialInputError) { res.status(400).json({ error: err.message }); return; }
      if (err instanceof PoolCredentialUnavailable) { res.status(503).json({ error: err.message }); return; }
      throw err;
    }
  }));

  router.delete('/pool-credential/github', requireAdminSession, asyncHandler(async (_req, res) => {
    res.json({ removed: await deletePoolCredential('github', deps) });
  }));

  return router;
}
