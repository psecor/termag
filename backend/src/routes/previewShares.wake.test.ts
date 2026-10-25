import { describe, expect, it, vi } from 'vitest';
import type { Instance, User } from '@prisma/client';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => false), numberVariationForContext: vi.fn(async () => 24) }));
vi.mock('../slack/app', () => ({ getSlackApp: () => null }));
vi.mock('../services/briefing/slack', () => ({ slackIdFor: vi.fn() }));
vi.mock('../services/boxPower', () => ({
  instanceStatus: vi.fn(async () => 'hibernated'),
  requestPower: vi.fn(),
  PowerRequestConflict: class PowerRequestConflict extends Error {},
}));
vi.mock('../services/boxProvisioner', () => ({ isBoxProvisioningConfigured: vi.fn(() => true) }));
vi.mock('../services/userByEmail', () => ({ findUserByEmail: vi.fn() }));
vi.mock('../services/credentialStore', () => ({ readGithubAccess: vi.fn(async () => null) }));
vi.mock('../services/agentRegistry', () => ({ projectAgentCapabilities: vi.fn(() => []), sendForProject: vi.fn() }));

import { PowerRequestConflict } from '../services/boxPower';
import { LINK_SHARE_DAYS } from '../services/previewShareRules';
import type { GuestShareContext, ShareRow } from '../services/previewShares';
import type { WakeDeps } from '../services/previewShareLinks';
import { shareForGrantee, wakeFor, type PreviewShareRouteDeps } from './previewShares';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const owner = { id: 'u-owner', displayName: 'Olive', googleEmail: 'olive@x.test', slackUserId: null } as User;
const viewer = { id: 'uviewer000001', displayName: 'Vic', googleEmail: 'vic@x.test' } as User;
const AUTO = 'Hibernated automatically after 2 h idle. Start it to resume where you left off.';

const box = (over: Partial<Instance> = {}) => ({
  id: 'box-1', name: 'olive-box', userId: owner.id, kind: 'ec2', ec2InstanceId: 'i-1', status: 'hibernated', lifecycleNote: AUTO,
  autoTerminatedAt: null, hibernationConfigured: true, parkedAt: new Date(NOW - 3600e3), ...over,
}) as unknown as Instance;

function share(over: Partial<ShareRow> = {}): ShareRow {
  return {
    id: 'clink00000000001', projectId: 'p1', workstreamId: 'ws1', ownerId: owner.id, audience: 'link', granteeId: null,
    originRecipe: { kind: 'webapp-dev-stack' }, expiresAt: new Date(NOW + LINK_SHARE_DAYS * 86400e3), revokedAt: null, endedAt: null, endedReason: null,
    lastOpenedAt: null, createdAt: new Date(NOW), prRepo: 'example-org/webapp', prNumber: 42, prCommentId: null, prHeadOid: null, ...over,
  };
}

function setup(opts: { share?: Partial<ShareRow>; box?: Partial<Instance> | null; viewerRow?: { revokedAt: Date | null } | null; wakeOn?: boolean; claim?: any; start?: () => Promise<void>; boxNow?: { status: string; autoTerminatedAt: Date | null } | null } = {}) {
  const s = share(opts.share);
  const instance = opts.box === null ? null : box(opts.box ?? {});
  const ctx: GuestShareContext = {
    share: s,
    project: { id: 'p1', name: 'webapp', userId: owner.id, archived: false, instanceId: 'box-1', setupStatus: 'ready', ownerUnixUsername: 'olive', instance },
    owner, workstream: { name: 'feature-x', archived: false }, viewerRow: opts.viewerRow === undefined ? { revokedAt: null } : opts.viewerRow,
  };
  const notices: string[] = [];
  const wake: WakeDeps = {
    store: {
      claimWake: vi.fn(async () => opts.claim ?? { ok: true, wakeId: 'wake-1' }),
      refundWake: vi.fn(async () => {}),
      recordEvent: vi.fn(async () => {}),
    },
    wakeOn: vi.fn(async () => opts.wakeOn ?? true),
    start: vi.fn(opts.start ?? (async () => {})),
    provisioningConfigured: () => true,
    notifyOwner: vi.fn(async (_o, text) => { notices.push(text); }),
    boxesChanged: vi.fn(),
    boxNow: vi.fn(async () => opts.boxNow ?? { status: 'starting', autoTerminatedAt: null }),
    now: () => NOW,
  };
  const deps = {
    store: { guestContext: vi.fn(async (id: string) => (id === s.id ? ctx : null)) },
    findUser: vi.fn(async (id: string) => [owner, viewer].find(u => u.id === id) ?? null),
    boxStatus: vi.fn(async () => instance?.status ?? null),
    now: () => NOW,
    wake,
  } as unknown as PreviewShareRouteDeps;
  return { deps, wake, notices, ctx };
}

const asUser = (u: User) => ({ id: u.id }) as Express.User;

