import type { Request, Router } from 'express';
import type { CallerProofConfig } from '../services/callerIdentity';
import { getCredentialStoreConfig, githubOrgsSource, githubStoreDeps, githubTokenSource } from '../services/credentialStore';
import { recheckGithub } from '../services/githubCredential';
import { decideGithubRequest, oncePerUser } from '../services/githubAuthz';
import { poolGithubTokenSource } from '../services/poolCredential';
import { poolEnvironmentRepos } from '../services/poolEnvironmentRepos';
import { boxForTokenAt, gatewayCheckRouter } from './gatewayCheck';

// After an SSO refusal, re-probe the owner's token (at most every 2 minutes):
// once they authorize it, the stored state turns ok and the next request passes.
const recheckAfterSso = oncePerUser(userId => {
  const cfg = getCredentialStoreConfig();
  if (!cfg) return;
  recheckGithub(githubStoreDeps(cfg, userId)).catch(err => {
    console.warn(`[GH-AUTHZ] re-check after an SSO refusal failed for user=${userId}: ${(err as Error).message}`);
  });
}, 2 * 60_000);

// Envoy sends a body only for the checks that read one, and caps it lower.
const MAX_BODY = 8 * 1024 * 1024;

function readBody(req: Request): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('check body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Envoy's ext_authz check for the GitHub broker: the gateway's GitHub listener
 * calls this for every request, with the request's own method and path
 * appended.
 */
export function githubAuthzRouter(cfg: CallerProofConfig): Router {
  // Allowed calls are a debug line (TERMAG_DEBUG=GH-AUTHZ): one per git and
  // gh request from every box. Refusals still log.
  const quiet = { quietAllow: true };
  return gatewayCheckRouter(cfg, 'GH-AUTHZ', 'The termag GitHub broker could not check this request', async ({ req, path, search }) => {
    const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
    return decideGithubRequest(
      { method: req.method, path, search, authorization: req.headers.authorization, body },
      {
        boxForToken: boxForTokenAt('githubBroker'),
        ownerToken: githubTokenSource,
        ownerOrgs: githubOrgsSource,
        onSsoRequired: recheckAfterSso,
        // The environment pool's rule: a preparing pool box's fetches of its environment's repositories.
        poolToken: poolGithubTokenSource,
        poolEnvironmentRepos,
      },
    );
  }, quiet);
}
