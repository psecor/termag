// The project record on the project routes:
// GET /api/projects carries each of the caller's own checkouts' userProjectId
// only under user-projects-enabled (running ensureUserProjects first), and
// never a shared checkout's; a create naming a project it can't use is refused
// before anything is made.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const row = (id: string, userProjectId: string | null) => ({
    id, name: id, instanceId: 'box1', userId: 'u1', userProjectId, user: { unixUsername: 'u' }, workflows: [], workstreams: [],
    repoUrl: null, layout: 'repo', repos: [],
  });
  return {
    prisma: {
      project: { findMany: vi.fn(async () => [row('mine', 'up1')]), create: vi.fn() },
      projectShare: { findMany: vi.fn(async () => [{ project: { ...row('theirs', 'up-owner'), userId: 'owner', archived: false } }]) },
      workTimeEntry: { groupBy: vi.fn(async () => []) },
      spaceBox: { findMany: vi.fn(async () => []) },
      workstream: { updateMany: vi.fn(async () => ({ count: 0 })) },
    },
  };
});
vi.mock('../db', () => ({ prisma: db.prisma }));

const up = vi.hoisted(() => ({
  ensureUserProjects: vi.fn(async () => ({ attached: 0, created: 0 })),
  userProjectsEnabled: vi.fn(async () => true),
  checkRequestedUserProject: vi.fn(),
  attachCheckout: vi.fn(),
}));
vi.mock('../services/userProjects', async importOriginal => ({ ...(await importOriginal<object>()), ...up }));

vi.mock('../services/environments', async importOriginal => ({
  ...(await importOriginal<object>()),
  withEnvironmentRepos: vi.fn(async (_store: unknown, _userId: string, input: object) => ({ input, warnings: [] })),
}));

import { createProjectFor, listProjectsFor } from './projects';
import { setWorkspaceChangeCallback } from '../services/workspaceEvents';

const pushed = vi.fn();
beforeEach(() => { vi.clearAllMocks(); setWorkspaceChangeCallback(pushed); });

describe('GET /api/projects and the project record', () => {
  it("with the flag on, backfills first and carries the owner's userProjectId, never a shared checkout's", async () => {
    const list = await listProjectsFor('u1', { userProjects: true });
    expect(up.ensureUserProjects).toHaveBeenCalledWith('u1');
    expect(list.map(p => [p.id, p.role, p.userProjectId])).toEqual([['mine', 'owner', 'up1'], ['theirs', 'collaborator', null]]);
  });

  it('with the flag off, reads nothing of the record and says null', async () => {
    const list = await listProjectsFor('u1');
    expect(up.ensureUserProjects).not.toHaveBeenCalled();
    expect(list.map(p => p.userProjectId)).toEqual([null, null]);
  });

  it("tells the person's other tabs when the backfill attached a checkout, which its raw SQL can't", async () => {
    await listProjectsFor('u1', { userProjects: true });
    expect(pushed).not.toHaveBeenCalled();
    up.ensureUserProjects.mockResolvedValueOnce({ attached: 2, created: 0 });
    await listProjectsFor('u1', { userProjects: true });
    expect(pushed).toHaveBeenCalledWith('u1', 'projects');
  });

  it('still lists when the backfill fails', async () => {
    up.ensureUserProjects.mockRejectedValueOnce(new Error('db down'));
    const list = await listProjectsFor('u1', { userProjects: true });
    expect(list).toHaveLength(2);
  });
});

describe('POST /api/projects with a userProjectId', () => {
  const user = { id: 'u1', googleEmail: 'u@example.com', displayName: 'U', unixUsername: 'u', defaultAgentProvider: 'claude' } as Express.User;

  it("is refused before anything is made when the project isn't one it can use", async () => {
    up.checkRequestedUserProject.mockResolvedValueOnce({ ok: false, status: 409, code: 'user_project_repos_mismatch', error: 'no' });
    const result = await createProjectFor(user, { name: 'x', repoUrl: 'https://github.com/o/r', userProjectId: 'up1' });
    expect(result).toEqual({ status: 409, body: { error: 'no', code: 'user_project_repos_mismatch' } });
    expect(up.checkRequestedUserProject).toHaveBeenCalledWith('u1', 'up1', ['https://github.com/o/r']);
    expect(db.prisma.project.create).not.toHaveBeenCalled();
  });

  it("answers 400 for a repos that isn't a list, without reading the project", async () => {
    const result = await createProjectFor(user, { name: 'x', repos: 'https://github.com/o/r' as never, userProjectId: 'up1' });
    expect(result).toEqual({ status: 400, body: { error: 'repos must be a list of repositories' } });
    expect(up.checkRequestedUserProject).not.toHaveBeenCalled();
  });

  it('is not read with the flag off', async () => {
    up.userProjectsEnabled.mockResolvedValueOnce(false);
    // No name: the create answers 400 before any write, having never looked at the project.
    const result = await createProjectFor(user, { userProjectId: 'up1' });
    expect(result.status).toBe(400);
    expect(up.checkRequestedUserProject).not.toHaveBeenCalled();
  });
});
