// An admin ends one preview link (services/previewLinkAdmin.ts, routes/admin/previewLinkEnd.ts;
// security-review.md SR15): by id or name, through the audience core, so the link's
// end hook revokes its sessions and tells the relay, and the event records the admin.
import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { adminEndPreviewLink, parseAdminLinkRef, type AdminEndableLink, type PreviewLinkAdminDeps } from './previewLinkAdmin';
import { endPreviewAudience, type AudienceRow } from './previewAudience';
import { previewLinkDelivery } from './previewLinks';
import { memoryStore } from './previewLinksTestStore';
import { previewLinksAdminRouter } from '../routes/admin/previewLinkEnd';

const NOW = new Date('2026-11-04T12:00:00Z');
const admin = { id: 'admin-1', googleEmail: 'admin@example.com' };

function world() {
  const mem = memoryStore();
  const told: Array<[string, readonly string[]]> = [];
  mem.deliveries.push(previewLinkDelivery(mem.store, (linkId, ids) => told.push([linkId, ids])));
  const a: AudienceRow = {
    id: 'aud-1', projectId: 'p', workstreamId: null, ownerId: 'owner', kind: 'owner', expiresAt: new Date(NOW.getTime() + 3600_000),
    revokedAt: null, endedAt: null, endReason: null, createdAt: NOW,
  };
  mem.audiences.push(a);
  mem.rawLinks.push({ id: 'clink0000001', name: 'abuse-app', audienceId: a.id, port: 3000, linkTokenHash: null, hostMode: 'localhost', requestId: null, createdAt: NOW });
  mem.names.set('abuse-app', { name: 'abuse-app', ownerId: 'owner', reservedUntil: new Date(NOW.getTime() + 31 * 86400_000), linkId: 'clink0000001' });
  mem.sessions.push({ idHash: 'h1', linkId: 'clink0000001', userId: 'viewer', basis: 'owner', tokenHash: null, revokedAt: null });
  const find = (ref: { id?: string; name?: string }): AdminEndableLink | null => {
    const id = ref.id ?? mem.names.get(ref.name ?? '')?.linkId;
    const l = mem.links.find(x => x.id === id);
    return l ? { id: l.id, name: l.name, audienceId: l.audienceId, ownerId: l.ownerId, boxId: 'box-1', endedAt: l.endedAt, endReason: l.endReason } : null;
  };
  const deps: PreviewLinkAdminDeps = {
    findLink: async (ref) => find(ref),
    endAudience: (audienceId, actorId, now) => endPreviewAudience(audienceId, 'admin', actorId, now, mem.endDeps),
    now: () => NOW,
  };
  return { mem, told, deps };
}

describe('adminEndPreviewLink', () => {
  it('ends a link by name with reason admin: sessions revoked, the relay told, the event naming the admin', async () => {
    const w = world();
    const r = await adminEndPreviewLink(w.deps, admin, { name: 'abuse-app', confirm: true });
    expect(r).toEqual({ status: 200, body: { link: { id: 'clink0000001', name: 'abuse-app', endedAt: NOW.toISOString(), endReason: 'admin' }, alreadyEnded: false } });
    expect(w.mem.sessions[0].revokedAt).toEqual(NOW);
    expect(w.told).toEqual([['clink0000001', ['h1']]]);
    expect(w.mem.events.at(-1)).toEqual({ audienceId: 'aud-1', kind: 'ended', actorId: 'admin-1', reason: 'admin' });
    // The name stays held at least 30 days from now (SR19).
    expect(w.mem.names.get('abuse-app')!.reservedUntil.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 30 * 86400_000);
  });

  it('ends a link by id, and answers an ended one as it is', async () => {
    const w = world();
    expect((await adminEndPreviewLink(w.deps, admin, { id: 'clink0000001', confirm: true })).status).toBe(200);
    expect(await adminEndPreviewLink(w.deps, admin, { id: 'clink0000001', confirm: true })).toMatchObject({ status: 200, body: { alreadyEnded: true, link: { endReason: 'admin' } } });
    expect(w.mem.events.filter(e => e.kind === 'ended')).toHaveLength(1);
  });

  it('is 404 for no such link, and 400 unless exactly one of id or name is given', async () => {
    const w = world();
    expect((await adminEndPreviewLink(w.deps, admin, { name: 'nope-app', confirm: true })).status).toBe(404);
    for (const body of [{ confirm: true }, { id: 'clink0000001', name: 'abuse-app', confirm: true }, { name: 'Bad Name', confirm: true }, { id: 1, confirm: true }, null, { name: 'abuse-app' }, { name: 'abuse-app', confirm: 'yes' }]) {
      expect((await adminEndPreviewLink(w.deps, admin, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(parseAdminLinkRef({ name: 'abuse-app' })).toEqual({ name: 'abuse-app' });
  });
});

describe('POST /api/admin/preview-links/end', () => {
  const servers: http.Server[] = [];
  afterAll(() => servers.forEach(s => s.close()));

  async function post(as: { tokenId?: string }, body: unknown) {
    const w = world();
    const app = express();
    app.use(express.json());
    // What requireAdmin leaves behind (middleware/admin.ts): an admin user, and with a bearer token its id.
    app.use((req, _res, next) => { req.user = { ...admin } as Express.User; if (as.tokenId) req.adminTokenId = as.tokenId; next(); });
    app.use('/api/admin', previewLinksAdminRouter(w.deps));
    const server = http.createServer(app);
    servers.push(server);
    const port = await new Promise<number>(r => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/preview-links/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json(), w };
  }

  it('ends the link for a signed-in admin session', async () => {
    const r = await post({}, { name: 'abuse-app', confirm: true });
    expect(r.status).toBe(200);
    expect(r.w.mem.audiences[0].endReason).toBe('admin');
  });

  it('refuses an admin bearer token: it acts on someone else\'s link, as quarantine does', async () => {
    const r = await post({ tokenId: 'tok-1' }, { name: 'abuse-app', confirm: true });
    expect(r.status).toBe(403);
    expect(r.w.mem.audiences[0].endedAt).toBeNull();
  });
});
