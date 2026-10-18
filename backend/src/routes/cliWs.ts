/**
 * The CLI's WebSockets: /api/cli/v1/ws/status and /api/cli/v1/ws/terminal.
 *
 * The same status push and terminal stream the browser gets on /ws/status and
 * /ws/terminal (index.ts), reached by `termag tui` with the CLI's credential
 * instead of a cookie, and from a laptop through the one ALB rule that lets
 * /termag/api/cli/* past Okta with a JWT. The credential travels in the
 * Authorization header only: a token in the URL would land in ALB and nginx
 * access logs, so `?token=` is refused outright. It is judged exactly as the
 * HTTP routes judge it (authenticateCliBearer), so a revoked device sign-in is
 * refused here on the same terms. Neither path is /ws/agent, so a box's agent
 * token here cannot evict the box's real agent.
 *
 * A refused upgrade is answered with a plain HTTP 401/400 and the socket is
 * closed; nothing is upgraded for an unauthenticated client.
 *
 * The credential keeps being judged after the upgrade, because frames are not
 * HTTP requests and neither the ALB nor cliBearer sees them: an open socket is
 * closed at once when its device sign-in is revoked in this process
 * (`termag logout`, Settings → CLI sign-ins), and every CLI socket re-checks
 * its credential each CLI_WS_RECHECK_MS for what that cannot catch: a revoke
 * handled by the other process during an overlap deploy, the idle and maximum
 * age of a device session, a revoked or rebound box token, and an access token
 * that has expired or whose signing key was retired. That last one closes with
 * CLI_WS_REAUTH_CLOSE_CODE, which the TUI answers by dialing again with a
 * fresh access token; the others close with 1008, which it treats as final.
 */
import type { IncomingMessage } from 'http';
import type { WebSocket } from 'ws';
import { bearerToken } from '../auth/agentWsToken';
import { cliSessionValidity } from '../services/cliAuth';
import { isJwtShaped } from '../services/cliJwt';
import { authenticateCliBearer, type CliAuth, type CliBearerDeps } from './cliApi';

export type CliWsRoute = 'status' | 'terminal';

export const CLI_WS_PREFIX = '/api/cli/v1/ws/';

/** Which browser socket a CLI socket path stands in for; null for every other path. */
export function cliWsRoute(pathname: string, basePath: string): CliWsRoute | null {
  const prefix = `${basePath}${CLI_WS_PREFIX}`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  return rest === 'status' || rest === 'terminal' ? rest : null;
}

export interface CliUpgradeRefusal {
  status: 400 | 401;
  error: string;
}

export type CliUpgradeResult = { auth: CliAuth; raw: string } | CliUpgradeRefusal;

export const QUERY_TOKEN_REFUSAL = 'A token in the URL is not accepted on the CLI sockets; send Authorization: Bearer';
export const MISSING_TOKEN_REFUSAL = 'Missing bearer token; run `termag login`';

export async function authenticateCliUpgrade(
  deps: CliBearerDeps,
  req: Pick<IncomingMessage, 'headers'>,
  url: URL,
): Promise<CliUpgradeResult> {
  if (url.searchParams.has('token')) return { status: 400, error: QUERY_TOKEN_REFUSAL };
  const raw = bearerToken(req.headers.authorization);
  if (!raw) return { status: 401, error: MISSING_TOKEN_REFUSAL };
  const result = await authenticateCliBearer(deps, raw);
  return 'error' in result ? { status: 401, error: result.error } : { auth: result.auth, raw };
}

// ── after the upgrade ───────────────────────────────────────────────────────

export const CLI_WS_RECHECK_MS = 60_000;
/** Close code for a CLI socket whose credential stopped being valid; 1008 so clients stop retrying. */
export const CLI_WS_REVOKED_CLOSE_CODE = 1008;
/**
 * Close code for a socket whose access token expired (or was signed by a
 * retired key) while the sign-in behind it is still good: the client should
 * dial again at once with a fresh access token. Mirrored in tui/src/terminalSocket.ts.
 */
export const CLI_WS_REAUTH_CLOSE_CODE = 4401;

export interface CliCredentialLapse { code: number; reason: string }

