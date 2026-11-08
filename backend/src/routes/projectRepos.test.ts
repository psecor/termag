import { beforeEach, describe, expect, it, vi } from 'vitest';

let project: Record<string, unknown> | null;
let rows: Array<Record<string, unknown>> = [];
const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
  const row = { setupStatus: 'pending', setupError: null, ...data };
  rows.push(row);
  return row;
});
// The project row lock: a transaction's FOR UPDATE waits for the one before it to end.
let lockTail: Promise<void> = Promise.resolve();
const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
  let release = () => {};
  const tx = {
    $queryRaw: async () => {
      const before = lockTail;
      lockTail = new Promise<void>(r => { release = r; });
      await before;
      return [];
    },
    projectRepo: {
      findMany: async () => { await Promise.resolve(); return rows.map(r => ({ ...r })); },
      create,
    },
  };
  try { return await fn(tx); } finally { release(); }
});
vi.mock('../db', () => ({ prisma: { project: { findFirst: vi.fn(async () => project) }, $transaction } }));
let flagOn = true;
vi.mock('../services/multiRepoFlag', () => ({ MULTI_REPO_DISABLED_CODE: 'multi_repo_disabled', multiRepoEnabled: vi.fn(async () => flagOn) }));
let view: { kind: string; capabilities?: string[] } = { kind: 'present', capabilities: [] };
vi.mock('../services/projectClone', () => ({ agentView: () => view }));
const dispatchWorkspace = vi.fn(async () => 'dispatched');
vi.mock('../services/workspaceSetup', () => ({ dispatchWorkspace }));
vi.mock('../services/workspaceEvents', () => ({ notifyOnSuccess: <T>(r: T) => r }));

const { addProjectRepo, listProjectRepos } = await import('./projectRepos');

const user = { id: 'u1' } as Express.User;
const repo = (name: string, position: number) => ({ name, url: `https://github.com/acme/${name}`, defaultBranch: null, setupStatus: 'ready', setupError: null, position });

beforeEach(() => {
  vi.clearAllMocks();
  flagOn = true;
  view = { kind: 'present', capabilities: ['workspace-clone-v1'] };
  project = { id: 'p1', userId: 'u1', instanceId: 'i1', layout: 'workspace', repos: [repo('web', 0), repo('api', 1)] };
  rows = (project.repos as Array<Record<string, unknown>>).map(r => ({ ...r }));
});

describe('the repositories routes', () => {
  it('answer 403 with the flag off, changing nothing', async () => {
    flagOn = false;
    expect(await listProjectRepos(user, 'p1')).toMatchObject({ status: 403, body: { code: 'multi_repo_disabled' } });
    expect(await addProjectRepo(user, 'p1', { url: 'https://github.com/acme/docs' })).toMatchObject({ status: 403 });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuse a single-repository project, and another user\'s', async () => {
    project = { ...project, layout: 'repo' };
    expect(await addProjectRepo(user, 'p1', { url: 'https://github.com/acme/docs' })).toMatchObject({ status: 409, body: { code: 'not_multi_repo' } });
    project = null;
    expect(await listProjectRepos(user, 'p1')).toMatchObject({ status: 404 });
  });

  it('add one after the last, and send its clone', async () => {
    const r = await addProjectRepo(user, 'p1', { url: 'https://github.com/acme/docs.git' });
    expect(r).toMatchObject({ status: 202, body: { repo: { name: 'docs', position: 2, setupStatus: 'pending' } } });
    expect(create).toHaveBeenCalledWith({ data: { projectId: 'p1', name: 'docs', url: 'https://github.com/acme/docs.git', defaultBranch: null, position: 2 } });
    expect(dispatchWorkspace).toHaveBeenCalledWith('p1');
  });

  it('add nothing while the box agent is away', async () => {
    view = { kind: 'absent' };
    expect(await addProjectRepo(user, 'p1', { url: 'https://github.com/acme/docs' })).toMatchObject({ status: 503 });
    expect(create).not.toHaveBeenCalled();
  });

  it('ask for a termag update on an agent that cannot clone into a workspace', async () => {
    view = { kind: 'present', capabilities: [] };
    expect(await addProjectRepo(user, 'p1', { url: 'https://github.com/acme/docs' })).toMatchObject({ status: 409, body: { code: 'agent_outdated' } });
    expect(create).not.toHaveBeenCalled();
  });

  it('let one of two adds of one repository under two names in at once', async () => {
    const [a, b] = await Promise.all([
      addProjectRepo(user, 'p1', { url: 'https://github.com/acme/docs', name: 'docs' }),
      addProjectRepo(user, 'p1', { url: 'https://github.com/acme/docs.git', name: 'documentation' }),
    ]);
    expect([a.status, b.status]).toEqual([202, 400]);
    expect(b.body).toMatchObject({ error: expect.stringContaining('already in this project') });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('give two adds of different repositories at once the next two positions', async () => {
    const [a, b] = await Promise.all([
      addProjectRepo(user, 'p1', { url: 'https://github.com/acme/docs' }),
      addProjectRepo(user, 'p1', { url: 'https://github.com/acme/infra' }),
    ]);
    expect([a.body, b.body]).toMatchObject([{ repo: { name: 'docs', position: 2 } }, { repo: { name: 'infra', position: 3 } }]);
  });

  it('refuse a repository already in the project', async () => {
    expect(await addProjectRepo(user, 'p1', { url: 'git@github.com:acme/api.git' })).toMatchObject({ status: 400, body: { error: expect.stringContaining('already in this project') } });
    expect(create).not.toHaveBeenCalled();
  });
});
