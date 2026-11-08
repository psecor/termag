import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

/**
 * GET /api/instances/sizes: what the New box dropdowns offer, with
 * `defaultSize`, which they preselect: what a box with no size launches at
 * for `?repo=` (its .termag/environment.json, else the caller's box-default-size).
 */

// box-default-size per user id, else off ("").
const flag = vi.hoisted(() => ({ byUser: {} as Record<string, string> }));
vi.mock('../services/featureFlags', () => ({
  boolVariation: vi.fn(async (_key: string, _user: unknown, fallback: boolean) => fallback),
  boolVariationForContext: vi.fn(async (_key: string, _ctx: unknown, fallback: boolean) => fallback),
  stringVariation: vi.fn(async (key: string, user: { id: string }, fallback: string) =>
    key === 'box-default-size' ? flag.byUser[user.id] ?? fallback : fallback),
  stringVariationForContext: vi.fn(async (_key: string, _ctx: unknown, fallback: string) => fallback),
}));
vi.mock('../db', () => ({ prisma: {} }));
// Signs in as the user the request names.
vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: { id: string } }).user = { id: String(req.headers['x-user']) };
    next();
  },
}));
vi.mock('../services/boxProvisioner', () => ({ provisionBox: vi.fn(), terminateBox: vi.fn(), isBoxProvisioningConfigured: () => true }));
vi.mock('../services/warmPool', () => ({ poolSpecHashOrNull: vi.fn(), reconcileWarmPool: vi.fn() }));
vi.mock('../services/agentRegistry', () => ({ sendToInstanceAgent: vi.fn(), isInstanceAgentConnected: () => false }));
vi.mock('../services/warmPoolClaim', () => ({ claimWarmBox: vi.fn(), isNameConflict: () => false, prismaClaimEffects: {} }));

// Each repository's .termag/environment.json, and EC2's match for requirements.
const files = vi.hoisted(() => ({ byRepo: {} as Record<string, { sizes: unknown; warnings: string[] }> }));
vi.mock('../services/repoEnvironment', () => ({
  repoSizesFor: vi.fn(async (_user: string, repo: string | null) => (repo && files.byRepo[repo]) || { sizes: null, warnings: [] }),
}));
vi.mock('../services/environments', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/environments')>(),
  prismaEnvironmentStore: {
    byName: vi.fn(async (name: string) => (name === 'full-stack' ? { id: 'e1', name, visibility: 'personal', ownerUserId: 'ada', kind: 'pointer', file: { repo: 'acme/tiny', branch: null, path: 'e.json' } } : null)),
  },
  resolveStoredEnvironment: vi.fn(async (_user: string, env: { name: string }) => (env.name === 'full-stack' ? { repos: [], sizes: { size: 'large' }, warnings: [] } : { repos: [], sizes: null, warnings: [] })),
}));
const matches = vi.hoisted(() => ({ ok: true }));
vi.mock('../services/boxRequirements', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/boxRequirements')>(),
  requirementsResolver: {
    resolve: vi.fn(async () => (matches.ok
      ? { ok: true, choice: { type: 'r8g.xlarge', fallbacks: ['r7g.xlarge'] }, preset: null }
      : { ok: false, warning: '4 vCPU, 32 GB: EC2 could not match it (denied)' })),
  },
}));