/**
 * Why the credential a socket was opened with is no longer good, or null while
 * it is. An access token is held to exactly what HTTP and the ALB hold it to
 * (signature, current key, expiry), so a token taken from a laptop cannot keep
 * a socket the edge would no longer admit; its lapse asks a legitimate client
 * to re-dial with a renewed token. Behind it, the device session must still be
 * live (revoked, idle, maximum age). A box token is re-validated whole and must
 * still belong to the same user and box.
 */
export async function recheckCliCredential(
  deps: CliBearerDeps,
  opened: { auth: CliAuth; raw: string },
): Promise<CliCredentialLapse | null> {
  const now = (deps.now ?? (() => new Date()))();
  const { credential, user } = opened.auth;
  const final = (reason: string) => ({ code: CLI_WS_REVOKED_CLOSE_CODE, reason });
  if (credential.kind === 'device') {
    const session = await deps.store.findSessionById(credential.sessionId);
    if (!session || session.userId !== user.id) return final('Unknown sign-in; run `termag login`');
    const validity = cliSessionValidity(session, now);
    if (!validity.valid) {
      return final(validity.reason === 'revoked'
        ? 'This device was signed out; run `termag login`'
        : 'Sign-in expired; run `termag login`');
    }
    if (isJwtShaped(opened.raw)) {
      const claims = (await deps.jwt).verify(opened.raw, now.getTime());
      if (!claims || claims.jti !== credential.sessionId || claims.sub !== user.id) {
        return { code: CLI_WS_REAUTH_CLOSE_CODE, reason: 'Access token expired; reconnect with a fresh one' };
      }
    }
    return null;
  }
  const box = await deps.store.validateAgentToken(opened.raw);
  if (!box || box.user.id !== user.id || box.instanceId !== credential.boxId) return final('Box credential revoked');
  return null;
}

/** Open CLI sockets by device session, so a revoke here closes them at once. */
const socketsBySession = new Map<string, Set<WebSocket>>();

/**
 * Keep judging an open CLI socket's credential: register it for immediate
 * close on a device revoke, and re-check it on an interval. A failed re-check
 * (the database unreachable) keeps the socket; only a definite "no" closes it.
 */
export function watchCliSocket(
  ws: WebSocket,
  deps: CliBearerDeps,
  opened: { auth: CliAuth; raw: string },
  intervalMs = CLI_WS_RECHECK_MS,
): void {
  const { credential } = opened.auth;
  const sessionId = credential.kind === 'device' ? credential.sessionId : null;
  if (sessionId) {
    let set = socketsBySession.get(sessionId);
    if (!set) { set = new Set(); socketsBySession.set(sessionId, set); }
    set.add(ws);
  }
  const timer = setInterval(() => {
    recheckCliCredential(deps, opened).then((lapse) => {
      if (lapse) closeRevoked(ws, lapse.reason, lapse.code);
    }, () => { /* not evidence either way */ });
  }, intervalMs);
  timer.unref?.();
  ws.once('close', () => {
    clearInterval(timer);
    if (!sessionId) return;
    const set = socketsBySession.get(sessionId);
    set?.delete(ws);
    if (set && set.size === 0) socketsBySession.delete(sessionId);
  });
}

/** Close every open CLI socket of a device session; call after revoking it. */
export function closeCliSocketsForSession(sessionId: string, reason = 'This device was signed out; run `termag login`'): number {
  const set = socketsBySession.get(sessionId);
  if (!set) return 0;
  const n = set.size;
  for (const ws of [...set]) closeRevoked(ws, reason);
  return n;
}

function closeRevoked(ws: WebSocket, reason: string, code = CLI_WS_REVOKED_CLOSE_CODE): void {
  try { ws.close(code, reason); } catch { /* already closing */ }
  // A peer that never answers the close frame must not keep the PTY.
  const kill = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 5_000);
  kill.unref?.();
  ws.once('close', () => clearTimeout(kill));
}

/** The raw HTTP response that refuses an upgrade, in the CLI API's JSON shape. */
export function refusalResponse(r: CliUpgradeRefusal): string {
  const body = JSON.stringify({ error: r.error, code: r.status === 401 ? 'auth_required' : 'invalid_request' });
  const reason = r.status === 401 ? 'Unauthorized' : 'Bad Request';
  return `HTTP/1.1 ${r.status} ${reason}\r\n`
    + (r.status === 401 ? 'WWW-Authenticate: Bearer\r\n' : '')
    + 'Content-Type: application/json\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + 'Connection: close\r\n\r\n'
    + body;
}
