// Who is the caller, at the TCP level?
//
// The orchestrator host is termag's local trust boundary: a same-host caller
// (the Claude Code hooks curl localhost) is trusted for things a remote caller
// has to authenticate for — see authStatusWrite in routes/status.ts. Getting
// "same host" right therefore has to survive both deployment shapes:
//
//   * direct bind (older cloud-init): the backend owns :3040, so its own socket
//     peer IS the client and no gateway header exists.
//   * nginx gateway (orchestrator AMI with deploy/nginx/termag-gateway.conf):
//     the backend binds 127.0.0.1:3100 behind nginx, so EVERY socket peer is
//     loopback. Read naively, the socket now says "same host" for ALB users and
//     VPC box agents alike, handing local trust to anything that can reach
//     :3040.
//
// nginx closes that by re-stating the peer it actually accepted the connection
// from in X-Termag-Peer-Addr (deploy/nginx/termag-proxy.conf). It uses
// `proxy_set_header`, which OVERWRITES any client-supplied value, so the header
// cannot be forged from outside. Deliberately NOT X-Forwarded-For: that is a
// client-appendable chain, and reading its leftmost entry is exactly the
// spoofable mistake this avoids.

import { Request } from 'express';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const PEER_HEADER = 'x-termag-peer-addr';

/**
 * The address the request really arrived from.
 *
 * The gateway header is only honoured when our own socket peer is loopback,
 * i.e. when nginx (or another same-host process) handed us the request. A
 * remote client that reaches the backend port directly is a non-loopback peer,
 * so its header is ignored and it can never talk its way into local trust. A
 * missing or blank header falls back to the socket peer, which is what keeps
 * the direct-bind deployment working unchanged.
 */
export function peerAddress(req: Request): string {
  const socketPeer = req.socket.remoteAddress ?? '';
  if (!LOOPBACK.has(socketPeer)) return socketPeer;
  const raw = req.headers[PEER_HEADER];
  const declared = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return declared || socketPeer;
}

/** True when the caller is genuinely on this host. */
export function isLocalPeer(req: Request): boolean {
  return LOOPBACK.has(peerAddress(req));
}
