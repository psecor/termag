import { beforeEach, describe, expect, it } from 'vitest';
import { spaceFileFeed, type FeedClient } from './spaceFileFeed';
import { MemorySpaceStore } from './spacesTestkit';

let store: MemorySpaceStore;
let got: Map<string, unknown[]>;
let clients: FeedClient[];
let spaceId: string;

function client(userId: string, tag = userId): FeedClient {
  return { userId, send: frame => { got.set(tag, [...(got.get(tag) ?? []), JSON.parse(frame)]); } };
}

const feed = () => spaceFileFeed({
  store, clients: () => clients,
});

beforeEach(async () => {
  store = new MemorySpaceStore();
  for (const u of ['alice', 'bob', 'carol', 'dave']) store.addUser(u);
  got = new Map();
  const s = await store.createSpace({ name: 'improve-termag', description: null, userId: 'alice' });
  spaceId = s.id;
  await store.addMember({ spaceId, email: 'bob@example.com', role: 'viewer', addedById: 'alice' });
  const other = await store.createSpace({ name: 'other', description: null, userId: 'carol' });
  void other;
  clients = [client('alice', 'alice-1'), client('alice', 'alice-2'), client('bob'), client('carol'), client('dave')];
});

describe('deliver', () => {
  it('reaches every socket of each member, by the space\'s name, and nobody else', async () => {
    const n = await feed().deliver({ spaceId, kind: 'put', path: 'pr-outbox.md', etag: '"v2"' });
    expect(n).toBe(3);
    const frame = { type: 'space-file', space: 'improve-termag', kind: 'put', path: 'pr-outbox.md', etag: '"v2"' };
    expect(got.get('alice-1')).toEqual([frame]);
    expect(got.get('alice-2')).toEqual([frame]);
    expect(got.get('bob')).toEqual([frame]);
    expect(got.has('carol')).toBe(false); // owns another space, not this one
    expect(got.has('dave')).toBe(false);
  });

  it('sends nothing for a deleted space, an unknown id, or a name passed as the id', async () => {
    await feed().deliver({ spaceId: 'improve-termag', kind: 'put', path: 'a.md' });
    await feed().deliver({ spaceId: 'cknope', kind: 'put', path: 'a.md' });
    await store.markDeleted(spaceId);
    await feed().deliver({ spaceId, kind: 'put', path: 'a.md' });
    expect(got.size).toBe(0);
  });

  it('stops at once for someone removed from the space', async () => {
    await store.removeMember(spaceId, 'bob');
    await feed().deliver({ spaceId, kind: 'mv', path: 'd/', to: 'z/' });
    expect(got.has('bob')).toBe(false);
    expect(got.get('alice-1')).toEqual([{ type: 'space-file', space: 'improve-termag', kind: 'mv', path: 'd/', to: 'z/' }]);
  });

  it('passes on a change without paths as one', async () => {
    await feed().deliver({ spaceId, kind: 'mv' });
    expect(got.get('bob')).toEqual([{ type: 'space-file', space: 'improve-termag', kind: 'mv' }]);
  });
});

describe('resync', () => {
  it('goes to every socket, naming nothing', async () => {
    await feed().resync();
    expect(got.get('carol')).toEqual([{ type: 'space-file', resync: true }]);
    expect(got.get('alice-2')).toEqual([{ type: 'space-file', resync: true }]);
  });
});
