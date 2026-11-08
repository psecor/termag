import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { spaceCallerFromCli, spacesRouter, SINGLE_PUT_MAX_BYTES } from './spaces';
import { spaceFilesRouter } from './spaceFiles';
import { spaceFileLinkPath } from '../services/spaces/spaceLinks';
import { SpacesUnavailableError } from '../services/spaces/spaceConfig';
import { MemorySpaceObjects, MemorySpaceStore } from '../services/spaces/spacesTestkit';
import { sweepSpaces } from '../services/spaces/spaceSweeper';
import type { SpaceCaller } from '../services/spaces/spaceAccess';
import type { PresignerIdentity } from '../services/spaces/spaceObjects';

let store: MemorySpaceStore;
let objects: MemorySpaceObjects;
let unavailable = false;
let identities: PresignerIdentity[];
/** Live file changes the router sent (onFileChange), for the open views a change must reach. */
const fileChanges: Array<{ kind: string; path: string; etag?: string }> = [];
let server: Server;
let origin: string;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const liveStore = new Proxy({}, { get: (_t, prop) => (store as unknown as Record<string | symbol, unknown>)[prop] && ((...args: unknown[]) => (store as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[prop](...args)) });
  app.use('/api/spaces', spacesRouter({
    store: liveStore as MemorySpaceStore,
    objects: async identity => {
      if (unavailable) throw new SpacesUnavailableError('no identity');
      identities.push(identity);
      return objects;
    },
    caller: r => {
      const user = r.get('x-user');
      if (!user) return null;
      const box = r.get('x-box');
      return (box ? { kind: 'box', userId: user, instanceId: box } : { kind: 'user', userId: user }) satisfies SpaceCaller;
    },
    fileLink: (space, path) => `https://ui.example${spaceFileLinkPath('/termag', space, path)}`,
    onFileChange: c => { fileChanges.push(c as never); },
  }));
  // The browser link, for a non-member's read of a file a box shared.
  app.use('/termag/files', spaceFilesRouter({
    store: liveStore as MemorySpaceStore,
    objects: async () => objects,
    userId: r => r.get('x-user') ?? null,
    viewerAllowed: () => true,
  }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `${origin}/api/spaces`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

beforeEach(() => {
  store = new MemorySpaceStore();
  objects = new MemorySpaceObjects();
  unavailable = false;
  identities = [];
  store.addUser('alice');
  store.addUser('bob');
  store.addUser('carol');
  store.addBox('alicebox', 'alice', 'alice-box');
  store.addBox('bobbox', 'bob', 'bob-box');
});

async function call(method: string, path: string, opts: { as?: string; box?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.as) headers['x-user'] = opts.as;
  if (opts.box) headers['x-box'] = opts.box;
  const res = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function createSpace(name = 'assets', as = 'alice') {
  const r = await call('POST', '/', { as, body: { name } });
  expect(r.status).toBe(201);
  return r.body.space as { id: string; name: string };
}

describe('authentication', () => {
  it('answers 401 with no caller', async () => {
    expect((await call('GET', '/')).status).toBe(401);
  });

  it('lists a box\'s spaces as its owner\'s', async () => {
    const s = await createSpace();
    await call('POST', `/${s.name}/boxes`, { as: 'alice', body: { box: 'alice-box' } });
    expect((await call('GET', '/', { as: 'alice', box: 'alicebox' })).body.spaces).toHaveLength(1);
  });

  it('answers 503 when the AWS identity cannot be read, without failing database routes', async () => {
    await createSpace();
    unavailable = true;
    expect((await call('GET', '/assets', { as: 'alice' })).status).toBe(200);
    const r = await call('GET', '/assets/tree', { as: 'alice' });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('spaces_unavailable');
  });
});

describe('spaceCallerFromCli', () => {
  it('makes a box token a box, and a token bound to no box its user', () => {
    expect(spaceCallerFromCli({ user: { id: 'alice' }, credential: { kind: 'box', boxId: 'i-1' } })).toEqual({ kind: 'box', userId: 'alice', instanceId: 'i-1' });
    expect(spaceCallerFromCli({ user: { id: 'alice' }, credential: { kind: 'box', boxId: null } })).toEqual({ kind: 'user', userId: 'alice' });
    expect(spaceCallerFromCli({ user: { id: 'alice' }, credential: { kind: 'device' } })).toEqual({ kind: 'user', userId: 'alice' });
  });
});

describe('spaces', () => {
  it('creates a space with its creator as owner and lists it', async () => {
    await createSpace();
    const r = await call('GET', '/', { as: 'alice' });
    expect(r.body.spaces).toEqual([expect.objectContaining({ name: 'assets', role: 'owner', readOnly: false, quotaBytes: 107374182400 })]);
    expect((await call('GET', '/', { as: 'bob' })).body.spaces).toEqual([]);
  });

  it('lists each space with its member count, invites not counted', async () => {
    await createSpace();
    await createSpace('solo');
    expect((await call('GET', '/', { as: 'alice' })).body.spaces.map((s: { name: string; memberCount: number }) => [s.name, s.memberCount]))
      .toEqual([['assets', 1], ['solo', 1]]);
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'editor' } });
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'nobody@example.com', role: 'viewer' } });
    const counts = (await call('GET', '/', { as: 'bob' })).body.spaces.map((s: { name: string; memberCount: number }) => [s.name, s.memberCount]);
    expect(counts).toEqual([['assets', 2]]);
  });

  it('refuses a bad or taken name', async () => {
    await createSpace();
    expect((await call('POST', '/', { as: 'bob', body: { name: 'Bad Name' } })).status).toBe(400);
    expect((await call('POST', '/', { as: 'bob', body: { name: 'assets' } })).status).toBe(409);
  });

  it('hides a space from non-members with a 404', async () => {
    await createSpace();
    expect((await call('GET', '/assets', { as: 'bob' })).status).toBe(404);
    expect((await call('GET', '/assets/tree', { as: 'bob' })).status).toBe(404);
  });

  it('lets a box read files but never manage', async () => {
    await createSpace();
    expect((await call('POST', '/', { as: 'alice', box: 'alicebox', body: { name: 'x2' } })).body.code).toBe('box_credential');
    expect((await call('PATCH', '/assets', { as: 'alice', box: 'alicebox', body: { name: 'x3' } })).body.code).toBe('box_credential');
  });

  it('renames and deletes as owner only', async () => {
    const s = await createSpace();
    await call('POST', `/${s.name}/members`, { as: 'alice', body: { email: 'bob@example.com', role: 'editor' } });
    expect((await call('PATCH', '/assets', { as: 'bob', body: { name: 'renamed' } })).status).toBe(403);
    expect((await call('PATCH', '/assets', { as: 'alice', body: { name: 'renamed' } })).body.space.name).toBe('renamed');
    expect((await call('DELETE', '/renamed', { as: 'alice' })).status).toBe(200);
    expect((await call('GET', '/', { as: 'bob' })).body.spaces).toEqual([]);
    expect(store.spaces.get(s.id)!.name).toBe(`deleted:${s.id}`);
    expect(store.eventRows.map(e => e.action)).toEqual(expect.arrayContaining(['space.rename', 'space.delete']));
  });
});

