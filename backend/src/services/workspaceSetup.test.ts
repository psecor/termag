import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Repo { id: string; name: string; url: string; position: number; defaultBranch: string | null; setupStatus: string; setupError: string | null; setupAttempt: number }
interface Row { id: string; name: string; userId: string; instanceId: string; layout: string; setupStatus: string; setupError: string | null }

let project: Row & { environmentId?: string | null; kind?: string; dir?: string | null };
let otherProjects = 0;
let dirTaken = false;
let repos: Repo[];
const order: string[] = [];

function matches(r: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in (v as object)) return ((v as { in: unknown[] }).in).includes(r[k]);
    return r[k] === v;
  });
}

const prisma = {
  project: {
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === project.id && project.layout === 'workspace'
      ? { ...project, repos: [...repos].sort((a, b) => a.position - b.position).map(r => ({ ...r })), instance: { hostHome: '/h', kind: 'ec2', userId: 'u1' }, user: { unixUsername: 'alice', defaultAgentProvider: 'claude' } }
      : null)),
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => ('dir' in where ? (dirTaken ? 1 : 0) : otherProjects)),
    update: vi.fn(async ({ data }: { data: Partial<Row> & { dir?: string } }) => { Object.assign(project, data); return project; }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      if (!matches(project as unknown as Record<string, unknown>, where)) return { count: 0 };
      order.push(`project:${data.setupStatus}`);
      Object.assign(project, data);
      return { count: 1 };
    }),
  },
  projectRepo: {
    findFirst: vi.fn(async ({ where }: { where: { name: string } }) => {
      const r = repos.find(x => x.name === where.name);
      return r ? { ...r, project: { setupStatus: project.setupStatus } } : null;
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => repos.filter(r => matches({ ...r, projectId: project.id } as Record<string, unknown>, where)).map(r => ({ ...r }))),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const r = repos.find(x => matches(x as unknown as Record<string, unknown>, where));
      if (!r) return { count: 0 };
      const { setupAttempt, ...rest } = data as { setupAttempt?: { increment: number } };
      Object.assign(r, rest);
      if (setupAttempt) r.setupAttempt += setupAttempt.increment;
      return { count: 1 };
    }),
  },
};
let workstreams: Array<{ name: string; branch: string }> = [];
(prisma as Record<string, unknown>).workstream = {
  findMany: vi.fn(async ({ where }: { where: { name?: { not: string } } }) => workstreams.filter(w => !where.name || w.name !== where.name.not)),
};
vi.mock('../db', () => ({ prisma }));

const sendToInstanceAgent = vi.fn();
const sendForProject = vi.fn(async () => ({ ok: true }));
vi.mock('./agentRegistry', () => ({
  sendToInstanceAgent, sendForProject, onBoxAgentFrame: vi.fn(() => () => {}), onBoxAgentHello: vi.fn(() => () => {}),
}));
let capabilities: string[] = ['workspace-clone-v1'];
const launchProjectSessions = vi.fn(async () => { order.push('launch'); return true; });
vi.mock('./projectClone', () => ({
  agentView: () => ({ kind: 'present', capabilities }),
  launchProjectSessions,
}));

const { applyRepoReport, dispatchWorkspace, retryWorkspace, workstreamGuideRepos } = await import('./workspaceSetup');

const repo = (name: string, position: number, over: Partial<Repo> = {}): Repo => ({
  id: `r-${name}`, name, url: `https://github.com/o/${name}`, position, defaultBranch: null, setupStatus: 'pending', setupError: null, setupAttempt: 0, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  capabilities = ['workspace-clone-v1'];
  project = { id: 'p1', name: 'shop', userId: 'u1', instanceId: 'i1', layout: 'workspace', setupStatus: 'pending', setupError: null };
  repos = [repo('web', 0), repo('api', 1)];
  workstreams = [];
  otherProjects = 0;
  dirTaken = false;
  sendToInstanceAgent.mockResolvedValue({ ok: true });
  sendForProject.mockImplementation(async () => ({ ok: true }));
});

