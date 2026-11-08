import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EnvironmentRecord } from './environments';
import type { RepoEnvironmentReader } from './repoEnvironment';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./agentRegistry', () => ({ onPoolBoxFrame: vi.fn(() => () => undefined), sendToInstanceAgent: vi.fn(), dropInstanceAgent: vi.fn() }));
vi.mock('./warmPool', () => ({ currentPoolSpecHash: vi.fn(async () => 'spec') }));
vi.mock('./productEvents', () => ({ recordProductEvent: vi.fn() }));

const { resolveForHello, envPoolDefinitionByName, resetEnvPoolCache, helloAction, prepareSendOutcome, restopIfStillStopping, stopSettlement, envPoolSetupHash, parsePoolStatus, poolStatusOutcome, prepareRequest, resolveEnvPoolDefinition, setupTextOf } = await import('./envPool');
const { parseEnvPoolSizes, ENV_POOL_TOTAL_CEILING } = await import('./envPoolSizes');
type Deps = import('./envPool').EnvPoolDeps;

// The fixtures' repositories are e2e-org's: count it as one of our orgs here (environments.ts reposOutsideOrgs).
beforeAll(() => { vi.stubEnv('GITHUB_REPO_ORGS', 'e2e-org,o'); });
afterAll(() => { vi.unstubAllEnvs(); });

const meta = { createdAt: new Date(0), updatedAt: new Date(0), createdByUserId: 'u1', updatedByUserId: 'u1', ownerUserId: 'u1' };
const FILE = JSON.stringify({ setup: 'npm ci', run: 'npm start', repos: [{ repo: 'e2e-org/lib', path: 'lib-src' }] });
const pointer: EnvironmentRecord = { ...meta, id: 'env1', name: 'envdemo', kind: 'pointer', visibility: 'shared', file: { repo: 'e2e-org/envdemo', branch: null, path: '.termag/environment.json' } };

function deps(over: Partial<Deps> = {}): Deps {
  const reader = {
    read: vi.fn(async (_u: string, repo: string) => ({ repo, commit: 'c'.repeat(40), sizes: { size: 'medium' }, repos: [{ repo: 'e2e-org/lib', path: 'lib-src' }], warnings: [], text: FILE })),
    cachedKeys: () => [], text: async () => ({ error: 'unused' }),
    defaultBranch: vi.fn(async () => ({ branch: 'main' })),
  } as unknown as RepoEnvironmentReader;
  return {
    store: { byName: async () => pointer, get: async () => pointer },
    reader,
    head: vi.fn(async (repo: string) => ({ sha: repo.endsWith('lib') ? 'b'.repeat(40) : 'a'.repeat(40) })),
    poolSpecHash: vi.fn(async (size: string | null) => `spec-${size}`),
    poolSize: async () => 'large',
    ...over,
  };
}

describe('resolveEnvPoolDefinition', () => {
  it("resolves a shared pointer: its repositories at their default branches' heads, setup, size and the hash", async () => {
    const res = await resolveEnvPoolDefinition(pointer, deps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.def.repos).toEqual([
      { repo: 'e2e-org/envdemo', branch: 'main', name: 'envdemo' },
      { repo: 'e2e-org/lib', branch: 'main', name: 'lib-src' },
    ]);
    expect(res.def.heads).toEqual({ 'e2e-org/envdemo': 'a'.repeat(40), 'e2e-org/lib': 'b'.repeat(40) });
    expect(res.def.size).toBe('medium');
    expect(res.def.setup).toBe('"npm ci"');
    expect(res.def.fileText).toBe(FILE);
    expect(res.def.fileRepo).toBe('e2e-org/envdemo');
    expect(res.def.setupHash).toBe(envPoolSetupHash({ setup: '"npm ci"', poolSpecHash: 'spec-medium', diskGiB: res.def.diskGiB, repos: res.def.repos }));
  });

  it('refuses a personal environment', async () => {
    expect(await resolveEnvPoolDefinition({ ...pointer, visibility: 'personal' }, deps())).toMatchObject({ ok: false });
  });

  it('says why when a head cannot be read with the pool credential', async () => {
    const res = await resolveEnvPoolDefinition(pointer, deps({ head: async () => ({ error: 'no pool credential is set' }) }));
    expect(res).toEqual({ ok: false, reason: 'no pool credential is set' });
  });

  it('refuses a size by requirements: the pool launches presets', async () => {
    const d = deps();
    (d.reader.read as any).mockResolvedValue({ repo: 'e2e-org/envdemo', commit: 'c'.repeat(40), sizes: { size: { vcpu: 6, memoryGiB: 24 } }, repos: [], warnings: [], text: FILE });
    expect(await resolveEnvPoolDefinition(pointer, d)).toMatchObject({ ok: false, reason: expect.stringContaining('requirements') });
  });
});

