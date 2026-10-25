import express from 'express';
import type { AddressInfo } from 'net';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => false), numberVariationForContext: vi.fn(async () => 24) }));
vi.mock('../slack/app', () => ({ getSlackApp: () => null }));
vi.mock('../services/briefing/slack', () => ({ slackIdFor: vi.fn() }));
vi.mock('../services/boxPower', () => ({ instanceStatus: vi.fn(async () => 'ready') }));
vi.mock('../services/userByEmail', () => ({ findUserByEmail: vi.fn() }));
vi.mock('../services/agentRegistry', () => ({
  projectAgentCapabilities: vi.fn(() => ['browser-pane-v1', 'browser-pane-profiles-v1']),
  sendForProject: vi.fn(async () => ({ ok: true })),
}));

import { sendForProject } from '../services/agentRegistry';
import { registerGuestSocket, resetLiveGuests, type GuestShareContext, type PreviewShareStore, type ShareRow } from '../services/previewShares';
import {
  askWakeFor, createShareFor, extendShareFor, previewLinkRouter, revokeShareFor, shareForGrantee, type PreviewShareRouteDeps,
} from './previewShares';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const owner = { id: 'u-owner', displayName: 'Olive Owner', googleEmail: 'olive@x.test' } as User;
const guest = { id: 'u-guest', displayName: 'Gus Guest', googleEmail: 'gus@x.test' } as User;
const stranger = { id: 'u-stranger', displayName: 'Sam', googleEmail: 'sam@x.test' } as User;
const project = { id: 'p1', name: 'webapp', userId: owner.id, archived: false, instanceId: 'box-1', instance: null };

function shareRow(over: Partial<ShareRow> = {}): ShareRow {
  return {
    id: 'cshare0000000001', projectId: 'p1', workstreamId: 'ws1', ownerId: owner.id, audience: 'user', granteeId: guest.id,
    originRecipe: { kind: 'webapp-dev-stack' }, expiresAt: new Date(NOW + 3600e3), revokedAt: null, endedAt: null, endedReason: null,
    lastOpenedAt: null, createdAt: new Date(NOW), ...over,
  };
}

function context(share: ShareRow, over: Partial<GuestShareContext> = {}): GuestShareContext {
  return {
    share,
    project: { id: 'p1', name: 'webapp', userId: owner.id, archived: false, instanceId: 'box-1', setupStatus: 'ready', ownerUnixUsername: 'olive', instance: null },
    owner, workstream: { name: 'feature-x', archived: false }, ...over,
  };
}

function fakeStore(initial: ShareRow[] = []): PreviewShareStore & { rows: ShareRow[]; events: any[] } {
  const rows = [...initial];
  const events: any[] = [];
  return {
    rows, events,
    guestContext: vi.fn(async (id) => { const s = rows.find(r => r.id === id); return s ? context(s) : null; }),
    create: vi.fn(async (input) => { const s = shareRow({ id: `cnew${rows.length.toString().padStart(12, '0')}`, workstreamId: input.workstreamId, granteeId: input.granteeId, originRecipe: input.recipe, expiresAt: input.expiresAt }); rows.push(s); return s; }),
    liveFor: vi.fn(async ({ projectId, workstreamIds, granteeId, now }) => rows.find(r => r.projectId === projectId && r.granteeId === granteeId && r.audience === 'user'
      && workstreamIds.includes(r.workstreamId) && !r.revokedAt && !r.endedAt && r.expiresAt.getTime() > now.getTime()) ?? null),
    renew: vi.fn(async (projectId, id, { recipe, expiresAt }) => { const s = rows.find(r => r.id === id && r.projectId === projectId && !r.revokedAt && !r.endedAt); if (!s) return null; s.originRecipe = recipe; s.expiresAt = expiresAt; return s; }),
    listForProject: vi.fn(async () => []),
    sharedWith: vi.fn(async () => []),
    revoke: vi.fn(async (projectId, id) => { const s = rows.find(r => r.id === id && r.projectId === projectId && !r.revokedAt); if (!s) return null; s.revokedAt = new Date(NOW); s.endedAt = new Date(NOW); s.endedReason = 'revoked'; return s; }),
    extend: vi.fn(async (projectId, id, expiresAt) => { const s = rows.find(r => r.id === id && r.projectId === projectId && !r.revokedAt); if (!s) return null; s.expiresAt = expiresAt; return s; }),
    endWhere: vi.fn(async () => []),
    recordEvent: vi.fn(async (shareId, kind, opts) => { events.push({ shareId, kind, ...opts }); }),
    noteOpened: vi.fn(async () => {}),
    viewerIds: vi.fn(async (s) => [...(s.granteeId ? [s.granteeId] : []), s.ownerId]),
  };
}

