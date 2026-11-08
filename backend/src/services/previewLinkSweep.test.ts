// The preview links' sweep (services/previewLinkSweep.ts): ended links hold
// their names 30 days, their sessions are revoked and the relay is told, and
// lapsed names, dead codes and sessions and stale requests go.
import { describe, expect, it } from 'vitest';
import { runPreviewLinkSweep, type EndableLink, type PreviewLinkSweepStore } from './previewLinkSweep';
import { memoryStore } from './previewLinksTestStore';
import { NAME_HOLD_MS, nameSweepable } from './previewLinkRules';
import { previewLinkDelivery, type PreviewLinkRow } from './previewLinks';
import { endPreviewAudience, type AudienceRow } from './previewAudience';

const NOW = new Date('2026-11-02T12:00:00Z');
const H = 3600_000;

function sweepStore(boxGone = new Set<string>(), archived = new Set<string>()) {
  const mem = memoryStore();
  const told: Array<[string, readonly string[]]> = [];
  // #1107's link delivery, as index.ts installs it: ending an audience ends its links and tells the relay.
  mem.deliveries.push(previewLinkDelivery(mem.store, (linkId, ids) => told.push([linkId, ids])));
  const add = (over: { id: string; name: string; expiresAt?: Date; endedAt?: Date | null }) => {
    const expiresAt = over.expiresAt ?? new Date(NOW.getTime() + H);
    const a: AudienceRow = {
      id: `aud-${over.id}`, projectId: 'p', workstreamId: null, ownerId: 'owner', kind: 'owner', expiresAt, revokedAt: null,
      endedAt: over.endedAt ?? null, endReason: over.endedAt ? 'revoked' : null, createdAt: new Date(NOW.getTime() - H),
    };
    mem.audiences.push(a);
    mem.rawLinks.push({ id: over.id, name: over.name, audienceId: a.id, port: 3000, linkTokenHash: null, hostMode: 'localhost', requestId: null, createdAt: a.createdAt });
    mem.names.set(over.name, { name: over.name, ownerId: 'owner', reservedUntil: new Date(expiresAt.getTime() + NAME_HOLD_MS), linkId: over.id });
  };
  const endable = (l: PreviewLinkRow): EndableLink => ({ id: l.id, name: l.name, audienceId: l.audienceId, ownerId: l.ownerId, boxId: 'box-1' });
  const codes: Array<{ expiresAt: Date }> = [];
  const sessions: Array<{ expiresAt: Date; revokedAt: Date | null }> = [];
  const requests: Array<{ state: string; createdAt: Date }> = [];
  const store: PreviewLinkSweepStore = {
    endAudience: async (audienceId, reason, now) => {
      if (mem.audiences.find(a => a.id === audienceId)?.endedAt) return false;
      await endPreviewAudience(audienceId, reason, null, now, mem.endDeps);
      return true;
    },
    expiredLinks: async (now) => mem.links.filter(l => l.endedAt === null && l.expiresAt <= now).map(endable),
    boxGoneLinks: async (now) => mem.links.filter(l => l.endedAt === null && l.expiresAt > now && boxGone.has(l.id)).map(endable),
    archivedLinks: async (now) => mem.links.filter(l => l.endedAt === null && l.expiresAt > now && archived.has(l.id)).map(endable),
    deleteLapsedNames: async (now) => {
      let n = 0;
      for (const [name, row] of mem.names) {
        const link = row.linkId ? mem.links.find(l => l.id === row.linkId) ?? null : null;
        if (nameSweepable({ name, ownerId: row.ownerId, reservedUntil: row.reservedUntil, link }, now)) { mem.names.delete(name); n++; }
      }
      return n;
    },
    deleteExpiredCodes: async (now) => { const before = codes.length; codes.splice(0, codes.length, ...codes.filter(c => c.expiresAt > now)); return before - codes.length; },
    deleteDeadSessions: async (now, revokedBefore) => {
      const before = sessions.length;
      sessions.splice(0, sessions.length, ...sessions.filter(s => s.expiresAt > now && !(s.revokedAt && s.revokedAt <= revokedBefore)));
      return before - sessions.length;
    },
    expireRequests: async (createdBefore) => { let n = 0; for (const r of requests) if (r.state === 'pending' && r.createdAt <= createdBefore) { r.state = 'expired'; n++; } return n; },
    countLive: async (now) => mem.links.filter(l => l.endedAt === null && l.expiresAt > now).length,
  };
  return { mem, add, store, codes, sessions, requests, told };
}