describe('the setup hash', () => {
  const v = { setup: '"npm ci"', poolSpecHash: 'spec', diskGiB: 120, repos: [{ repo: 'o/a', branch: 'main', name: 'a' }] };
  it('changes with the setup, the image spec, the disk and where a checkout goes', () => {
    const h = envPoolSetupHash(v);
    expect(envPoolSetupHash({ ...v, setup: '"npm ci && make"' })).not.toBe(h);
    expect(envPoolSetupHash({ ...v, poolSpecHash: 'spec2' })).not.toBe(h);
    expect(envPoolSetupHash({ ...v, diskGiB: 200 })).not.toBe(h);
    expect(envPoolSetupHash({ ...v, repos: [{ ...v.repos[0], name: 'b' }] })).not.toBe(h);
    expect(envPoolSetupHash({ ...v })).toBe(h);
  });
  it("reads only the definition's setup, not its run", () => {
    expect(setupTextOf({ setup: ['a', 'b'], run: 'x' })).toBe(setupTextOf({ setup: ['a', 'b'], run: 'y' }));
    expect(setupTextOf({})).toBe('');
  });
});

describe('parsePoolStatus', () => {
  it("reads the pool chain's frames only", () => {
    expect(parsePoolStatus({ projectId: 'cuid', status: {} })).toBeNull();
    expect(parsePoolStatus({
      projectId: 'pool', status: { state: 'ready', setup: { state: 'succeeded' }, setupCommit: { 'o/a': 'a'.repeat(40), bad: 3 } },
    })).toEqual({ state: 'ready', setup: 'succeeded', setupCommit: { 'o/a': 'a'.repeat(40) }, log: '', error: null, exitCode: null, prepareId: null });
    expect(parsePoolStatus({ projectId: 'pool', status: { state: 'failed', setup: { state: 'failed', error: 'exit 1' }, log: 'npm ERR!' } }))
      .toMatchObject({ state: 'failed', error: 'exit 1', log: 'npm ERR!' });
    expect(parsePoolStatus({ projectId: 'pool', status: { prepareId: 'refresh-1' } })?.prepareId).toBe('refresh-1');
  });
});

describe('poolStatusOutcome (Bugbot on #1453)', () => {
  const st = (state: string, setup: string, exitCode: number | null = null) => parsePoolStatus({ projectId: 'pool', status: { state, setup: { state: setup, ...(exitCode !== null ? { exitCode } : {}) } } })!;
  it('takes an environment with no setup as prepared once the chain finished', () => {
    expect(poolStatusOutcome(st('ready', 'none'))).toBe('prepared');
    expect(poolStatusOutcome(st('pending', 'none'))).toBe('pending');
    expect(poolStatusOutcome(st('setup', 'running'))).toBe('pending');
    expect(poolStatusOutcome(st('ready', 'succeeded'))).toBe('prepared');
  });
  it("takes a setup success as prepared only once the chain settled: a pending or running chain may carry the last one's", () => {
    expect(poolStatusOutcome(st('pending', 'succeeded'))).toBe('pending');
    expect(poolStatusOutcome(st('setup', 'succeeded'))).toBe('pending');
  });
  it('fails, and tells a setup step that exited from a failure before the chain', () => {
    expect(poolStatusOutcome(st('failed', 'failed', 1))).toBe('failed');
    expect(st('failed', 'failed', 1).exitCode).toBe(1);
    expect(st('failed', 'failed').exitCode).toBeNull();
  });
});

