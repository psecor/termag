import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./repoEnvironment', () => ({ repoEnvironment: { text: vi.fn() } }));
vi.mock('./workspaceEvents', () => ({ notifyWorkspaceChange: vi.fn() }));
vi.mock('./agentRegistry', () => ({ onBoxAgentFrame: vi.fn(), projectAgentCapabilities: vi.fn(() => []), sendToInstanceAgent: vi.fn() }));

import { environmentUpRequest, finishedSetup, parseEnvironmentFileRef, parseEnvironmentStatusFrame, setupEventProps, setupWhere } from './projectEnvironment';

// These fixtures use acme/… repositories: count acme as one of our orgs here (environments.ts reposOutsideOrgs).
beforeAll(() => { vi.stubEnv('GITHUB_REPO_ORGS', 'example-org,example-team,acme'); });
afterAll(() => { vi.unstubAllEnvs(); });


const base = { id: 'p1', instanceId: 'b1', layout: 'repo', environmentFile: null, dir: '/home/ada/termag/projects/web', otherProjectsOnBox: 0, chatTrustedAt: new Date('2026-10-30T00:00:00Z'), userId: 'u1' };

describe('environmentUpRequest', () => {
  it("sends a single repository's implicit file to the box made for it, held (Security Agent, #998)", () => {
    expect(environmentUpRequest(base)).toEqual({ payload: { projectId: 'p1', instanceId: 'b1', dir: '/home/ada/termag/projects/web', trusted: true, hold: 'checkout' } });
  });

  it("sends a pointer's file as it was frozen at creation, named repo:branch:path", () => {
    const pointer = { name: 'full-stack', repo: 'acme/web', branch: 'env', path: '.termag/full-stack/environment.json', text: '{"run":"make"}', editedBy: 'u1' };
    expect(environmentUpRequest({ ...base, layout: 'workspace', environmentFile: pointer })).toEqual({
      payload: { projectId: 'p1', instanceId: 'b1', dir: base.dir, trusted: true, fileRepo: 'acme/web', filePath: 'acme/web:env:.termag/full-stack/environment.json', fileText: '{"run":"make"}' },
    });
  });

  it("leaves a pointer that couldn't be read at creation to the box's checkout of its repository, and starts it (decision #58)", () => {
    const req = environmentUpRequest({ ...base, environmentFile: { name: 'x', repo: 'acme/web', path: '.termag/x.json', editedBy: 'u1' } });
    expect(req).toEqual({ payload: { projectId: 'p1', instanceId: 'b1', dir: base.dir, trusted: true, fileRepo: 'acme/web', filePath: '.termag/x.json' } });
  });

  it("sends an inline environment's own file, which no repository holds", () => {
    const req = environmentUpRequest({ ...base, layout: 'workspace', environmentFile: { name: 'full-stack', text: '{"repos":[{"repo":"acme/web"}]}', editedBy: 'u1' } });
    expect(req).toEqual({ payload: expect.objectContaining({ fileText: '{"repos":[{"repo":"acme/web"}]}', filePath: "full-stack's file" }) });
    expect((req as { payload: Record<string, unknown> }).payload).not.toHaveProperty('fileRepo');
  });

  it('starts nothing on a box that has other projects: it was not made for this one', () => {
    expect(environmentUpRequest({ ...base, otherProjectsOnBox: 1 })).toEqual({ skip: 'not-first' });
  });

  it('runs nothing for a multi-repo project made without an environment', () => {
    expect(environmentUpRequest({ ...base, layout: 'workspace' })).toEqual({ skip: 'no-file' });
  });
});

