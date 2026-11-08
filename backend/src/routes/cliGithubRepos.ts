/**
 * GET /api/cli/v1/github/repos[?refresh=1]: /api/github/repos
 * (routes/githubRepos.ts) for the desktop's repository picker. It lists the
 * person's GitHub repositories and their orgs', grouped, from the same cache,
 * in the same body. A device sign-in's: a box's own token gets 403, since
 * anything on the box could read the list. 503 `store_off` where the credential store that
 * holds their GitHub token isn't configured, as the web route answers.
 */
import type { RequestHandler, Response, Router } from 'express';
import { prisma } from '../db';
import { asyncHandler } from '../middleware/errors';
import type { CliUser } from '../services/cliStore';
import { getCredentialStoreConfig } from '../services/credentialStore';
import { repoCache } from '../services/githubRepoCache';
import type { CliAuth } from './cliApi';

export interface CliGithubRepos {
  /** Whether the credential store (the person's GitHub token) is configured. */
  storeConfigured(): boolean;
  /** /api/github/repos' body; `refresh` skips the cache. */
  repos(user: CliUser, refresh: boolean): Promise<unknown>;
}

const NOT_FOUND = { error: 'No such CLI endpoint; this termag CLI may be newer than the orchestrator', code: 'not_found' };
const DEVICE_ONLY = {
  error: "A box's own credentials can't list your GitHub repositories; sign in with `termag login`",
  code: 'forbidden',
};
const STORE_OFF = { error: 'The credential store is not configured on this orchestrator.', code: 'store_off' };

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

export function mountCliGithubRepoRoutes(router: Router, deps: CliGithubRepos, bearer: RequestHandler): void {
  router.get('/github/repos', bearer, asyncHandler(async (req, res) => {
    const { user, credential } = cliAuth(res);
    if (credential.kind !== 'device') { res.status(403).json(DEVICE_ONLY); return; }
    if (!deps.storeConfigured()) { res.status(503).json(STORE_OFF); return; }
    const body = await deps.repos(user, req.query.refresh === '1');
    res.set('Cache-Control', 'no-store');
    res.json(body);
  }));
}

export const prismaCliGithubRepos: CliGithubRepos = {
  storeConfigured: () => !!getCredentialStoreConfig(),
  repos: (user, refresh) => repoCache.getRepos(user.id, { refresh }),
};
