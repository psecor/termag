// How a box agent presents its token on the /ws/agent upgrade.
//
// Agents send `Authorization: Bearer tmag_…`. Agents from before that sent the
// token as `?token=`, which put it in every nginx (and ALB) request line on the
// orchestrator, so the query form is accepted only while old agents remain and
// is counted so the admin System page shows when none are left. Set
// AGENT_WS_QUERY_TOKEN=false to refuse it.
//
// The refusal reasons are close-frame text an agent can see. 'token param
// required' is what orchestrators before the header sent for a missing token,
// and agent/agent.js falls back to the query form on exactly that reason, so
// no reason here may reuse it.
import type { IncomingHttpHeaders } from 'http';

export type AgentTokenForm = 'header' | 'query';

export type AgentWsToken =
  | { token: string; form: AgentTokenForm }
  | { refusal: string };

export const MISSING_TOKEN_REFUSAL = 'authorization required';
export const QUERY_TOKEN_REFUSAL = 'token query parameter not accepted; send Authorization: Bearer';

export function queryTokenAccepted(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AGENT_WS_QUERY_TOKEN ?? '').trim().toLowerCase() !== 'false';
}

export function bearerToken(authorization: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
  return m ? m[1] : null;
}

/** The header wins when both are present; a non-Bearer header counts as absent. */
export function agentWsToken(
  headers: IncomingHttpHeaders,
  url: URL,
  env: NodeJS.ProcessEnv = process.env,
): AgentWsToken {
  const header = bearerToken(headers.authorization);
  if (header) return { token: header, form: 'header' };
  const query = url.searchParams.get('token');
  if (!query) return { refusal: MISSING_TOKEN_REFUSAL };
  if (!queryTokenAccepted(env)) return { refusal: QUERY_TOKEN_REFUSAL };
  return { token: query, form: 'query' };
}

export interface QueryFormAgent {
  userId: string | null;
  instanceId: string | null;
  since: string;
}

export class AgentTokenFormCounter {
  private totals: Record<AgentTokenForm, number> = { header: 0, query: 0 };
  private refusedQuery = 0;
  private live = new Map<object, QueryFormAgent>();

  /** Call once per authenticated connection; `conn` identifies it until `closed`. */
  connected(conn: object, form: AgentTokenForm, who: { userId: string | null; instanceId: string | null }, now = new Date()): number {
    this.totals[form] += 1;
    if (form === 'query') this.live.set(conn, { ...who, since: now.toISOString() });
    return this.totals[form];
  }

  closed(conn: object): void {
    this.live.delete(conn);
  }

  refused(): void {
    this.refusedQuery += 1;
  }

  snapshot(env: NodeJS.ProcessEnv = process.env) {
    return {
      queryAccepted: queryTokenAccepted(env),
      sinceStart: { ...this.totals, refusedQuery: this.refusedQuery },
      queryFormConnected: [...this.live.values()],
    };
  }
}

export const agentTokenForms = new AgentTokenFormCounter();
