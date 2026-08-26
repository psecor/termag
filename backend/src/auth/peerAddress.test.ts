import { describe, it, expect } from 'vitest';
import { Request } from 'express';
import { isLocalPeer, peerAddress, PEER_HEADER } from './peerAddress';

// Minimal shape of what peerAddress() reads off a request.
function req(socketPeer: string | undefined, headers: Record<string, string | string[]> = {}): Request {
  return { socket: { remoteAddress: socketPeer }, headers } as unknown as Request;
}

describe('peerAddress — direct bind (no nginx gateway)', () => {
  it('uses the socket peer for a same-host caller', () => {
    expect(peerAddress(req('127.0.0.1'))).toBe('127.0.0.1');
    expect(isLocalPeer(req('127.0.0.1'))).toBe(true);
  });

  it('uses the socket peer for a remote caller', () => {
    expect(peerAddress(req('10.50.4.45'))).toBe('10.50.4.45');
    expect(isLocalPeer(req('10.50.4.45'))).toBe(false);
  });

  it('treats IPv6 and IPv4-mapped loopback as local', () => {
    expect(isLocalPeer(req('::1'))).toBe(true);
    expect(isLocalPeer(req('::ffff:127.0.0.1'))).toBe(true);
  });

  it('does not grant local trust when the peer is unknown', () => {
    expect(isLocalPeer(req(undefined))).toBe(false);
  });
});

describe('peerAddress — behind the nginx gateway (socket peer always loopback)', () => {
  it('reports the real client for a request nginx forwarded from off-host', () => {
    const r = req('127.0.0.1', { [PEER_HEADER]: '10.50.4.45' });
    expect(peerAddress(r)).toBe('10.50.4.45');
    // The regression this guards: without the header the socket says
    // 127.0.0.1 and a VPC box would inherit same-host trust.
    expect(isLocalPeer(r)).toBe(false);
  });

  it('still reports local for a genuine same-host caller through nginx', () => {
    const r = req('127.0.0.1', { [PEER_HEADER]: '127.0.0.1' });
    expect(isLocalPeer(r)).toBe(true);
  });

  it('falls back to the socket peer when the header is blank', () => {
    expect(isLocalPeer(req('127.0.0.1', { [PEER_HEADER]: '   ' }))).toBe(true);
  });

  it('reads the first value if the header somehow arrives repeated', () => {
    const r = req('127.0.0.1', { [PEER_HEADER]: ['10.50.4.45', '127.0.0.1'] });
    expect(peerAddress(r)).toBe('10.50.4.45');
    expect(isLocalPeer(r)).toBe(false);
  });
});

describe('peerAddress — spoofing attempts', () => {
  it('ignores a header claiming loopback when the socket peer is remote', () => {
    // A client hitting the backend port directly (bypassing nginx) cannot
    // promote itself to local by asserting the header.
    const r = req('10.50.4.45', { [PEER_HEADER]: '127.0.0.1' });
    expect(peerAddress(r)).toBe('10.50.4.45');
    expect(isLocalPeer(r)).toBe(false);
  });

  it('ignores X-Forwarded-For entirely', () => {
    // nginx appends its own $remote_addr to XFF, so a client-supplied
    // "127.0.0.1" ends up leftmost. Reading XFF would be exploitable.
    const r = req('127.0.0.1', {
      'x-forwarded-for': '127.0.0.1, 10.50.4.45',
      [PEER_HEADER]: '10.50.4.45',
    });
    expect(isLocalPeer(r)).toBe(false);
  });

  it('fails closed when a local caller declares a remote address', () => {
    expect(isLocalPeer(req('127.0.0.1', { [PEER_HEADER]: '10.50.4.45' }))).toBe(false);
  });
});
