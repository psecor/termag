import { beforeEach, describe, expect, it } from 'vitest';
import { SpaceOpError, declaredSize, preconditionFailed, proofCaller, spaceFileOps, type SpaceFileOps } from './spaceFileOps';
import { MemorySpaceObjects, MemorySpaceStore } from './spacesTestkit';
import type { PresignerIdentity } from './spaceObjects';
import { objectKey } from './spacePaths';
import type { SpaceRecord } from './spaceStore';
import type { FileChange } from './spaceFileBus';

let store: MemorySpaceStore;
let objects: MemorySpaceObjects;
let identities: PresignerIdentity[];
let changes: FileChange[];
let ops: SpaceFileOps;
let space: SpaceRecord;

const alice = { kind: 'user', userId: 'alice' } as const;
const bob = { kind: 'user', userId: 'bob' } as const;
const aliceBox = { kind: 'box', userId: 'alice', instanceId: 'alicebox' } as const;

async function refusal(p: Promise<unknown> | (() => unknown)): Promise<SpaceOpError> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    expect(err).toBeInstanceOf(SpaceOpError);
    return err as SpaceOpError;
  }
  throw new Error('expected a refusal');
}

beforeEach(async () => {
  store = new MemorySpaceStore();
  objects = new MemorySpaceObjects();
  identities = [];
  changes = [];
  store.addUser('alice');
  store.addUser('bob');
  store.addUser('carol');
  store.addBox('alicebox', 'alice', 'alice-box');
  ops = spaceFileOps({
    store,
    objects: async identity => { identities.push(identity); return objects; },
    onFileChange: c => { changes.push(c); },
    uploadSecret: () => 'test-secret',
  });
  space = await store.createSpace({ name: 'assets', description: null, userId: 'alice' });
  await store.addMember({ spaceId: space.id, email: 'bob@example.com', role: 'viewer', addedById: 'alice' });
});

describe('load', () => {
  it('loads a space by name for a member with the role it needs', async () => {
    const loaded = await ops.load(alice, 'assets', 'owner');
    expect(loaded.space.id).toBe(space.id);
    expect(loaded.access.role).toBe('owner');
  });

  it('is a 404 for a non-member and a missing space, so names do not leak', async () => {
    expect((await refusal(ops.load({ kind: 'user', userId: 'carol' }, 'assets', 'viewer'))).status).toBe(404);
    expect((await refusal(ops.load(alice, 'nope', 'viewer'))).code).toBe('not_found');
  });

  it('is a 403 for a member below the role', async () => {
    const err = await refusal(ops.load(bob, 'assets', 'editor'));
    expect([err.status, err.code, err.message]).toEqual([403, 'forbidden', 'You are a viewer of assets; this needs editor']);
  });

  it('claims a pending invite and looks again', async () => {
    await store.addMember({ spaceId: space.id, email: 'dave@example.com', role: 'editor', addedById: 'alice' });
    store.addUser('dave');
    expect((await ops.load({ kind: 'user', userId: 'dave' }, 'assets', 'editor')).access.role).toBe('editor');
  });

  it('gives a box no access until it is added', async () => {
    expect((await refusal(ops.load(aliceBox, 'assets', 'viewer'))).status).toBe(404);
    await store.addGrant(space.id, 'alicebox', 'alice');
    expect((await ops.load(aliceBox, 'assets', 'viewer')).access.boxAccess?.kind).toBe('explicit');
  });
});

describe('objectsFor', () => {
  it('signs as the person, or as the box with its owner', async () => {
    await ops.objectsFor(alice);
    await ops.objectsFor(aliceBox);
    expect(identities).toEqual([
      { kind: 'user', userId: 'alice', email: 'alice@example.com' },
      { kind: 'box', instanceId: 'alicebox', name: 'alice-box', ownerUserId: 'alice', ownerEmail: 'alice@example.com' },
    ]);
  });
});

