import type { Router } from 'express';
import type { CallerProofConfig } from '../services/callerIdentity';
import { termagUrlFromEnv } from '../services/claudeRunnerNotices';
import { decideApiRequest, isApiBrokerPath } from '../services/apiBroker';
import { decideMcpRequest } from '../services/mcpAuthz';
import {
  apiBrokerEnabledForBox, findConnector, listConnectors, oauthAccessToken, readConnectorSecrets,
} from '../services/mcpConnectorStore';
import { upstreamTestAllow } from '../services/mcpConnectors';
import { boxForTokenAt, gatewayCheckRouter } from './gatewayCheck';

/**
 * Envoy's ext_authz check for the MCP broker listener: every request a box
 * makes to <broker>/c/<connector id>/… (an MCP server)
 * or <broker>/c/<provider>@<host>/… (a provider's REST API, "Plain HTTP
 * APIs"), path appended, no body.
 */
export function mcpAuthzRouter(cfg: CallerProofConfig): Router {
  return gatewayCheckRouter(cfg, 'MCP-AUTHZ', 'The termag MCP broker could not check this request', ({ req, path }) => {
    const boxForToken = boxForTokenAt('mcpGateway');
    if (isApiBrokerPath(path)) {
      return decideApiRequest({ path, authorization: req.headers.authorization }, {
        boxForToken,
        flagOn: box => apiBrokerEnabledForBox(box.userId, box.instanceId),
        connectors: listConnectors,
        accessToken: oauthAccessToken,
        termagUrl: termagUrlFromEnv(),
      });
    }
    return decideMcpRequest(
      { path, authorization: req.headers.authorization },
      {
        boxForToken,
        connector: findConnector,
        secrets: readConnectorSecrets,
        accessToken: oauthAccessToken,
        termagUrl: termagUrlFromEnv(),
        allow: upstreamTestAllow(),
      },
    );
  }, { quietAllow: true });
}
