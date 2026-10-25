import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  shares: [] as any[],
  events: [] as any[],
  viewers: [] as any[],
  failCreateOnce: false,
  findManyCalls: [] as any[],
  locks: [] as string[],
}));

vi.mock('../db', () => {
  const matches = (row: any, where: any) => Object.entries(where).every(([k, v]) => row[k] === v);
  const previewShare = {
    findUnique: vi.fn(async ({ where }: any) => db.shares.find(s => matches(s, where)) ?? null),
    findMany: vi.fn(async (args: any) => {
      db.findManyCalls.push(args);
      if (args.where?.audience === 'link' && args.take) {
        const live = db.shares.filter(s => s.audience === 'link' && !s.endedAt && !s.revokedAt).sort((a, b) => (a.id < b.id ? -1 : 1));
        const from = args.cursor ? live.findIndex(s => s.id === args.cursor.id) + (args.skip ?? 0) : 0;
        return live.slice(from, from + args.take).map(s => ({ ...s, owner: { id: s.ownerId, displayName: 'O', slackUserId: null, googleEmail: 'o@x' }, project: { userId: s.ownerId, instanceId: null } }));
      }
      return [];
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const hit = db.shares.filter(s => matches(s, where));
      for (const s of hit) Object.assign(s, data);
      return { count: hit.length };
    }),
    update: vi.fn(async ({ where, data }: any) => { const s = db.shares.find(x => x.id === where.id); Object.assign(s, data); return s; }),
    create: vi.fn(async ({ data }: any) => {
      if (db.failCreateOnce) {
        db.failCreateOnce = false;
        // Someone else's share took the key between our read and our write.
        db.shares.push({ ...data, id: 'cother000000001', createdAt: new Date(), revokedAt: null, endedAt: null, endedReason: null, lastOpenedAt: null, granteeId: null, prCommentId: null, linkTokenHash: 'h-other' });
        const { Prisma } = await import('@prisma/client');
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
      }
      const s = { ...data, id: `cnew${String(db.shares.length).padStart(11, '0')}`, createdAt: new Date(), revokedAt: null, endedAt: null, endedReason: null, lastOpenedAt: null, granteeId: null, prCommentId: null, linkTokenHash: null };
      db.shares.push(s);
      return s;
    }),
  };
  const previewShareEvent = {
    create: vi.fn(async ({ data }: any) => { const e = { id: `ev${db.events.length}`, at: new Date(), ...data }; db.events.push(e); return e; }),
    findFirst: vi.fn(async ({ where }: any) => db.events.filter(e => e.shareId === where.shareId && e.kind === where.kind && e.reason === where.reason).pop() ?? null),
    findMany: vi.fn(async ({ where }: any) => db.events.filter(e => e.kind === where.kind && e.at > where.at.gt
      && db.shares.some(sh => sh.id === e.shareId && sh.ownerId === where.share.ownerId))),
    delete: vi.fn(async ({ where }: any) => { db.events = db.events.filter(e => e.id !== where.id); return {}; }),
  };
  const previewShareViewer = {
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const k = where.shareId_userId;
      let v = db.viewers.find(x => x.shareId === k.shareId && x.userId === k.userId);
      if (v) Object.assign(v, update); else { v = { ...create, revokedAt: null }; db.viewers.push(v); }
      return v;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const hit = db.viewers.filter(v => v.shareId === where.shareId && v.userId === where.userId && (where.revokedAt === undefined || v.revokedAt === where.revokedAt)
        && (!where.share || db.shares.some(s => s.id === v.shareId && s.projectId === where.share.projectId && s.audience === where.share.audience)));
      for (const v of hit) Object.assign(v, data);
      return { count: hit.length };
    }),
  };
  const prisma: any = { previewShare, previewShareEvent, previewShareViewer };
  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
  prisma.$executeRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => { db.locks.push(String(values[0])); return 1; });
  return { prisma };
});
vi.mock('./agentRegistry', () => ({ projectAgentCapabilities: vi.fn(() => []), sendForProject: vi.fn() }));

import { endPreviewShares, onPreviewShareEnded, prismaPreviewShareStore as store, type PreviewShareStore } from './previewShares';