const { instancesRouter } = await import('./instances');

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use('/api/instances', instancesRouter());
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/instances`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => {
  flag.byUser = {};
  matches.ok = true;
  files.byRepo = {
    'https://github.com/acme/tiny': { sizes: { size: 'small' }, warnings: [] },
    'https://github.com/acme/big-memory': { sizes: { size: { vcpu: 4, memoryGiB: 32 } }, warnings: [] },
    'https://github.com/acme/typo': { sizes: { size: null }, warnings: ['acme/typo\'s .termag/environment.json: "resources" is "huge", …'] },
  };
});

const sizesFor = async (user: string, repo?: string) =>
  (await fetch(`${base}/sizes${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`, { headers: { 'x-user': user } })).json();

describe('GET /api/instances/sizes', () => {
  it('returns each caller\'s own box-default-size as defaultSize', async () => {
    flag.byUser = { ada: 'large', bob: 'medium' };
    expect(await sizesFor('ada')).toMatchObject({ enabled: true, defaultSize: 'large', default: 'large' });
    expect(await sizesFor('bob')).toMatchObject({ enabled: true, defaultSize: 'medium' });
  });

  it('preselects what decideBoxSize says for ?repo=: its environment.json size, smaller than the default too', async () => {
    flag.byUser = { ada: 'large' };
    expect(await sizesFor('ada', 'https://github.com/acme/tiny')).toMatchObject({ defaultSize: 'small', defaultSource: 'repo', defaultRequirements: null, default: 'large' });
    expect(await sizesFor('ada', 'https://github.com/acme/none')).toMatchObject({ defaultSize: 'large', defaultSource: 'flag' });
  });

  it('answers a repo\'s requirements with the type EC2 matched, for the picker\'s entry, and their fallback', async () => {
    flag.byUser = { ada: 'medium' };
    expect(await sizesFor('ada', 'https://github.com/acme/big-memory')).toMatchObject({
      defaultSize: 'medium', defaultSource: 'repo', defaultRequirements: { vcpu: 4, memoryGiB: 32, instanceType: 'r8g.xlarge' }, warnings: [],
    });
    matches.ok = false;
    expect(await sizesFor('ada', 'https://github.com/acme/big-memory')).toMatchObject({
      defaultSize: 'medium', defaultRequirements: null, warnings: [expect.stringContaining('launching medium instead')],
    });
  });

  it('takes ?repo= once per repository for a multi-repo project, and reads them all', async () => {
    flag.byUser = { ada: 'medium' };
    const { repoSizesFor } = await import('../services/repoEnvironment');
    vi.mocked(repoSizesFor).mockClear();
    const got = await (await fetch(`${base}/sizes?repo=${encodeURIComponent('https://github.com/acme/tiny')}&repo=${encodeURIComponent('https://github.com/acme/typo')}`, { headers: { 'x-user': 'ada' } })).json();
    expect(vi.mocked(repoSizesFor).mock.calls.at(-1)?.[1]).toEqual(['https://github.com/acme/tiny', 'https://github.com/acme/typo']);
    expect(got).toMatchObject({ enabled: true });
  });

  it('passes on what of the repo\'s environment.json was left out', async () => {
    flag.byUser = { ada: 'medium' };
    expect(await sizesFor('ada', 'https://github.com/acme/typo')).toMatchObject({ defaultSize: 'medium', warnings: [expect.stringContaining('"huge"')] });
  });

  it('is off, with nothing to preselect, while the flag serves "" (the dropdowns stay hidden)', async () => {
    flag.byUser = { ada: 'large' };
    expect(await sizesFor('cy')).toEqual({
      enabled: false, default: null, defaultSize: null, defaultSource: 'configured', defaultRequirements: null, sizes: [], warnings: [],
      disk: { minGiB: 50, maxGiB: 300, defaultGiB: 120, diskGiB: 120 },
    });
  });

  it('answers the disk range and default whatever the size flag says, with ?repo=\'s diskGiB as what a box gets', async () => {
    files.byRepo['https://github.com/acme/disky'] = { sizes: { size: null, diskGiB: 250 }, warnings: [] };
    expect(await sizesFor('cy', 'https://github.com/acme/disky')).toMatchObject({ enabled: false, disk: { minGiB: 50, maxGiB: 300, defaultGiB: 120, diskGiB: 250 } });
    flag.byUser = { ada: 'large' };
    expect(await sizesFor('ada', 'https://github.com/acme/disky')).toMatchObject({ enabled: true, defaultSize: 'large', disk: { diskGiB: 250 } });
    expect(await sizesFor('ada', 'https://github.com/acme/tiny')).toMatchObject({ defaultSize: 'small', disk: { diskGiB: 120 } });
  });

  it("preselects an environment's file size for ?environment=, and 404s one there is none of", async () => {
    flag.byUser = { ada: 'small' };
    const get = (q: string) => fetch(`${base}/sizes?${q}`, { headers: { 'x-user': 'ada' } });
    expect(await (await get('environment=full-stack&repo=https%3A%2F%2Fgithub.com%2Facme%2Ftiny')).json()).toMatchObject({ defaultSize: 'large', defaultSource: 'repo' });
    const missing = await get('environment=nope');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'environment_not_found' });
  });
});
