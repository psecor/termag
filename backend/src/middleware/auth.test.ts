import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const tokens = new Map<string, unknown>();
vi.mock('../routes/agentTokens', () => ({ validateAgentToken: async (t: string) => tokens.get(t) ?? null }));
vi.mock('../services/admin/adminAccess', () => ({ touchLastSeen: () => {} }));

const { requireAuthOrAgentToken } = await import('./auth');

const alice = { id: 'alice' };

function token(scope: string, user: unknown = alice) {
  return { user, instance: { id: 'i-1' }, token: { id: 't', scope, name: 'n' } };
}

async function run(authorization?: string) {
  const req = { headers: authorization ? { authorization } : {} } as unknown as Request;
  let status = 0;
  const res = { status: (s: number) => { status = s; return { json: () => {} }; } } as unknown as Response;
  let passed = false;
  await requireAuthOrAgentToken(req, res, () => { passed = true; });
  return { passed, status, req };
}

beforeEach(() => tokens.clear());

describe('requireAuthOrAgentToken', () => {
  it('lets an owner-bound agent token act as its owner', async () => {
    tokens.set('tmag_agent', token('agent'));
    const { passed, req } = await run('Bearer tmag_agent');
    expect(passed).toBe(true);
    expect(req.user).toBe(alice);
    expect(req.agentInstanceId).toBe('i-1');
  });

  it.each(['admin', 'client', ''])('refuses a %s-scoped token', async (scope) => {
    tokens.set('tmag_x', token(scope));
    expect(await run('Bearer tmag_x')).toMatchObject({ passed: false, status: 401 });
  });

  it('refuses an ownerless token and a missing one', async () => {
    tokens.set('tmag_warm', token('agent', null));
    expect(await run('Bearer tmag_warm')).toMatchObject({ passed: false, status: 401 });
    expect(await run()).toMatchObject({ passed: false, status: 401 });
  });
});
