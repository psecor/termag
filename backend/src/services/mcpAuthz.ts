/**
 * The MCP broker's ext_authz decision. A box's Claude
 * Code calls <broker>/c/<connector id>/… with the box's own agent token;
 * Envoy asks this whether to forward and where. The allow names the upstream
 * (x-termag-mcp-upstream) and the headers to send it (x-termag-mcp-h-<name>);
 * Envoy drops the box's token and every other x-termag-* header itself.
 *
 * Refusals are 403 and 404, never 401: a 401 from the broker would start
 * Claude Code's own OAuth discovery against it.
 */

import { boxTokenFrom } from './githubBroker';
import type { AuthzBox, AuthzDecision, BoxForToken } from './gatewayAuthz';
import { McpConnectorError, parseUpstream, relinkMessage, renderHeaders, validateHeaderTemplates, type Secrets } from './mcpConnectors';
import { McpNeedsLinkError } from './mcpOAuth';

export interface McpConnectorRecord {
  id: string;
  userId: string;
  name: string;
  upstream: string;
  authType: string;
  headerTemplates: unknown;
  oauthMetadata?: unknown;
}

export interface McpAuthzRequest {
  path: string;
  authorization: string | undefined;
}

export interface McpAuthzDeps {
  boxForToken: BoxForToken;
  // mcp-broker-enabled for the box's owner and the box.
  flagOn: (box: AuthzBox) => Promise<boolean>;
  // The connector by id, whoever owns it; never cached.
  connector: (id: string) => Promise<McpConnectorRecord | null>;
  secrets: (userId: string, connectorId: string) => Promise<Secrets>;
  // oauth: the access token, refreshed if it is about to expire; throws
  // McpNeedsLinkError when the user has to link (again).
  accessToken: (connector: McpConnectorRecord) => Promise<string>;
  termagUrl: string | null;
  allow?: Set<string>;
}

const CONNECTOR_PATH = /^\/c\/([a-z0-9]{1,40})(?:[/?]|$)/;

function deny(status: number, message: string, audit: string): AuthzDecision {
  return { allow: false, status, message, audit };
}

const NOT_FOUND = 'No such MCP connector for this box\'s owner';

/**
 * Order: the box token and a managed box, then the flag, then a connector the
 * box's owner owns (404 for anyone else's, so its existence never shows),
 * then its headers. No secret or upstream header value reaches an audit line.
 */
export async function decideMcpRequest(req: McpAuthzRequest, deps: McpAuthzDeps): Promise<AuthzDecision> {
  const token = boxTokenFrom(req.authorization);
  if (!token) return deny(403, "The termag MCP broker needs this box's agent token (termag-mcp-headers)", 'no box token');
  const box = await deps.boxForToken(token);
  if (!box) return deny(403, 'Unknown or revoked box token', 'unknown box token');
  if (!box.managed) return deny(403, 'Only a termag-managed box can use the MCP broker', `instance=${box.instanceId} not a managed box`);
  const who = `user=${box.userId} instance=${box.instanceId}`;
  if (!await deps.flagOn(box)) {
    return deny(403, 'MCP connectors through termag are not enabled for you (feature flag mcp-broker-enabled)', `${who} flag off`);
  }
  const id = CONNECTOR_PATH.exec(req.path)?.[1];
  if (!id) return deny(404, NOT_FOUND, `${who} no connector in path`);
  const connector = await deps.connector(id);
  if (!connector || connector.userId !== box.userId) return deny(404, NOT_FOUND, `${who} connector=${id} not found`);
  const relink = relinkMessage(connector.name, connector.id, deps.termagUrl);
  const at = `${who} connector=${id}`;
  let headers: Record<string, string>;
  if (connector.authType === 'oauth') {
    try {
      headers = { authorization: `Bearer ${await deps.accessToken(connector)}` };
    } catch (err) {
      if (err instanceof McpNeedsLinkError) return deny(403, relink, `${at} needs link (${err.message.slice(0, 200)})`);
      return deny(403, `MCP server "${connector.name}": termag could not get a token for it; try again, or re-link it on the termag Settings page`,
        `${at} token error ${(err as Error).message.slice(0, 200)}`);
    }
  } else if (connector.authType === 'static') {
    try {
      // Re-checked on every request: a row written under looser rules must not
      // set a header the broker reserves.
      const templates = validateHeaderTemplates(connector.headerTemplates);
      headers = renderHeaders(templates, await deps.secrets(box.userId, connector.id));
    } catch (err) {
      if (!(err instanceof McpConnectorError)) throw err;
      return deny(403, `MCP server "${connector.name}": ${err.message}. Set it on the termag Settings page`, `${at} ${err.message}`);
    }
  } else {
    return deny(403, relink, `${at} unknown auth type ${connector.authType}`);
  }
  let target: string;
  try {
    target = parseUpstream(connector.upstream, deps.allow).envoyTarget;
  } catch {
    return deny(403, `MCP server "${connector.name}" has an upstream termag no longer accepts; fix it on the termag Settings page`, `${at} bad upstream`);
  }
  return {
    allow: true,
    audit: `${at} ${req.path.slice(0, 200)} allowed`,
    headers: {
      'x-termag-user': box.userId,
      'x-termag-instance': box.instanceId,
      'x-termag-mcp-connector': connector.id,
      'x-termag-mcp-relink': relink,
      'x-termag-mcp-upstream': target,
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [`x-termag-mcp-h-${k}`, v])),
    },
  };
}