describe('members', () => {
  it('drops a pending invite when the person is added as a member', async () => {
    await createSpace();
    store.inviteRows.push({ id: 'inv-old', spaceId: store.spaces.values().next().value!.id, email: 'bob@example.com', role: 'viewer', addedById: 'alice', createdAt: new Date() });
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'editor' } });
    const r = await call('GET', '/assets/members', { as: 'alice' });
    expect(r.body.invites).toEqual([]);
    expect(r.body.members).toEqual(expect.arrayContaining([expect.objectContaining({ userId: 'bob', role: 'editor' })]));
  });

  it('adds a signed-in user at once and an unknown email as a pending invite', async () => {
    await createSpace();
    const added = await call('POST', '/assets/members', { as: 'alice', body: { email: 'BOB@example.com', role: 'viewer' } });
    expect(added.body.member).toMatchObject({ userId: 'bob', role: 'viewer' });
    expect((await call('GET', '/', { as: 'bob' })).body.spaces[0].role).toBe('viewer');

    const invited = await call('POST', '/assets/members', { as: 'alice', body: { email: 'dave@example.com', role: 'editor' } });
    expect(invited.body.invite).toMatchObject({ email: 'dave@example.com', role: 'editor' });
    store.addUser('dave');
    expect((await call('GET', '/', { as: 'dave' })).body.spaces[0]).toMatchObject({ name: 'assets', role: 'editor' });
    expect(store.inviteRows).toEqual([]);
  });

  it('claims an invite when a space is opened by name first', async () => {
    await createSpace();
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'dave@example.com', role: 'viewer' } });
    store.addUser('dave');
    expect((await call('GET', '/assets', { as: 'dave' })).body.space.role).toBe('viewer');
  });

  it('refuses self-adds, bad roles, and non-owners', async () => {
    await createSpace();
    expect((await call('POST', '/assets/members', { as: 'alice', body: { email: 'alice@example.com', role: 'owner' } })).body.code).toBe('self');
    expect((await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'admin' } })).body.code).toBe('invalid_role');
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'editor' } });
    expect((await call('POST', '/assets/members', { as: 'bob', body: { email: 'carol@example.com', role: 'viewer' } })).status).toBe(403);
  });

  it('never leaves a space without an owner', async () => {
    await createSpace();
    expect((await call('PATCH', '/assets/members/alice', { as: 'alice', body: { role: 'editor' } })).body.code).toBe('last_owner');
    expect((await call('DELETE', '/assets/members/alice', { as: 'alice' })).body.code).toBe('last_owner');
  });

  it('the store refuses the last owner even when the route check read a stale membership', async () => {
    const space = await createSpace();
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'owner' } });
    const stale = await store.memberRoles(space.id);
    vi.spyOn(store, 'memberRoles').mockResolvedValue(stale);
    expect((await call('DELETE', '/assets/members/bob', { as: 'alice' })).status).toBe(200);
    const r = await call('DELETE', '/assets/members/alice', { as: 'alice' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('last_owner');
    expect((await call('GET', '/assets/members', { as: 'alice' })).body.members.map((m: { email: string }) => m.email)).toEqual(['alice@example.com']);
  });

  it('lets a member leave a space whose owner is already gone', async () => {
    const space = await createSpace();
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'editor' } });
    store.memberRows = store.memberRows.filter(m => !(m.spaceId === space.id && m.userId === 'alice'));
    expect((await call('DELETE', '/assets/members/bob', { as: 'bob' })).status).toBe(200);
  });

  it('removing a member removes their boxes too, so a re-add does not re-arm them', async () => {
    await createSpace();
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'editor' } });
    await call('POST', '/assets/boxes', { as: 'bob', body: { box: 'bob-box' } });
    expect((await call('GET', '/', { as: 'bob', box: 'bobbox' })).body.spaces).toHaveLength(1);
    const r = await call('DELETE', '/assets/members/bob', { as: 'alice' });
    expect(r.body.removedBoxes).toBe(1);
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'editor' } });
    expect((await call('GET', '/', { as: 'bob', box: 'bobbox' })).body.spaces).toEqual([]);
  });

  it('lets a member leave', async () => {
    await createSpace();
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'viewer' } });
    expect((await call('DELETE', '/assets/members/bob', { as: 'bob' })).status).toBe(200);
    expect((await call('GET', '/assets', { as: 'bob' })).status).toBe(404);
  });

  it('shows invites to owners only', async () => {
    await createSpace();
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'viewer' } });
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'dave@example.com', role: 'viewer' } });
    expect((await call('GET', '/assets/members', { as: 'alice' })).body.invites).toHaveLength(1);
    expect((await call('GET', '/assets/members', { as: 'bob' })).body.invites).toEqual([]);
  });
});

describe('boxes', () => {
  it('adds only the caller\'s own box, as editor or owner', async () => {
    await createSpace();
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'viewer' } });
    expect((await call('POST', '/assets/boxes', { as: 'alice', body: { box: 'bob-box' } })).body.code).toBe('box_not_found');
    expect((await call('POST', '/assets/boxes', { as: 'bob', body: { box: 'bob-box' } })).status).toBe(403);
    expect((await call('POST', '/assets/boxes', { as: 'alice', body: { box: 'alice-box' } })).status).toBe(201);
    const list = await call('GET', '/assets/boxes', { as: 'alice' });
    expect(list.body.boxes).toEqual([expect.objectContaining({ id: 'alicebox', name: 'alice-box', mine: true, children: [] })]);
  });

  it('gives a box its owner\'s current role, and nothing once terminated', async () => {
    await createSpace();
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'editor' } });
    await call('POST', '/assets/boxes', { as: 'bob', body: { box: 'bob-box' } });
    const listed = await call('GET', '/', { as: 'bob', box: 'bobbox' });
    expect(listed.body.spaces[0]).toMatchObject({ role: 'editor', access: { kind: 'explicit' } });
    await call('PATCH', '/assets/members/bob', { as: 'alice', body: { role: 'viewer' } });
    expect((await call('POST', '/assets/files/upload', { as: 'bob', box: 'bobbox', body: { path: 'a', size: 1 } })).status).toBe(403);
    store.boxes.get('bobbox')!.status = 'terminated';
    expect((await call('GET', '/assets/tree', { as: 'bob', box: 'bobbox' })).status).toBe(404);
  });

  it('gives a child box its parent\'s spaces with the owner\'s full role', async () => {
    const s = await createSpace();
    await call('POST', '/assets/boxes', { as: 'alice', body: { box: 'alice-box' } });
    store.addBox('askbox', 'alice', 'ask-box', 'ready', 'alicebox');
    const listed = await call('GET', '/', { as: 'alice', box: 'askbox' });
    expect(listed.body.spaces).toEqual([expect.objectContaining({ name: 'assets', role: 'owner', access: { kind: 'inherited', via: 'alicebox' } })]);
    expect((await call('POST', '/assets/files/upload', { as: 'alice', box: 'askbox', body: { path: 'a', size: 1 } })).status).toBe(200);
    objects.put(`${s.id}/a`, 1);
    expect((await call('POST', '/assets/files/download', { as: 'alice', box: 'askbox', body: { path: 'a' } })).status).toBe(200);
    expect(store.eventRows.at(-1)).toMatchObject({ actorInstanceId: 'askbox', via: 'alicebox' });
    const boxes = await call('GET', '/assets/boxes', { as: 'alice' });
    expect(boxes.body.boxes[0].children).toEqual([{ id: 'askbox', name: 'ask-box', via: 'alicebox' }]);
  });

  it('gives a child nothing through a terminated parent or another owner\'s box', async () => {
    await createSpace();
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'editor' } });
    await call('POST', '/assets/boxes', { as: 'alice', body: { box: 'alice-box' } });
    store.addBox('bobchild', 'bob', 'bob-child', 'ready', 'alicebox');
    expect((await call('GET', '/assets/tree', { as: 'bob', box: 'bobchild' })).status).toBe(404);
    expect((await call('GET', '/', { as: 'bob', box: 'bobchild' })).body.spaces).toEqual([]);
    store.addBox('askbox', 'alice', 'ask-box', 'ready', 'alicebox');
    expect((await call('GET', '/assets/tree', { as: 'alice', box: 'askbox' })).status).toBe(200);
    store.boxes.get('alicebox')!.status = 'terminated';
    expect((await call('GET', '/assets/tree', { as: 'alice', box: 'askbox' })).status).toBe(404);
  });

  it('never lets a child box manage the space', async () => {
    await createSpace();
    await call('POST', '/assets/boxes', { as: 'alice', body: { box: 'alice-box' } });
    store.addBox('askbox', 'alice', 'ask-box', 'ready', 'alicebox');
    const r = await call('POST', '/assets/boxes', { as: 'alice', box: 'askbox', body: { box: 'ask-box' } });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('box_credential');
  });

  it('lets the box owner or a space owner remove a box', async () => {
    await createSpace();
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'editor' } });
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'carol@example.com', role: 'editor' } });
    await call('POST', '/assets/boxes', { as: 'bob', body: { box: 'bob-box' } });
    expect((await call('DELETE', '/assets/boxes/bobbox', { as: 'carol' })).status).toBe(403);
    expect((await call('DELETE', '/assets/boxes/bobbox', { as: 'alice' })).status).toBe(200);
  });
});

