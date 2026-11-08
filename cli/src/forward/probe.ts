import type { Api } from '../api.js';
import { CliError } from '../errors.js';
import type { ForwardPort } from './ports.js';
import { describeRefusal, RETRY_CODES, sshFallback, suggestsSsh } from './refusals.js';

export const FORWARD_CAPABILITY = 'port-forward-v1';

export type ProbeResult =
  | { ok: true; capability: string; maxConnections: number | null }
  | {
    ok: false;
    code: string;
    status: number | undefined;
    /** What it means and what to do, without the ssh suggestion. */
    message: string;
    /** `termag ssh <box> -N -L …` for these ports, when the forward is unavailable rather than misused. */
    fallback: string | null;
  };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Ask the orchestrator whether it would forward to this box (contract section
 * 2), before any listener is bound. A refusal comes back as `ok: false`; a
 * failure to ask at all (unreachable, signed out, the edge) is thrown as the
 * Api's CliError. One retry while the orchestrator drains.
 */
export async function probeForward(
  api: Api,
  box: { id: string; name: string },
  ports: ForwardPort[],
  opts: { retryDelayMs?: number } = {},
): Promise<ProbeResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      const body = await api.request<{ ok?: boolean; capability?: string; maxConnections?: number }>(
        'GET', `/boxes/${encodeURIComponent(box.id)}/forward`);
      return {
        ok: true,
        capability: body.capability ?? FORWARD_CAPABILITY,
        maxConnections: typeof body.maxConnections === 'number' ? body.maxConnections : null,
      };
    } catch (err) {
      if (!(err instanceof CliError) || err.status === undefined || err.status === 401 || err.code === 'edge_auth'
        || err.code === 'not_cli_enabled' || err.code === 'unreachable') throw err;
      const code = typeof err.body?.code === 'string' ? err.body.code : err.status === 404 ? 'not_found' : 'failed';
      if (RETRY_CODES.has(code) && attempt === 0) { await sleep(opts.retryDelayMs ?? 1000); continue; }
      const error = typeof err.body?.error === 'string' ? err.body.error : undefined;
      return {
        ok: false,
        code,
        status: err.status,
        message: describeRefusal(code, { box: box.name, host: api.host, error }),
        fallback: suggestsSsh(code) ? sshFallback(box.name, ports) : null,
      };
    }
  }
}