describe('event', () => {
  it('records the explicit caller and sends a file change, keeping the etag out of the row', async () => {
    await store.addGrant(space.id, 'alicebox', 'alice');
    const loaded = await ops.load(aliceBox, 'assets', 'viewer');
    await ops.event({ caller: aliceBox }, loaded.space, loaded.access, 'file.put', { path: 'a.txt', bytes: 3, etag: '"e1"' });
    const row = store.eventRows.at(-1)!;
    expect(row).toMatchObject({ spaceId: space.id, actorUserId: 'alice', actorInstanceId: 'alicebox', action: 'file.put', path: 'a.txt', bytes: 3 });
    expect(row).not.toHaveProperty('etag');
    expect(changes).toEqual([expect.objectContaining({ path: 'a.txt', etag: '"e1"' })]);
  });

  it('accepts a surface and on-behalf-of user, and stores them', async () => {
    const { access } = await ops.load(alice, 'assets', 'editor');
    await ops.event({ caller: alice, surface: 'slack', onBehalfOfUserId: 'bob' }, space, access, 'file.rm', { path: 'x' });
    expect(store.eventRows.at(-1)).toMatchObject({ actorUserId: 'alice', action: 'file.rm', path: 'x', surface: 'slack', onBehalfOfUserId: 'bob' });
    // The web UI and the CLI name no surface: both are stored as null.
    await ops.event({ caller: alice }, space, access, 'file.rm', { path: 'y' });
    expect(store.eventRows.at(-1)).toMatchObject({ path: 'y', surface: null, onBehalfOfUserId: null });
  });
});

describe('quota', () => {
  it('checks a declared size against the file limit and the quota', async () => {
    expect(declaredSize(10)).toBe(10);
    expect((await refusal(() => declaredSize(-1))).code).toBe('invalid_size');
    expect((await refusal(() => declaredSize(6 * 1024 ** 3))).code).toBe('file_too_large');
    expect(ops.checkDeclaredSize(space, 10)).toBe(10);
    const full = { ...space, usedBytes: space.quotaBytes };
    expect((await refusal(() => ops.checkQuota(full, 1))).status).toBe(413);
  });

  it('charges bytes, and refuses past the quota', async () => {
    await ops.charge(space, 100, 60, null);
    expect(store.spaces.get(space.id)!.usedBytes).toBe(100n);
    const err = await refusal(ops.charge(space, Number(space.quotaBytes), 60, null));
    expect(err.code).toBe('quota_exceeded');
  });
});

describe('recordPut', () => {
  it('is a 409 when nothing was uploaded, and records a stored put once', async () => {
    const loaded = await ops.load(alice, 'assets', 'editor');
    expect((await refusal(ops.recordPut({ caller: alice }, loaded, 'a.txt', objects))).code).toBe('not_uploaded');
    objects.put(objectKey(space.id, 'a.txt'), 5, 'text/plain', new Date(Date.now() - 1000));
    await ops.recordPut({ caller: alice }, loaded, 'a.txt', objects, 'why');
    await ops.recordPut({ caller: alice }, loaded, 'a.txt', objects);
    expect(store.eventRows.filter(e => e.action === 'file.put')).toEqual([expect.objectContaining({ path: 'a.txt', bytes: 5, note: 'why' })]);
  });
});

describe('refuseIfChanged', () => {
  it('passes a matching version and is a 412 naming the last writer otherwise', async () => {
    const loaded = await ops.load(alice, 'assets', 'editor');
    await ops.refuseIfChanged(loaded, 'a.txt', { ifNoneMatch: '*' }, null);
    await ops.event({ caller: alice }, space, loaded.access, 'file.put', { path: 'a.txt', bytes: 1 });
    const err = await refusal(ops.refuseIfChanged(loaded, 'a.txt', { ifNoneMatch: '*' }, { etag: '"e2"' }));
    expect(err.status).toBe(412);
    expect(err.code).toBe('changed');
  });
});

describe('checkLanded', () => {
  it('does nothing for an unconditional write', async () => {
    const loaded = await ops.load(alice, 'assets', 'editor');
    await ops.checkLanded({ caller: alice }, loaded, 'a.txt', objects, null, null);
  });
});

describe('helpers', () => {
  it('names a proof caller and recognises a storage 412', () => {
    expect(proofCaller(alice)).toBe('alice');
    expect(proofCaller(aliceBox)).toBe('alice/alicebox');
    expect(preconditionFailed({ $metadata: { httpStatusCode: 412 } })).toBe(true);
    expect(preconditionFailed({ name: 'PreconditionFailed' })).toBe(true);
    expect(preconditionFailed(new Error('x'))).toBe(false);
  });
});