describe('listing outlives the box', () => {
  beforeEach(async () => {
    await createSpace();
    store.addProject('chat', 'alice', 'alicebox');
    await call('POST', '/assets/boxes', { as: 'alice', body: { box: 'alice-box' } });
  });

  it('lists a terminated box\'s project in the space, before and after the sweep prunes its grant', async () => {
    const assets = [...store.spaces.values()][0];
    expect(store.listedIn('chat')).toEqual([assets.id]);
    expect((await call('GET', '/assets/boxes', { as: 'alice' })).body.listed).toEqual([]);
    store.boxes.get('alicebox')!.status = 'terminated';
    const before = await call('GET', '/assets/boxes', { as: 'alice' });
    expect(before.body.boxes).toEqual([]);
    expect(before.body.listed).toEqual([{ id: 'alicebox' }]);
    await store.recordListings();
    expect(await store.pruneTerminatedGrants()).toBe(1);
    expect((await call('GET', '/assets/boxes', { as: 'alice' })).body.listed).toEqual([{ id: 'alicebox' }]);
    expect((await call('GET', '/assets/tree', { as: 'alice', box: 'alicebox' })).status).toBe(404);
  });

  it('keeps a child\'s inherited listing once its parent terminates', async () => {
    store.addBox('askbox', 'alice', 'ask-box', 'ready', 'alicebox');
    store.addProject('ask', 'alice', 'askbox');
    await store.recordListings();
    store.boxes.get('alicebox')!.status = 'terminated';
    store.boxes.get('askbox')!.status = 'terminated';
    await store.recordListings();
    await store.pruneTerminatedGrants();
    expect((await call('GET', '/assets/boxes', { as: 'alice' })).body.listed).toEqual([{ id: 'alicebox' }, { id: 'askbox' }]);
  });

  it('keeps a live child\'s inherited listing in the space once its parent terminates', async () => {
    store.addBox('askbox', 'alice', 'ask-box', 'ready', 'alicebox');
    store.addProject('ask', 'alice', 'askbox');
    await store.recordListings();
    const live = await call('GET', '/assets/boxes', { as: 'alice' });
    expect(live.body.boxes[0].children).toEqual([expect.objectContaining({ id: 'askbox' })]);
    expect(live.body.listed).toEqual([]);
    store.boxes.get('alicebox')!.status = 'terminated';
    await store.recordListings();
    await store.pruneTerminatedGrants();
    expect((await call('GET', '/assets/boxes', { as: 'alice' })).body.listed).toEqual([{ id: 'alicebox' }, { id: 'askbox' }]);
  });

  it('unlists a removed box\'s projects and its live children\'s', async () => {
    store.addBox('askbox', 'alice', 'ask-box', 'ready', 'alicebox');
    store.addProject('ask', 'alice', 'askbox');
    await store.recordListings();
    expect(store.listedIn('ask')).toHaveLength(1);
    expect((await call('DELETE', '/assets/boxes/alicebox', { as: 'alice' })).status).toBe(200);
    expect(store.listedIn('chat')).toEqual([]);
    expect(store.listedIn('ask')).toEqual([]);
  });

  it('keeps a listing another grant still reaches', async () => {
    store.addBox('askbox', 'alice', 'ask-box', 'ready', 'alicebox');
    store.addProject('ask', 'alice', 'askbox');
    await call('POST', '/assets/boxes', { as: 'alice', body: { box: 'ask-box' } });
    await call('DELETE', '/assets/boxes/alicebox', { as: 'alice' });
    expect(store.listedIn('ask')).toHaveLength(1);
  });

  it('doesn\'t list a box a project moved to that the space never granted', async () => {
    store.addBox('newbox', 'alice', 'new-box', 'ready');
    store.projects.get('chat')!.instanceId = 'newbox';
    store.boxes.get('alicebox')!.status = 'terminated';
    await store.recordListings();
    await store.pruneTerminatedGrants();
    expect((await call('GET', '/assets/boxes', { as: 'alice' })).body.listed).toEqual([]);
  });

  it('moves the listing with a project that lands on another granted box', async () => {
    store.addBox('newbox', 'alice', 'new-box', 'ready');
    await call('POST', '/assets/boxes', { as: 'alice', body: { box: 'new-box' } });
    store.projects.get('chat')!.instanceId = 'newbox';
    await store.recordListings();
    store.boxes.get('newbox')!.status = 'terminated';
    await store.recordListings();
    await store.pruneTerminatedGrants();
    expect((await call('GET', '/assets/boxes', { as: 'alice' })).body.listed).toEqual([{ id: 'newbox' }]);
  });

  it('unlists a member\'s projects when they leave', async () => {
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'owner' } });
    expect((await call('DELETE', '/assets/members/alice', { as: 'alice' })).status).toBe(200);
    expect(store.listedIn('chat')).toEqual([]);
  });
});