describe('parseEnvironmentFileRef', () => {
  it('takes an inline text, or a pointer with its branch', () => {
    expect(parseEnvironmentFileRef({ name: 'x', text: '{}' })).toEqual({ name: 'x', text: '{}' });
    expect(parseEnvironmentFileRef({ repo: 'acme/web', branch: 'feature/env', path: 'e.json' })).toEqual({ repo: 'acme/web', branch: 'feature/env', path: 'e.json' });
    expect(parseEnvironmentFileRef({ repo: 'acme/web', branch: '../x', path: 'e.json' })).toEqual({ repo: 'acme/web', path: 'e.json' });
  });

  it('takes a relative path in owner/name, and nothing that climbs out of it', () => {
    expect(parseEnvironmentFileRef({ name: 'x', repo: 'acme/web', path: '.termag/environment.json' })).toEqual({ name: 'x', repo: 'acme/web', path: '.termag/environment.json' });
    expect(parseEnvironmentFileRef({ repo: 'acme/web', path: '../x' })).toBeNull();
    expect(parseEnvironmentFileRef({ repo: 'acme/web', path: '/etc/x' })).toBeNull();
    expect(parseEnvironmentFileRef({ repo: 'not a repo', path: 'x' })).toBeNull();
    expect(parseEnvironmentFileRef(null)).toBeNull();
  });
});

describe('parseEnvironmentStatusFrame', () => {
  const frame = {
    type: 'environment-status', projectId: 'p1', instanceId: 'b1',
    status: {
      state: 'up', file: '.termag/environment.json',
      setup: { state: 'succeeded', startedAt: 't0', finishedAt: 't1', durationMs: 151000.4, exitCode: 0 },
      run: { state: 'succeeded', durationMs: 42000 },
      seed: { state: 'bogus' },
      ports: [{ name: 'frontend', port: 5174, path: '/termag/', healthy: true }, { port: 99999 }, { name: 'backend', port: 3040, healthy: 'yes' }],
      secrets: { resolved: ['APP_API_KEY'], missing: ['APP_SDK_KEY', 7] },
      warnings: ['APP_SDK_KEY is not something termag delivers'],
    },
  };

  it('keeps what the UIs show, field by field', () => {
    const parsed = parseEnvironmentStatusFrame(frame)!;
    expect(parsed.projectId).toBe('p1');
    expect(parsed.status.setup).toEqual({ state: 'succeeded', startedAt: 't0', finishedAt: 't1', durationMs: 151000, exitCode: 0 });
    expect(parsed.status.seed).toEqual({ state: 'none' });
    expect(parsed.status.ports).toEqual([
      { name: 'frontend', port: 5174, path: '/termag/', healthy: true },
      { name: 'backend', port: 3040, path: '/', healthy: false },
    ]);
    expect(parsed.status.secrets).toEqual({ resolved: ['APP_API_KEY'], missing: ['APP_SDK_KEY'] });
  });

  it('drops a frame with no project or no status', () => {
    expect(parseEnvironmentStatusFrame({ status: {} })).toBeNull();
    expect(parseEnvironmentStatusFrame({ projectId: 'p1' })).toBeNull();
  });

  it('names a setup once, when it finishes', () => {
    const next = parseEnvironmentStatusFrame(frame)!.status;
    expect(finishedSetup({ setup: { state: 'running' } }, next)).toMatchObject({ state: 'succeeded', durationMs: 151000 });
    expect(finishedSetup(next, next)).toBeNull();
    expect(finishedSetup(null, { ...next, setup: { state: 'running' } })).toBeNull();
  });
});

describe('environmentFileRecord (services/environments.ts)', () => {
  it("records an inline definition's JSON as the text the box runs, else the pointer with its branch", async () => {
    const { environmentFileRecord } = await import('./environments');
    const definition = { repos: [{ repo: 'acme/web' }], run: 'make dev' };
    expect(environmentFileRecord({ name: 'a', kind: 'inline', definition })).toEqual({ name: 'a', text: JSON.stringify(definition) });
    expect(environmentFileRecord({ name: 'b', kind: 'pointer', file: { repo: 'acme/web', branch: 'env', path: '.termag/b.json' } }))
      .toEqual({ name: 'b', repo: 'acme/web', branch: 'env', path: '.termag/b.json' });
    expect(environmentFileRecord({ name: 'c', kind: 'pointer', file: { repo: 'acme/web', branch: null, path: '.termag/environment.json' } }))
      .toEqual({ name: 'c', repo: 'acme/web', path: '.termag/environment.json' });
  });
});

