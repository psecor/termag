import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  rows: new Map<string, { id: string; name: string; archived: boolean }>(),
  share: null as any,
  updates: [] as any[],
  viewers: [] as string[],
  calls: [] as unknown[][],
  same: null as any,
}));
vi.mock('../db', () => ({
  prisma: {
    $transaction: vi.fn(async (fn: any) => fn({
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => { db.calls.push(['lock', strings.join('?'), ...values]); return 1; }),
      previewShare: {
        findFirst: vi.fn(async () => { db.calls.push(['findFirst']); return db.same; }),
        findUnique: vi.fn(async () => { db.calls.push(['findUnique']); return null; }),
        create: vi.fn(async () => ({ id: 'cnew' })),
        update: vi.fn(async () => ({ ...share({ audience: 'link', granteeId: null }), id: 'cnew', prHeadBranch: null, checkoutDir: null, prRepo: 'example-org/webapp', prNumber: 42, prCommentId: null, prHeadOid: null })),
      },
      previewShareEvent: { create: vi.fn(async () => ({})) },
    })),
    workstream: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return [...db.rows.values()].find(r => r.id === where.id) ?? null;
        return db.rows.get(where.projectId_name.name) ?? null;
      }),
      findMany: vi.fn(async ({ where }: any) => [...db.rows.values()].filter(r => (where.archived !== false || !r.archived) && (where.askThread !== null || !(r as any).askThread))),
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

import { prismaPreviewShareStore, shareTarget } from './previewShares';
import { defaultPreviewShareRouteDeps } from '../routes/previewShares';

const project = { id: 'p1', name: 'proj', userId: 'u1', archived: false, instanceId: null, setupStatus: 'ready', user: { unixUsername: 'u' }, instance: null };
const share = (over: Record<string, unknown> = {}) => ({
  id: 's1', projectId: 'p1', workstreamId: null, ownerId: 'u1', audience: 'user', granteeId: 'u2', originRecipe: { kind: 'webapp-dev-stack' },
  expiresAt: new Date(Date.now() + 3600e3), revokedAt: null, endedAt: null, endedReason: null, lastOpenedAt: null, createdAt: new Date(), project, ...over,
});

beforeEach(() => { db.rows.clear(); db.updates = []; db.viewers = []; db.calls = []; db.same = null; });

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

describe('4d: a share from the PR\'s own checkout', () => {
  const ctx = (over: Record<string, unknown> = {}) => ({
    share: { ...share({ audience: 'link', granteeId: null }), prHeadBranch: 'feat/x', checkoutDir: null, ...over } as any,
    project: { id: 'p1', name: 'Webapp', userId: 'u1', archived: false, instanceId: 'box-1', setupStatus: 'ready', ownerUnixUsername: 'olive', instance: null },
    owner: {} as any,
    workstream: { name: 'main', archived: false },
  });

  it('shows its checkout in place of the workstream\'s directory (seam 1)', () => {
    expect(shareTarget(ctx())!.cwd).toBe('/home/olive/termag/projects/Webapp');
    expect(shareTarget(ctx({ checkoutDir: '/home/olive/src/webapp' }))).toMatchObject({ cwd: '/home/olive/src/webapp', workstream: 'main', host: { userId: 'u1', instanceId: 'box-1' } });
  });

  it('looks among the project\'s live workstreams: main even without a row, but not once its row is archived', async () => {
    db.rows.set('feature-x', { id: 'w-f', name: 'feature-x', archived: false });
    db.rows.set('old', { id: 'w-o', name: 'old', archived: true });
    // An ask's chat has no checkout of its own.
    db.rows.set('ask-1', { id: 'w-a', name: 'ask-1', archived: false, askThread: { id: 't1' } } as any);
    expect(await defaultPreviewShareRouteDeps.listWorkstreams('p1')).toEqual([{ id: null, name: 'main' }, expect.objectContaining({ id: 'w-f', name: 'feature-x' })]);
    db.rows.set('main', { id: 'w-main', name: 'main', archived: false });
    expect((await defaultPreviewShareRouteDeps.listWorkstreams('p1')).map(w => w.name)).toEqual(['feature-x', 'main']);
    // An archived main row is gone: no implicit main stands in for it.
    db.rows.set('main', { id: 'w-main', name: 'main', archived: true });
    expect(await defaultPreviewShareRouteDeps.listWorkstreams('p1')).toEqual([{ id: 'w-f', name: 'feature-x' }]);
  });
});

describe('4d: one live link share per PR', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    projectId: 'p1', workstreamId: null, ownerId: 'u1', recipe: { kind: 'webapp-dev-stack' } as const, expiresAt: new Date(Date.now() + 3600e3),
    prRepo: 'Example-Org/Webapp', prNumber: 42, prHeadOid: 'a'.repeat(40), linkKey: 'box:box-1:dir:0123456789abcdef', hashFor: () => 'h', now: new Date(),
    ...over,
  });

  it('holds a lock per owner and PR before it looks for the PR\'s live share, so two asks from different checkouts make one', async () => {
    db.same = { ...share({ audience: 'link', granteeId: null }), id: 'cold', prRepo: 'example-org/webapp', prNumber: 42, prCommentId: '9', prHeadOid: null, prHeadBranch: 'feat/x', checkoutDir: null };
    const got = await prismaPreviewShareStore.openLinkShare({ ...input(), samePr: true });
    expect(got).toMatchObject({ existing: true, ended: null, share: { id: 'cold' } });
    expect(db.calls[0]).toEqual(['lock', 'SELECT pg_advisory_xact_lock(hashtext(?))', 'link-share:u1:example-org/webapp#42']);
    expect(db.calls[1]).toEqual(['findFirst']);
    expect(db.calls).not.toContainEqual(['findUnique']);
  });

  it('takes no lock and looks by key only without samePr, as before', async () => {
    await prismaPreviewShareStore.openLinkShare(input());
    expect(db.calls).toEqual([['findUnique']]);
  });
});