describe('runPreviewLinkSweep', () => {
  it('ends an expired link, holds its name 30 days from now, revokes its sessions and tells the relay', async () => {
    const s = sweepStore();
    s.add({ id: 'l1', name: 'old-app', expiresAt: new Date(NOW.getTime() - 1) });
    s.add({ id: 'l2', name: 'live-app' });
    s.mem.sessions.push({ idHash: 'h1', linkId: 'l1', userId: 'v', basis: 'owner', tokenHash: null, revokedAt: null });
    const r = await runPreviewLinkSweep(s.store, NOW);
    expect(r).toMatchObject({ expired: 1, boxGone: 0, live: 1 });
    expect(s.mem.links.find(l => l.id === 'l1')).toMatchObject({ endedAt: NOW, endReason: 'expired' });
    expect(s.mem.names.get('old-app')!.reservedUntil.getTime()).toBe(NOW.getTime() + NAME_HOLD_MS);
    expect(s.mem.sessions[0].revokedAt).toEqual(NOW);
    expect(s.told).toEqual([['l1', ['h1']]]);
    expect(s.mem.events.map(e => [e.audienceId, e.kind, e.reason])).toEqual([['aud-l1', 'ended', 'expired']]);
    // Run again: nothing more to end.
    expect((await runPreviewLinkSweep(s.store, NOW)).expired).toBe(0);
  });

  it('ends a link whose box has gone', async () => {
    const s = sweepStore(new Set(['l1']));
    s.add({ id: 'l1', name: 'boxless' });
    const r = await runPreviewLinkSweep(s.store, NOW);
    expect(r.boxGone).toBe(1);
    expect(s.mem.links[0].endReason).toBe('box-gone');
  });

  it('ends a live link of an archived project whose end failed at archive time', async () => {
    const s = sweepStore(new Set(), new Set(['l1']));
    s.add({ id: 'l1', name: 'archived-app' });
    s.mem.sessions.push({ idHash: 'h1', linkId: 'l1', userId: 'v', basis: 'owner', tokenHash: null, revokedAt: null });
    const r = await runPreviewLinkSweep(s.store, NOW);
    expect(r.archived).toBe(1);
    expect(s.mem.links[0].endReason).toBe('project-gone');
    expect(s.told).toEqual([['l1', ['h1']]]);
  });

  it('frees a name only past its hold, and only when its link is gone or ended', async () => {
    const s = sweepStore();
    s.add({ id: 'l1', name: 'lapsed', expiresAt: new Date(NOW.getTime() - NAME_HOLD_MS - H), endedAt: new Date(NOW.getTime() - NAME_HOLD_MS - H) });
    s.add({ id: 'l2', name: 'held', expiresAt: new Date(NOW.getTime() - H), endedAt: new Date(NOW.getTime() - H) });
    s.mem.names.set('orphan', { name: 'orphan', ownerId: 'x', reservedUntil: new Date(NOW.getTime() - 1), linkId: null });
    s.mem.names.set('orphan-held', { name: 'orphan-held', ownerId: 'x', reservedUntil: new Date(NOW.getTime() + H), linkId: null });
    const r = await runPreviewLinkSweep(s.store, NOW);
    expect(r.names).toBe(2);
    expect([...s.mem.names.keys()].sort()).toEqual(['held', 'orphan-held']);
  });

  it('deletes expired codes, sessions past expiry or revoked over a day ago, and expires day-old requests', async () => {
    const s = sweepStore();
    s.codes.push({ expiresAt: new Date(NOW.getTime() - 1) }, { expiresAt: new Date(NOW.getTime() + 1) });
    s.sessions.push(
      { expiresAt: new Date(NOW.getTime() - 1), revokedAt: null },
      { expiresAt: new Date(NOW.getTime() + H), revokedAt: new Date(NOW.getTime() - 25 * H) },
      { expiresAt: new Date(NOW.getTime() + H), revokedAt: new Date(NOW.getTime() - H) },
      { expiresAt: new Date(NOW.getTime() + H), revokedAt: null },
    );
    s.requests.push({ state: 'pending', createdAt: new Date(NOW.getTime() - 25 * H) }, { state: 'pending', createdAt: new Date(NOW.getTime() - H) }, { state: 'declined', createdAt: new Date(0) });
    const r = await runPreviewLinkSweep(s.store, NOW);
    expect(r).toMatchObject({ codes: 1, sessions: 2, requests: 1 });
    expect(s.codes).toHaveLength(1);
    expect(s.sessions).toHaveLength(2);
    expect(s.requests.map(x => x.state)).toEqual(['expired', 'pending', 'declined']);
  });
});