describe('dispatchWorkspace', () => {
  it('writes the root and sends every pending clone', async () => {
    expect(await dispatchWorkspace('p1')).toBe('dispatched');
    expect(sendForProject).toHaveBeenCalledWith({ userId: 'u1', instanceId: 'i1' }, 'init-workspace', expect.objectContaining({ dir: expect.stringMatching(/shop$/) }));
    expect(sendToInstanceAgent.mock.calls.map(c => (c[2] as { repo: string }).repo)).toEqual(['web', 'api']);
  });

  it('on a box made from an environment for it, makes ~/code the root and records it; the clones land in it', async () => {
    capabilities = ['workspace-clone-v1', 'workspace-static-root-v1'];
    project.environmentId = 'env1';
    project.kind = 'normal';
    sendForProject.mockImplementation(async () => ({ ok: true, staticLayout: true }));
    await dispatchWorkspace('p1');
    expect(sendForProject).toHaveBeenCalledWith({ userId: 'u1', instanceId: 'i1' }, 'init-workspace', expect.objectContaining({ dir: expect.stringMatching(/shop$/), staticRoot: '/h/code' }));
    expect(project.dir).toBe('/h/code');
    // Each clone goes to <root>/<repo>, which the link makes ~/code/<repo>; no per-repository static path.
    expect(sendToInstanceAgent.mock.calls.map(c => [(c[2] as { dir: string }).dir, (c[2] as { staticDir?: string }).staticDir])).toEqual([
      [expect.stringMatching(/\/shop\/web$/), undefined],
      [expect.stringMatching(/\/shop\/api$/), undefined],
    ]);
  });

  it('names the project in the static root request, so the box can tell its own ~/code from another project\'s', async () => {
    capabilities = ['workspace-clone-v1', 'workspace-static-root-v1'];
    project.environmentId = 'env1';
    project.kind = 'normal';
    await dispatchWorkspace('p1');
    expect(sendForProject).toHaveBeenCalledWith(expect.anything(), 'init-workspace', expect.objectContaining({ staticRoot: '/h/code', projectId: 'p1' }));
  });

  it('asks for no static root when another project on the box, archived or not, already records ~/code', async () => {
    capabilities = ['workspace-clone-v1', 'workspace-static-root-v1'];
    project.environmentId = 'env1';
    project.kind = 'normal';
    dirTaken = true;
    await dispatchWorkspace('p1');
    const roots = sendForProject.mock.calls.filter(c => (c as unknown[])[1] === 'init-workspace').map(c => ((c as unknown[])[2] as { staticRoot?: string }).staticRoot);
    expect(roots).toEqual([undefined]);
  });

  it('forgets a recorded ~/code root the box refuses (Devin, #1462)', async () => {
    capabilities = ['workspace-clone-v1', 'workspace-static-root-v1'];
    project.environmentId = 'env1';
    project.kind = 'normal';
    project.dir = '/h/code';
    sendForProject.mockImplementation(async () => ({ ok: true, staticLayout: false, staticRefused: '/h/code belongs to another project' }));
    await dispatchWorkspace('p1');
    expect(project.dir).toBeNull();
  });

  it("keeps the project's own root when the box says ~/code is taken", async () => {
    capabilities = ['workspace-clone-v1', 'workspace-static-root-v1'];
    project.environmentId = 'env1';
    project.kind = 'normal';
    sendForProject.mockImplementation(async () => ({ ok: true, staticLayout: false, staticRefused: '/h/code already holds something' }));
    await dispatchWorkspace('p1');
    expect(project.dir).toBeUndefined();
  });

  it('asks for no static root on a box that already has another project, an older agent, or a project not from an environment', async () => {
    capabilities = ['workspace-clone-v1', 'workspace-static-root-v1'];
    project.environmentId = 'env1';
    project.kind = 'normal';
    otherProjects = 1;
    await dispatchWorkspace('p1');
    otherProjects = 0;
    capabilities = ['workspace-clone-v1'];
    await dispatchWorkspace('p1');
    capabilities = ['workspace-clone-v1', 'workspace-static-root-v1'];
    project.environmentId = null;
    await dispatchWorkspace('p1');
    const roots = sendForProject.mock.calls.filter(c => (c as unknown[])[1] === 'init-workspace').map(c => ((c as unknown[])[2] as { staticRoot?: string }).staticRoot);
    expect(roots).toEqual([undefined, undefined, undefined]);
  });

  it('fails the project on a box without the capability, sending nothing', async () => {
    capabilities = [];
    expect(await dispatchWorkspace('p1')).toBe('unsupported');
    expect(project).toMatchObject({ setupStatus: 'failed', setupError: expect.stringContaining('Update termag') });
    expect(sendForProject).not.toHaveBeenCalled();
    expect(sendToInstanceAgent).not.toHaveBeenCalled();
  });

  it('fails a project caught cloning by an agent that lost the capability, and Retry clones again once it is back', async () => {
    capabilities = [];
    project.setupStatus = 'cloning';
    repos = [repo('web', 0, { setupStatus: 'ready' }), repo('api', 1, { setupStatus: 'cloning' })];
    expect(await dispatchWorkspace('p1')).toBe('unsupported');
    expect(project).toMatchObject({ setupStatus: 'failed', setupError: expect.stringContaining('Update termag') });
    capabilities = ['workspace-clone-v1'];
    expect((await retryWorkspace('p1')).dispatch).toBe('dispatched');
    expect(project.setupStatus).toBe('cloning');
    expect(sendToInstanceAgent.mock.calls.map(c => (c[2] as { repo: string }).repo)).toEqual(['api']);
  });

  it('fails a repository the box refuses, so it is not resent on every hello', async () => {
    sendToInstanceAgent.mockImplementation(async (_i: string, _t: string, payload: { repo: string }) => {
      if (payload.repo === 'api') throw new Error('project-clone: branch must be HEAD or a branch name');
      return { ok: true };
    });
    await dispatchWorkspace('p1');
    expect(repos.find(r => r.name === 'api')).toMatchObject({ setupStatus: 'failed', setupError: expect.stringContaining('branch must be') });
    expect(repos.find(r => r.name === 'web')?.setupStatus).toBe('pending');
    expect(project).toMatchObject({ setupStatus: 'failed', setupError: expect.stringContaining('api:') });
  });

  it('leaves a repository pending when the request was lost, for the next hello', async () => {
    sendToInstanceAgent.mockRejectedValue(new Error('Agent request timed out: project-clone'));
    await dispatchWorkspace('p1');
    expect(repos.every(r => r.setupStatus === 'pending')).toBe(true);
    expect(project.setupStatus).toBe('pending');
  });
});

