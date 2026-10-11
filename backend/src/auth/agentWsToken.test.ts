import { describe, expect, it } from 'vitest';
import {
  AgentTokenFormCounter,
  MISSING_TOKEN_REFUSAL,
  QUERY_TOKEN_REFUSAL,
  agentWsToken,
  bearerToken,
  queryTokenAccepted,
} from './agentWsToken';

const url = (q = '') => new URL(`http://localhost/termag/ws/agent${q}`);

describe('bearerToken', () => {
  it('reads a Bearer credential, case-insensitively', () => {
    expect(bearerToken('Bearer tmag_abc')).toBe('tmag_abc');
    expect(bearerToken('bearer tmag_abc')).toBe('tmag_abc');
  });

  it('ignores other schemes and empty credentials', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    expect(bearerToken('Bearer ')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
  });
});

describe('agentWsToken', () => {
  it('takes the token from the Authorization header', () => {
    expect(agentWsToken({ authorization: 'Bearer tmag_h' }, url(), {})).toEqual({ token: 'tmag_h', form: 'header' });
  });

  it('prefers the header when an agent sends both', () => {
    expect(agentWsToken({ authorization: 'Bearer tmag_h' }, url('?token=tmag_q'), {})).toEqual({ token: 'tmag_h', form: 'header' });
  });

  it('accepts the query form by default, for agents from before the header', () => {
    expect(agentWsToken({}, url('?token=tmag_q'), {})).toEqual({ token: 'tmag_q', form: 'query' });
  });

  it('falls back to the query when the header is not a Bearer credential', () => {
    expect(agentWsToken({ authorization: 'Basic x' }, url('?token=tmag_q'), {})).toEqual({ token: 'tmag_q', form: 'query' });
  });

  it('refuses the query form when AGENT_WS_QUERY_TOKEN=false', () => {
    expect(agentWsToken({}, url('?token=tmag_q'), { AGENT_WS_QUERY_TOKEN: 'false' })).toEqual({ refusal: QUERY_TOKEN_REFUSAL });
    expect(agentWsToken({ authorization: 'Bearer tmag_h' }, url(), { AGENT_WS_QUERY_TOKEN: 'false' }))
      .toEqual({ token: 'tmag_h', form: 'header' });
  });

  it('refuses a connection with no token', () => {
    expect(agentWsToken({}, url(), {})).toEqual({ refusal: MISSING_TOKEN_REFUSAL });
    expect(agentWsToken({}, url('?token='), {})).toEqual({ refusal: MISSING_TOKEN_REFUSAL });
  });

  it("never reuses the old orchestrators' reason, which new agents treat as 'send the query form'", () => {
    expect([MISSING_TOKEN_REFUSAL, QUERY_TOKEN_REFUSAL]).not.toContain('token param required');
    for (const r of [MISSING_TOKEN_REFUSAL, QUERY_TOKEN_REFUSAL]) expect(Buffer.byteLength(r)).toBeLessThanOrEqual(123);
  });
});

describe('queryTokenAccepted', () => {
  it('is on unless set to false', () => {
    expect(queryTokenAccepted({})).toBe(true);
    expect(queryTokenAccepted({ AGENT_WS_QUERY_TOKEN: 'true' })).toBe(true);
    expect(queryTokenAccepted({ AGENT_WS_QUERY_TOKEN: ' FALSE ' })).toBe(false);
  });
});

describe('AgentTokenFormCounter', () => {
  it('counts both forms and lists the query-form agents still connected', () => {
    const c = new AgentTokenFormCounter();
    const a = {}, b = {}, h = {};
    expect(c.connected(a, 'query', { userId: 'u1', instanceId: 'i1' }, new Date('2026-10-06T00:00:00Z'))).toBe(1);
    expect(c.connected(b, 'query', { userId: 'u2', instanceId: null })).toBe(2);
    expect(c.connected(h, 'header', { userId: 'u3', instanceId: 'i3' })).toBe(1);
    c.refused();
    c.closed(b);
    c.closed(h);
    expect(c.snapshot({})).toEqual({
      queryAccepted: true,
      sinceStart: { header: 1, query: 2, refusedQuery: 1 },
      queryFormConnected: [{ userId: 'u1', instanceId: 'i1', since: '2026-10-06T00:00:00.000Z' }],
    });
  });
});
