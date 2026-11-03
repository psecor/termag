import type { AgentStatus } from '../types';

/**
 * One status push on the status socket, /ws/status and the CLI's
 * /api/cli/v1/ws/status (index.ts): the session's whole AgentStatus, its
 * dates as ISO strings. A contract with shipped clients (the browser's
 * utils/statusPush.ts, the TUI, `termag events`): add fields, never rename
 * or remove them.
 */
export function statusFrame(session: string, status: AgentStatus): string {
  return JSON.stringify({ type: 'status', session, ...status });
}
