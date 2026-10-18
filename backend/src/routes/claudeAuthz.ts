import type { Router } from 'express';
import { prisma } from '../db';
import type { CallerProofConfig } from '../services/callerIdentity';
import { decideClaudeRequest } from '../services/claudeAuthz';
import { getClaudeGatewayConfig } from '../services/claudeGateway';
import { boxForToken, gatewayCheckRouter } from './gatewayCheck';

async function gatewayEnabled(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { claudeGatewayEnabled: true } });
  return !!user?.claudeGatewayEnabled;
}

/**
 * Envoy's ext_authz check for the Claude gateway: the gateway's Bedrock
 * listener calls this for every model call, with the call's path appended.
 * Envoy sends no body.
 */
export function claudeAuthzRouter(cfg: CallerProofConfig): Router {
  return gatewayCheckRouter(cfg, 'CLAUDE-AUTHZ', 'The termag Claude gateway could not check this request', ({ req, path }) =>
    decideClaudeRequest(
      { path, authorization: req.headers.authorization },
      { configured: getClaudeGatewayConfig() !== null, boxForToken, gatewayEnabled },
    ));
}
