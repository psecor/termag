import { Router, type Request, type Response } from 'express';
import { verifyCallerProof, type CallerProofConfig } from '../services/callerIdentity';
import type { AuthzBox, AuthzDecision } from '../services/gatewayAuthz';
import { isManagedBox, parseAgentConnection } from '../services/instanceLifecycle';
import { validateAgentToken } from './agentTokens';

export async function boxForToken(token: string): Promise<AuthzBox | null> {
  const validated = await validateAgentToken(token);
  // Only agent-scoped tokens identify a box or a user's agent here; admin and
  // client tokens (middleware/admin.ts) never authorise gateway calls.
  const conn = validated && validated.token.scope === 'agent' ? parseAgentConnection(validated) : null;
  if (!conn) return null;
  if (conn.kind === 'user-agent') return { userId: conn.user.id, instanceId: '-', managed: false };
  if (conn.kind !== 'owned-box') return { userId: '-', instanceId: conn.instance.id, managed: false };
  return {
    userId: conn.user.id,
    instanceId: conn.instance.id,
    managed: isManagedBox(conn.instance),
    email: conn.user.googleEmail,
  };
}

export interface CheckRequest {
  req: Request;
  // The box's own request: Envoy appends its path and query to the check's.
  path: string;
  search: string;
}

/**
 * An Envoy ext_authz check endpoint on the gateway's behalf. Only the gateway
 * may call one: the request must carry a caller proof for an allowed role,
 * checked before anything else. nginx also keeps /termag/internal/ off the
 * plain :3040 listener, but the proof is what decides. Mounted
 * before express.json(). Logs under `[tag]` the box, owner and decision; never
 * a token or a body.
 */
export function gatewayCheckRouter(
  cfg: CallerProofConfig,
  tag: string,
  unavailable: string,
  decide: (check: CheckRequest) => Promise<AuthzDecision>,
): Router {
  const router = Router();
  router.use(async (req: Request, res: Response) => {
    const q = req.url.indexOf('?');
    const path = q >= 0 ? req.url.slice(0, q) : req.url;
    const search = q >= 0 ? req.url.slice(q) : '';
    const refuse = (status: number, message: string, audit: string, headers: Record<string, string> = {}) => {
      console.log(`[${tag}] ${req.method} ${path} -> ${status} ${audit}`);
      res.status(status).set(headers).json({ message });
    };
    try {
      if (!await verifyCallerProof(req.headers, cfg)) {
        refuse(403, 'Only the termag gateway can use this endpoint', 'no valid caller proof');
        return;
      }
      const decision = await decide({ req, path, search });
      if (!decision.allow) {
        refuse(decision.status, decision.message, decision.audit, decision.headers);
        return;
      }
      console.log(`[${tag}] ${decision.audit}`);
      res.status(200).set(decision.headers).end();
    } catch (err) {
      refuse(503, unavailable, `error ${(err as Error).message}`);
    }
  });
  return router;
}