describe('prepareRequest', () => {
  it('names each repository with its clone URL, branch and static directory, and never a token', async () => {
    const res = await resolveEnvPoolDefinition(pointer, deps());
    if (!res.ok) throw new Error('unresolved');
    const req = prepareRequest('i1', res.def);
    expect(req).toMatchObject({
      instanceId: 'i1', environmentId: 'env1', fileRepo: 'e2e-org/envdemo', filePath: '.termag/environment.json',
      repos: [
        { repo: 'e2e-org/envdemo', branch: 'main', name: 'envdemo', url: 'https://github.com/e2e-org/envdemo' },
        { repo: 'e2e-org/lib', branch: 'main', name: 'lib-src', url: 'https://github.com/e2e-org/lib' },
      ],
    });
    expect(JSON.stringify(req)).not.toMatch(/token|ghp_|github_pat/i);
  });
});

describe('parseEnvPoolSizes', () => {
  it('reads counts by environment name', () => {
    expect(parseEnvPoolSizes({ termag: 3, envdemo: 2 })).toEqual([{ name: 'envdemo', target: 2 }, { name: 'termag', target: 3 }]);
  });
  it('has no pool for unset or not an object', () => {
    expect(parseEnvPoolSizes(null)).toEqual([]);
    expect(parseEnvPoolSizes([1])).toEqual([]);
  });
  it('leaves out a bad name or count, and keeps the rest', () => {
    expect(parseEnvPoolSizes({ 'Bad Name': 1, ok: 1.5, fine: 2 })).toEqual([{ name: 'fine', target: 2 }]);
  });
  it(`clamps the total to ${ENV_POOL_TOTAL_CEILING} in name order`, () => {
    expect(parseEnvPoolSizes({ a: 15, b: 15, c: 15 })).toEqual([{ name: 'a', target: 15 }, { name: 'b', target: 5 }, { name: 'c', target: 0 }]);
  });
});

describe('the setup hash covers what setup runs with (Devin on #1453)', () => {
  const repos = [{ repo: 'o/a', branch: 'main', name: 'a' }];
  const v = { setup: setupTextOf({ setup: 'npm ci', env: { NODE_ENV: 'test' } }), poolSpecHash: 'spec', diskGiB: 120, repos };
  it("changes with the definition's env, which setup gets", () => {
    expect(setupTextOf({ setup: 'npm ci', env: { NODE_ENV: 'production' } })).not.toBe(v.setup);
    expect(setupTextOf({ setup: 'npm ci', run: 'x' })).toBe(setupTextOf({ setup: 'npm ci', run: 'y' }));
  });
  it("changes with a repository's default branch: a box cloned from the old one is stale", () => {
    expect(envPoolSetupHash({ ...v, repos: [{ ...repos[0], branch: 'trunk' }] })).not.toBe(envPoolSetupHash(v));
  });
});

describe('stopSettlement: an env-stopping box, by what EC2 says (Bugbot and Devin on #1453)', () => {
  it('settles a stopped box, and sends the stop again to one still running (its StopInstances failed)', () => {
    expect(stopSettlement('stopped')).toBe('settle');
    expect(stopSettlement('running')).toBe('restop');
  });
  it('waits while EC2 is getting there, and retires a box EC2 has gone from', () => {
    expect(stopSettlement('stopping')).toBe('wait');
    expect(stopSettlement('pending')).toBe('wait');
    expect(stopSettlement(undefined)).toBe('wait');
    expect(stopSettlement('terminated')).toBe('gone');
    expect(stopSettlement('shutting-down')).toBe('gone');
  });
});

describe('helloAction: a preparing box said hello (Bugbot on #1453)', () => {
  const def = { setupHash: 'h1' } as any;
  it('prepares a box launched for what the environment is now', () => {
    expect(helloAction('h1', { ok: true, def })).toEqual({ kind: 'prepare' });
  });
  it('retries later, never fails, when the environment could not be resolved just now (GitHub, the credential)', () => {
    expect(helloAction('h1', { ok: false, reason: 'GitHub answered 502' })).toEqual({ kind: 'retry', reason: 'GitHub answered 502' });
  });
  it('retires a box whose environment is gone, or moved on since its launch', () => {
    expect(helloAction('h1', null)).toEqual({ kind: 'retire', reason: 'its environment is gone' });
    expect(helloAction('h0', { ok: true, def })).toEqual({ kind: 'retire', reason: 'stale before it prepared' });
  });
});