// Security Agent on #998: the steps run at claim only for a project its owner trusted, and the file is the one frozen at creation.
describe('environment-up and the owner\'s trust', () => {
  const trusted = base;

  // Review on #998: it's held, not silent: the box keeps the definition and the card says Full access starts it.
  // Decision #58: picking the environment is the consent, so the trust tick doesn't decide; a repository's own file is held either way.
  it("doesn't wait for the trust tick: a repository's own file is held whether trusted or not", () => {
    expect(environmentUpRequest({ ...base, chatTrustedAt: null })).toEqual({ payload: expect.objectContaining({ hold: 'checkout', trusted: true }) });
    expect(environmentUpRequest(trusted)).toEqual({ payload: expect.objectContaining({ trusted: true }) });
  });

  it("sends the pointer's file as it was read at creation, not read again at claim", () => {
    const frozen = { name: 'full-stack', repo: 'acme/web', branch: 'env', path: '.termag/x.json', text: '{"run":"make"}', editedBy: 'u1' };
    expect(environmentUpRequest({ ...trusted, environmentFile: frozen })).toEqual({
      payload: expect.objectContaining({ fileRepo: 'acme/web', filePath: 'acme/web:env:.termag/x.json', fileText: '{"run":"make"}', trusted: true }),
    });
  });

  it('freezes a pointer at creation: reads its file once, with the creator\'s credential, and keeps the pointer when it cannot', async () => {
    const { freezeEnvironmentFile } = await import('./projectEnvironment');
    const reader = { text: vi.fn(async () => ({ text: '{"run":"make dev"}' })) };
    expect(await freezeEnvironmentFile('u1', { name: 'e', repo: 'acme/web', branch: 'env', path: 'e.json' }, reader))
      .toEqual({ name: 'e', repo: 'acme/web', branch: 'env', path: 'e.json', text: '{"run":"make dev"}' });
    expect(reader.text).toHaveBeenCalledWith('u1', 'acme/web', 'e.json', 'env');
    reader.text.mockResolvedValueOnce({ error: 'acme/web has no e.json' } as never);
    expect(await freezeEnvironmentFile('u1', { name: 'e', repo: 'acme/web', path: 'e.json' }, reader)).toEqual({ name: 'e', repo: 'acme/web', path: 'e.json' });
    const inline = { name: 'i', text: '{}' };
    expect(await freezeEnvironmentFile('u1', inline, reader)).toBe(inline);
  });
});

// Security Agent on #998 (environments.ts:355/:363): a shared environment anyone can edit. Its commands start
// on their own only for a project whose owner wrote its current version; another editor's version is cloned and
// readable, and runs when the owner runs it (termag-env up).
describe("a shared environment's commands and who last edited it", () => {
  const owner = 'u-owner';
  const named = (editedBy: string | null | undefined) => ({ name: 'full-stack', text: '{"run":"make dev"}', ...(editedBy !== undefined ? { editedBy } : {}) });

  it('starts the steps when the project owner made the version the project was created from', () => {
    expect(environmentUpRequest({ ...base, userId: owner, environmentFile: named(owner) })).toEqual({ payload: expect.objectContaining({ trusted: true, fileText: '{"run":"make dev"}' }) });
  });

  // Decision #58: picking it is the consent, whoever last edited it.
  it('starts them when someone else edited it last, and when the record does not say who', () => {
    for (const f of [named('u-coworker'), named(undefined)]) expect((environmentUpRequest({ ...base, userId: owner, environmentFile: f }) as { payload: Record<string, unknown> }).payload).not.toHaveProperty('hold');
  });

  it("is not about a repository's own file, which the owner's trust covers", () => {
    expect(environmentUpRequest({ ...base, userId: owner, environmentFile: null })).toEqual({ payload: expect.objectContaining({ trusted: true }) });
  });

  it('records the last editor at creation, frozen with the definition', async () => {
    const { environmentFileRecord } = await import('./environments');
    expect(environmentFileRecord({ name: 'a', kind: 'inline', definition: { run: 'x' }, updatedByUserId: 'u-coworker', createdByUserId: 'u-owner' }))
      .toEqual({ name: 'a', text: JSON.stringify({ run: 'x' }), editedBy: 'u-coworker' });
    expect(environmentFileRecord({ name: 'b', kind: 'pointer', file: { repo: 'acme/web', branch: null, path: 'e.json' }, updatedByUserId: null, createdByUserId: 'u-owner' }))
      .toEqual({ name: 'b', repo: 'acme/web', path: 'e.json', editedBy: 'u-owner' });
  });
});