describe('a repository report', () => {
  const report = (name: string, status: string) => ({ projectId: 'p1', instanceId: 'i1', attempt: 0, repo: name, status, ...(status === 'ready' ? { branch: 'main' } : {}) });

  it('starts the sessions when the last repository lands, before committing ready', async () => {
    repos = [repo('web', 0, { setupStatus: 'ready' }), repo('api', 1, { setupStatus: 'cloning' })];
    project.setupStatus = 'cloning';
    await applyRepoReport('i1', report('api', 'ready'));
    expect(order).toEqual(['launch', 'project:ready']);
    expect(launchProjectSessions).toHaveBeenCalledWith({ projectId: 'p1', instanceId: 'i1' }, { projectId: 'p1', from: 'cloning' });
  });

  it('starts nothing while another repository is still cloning', async () => {
    repos = [repo('web', 0, { setupStatus: 'pending' }), repo('api', 1, { setupStatus: 'pending' })];
    await applyRepoReport('i1', report('api', 'cloning'));
    expect(project.setupStatus).toBe('cloning');
    expect(launchProjectSessions).not.toHaveBeenCalled();
  });
});

describe('retryWorkspace', () => {
  it('sends the clones again after the box was updated, with no repository failed', async () => {
    project.setupStatus = 'failed';
    project.setupError = 'Update termag on this box to use more than one repository';
    const result = await retryWorkspace('p1');
    expect(result).toEqual({ retried: [], dispatch: 'dispatched' });
    expect(project.setupStatus).toBe('pending');
    expect(sendToInstanceAgent).toHaveBeenCalledTimes(2);
  });

  it('says the box still cannot hold it', async () => {
    capabilities = [];
    project.setupStatus = 'failed';
    expect((await retryWorkspace('p1')).dispatch).toBe('unsupported');
    expect(project.setupStatus).toBe('failed');
  });
});

type Call = [unknown, string, Record<string, unknown>];
const calls = (type: string) => (sendForProject.mock.calls as unknown as Call[]).filter(c => c[1] === type).map(c => c[2]);

