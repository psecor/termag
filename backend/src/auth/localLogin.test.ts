import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { assertLocalLoginAllowed, isSameHostRequest } from './localLogin';
import { PEER_HEADER } from './peerAddress';

describe('assertLocalLoginAllowed', () => {
  it('allows a development or test server bound to IPv4 or IPv6 loopback', () => {
    expect(() => assertLocalLoginAllowed({ NODE_ENV: 'development', BIND_HOST: '127.0.0.1' })).not.toThrow();
    expect(() => assertLocalLoginAllowed({ NODE_ENV: 'test', BIND_HOST: '::1' })).not.toThrow();
  });

  it('refuses production even when bound to loopback', () => {
    expect(() => assertLocalLoginAllowed({ NODE_ENV: 'production', BIND_HOST: '127.0.0.1' }))
      .toThrow(/"production"/);
  });

  it('refuses an unset or unrecognised NODE_ENV, so a unit without one fails closed', () => {
    expect(() => assertLocalLoginAllowed({ BIND_HOST: '127.0.0.1' })).toThrow(/NODE_ENV=development or test; got none/);
    expect(() => assertLocalLoginAllowed({ NODE_ENV: 'staging', BIND_HOST: '127.0.0.1' })).toThrow(/"staging"/);
  });

  it('refuses a server listening on all interfaces', () => {
    expect(() => assertLocalLoginAllowed({ NODE_ENV: 'development' })).toThrow(/all interfaces/);
    expect(() => assertLocalLoginAllowed({ NODE_ENV: 'development', BIND_HOST: '  ' })).toThrow(/all interfaces/);
    expect(() => assertLocalLoginAllowed({ NODE_ENV: 'development', BIND_HOST: '0.0.0.0' })).toThrow(/"0.0.0.0"/);
    expect(() => assertLocalLoginAllowed({ NODE_ENV: 'development', BIND_HOST: '::' })).toThrow(/"::"/);
  });

  it('refuses names that only usually resolve to loopback', () => {
    expect(() => assertLocalLoginAllowed({ NODE_ENV: 'development', BIND_HOST: 'localhost' })).toThrow(/"localhost"/);
    expect(() => assertLocalLoginAllowed({ NODE_ENV: 'development', BIND_HOST: '10.0.0.5' })).toThrow(/"10.0.0.5"/);
  });
});

function req(socketPeer: string, headers: Record<string, string | string[]> = {}): Request {
  return { socket: { remoteAddress: socketPeer }, headers } as unknown as Request;
}

describe('isSameHostRequest', () => {
  it('accepts a direct loopback caller and one proxied from loopback', () => {
    expect(isSameHostRequest(req('127.0.0.1'))).toBe(true);
    expect(isSameHostRequest(req('::1', { 'x-forwarded-for': '127.0.0.1' }))).toBe(true);
    expect(isSameHostRequest(req('127.0.0.1', { [PEER_HEADER]: '127.0.0.1', 'x-forwarded-for': '127.0.0.1' }))).toBe(true);
  });

  it('refuses a remote socket peer', () => {
    expect(isSameHostRequest(req('10.0.0.5'))).toBe(false);
  });

  it('refuses an off-host client that the nginx gateway forwarded to the loopback backend', () => {
    expect(isSameHostRequest(req('127.0.0.1', { [PEER_HEADER]: '10.50.4.45' }))).toBe(false);
  });

  it('refuses an off-host client that a proxy with no peer header named in X-Forwarded-For or Forwarded', () => {
    expect(isSameHostRequest(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }))).toBe(false);
    expect(isSameHostRequest(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' }))).toBe(false);
    expect(isSameHostRequest(req('127.0.0.1', { forwarded: 'for=203.0.113.9;proto=https' }))).toBe(false);
    expect(isSameHostRequest(req('127.0.0.1', { forwarded: 'for="[2001:db8::1]:443"' }))).toBe(false);
  });
});