function deps(over: Partial<PreviewShareRouteDeps> = {}, store = fakeStore()): PreviewShareRouteDeps & { store: ReturnType<typeof fakeStore> } {
  return {
    store,
    findOwnedProject: vi.fn(async (userId, id) => (userId === owner.id && id === 'p1' ? project : null)),
    findWorkstream: vi.fn(async (_p, name) => (name === 'feature-x' ? { id: 'ws1' } : name === 'main' ? { id: null } : undefined)),
    findUserByEmail: vi.fn(async (email) => ({ 'gus@x.test': guest, 'olive@x.test': owner } as Record<string, User>)[email] ?? null),
    findUser: vi.fn(async (id) => [owner, guest, stranger].find(u => u.id === id) ?? null),
    isCollaborator: vi.fn(async () => false),
    sharingOn: vi.fn(async () => true),
    ttlDefault: vi.fn(async () => 24),
    boxStatus: vi.fn(async () => 'ready'),
    notifyWake: vi.fn(async () => true),
    now: () => NOW,
    ...over,
  } as any;
}

const asUser = (u: User) => ({ id: u.id }) as Express.User;

beforeEach(() => { resetLiveGuests(); vi.mocked(sendForProject).mockClear(); });

describe('creating a share', () => {
  it('shares a workstream with a termag user, for the flag\'s default lifetime', async () => {
    const d = deps();
    const r = await createShareFor(d, asUser(owner), 'p1', { email: ' GUS@x.test ', workstream: 'feature-x' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ttlHours: 24, link: expect.stringMatching(/^\/p\/c/) });
    expect(d.store.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', workstreamId: 'ws1', granteeId: guest.id, recipe: { kind: 'webapp-dev-stack' }, expiresAt: new Date(NOW + 24 * 3600e3) }));
    expect(d.store.events).toEqual([expect.objectContaining({ kind: 'created', actorId: owner.id })]);
  });

  it('sharing again with the same person renews their share, same link, never ending it sooner', async () => {
    const d = deps();
    const first = await createShareFor(d, asUser(owner), 'p1', { email: 'gus@x.test', workstream: 'feature-x' });
    expect(first.status).toBe(201);
    const id = (first.body as { id: string }).id;
    // Again, for three days and another recipe: the same share, renewed.
    const again = await createShareFor(d, asUser(owner), 'p1', { email: 'gus@x.test', workstream: 'feature-x', ttlHours: 72, recipe: { kind: 'manual', origins: ['127.0.0.2:8080'] } });
    expect(again).toMatchObject({ status: 200, body: { id, link: `/p/${id}`, renewed: true, expiresAt: new Date(NOW + 72 * 3600e3).toISOString() } });
    expect(d.store.rows).toHaveLength(1);
    expect(d.store.rows[0].originRecipe).toEqual({ kind: 'manual', origins: ['127.0.0.2:8080'] });
    expect(sendForProject).toHaveBeenCalledWith(expect.anything(), 'browser-profile-expiry', expect.objectContaining({ expiresAt: new Date(NOW + 72 * 3600e3).toISOString() }), 15000);
    // The recipe changed: a reviewer looking now is told to redial; the same one again tells nobody.
    const reconnect = vi.fn();
    const unregister = registerGuestSocket(id, { close: vi.fn(), reconnect });
    await createShareFor(d, asUser(owner), 'p1', { email: 'gus@x.test', workstream: 'feature-x', ttlHours: 72, recipe: { kind: 'manual', origins: ['127.0.0.2:8080'] } });
    expect(reconnect).not.toHaveBeenCalled();
    await createShareFor(d, asUser(owner), 'p1', { email: 'gus@x.test', workstream: 'feature-x', ttlHours: 72 });
    expect(reconnect).toHaveBeenCalledTimes(1);
    unregister();
    // A shorter lifetime asked for now keeps the later end.
    const shorter = await createShareFor(d, asUser(owner), 'p1', { email: 'gus@x.test', workstream: 'feature-x', ttlHours: 1 });
    expect(shorter).toMatchObject({ status: 200, body: { id, expiresAt: new Date(NOW + 72 * 3600e3).toISOString() } });
    // Another workstream, or after a revoke: a new share.
    expect((await createShareFor(d, asUser(owner), 'p1', { email: 'gus@x.test', workstream: 'main' })).status).toBe(201);
    d.store.rows[0].revokedAt = new Date(NOW);
    expect((await createShareFor(d, asUser(owner), 'p1', { email: 'gus@x.test', workstream: 'feature-x' })).status).toBe(201);
  });

  it('takes a lifetime and a manual recipe, clamped and checked', async () => {
    const d = deps();
    const r = await createShareFor(d, asUser(owner), 'p1', { email: 'gus@x.test', workstream: 'main', ttlHours: 1000, recipe: { kind: 'manual', origins: ['127.0.0.2:8080'] } });
    expect(r.body).toMatchObject({ ttlHours: 168 });
    expect(d.store.create).toHaveBeenCalledWith(expect.objectContaining({ workstreamId: null, recipe: { kind: 'manual', origins: ['127.0.0.2:8080'] } }));
    const bad = await createShareFor(d, asUser(owner), 'p1', { email: 'gus@x.test', recipe: { kind: 'manual', origins: ['10.0.0.5:80'] } });
    expect(bad.status).toBe(400);
  });

  it('refuses: not the owner, sharing off, no such workstream, no such user, yourself', async () => {
    expect((await createShareFor(deps(), asUser(guest), 'p1', { email: 'gus@x.test' })).status).toBe(404);
    expect(await createShareFor(deps({ sharingOn: vi.fn(async () => false) }), asUser(owner), 'p1', { email: 'gus@x.test' })).toMatchObject({ status: 403, body: { code: 'preview-share-disabled' } });
    expect((await createShareFor(deps(), asUser(owner), 'p1', { email: 'gus@x.test', workstream: 'nope' })).status).toBe(404);
    expect((await createShareFor(deps(), asUser(owner), 'p1', { email: 'gus@x.test', workstream: '../etc' })).status).toBe(400);
    expect(await createShareFor(deps(), asUser(owner), 'p1', { email: 'nobody@x.test' })).toMatchObject({ status: 404, body: { code: 'no-such-user' } });
    expect((await createShareFor(deps(), asUser(owner), 'p1', { email: 'olive@x.test' })).status).toBe(400);
    expect((await createShareFor(deps(), asUser(owner), 'p1', {})).status).toBe(400);
  });
});

describe('revoking and extending', () => {
  it('revokes by both ids, closes the share\'s live guests and has the box forget their profiles', async () => {
    const d = deps({}, fakeStore([shareRow()]));
    const closed: string[] = [];
    registerGuestSocket('cshare0000000001', { close: (m) => closed.push(m) });
    expect((await revokeShareFor(d, asUser(owner), 'p-other', 'cshare0000000001')).status).toBe(404);
    expect((await revokeShareFor(d, asUser(guest), 'p1', 'cshare0000000001')).status).toBe(404);
    const r = await revokeShareFor(d, asUser(owner), 'p1', 'cshare0000000001');
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(closed).toEqual(['Its owner stopped sharing this preview.']);
    expect(sendForProject).toHaveBeenCalledWith({ userId: owner.id, instanceId: 'box-1' }, 'browser-profile-forget', { profileKey: `guest:cshare0000000001:${guest.id}` }, 15000);
    // And the owner's own Preview as guest profile.
    expect(sendForProject).toHaveBeenCalledWith({ userId: owner.id, instanceId: 'box-1' }, 'browser-profile-forget', { profileKey: `guest:cshare0000000001:${owner.id}` }, 15000);
    expect((await revokeShareFor(d, asUser(owner), 'p1', 'cshare0000000001')).status).toBe(404, 'nothing live to revoke twice');
  });

  it('extends from now, owner only, and tells the box the guests\' profiles live as long', async () => {
    const d = deps({}, fakeStore([shareRow()]));
    const r = await extendShareFor(d, asUser(owner), 'p1', 'cshare0000000001', { ttlHours: 72 });
    expect(r).toMatchObject({ status: 200, body: { expiresAt: new Date(NOW + 72 * 3600e3).toISOString() } });
    expect(sendForProject).toHaveBeenCalledWith({ userId: owner.id, instanceId: 'box-1' }, 'browser-profile-expiry',
      { profileKey: `guest:cshare0000000001:${guest.id}`, expiresAt: new Date(NOW + 72 * 3600e3).toISOString() }, 15000);
    expect(sendForProject).toHaveBeenCalledWith({ userId: owner.id, instanceId: 'box-1' }, 'browser-profile-expiry',
      { profileKey: `guest:cshare0000000001:${owner.id}`, expiresAt: new Date(NOW + 72 * 3600e3).toISOString() }, 15000);
    expect((await extendShareFor(d, asUser(guest), 'p1', 'cshare0000000001', { ttlHours: 72 })).status).toBe(404);
  });

  it('never ends a share sooner: a lifetime shorter than what is left is refused', async () => {
    const d = deps({}, fakeStore([shareRow({ expiresAt: new Date(NOW + 6 * 24 * 3600e3) })]));
    expect(await extendShareFor(d, asUser(owner), 'p1', 'cshare0000000001', { ttlHours: 24 })).toMatchObject({ status: 409, body: { code: 'would-shorten' } });
    expect(d.store.extend).not.toHaveBeenCalled();
    expect(sendForProject).not.toHaveBeenCalledWith(expect.anything(), 'browser-profile-expiry', expect.anything(), expect.anything());
    expect((await extendShareFor(d, asUser(owner), 'p1', 'cshare0000000001', { ttlHours: 168 })).status).toBe(200);
  });
});

describe('a share as its grantee sees it', () => {
  it('shows the grantee its state, and anyone else the same 404', async () => {
    const live = deps({}, fakeStore([shareRow()]));
    expect(await shareForGrantee(live, asUser(guest), 'cshare0000000001')).toMatchObject({ status: 200, body: { state: 'active', owner: { name: 'Olive Owner' }, workstream: 'feature-x', boxStatus: 'ready', signInHint: 'reviewer@example.com / example-password' } });
    const expired = deps({}, fakeStore([shareRow({ expiresAt: new Date(NOW - 1) })]));
    expect(await shareForGrantee(expired, asUser(guest), 'cshare0000000001')).toMatchObject({ status: 200, body: { state: 'expired', message: expect.stringMatching(/expired/), signInHint: null } });
    for (const d of [live, expired]) {
      expect(await shareForGrantee(d, asUser(stranger), 'cshare0000000001')).toEqual({ status: 404, body: { error: "This preview isn't shared with you.", code: 'not-shared' } });
    }
    expect((await shareForGrantee(live, asUser(guest), 'nope')).status).toBe(404);
    // Its owner sees it as its reviewer would (Preview as guest).
    expect(await shareForGrantee(live, asUser(owner), 'cshare0000000001')).toMatchObject({ status: 200, body: { state: 'active', asOwner: true } });
    expect(await shareForGrantee(live, asUser(guest), 'cshare0000000001')).toMatchObject({ body: { asOwner: false } });
  });

  it('shows its owner their own share whatever its audience, a phase-2 link share included, and its real state', async () => {
    const link = deps({}, fakeStore([shareRow({ audience: 'link', granteeId: null })]));
    expect(await shareForGrantee(link, asUser(owner), 'cshare0000000001')).toMatchObject({ status: 200, body: { state: 'active' } });
    // Nobody else gets a link share without the viewer row the token route makes.
    expect((await shareForGrantee(link, asUser(stranger), 'cshare0000000001')).status).toBe(404);
    const revoked = deps({}, fakeStore([shareRow({ audience: 'link', granteeId: null, revokedAt: new Date(NOW) })]));
    expect(await shareForGrantee(revoked, asUser(owner), 'cshare0000000001')).toMatchObject({ status: 200, body: { state: 'revoked' } });
  });

  it('tells an owner previewing their own share that the box is theirs to start, and sends nothing', async () => {
    const d = deps({}, fakeStore([shareRow()]));
    expect(await askWakeFor(d, asUser(owner), 'cshare0000000001')).toMatchObject({ status: 409, body: { code: 'own-box' } });
    expect(d.notifyWake).not.toHaveBeenCalled();
  });

  it('asks the owner to wake the box, at most every ten minutes', async () => {
    let t = NOW;
    const d = deps({ now: () => t }, fakeStore([shareRow()]));
    expect(await askWakeFor(d, asUser(guest), 'cshare0000000001')).toEqual({ status: 200, body: { ok: true, sent: true } });
    expect(d.notifyWake).toHaveBeenCalledWith(owner, guest, { projectName: 'webapp', workstream: 'feature-x' });
    expect((await askWakeFor(d, asUser(guest), 'cshare0000000001')).status).toBe(429);
    t += 11 * 60 * 1000;
    expect((await askWakeFor(d, asUser(guest), 'cshare0000000001')).status).toBe(200);
    expect((await askWakeFor(d, asUser(stranger), 'cshare0000000001')).status).toBe(404);
  });
});

describe('the share link', () => {
  async function get(path: string, userId: string | null, over: { signIn?: any; collaborator?: boolean } = {}) {
    const a = express();
    const store = fakeStore([shareRow()]);
    a.use('/termag/p', previewLinkRouter('/termag', {
      store, isCollaborator: vi.fn(async () => !!over.collaborator), userId: () => userId,
      signIn: 'signIn' in over ? over.signIn : vi.fn(async () => '/termag/auth/login'),
    }));
    const server = await new Promise<ReturnType<typeof a.listen>>(resolve => { const s = a.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { redirect: 'manual' });
      return { status: res.status, location: res.headers.get('location') };
    } finally {
      server.close();
    }
  }

  it('sends someone signed out to sign in, or answers 401 where the ALB signs people in', async () => {
    expect(await get('/termag/p/cshare0000000001', null)).toEqual({ status: 302, location: '/termag/auth/login' });
    expect((await get('/termag/p/cshare0000000001', null, { signIn: undefined })).status).toBe(401);
  });

  it('sends anyone signed in to the guest page, keeping a safe at and dropping an unsafe one', async () => {
    expect((await get('/termag/p/cshare0000000001?at=%2Fdefault%2Fflags', guest.id)).location).toBe('/termag/preview/cshare0000000001?at=%2Fdefault%2Fflags');
    // The page decides what a stranger sees: the same 404.
    expect((await get('/termag/p/cshare0000000001?at=%2F%2Fevil.example', stranger.id)).location).toBe('/termag/preview/cshare0000000001');
    expect((await get('/termag/p/not-a-share!', guest.id)).status).toBe(404);
  });

  it('sends the owner or a full collaborator to their own pane at that page', async () => {
    expect((await get('/termag/p/cshare0000000001?at=%2Fflags', owner.id)).location).toBe('/termag/?project=p1&ws=feature-x&browser=open&browserShare=cshare0000000001&browserAt=%2Fflags');
    expect((await get('/termag/p/cshare0000000001', stranger.id, { collaborator: true })).location).toBe('/termag/?project=p1&ws=feature-x&browser=open&browserShare=cshare0000000001');
  });

  it('redirects only to a path on this site, whatever the sign-in step hands back', async () => {
    for (const evil of ['https://evil.example/', '//evil.example/x', '/\\evil.example', '/termag/\r\nSet-Cookie: x=1']) {
      expect(await get('/termag/p/cshare0000000001', null, { signIn: vi.fn(async () => evil) }), evil).toEqual({ status: 404, location: null });
    }
  });

  it('is rate limited per viewer', async () => {
    const a = express();
    a.use('/termag/p', previewLinkRouter('/termag', { store: fakeStore([shareRow()]), isCollaborator: vi.fn(async () => false), userId: () => guest.id }));
    const server = await new Promise<ReturnType<typeof a.listen>>(resolve => { const s = a.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/termag/p/cshare0000000001`;
      const codes: number[] = [];
      for (let i = 0; i < 32; i += 1) codes.push((await fetch(url, { redirect: 'manual' })).status);
      expect(codes.slice(0, 30).every(c => c === 302)).toBe(true);
      expect(codes.slice(30)).toEqual([429, 429]);
    } finally {
      server.close();
    }
  });
});
