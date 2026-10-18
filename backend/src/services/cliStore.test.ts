import { describe, it, expect } from 'vitest';
import { boxCredentialFromAgentToken } from './cliStore';

const alice = { id: 'u1', googleEmail: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice' };

describe('boxCredentialFromAgentToken', () => {
  it('accepts an owner-bound agent token, with or without a box', () => {
    expect(boxCredentialFromAgentToken({ user: alice, instance: { id: 'i-1' }, token: { scope: 'agent' } }))
      .toEqual({ user: alice, instanceId: 'i-1' });
    expect(boxCredentialFromAgentToken({ user: alice, instance: null, token: { scope: 'agent' } }))
      .toEqual({ user: alice, instanceId: null });
  });

  it('refuses admin, client and unknown scopes', () => {
    for (const scope of ['admin', 'client', 'Agent', '']) {
      expect(boxCredentialFromAgentToken({ user: alice, instance: { id: 'i-1' }, token: { scope } })).toBeNull();
    }
  });

  it('refuses an ownerless warm-pool token and an invalid one', () => {
    expect(boxCredentialFromAgentToken({ user: null, instance: { id: 'i-1' }, token: { scope: 'agent' } })).toBeNull();
    expect(boxCredentialFromAgentToken(null)).toBeNull();
  });
});