const NOW = new Date('2026-10-22T12:00:00Z');
const base = {
  projectId: 'p1', workstreamId: 'ws1', ownerId: 'u-owner', recipe: { kind: 'webapp-dev-stack' as const },
  expiresAt: new Date(NOW.getTime() + 14 * 86400e3), prRepo: 'example-org/webapp', prNumber: 42, prHeadOid: 'a'.repeat(40),
  linkKey: 'ws1', hashFor: (id: string) => `hash-of-${id}`, now: NOW,
};

beforeEach(() => { db.shares = []; db.events = []; db.viewers = []; db.failCreateOnce = false; db.findManyCalls = []; db.locks = []; });

describe('opening a workstream\'s link share', () => {
  it('makes one, keyed to the workstream, with its token\'s hash from its own id', async () => {
    const r = await store.openLinkShare(base);
    expect(r.existing).toBe(false);
    expect(r.ended).toBeNull();
    const row = db.shares[0];
    expect(row).toMatchObject({ audience: 'link', activeLinkKey: 'ws1', linkTokenHash: `hash-of-${row.id}`, prRepo: 'example-org/webapp', prNumber: 42 });
    expect(db.events).toEqual([expect.objectContaining({ shareId: row.id, kind: 'created' })]);
  });

  it('the same PR again is the same share', async () => {
    const first = await store.openLinkShare(base);
    const again = await store.openLinkShare({ ...base, prRepo: 'Example-Org/Webapp' });
    expect(again).toMatchObject({ existing: true, ended: null, share: { id: first.share.id } });
    expect(db.shares).toHaveLength(1);
  });

  it('another PR ends the live one as superseded, and frees its key', async () => {
    const first = await store.openLinkShare(base);
    const second = await store.openLinkShare({ ...base, prNumber: 43 });
    expect(second.existing).toBe(false);
    expect(second.ended).toMatchObject({ id: first.share.id, endedReason: 'superseded' });
    const old = db.shares.find(s => s.id === first.share.id);
    expect(old).toMatchObject({ activeLinkKey: null, endedReason: 'superseded' });
    expect(db.shares.find(s => s.id === second.share.id).activeLinkKey).toBe('ws1');
  });

  it('one past its expiry is ended as expired first, even for the same PR', async () => {
    const first = await store.openLinkShare(base);
    db.shares[0].expiresAt = new Date(NOW.getTime() - 1);
    const again = await store.openLinkShare(base);
    expect(again.existing).toBe(false);
    expect(again.ended).toMatchObject({ id: first.share.id, endedReason: 'expired' });
  });

  it('losing a race for the key reads the winner\'s share', async () => {
    db.failCreateOnce = true;
    const r = await store.openLinkShare(base);
    // The retry finds the other share live for the same PR, and returns it.
    expect(r).toMatchObject({ existing: true, share: { id: 'cother000000001' } });
  });
});

describe('a link share\'s viewers in the store', () => {
  it('a first open makes the row; opening again never un-revokes it; revoking is scoped by project', async () => {
    const { share } = await store.openLinkShare(base);
    expect(await store.addViewer(share.id, 'u-v')).toMatchObject({ revokedAt: null });
    expect(await store.revokeViewer('other-project', share.id, 'u-v', 'u-owner')).toBe(false);
    expect(await store.revokeViewer('p1', share.id, 'u-v', 'u-owner')).toBe(true);
    expect(await store.revokeViewer('p1', share.id, 'u-v', 'u-owner')).toBe(false);
    expect((await store.addViewer(share.id, 'u-v')).revokedAt).toBeInstanceOf(Date);
  });
});

describe('claiming a link share\'s comment', () => {
  it('one poster at a time; a dead poster\'s claim can be taken over; settling only under the claim', async () => {
    const { share } = await store.openLinkShare(base);
    expect(await store.claimComment(share.id, 1000, 120e3)).toBe(true);
    expect(db.shares[0].prCommentId).toBe('pending:1000');
    expect(await store.claimComment(share.id, 2000, 120e3)).toBe(false);
    // Long enough later, the claim is stale: its poster died.
    expect(await store.claimComment(share.id, 1000 + 121e3, 120e3)).toBe(true);
    // The first poster comes back late: its settle no longer holds.
    await store.settleComment(share.id, 1000, '1111');
    expect(db.shares[0].prCommentId).toBe(`pending:${1000 + 121e3}`);
    await store.settleComment(share.id, 1000 + 121e3, '2222');
    expect(db.shares[0].prCommentId).toBe('2222');
    expect(await store.claimComment(share.id, 999999, 120e3)).toBe(false);
  });
});

