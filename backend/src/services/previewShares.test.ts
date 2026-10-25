import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  rows: new Map<string, { id: string; name: string; archived: boolean }>(),
  share: null as any,
  updates: [] as any[],
  viewers: [] as string[],
}));
vi.mock('../db', () => ({
  prisma: {
    workstream: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return [...db.rows.values()].find(r => r.id === where.id) ?? null;
        return db.rows.get(where.projectId_name.name) ?? null;
      }),
    },
    previewShareViewer: {
      findMany: vi.fn(async () => db.viewers.map(userId => ({ userId }))),
    },
    previewShare: {
      findUnique: vi.fn(async () => db.share),
      update: vi.fn(async (args: any) => { db.updates.push(args); return {}; }),
    },
  },
}));
vi.mock('./agentRegistry', () => ({ projectAgentCapabilities: vi.fn(() => []), sendForProject: vi.fn() }));
vi.mock('./featureFlags', () => ({ boolVariation: vi.fn(), numberVariationForContext: vi.fn() }));
vi.mock('../slack/app', () => ({ getSlackApp: () => null }));

import { prismaPreviewShareStore } from './previewShares';
import { defaultPreviewShareRouteDeps } from '../routes/previewShares';

const project = { id: 'p1', name: 'proj', userId: 'u1', archived: false, instanceId: null, setupStatus: 'ready', user: { unixUsername: 'u' }, instance: null };
const share = (over: Record<string, unknown> = {}) => ({
  id: 's1', projectId: 'p1', workstreamId: null, ownerId: 'u1', audience: 'user', granteeId: 'u2', originRecipe: { kind: 'webapp-dev-stack' },
  expiresAt: new Date(Date.now() + 3600e3), revokedAt: null, endedAt: null, endedReason: null, lastOpenedAt: null, createdAt: new Date(), project, ...over,
});

beforeEach(() => { db.rows.clear(); db.updates = []; db.viewers = []; });

describe('a share\'s viewers', () => {
  it('are its grantee, anyone who opened it, and its owner (Preview as guest has a profile too)', async () => {
    db.viewers = ['u3', 'u2'];
    expect(await prismaPreviewShareStore.viewerIds(share() as any)).toEqual(['u2', 'u3', 'u1']);
    expect(await prismaPreviewShareStore.viewerIds(share({ granteeId: null }) as any)).toEqual(['u3', 'u2', 'u1']);
  });
});

describe('a share on main', () => {
  it('is there with no rows at all, and with feature workstreams but no main row', async () => {
    db.share = share();
    expect((await prismaPreviewShareStore.guestContext('s1'))!.workstream).toEqual({ name: 'main', archived: false });
    db.rows.set('feature-x', { id: 'w-f', name: 'feature-x', archived: false });
    expect((await prismaPreviewShareStore.guestContext('s1'))!.workstream).toEqual({ name: 'main', archived: false });
  });

  it('is bound to a main row once one exists, and gone when that row is archived', async () => {
    db.rows.set('main', { id: 'w-main', name: 'main', archived: false });
    db.share = share();
    expect((await prismaPreviewShareStore.guestContext('s1'))!.workstream).toEqual({ name: 'main', archived: false });
    expect(db.updates).toEqual([{ where: { id: 's1' }, data: { workstreamId: 'w-main' } }]);
    db.rows.set('main', { id: 'w-main', name: 'main', archived: true });
    db.share = share({ workstreamId: 'w-main' });
    expect((await prismaPreviewShareStore.guestContext('s1'))!.workstream).toMatchObject({ name: 'main', archived: true });
  });

  it('can be created on a project with or without a main row, never on an archived one', async () => {
    expect(await defaultPreviewShareRouteDeps.findWorkstream('p1', 'main')).toEqual({ id: null });
    db.rows.set('feature-x', { id: 'w-f', name: 'feature-x', archived: false });
    expect(await defaultPreviewShareRouteDeps.findWorkstream('p1', 'main')).toEqual({ id: null });
    expect(await defaultPreviewShareRouteDeps.findWorkstream('p1', 'feature-x')).toEqual({ id: 'w-f' });
    expect(await defaultPreviewShareRouteDeps.findWorkstream('p1', 'nope')).toBeUndefined();
    db.rows.set('main', { id: 'w-main', name: 'main', archived: true });
    expect(await defaultPreviewShareRouteDeps.findWorkstream('p1', 'main')).toBeUndefined();
  });
});