// Bugbot on #998 (1b6aec08): a held environment still reaches the box, so termag-env up can run it once its owner has read it.
describe("someone else's version is held on the box, not withheld", () => {
  it('sends the frozen file to start, whoever wrote this version', () => {
    const req = environmentUpRequest({ ...base, userId: 'u-owner', environmentFile: { name: 'full-stack', text: '{"run":"make dev"}', editedBy: 'u-coworker' } });
    expect(req).toEqual({ payload: expect.objectContaining({ fileText: '{"run":"make dev"}', trusted: true }) });
    expect((req as { payload: Record<string, unknown> }).payload).not.toHaveProperty('hold');
  });

  it('starts as before for the owner\'s own version: no hold', () => {
    const req = environmentUpRequest({ ...base, userId: 'u-owner', environmentFile: { name: 'full-stack', text: '{}', editedBy: 'u-owner' } });
    expect((req as { payload: Record<string, unknown> }).payload).not.toHaveProperty('hold');
  });
});

// Bugbot on #998 (8ebe1075): a definition that fits the cap compact must still fit once stored.
describe('an inline definition near the size cap', () => {
  it('is stored compact, so the record the box gets is the definition that was saved', async () => {
    const { environmentFileRecord } = await import('./environments');
    const steps: Record<string, string> = {};
    for (let i = 0; i < 900; i++) steps[`acme/r${i}`] = 'x';
    const definition = { repos: [{ repo: 'acme/web' }], setup: steps };
    expect(Buffer.byteLength(JSON.stringify(definition))).toBeLessThan(16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(definition, null, 2))).toBeGreaterThan(16 * 1024);
    const record = environmentFileRecord({ name: 'big', kind: 'inline', definition, updatedByUserId: 'u1' });
    expect(parseEnvironmentFileRef(record)).toEqual(expect.objectContaining({ text: JSON.stringify(definition) }));
  });
});

// Security Agent on #998 (8ebe1075): an automation's trust tick is consent to its classifier-gated auto mode, not to running checkout commands.
describe('automations', () => {
  it('never start environment steps, trusted or not', () => {
    expect(environmentUpRequest({ ...base, kind: 'automation' })).toEqual({ skip: 'automation' });
    // Its definition is delivered held (Bugbot, #998): still nothing starts.
    expect(environmentUpRequest({ ...base, kind: 'automation', environmentFile: { name: 'e', text: '{}', editedBy: 'u1' } })).toEqual({ payload: expect.objectContaining({ hold: 'automation' }) });
    expect(environmentUpRequest({ ...base, kind: 'normal' })).toEqual({ payload: expect.objectContaining({ trusted: true }) });
  });
});