describe('a reviewer waking the box', () => {
  it('wakes a box the idle sweep hibernated, as a reviewer\'s start, and tells the owner', async () => {
    const { deps, wake, notices } = setup();
    expect(await wakeFor(deps, asUser(viewer), 'clink00000000001')).toEqual({ status: 202, body: { ok: true, status: 'starting' } });
    expect(wake.store.claimWake).toHaveBeenCalledWith({ ownerId: owner.id, shareId: 'clink00000000001', viewerId: viewer.id, now: NOW });
    expect(wake.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'box-1' }));
    expect(wake.boxesChanged).toHaveBeenCalledWith(owner.id);
    expect(notices[0]).toBe('Vic woke your box olive-box to review example-org/webapp#42. It goes back to sleep on its own once nobody is using it.');
  });

  it('never wakes a box its owner stopped or hibernated, or one that is up', async () => {
    for (const [over, code] of [[{ lifecycleNote: null }, 'not-auto'], [{ status: 'stopped' }, 'not-auto'], [{ status: 'ready' }, 'awake']] as const) {
      const { deps, wake } = setup({ box: over as Partial<Instance> });
      expect(await wakeFor(deps, asUser(viewer), 'clink00000000001'), code).toMatchObject({ status: 409, body: { code } });
      expect(wake.store.claimWake).not.toHaveBeenCalled();
      expect(wake.start).not.toHaveBeenCalled();
    }
  });

  it('a box already starting is fine, and costs no wake', async () => {
    const { deps, wake } = setup({ box: { status: 'starting' } });
    expect(await wakeFor(deps, asUser(viewer), 'clink00000000001')).toMatchObject({ status: 202 });
    expect(wake.store.claimWake).not.toHaveBeenCalled();
  });

  it('a per-person share and the flag off never wake', async () => {
    expect(await wakeFor(setup({ share: { audience: 'user', granteeId: viewer.id } }).deps, asUser(viewer), 'clink00000000001')).toMatchObject({ status: 409, body: { code: 'not-wakeable' } });
    expect(await wakeFor(setup({ wakeOn: false }).deps, asUser(viewer), 'clink00000000001')).toMatchObject({ status: 409, body: { code: 'wake-off' } });
  });

  it('the owner\'s budget says when the next wake fits', async () => {
    const retryAt = NOW + 20 * 60e3;
    const { deps, wake } = setup({ claim: { ok: false, reason: 'too-soon', retryAt } });
    expect(await wakeFor(deps, asUser(viewer), 'clink00000000001')).toMatchObject({ status: 429, body: { code: 'too-soon', retryAt: new Date(retryAt).toISOString() } });
    expect(wake.start).not.toHaveBeenCalled();
  });

  it('a start that fails gives the wake back; a race with another start is fine', async () => {
    const failed = setup({ start: async () => { throw new Error('InsufficientInstanceCapacity'); } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await wakeFor(failed.deps, asUser(viewer), 'clink00000000001')).toMatchObject({ status: 502, body: { code: 'failed' } });
    warn.mockRestore();
    expect(failed.wake.store.refundWake).toHaveBeenCalledWith('wake-1');
    const raced = setup({ start: async () => { throw new PowerRequestConflict('changed'); } });
    expect(await wakeFor(raced.deps, asUser(viewer), 'clink00000000001')).toMatchObject({ status: 202 });
    expect(raced.wake.store.refundWake).toHaveBeenCalledWith('wake-1');
    expect(raced.notices).toEqual([]);
    // Lost to the terminate sweep's claim: the box stays down, and the reviewer is told so.
    const claimed = setup({ start: async () => { throw new PowerRequestConflict('changed'); }, boxNow: { status: 'hibernated', autoTerminatedAt: new Date(NOW) } });
    expect(await wakeFor(claimed.deps, asUser(viewer), 'clink00000000001')).toMatchObject({ status: 409, body: { code: 'no-box' } });
    const moved = setup({ start: async () => { throw new PowerRequestConflict('changed'); }, boxNow: { status: 'stopping', autoTerminatedAt: null } });
    expect(await wakeFor(moved.deps, asUser(viewer), 'clink00000000001')).toMatchObject({ status: 502, body: { code: 'failed' } });
    // A read that failed is worth another try, not "no box".
    const unread = setup({ start: async () => { throw new PowerRequestConflict('changed'); } });
    vi.mocked(unread.wake.boxNow).mockRejectedValueOnce(new Error('db blip'));
    expect(await wakeFor(unread.deps, asUser(viewer), 'clink00000000001')).toMatchObject({ status: 502, body: { code: 'failed' } });
    // A start that failed leaves a trace, its woke given back.
    expect(failed.wake.store.recordEvent).toHaveBeenCalledWith('clink00000000001', 'wake-failed', expect.objectContaining({ actorId: viewer.id, reason: 'InsufficientInstanceCapacity' }));
  });

  it('only someone the share lets in may wake it; its owner starts their own box', async () => {
    expect(await wakeFor(setup({ viewerRow: null }).deps, asUser(viewer), 'clink00000000001')).toMatchObject({ status: 404 });
    expect(await wakeFor(setup({ viewerRow: { revokedAt: new Date() } }).deps, asUser(viewer), 'clink00000000001')).toMatchObject({ status: 409, body: { code: 'viewer-revoked' } });
    expect(await wakeFor(setup().deps, asUser(owner), 'clink00000000001')).toMatchObject({ status: 409, body: { code: 'own-box' } });
    expect(await wakeFor(setup({ share: { endedAt: new Date(NOW), endedReason: 'merged' } }).deps, asUser(viewer), 'clink00000000001')).toMatchObject({ status: 409, body: { code: 'ended' } });
  });

  it('the guest page is told whether it may offer the wake', async () => {
    expect((await shareForGrantee(setup().deps, asUser(viewer), 'clink00000000001')).body).toMatchObject({ canWake: true, boxStatus: 'hibernated' });
    expect((await shareForGrantee(setup({ box: { lifecycleNote: null } }).deps, asUser(viewer), 'clink00000000001')).body).toMatchObject({ canWake: false });
    expect((await shareForGrantee(setup({ wakeOn: false }).deps, asUser(viewer), 'clink00000000001')).body).toMatchObject({ canWake: false });
    // Its owner previewing as a guest starts the box themselves.
    expect((await shareForGrantee(setup().deps, asUser(owner), 'clink00000000001')).body).toMatchObject({ canWake: false });
  });
});
