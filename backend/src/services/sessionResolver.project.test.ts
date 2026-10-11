import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { ownerCandidatesWhere, resolveSessionProject } from './sessionResolver';

vi.mock('../db', () => ({
  prisma: { user: { findMany: vi.fn() }, project: { findMany: vi.fn() } },
}));

type P = { id: string; name: string; instanceId: string | null; workstreams: { name: string }[] };
const proj = (id: string, name: string, instanceId: string | null): P =>
  ({ id, name, instanceId, workstreams: [{ name: 'main' }] });

let projectsByUser: Record<string, P[]> = {};

// The DB query is only a superset; the resolver must do the real filtering,
// so the mock hands back every user regardless of the where clause.
function withUsers(users: { id: string; unixUsername: string }[]) {
  vi.mocked(prisma.user.findMany).mockResolvedValue(users as never);
}

beforeEach(() => {
  projectsByUser = {};
  vi.mocked(prisma.user.findMany).mockReset();
  vi.mocked(prisma.project.findMany).mockReset();
  vi.mocked(prisma.project.findMany).mockImplementation((async (args: { where: { userId: string } }) =>
    projectsByUser[args.where.userId] ?? []) as never);
});

describe('ownerCandidatesWhere', () => {
  it('is an exact match when the owner has no underscore', () => {
    expect(ownerCandidatesWhere('alice')).toEqual({ unixUsername: 'alice' });
  });

  it('bounds by the text around the underscores', () => {
    expect(ownerCandidatesWhere('a_b_c')).toEqual({ unixUsername: { startsWith: 'a', endsWith: 'c' } });
  });
});

describe('resolveSessionProject', () => {
  it('finds a dotted owner from the tmux-safe session name', async () => {
    withUsers([{ id: 'u-dot', unixUsername: 'first.last' }]);
    projectsByUser['u-dot'] = [proj('p-webapp', 'webapp', 'box-1')];
    expect(await resolveSessionProject('first_last-webapp-agent', 'box-1'))
      .toEqual({ userId: 'u-dot', instanceId: 'box-1', projectId: 'p-webapp', workstream: 'main' });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { unixUsername: { startsWith: 'first', endsWith: 'last' } },
    });
  });

  it('routes to the one colliding user whose projects build the name', async () => {
    withUsers([{ id: 'u-dot', unixUsername: 'first.last' }, { id: 'u-under', unixUsername: 'first_last' }]);
    projectsByUser['u-dot'] = [proj('p-webapp', 'webapp', 'box-1')];
    projectsByUser['u-under'] = [proj('p-other', 'other', 'box-2')];
    expect(await resolveSessionProject('first_last-other-agent', 'box-2'))
      .toEqual({ userId: 'u-under', instanceId: 'box-2', projectId: 'p-other', workstream: 'main' });
    expect(await resolveSessionProject('first_last-webapp-ctrl', 'box-1'))
      .toEqual({ userId: 'u-dot', instanceId: 'box-1', projectId: 'p-webapp', workstream: 'main' });
  });

  it('is ambiguous when two colliding users both build the name', async () => {
    withUsers([{ id: 'u-under', unixUsername: 'first_last' }, { id: 'u-dot', unixUsername: 'first.last' }]);
    projectsByUser['u-dot'] = [proj('p-dot', 'shared', 'box-1')];
    projectsByUser['u-under'] = [proj('p-under', 'shared', 'box-1')];
    expect(await resolveSessionProject('first_last-shared-agent', 'box-1')).toEqual({ ambiguous: true });
    expect(await resolveSessionProject('first_last-shared-agent')).toEqual({ ambiguous: true });
  });

  it('is ambiguous for an unmatched session when colliding users would both fall back to legacy', async () => {
    withUsers([{ id: 'u-dot', unixUsername: 'first.last' }, { id: 'u-under', unixUsername: 'first_last' }]);
    expect(await resolveSessionProject('first_last-adhoc')).toEqual({ ambiguous: true });
  });

  it('matches mixed . and _ usernames by folding them, not by un-folding the session', async () => {
    withUsers([
      { id: 'u-mixed', unixUsername: 'a.b_c' },
      { id: 'u-mixed2', unixUsername: 'a_b.c' },
      { id: 'u-dots', unixUsername: 'a.b.c' },
      { id: 'u-decoy', unixUsername: 'a.bx.c' },
    ]);
    projectsByUser['u-mixed'] = [proj('p-mixed', 'proj', 'box-1')];
    projectsByUser['u-decoy'] = [proj('p-decoy', 'proj', 'box-1')];
    expect(await resolveSessionProject('a_b_c-proj-agent', 'box-1'))
      .toEqual({ userId: 'u-mixed', instanceId: 'box-1', projectId: 'p-mixed', workstream: 'main' });

    projectsByUser['u-dots'] = [proj('p-dots', 'proj', 'box-1')];
    expect(await resolveSessionProject('a_b_c-proj-ctrl', 'box-1')).toEqual({ ambiguous: true });
  });

  it('keeps a single legacy owner for an unmatched unscoped session', async () => {
    withUsers([{ id: 'u-dot', unixUsername: 'first.last' }]);
    expect(await resolveSessionProject('first_last-adhoc-x'))
      .toEqual({ userId: 'u-dot', instanceId: null, projectId: null, workstream: null });
  });

  it('is null for an unknown owner', async () => {
    withUsers([]);
    expect(await resolveSessionProject('nobody-x-agent', 'box-1')).toBeNull();
  });
});