// Security Agent on #998 (1c1f4cf6): a pointer whose file couldn't be pinned at creation is the branch's
// current text, not the version the owner chose, so it never starts on its own.
describe('a pointer that could not be pinned', () => {
  const base = { id: 'p1', instanceId: 'i1', layout: 'single', dir: '/w/p1', otherProjectsOnBox: 0, chatTrustedAt: new Date(), userId: 'u-owner' };
  it('starts it from the checkout (decision #58: any branch)', () => {
    const req = environmentUpRequest({ ...base, environmentFile: { name: 'web', repo: 'acme/web', path: '.termag/environment.json', editedBy: 'u-owner' } });
    expect(req).toEqual({ payload: expect.objectContaining({ trusted: true, filePath: '.termag/environment.json', fileRepo: 'acme/web' }) });
    expect((req as { payload: Record<string, unknown> }).payload).not.toHaveProperty('hold');
    expect((req as { payload: Record<string, unknown> }).payload).not.toHaveProperty('fileText');
  });

  // Security Agent on #998 (c93708ad): the environment's editor didn't write the pointer's file; its branch's writers did.
  it('starts a pinned pointer with the pinned text', () => {
    const req = environmentUpRequest({ ...base, environmentFile: { name: 'web', repo: 'acme/web', path: '.termag/environment.json', text: '{"setup":"make"}', editedBy: 'u-owner' } });
    expect(req).toEqual({ payload: expect.objectContaining({ fileText: '{"setup":"make"}', trusted: true }) });
    expect((req as { payload: Record<string, unknown> }).payload).not.toHaveProperty('hold');
  });

  it("while an inline definition its owner wrote still starts on its own", () => {
    const req = environmentUpRequest({ ...base, environmentFile: { name: 'web', text: '{"setup":"make"}', editedBy: 'u-owner' } });
    expect((req as { payload: Record<string, unknown> }).payload).not.toHaveProperty('hold');
  });
});

// Security Agent on #998 (061f9184): a repository's own .termag/environment.json is whatever its branch holds
// at clone, which anyone who can push it chose; it never runs unattended. An environment's definition the
// owner wrote, pinned at creation, still does.
describe("a repository's own environment file", () => {
  const base = { id: 'p1', instanceId: 'i1', layout: 'single', dir: '/w/p1', otherProjectsOnBox: 0, chatTrustedAt: new Date(), userId: 'u-owner' };
  it('is held on a trusted project, for its owner to read and run', () => {
    const req = environmentUpRequest({ ...base, environmentFile: null });
    expect(req).toEqual({ payload: expect.objectContaining({ hold: 'checkout', trusted: true }) });
    expect((req as { payload: Record<string, unknown> }).payload).not.toHaveProperty('fileText');
  });

  it("while an environment's pinned definition its owner wrote still starts on its own", () => {
    const req = environmentUpRequest({ ...base, environmentFile: { name: 'full-stack', text: '{}', editedBy: 'u-owner' } });
    expect((req as { payload: Record<string, unknown> }).payload).not.toHaveProperty('hold');
  });
});

// Bugbot on #998 (bea08d69): a project that starts nothing on its own still gets its environment's definition,
// held, so the owner's termag-env up runs what was chosen rather than the checkout's file.
describe('a project that starts nothing on its own', () => {
  const base = { id: 'p1', instanceId: 'i1', layout: 'single', dir: '/w/p1', otherProjectsOnBox: 0, chatTrustedAt: new Date(), userId: 'u-owner' };
  const file = { name: 'full-stack', text: '{"setup":"make"}', editedBy: 'u-owner' };
  it("delivers its environment's definition held, on a box made for another project", () => {
    expect(environmentUpRequest({ ...base, otherProjectsOnBox: 2, environmentFile: file }))
      .toEqual({ payload: expect.objectContaining({ hold: 'not-first', fileText: '{"setup":"make"}' }) });
  });
  it("delivers an automation's definition held, trusted or not", () => {
    for (const chatTrustedAt of [new Date(), null]) {
      expect(environmentUpRequest({ ...base, kind: 'automation', chatTrustedAt, environmentFile: file }))
        .toEqual({ payload: expect.objectContaining({ hold: 'automation', fileText: '{"setup":"make"}' }) });
    }
  });
  it('still sends nothing when there is no definition to deliver', () => {
    expect(environmentUpRequest({ ...base, otherProjectsOnBox: 2, environmentFile: null })).toEqual({ skip: 'not-first' });
    expect(environmentUpRequest({ ...base, kind: 'automation', environmentFile: null })).toEqual({ skip: 'automation' });
  });
});

// Bugbot on #998 (9df5afe2): a port the box found on ::1 keeps that, so its links open at [::1].
describe('a port answered on ::1', () => {
  it('keeps host ::1 from the frame, and drops any other host', () => {
    const frame = (host: unknown) => parseEnvironmentStatusFrame({ projectId: 'p1', status: { state: 'up', ports: [{ name: 'web', port: 5174, path: '/', healthy: true, host }] } })!;
    expect(frame('::1').status.ports[0]).toMatchObject({ host: '::1' });
    for (const h of ['127.0.0.1', 'evil.example', 7]) expect(frame(h).status.ports[0]).not.toHaveProperty('host');
  });
});

