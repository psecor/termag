import type { Router } from 'express';
import type { CallerProofConfig } from '../services/callerIdentity';
import { termagUrlFromEnv } from '../services/claudeRunnerNotices';
import { decideMcpRequest } from '../services/mcpAuthz';
import { findConnector, mcpBrokerEnabledForBox, oauthAccessToken, readConnectorSecrets } from '../services/mcpConnectorStore';
import { upstreamTestAllow } from '../services/mcpConnectors';
import { boxForToken, gatewayCheckRouter } from './gatewayCheck';

/**
 * Envoy's ext_authz check for the MCP broker listener: every request a box's
 * Claude Code makes to <broker>/c/<connector id>/…, path appended, no body.
 */
export function mcpAuthzRouter(cfg: CallerProofConfig): Router {
  return gatewayCheckRouter(cfg, 'MCP-AUTHZ', 'The termag MCP broker could not check this request', ({ req, path }) =>
    decideMcpRequest(
      { path, authorization: req.headers.authorization },
      {
        boxForToken,
        flagOn: box => mcpBrokerEnabledForBox(box.userId, box.instanceId),
        connector: findConnector,
        secrets: readConnectorSecrets,
        accessToken: oauthAccessToken,
        termagUrl: termagUrlFromEnv(),
        allow: upstreamTestAllow(),
      },
    ), { quietAllow: true });
}
