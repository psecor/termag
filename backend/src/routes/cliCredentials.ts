/**
 * The credential routes of /termag/api/cli/v1, for `termag doctor`. index.ts
 * mounts this just ahead of cliApiRouter, before the cookie stack, and every
 * route takes cliApiRouter's own bearer check, so the same two credential
 * kinds reach them and anything else falls through to its 404. Reads are open
 * to both; the one write, storing the GitHub token, takes a device sign-in
 * only, so an agent on a box can never change its owner's credentials with the
 * box's own token. Adding an SSH key is web-only (routes/sshKeys.ts): a key
 * opens a shell on every box, so a CLI credential must not be able to add one
 * until CLI sessions can be revoked. POST /ssh-keys gets the CLI API's 404.
 *
 * No response carries a token or a full public key.
 */
import { Router, RequestHandler, Response } from 'express';
import { asyncHandler } from '../middleware/errors';
import type { CliCredentials } from '../services/cliCredentials';
import { CredentialStoreUnavailableError } from '../services/cliCredentials';
import { CredentialInputError } from '../services/githubCredential';
import { cliBearer, type CliApiDeps, type CliAuth } from './cliApi';

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

const deviceOnly: RequestHandler = (_req, res, next) => {
  if (cliAuth(res).credential.kind !== 'device') {
    res.status(403).json({
      error: 'A box\'s own credentials cannot change your SSH keys or GitHub token; run this on your laptop after `termag login`',
      code: 'box_credential',
    });
    return;
  }
  next();
};

const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

export function cliCredentialsRouter(deps: Pick<CliApiDeps, 'store' | 'jwt' | 'now'> & { credentials: CliCredentials }): Router {
  const router = Router();
  const bearer: RequestHandler[] = [noStore, cliBearer(deps)];
  const { credentials } = deps;

  router.get('/credentials', bearer, asyncHandler(async (_req, res) => {
    const userId = cliAuth(res).user.id;
    const [status, sshKeys] = await Promise.all([credentials.status(userId), credentials.listSshKeys(userId)]);
    res.json({ ...status, sshKeys });
  }));

  router.get('/ssh-keys', bearer, asyncHandler(async (_req, res) => {
    res.json({ sshKeys: await credentials.listSshKeys(cliAuth(res).user.id) });
  }));

  router.put('/github', bearer, deviceOnly, asyncHandler(async (req, res) => {
    try {
      res.json(await credentials.connectGithub(cliAuth(res).user.id, (req.body as { token?: unknown })?.token));
    } catch (err) {
      if (err instanceof CredentialInputError) { res.status(400).json({ error: err.message, code: 'invalid_token' }); return; }
      if (err instanceof CredentialStoreUnavailableError) {
        res.status(503).json({ error: err.message, code: 'credential_store_unavailable' });
        return;
      }
      throw err;
    }
  }));

  return router;
}