// Bugbot on #998 (35c6d2f5): a pinned pointer whose file is over the cap is still that pointer, unpinned, never
// "no environment" (which would run the checkout's implicit file instead).
describe('a pointer whose pinned file is over the size cap', () => {
  it('keeps the pointer without its text, read from the checkout', () => {
    const big = 'x'.repeat(16 * 1024 + 1);
    const ref = parseEnvironmentFileRef({ name: 'web', repo: 'acme/web', path: '.termag/environment.json', text: big, editedBy: 'u1' });
    expect(ref).toEqual({ name: 'web', repo: 'acme/web', path: '.termag/environment.json', editedBy: 'u1' });
    const req = environmentUpRequest({ id: 'p1', instanceId: 'i1', layout: 'workspace', dir: '/w', otherProjectsOnBox: 0, chatTrustedAt: new Date(), userId: 'u1',
      environmentFile: { name: 'web', repo: 'acme/web', path: '.termag/environment.json', text: big, editedBy: 'u1' } });
    expect(req).toEqual({ payload: expect.objectContaining({ fileRepo: 'acme/web' }) });
    expect((req as { payload: Record<string, unknown> }).payload).not.toHaveProperty('fileText');
  });
  it('still drops an inline file over the cap: there is nothing else to run', () => {
    expect(parseEnvironmentFileRef({ name: 'big', text: 'x'.repeat(16 * 1024 + 1) })).toBeNull();
  });
});


// Review on #998: the setup event says what started it, whether it was a rerun, and which environment and repos.
describe('the environment.setup event', () => {
  it('carries the trigger, the rerun, the environment and its repositories, and keeps them through the frame', () => {
    const frame = parseEnvironmentStatusFrame({ projectId: 'p1', status: { state: 'up', trigger: 'trust', held: 'untrusted', setup: { state: 'succeeded', durationMs: 61_000, exitCode: 0, rerun: true } } })!;
    expect(frame.status).toMatchObject({ trigger: 'trust', held: 'untrusted', setup: { rerun: true } });
    expect(parseEnvironmentStatusFrame({ projectId: 'p1', status: { state: 'up', trigger: 'evil', held: 'x'.repeat(80) } })!.status).not.toHaveProperty('trigger');
    const props = setupEventProps(frame.status, frame.status.setup, { environmentFile: { name: 'full-stack' }, repoUrl: null, repos: [{ url: 'https://github.com/acme/web' }, { url: 'https://github.com/acme/api' }] });
    expect(props).toEqual({ outcome: 'succeeded', durationSec: 61, exitCode: 0, trigger: 'trust', rerun: true, where: 'box', incremental: true, environment: 'full-stack', repos: 'acme/web,acme/api' });
    expect(setupEventProps({ ...frame.status, trigger: undefined }, { state: 'failed' }, { environmentFile: null, repoUrl: 'https://github.com/acme/app.git', repos: [] }))
      .toEqual({ outcome: 'failed', durationSec: null, exitCode: null, trigger: null, rerun: false, where: 'box', incremental: false, environment: 'implicit', repos: 'acme/app' });
  });

  it('says where setup ran: catching up at claim on a box an environment pool prepared, at a box\'s own first run, or from termag-env', () => {
    const pooled = parseEnvironmentStatusFrame({ projectId: 'p1', status: { state: 'up', trigger: 'claim', preparedByPool: true, setup: { state: 'succeeded' } } })!;
    expect(setupWhere(pooled.status, pooled.status.setup)).toEqual({ where: 'claim', incremental: true });
    expect(setupWhere({ trigger: 'claim' }, { rerun: false })).toEqual({ where: 'box', incremental: false });
    expect(setupWhere({ trigger: 'cli' }, { rerun: true })).toEqual({ where: 'up', incremental: true });
  });
});
