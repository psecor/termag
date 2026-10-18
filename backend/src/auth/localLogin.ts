// AUTH_MODE=local: sign in without an identity provider, for the local e2e
// stack (scripts/e2e). It is an authentication bypass, so the server refuses to
// start with it unless it can only be reached from the same host, and each
// sign-in is refused unless the caller really is on the same host.

import type { Request } from 'express';
import { isLocalPeer, isLoopbackAddress } from './peerAddress';

const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', '::1']);
const LOCAL_NODE_ENVS = new Set(['development', 'test']);

/** Throws unless local login is safe: an explicit dev/test NODE_ENV, bound to loopback only. */
export function assertLocalLoginAllowed(env: NodeJS.ProcessEnv): void {
  if (!LOCAL_NODE_ENVS.has(env.NODE_ENV ?? '')) {
    throw new Error(
      `AUTH_MODE=local requires NODE_ENV=development or test; got ${env.NODE_ENV ? `"${env.NODE_ENV}"` : 'none'}`,
    );
  }
  const host = env.BIND_HOST?.trim() ?? '';
  if (!LOOPBACK_BIND_HOSTS.has(host)) {
    throw new Error(
      `AUTH_MODE=local requires BIND_HOST=127.0.0.1 or ::1; got ${host ? `"${host}"` : 'none (all interfaces)'}`,
    );
  }
}

/** Clients named in X-Forwarded-For and Forwarded, in header order. */
export function forwardedClients(req: Request): string[] {
  const header = (name: string) => [req.headers[name] ?? []].flat().join(',');
  const xff = header('x-forwarded-for').split(',').map(s => s.trim()).filter(Boolean);
  const fwd = [...header('forwarded').matchAll(/for="?\[?([^\]",;]+)/gi)].map(m => m[1].trim());
  return [...xff, ...fwd];
}

/**
 * True when a sign-in request comes from this host. A loopback bind is not
 * enough on its own: a same-host reverse proxy (the nginx gateway, Apache)
 * makes every socket peer loopback, so a proxied request must also say, in the
 * gateway's peer header or in its forwarding headers, that the client is local.
 * Forwarding headers are client-appendable, so they are only used to refuse.
 */
export function isSameHostRequest(req: Request): boolean {
  return isLocalPeer(req) && forwardedClients(req).every(isLoopbackAddress);
}
