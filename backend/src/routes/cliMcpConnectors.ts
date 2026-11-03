/**
 * The signed-in user's MCP broker connectors, read-only, for the desktop app's
 * Settings → Integrations: what
 * each one is and whether it works, never its header templates or secrets.
 * Adding, linking and removing them stays in termag's Settings → MCP servers.
 */
import type { RequestHandler, Response, Router } from 'express';
import { prisma } from '../db';
import { asyncHandler } from '../middleware/errors';
import type { CliUser } from '../services/cliStore';
import { listConnectors, mcpBrokerEnabledForUser } from '../services/mcpConnectorStore';
import { getMcpBrokerUrl } from '../services/mcpConnectors';
import type { CliAuth } from './cliApi';
import { view } from './mcpConnectors';

export type CliMcpConnectorStatus = 'ready' | 'needs_secrets' | 'secrets_unreadable' | 'needs_link' | 'link_failed';

export interface CliMcpConnector {
  id: string;
  name: string;
  upstream: string;
  authType: 'static' | 'oauth';
  status: CliMcpConnectorStatus;
}

export interface CliMcpConnectors {
  /** Null while mcp-broker-enabled is off for the user. */
  list(user: CliUser): Promise<{ available: boolean; connectors: CliMcpConnector[] } | null>;
}

type View = Awaited<ReturnType<typeof view>>;

/** One word for whether a connector works on the user's boxes, as Settings → MCP servers reads its row. */
export function connectorStatus(v: View): CliMcpConnectorStatus {
  if ('linkStatus' in v) return v.linkStatus === 'linked' ? 'ready' : v.linkError ? 'link_failed' : 'needs_link';
  // null: the credential store couldn't be read, so whether it works is unknown.
  if (v.secretNames === null) return 'secrets_unreadable';
  return v.missingSecrets.length > 0 ? 'needs_secrets' : 'ready';
}

export const prismaCliMcpConnectors: CliMcpConnectors = {
  async list(user) {
    const owner = await prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true },
    });
    if (!owner || !(await mcpBrokerEnabledForUser(owner))) return null;
    const broker = getMcpBrokerUrl();
    const views = await Promise.all((await listConnectors(user.id)).map(r => view(r, broker)));
    return {
      available: broker !== null,
      connectors: views.map(v => ({
        id: v.id, name: v.name, upstream: v.upstream, authType: v.authType === 'oauth' ? 'oauth' : 'static', status: connectorStatus(v),
      })),
    };
  },
};

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

export function mountCliMcpConnectorRoutes(router: Router, deps: CliMcpConnectors, bearer: RequestHandler): void {
  router.get('/mcp-connectors', bearer, asyncHandler(async (_req, res) => {
    const list = await deps.list(cliAuth(res).user);
    res.json(list ? { enabled: true, ...list } : { enabled: false, available: false, connectors: [] });
  }));
}