describe('the second round of review on #1453 (Devin, Bugbot)', () => {
  it('fails, with its cause, a box whose environment can no longer be pooled at all (permanent), instead of retrying', () => {
    expect(helloAction('h1', { ok: false, reason: 'envdemo is personal; only a shared environment has a pool', permanent: true }))
      .toEqual({ kind: 'fail', reason: 'envdemo is personal; only a shared environment has a pool' });
    expect(helloAction('h1', { ok: false, reason: 'GitHub answered 502' }).kind).toBe('retry');
  });

  it('marks the resolutions that no retry can change as permanent', async () => {
    expect(await resolveEnvPoolDefinition({ ...pointer, visibility: 'personal' }, deps())).toMatchObject({ ok: false, permanent: true });
    const flaky = await resolveEnvPoolDefinition(pointer, deps({ head: async () => ({ error: 'GitHub could not be reached' }) }));
    expect(flaky).toEqual({ ok: false, reason: 'GitHub could not be reached' });
  });

  it("fails a prepare only on the agent's own refusal; a send that didn't reach it (not connected here, a dropped socket) waits for its next hello", () => {
    expect(prepareSendOutcome({ answer: { error: 'environment-prepare: not a pool box' } })).toEqual({ kind: 'fail', reason: 'environment-prepare: not a pool box' });
    expect(prepareSendOutcome({ thrown: new Error('Agent disconnected') })).toEqual({ kind: 'wait', reason: 'Agent disconnected' });
    expect(prepareSendOutcome({ answer: { started: true } })).toEqual({ kind: 'started', running: false });
    expect(prepareSendOutcome({ answer: { running: true } })).toEqual({ kind: 'started', running: true });
  });

  it('sends the stop again only while the row is still env-stopping: a claim may have taken it since the tick read it', async () => {
    const stop = vi.fn(async () => undefined);
    expect(await restopIfStillStopping({ stillStopping: async () => false, stop })).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(await restopIfStillStopping({ stillStopping: async () => true, stop })).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('the third review round on #1453 (Bugbot, Cursor security review)', () => {
  it("refuses, permanently, an environment that names a repository outside our GitHub orgs: the pool never clones or runs it", async () => {
    const d = deps();
    (d.reader.read as any).mockResolvedValue({ repo: 'e2e-org/envdemo', commit: 'c'.repeat(40), sizes: null, repos: [{ repo: 'outsider/tool' }], warnings: [], text: FILE });
    const res = await resolveEnvPoolDefinition(pointer, d);
    expect(res).toMatchObject({ ok: false, permanent: true, reason: expect.stringContaining('outsider/tool') });
  });

  it("resolves the environment afresh at a hello, past the 60 s cache, and refreshes the cache with it", async () => {
    resetEnvPoolCache();
    const personal = { ...pointer, visibility: 'personal' as const };
    expect(await envPoolDefinitionByName('envdemo', deps({ store: { byName: async () => personal, get: async () => personal } }))).toMatchObject({ ok: false, permanent: true });
    // The environment is shared again: the cache still says no, a hello's fresh read says yes.
    const fresh = await resolveForHello(pointer, deps());
    expect(fresh.ok).toBe(true);
    expect((await envPoolDefinitionByName('envdemo', deps())).ok).toBe(true);
  });
});

describe('resolveForHello keeps a transient failure to itself (Devin on #1453)', () => {
  it("doesn't replace the cached definition the claims read with a GitHub blip, but does with a success or a permanent refusal", async () => {
    resetEnvPoolCache();
    expect((await envPoolDefinitionByName('envdemo', deps())).ok).toBe(true);
    const blip = await resolveForHello(pointer, deps({ head: async () => ({ error: 'GitHub answered 502' }) }));
    expect(blip).toEqual({ ok: false, reason: 'GitHub answered 502' });
    // The claims still see the ready pool.
    expect((await envPoolDefinitionByName('envdemo', deps({ head: async () => ({ error: 'not called: cached' }) }))).ok).toBe(true);
    // A permanent refusal is cached: it stays true however often it is read.
    await resolveForHello({ ...pointer, visibility: 'personal' }, deps());
    expect(await envPoolDefinitionByName('envdemo', deps())).toMatchObject({ ok: false, permanent: true });
  });
});