describe('the sweep\'s read, and shared with me', () => {
  it('reads every live link share, a page at a time', async () => {
    for (let i = 0; i < 1203; i++) db.shares.push({ id: `c${String(i).padStart(6, '0')}`, audience: 'link', ownerId: 'u', projectId: 'p1', originRecipe: {}, endedAt: null, revokedAt: null });
    db.shares.push({ id: 'cended', audience: 'link', ownerId: 'u', projectId: 'p1', originRecipe: {}, endedAt: new Date(), revokedAt: null });
    const live = await store.liveLinkShares();
    expect(live).toHaveLength(1203);
    expect(new Set(live.map(l => l.share.id)).size).toBe(1203);
    expect(db.findManyCalls.filter(c => c.where?.audience === 'link')).toHaveLength(3);
  });

  it('lists a PR\'s link share for someone who opened it and still may, beside shares made for them', async () => {
    await store.sharedWith('u-v');
    const where = db.findManyCalls.at(-1).where;
    expect(where.OR).toEqual([{ granteeId: 'u-v', audience: 'user' }, { audience: 'link', viewers: { some: { userId: 'u-v', revokedAt: null } } }]);
    expect(where).toMatchObject({ revokedAt: null, endedAt: null });
  });
});

describe('a workstream removed or a project archived', () => {
  it('ends its link shares through the end hooks too', async () => {
    const ended: [string, string][] = [];
    const off = onPreviewShareEnded((s, reason) => { ended.push([s.id, reason]); });
    const row = { id: 'clink1', audience: 'link', prCommentId: '9001' } as any;
    const fake = { endWhere: vi.fn(async () => [row]), viewerIds: vi.fn(async () => []) } as unknown as PreviewShareStore;
    try {
      expect(await endPreviewShares({ workstreamId: 'ws1' }, 'workstream-removed', { userId: 'u', instanceId: null }, fake)).toBe(1);
      expect(await endPreviewShares({ projectId: 'p1' }, 'project-archived', { userId: 'u', instanceId: null }, fake)).toBe(1);
    } finally { off(); }
    expect(ended).toEqual([['clink1', 'workstream-removed'], ['clink1', 'project-archived']]);
  });
});

describe('which PR a superseded share moved to', () => {
  it('is read from its ended event', async () => {
    const first = await store.openLinkShare(base);
    await store.openLinkShare({ ...base, prNumber: 43 });
    expect(await store.supersededBy(first.share.id)).toBe(43);
    const other = await store.openLinkShare({ ...base, linkKey: 'ws2', workstreamId: 'ws2' });
    expect(await store.supersededBy(other.share.id)).toBeNull();
  });
});

describe('the owner\'s wake budget in the store (4b)', () => {
  it('takes a wake under the owner\'s lock, refuses the next within 30 minutes, and can give one back', async () => {
    const { share } = await store.openLinkShare(base);
    const now = NOW.getTime();
    const first = await store.claimWake({ ownerId: 'u-owner', shareId: share.id, viewerId: 'u-v', now });
    expect(first).toMatchObject({ ok: true });
    expect(db.locks).toEqual(['preview-wake:u-owner']);
    expect(db.events.filter(e => e.kind === 'woke')).toHaveLength(1);
    // The events' `at` is the claim's time.
    db.events.find(e => e.kind === 'woke').at = new Date(now);
    expect(await store.claimWake({ ownerId: 'u-owner', shareId: share.id, viewerId: 'u-w', now: now + 60e3 })).toMatchObject({ ok: false, reason: 'too-soon' });
    // Another owner's budget is their own.
    db.shares.push({ ...db.shares[0], id: 'cother', ownerId: 'u-other' });
    expect(await store.claimWake({ ownerId: 'u-other', shareId: 'cother', viewerId: 'u-v', now: now + 60e3 })).toMatchObject({ ok: true });
    await store.refundWake((first as { wakeId: string }).wakeId);
    expect(await store.claimWake({ ownerId: 'u-owner', shareId: share.id, viewerId: 'u-w', now: now + 60e3 })).toMatchObject({ ok: true });
  });
});
