import { describe, it, expect } from 'vitest';
import { parseAdminUsers } from '../../auth/adminUsers';
import { planAdminSync } from './adminAccess';

describe('planAdminSync', () => {
  const config = parseAdminUsers('ops@example.com, @acme.io');
  const users = [
    { id: 'u1', googleEmail: 'ops@example.com', role: 'member', adminSource: null },      // promote
    { id: 'u2', googleEmail: 'ops@example.com', role: 'admin', adminSource: 'env' },      // already
    { id: 'u3', googleEmail: 'old@example.com', role: 'admin', adminSource: 'env' },      // demote
    { id: 'u4', googleEmail: 'lead@example.com', role: 'admin', adminSource: 'grant' },   // untouched
    { id: 'u5', googleEmail: 'x@acme.io', role: 'admin', adminSource: 'grant' },          // re-source to env
    { id: 'u6', googleEmail: 'bob@example.com', role: 'member', adminSource: null },      // untouched
  ];

  it('promotes listed members and demotes delisted env-admins only', () => {
    expect(planAdminSync(config, users)).toEqual({ promote: ['u1', 'u5'], demote: ['u3'] });
  });

  it('does nothing when ADMIN_USERS is unset except demote stale env-admins', () => {
    expect(planAdminSync(parseAdminUsers(undefined), users)).toEqual({ promote: [], demote: ['u2', 'u3'] });
  });
});
