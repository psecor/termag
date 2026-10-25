import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { spaceCallerFromCli, spacesRouter, SINGLE_PUT_MAX_BYTES } from './spaces';
import { spaceFileLinkPath } from '../services/spaces/spaceLinks';
import { SpacesUnavailableError } from '../services/spaces/spaceConfig';
import { MemorySpaceObjects, MemorySpaceStore } from '../services/spaces/spacesTestkit';
import { sweepSpaces } from '../services/spaces/spaceSweeper';
import type { SpaceCaller } from '../services/spaces/spaceAccess';
import type { PresignerIdentity } from '../services/spaces/spaceObjects';

let store: MemorySpaceStore;
let objects: MemorySpaceObjects;
let enabled: Set<string>;
let sharing: Set<string>;
let unavailable = false;
let identities: PresignerIdentity[];
let server: Server;
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
    enabled: async userId => enabled.has(userId),
    sharing: async userId => sharing.has(userId),
    caller: r => {
      const user = r.get('x-user');
      if (!user) return null;
      const box = r.get('x-box');
      return (box ? { kind: 'box', userId: user, instanceId: box } : { kind: 'user', userId: user }) satisfies SpaceCaller;
    },
    fileLink: (space, path) => `https://ui.example${spaceFileLinkPath('/termag', space, path)}`,
  }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/spaces`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

beforeEach(() => {
  store = new MemorySpaceStore();
  objects = new MemorySpaceObjects();
  enabled = new Set(['alice', 'bob', 'carol']);
  sharing = new Set(['alice', 'bob', 'carol']);
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

describe('the flag and authentication', () => {
  it('answers 401 with no caller', async () => {
    expect((await call('GET', '/')).status).toBe(401);
  });

  it('answers 404 on every route while spaces-enabled is off for the user', async () => {
    await createSpace();
    enabled.delete('alice');
    expect((await call('GET', '/', { as: 'alice' })).status).toBe(404);
    expect((await call('GET', '/assets', { as: 'alice' })).status).toBe(404);
    expect((await call('POST', '/', { as: 'alice', body: { name: 'other' } })).status).toBe(404);
  });

  it('checks the flag for a box\'s owner', async () => {
    const s = await createSpace();
    await call('POST', `/${s.name}/boxes`, { as: 'alice', body: { box: 'alice-box' } });
    expect((await call('GET', '/', { as: 'alice', box: 'alicebox' })).body.spaces).toHaveLength(1);
    enabled.delete('alice');
    expect((await call('GET', '/', { as: 'alice', box: 'alicebox' })).status).toBe(404);
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

  it('refuses adding a member or an invite while spaces-sharing-enabled is off for the owner', async () => {
    await createSpace();
    sharing.delete('alice');
    const created = await call('POST', '/', { as: 'alice', body: { name: 'solo' } });
    expect(created.body.sharing).toBe(false);
    expect((await call('GET', '/assets/members', { as: 'alice' })).body).toEqual(expect.objectContaining({ sharing: false }));
    for (const email of ['bob@example.com', 'dave@example.com']) {
      const r = await call('POST', '/assets/members', { as: 'alice', body: { email, role: 'viewer' } });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('sharing_disabled');
    }
    expect((await call('GET', '/assets/members', { as: 'alice' })).body).toEqual(expect.objectContaining({
      members: [expect.objectContaining({ userId: 'alice', role: 'owner' })], invites: [],
    }));
    expect((await call('POST', '/assets/boxes', { as: 'alice', body: { box: 'alice-box' } })).status).toBe(201);
    expect((await call('POST', '/assets/members', { as: 'bob', body: { email: 'carol@example.com', role: 'viewer' } })).status).toBe(404);
  });

  it('adds a signed-in user at once and an unknown email as a pending invite', async () => {
    await createSpace();
    const added = await call('POST', '/assets/members', { as: 'alice', body: { email: 'BOB@example.com', role: 'viewer' } });
    expect(added.body.member).toMatchObject({ userId: 'bob', role: 'viewer' });
    expect((await call('GET', '/', { as: 'bob' })).body.spaces[0].role).toBe('viewer');

    const invited = await call('POST', '/assets/members', { as: 'alice', body: { email: 'dave@example.com', role: 'editor' } });
    expect(invited.body.invite).toMatchObject({ email: 'dave@example.com', role: 'editor' });
    store.addUser('dave');
    enabled.add('dave');
    expect((await call('GET', '/', { as: 'dave' })).body.spaces[0]).toMatchObject({ name: 'assets', role: 'editor' });
    expect(store.inviteRows).toEqual([]);
  });

  it('claims an invite when a space is opened by name first', async () => {
    await createSpace();
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'dave@example.com', role: 'viewer' } });
    store.addUser('dave');
    enabled.add('dave');
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
    expect(store.eventRows.at(-1)).toMatchObject({ action: 'file.get', actorUserId: 'alice', actorInstanceId: 'alicebox', via: null });
    const events = await call('GET', '/assets/events', { as: 'alice' });
    expect(events.body.events[0]).toMatchObject({ action: 'file.get', actorInstanceId: 'alicebox' });
  });
});