describe('files', () => {
  it('reaches S3 as the person, or as the box with its owner', async () => {
    const s = await createSpace();
    await call('POST', `/${s.name}/boxes`, { as: 'alice', body: { box: 'alice-box' } });
    objects.put(`${s.id}/a.txt`, 3);
    await call('POST', '/assets/files/download', { as: 'alice', body: { path: 'a.txt' } });
    await call('POST', '/assets/files/download', { as: 'alice', box: 'alicebox', body: { path: 'a.txt' } });
    expect(identities).toEqual([
      { kind: 'user', userId: 'alice', email: 'alice@example.com' },
      { kind: 'box', instanceId: 'alicebox', name: 'alice-box', ownerUserId: 'alice', ownerEmail: 'alice@example.com' },
    ]);
  });

  it('lists one level at a time, only under the space\'s prefix', async () => {
    const s = await createSpace();
    objects.put(`${s.id}/a.txt`, 3);
    objects.put(`${s.id}/docs/b.md`, 4);
    objects.put(`${s.id}/docs/deep/c.json`, 5);
    objects.put('otherspace/secret.txt', 9);
    const root = await call('GET', '/assets/tree', { as: 'alice' });
    expect(root.body.dirs).toEqual([{ name: 'docs', path: 'docs/' }]);
    expect(root.body.files).toEqual([expect.objectContaining({ name: 'a.txt', path: 'a.txt', size: 3 })]);
    const docs = await call('GET', '/assets/tree?prefix=docs', { as: 'alice' });
    expect(docs.body.prefix).toBe('docs/');
    expect(docs.body.files.map((f: { path: string }) => f.path)).toEqual(['docs/b.md']);
    expect((await call('GET', '/assets/tree?prefix=../x', { as: 'alice' })).status).toBe(400);
  });

  it('presigns downloads, inline only where safe, and logs them', async () => {
    const s = await createSpace();
    objects.put(`${s.id}/cat.png`, 10, 'image/png');
    objects.put(`${s.id}/page.html`, 10, 'text/html');
    const img = await call('POST', '/assets/files/download', { as: 'alice', body: { path: 'cat.png', inline: true } });
    expect(img.body).toMatchObject({ url: expect.stringContaining('/get/'), size: 10 });
    expect(objects.presigned.at(-1)!.extra).toMatchObject({ contentType: 'image/png', contentDisposition: expect.stringMatching(/^inline/) });
    await call('POST', '/assets/files/download', { as: 'alice', body: { path: 'page.html', inline: true } });
    expect(objects.presigned.at(-1)!.extra).toMatchObject({ contentDisposition: expect.stringMatching(/^attachment/) });
    expect((await call('POST', '/assets/files/download', { as: 'alice', body: { path: 'nope' } })).status).toBe(404);
    expect(store.eventRows.filter(e => e.action === 'file.get')).toHaveLength(2);
  });

  it('signs 30-minute inline viewer URLs, HTML and SVG as plain text, and says when there is no viewer', async () => {
    const s = await createSpace();
    objects.put(`${s.id}/r.pdf`, 10, 'application/octet-stream');
    objects.put(`${s.id}/page.html`, 10, 'text/html');
    objects.put(`${s.id}/logo.svg`, 10, 'image/svg+xml');
    objects.put(`${s.id}/deck.pptx`, 10, 'application/vnd.ms-powerpoint');
    const pdf = await call('POST', '/assets/files/download', { as: 'alice', body: { path: 'r.pdf', view: true } });
    expect(pdf.body.view).toEqual({ contentType: 'application/pdf', render: 'frame' });
    expect(objects.presigned.at(-1)!.extra).toMatchObject({ contentType: 'application/pdf', contentDisposition: expect.stringMatching(/^inline/), ttlS: 30 * 60 });
    for (const [path, render] of [['page.html', 'html'], ['logo.svg', 'svg']]) {
      const r = await call('POST', '/assets/files/download', { as: 'alice', body: { path, view: true } });
      expect(r.body.view).toEqual({ contentType: 'text/plain; charset=utf-8', render });
      expect(objects.presigned.at(-1)!.extra).toMatchObject({ contentType: 'text/plain; charset=utf-8', ttlS: 30 * 60 });
      const raw = await call('POST', '/assets/files/download', { as: 'alice', body: { path, inline: true } });
      expect(raw.body).not.toHaveProperty('view');
      expect(objects.presigned.at(-1)!.extra).toEqual({ contentDisposition: expect.stringMatching(/^attachment/) });
    }
    const deck = await call('POST', '/assets/files/download', { as: 'alice', body: { path: 'deck.pptx', view: true } });
    expect(deck.body.view).toBeNull();
    expect(objects.presigned.at(-1)!.extra).toMatchObject({ contentDisposition: expect.stringMatching(/^attachment/) });
    expect(objects.presigned.at(-1)!.extra).not.toHaveProperty('ttlS');
  });

  it('hands out a file\'s browser link to a viewer or a granted box, and 404s a missing file', async () => {
    const s = await createSpace();
    objects.put(`${s.id}/docs/My Report.pdf`, 12, 'application/pdf');
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'viewer' } });
    const link = await call('POST', '/assets/files/link', { as: 'bob', body: { path: 'docs/My Report.pdf' } });
    expect(link).toEqual({ status: 200, body: { url: 'https://ui.example/termag/files/assets/docs/My%20Report.pdf', path: 'docs/My Report.pdf', size: 12 } });
    expect((await call('POST', '/assets/files/link', { as: 'bob', body: { path: 'nope.pdf' } })).status).toBe(404);
    expect((await call('POST', '/assets/files/link', { as: 'carol', body: { path: 'docs/My Report.pdf' } })).status).toBe(404);
    expect((await call('POST', '/assets/files/link', { as: 'bob', body: { path: '../x' } })).status).toBe(400);
    await call('POST', '/assets/boxes', { as: 'alice', body: { box: 'alicebox' } });
    expect((await call('POST', '/assets/files/link', { as: 'alice', box: 'alicebox', body: { path: 'docs/My Report.pdf' } })).status).toBe(200);
    expect(objects.presigned).toHaveLength(0);
  });

  it('presigns a single PUT up to 64 MiB, charging it, then records the upload', async () => {
    const s = await createSpace();
    const up = await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'a/b.txt', size: 5, contentType: 'text/plain' } });
    expect(up.body).toMatchObject({ kind: 'single', method: 'PUT', path: 'a/b.txt' });
    expect(objects.presigned.at(-1)).toEqual({ op: 'put', key: `${s.id}/a/b.txt`, extra: { size: 5, contentType: 'text/plain' } });
    expect(store.spaces.get(s.id)!.usedBytes).toBe(5n);
    expect(store.eventRows.at(-1)).toMatchObject({ action: 'file.put.signed', path: 'a/b.txt', bytes: 5, actorUserId: 'alice' });
    expect((await call('POST', '/assets/files/uploaded', { as: 'alice', body: { path: 'a/b.txt' } })).status).toBe(409);
    objects.put(`${s.id}/a/b.txt`, 5);
    expect((await call('POST', '/assets/files/uploaded', { as: 'alice', body: { path: 'a/b.txt' } })).body.size).toBe(5);
    expect(store.spaces.get(s.id)!.usedBytes).toBe(5n);
    expect(store.eventRows.at(-1)).toMatchObject({ action: 'file.put', path: 'a/b.txt', bytes: 5 });
  });

  it('switches to multipart above 64 MiB and completes it', async () => {
    const s = await createSpace();
    const size = SINGLE_PUT_MAX_BYTES + 1;
    const up = await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'big.bin', size } });
    expect(up.body).toMatchObject({ kind: 'multipart', partCount: 2 });
    const parts = await call('POST', `/assets/uploads/${up.body.uploadId}/parts`, { as: 'alice', body: { path: 'big.bin', size, partNumbers: [1, 2] } });
    expect(parts.body.parts.map((p: { partNumber: number }) => p.partNumber)).toEqual([1, 2]);
    expect(objects.presigned.at(-1)).toEqual({ op: 'parts', key: `${s.id}/big.bin`, extra: [{ partNumber: 1, size: SINGLE_PUT_MAX_BYTES }, { partNumber: 2, size: 1 }] });
    expect(store.spaces.get(s.id)!.usedBytes).toBe(BigInt(size));
    const done = await call('POST', `/assets/uploads/${up.body.uploadId}/complete`, {
      as: 'alice', body: { path: 'big.bin', parts: [{ partNumber: 1, etag: 'a' }, { partNumber: 2, etag: 'b' }] },
    });
    expect(done.body).toMatchObject({ ok: true, size: 20 });
    expect(objects.files.has(`${s.id}/big.bin`)).toBe(true);
  });

  it('signs multipart parts only for the declared size, within the limits', async () => {
    await createSpace();
    const size = SINGLE_PUT_MAX_BYTES + 1;
    const up = await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'big.bin', size } });
    const parts = (body: unknown) => call('POST', `/assets/uploads/${up.body.uploadId}/parts`, { as: 'alice', body });
    expect((await parts({ path: 'big.bin', partNumbers: [1] })).body.code).toBe('invalid_size');
    expect((await parts({ path: 'big.bin', size, partNumbers: [3] })).body.code).toBe('invalid_parts');
    expect((await parts({ path: 'big.bin', size: 6 * 1024 ** 3, partNumbers: [1] })).body.code).toBe('file_too_large');
  });

  it('records a confirmed upload once, and an overwrite again, without charging on confirm', async () => {
    const s = await createSpace();
    objects.put(`${s.id}/a.txt`, 5, 'text/plain', new Date(Date.now() - 60_000));
    for (let i = 0; i < 3; i++) expect((await call('POST', '/assets/files/uploaded', { as: 'alice', body: { path: 'a.txt' } })).status).toBe(200);
    expect(store.eventRows.filter(e => e.action === 'file.put')).toHaveLength(1);
    objects.put(`${s.id}/a.txt`, 7, 'text/plain', new Date(Date.now() + 60_000));
    await call('POST', '/assets/files/uploaded', { as: 'alice', body: { path: 'a.txt' } });
    expect(store.eventRows.filter(e => e.action === 'file.put')).toHaveLength(2);
    expect(store.spaces.get(s.id)!.usedBytes).toBe(0n);
  });

  it('counts signed URLs against the quota whether or not the upload is confirmed', async () => {
    const s = await createSpace();
    store.spaces.get(s.id)!.quotaBytes = 10n;
    expect((await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'a', size: 6 } })).status).toBe(200);
    expect((await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'b', size: 6 } })).body.code).toBe('quota_exceeded');
  });

  it('counts an upload once after the sweep, whether it was a single PUT or multipart', async () => {
    const s = await createSpace();
    const single = await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'a.txt', size: 6 } });
    expect(single.body.kind).toBe('single');
    objects.put(`${s.id}/a.txt`, 6, 'text/plain', new Date(Date.now() + 1000));
    const size = SINGLE_PUT_MAX_BYTES + 1;
    const up = await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'big.bin', size } });
    await call('POST', `/assets/uploads/${up.body.uploadId}/parts`, { as: 'alice', body: { path: 'big.bin', size, partNumbers: [1, 2] } });
    const done = await call('POST', `/assets/uploads/${up.body.uploadId}/complete`, { as: 'alice', body: { path: 'big.bin', parts: [{ partNumber: 1, etag: 'a' }, { partNumber: 2, etag: 'b' }] } });
    expect(done.status).toBe(200);
    expect(store.spaces.get(s.id)!.usedBytes).toBe(6n + BigInt(size));
    await sweepSpaces(store, async () => objects);
    expect(store.spaces.get(s.id)!.usedBytes).toBe(6n + 20n);
  });

  it('charges concurrent presigns atomically, so they cannot pass the quota together', async () => {
    const s = await createSpace();
    store.spaces.get(s.id)!.quotaBytes = 10n;
    const rs = await Promise.all(['a', 'b', 'c'].map(path => call('POST', '/assets/files/upload', { as: 'alice', body: { path, size: 4 } })));
    expect(rs.map(r => r.status).sort()).toEqual([200, 200, 413]);
    expect(store.spaces.get(s.id)!.usedBytes).toBe(8n);
  });

  it('charges multipart parts per signed batch, so a later batch is not refused for the whole file', async () => {
    const s = await createSpace();
    const size = SINGLE_PUT_MAX_BYTES * 2;
    store.spaces.get(s.id)!.quotaBytes = BigInt(size) + 1n;
    const up = await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'big.bin', size } });
    const parts = (n: number) => call('POST', `/assets/uploads/${up.body.uploadId}/parts`, { as: 'alice', body: { path: 'big.bin', size, partNumbers: [n] } });
    expect((await parts(1)).status).toBe(200);
    expect((await parts(2)).status).toBe(200);
    expect(store.spaces.get(s.id)!.usedBytes).toBe(BigInt(size));
    expect((await parts(2)).body.code).toBe('quota_exceeded');
  });

  it('refuses uploads over 5 GiB, over quota, or from a viewer', async () => {
    const s = await createSpace();
    expect((await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'x', size: 6 * 1024 ** 3 } })).body.code).toBe('file_too_large');
    store.spaces.get(s.id)!.usedBytes = store.spaces.get(s.id)!.quotaBytes;
    expect((await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'x', size: 1 } })).body.code).toBe('quota_exceeded');
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'viewer' } });
    expect((await call('POST', '/assets/files/upload', { as: 'bob', body: { path: 'x', size: 1 } })).status).toBe(403);
  });

  it('moves a file and a folder, and refuses a folder into itself', async () => {
    const s = await createSpace();
    objects.put(`${s.id}/a.txt`, 1);
    objects.put(`${s.id}/d/x.txt`, 2);
    objects.put(`${s.id}/d/e/y.txt`, 3);
    expect((await call('POST', '/assets/files/move', { as: 'alice', body: { from: 'a.txt', to: 'b.txt' } })).body.moved).toBe(1);
    expect((await call('POST', '/assets/files/move', { as: 'alice', body: { from: 'd/', to: 'z/' } })).body.moved).toBe(2);
    expect([...objects.files.keys()].sort()).toEqual([`${s.id}/b.txt`, `${s.id}/z/e/y.txt`, `${s.id}/z/x.txt`]);
    expect((await call('POST', '/assets/files/move', { as: 'alice', body: { from: 'z/', to: 'z/in/' } })).body.code).toBe('invalid_move');
    expect(store.eventRows.filter(e => e.action === 'file.mv')).toHaveLength(2);
  });

  it('deletes a file, or a folder with recursive', async () => {
    const s = await createSpace();
    objects.put(`${s.id}/a.txt`, 1);
    objects.put(`${s.id}/d/x.txt`, 2);
    objects.put(`${s.id}/d/y.txt`, 3);
    expect((await call('DELETE', '/assets/files?path=a.txt', { as: 'alice' })).body.deleted).toBe(1);
    expect((await call('DELETE', '/assets/files?path=d/&recursive=1', { as: 'alice' })).body.deleted).toBe(2);
    expect(objects.files.size).toBe(0);
    expect((await call('DELETE', '/assets/files?path=&recursive=1', { as: 'alice' })).status).toBe(400);
  });

  it('records the box an event came from', async () => {
    const s = await createSpace();
    await call('POST', '/assets/boxes', { as: 'alice', body: { box: 'alice-box' } });
    objects.put(`${s.id}/a.txt`, 1);
    await call('POST', '/assets/files/download', { as: 'alice', box: 'alicebox', body: { path: 'a.txt' } });
    // A box (the CLI) acts for itself, on no surface.
    expect(store.eventRows.at(-1)).toMatchObject({ action: 'file.get', actorUserId: 'alice', actorInstanceId: 'alicebox', via: null, surface: null, onBehalfOfUserId: null });
    // So does the web UI.
    await call('POST', '/assets/files/download', { as: 'alice', body: { path: 'a.txt' } });
    expect(store.eventRows.at(-1)).toMatchObject({ action: 'file.get', actorInstanceId: null, surface: null, onBehalfOfUserId: null });
    const events = await call('GET', '/assets/events', { as: 'alice' });
    expect(events.body.events[1]).toMatchObject({ action: 'file.get', actorInstanceId: 'alicebox', surface: null, onBehalfOfUserId: null });
  });

  it('returns where an event came from and whom it was for, and null for older events', async () => {
    const s = await createSpace();
    // An event as every writer before spaces in Slack records it.
    await store.recordEvent({ spaceId: s.id, actorUserId: 'alice', action: 'space.rename' });
    await store.recordEvent({ spaceId: s.id, actorUserId: 'alice', action: 'slack.channel_link', surface: 'slack', onBehalfOfUserId: 'bob', note: 'linkedVia=slack_command' });
    const events = (await call('GET', '/assets/events', { as: 'alice' })).body.events;
    expect(events[0]).toMatchObject({ action: 'slack.channel_link', surface: 'slack', onBehalfOfUserId: 'bob', note: 'linkedVia=slack_command' });
    expect(events[1]).toMatchObject({ action: 'space.rename', surface: null, onBehalfOfUserId: null });
  });
});

