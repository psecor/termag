import type { Request, Router } from 'express';
import type { CallerProofConfig } from '../services/callerIdentity';
import { githubTokenSource } from '../services/credentialStore';
import { decideGithubRequest } from '../services/githubAuthz';
import { boxForToken, gatewayCheckRouter } from './gatewayCheck';

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
  return gatewayCheckRouter(cfg, 'GH-AUTHZ', 'The termag GitHub broker could not check this request', async ({ req, path, search }) => {
    const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
    return decideGithubRequest(
      { method: req.method, path, search, authorization: req.headers.authorization, body },
      { boxForToken, ownerToken: githubTokenSource },
    );
  });
}
