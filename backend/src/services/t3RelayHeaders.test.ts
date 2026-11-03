import { describe, it, expect } from 'vitest';
import { requestHeadersToBox, responseHeadersFromBox } from './t3RelayHeaders';

describe('requestHeadersToBox', () => {
  const incoming = {
    host: 'orch.example',
    authorization: 'Bearer eyJ.termag.jwt',
    cookie: 'termag.sid=s',
    origin: 'https://evil.example',
    'x-t3-authorization': 'Bearer t3-session',
    'x-t3-origin': 't3code://app',
    'x-t3-forwarded-host': '127.0.0.1:47100',
    'x-t3-forwarded-proto': 'http',
    'x-t3-orchestration-protocol': '2',
    'x-t3-relay-delivery': 'forged',
    'x-t3-relay-delivery-id': 'forged',
    'x-forwarded-for': '10.0.0.1',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'orch.example',
    'x-amzn-trace-id': 'Root=1',
    'x-amzn-oidc-data': 'eyJ',
    'x-termag-client': 'desktop/abc',
    forwarded: 'for=1.2.3.4',
    connection: 'keep-alive, x-hop',
    'keep-alive': 'timeout=5',
    'x-hop': 'listed in Connection',
    'transfer-encoding': 'chunked',
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': '42',
    accept: 'application/json',
    'user-agent': 'termag-desktop',
    dpop: 'proof',
  };

  it('restores the t3 headers, keeps t3\'s own, and drops termag, ALB, cookie, relay-trust and hop-by-hop ones', () => {
    expect(requestHeadersToBox(incoming, 47731)).toEqual({
      host: '127.0.0.1:47731',
      authorization: 'Bearer t3-session',
      origin: 't3code://app',
      'x-forwarded-host': '127.0.0.1:47100',
      'x-forwarded-proto': 'http',
      'x-t3-orchestration-protocol': '2',
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': '42',
      accept: 'application/json',
      'user-agent': 'termag-desktop',
      dpop: 'proof',
    });
  });

  it('never forwards the termag credential or a client Origin, even without t3 headers', () => {
    const out = requestHeadersToBox({ authorization: 'Bearer eyJ.termag.jwt', origin: 'https://evil.example', accept: '*/*' }, null);
    expect(out).toEqual({ host: '127.0.0.1', accept: '*/*' });
  });

  it('drops the WebSocket handshake headers for a relayed upgrade', () => {
    const out = requestHeadersToBox({
      upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'k', 'sec-websocket-version': '13',
      'sec-websocket-extensions': 'permessage-deflate', 'sec-websocket-protocol': 'p1', 'x-t3-origin': 't3code://app',
    }, 4000, { websocket: true });
    expect(out).toEqual({ host: '127.0.0.1:4000', origin: 't3code://app' });
  });
});

describe('responseHeadersFromBox', () => {
  it('passes the box\'s headers on except hop-by-hop ones and cookies', () => {
    expect(responseHeadersFromBox({
      'content-type': 'application/json',
      'content-length': '10',
      'cache-control': 'no-store',
      'access-control-allow-origin': 't3code://app',
      'set-cookie': ['t3_session=x'],
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
    })).toEqual({
      'content-type': 'application/json',
      'content-length': '10',
      'cache-control': 'no-store',
      'access-control-allow-origin': 't3code://app',
    });
  });
});
