import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Repo { id: string; name: string; url: string; position: number; defaultBranch: string | null; setupStatus: string; setupError: string | null; setupAttempt: number }
interface Row { id: string; name: string; userId: string; instanceId: string; layout: string; setupStatus: string; setupError: string | null }

let project: Row;
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
      return r ? { ...r } : null;
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

const { applyRepoReport, dispatchWorkspace, retryWorkspace } = await import('./workspaceSetup');

const repo = (name: string, position: number, over: Partial<Repo> = {}): Repo => ({
  id: `r-${name}`, name, url: `https://github.com/o/${name}`, position, defaultBranch: null, setupStatus: 'pending', setupError: null, setupAttempt: 0, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  capabilities = ['workspace-clone-v1'];
  project = { id: 'p1', name: 'shop', userId: 'u1', instanceId: 'i1', layout: 'workspace', setupStatus: 'pending', setupError: null };
  repos = [repo('web', 0), repo('api', 1)];
  sendToInstanceAgent.mockResolvedValue({ ok: true });
});

describe('dispatchWorkspace', () => {
  it('writes the root and sends every pending clone', async () => {
    expect(await dispatchWorkspace('p1')).toBe('dispatched');
    expect(sendForProject).toHaveBeenCalledWith({ userId: 'u1', instanceId: 'i1' }, 'init-workspace', expect.objectContaining({ dir: expect.stringMatching(/shop$/) }));
    expect(sendToInstanceAgent.mock.calls.map(c => (c[2] as { repo: string }).repo)).toEqual(['web', 'api']);
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