describe('a repository added to a project in use', () => {
  const report = (name: string, status: string, attempt = 0) => ({ projectId: 'p1', instanceId: 'i1', attempt, repo: name, status, ...(status === 'ready' ? { branch: 'main' } : {}) });

  beforeEach(() => {
    project.setupStatus = 'ready';
    repos = [repo('web', 0, { setupStatus: 'ready' }), repo('api', 1, { setupStatus: 'ready' }), repo('docs', 2, { setupStatus: 'cloning' })];
    workstreams = [{ name: 'fix', branch: 'e2e/fix' }, { name: 'gone', branch: 'e2e/gone' }];
    sendForProject.mockImplementation(async (_h: unknown, type: string, msg: { wsRoot?: string }) => (
      type === 'workspace-root-state' ? { exists: !msg.wsRoot!.endsWith('/gone'), present: ['web', 'api'], leftovers: [] } : { ok: true }
    ) as never);
  });

  it('sends its clone without writing the root again, and the project stays ready', async () => {
    repos[2].setupStatus = 'pending';
    expect(await dispatchWorkspace('p1')).toBe('dispatched');
    expect(calls('init-workspace')).toEqual([]);
    expect(sendToInstanceAgent.mock.calls.map(c => (c[2] as { repo: string }).repo)).toEqual(['docs']);
    await applyRepoReport('i1', report('docs', 'cloning'));
    expect(project.setupStatus).toBe('ready');
    expect(launchProjectSessions).not.toHaveBeenCalled();
  });

  it('gets a worktree in every workstream on its branch once cloned, then every guide lists it', async () => {
    await applyRepoReport('i1', report('docs', 'ready'));
    expect(calls('git-worktree-add')).toEqual([{
      projectDir: '/h/termag/projects/shop/docs', worktreeName: 'fix', worktreePath: '/h/termag/projects/shop/.worktrees/fix/docs',
      branch: 'e2e/fix', baseRef: 'HEAD', initRepo: false,
    }]);
    expect(calls('init-workspace').map(m => [m.dir, String(m.guide).includes('`docs/`')])).toEqual([
      ['/h/termag/projects/shop', true],
      ['/h/termag/projects/shop/.worktrees/fix', true],
    ]);
    expect(repos[2]).toMatchObject({ setupStatus: 'ready', setupError: null });
    expect(project.setupStatus).toBe('ready');
    expect(launchProjectSessions).not.toHaveBeenCalled();
  });

  it('is listed only in the guides of the roots it joined, and a guide lists what its root holds', async () => {
    // blog joined hot but not fix; wiki never cloned.
    repos.push(
      repo('blog', 3, { setupStatus: 'failed', setupError: "no worktree of it in fix: fatal: a branch named 'e2e/fix' already exists" }),
      repo('wiki', 4, { setupStatus: 'failed', setupError: 'Repository not found' }),
    );
    workstreams = [{ name: 'fix', branch: 'e2e/fix' }, { name: 'hot', branch: 'e2e/hot' }];
    const trees: Record<string, string[]> = { fix: ['web', 'api'], hot: ['web', 'api', 'blog'] };
    sendForProject.mockImplementation(async (_h: unknown, type: string, msg: { wsRoot?: string; worktreePath?: string; repos?: string[] }) => {
      if (type === 'workspace-root-state') {
        const held = trees[msg.wsRoot!.split('/').pop()!] ?? [];
        return { exists: true, present: msg.repos!.filter(n => held.includes(n)), leftovers: [] } as never;
      }
      if (type === 'git-worktree-add' && msg.worktreePath!.includes('/fix/')) throw new Error("fatal: a branch named 'e2e/fix' already exists");
      return { ok: true } as never;
    });
    await applyRepoReport('i1', report('docs', 'ready'));
    const listed = (m: Record<string, unknown>) => ['web', 'api', 'docs', 'blog', 'wiki'].filter(n => String(m.guide).includes(`\`${n}/\``));
    expect(calls('init-workspace').map(m => [m.dir, listed(m)])).toEqual([
      ['/h/termag/projects/shop', ['web', 'api', 'docs', 'blog']],
      ['/h/termag/projects/shop/.worktrees/fix', ['web', 'api']],
      ['/h/termag/projects/shop/.worktrees/hot', ['web', 'api', 'docs', 'blog']],
    ]);
    expect(repos[2]).toMatchObject({ setupStatus: 'failed', setupError: expect.stringContaining('no worktree of it in fix') });
  });

  it("gives a renamed workstream's guide the worktrees its root holds, or the checkouts when the box cannot say", async () => {
    repos.push(repo('blog', 3, { setupStatus: 'failed', setupError: 'no worktree of it in fix: boom' }));
    const host = { userId: 'u1', instanceId: 'i1' };
    sendForProject.mockImplementation(async () => ({ exists: true, present: ['web', 'blog'], leftovers: [] }) as never);
    expect((await workstreamGuideRepos(host, '/h/termag/projects/shop/.worktrees/hot', repos)).map(r => r.name)).toEqual(['web', 'blog']);
    sendForProject.mockImplementation(async () => { throw new Error('Unknown command'); });
    expect((await workstreamGuideRepos(host, '/h/termag/projects/shop/.worktrees/hot', repos)).map(r => r.name)).toEqual(['web', 'api', 'blog']);
  });

  it('fails, naming the workstream, when a worktree cannot be made, and Retry joins it again', async () => {
    sendForProject.mockImplementation(async (_h: unknown, type: string) => {
      if (type === 'git-worktree-add') throw new Error("fatal: a branch named 'e2e/fix' already exists");
      return (type === 'workspace-root-state' ? { exists: true } : { ok: true }) as never;
    });
    workstreams = [{ name: 'fix', branch: 'e2e/fix' }];
    await applyRepoReport('i1', report('docs', 'ready'));
    expect(repos[2]).toMatchObject({ setupStatus: 'failed', setupError: "no worktree of it in fix: fatal: a branch named 'e2e/fix' already exists" });
    expect(project.setupStatus).toBe('ready');
    sendForProject.mockImplementation(async (_h: unknown, type: string) => (type === 'workspace-root-state' ? { exists: true } : { ok: true }) as never);
    expect((await retryWorkspace('p1')).retried).toEqual(['docs']);
    expect(repos[2]).toMatchObject({ setupStatus: 'pending', setupAttempt: 1 });
    await applyRepoReport('i1', report('docs', 'ready', 1));
    expect(repos[2].setupStatus).toBe('ready');
  });
});
