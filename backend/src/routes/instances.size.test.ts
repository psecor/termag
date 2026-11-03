import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlagContext } from '../services/featureFlags';

/**
 * A new box's size (services/boxSize.ts) through POST /api/instances: the one
 * asked for, the repo's .termag/environment.json, or the owner's box-default-size; the cold launch
 * walks that size's types, and a warm box is claimed only of that size, when
 * the pool holds any (box-warm-pool-sizes).
 */

// box-default-size as a targeting flag source would serve it: per user key, else the
// fallthrough, which is also what the pool's fixed context gets.
// warm-pool-enabled is on for everyone, box-hibernation-enabled off,
// box-warm-pool-size at its fallback and box-warm-pool-sizes as `poolSizes`
// (null: unset, the single-size pool of the fallthrough's size).
const flag = vi.hoisted(() => ({ fallthrough: '', userTargets: {} as Record<string, string>, poolSizes: null as unknown }));

vi.mock('../services/featureFlags', () => {
  const size = (ctx: FlagContext, fallback: string) => {
    const key = ctx.kind === 'user' ? ctx.key : undefined;
    return key !== undefined && key in flag.userTargets ? flag.userTargets[key] : flag.fallthrough || fallback;
  };
  return {
    boolVariation: vi.fn(async (key: string, _user: unknown, fallback: boolean) => (key === 'warm-pool-enabled' ? true : fallback)),
    boolVariationForContext: vi.fn(async (_key: string, _ctx: unknown, fallback: boolean) => fallback),
    stringVariation: vi.fn(async (key: string, user: { id: string }, fallback: string) =>
      key === 'box-default-size' ? size({ kind: 'user', key: user.id }, fallback) : fallback),
    stringVariationForContext: vi.fn(async (key: string, ctx: FlagContext, fallback: string) =>
      key === 'box-default-size' ? size(ctx, fallback) : fallback),
    numberVariationForContext: vi.fn(async (_key: string, _ctx: unknown, fallback: number) => fallback),
    jsonVariationForContext: vi.fn(async (key: string, _ctx: unknown, fallback: unknown) =>
      key === 'box-warm-pool-sizes' ? flag.poolSizes : fallback),
  };
});

const claimed = { id: 'pool1', userId: 'u1', name: 'dev1', kind: 'ec2', status: 'ready', size: 'small' };
const claimWarmBox = vi.hoisted(() => vi.fn());
const provisionBox = vi.hoisted(() => vi.fn(async () => {}));
const created = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const findFirst = vi.hoisted(() => vi.fn(async () => null));

