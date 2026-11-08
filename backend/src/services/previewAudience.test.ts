import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));

const core = await import('./previewAudience');
const { memoryStore } = await import('./previewLinksTestStore');

const NOW = new Date('2026-11-04T12:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe('who may manage an audience (provisional: one policy per delivery)', () => {
  const owner = { isProjectOwner: true, isCollaborator: false };
  const collaborator = { isProjectOwner: false, isCollaborator: true };
  const stranger = { isProjectOwner: false, isCollaborator: false };

  it("links: the owner and collaborators create; the owner or the audience's creator change it", () => {
    const p = core.LINK_MANAGE_POLICY;
    expect([owner, collaborator, stranger].map(s => core.mayCreateAudience(p, s))).toEqual([true, true, false]);
    expect(core.mayChangeAudience(p, owner, { ownerId: 'bob' }, 'alice')).toBe(true);
    expect(core.mayChangeAudience(p, collaborator, { ownerId: 'bob' }, 'bob')).toBe(true);
    expect(core.mayChangeAudience(p, collaborator, { ownerId: 'bob' }, 'carol')).toBe(false);
  });

  it('an owner-only delivery (preview shares today) lets nobody else create or change', () => {
    const p = core.OWNER_ONLY_POLICY;
    expect([owner, collaborator, stranger].map(s => core.mayCreateAudience(p, s))).toEqual([true, false, false]);
    expect(core.mayChangeAudience(p, collaborator, { ownerId: 'bob' }, 'bob')).toBe(false);
  });
});

describe('expiry (provisional: the audience\'s, plus an optional per-grantee one)', () => {
  it('lives until its expiry or its end', () => {
    expect(core.audienceLive({ expiresAt: later(1), endedAt: null }, NOW)).toBe(true);
    expect(core.audienceLive({ expiresAt: NOW, endedAt: null }, NOW)).toBe(false);
    expect(core.audienceLive({ expiresAt: later(1), endedAt: NOW }, NOW)).toBe(false);
  });

  it('a grantee with no expiry of their own lasts as the audience does; one with an expiry, until it', () => {
    expect(core.granteeLive({ expiresAt: null }, NOW)).toBe(true);
    expect(core.granteeLive({ expiresAt: later(1) }, NOW)).toBe(true);
    expect(core.granteeLive({ expiresAt: NOW }, NOW)).toBe(false);
  });

  it('hasLiveGrant reads the grantee\'s own expiry', async () => {
    const mem = memoryStore();
    const a = await mem.audience.create({ projectId: 'p', workstreamId: null, ownerId: 'alice', kind: 'people', expiresAt: later(3600_000) });
    await mem.audience.setGrantees(a.id, ['bob', 'carol']);
    mem.grantees.find(g => g.userId === 'carol')!.expiresAt = NOW;
    expect(await mem.audience.hasLiveGrant(a.id, 'bob', NOW)).toBe(true);
    expect(await mem.audience.hasLiveGrant(a.id, 'carol', NOW)).toBe(false);
    expect(await mem.audience.hasLiveGrant(a.id, 'dave', NOW)).toBe(false);
  });
});

