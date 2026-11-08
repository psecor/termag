import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../routes/agentTokens', () => ({ validateAgentToken: vi.fn() }));

import { summarizeArgs, auditOutcome } from './admin';

describe('auditOutcome', () => {
  it('maps status codes to the audit vocabulary', () => {
    expect([200, 302, 401, 403, 404, 400, 429, 500].map(auditOutcome)).toEqual(['ok', 'ok', 'denied', 'denied', 'not_found', 'rejected', 'rejected', 'error']);
  });
});

describe('summarizeArgs', () => {
  it('keeps query, params and scalar body fields; elides structures and long strings', () => {
    const out = summarizeArgs({
      query: { range: '7d' },
      params: { id: 'abc' },
      body: { name: 'x'.repeat(250), confirm: true, nested: { a: 1 }, list: [1, 2, 3], n: null },
    } as never);
    expect(out).toMatchObject({ range: '7d', id: 'abc', confirm: true, nested: '{…}', list: '[3 items]', n: null });
    expect((out!.name as string).length).toBe(201);
  });

  it('records a secret-named field as redacted, never its value: a pasted token stays out of the audit log', () => {
    const PAT = 'github_pat_AUDITsentinelAUDITsentinel0123'; // gitleaks:allow (test sentinel)
    const out = summarizeArgs({
      query: { access_token: PAT }, params: {},
      body: { token: PAT, clientSecret: PAT, password: PAT, tokenId: 'tok1', name: 'pool' },
    } as never);
    expect(JSON.stringify(out)).not.toContain(PAT);
    expect(out).toMatchObject({ token: '[redacted]', clientSecret: '[redacted]', password: '[redacted]', access_token: '[redacted]', tokenId: 'tok1', name: 'pool' });
  });

  it('returns null when there is nothing to record', () => {
    expect(summarizeArgs({ query: {}, params: {}, body: undefined } as never)).toBeNull();
  });
});