vi.mock('../db', () => ({
  prisma: {
    instance: { findFirst, count: vi.fn(async () => 2) },
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
const provisioned = vi.hoisted(() => ({ configured: true }));
vi.mock('../services/boxProvisioner', () => ({ provisionBox, terminateBox: vi.fn(), isBoxProvisioningConfigured: () => provisioned.configured }));
vi.mock('../services/warmPool', () => ({ poolSpecHashOrNull: vi.fn(async () => 'spec1'), reconcileWarmPool: vi.fn(async () => {}) }));
vi.mock('../services/agentRegistry', () => ({ sendToInstanceAgent: vi.fn() }));
vi.mock('../services/warmPoolClaim', () => ({
  claimWarmBox, isNameConflict: () => false, prismaClaimEffects: {}, WARM_POOL_ENABLED_FLAG: 'warm-pool-enabled',
}));
const boxCreationRefusal = vi.hoisted(() => vi.fn(() => null));
vi.mock('../services/boxCreationGate', () => ({
  readBoxCreationFacts: vi.fn(async () => ({})),
  boxCreationRefusal,
}));

// Each repository's .termag/environment.json as services/repoEnvironment.ts would read it.
const repoFiles = vi.hoisted(() => ({
  read: [] as string[],
  byRepo: {} as Record<string, { sizes: { size: unknown } | null; warnings: string[] }>,
}));
// What a box made for several repositories gets is keyed by them joined with "+" (repoEnvironment's largest is its own test).
vi.mock('../services/repoEnvironment', () => ({
  repoSizesFor: vi.fn(async (_userId: string, repos: string[]) => {
    if (!repos.length) return { sizes: null, warnings: [] };
    repoFiles.read.push(...repos);
    return repoFiles.byRepo[repos.join('+')] ?? { sizes: null, warnings: [] };
  }),
}));

// EC2's matching for a repo's requirements (services/boxRequirements.ts), keyed by `<vcpu>/<memoryGiB>`.
const resolutions = vi.hoisted(() => ({ byKey: {} as Record<string, unknown> }));
vi.mock('../services/boxRequirements', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/boxRequirements')>();
  return {
    ...real,
    requirementsResolver: {
      resolve: vi.fn(async (r: { vcpu: number; memoryGiB: number }) => resolutions.byKey[`${r.vcpu}/${r.memoryGiB}`]
        ?? { ok: false, warning: `${r.vcpu} vCPU, ${r.memoryGiB} GB: no m8g/r8g/m7g/r7g type has that` }),
    },
  };
});

const { createBox } = await import('./instances');
const { poolSpecHashOrNull } = await import('../services/warmPool');

const user = { id: 'u1', unixUsername: 'alice', googleEmail: 'alice@example.com', displayName: 'Alice' } as unknown as Express.User;
const WEBAPP = 'https://github.com/example-org/webapp';
const TINY = 'https://github.com/acme/tiny';
const BROKEN = 'https://github.com/acme/broken';
const BIG_MEMORY = 'https://github.com/acme/big-memory';
const MEDIUM_SHAPE = 'https://github.com/acme/medium-shape';
const R8G = { ok: true, choice: { type: 'r8g.xlarge', fallbacks: ['r7g.xlarge', 'm8g.2xlarge'] }, preset: null };

beforeEach(() => {
  flag.fallthrough = '';
  flag.userTargets = {};
  flag.poolSizes = null;
  provisioned.configured = true;
  created.length = 0;
  repoFiles.read = [];
  repoFiles.byRepo = {
    [WEBAPP]: { sizes: { size: 'medium' }, warnings: [] },
    [TINY]: { sizes: { size: 'small' }, warnings: [] },
    [BROKEN]: { sizes: { size: null }, warnings: ['acme/broken\'s .termag/environment.json: "resources" is "huge", not one of small, medium, large, so it was ignored'] },
    [BIG_MEMORY]: { sizes: { size: { vcpu: 4, memoryGiB: 32 } }, warnings: [] },
    [`${TINY}+${BIG_MEMORY}`]: { sizes: { size: { vcpu: 4, memoryGiB: 32 } }, warnings: [] },
    [MEDIUM_SHAPE]: { sizes: { size: { vcpu: 4, memoryGiB: 16 } }, warnings: [] },
  };
  resolutions.byKey = { '4/32': R8G, '4/16': { ok: true, choice: { type: 'm8g.xlarge', fallbacks: ['m7g.xlarge'] }, preset: 'medium' } };
  vi.clearAllMocks();
  claimWarmBox.mockResolvedValue({ claimed: false, reason: 'no-warm-box', candidatesTried: 0 });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const launchedTypes = () => (provisionBox.mock.calls[0] as unknown as [{ instanceTypes?: { type: string; fallbacks: string[] } }])[0].instanceTypes;

describe('a new box with box-default-size off', () => {
  it('launches as before: no size on the row and the configured type', async () => {
    const result = await createBox(user, { name: 'dev1', kind: 'ec2' });
    expect(result.status).toBe(201);
    expect(created[0]).toMatchObject({ size: null });
    expect(launchedTypes()).toBeUndefined();
  });

  it('reads the repo file only for its disk: the size stays none', async () => {
    await createBox(user, { name: 'dev1', kind: 'ec2', repo: WEBAPP });
    expect(created[0]).toMatchObject({ size: null });
    expect(launchedTypes()).toBeUndefined();
    expect(repoFiles.read).toEqual([WEBAPP]);
  });

  it('does not read the repo file with a disk asked for', async () => {
    await createBox(user, { name: 'dev1', kind: 'ec2', repo: WEBAPP, diskGiB: 120 });
    expect(repoFiles.read).toEqual([]);
  });

  it('refuses a size asked for, before anything is written', async () => {
    const result = await createBox(user, { name: 'dev1', kind: 'ec2', size: 'small' });
    expect(result).toEqual({ status: 403, body: { error: expect.any(String), code: 'box_size_disabled' } });
    expect(findFirst).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });
});

describe('a new box with box-default-size on', () => {
  beforeEach(() => { flag.fallthrough = 'small'; });

  it('launches at the flag\'s size, recording it on the row, with that size\'s fallbacks', async () => {
    await createBox(user, { name: 'dev1', kind: 'ec2' });
    expect(created[0]).toMatchObject({ size: 'small' });
    expect(launchedTypes()).toEqual({ type: 'm8g.large', fallbacks: ['m7g.large', 'r8g.large', 'r7g.large', 'm8g.xlarge'] });
  });

  it('reads the flag for the owner', async () => {
    flag.userTargets = { u1: 'large' };
    await createBox(user, { name: 'dev1', kind: 'ec2' });
    expect(created[0]).toMatchObject({ size: 'large' });
    expect(launchedTypes()?.type).toBe('m8g.2xlarge');
  });

  it('takes the repo file\'s size: a webapp project\'s box is medium', async () => {
    await createBox(user, { name: 'dev1', kind: 'ec2', repo: WEBAPP });
    expect(created[0]).toMatchObject({ size: 'medium' });
    expect(launchedTypes()?.type).toBe('m8g.xlarge');
  });

  it('takes the repo file\'s size when it is smaller than the default too', async () => {
    flag.fallthrough = 'large';
    await createBox(user, { name: 'dev1', kind: 'ec2', repo: TINY });
    expect(created[0]).toMatchObject({ size: 'small' });
  });

  it('lets an explicit size win over the repo\'s, without reading the file when the disk is asked for too', async () => {
    await createBox(user, { name: 'dev1', kind: 'ec2', size: 'small', repo: WEBAPP });
    expect(created[0]).toMatchObject({ size: 'small' });
    await createBox(user, { name: 'dev2', kind: 'ec2', size: 'small', diskGiB: 120, repo: WEBAPP });
    expect(created[1]).toMatchObject({ size: 'small' });
    expect(repoFiles.read).toEqual([WEBAPP]);
  });

  it('launches a repo with no file at the default', async () => {
    await createBox(user, { name: 'dev1', kind: 'ec2', repo: 'https://github.com/acme/plain' });
    expect(created[0]).toMatchObject({ size: 'small' });
  });

  it('ignores a malformed value with a warning in the 201, never an error', async () => {
    flag.fallthrough = 'medium';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await createBox(user, { name: 'dev1', kind: 'ec2', repo: BROKEN });
    expect(result.status).toBe(201);
    expect(created[0]).toMatchObject({ size: 'medium' });
    expect(result.body).toMatchObject({ warnings: [expect.stringContaining('"resources" is "huge"')] });
  });

  it('leaves warnings out of a 201 that has none', async () => {
    const result = await createBox(user, { name: 'dev1', kind: 'ec2', repo: WEBAPP });
    expect(result.body).not.toHaveProperty('warnings');
  });

  it('refuses a size it does not know with a 400, before anything is written', async () => {
    const result = await createBox(user, { name: 'dev1', kind: 'ec2', size: 'huge' });
    expect(result).toEqual({ status: 400, body: { error: 'size must be one of small, medium, large', code: 'invalid_size' } });
    expect(created).toEqual([]);
    expect(boxCreationRefusal).not.toHaveBeenCalled();
  });

  it('refuses a repo that is not a string', async () => {
    expect(await createBox(user, { name: 'dev1', kind: 'ec2', repo: 7 })).toMatchObject({ status: 400 });
  });

  it('keeps a relaunched box\'s size whatever the flag says now', async () => {
    flag.fallthrough = '';
    await createBox(user, { name: 'dev1', kind: 'ec2' }, { relaunchSize: 'medium' });
    expect(created[0]).toMatchObject({ size: 'medium' });
  });
});

describe('a box made for an ask (createdFor ask), sized like any other', () => {
  beforeEach(() => { flag.fallthrough = 'large'; });

  it('takes the owner\'s default with no repo file: no small-for-asks', async () => {
    await createBox(user, { name: 'ask1', kind: 'ec2' }, { createdFor: 'ask' });
    expect(created[0]).toMatchObject({ size: 'large' });
    expect(launchedTypes()?.type).toBe('m8g.2xlarge');
  });

  it('takes the repo file\'s size, and an explicit size still wins', async () => {
    await createBox(user, { name: 'ask2', kind: 'ec2', repo: TINY }, { createdFor: 'ask' });
    await createBox(user, { name: 'ask3', kind: 'ec2', size: 'medium', repo: TINY }, { createdFor: 'ask' });
    expect(created.map(c => c.size)).toEqual(['small', 'medium']);
  });
});

describe('a box made for a multi-repo project', () => {
  beforeEach(() => { flag.fallthrough = 'small'; vi.spyOn(console, 'warn').mockImplementation(() => {}); });

  it('reads every repository\'s file and takes the largest, resolved as usual', async () => {
    await createBox(user, { name: 'mr', kind: 'ec2', repo: [TINY, BIG_MEMORY] });
    expect(repoFiles.read).toEqual([TINY, BIG_MEMORY]);
    expect(created[0]).toMatchObject({ size: '4vcpu-32gib' });
    expect(launchedTypes()?.type).toBe('r8g.xlarge');
  });

  it('lets an explicit size win, without reading the files when the disk is asked for too', async () => {
    await createBox(user, { name: 'mr', kind: 'ec2', size: 'large', diskGiB: 120, repo: [TINY, BIG_MEMORY] });
    expect(repoFiles.read).toEqual([]);
    expect(created[0]).toMatchObject({ size: 'large' });
  });

  it('refuses a repo list that is not all strings', async () => {
    expect(await createBox(user, { name: 'mr', kind: 'ec2', repo: [TINY, 7] })).toMatchObject({ status: 400 });
  });
});

describe('the warm pool holds each size apart', () => {
  // Set, so every size is pooled: small 4, medium 2, large 2 (the code default per size).
  beforeEach(() => { flag.poolSizes = {}; });

  it('claims at the owner\'s size, asking only for a box of that size', async () => {
    flag.fallthrough = 'small';
    claimWarmBox.mockResolvedValue({ claimed: true, instance: claimed, candidatesTried: 1 });
    const result = await createBox(user, { name: 'dev1', kind: 'ec2' });
    expect(result).toEqual({ status: 201, body: { instance: claimed, claimed: true } });
    expect(claimWarmBox).toHaveBeenCalledWith(expect.objectContaining({ currentHash: 'spec1', size: 'small' }), {});
    expect(poolSpecHashOrNull).toHaveBeenCalledWith('small');
    expect(provisionBox).not.toHaveBeenCalled();
  });

  it('claims with no size when the flag is off for both, as before', async () => {
    await createBox(user, { name: 'dev1', kind: 'ec2' });
    expect(claimWarmBox).toHaveBeenCalledWith(expect.objectContaining({ size: null }), {});
  });

  it.each([
    { what: 'an explicit size', input: { size: 'large' }, size: 'large' },
    { what: 'the repo file\'s size', input: { repo: WEBAPP }, size: 'medium' },
    { what: 'an owner\'s own default', input: {}, size: 'large', userTarget: 'large' },
  ])('claims $what from that size\'s pool, not the fallthrough\'s', async ({ input, size, userTarget }) => {
    flag.fallthrough = 'small';
    if (userTarget) flag.userTargets = { u1: userTarget };
    await createBox(user, { name: 'dev1', kind: 'ec2', ...input });
    expect(claimWarmBox).toHaveBeenCalledWith(expect.objectContaining({ size }), {});
  });

  it('launches cold, without asking, for a size the pool holds none of', async () => {
    flag.fallthrough = 'small';
    flag.poolSizes = { small: 3, medium: 2, large: 0 };
    await createBox(user, { name: 'dev1', kind: 'ec2', size: 'large' });
    expect(poolSpecHashOrNull).not.toHaveBeenCalled();
    expect(claimWarmBox).not.toHaveBeenCalled();
    expect(created[0]).toMatchObject({ size: 'large' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[POOL] claim miss size=large via=add-box user=alice reason=size-not-pooled'));
  });

  it('with box-warm-pool-sizes unset, claims only at the single-size pool\'s size and launches others cold', async () => {
    flag.poolSizes = null;
    flag.fallthrough = 'small';
    await createBox(user, { name: 'dev1', kind: 'ec2', size: 'large' });
    expect(claimWarmBox).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[POOL] claim miss size=large via=add-box user=alice reason=size-not-pooled'));
    await createBox(user, { name: 'dev2', kind: 'ec2' });
    expect(claimWarmBox).toHaveBeenCalledWith(expect.objectContaining({ size: 'small' }), {});
  });

  it('falls back to a cold launch at the size when no box of it is warm', async () => {
    flag.fallthrough = 'medium';
    vi.mocked(poolSpecHashOrNull).mockResolvedValueOnce(null);
    const result = await createBox(user, { name: 'dev1', kind: 'ec2' });
    expect(result.status).toBe(201);
    expect(claimWarmBox).not.toHaveBeenCalled();
    expect(created[0]).toMatchObject({ size: 'medium' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[POOL] claim miss size=medium via=add-box user=alice reason=no-warm-box'));
  });

  it('falls back to a cold launch when every candidate fails, and logs the miss by size', async () => {
    flag.fallthrough = 'small';
    claimWarmBox.mockResolvedValue({ claimed: false, reason: 'every-candidate-failed', candidatesTried: 3 });
    await createBox(user, { name: 'dev1', kind: 'ec2' });
    expect(created[0]).toMatchObject({ size: 'small' });
    expect(provisionBox).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[POOL] claim miss size=small via=add-box user=alice reason=every-candidate-failed'));
  });

  it('logs a hit by size', async () => {
    flag.fallthrough = 'small';
    claimWarmBox.mockResolvedValue({ claimed: true, instance: claimed, candidatesTried: 1 });
    await createBox(user, { name: 'dev1', kind: 'ec2' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[POOL] claim hit size=small via=add-box user=alice'));
  });
});

describe('a repo file asking for requirements ({ vcpu, memoryGiB })', () => {
  beforeEach(() => { flag.fallthrough = 'small'; vi.spyOn(console, 'warn').mockImplementation(() => {}); });

  it('launches EC2\'s match, r8g.xlarge first, records 4vcpu-32gib, and skips the warm pool', async () => {
    const result = await createBox(user, { name: 'g1', kind: 'ec2', repo: BIG_MEMORY });
    expect(result.status).toBe(201);
    expect(created[0]).toMatchObject({ size: '4vcpu-32gib' });
    expect(launchedTypes()).toEqual({ type: 'r8g.xlarge', fallbacks: ['r7g.xlarge', 'm8g.2xlarge'] });
    expect(claimWarmBox).not.toHaveBeenCalled();
  });

  it('is the preset its match starts with, which the pool can hold: 4 vCPU / 16 GB is medium', async () => {
    flag.fallthrough = 'medium';
    await createBox(user, { name: 'g2', kind: 'ec2', repo: MEDIUM_SHAPE });
    expect(claimWarmBox).toHaveBeenCalledWith(expect.objectContaining({ size: 'medium' }), {});
    expect(created[0]).toMatchObject({ size: 'medium' });
    expect(launchedTypes()?.type).toBe('m8g.xlarge');
  });

  it('falls back to the default with a warning when EC2 has no match, never failing the create', async () => {
    resolutions.byKey = {};
    const result = await createBox(user, { name: 'g3', kind: 'ec2', repo: BIG_MEMORY });
    expect(result.status).toBe(201);
    expect(created[0]).toMatchObject({ size: 'small' });
    expect(result.body).toMatchObject({ warnings: [expect.stringContaining('no m8g/r8g/m7g/r7g type has that; launching small instead')] });
  });

  it('lets an explicit size win', async () => {
    await createBox(user, { name: 'g4', kind: 'ec2', size: 'large', repo: BIG_MEMORY });
    expect(created[0]).toMatchObject({ size: 'large' });
  });

  it('keeps a relaunched requirements box at its requirements', async () => {
    await createBox(user, { name: 'g5', kind: 'ec2' }, { relaunchSize: '4vcpu-32gib' });
    expect(created[0]).toMatchObject({ size: '4vcpu-32gib' });
    expect(launchedTypes()?.type).toBe('r8g.xlarge');
  });
});

describe('boxes without a size', () => {
  it('an external box has none, and refuses one', async () => {
    flag.fallthrough = 'small';
    await createBox(user, { name: 'laptop', kind: 'external' });
    expect(created[0]).toMatchObject({ size: null });
    expect(await createBox(user, { name: 'laptop2', kind: 'external', size: 'small' })).toMatchObject({ status: 400, body: { code: 'invalid_size' } });
  });
});

describe('a new box\'s disk (services/boxDiskSize.ts): asked for, else the repo file\'s, else 120', () => {
  const DISKY = 'https://github.com/acme/disky';
  const launchedDisk = () => (provisionBox.mock.calls[0] as unknown as [{ diskGiB?: number }])[0].diskGiB;
  beforeEach(() => {
    repoFiles.byRepo[DISKY] = { sizes: { size: 'medium', diskGiB: 250 }, warnings: [] };
    repoFiles.byRepo[`${TINY}+${DISKY}`] = { sizes: { size: 'medium', diskGiB: 250 }, warnings: [] };
  });

  it('records 120 and launches with it when nothing asks for another', async () => {
    await createBox(user, { name: 'dev1', kind: 'ec2' });
    expect(created[0]).toMatchObject({ diskGiB: 120 });
    expect(launchedDisk()).toBe(120);
  });

  it('records and launches the size asked for, with box-default-size off as well as on', async () => {
    await createBox(user, { name: 'dev1', kind: 'ec2', diskGiB: 200 });
    flag.fallthrough = 'small';
    await createBox(user, { name: 'dev2', kind: 'ec2', diskGiB: 300, size: 'large' });
    expect(created.map(c => [c.size, c.diskGiB])).toEqual([[null, 200], ['large', 300]]);
    expect((provisionBox.mock.calls as unknown as Array<[{ diskGiB: number }]>).map(c => c[0].diskGiB)).toEqual([200, 300]);
  });

  it('takes the repo file\'s diskGiB, and the largest of a multi-repo project\'s', async () => {
    await createBox(user, { name: 'dev1', kind: 'ec2', repo: DISKY });
    await createBox(user, { name: 'dev2', kind: 'ec2', repo: [TINY, DISKY] });
    expect(created.map(c => c.diskGiB)).toEqual([250, 250]);
  });

  it('lets a disk asked for win over the repo file\'s', async () => {
    await createBox(user, { name: 'dev1', kind: 'ec2', repo: DISKY, diskGiB: 80 });
    expect(created[0]).toMatchObject({ diskGiB: 80 });
  });

  it.each([49, 301, 120.5, '200'])('refuses %s with a 400 naming the range, before anything is written', async diskGiB => {
    const result = await createBox(user, { name: 'dev1', kind: 'ec2', diskGiB });
    expect(result).toEqual({ status: 400, body: { error: 'diskGiB must be a whole number of GB from 50 to 300', code: 'invalid_disk' } });
    expect(findFirst).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it('refuses one for a box this orchestrator does not launch', async () => {
    expect(await createBox(user, { name: 'laptop', kind: 'external', diskGiB: 200 })).toMatchObject({ status: 400, body: { code: 'invalid_disk' } });
    await createBox(user, { name: 'laptop', kind: 'external' });
    expect(created[0]).toMatchObject({ diskGiB: null });
  });

  it('keeps a relaunched box\'s disk', async () => {
    await createBox(user, { name: 'dev1', kind: 'ec2' }, { relaunchSize: null, relaunchDiskGiB: 250 });
    expect(created[0]).toMatchObject({ diskGiB: 250 });
    expect(launchedDisk()).toBe(250);
  });

  describe('the warm pool, whose boxes all have the default disk', () => {
    beforeEach(() => { flag.poolSizes = {}; flag.fallthrough = 'small'; });

    it('claims for the default disk, asked for or not', async () => {
      await createBox(user, { name: 'dev1', kind: 'ec2' });
      await createBox(user, { name: 'dev2', kind: 'ec2', diskGiB: 120 });
      expect(claimWarmBox).toHaveBeenCalledTimes(2);
    });

    it('launches cold for any other disk, without asking the pool, and logs the miss', async () => {
      await createBox(user, { name: 'dev1', kind: 'ec2', diskGiB: 200 });
      await createBox(user, { name: 'dev2', kind: 'ec2', repo: DISKY });
      expect(claimWarmBox).not.toHaveBeenCalled();
      expect(poolSpecHashOrNull).not.toHaveBeenCalled();
      expect(created.map(c => c.diskGiB)).toEqual([200, 250]);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[POOL] claim miss size=small via=add-box user=alice reason=disk-not-pooled'));
    });
  });
});
