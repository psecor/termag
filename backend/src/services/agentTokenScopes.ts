/**
 * Which AgentToken scopes each place that authenticates with one accepts.
 * Every scope check reads its list from here, and agentTokenScopes.test.ts
 * fails on any other read of a token's scope, or on a validateAgentToken
 * caller or gateway it doesn't know. So a new scope (the preview
 * fleet's `preview-agent`) is an explicit
 * decision at every site, never a default one of them forgot.
 */
export type AgentTokenScope = 'agent' | 'admin';

export const TOKEN_SITES = {
  /** index.ts: a box's agent socket, /ws/agent. */
  agentSocket: ['agent'],
  /** middleware/auth.ts requireAuthOrAgentToken: every owner-wide route an agent calls (MetaTerm, projects, chat, …). */
  agentRoutes: ['agent'],
  /** routes/status.ts: GET /status/:session, the agent's stale-waiting check. */
  status: ['agent'],
  /** middleware/admin.ts: /api/admin and /mcp/admin. */
  admin: ['admin'],
  /** services/cliStore.ts boxCredentialFromAgentToken: /api/cli/v1 and its socket, for a box's own CLI. */
  cliBox: ['agent'],
  /**
   * routes/cliT3.ts handleAgentTunnelUpgrade: a box's agent dialling back for
   * a tunnel its owner opened from the CLI, T3 or (since #724) a port forward.
   */
  agentTunnel: ['agent'],
  /** The gateways' ext_authz checks, through routes/gatewayCheck.ts boxForToken. */
  githubBroker: ['agent'],
  claudeGateway: ['agent'],
  fireworksGateway: ['agent'],
  mcpGateway: ['agent'],
} as const satisfies Record<string, readonly AgentTokenScope[]>;

export type TokenSite = keyof typeof TOKEN_SITES;

/** Whether a token of `scope` may authenticate at `site`. */
export function acceptsScope(site: TokenSite, scope: string): boolean {
  return (TOKEN_SITES[site] as readonly string[]).includes(scope);
}
