import { describe, expect, it, vi, beforeEach } from 'vitest';

// Decision #58 on #998: picking an environment is the consent for its steps (no trust tick), its repositories are
// our GitHub orgs' (refused at save, at create and at claim), and decision #71: environment-selection-enabled gates
// the automatic start.

const sent = vi.hoisted(() => ({ calls: [] as unknown[][], flag: true }));
vi.mock('../db', () => ({ prisma: { project: { count: vi.fn(async () => 0) }, user: { findUnique: vi.fn(async () => ({ id: 'u1', googleEmail: 'u@x', displayName: 'U', unixUsername: 'u', defaultAgentProvider: 'claude' })) } } }));
vi.mock('./agentRegistry', () => ({
  onBoxAgentFrame: vi.fn(), projectAgentCapabilities: () => ['environment-v1'],
  sendToInstanceAgent: vi.fn(async (...args: unknown[]) => { sent.calls.push(args); return { started: true, session: 's' }; }),
}));
vi.mock('./featureFlags', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./featureFlags');
  return { ...actual, boolVariation: vi.fn(async (key: string, _u: unknown, fallback: boolean) => (key === 'environment-selection-enabled' ? sent.flag : fallback)) };
});

const { environmentUpRequest, startEnvironmentAfterClone } = await import('./projectEnvironment');
const { parseEnvironmentInput, withEnvironmentRepos } = await import('./environments');

const base = { id: 'p1', instanceId: 'i1', layout: 'single', dir: '/w/p1', otherProjectsOnBox: 0, userId: 'u-owner' };
const inline = (repo: string) => ({ name: 'full-stack', text: JSON.stringify({ repos: [{ repo }], setup: 'make' }), editedBy: 'someone-else' });

describe('an environment picked for a project starts its steps on its own', () => {
  it('with no trust tick, whoever last edited it, inline or a pointer at any branch, pinned or not', () => {
    for (const environmentFile of [
      inline('example-org/web'),
      { name: 'p', repo: 'example-org/web', branch: 'any-branch', path: 'e.json', text: '{"setup":"make"}', editedBy: 'u-owner' },
      { name: 'p', repo: 'example-team/tool', path: 'e.json' },
    ]) {
      const req = environmentUpRequest({ ...base, chatTrustedAt: null, environmentFile });
      expect(req).toEqual({ payload: expect.objectContaining({ trusted: true }) });
      expect((req as { payload: Record<string, unknown> }).payload).not.toHaveProperty('hold');
    }
  });
  it("still holds a repository's own file, which nobody picked", () => {
    expect(environmentUpRequest({ ...base, chatTrustedAt: new Date(), environmentFile: null })).toEqual({ payload: expect.objectContaining({ hold: 'checkout' }) });
  });
});

describe("an environment's repositories are our GitHub orgs'", () => {
  it('are refused at save, inline or a pointer', () => {
    const bad = parseEnvironmentInput({ name: 'x', kind: 'inline', definition: { repos: [{ repo: 'example-org/web' }, { repo: 'evil/app' }] } });
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.error).toMatch(/evil\/app.*example-org, example-team/);
    expect(parseEnvironmentInput({ name: 'x', kind: 'pointer', file: { repo: 'evil/app', path: 'e.json' } })).toMatchObject({ ok: false });
    expect(parseEnvironmentInput({ name: 'x', kind: 'inline', definition: { repos: [{ repo: 'Example-Org/web' }, { repo: 'example-team/tool' }] } })).toMatchObject({ ok: true });
  });
  it('are refused when a project is made from one that names another', async () => {
    const store = { byName: async () => ({ id: 'e1', name: 'old', kind: 'inline' as const, definition: { repos: [{ repo: 'evil/app' }] }, createdAt: new Date(), updatedAt: new Date(), createdByUserId: 'u1', updatedByUserId: 'u1', visibility: 'personal' as const, ownerUserId: 'u1' }) };
    const resolve = async () => ({ repos: [{ repo: 'evil/app' }], sizes: null, warnings: [] });
    expect(await withEnvironmentRepos(store as never, 'u1', { name: 'p', environment: 'old', environmentRepos: [{ repo: 'evil/app' }] }, resolve))
      .toMatchObject({ status: 400, body: { code: 'environment_repo_outside_orgs' } });
  });
  it('and its steps never start at claim for one stored before the rule', () => {
    expect(environmentUpRequest({ ...base, chatTrustedAt: null, environmentFile: inline('evil/app') })).toEqual({ skip: 'outside-orgs' });
    expect(environmentUpRequest({ ...base, chatTrustedAt: null, environmentFile: { name: 'p', repo: 'evil/app', path: 'e.json' } })).toEqual({ skip: 'outside-orgs' });
  });
});

describe('environment-selection-enabled gates the automatic start', () => {
  const row = { id: 'p1', userId: 'u1', instanceId: 'i1', layout: 'single', dir: '/w/p1', chatTrustedAt: null, kind: 'normal', environmentFile: inline('example-org/web') };
  beforeEach(() => { sent.calls = []; });
  it('sends environment-up when it is on', async () => {
    sent.flag = true;
    await startEnvironmentAfterClone(row);
    expect(sent.calls.map(c => c[1])).toEqual(['environment-up']);
  });
  it('never sends it when it is off', async () => {
    sent.flag = false;
    await startEnvironmentAfterClone(row);
    expect(sent.calls).toEqual([]);
  });
});