describe('space memory (docs/space-memory.md)', () => {
  async function memorySpace() {
    const s = await createSpace();
    await call('POST', `/${s.name}/members`, { as: 'alice', body: { email: 'bob@example.com', role: 'editor' } });
    await call('POST', `/${s.name}/members`, { as: 'alice', body: { email: 'carol@example.com', role: 'viewer' } });
    await call('POST', `/${s.name}/boxes`, { as: 'alice', body: { box: 'alice-box' } });
    return s;
  }
  async function put(as: string, path: string, opts: { box?: string; note?: string; body?: Record<string, unknown> } = {}) {
    const up = await call('POST', '/assets/files/upload', { as, box: opts.box, body: { path, size: 5, contentType: 'text/markdown', ...opts.body } });
    if (up.status !== 200) return up;
    objects.put(`${store.spaces.values().next().value!.id}/${path}`, 5, 'text/markdown');
    return call('POST', '/assets/files/uploaded', { as, box: opts.box, body: { path, ...(opts.note ? { note: opts.note } : {}) } });
  }

  it('still hides a space the caller has no role in', async () => {
    await memorySpace();
    store.addUser('dave');
    expect((await call('GET', '/assets/memory', { as: 'dave' })).body.code).toBe('not_found');
  });

  it('gives the role and the last writer of each memory file, not of tools or other paths', async () => {
    await memorySpace();
    expect((await put('alice', '.termag/memory/a.md', { box: 'alicebox', note: 'first fact' })).status).toBe(200);
    expect((await put('bob', '.termag/memory/a.md')).status).toBe(200);
    expect((await put('alice', '.termag/memory/b.md')).status).toBe(200);
    expect((await put('alice', '.termag/tools/t/data.json')).status).toBe(200);
    expect((await put('alice', 'notes.md')).status).toBe(200);
    await call('DELETE', '/assets/files?path=.termag/memory/b.md&note=stale', { as: 'alice' });

    const r = await call('GET', '/assets/memory', { as: 'alice', box: 'alicebox' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(expect.objectContaining({ space: 'assets', role: 'owner', readOnly: false, writable: true, me: 'alice' }));
    expect(Object.keys(r.body.writers)).toEqual(['.termag/memory/a.md']);
    expect(r.body.writers['.termag/memory/a.md']).toEqual(expect.objectContaining({ userId: 'bob', email: 'bob@example.com', box: null }));

    const viewer = await call('GET', '/assets/memory', { as: 'carol' });
    expect(viewer.body).toEqual(expect.objectContaining({ role: 'viewer', writable: false }));
  });

  it('logs memory changes with who, which box, the S3 version and the note', async () => {
    await memorySpace();
    await put('alice', '.termag/memory/a.md', { box: 'alicebox', note: '  why\n it changed ' });
    await call('DELETE', '/assets/files?path=.termag/memory/a.md&note=wrong', { as: 'bob' });
    await put('alice', 'other.md');
    const r = await call('GET', '/assets/memory/log?since=1d', { as: 'carol' });
    expect(r.status).toBe(200);
    expect(r.body.entries).toEqual([
      expect.objectContaining({ action: 'file.rm', path: '.termag/memory/a.md', note: 'wrong', userId: 'bob', box: null }),
      expect.objectContaining({ action: 'file.put', path: '.termag/memory/a.md', note: 'why it changed', userId: 'alice', box: 'alice-box', versionId: 'v1', bytes: 5 }),
    ]);
    expect((await call('GET', '/assets/memory/log?since=soon', { as: 'carol' })).body.code).toBe('invalid_since');
  });

  it('refuses a note that is too long or holds a secret, and records nothing for it', async () => {
    await memorySpace();
    const long = await put('alice', '.termag/memory/a.md', { note: 'x'.repeat(201) });
    expect(long.body.code).toBe('invalid_note');
    const secret = await put('alice', '.termag/memory/a.md', { note: `key AKIA${'Q'.repeat(16)}` });
    expect(secret).toEqual({ status: 400, body: expect.objectContaining({ code: 'note_secret' }) });
    expect(store.eventRows.filter(e => e.action === 'file.put')).toEqual([]);
  });

  it('signs a conditional write when asked, and says so', async () => {
    const sp = await memorySpace();
    objects.put(`${sp.id}/.termag/memory/a.md`, 5);
    const current = objects.etagOf(`${sp.id}/.termag/memory/a.md`)!;
    const edit = await call('POST', '/assets/files/upload', { as: 'alice', box: 'alicebox', body: { path: '.termag/memory/a.md', size: 5, contentType: 'text/markdown', ifMatch: current } });
    expect(edit.body).toEqual(expect.objectContaining({ kind: 'single', conditional: true, headers: expect.objectContaining({ 'if-match': current }) }));
    const add = await call('POST', '/assets/files/upload', { as: 'alice', body: { path: '.termag/memory/b.md', size: 5, ifNoneMatch: '*' } });
    expect(add.body.headers['if-none-match']).toBe('*');
    const plain = await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'c.md', size: 5 } });
    expect(plain.body.conditional).toBeUndefined();
    expect((await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'd.md', size: 5, ifMatch: '"a"', ifNoneMatch: '*' } })).body.code).toBe('invalid_condition');
    expect((await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'd.md', size: 5, ifNoneMatch: 'x' } })).body.code).toBe('invalid_condition');
    // A multipart upload's condition goes again with its complete.
    const big = await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'e.bin', size: SINGLE_PUT_MAX_BYTES + 1, ifNoneMatch: '*' } });
    expect(big.body).toEqual(expect.objectContaining({ kind: 'multipart', conditional: true }));
  });

  it('lets a viewer read memory but refuses their writes', async () => {
    await memorySpace();
    expect((await call('GET', '/assets/memory', { as: 'carol' })).status).toBe(200);
    expect((await call('POST', '/assets/files/upload', { as: 'carol', body: { path: '.termag/memory/x.md', size: 5, ifNoneMatch: '*' } })).status).toBe(403);
  });
});

