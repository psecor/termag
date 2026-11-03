// A chat belongs to one space, fixed when it starts (plan-outbox #38;
// services/chatSpace.ts), against a small in-memory stand-in for the
// queries it makes.
import { describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ prisma: {} }));
import { chatSpaceFor, fixedOnCreate, fixListedChatSpaces, resolveChatSpaceChoice, turnMemorySpace, type ChatSpaceDb } from './chatSpace';

interface World {
  spaces: Array<{ id: string; name: string; deletedAt: Date | null; members: string[] }>;
  grants: Array<{ id: string; spaceId: string; instanceId: string; createdAt: number }>;
  workstreams: Array<{ id: string; instanceId: string | null; spaceId: string | null; spaceFixedAt: Date | null }>;
}

function fakeDb(w: World): ChatSpaceDb & { writes: number } {
  const spaceOf = (id: string | null) => w.spaces.find(s => s.id === id) ?? null;
  const live = (id: string) => !spaceOf(id)?.deletedAt;
  const byAge = () => [...w.grants].sort((a, b) => a.createdAt - b.createdAt);
  const db = {
    writes: 0,
    workstream: {
      async findUnique({ where }: { where: { id: string } }) {
        const ws = w.workstreams.find(x => x.id === where.id);
        if (!ws) return null;
        const s = spaceOf(ws.spaceId);
        return { spaceFixedAt: ws.spaceFixedAt, space: s ? { id: s.id, name: s.name, deletedAt: s.deletedAt } : null, project: { instanceId: ws.instanceId } };
      },
      async updateMany({ where, data }: { where: { id: string | { in: string[] }; spaceFixedAt: null }; data: { spaceId: string | null; spaceFixedAt: Date } }) {
        const ids = typeof where.id === 'string' ? [where.id] : where.id.in;
        let count = 0;
        for (const ws of w.workstreams) {
          if (ids.includes(ws.id) && !ws.spaceFixedAt) { ws.spaceId = data.spaceId; ws.spaceFixedAt = data.spaceFixedAt; count++; db.writes++; }
        }
        return { count };
      },
    },
    space: {
      async findFirst({ where }: { where: { name: string; members: { some: { userId: string } } } }) {
        const s = w.spaces.find(x => x.name === where.name && !x.deletedAt && x.members.includes(where.members.some.userId));
        return s ? { id: s.id, name: s.name } : null;
      },
    },
    spaceBox: {
      async findFirst({ where }: { where: { instanceId: string; spaceId?: string } }) {
        const g = byAge().find(x => x.instanceId === where.instanceId && (where.spaceId ? x.spaceId === where.spaceId : live(x.spaceId)));
        if (!g) return null;
        const s = spaceOf(g.spaceId)!;
        return where.spaceId ? { id: g.id } : { space: { id: s.id, name: s.name } };
      },
      async findMany({ where }: { where: { instanceId: { in: string[] } } }) {
        return byAge().filter(x => where.instanceId.in.includes(x.instanceId) && live(x.spaceId)).map(x => ({ instanceId: x.instanceId, spaceId: x.spaceId }));
      },
    },
  };
  return db as unknown as ChatSpaceDb & { writes: number };
}

function world(): World {
  return {
    spaces: [
      { id: 's-alpha', name: 'alpha', deletedAt: null, members: ['u1'] },
      { id: 's-beta', name: 'beta', deletedAt: null, members: ['u1'] },
      { id: 's-gamma', name: 'gamma', deletedAt: null, members: [] },
    ],
    grants: [
      { id: 'g1', spaceId: 's-alpha', instanceId: 'box1', createdAt: 1 },
      { id: 'g2', spaceId: 's-beta', instanceId: 'box1', createdAt: 2 },
    ],
    workstreams: [
      { id: 'ws1', instanceId: 'box1', spaceId: null, spaceFixedAt: null },
      { id: 'ws2', instanceId: 'box2', spaceId: null, spaceFixedAt: null },
    ],
  };
}

