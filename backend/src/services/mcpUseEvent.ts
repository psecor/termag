/**
 * Which MCP servers agents use (docs/agents/observability.md,
 * `agent.mcp.used`): the PostToolUse and PostToolUseFailure hooks
 * (deploy/termag-status post-tool, post-tool-failure) send, for each
 * `mcp__<server>__<tool>` call, the server and tool names, whether it failed,
 * and Claude Code's session id; never the arguments or the result. Agent
 * telemetry can't say this itself: with OTEL_LOG_TOOL_DETAILS off every MCP
 * call logs as `custom`.
 *
 * Only a known server is named: termag's own and the ones the
 * mcp-default-connectors catalog offers. Any other is `other` with no tool,
 * since a person's own server, and its tools, can be called anything. Pure.
 */

/**
 * The route's on switch: off, POST /api/status/mcp
 * answers 404 like an orchestrator that predates it, which the hook ignores,
 * and records nothing. Read for the user, per call.
 */
export const AGENT_MCP_EVENTS_FLAG = 'agent-mcp-events-enabled';

/**
 * The servers termag delivers or recommends, named whether or not today's
 * catalog lists them: metaterm (services/metaterm.ts), an observability
 * server under each name it goes by, and the connectors people link most.
 */
export const KNOWN_MCP_SERVERS = [
  'metaterm',
  'acme-observability', 'acme-flags', 'acme-observability-dev',
  'slack', 'atlassian', 'datadog', 'incident-io', 'meticulous', 'github', 'linear', 'notion', 'sentry',
] as const;

export const MCP_OUTCOMES = ['ok', 'error'] as const;
export type McpOutcome = typeof MCP_OUTCOMES[number];

// Claude Code's server names are [A-Za-z0-9_-]; a tool name can add dots.
const SERVER = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL = /^[A-Za-z0-9_.-]{1,64}$/;
const CLAUDE_SESSION = /^[A-Za-z0-9-]{8,64}$/;

export interface McpUse {
  /** The termag tmux session the hook ran in. */
  session: string;
  server: string;
  tool: string;
  outcome: McpOutcome;
  /** Claude Code's session.id, which its spans carry, when the hook had one. */
  claudeSession: string | null;
}

export function parseMcpUseBody(body: unknown): McpUse | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'body must be an object' };
  const { session, server, tool, outcome, claudeSession } = body as Record<string, unknown>;
  if (typeof session !== 'string' || !session) return { error: 'session required' };
  if (typeof server !== 'string' || !SERVER.test(server)) return { error: 'server must be an MCP server name' };
  if (typeof tool !== 'string' || !TOOL.test(tool)) return { error: 'tool must be an MCP tool name' };
  if (typeof outcome !== 'string' || !(MCP_OUTCOMES as readonly string[]).includes(outcome)) return { error: `outcome must be one of ${MCP_OUTCOMES.join(', ')}` };
  const cs = typeof claudeSession === 'string' && CLAUDE_SESSION.test(claudeSession) ? claudeSession : null;
  return { session, server, tool, outcome: outcome as McpOutcome, claudeSession: cs };
}

/** The event's detail: the server and tool when the server is known, else `other` and no tool. */
export function mcpUseDetail(use: McpUse, catalogNames: readonly string[]): { server: string; tool?: string; outcome: McpOutcome; claudeSession: string | null } {
  const known = (KNOWN_MCP_SERVERS as readonly string[]).includes(use.server) || catalogNames.includes(use.server);
  return known
    ? { server: use.server, tool: use.tool, outcome: use.outcome, claudeSession: use.claudeSession }
    : { server: 'other', outcome: use.outcome, claudeSession: use.claudeSession };
}