describe('optimistic concurrency on every file write (docs/spaces.md, "Conflicts")', () => {
  let sp: { id: string; name: string };
  const key = (p: string) => `${sp.id}/${p}`;
  beforeEach(async () => {
    sp = await createSpace();
    await call('POST', `/${sp.name}/members`, { as: 'alice', body: { email: 'bob@example.com', role: 'editor' } });
    await call('POST', `/${sp.name}/boxes`, { as: 'alice', body: { box: 'bob-box' } }).catch(() => null);
  });
  /** One whole write as a client does it: sign, the PUT lands, confirm; `cond` is what it read. */
  async function write(as: string, path: string, cond: Record<string, unknown> = {}, opts: { box?: string } = {}) {
    const up = await call('POST', '/assets/files/upload', { as, box: opts.box, body: { path, size: 5, ...cond } });
    if (up.status !== 200) return up;
    // The PUT as a client sends it: the headers the upload signed, its proof among them.
    objects.putSigned(key(path), 5, up.body.headers);
    return call('POST', '/assets/files/uploaded', { as, box: opts.box, body: { path, etag: objects.etagOf(key(path)), ...cond } });
  }

  it('a confirm can\'t name someone else\'s version as its own: 412, nothing copied, nothing recorded (Security Agent, #769)', async () => {
    await write('alice', 'a.md');
    const first = objects.etagOf(key('a.md'))!;
    expect((await write('bob', 'a.md', { ifMatch: first })).status).toBe(200);
    const bobs = objects.etagOf(key('a.md'))!;
    const versions = objects.history.get(key('a.md'))!.length;
    const puts = store.eventRows.filter(e => e.action.startsWith('file.put')).length;
    // Alice knows the current ETag and claims it as her write, with a condition it can't meet: no PUT of hers exists.
    for (const cond of [{ ifNoneMatch: '*' }, { ifMatch: '"0123456789abcdef0123456789abcdef"' }]) {
      const r = await call('POST', '/assets/files/uploaded', { as: 'alice', body: { path: 'a.md', etag: bobs, ...cond } });
      expect(r.status).toBe(412);
      expect(r.body.code).toBe('changed');
    }
    expect(objects.etagOf(key('a.md')), 'Bob\'s version stays current').toBe(bobs);
    expect(objects.history.get(key('a.md'))!.length, 'no restore copied anything').toBe(versions);
    expect(store.eventRows.filter(e => e.action.startsWith('file.put')).length).toBe(puts);
    // Even signed for the path and the condition, someone else's version isn't hers: the proof names its signer.
    const signed = await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'a.md', size: 5, ifMatch: first } });
    expect(signed.status).toBe(412);
  });

  it('a download says which version it served', async () => {
    objects.put(key('a.md'), 5);
    const r = await call('POST', '/assets/files/download', { as: 'alice', body: { path: 'a.md' } });
    expect(r.body).toEqual(expect.objectContaining({ etag: objects.etagOf(key('a.md')), versionId: 'v1' }));
  });

  it('refuses before signing a write over a newer version: 412 changed, with who wrote it and when', async () => {
    expect((await write('alice', 'a.md')).status).toBe(200);
    const read = objects.etagOf(key('a.md'))!;
    expect((await write('bob', 'a.md', { ifMatch: read })).status).toBe(200);
    const signed = objects.presigned.length;
    const r = await write('alice', 'a.md', { ifMatch: read });
    expect(r.status).toBe(412);
    expect(r.body).toEqual(expect.objectContaining({ code: 'changed', path: 'a.md', yours: read, now: objects.etagOf(key('a.md')), by: 'bob@example.com' }));
    expect(r.body.error).toMatch(/^assets:a\.md changed since you read it \(yours "[^"]+", now "[^"]+" by bob@example\.com at \d{4}-/);
    expect(objects.presigned.length, 'nothing signed').toBe(signed);
  });

  it('refuses a new file that already exists, and a write over a file removed since', async () => {
    await write('alice', 'a.md');
    expect((await write('bob', 'a.md', { ifNoneMatch: '*' })).body).toEqual(expect.objectContaining({ code: 'changed', yours: 'new' }));
    const read = objects.etagOf(key('a.md'))!;
    await call('DELETE', '/assets/files?path=a.md', { as: 'bob' });
    const gone = await write('alice', 'a.md', { ifMatch: read });
    expect(gone.status).toBe(412);
    expect(gone.body.now).toBeNull();
    expect(gone.body.error).toContain('now gone');
  });

  it('where storage ignores the condition, the confirm puts the newer version back and answers 412', async () => {
    objects.enforceConditions = false;
    await write('alice', 'a.md');
    const read = objects.etagOf(key('a.md'))!;
    // Alice signs while the file is still the version she read; Bob writes in between; then her PUT lands.
    const signed = await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'a.md', size: 5, ifMatch: read } });
    expect(signed.status).toBe(200);
    expect((await write('bob', 'a.md', { ifMatch: read })).status).toBe(200);
    const bobs = objects.etagOf(key('a.md'))!;
    const bobsVersion = objects.history.get(key('a.md'))!.at(-1)!.versionId;
    objects.putSigned(key('a.md'), 7, signed.body.headers);
    const putsBefore = store.eventRows.filter(e => e.action === 'file.put').length;
    const r = await call('POST', '/assets/files/uploaded', { as: 'alice', body: { path: 'a.md', etag: objects.etagOf(key('a.md')), ifMatch: read } });
    expect(r.status).toBe(412);
    expect(r.body).toEqual(expect.objectContaining({ code: 'changed', yours: read, by: 'bob@example.com' }));
    // Bob's version is current again (a copy of it), and Alice's bytes stay in the history only.
    expect(objects.files.get(key('a.md'))!.size).toBe(5);
    const history = objects.history.get(key('a.md'))!;
    expect(history.at(-2)!.size).toBe(7);
    expect(history.find(v => v.versionId === bobsVersion)).toBeTruthy();
    expect(store.eventRows.filter(e => e.action === 'file.put').length, 'her write is not recorded').toBe(putsBefore);
    // The restore is: who wrote over whom, and that their version was put back.
    expect(store.eventRows.at(-1)).toEqual(expect.objectContaining({ action: 'file.put.reverted', path: 'a.md' }));
    // The 412 names the version that is current now, the restored copy, and open views hear of it (Bugbot, #769).
    const restored = objects.etagOf(key('a.md'))!;
    expect(restored).not.toBe(bobs);
    expect(r.body.now).toBe(restored);
    expect(fileChanges.at(-1)).toEqual(expect.objectContaining({ kind: 'put', path: 'a.md', etag: restored }));
  });

  it('a restore never clobbers a write that lands after the check: the copy is conditional on ours being current (Bugbot, #769)', async () => {
    objects.enforceConditions = false;
    await write('alice', 'a.md');
    const read = objects.etagOf(key('a.md'))!;
    const signed = await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'a.md', size: 5, ifMatch: read } });
    expect((await write('bob', 'a.md', { ifMatch: read })).status).toBe(200);
    objects.putSigned(key('a.md'), 7, signed.body.headers);
    // Carol's write lands between the versions the confirm read and its copy.
    objects.beforeRestore = () => { objects.put(key('a.md'), 11); };
    const r = await call('POST', '/assets/files/uploaded', { as: 'alice', body: { path: 'a.md', etag: objects.etagOf(key('a.md')), ifMatch: read } });
    objects.beforeRestore = null;
    expect(r.status).toBe(412);
    expect(objects.files.get(key('a.md'))!.size, 'Carol\'s write stays current').toBe(11);
    expect(r.body.now).toBe(objects.etagOf(key('a.md')));
    expect(store.eventRows.some(e => e.action === 'file.put.reverted')).toBe(false);
  });

  it('where storage ignores it, a new file that someone else created first is put back as theirs', async () => {
    objects.enforceConditions = false;
    const signed = await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'n.md', size: 5, ifNoneMatch: '*' } });
    expect(signed.status).toBe(200);
    expect((await write('bob', 'n.md')).status).toBe(200);
    objects.putSigned(key('n.md'), 9, signed.body.headers);
    const r = await call('POST', '/assets/files/uploaded', { as: 'alice', body: { path: 'n.md', etag: objects.etagOf(key('n.md')), ifNoneMatch: '*' } });
    expect(r.status).toBe(412);
    expect(objects.files.get(key('n.md'))!.size).toBe(5);
  });

  it('on a store without version history, a confirmed write stays: the confirm never deletes the only version (Bugbot sweep 12)', async () => {
    objects.versioned = false;
    objects.enforceConditions = false;
    await write('alice', 'a.md');
    const read = objects.etagOf(key('a.md'))!;
    const r = await write('alice', 'a.md', { ifMatch: read });
    expect(r.status).toBe(200);
    expect(objects.files.has(key('a.md'))).toBe(true);
    const fresh = await write('alice', 'new.md', { ifNoneMatch: '*' });
    expect(fresh.status).toBe(200);
    expect(objects.files.has(key('new.md'))).toBe(true);
  });

  it('a confirm sent again (a retry) passes, and changes nothing', async () => {
    await write('alice', 'a.md');
    const read = objects.etagOf(key('a.md'))!;
    expect((await write('alice', 'a.md', { ifMatch: read })).status).toBe(200);
    const ours = objects.etagOf(key('a.md'))!;
    const again = await call('POST', '/assets/files/uploaded', { as: 'alice', body: { path: 'a.md', etag: ours, ifMatch: read } });
    expect(again.status).toBe(200);
    expect(objects.etagOf(key('a.md'))).toBe(ours);
  });

  it('confirms a write on the version it expected, and answers its new version', async () => {
    await write('alice', 'a.md');
    const read = objects.etagOf(key('a.md'))!;
    const r = await write('alice', 'a.md', { ifMatch: read });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(expect.objectContaining({ ok: true, etag: objects.etagOf(key('a.md')), versionId: 'v2' }));
  });

  it('checks a multipart upload at its complete', async () => {
    await write('alice', 'big.bin');
    const read = objects.etagOf(key('big.bin'))!;
    const up = await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'big.bin', size: SINGLE_PUT_MAX_BYTES + 1, ifMatch: read } });
    expect(up.body.conditional).toBe(true);
    await write('bob', 'big.bin');
    const r = await call('POST', `/assets/uploads/${up.body.uploadId}/complete`, { as: 'alice', body: { path: 'big.bin', parts: [{ partNumber: 1, etag: '"p1"' }], ifMatch: read } });
    expect(r.status).toBe(412);
    expect(r.body.code).toBe('changed');
  });

  it('checks a file move\'s source version and a new destination; a folder move checks none', async () => {
    await write('alice', 'a.md');
    const read = objects.etagOf(key('a.md'))!;
    await write('bob', 'a.md');
    expect((await call('POST', '/assets/files/move', { as: 'alice', body: { from: 'a.md', to: 'b.md', ifMatch: read } })).status).toBe(412);
    expect(objects.files.has(key('b.md'))).toBe(false);
    const now = objects.etagOf(key('a.md'))!;
    await write('alice', 'c.md');
    expect((await call('POST', '/assets/files/move', { as: 'alice', body: { from: 'a.md', to: 'c.md', ifMatch: now, ifNoneMatch: '*' } })).body.code).toBe('changed');
    expect((await call('POST', '/assets/files/move', { as: 'alice', body: { from: 'a.md', to: 'b.md', ifMatch: now } })).status).toBe(200);
    expect(objects.copies.at(-1)).toEqual({ from: key('a.md'), to: key('b.md'), sourceIfMatch: now });
    expect((await call('POST', '/assets/files/move', { as: 'alice', body: { from: 'dir/', to: 'other/', ifMatch: now } })).body.code).toBe('invalid_condition');
  });

  it('checks a single file\'s delete; a folder delete checks none', async () => {
    await write('alice', 'a.md');
    const read = objects.etagOf(key('a.md'))!;
    await write('bob', 'a.md');
    const r = await call('DELETE', `/assets/files?path=a.md&ifMatch=${encodeURIComponent(read)}`, { as: 'alice' });
    expect(r.status).toBe(412);
    expect(objects.files.has(key('a.md'))).toBe(true);
    expect((await call('DELETE', `/assets/files?path=a.md&ifMatch=${encodeURIComponent(objects.etagOf(key('a.md'))!)}`, { as: 'alice' })).status).toBe(200);
    expect((await call('DELETE', `/assets/files?path=dir/&recursive=1&ifMatch=${encodeURIComponent(read)}`, { as: 'alice' })).body.code).toBe('invalid_condition');
  });

  it('a write with no condition is unconditional, as before', async () => {
    await write('alice', 'a.md');
    await write('bob', 'a.md');
    expect((await write('alice', 'a.md')).status).toBe(200);
  });
});

