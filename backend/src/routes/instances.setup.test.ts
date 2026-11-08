import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A new box's termag setup through POST /api/instances:
 * as asked (setupEnabled), else the repos' .termag/environment.json
 * `setupEnabled` when the caller states it (useRepoSetup, the CLI), else on.
 * Setup off needs empty-box-enabled and never comes from the warm pool.
 */

const flag = vi.hoisted(() => ({ setupOff: true, dotfiles: false }));
vi.mock('../services/featureFlags', () => ({
  boolVariation: vi.fn(async (key: string, _user: unknown, fallback: boolean) =>
    key === 'empty-box-enabled' ? flag.setupOff : key === 'onboarding-refresh-enabled' ? flag.dotfiles : fallback),
  boolVariationForContext: vi.fn(async (_key: string, _ctx: unknown, fallback: boolean) => fallback),
  stringVariation: vi.fn(async (_key: string, _user: unknown, fallback: string) => fallback),
  stringVariationForContext: vi.fn(async (_key: string, _ctx: unknown, fallback: string) => fallback),
  numberVariationForContext: vi.fn(async (_key: string, _ctx: unknown, fallback: number) => fallback),
  jsonVariationForContext: vi.fn(async (_key: string, _ctx: unknown, fallback: unknown) => fallback),
}));

const claimWarmBox = vi.hoisted(() => vi.fn());
const provisionBox = vi.hoisted(() => vi.fn(async () => {}));
const created = vi.hoisted(() => [] as Array<Record<string, unknown>>);
// The box of the same name a create finds: null, or a failed one a Try again retires.
const existingBox = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }));
const retired = vi.hoisted(() => [] as string[]);
vi.mock('../db', () => ({
  prisma: {
    instance: {
      findFirst: vi.fn(async () => existingBox.row),
      count: vi.fn(async () => 0),
      updateMany: vi.fn(async (args: { where: { id: string } }) => { retired.push(args.where.id); return { count: 1 }; }),
      findUnique: vi.fn(async () => existingBox.row),
    },
    agentToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
    project: { count: vi.fn(async () => 0) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      instance: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return { id: 'cold1', ...args.data };
        }),
      },
      agentToken: { create: vi.fn(async () => ({})) },
    })),
  },
}));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('../services/boxProvisioner', () => ({ provisionBox, terminateBox: vi.fn(), isBoxProvisioningConfigured: () => true }));
vi.mock('../services/warmPool', () => ({ poolSpecHashOrNull: vi.fn(async () => 'spec1'), reconcileWarmPool: vi.fn(async () => {}) }));
vi.mock('../services/agentRegistry', () => ({ sendToInstanceAgent: vi.fn() }));
vi.mock('../services/warmPoolClaim', () => ({
  claimWarmBox, isNameConflict: () => false, prismaClaimEffects: {},
}));
vi.mock('../services/boxCreationGate', () => ({ readBoxCreationFacts: vi.fn(async () => ({})), boxCreationRefusal: vi.fn(() => null) }));

const BARE = 'https://github.com/acme/bare';
const UNREAD = 'https://github.com/acme/unread';
const UNREAD_WARNING = "couldn't read acme/unread's .termag/environment.json (GitHub answered 500 for its default branch), so it was left out";
const repoSetupFor = vi.hoisted(() => vi.fn(async (_user: string, repos: string[]) =>
  (repos.includes('https://github.com/acme/bare')
    ? { setupEnabled: false, repos: ['acme/bare'], warnings: [], readWarnings: [] }
    : repos.includes('https://github.com/acme/unread')
      ? { setupEnabled: null, repos: [], warnings: [], readWarnings: ["couldn't read acme/unread's .termag/environment.json (GitHub answered 500 for its default branch), so it was left out"] }
      : { setupEnabled: null, repos: [], warnings: [], readWarnings: [] })));
const repoSizesFor = vi.hoisted(() => vi.fn(async (_user: string, repos: string[]) =>
  (repos.includes('https://github.com/acme/unread')
    ? { sizes: null, warnings: ["couldn't read acme/unread's .termag/environment.json (GitHub answered 500 for its default branch), so it was left out"] }
    : { sizes: null, warnings: [] })));