describe('ending an audience ends every delivery on it', () => {
  async function setup() {
    const mem = memoryStore();
    const mk = (projectId: string, workstreamId: string | null) =>
      mem.audience.create({ projectId, workstreamId, ownerId: 'alice', kind: 'owner', expiresAt: later(3600_000) });
    const a1 = await mk('p1', 'ws1');
    const a2 = await mk('p1', 'ws2');
    const other = await mk('p2', null);
    const ended: Array<[string, string, string]> = [];
    const delivery = (kind: string, has: Set<string>) => ({
      kind,
      async end(audienceId: string, reason: core.AudienceEndReason, actorId: string | null, now: Date) {
        if (!has.has(audienceId)) return false;
        ended.push([kind, audienceId, reason]);
        await core.endAudienceInTx(mem.audience, audienceId, reason, actorId, now);
        return true;
      },
    });
    mem.deliveries.push(delivery('link', new Set([a1.id])), delivery('share', new Set([a1.id])));
    return { mem, a1, a2, other, ended };
  }

  it('runs each delivery\'s end hook, and stamps the audience once', async () => {
    const { mem, a1, ended } = await setup();
    await core.endPreviewAudience(a1.id, 'revoked', 'alice', NOW, mem.endDeps);
    expect(ended).toEqual([['link', a1.id, 'revoked'], ['share', a1.id, 'revoked']]);
    expect(await mem.audience.read(a1.id)).toMatchObject({ endedAt: NOW, revokedAt: NOW, endReason: 'revoked' });
    expect(mem.events.filter(e => e.audienceId === a1.id)).toEqual([{ audienceId: a1.id, kind: 'revoked', actorId: 'alice', reason: 'revoked' }]);
  });

  it('ends an audience no delivery has anything on by itself', async () => {
    const { mem, a2, ended } = await setup();
    await core.endPreviewAudience(a2.id, 'expired', null, NOW, mem.endDeps);
    expect(ended).toEqual([]);
    expect(await mem.audience.read(a2.id)).toMatchObject({ endedAt: NOW, revokedAt: null, endReason: 'expired' });
  });

  it('a second end changes nothing', async () => {
    const mem = memoryStore();
    const a = await mem.audience.create({ projectId: 'p', workstreamId: null, ownerId: 'alice', kind: 'owner', expiresAt: later(1) });
    expect(await core.endAudienceInTx(mem.audience, a.id, 'expired', null, NOW)).toMatchObject({ endReason: 'expired' });
    expect(await core.endAudienceInTx(mem.audience, a.id, 'revoked', 'alice', later(5))).toBeNull();
    expect(await mem.audience.read(a.id)).toMatchObject({ endedAt: NOW, endReason: 'expired', revokedAt: null });
  });

  it("ends a project's audiences when it is archived, and a workstream's when it is removed, nobody else's", async () => {
    const { mem, a1, a2, other } = await setup();
    expect(await core.endPreviewAudiences({ workstreamId: 'ws2' }, 'workstream-gone', null, NOW, mem.endDeps)).toBe(1);
    expect((await mem.audience.read(a2.id))!.endReason).toBe('workstream-gone');
    expect((await mem.audience.read(a1.id))!.endedAt).toBeNull();
    expect(await core.endPreviewAudiences({ projectId: 'p1' }, 'project-gone', null, NOW, mem.endDeps)).toBe(1);
    expect((await mem.audience.read(a1.id))!.endReason).toBe('project-gone');
    expect((await mem.audience.read(other.id))!.endedAt).toBeNull();
  });
});

describe('ending a project\'s audiences when one of them fails', () => {
  it('still ends every other one, retries the failure once, and then throws naming it', async () => {
    const mem = memoryStore();
    const mk = () => mem.audience.create({ projectId: 'p1', workstreamId: null, ownerId: 'alice', kind: 'owner', expiresAt: later(3600_000) });
    const [a, b, c] = [await mk(), await mk(), await mk()];
    const tries = new Map<string, number>();
    mem.deliveries.push({
      kind: 'link',
      async end(audienceId, reason, actorId, now) {
        tries.set(audienceId, (tries.get(audienceId) ?? 0) + 1);
        if (audienceId === b.id) throw new Error('lock timeout');
        await core.endAudienceInTx(mem.audience, audienceId, reason, actorId, now);
        return true;
      },
    });
    await expect(core.endPreviewAudiences({ projectId: 'p1' }, 'project-gone', null, NOW, mem.endDeps))
      .rejects.toThrow(`1 of 3 preview audience(s) did not end (project-gone): ${b.id}`);
    expect((await mem.audience.read(a.id))!.endReason).toBe('project-gone');
    expect((await mem.audience.read(c.id))!.endReason).toBe('project-gone');
    expect((await mem.audience.read(b.id))!.endedAt).toBeNull();
    expect(tries.get(b.id)).toBe(2);
  });

  it('a failure that clears on the retry ends the audience, and nothing is thrown', async () => {
    const mem = memoryStore();
    const a = await mem.audience.create({ projectId: 'p1', workstreamId: null, ownerId: 'alice', kind: 'owner', expiresAt: later(3600_000) });
    let first = true;
    mem.deliveries.push({
      kind: 'link',
      async end(audienceId, reason, actorId, now) {
        if (first) { first = false; throw new Error('serialization failure'); }
        await core.endAudienceInTx(mem.audience, audienceId, reason, actorId, now);
        return true;
      },
    });
    expect(await core.endPreviewAudiences({ projectId: 'p1' }, 'project-gone', null, NOW, mem.endDeps)).toBe(1);
    expect((await mem.audience.read(a.id))!.endReason).toBe('project-gone');
  });
});