describe('sharing a file', () => {
  let s: { id: string; name: string };
  const share = (as: string, path = 'docs/a.md', box?: string) => call('PUT', '/assets/files/share', { as, box, body: { path } });
  const unshare = (as: string, path = 'docs/a.md', box?: string) => call('DELETE', `/assets/files/share?path=${encodeURIComponent(path)}`, { as, box });

  beforeEach(async () => {
    s = await createSpace();
    objects.put(`${s.id}/docs/a.md`, 1, 'text/markdown');
    objects.put(`${s.id}/docs/b.md`, 1, 'text/markdown');
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'viewer' } });
  });

  it('shares and unshares one file, once each in the audit, and shows it in the view and the tree', async () => {
    expect((await share('alice')).body).toMatchObject({ shared: true, sharedBy: { displayName: 'alice' } });
    expect((await share('alice')).status).toBe(200);
    const viewed = await call('POST', '/assets/files/download', { as: 'alice', body: { path: 'docs/a.md', view: true } });
    expect(viewed.body.share).toMatchObject({ shared: true, canShare: true });
    const tree = await call('GET', '/assets/tree?prefix=docs/', { as: 'alice' });
    expect(tree.body.files.map((f: { path: string; shared?: boolean }) => [f.path, f.shared ?? false])).toEqual([['docs/a.md', true], ['docs/b.md', false]]);
    expect((await unshare('alice')).body).toEqual({ shared: false });
    expect((await unshare('alice')).status).toBe(200);
    expect(store.eventRows.filter(e => e.action.startsWith('file.') && e.action.includes('share')).map(e => [e.action, e.path]))
      .toEqual([['file.share', 'docs/a.md'], ['file.unshare', 'docs/a.md']]);
  });

  it('refuses a viewer, a read-only space, a missing file and a folder', async () => {
    expect((await share('bob')).status).toBe(403);
    const viewed = await call('POST', '/assets/files/download', { as: 'bob', body: { path: 'docs/a.md', view: true } });
    expect(viewed.body.share).toEqual({ shared: false, canShare: false });
    expect((await share('alice', 'docs/nope.md')).body.code).toBe('file_not_found');
    expect((await share('alice', 'docs/')).status).toBe(400);
    store.spaces.get(s.id)!.readOnlyAt = new Date();
    expect((await share('alice')).body.code).toBe('read_only');
    expect(store.shareRows).toEqual([]);
  });

  describe('from a box', () => {
    beforeEach(async () => {
      await call('POST', '/assets/boxes', { as: 'alice', body: { box: 'alice-box' } });
      objects.put(`${s.id}/notes.md`, 1, 'text/markdown');
    });

    it('shares and unshares any file, as its owner, with the box in the audit', async () => {
      expect((await share('alice', 'docs/a.md', 'alicebox')).body).toMatchObject({ shared: true, sharedBy: { displayName: 'alice' } });
      expect((await share('alice', 'notes.md', 'alicebox')).status).toBe(200);
      expect(store.shareRows.map(r => [r.path, r.sharedById])).toEqual([['docs/a.md', 'alice'], ['notes.md', 'alice']]);
      expect((await unshare('alice', 'notes.md', 'alicebox')).body).toEqual({ shared: false });
      expect(store.shareRows.map(r => r.path)).toEqual(['docs/a.md']);
      expect(store.eventRows.filter(e => e.action.includes('share')).map(e => [e.action, e.path, e.actorUserId, e.actorInstanceId]))
        .toEqual([
          ['file.share', 'docs/a.md', 'alice', 'alicebox'],
          ['file.share', 'notes.md', 'alice', 'alicebox'],
          ['file.unshare', 'notes.md', 'alice', 'alicebox'],
        ]);
      const viewed = await call('POST', '/assets/files/download', { as: 'alice', box: 'alicebox', body: { path: 'docs/a.md', view: true } });
      expect(viewed.body.share).toMatchObject({ shared: true, canShare: true });
    });

    it('unshares a file a person shared, as a person can', async () => {
      await share('alice', 'notes.md');
      expect((await unshare('alice', 'notes.md', 'alicebox')).body).toEqual({ shared: false });
      expect(store.shareRows).toEqual([]);
    });

    it('keeps every other check: editor, a box with access, a read-only space, a missing file, the kill switch', async () => {
      await call('PATCH', '/assets/members/bob', { as: 'alice', body: { role: 'editor' } });
      expect((await call('POST', '/assets/boxes', { as: 'bob', body: { box: 'bob-box' } })).status).toBe(201);
      await call('PATCH', '/assets/members/bob', { as: 'alice', body: { role: 'viewer' } });
      expect((await call('GET', '/assets/tree', { as: 'bob', box: 'bobbox' })).status).toBe(200);
      expect((await share('bob', 'notes.md', 'bobbox')).body.code).toBe('forbidden');
      expect((await unshare('bob', 'notes.md', 'bobbox')).status).toBe(403);
      store.addBox('stray', 'alice', 'stray-box');
      expect((await share('alice', 'notes.md', 'stray')).status).toBe(404);
      expect((await share('alice', 'nope.md', 'alicebox')).body.code).toBe('file_not_found');
      process.env.SPACE_FILE_SHARING_DISABLED = '1';
      try {
        expect((await share('alice', 'notes.md', 'alicebox')).body.code).toBe('sharing_off');
      } finally {
        delete process.env.SPACE_FILE_SHARING_DISABLED;
      }
      store.spaces.get(s.id)!.readOnlyAt = new Date();
      expect((await share('alice', 'notes.md', 'alicebox')).body.code).toBe('read_only');
      expect(store.shareRows).toEqual([]);
    });

    it('lets a non-member open the file it shared through the link, until the box unshares it', async () => {
      const link = `${origin}/termag/files/assets/notes.md`;
      const open = () => fetch(link, { headers: { 'x-user': 'carol' }, redirect: 'manual' });
      expect((await open()).status).toBe(404);
      await share('alice', 'notes.md', 'alicebox');
      const r = await open();
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(`https://s3.test/get/${s.id}/notes.md`);
      expect(store.eventRows.filter(e => e.action === 'file.get').at(-1)).toMatchObject({ actorUserId: 'carol', via: 'share', path: 'notes.md' });
      await unshare('alice', 'notes.md', 'alicebox');
      expect((await open()).status).toBe(404);
    });
  });

  it('refuses a new share with the kill switch on, but still lets a file be made private', async () => {
    await share('alice');
    process.env.SPACE_FILE_SHARING_DISABLED = '1';
    try {
      expect((await share('alice', 'docs/b.md')).body.code).toBe('sharing_off');
      expect((await unshare('alice')).body).toEqual({ shared: false });
    } finally {
      delete process.env.SPACE_FILE_SHARING_DISABLED;
    }
  });

  it('drops the share when the file is deleted or moved, so the new path starts private', async () => {
    objects.put(`${s.id}/c.md`, 1, 'text/markdown');
    await share('alice');
    await share('alice', 'docs/b.md');
    await share('alice', 'c.md');
    await call('POST', '/assets/files/move', { as: 'alice', body: { from: 'docs/', to: 'old/' } });
    expect([...await store.sharedPaths(s.id)]).toEqual(['c.md']);
    await call('DELETE', '/assets/files?path=c.md', { as: 'alice' });
    expect(store.shareRows).toEqual([]);
  });
});