vi.mock('../services/repoEnvironment', () => ({ repoSizesFor, repoSetupFor }));

const { createBox } = await import('./instances');
const user = { id: 'u1', unixUsername: 'alice', googleEmail: 'alice@example.com', displayName: 'Alice' } as unknown as Express.User;

beforeEach(() => {
  flag.setupOff = true;
  flag.dotfiles = false;
  existingBox.row = null;
  retired.length = 0;
  created.length = 0;
  vi.clearAllMocks();
  claimWarmBox.mockResolvedValue({ claimed: false, reason: 'no-warm-box', candidatesTried: 0 });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('setupEnabled as asked', () => {
  it('launches a box with setup off cold, never from the warm pool, and says nothing of a repo', async () => {
    const result = await createBox(user, { name: 'dev1', kind: 'ec2', setupEnabled: false });
    expect(result.status).toBe(201);
    expect(created[0]).toMatchObject({ setupEnabled: false });
    expect(claimWarmBox).not.toHaveBeenCalled();
    expect(result.body).not.toHaveProperty('repoSetup');
  });

  it('is on by default, and may come from the warm pool', async () => {
    await createBox(user, { name: 'dev1', kind: 'ec2' });
    expect(created[0]).toMatchObject({ setupEnabled: true });
    expect(claimWarmBox).toHaveBeenCalled();
  });

  it('refuses setup off while empty-box-enabled is off, and a setupEnabled that isn\'t a boolean', async () => {
    flag.setupOff = false;
    expect((await createBox(user, { name: 'dev1', kind: 'ec2', setupEnabled: false })).status).toBe(403);
    flag.setupOff = true;
    expect((await createBox(user, { name: 'dev1', kind: 'ec2', setupEnabled: 'false' })).status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it('says the repo turned setup off on a box claimed from the warm pool with it on, too (Bugbot, #983)', async () => {
    claimWarmBox.mockResolvedValue({ claimed: true, instance: { id: 'pool1', name: 'dev1', kind: 'ec2', status: 'ready', setupEnabled: true } });
    const result = await createBox(user, { name: 'dev1', kind: 'ec2', repo: BARE, setupEnabled: true, useRepoSetup: true });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ claimed: true, repoSetup: { setupEnabled: false, repos: ['acme/bare'], applied: false } });
  });

  it('wins over the repo\'s setting, and the 201 says the repo turned it off', async () => {
    const result = await createBox(user, { name: 'dev1', kind: 'ec2', repo: BARE, setupEnabled: true, useRepoSetup: true });
    expect(created[0]).toMatchObject({ setupEnabled: true });
    expect(result.body).toMatchObject({ repoSetup: { setupEnabled: false, repos: ['acme/bare'], applied: false } });
  });
});

describe('a Retry of a failed box with setup off (relaunchSetupOff)', () => {
  it('relaunches it with setup off while empty-box-enabled is off: the flag gates new boxes, not this one (Bugbot, #983)', async () => {
    flag.setupOff = false;
    const result = await createBox(user, { name: 'dev1', kind: 'ec2', setupEnabled: false }, { relaunchSize: null, relaunchSetupOff: true });
    expect(result.status).toBe(201);
    expect(created[0]).toMatchObject({ setupEnabled: false });
    expect(claimWarmBox).not.toHaveBeenCalled();
  });

  it('still refuses setup off for a new box with the flag off', async () => {
    flag.setupOff = false;
    expect((await createBox(user, { name: 'dev1', kind: 'ec2', setupEnabled: false }, { relaunchSize: null, relaunchSetupOff: false })).status).toBe(403);
    expect((await createBox(user, { name: 'dev1', kind: 'ec2', setupEnabled: false })).status).toBe(403);
  });
});

describe('the repo\'s setupEnabled', () => {
  it('turns setup off when the caller states it, and the 201 says where it came from', async () => {
    const result = await createBox(user, { name: 'dev1', kind: 'ec2', repo: BARE, useRepoSetup: true });
    expect(created[0]).toMatchObject({ setupEnabled: false });
    expect(claimWarmBox).not.toHaveBeenCalled();
    expect(result.body).toMatchObject({ repoSetup: { setupEnabled: false, repos: ['acme/bare'], applied: true } });
  });

  it('is never applied silently: a box made without useRepoSetup (the UI) has setup on, and the file is not read for it', async () => {
    const result = await createBox(user, { name: 'dev1', kind: 'ec2', repo: BARE });
    expect(created[0]).toMatchObject({ setupEnabled: true });
    expect(repoSetupFor).not.toHaveBeenCalled();
    expect(result.body).not.toHaveProperty('repoSetup');
  });

  it('is not read while empty-box-enabled is off: setup is on, as before the flag', async () => {
    flag.setupOff = false;
    const result = await createBox(user, { name: 'dev1', kind: 'ec2', repo: BARE, useRepoSetup: true });
    expect(result.status).toBe(201);
    expect(created[0]).toMatchObject({ setupEnabled: true });
    expect(repoSetupFor).not.toHaveBeenCalled();
  });
});

describe('a repository file that could not be read (Bugbot, #983)', () => {
  it('says so when the size was not read for it, as with --disk while box sizes are off', async () => {
    const result = await createBox(user, { name: 'dev1', kind: 'ec2', repo: UNREAD, diskGiB: 100, useRepoSetup: true });
    expect(result.status).toBe(201);
    expect(repoSizesFor).not.toHaveBeenCalled();
    expect(created[0]).toMatchObject({ setupEnabled: true });
    expect(result.body).toMatchObject({ warnings: [UNREAD_WARNING] });
  });

  it('says so once when the size was read for it too', async () => {
    const result = await createBox(user, { name: 'dev1', kind: 'ec2', repo: UNREAD, useRepoSetup: true });
    expect(repoSizesFor).toHaveBeenCalled();
    expect(result.body).toMatchObject({ warnings: [UNREAD_WARNING] });
  });
});

describe('New project\'s Try again of a failed box with setup off (POST /api/instances, no relaunch opt)', () => {
  it('relaunches it with setup off while empty-box-enabled is off, retiring the failed one (Bugbot, #983)', async () => {
    flag.setupOff = false;
    existingBox.row = { id: 'failed1', name: 'dev1', kind: 'ec2', status: 'failed', setupEnabled: false };
    const result = await createBox(user, { name: 'dev1', kind: 'ec2', setupEnabled: false });
    expect(result.status).toBe(201);
    expect(retired).toEqual(['failed1']);
    expect(created[0]).toMatchObject({ setupEnabled: false });
  });

  it('still refuses setup off with the flag off when the failed box had setup on, retiring nothing', async () => {
    flag.setupOff = false;
    existingBox.row = { id: 'failed2', name: 'dev1', kind: 'ec2', status: 'failed', setupEnabled: true };
    expect((await createBox(user, { name: 'dev1', kind: 'ec2', setupEnabled: false })).status).toBe(403);
    expect(retired).toEqual([]);
    expect(created).toHaveLength(0);
  });
});

describe('the owner\'s dotfiles on a new box (NEW_BOX_DOTFILES_FLAG)', () => {
  const withDotfiles = { ...user, dotfilesRepoUrl: 'https://github.com/alice/dotfiles' } as unknown as Express.User;

  it('are queued for a box with setup on, as before', async () => {
    flag.dotfiles = true;
    await createBox(withDotfiles, { name: 'dev1', kind: 'ec2' });
    expect(created[0]).toMatchObject({ onClaimStatus: 'pending' });
  });

  it('are not queued for a box with setup off: on-claim needs the GitHub credentials it doesn\'t get (Bugbot, #983)', async () => {
    flag.dotfiles = true;
    await createBox(withDotfiles, { name: 'dev1', kind: 'ec2', setupEnabled: false });
    expect(created[0]).toMatchObject({ setupEnabled: false });
    expect(created[0]).not.toHaveProperty('onClaimStatus');
  });
});
