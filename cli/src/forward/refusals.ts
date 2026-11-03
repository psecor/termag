import type { ForwardPort } from './ports.js';

/**
 * The orchestrator's refusal codes for the forward socket and its probe
 * (contract section 1). Each is a plain HTTP answer with a JSON body
 * `{ error, code }`, given before any upgrade.
 */
export type RefusalCode =
  | 'not_found'
  | 'forbidden'
  | 'bad_port'
  | 'box_parked'
  | 'box_not_ready'
  | 'box_outdated'
  | 'draining'
  | 'too_many_tunnels'
  | 'port_refused'
  | 'port_closed'
  | 'tunnel_failed'
  /** Only v1 offered, after the orchestrator's FORWARD_V1_REFUSE_AFTER. */
  | 'cli_outdated';

/** Worth one more try on a new connection: an overlap deploy's dial-back or a draining process. */
export const RETRY_CODES: ReadonlySet<string> = new Set(['tunnel_failed', 'draining']);

/** The WebSocket close codes of contract section 4. */
export const CLOSE = {
  NORMAL: 1000,
  REVOKED: 1008,
  ERROR: 1011,
  DRAINING: 1012,
  TOKEN_LAPSED: 4401,
  /** v2: the access token expired with no valid renewal, or the renewal was refused. */
  TOKEN_NOT_RENEWED: 4402,
  /** v2: the orchestrator refused a renewed token (another sign-in's, say). */
  RENEWAL_REFUSED: 4406,
  /** The forward reached its 12 h lifetime from the upgrade. */
  LIFETIME: 4408,
  PARKED: 4409,
} as const;

/** What `termag ssh` would do instead, for when the native forward can't. */
export function sshFallback(boxName: string, ports: ForwardPort[]): string {
  const flags = ports.map(p => `-L ${p.local}:localhost:${p.port}`).join(' ');
  return `termag ssh ${boxName} -N ${flags}`;
}

/** Whether a refusal from the probe means "use `termag ssh -L` for now" rather than "fix something". */
export function suggestsSsh(code: string): boolean {
  return code === 'not_found' || code === 'box_outdated';
}

/**
 * One line saying what a refusal means and what to do. `port` is set for a
 * connection's refusal and unset for the probe's; `error` is the
 * orchestrator's own text (the agent's reason, for `port_refused`).
 */
export function describeRefusal(code: string, at: { box: string; host: string; port?: number; error?: string }): string {
  const { box } = at;
  const port = at.port === undefined ? 'that port' : `port ${at.port}`;
  switch (code) {
    case 'not_found':
      return `termag-native forwarding isn't available for ${box} yet: the orchestrator at ${at.host} doesn't offer it, or it isn't turned on for you`;
    case 'forbidden':
      return 'forwarding needs this device signed in with `termag login`; a box\'s own credentials can\'t forward';
    case 'bad_port':
      return `the orchestrator refused ${port}: ports run from 1 to 65535`;
    case 'box_parked':
      return `${box} is stopped or hibernated, and a forward never starts it; run \`termag box start ${box}\` and try again`;
    case 'box_not_ready':
      return `${box} isn't ready yet (its agent hasn't connected); try again in a minute`;
    case 'box_outdated':
      return `${box}'s agent predates port forwarding; it needs an update before it can forward`;
    case 'draining':
      return 'the orchestrator is restarting (a deploy); try again in a few seconds';
    case 'too_many_tunnels':
      // Two limits share this code (the box's cap, and the orchestrator's own ceiling, which clears by itself): its text says which.
      return at.error ? `the orchestrator refused another connection to ${box}: ${at.error}` : `${box} already has as many forwarded connections open as the orchestrator allows; close some`;
    case 'port_refused':
      return `${box} refused to forward ${port}${at.error ? `: ${at.error}` : ''}`;
    case 'port_closed':
      return `nothing listens on ${port} on ${box}`;
    case 'cli_outdated':
      return 'this termag is too old for the forward: run `termag update`';
    case 'tunnel_failed':
      return `the orchestrator couldn't open a tunnel to ${box} in time`;
    default:
      return at.error ?? `the orchestrator refused the forward (${code})`;
  }
}

/** What a close code on a live connection means, for the notice about a dropped connection. */
export function describeClose(code: number, box: string): string {
  switch (code) {
    case CLOSE.ERROR: return `the connection to ${box} was reset`;
    case CLOSE.DRAINING: return 'the orchestrator restarted (a deploy)';
    case CLOSE.PARKED: return `${box} was stopped or hibernated`;
    case CLOSE.REVOKED: return 'this device\'s sign-in was revoked; run `termag login`';
    case CLOSE.TOKEN_LAPSED: return 'its access token lapsed';
    case CLOSE.TOKEN_NOT_RENEWED: return 'its access token expired before a renewed one reached the orchestrator';
    case CLOSE.RENEWAL_REFUSED: return 'the orchestrator refused its renewed access token (from a different sign-in?)';
    case CLOSE.LIFETIME: return 'it reached the orchestrator\'s 12 h limit';
    case 1006: return `the connection to the orchestrator dropped`;
    default: return `the orchestrator closed it (${code})`;
  }
}