describe('chatSpaceFor', () => {
  it('a chat with none yet gets its box\'s first granted space at first use, and keeps it after another grant', async () => {
    const w = world();
    const db = fakeDb(w);
    expect(await chatSpaceFor('ws1', {}, db)).toEqual({ space: { id: 's-alpha', name: 'alpha' }, reachable: true });
    expect(w.workstreams[0]).toEqual(expect.objectContaining({ spaceId: 's-alpha', spaceFixedAt: expect.any(Date) }));
    // An earlier-dated grant of another space (or any later one) moves nothing: it is fixed.
    w.grants.unshift({ id: 'g0', spaceId: 's-beta', instanceId: 'box1', createdAt: 0 });
    expect((await chatSpaceFor('ws1', {}, db)).space?.name).toBe('alpha');
    expect(db.writes).toBe(1);
  });

  it('New session\'s space is recorded; its "No space" too, for good', async () => {
    const w = world();
    const db = fakeDb(w);
    expect((await chatSpaceFor('ws1', { requested: { name: 'beta', userId: 'u1' } }, db)).space?.name).toBe('beta');
    expect(await chatSpaceFor('ws2', { requested: { name: null, userId: 'u1' } }, db)).toEqual({ space: null, reachable: false });
    w.grants.push({ id: 'g3', spaceId: 's-alpha', instanceId: 'box2', createdAt: 3 });
    expect((await chatSpaceFor('ws2', {}, db)).space).toBeNull();
  });

  it('a requested space that is not a live space of the user\'s falls back to the box\'s first', async () => {
    for (const name of ['gamma', 'nope']) {
      const db = fakeDb(world());
      expect((await chatSpaceFor('ws1', { requested: { name, userId: 'u1' } }, db)).space?.name).toBe('alpha');
    }
  });

  it('a box with no grant is No space; a fixed space the box lost, or one deleted, is not reachable or is none', async () => {
    const w = world();
    const db = fakeDb(w);
    expect(await chatSpaceFor('ws2', {}, db)).toEqual({ space: null, reachable: false });
    await chatSpaceFor('ws1', {}, db);
    w.grants = w.grants.filter(g => g.spaceId !== 's-alpha');
    expect(await chatSpaceFor('ws1', {}, db)).toEqual({ space: { id: 's-alpha', name: 'alpha' }, reachable: false });
    w.spaces[0].deletedAt = new Date();
    expect(await chatSpaceFor('ws1', {}, db)).toEqual({ space: null, reachable: false });
  });

  it('two first uses at once fix it once: the second reads what the first wrote', async () => {
    const w = world();
    const db = fakeDb(w);
    const [a, b] = await Promise.all([chatSpaceFor('ws1', { requested: { name: 'beta', userId: 'u1' } }, db), chatSpaceFor('ws1', {}, db)]);
    expect(a.space?.name).toBe(b.space?.name);
    expect(db.writes).toBe(1);
  });
});

describe('a space fixed as the chat\'s workstream is made (Bugbot, #769: New session space lost on list)', () => {
  it('resolves New session\'s or an automation\'s choice up front: a live space of the user\'s, No space, or nothing for an unknown name', async () => {
    const db = fakeDb(world());
    expect(await resolveChatSpaceChoice('beta', 'u1', db)).toEqual({ spaceId: 's-beta' });
    expect(await resolveChatSpaceChoice(null, 'u1', db)).toEqual({ spaceId: null });
    for (const bad of ['gamma', 'nope', undefined]) expect(await resolveChatSpaceChoice(bad, 'u1', db)).toBeNull();
  });

  it('a workstream made fixed is never refixed by a listing that comes before the create finishes', async () => {
    const w = world();
    const db = fakeDb(w);
    // The main workstream as the create inserts it: already fixed to No space, while its box has grants.
    w.workstreams[0] = { id: 'ws1', instanceId: 'box1', ...fixedOnCreate({ spaceId: null }) };
    const rows = [{ id: 'ws1', spaceId: w.workstreams[0].spaceId, spaceFixedAt: w.workstreams[0].spaceFixedAt }];
    await fixListedChatSpaces(rows, () => 'box1', db);
    expect(w.workstreams[0].spaceId).toBeNull();
    expect(await chatSpaceFor('ws1', {}, db)).toEqual({ space: null, reachable: false });
    expect(fixedOnCreate(null)).toEqual({});
  });
});

describe('turnMemorySpace: what every turn of a chat loads', () => {
  it('is the chat\'s space while its box is granted it, null for none or a lost grant, undefined when unreadable', async () => {
    const w = world();
    const db = fakeDb(w);
    expect(await turnMemorySpace('ws1', db)).toBe('alpha');
    expect(await turnMemorySpace('ws2', db)).toBeNull();
    w.grants = [];
    expect(await turnMemorySpace('ws1', db)).toBeNull();
    const broken = { ...db, workstream: { ...db.workstream, findUnique: async () => { throw new Error('db down'); } } } as ChatSpaceDb;
    expect(await turnMemorySpace('ws1', broken)).toBeUndefined();
  });
});

describe('fixListedChatSpaces', () => {
  it('fixes the list\'s unfixed chats by their box\'s first grant, leaves fixed ones alone, and says so on the rows', async () => {
    const w = world();
    w.workstreams.push({ id: 'ws3', instanceId: 'box1', spaceId: 's-beta', spaceFixedAt: new Date(5) });
    const db = fakeDb(w);
    const rows = w.workstreams.map(x => ({ id: x.id, spaceId: x.spaceId, spaceFixedAt: x.spaceFixedAt, instanceId: x.instanceId }));
    await fixListedChatSpaces(rows, r => r.instanceId, db);
    expect(rows.map(r => [r.id, r.spaceId, r.spaceFixedAt instanceof Date])).toEqual([['ws1', 's-alpha', true], ['ws2', null, true], ['ws3', 's-beta', true]]);
    expect(w.workstreams.map(x => x.spaceId)).toEqual(['s-alpha', null, 's-beta']);
    expect(w.workstreams[2].spaceFixedAt).toEqual(new Date(5));
    const writes = db.writes;
    await fixListedChatSpaces(rows, r => r.instanceId, db);
    expect(db.writes).toBe(writes);
  });
});
