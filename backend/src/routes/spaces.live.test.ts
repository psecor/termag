// The spaces router's live-file side: a change
// for every put, move and remove, and the file version the view checks once
// on open and after a missed frame.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { spacesRouter } from './spaces';
import { MemorySpaceObjects, MemorySpaceStore } from '../services/spaces/spacesTestkit';
import type { FileChange } from '../services/spaces/spaceFileBus';

let store: MemorySpaceStore;
let objects: MemorySpaceObjects;
let changes: FileChange[];
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const liveStore = new Proxy({}, { get: (_t, prop) => (store as unknown as Record<string | symbol, unknown>)[prop] && ((...args: unknown[]) => (store as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[prop](...args)) });
  app.use('/api/spaces', spacesRouter({
    store: liveStore as MemorySpaceStore,
    objects: async () => objects,
    enabled: async () => true,
    sharing: async () => true,
    onFileChange: c => { changes.push(c); },
    caller: r => {
      const user = r.get('x-user');
      const box = r.get('x-box');
      return user ? (box ? { kind: 'box', userId: user, instanceId: box } : { kind: 'user', userId: user }) : null;
    },
  }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/spaces`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

beforeEach(() => {
  store = new MemorySpaceStore();
  objects = new MemorySpaceObjects();
  changes = [];
  store.addUser('alice');
  store.addUser('bob');
  store.addBox('alicebox', 'alice', 'alice-box');
});

async function call(method: string, path: string, opts: { as?: string; box?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (opts.as) headers['x-user'] = opts.as;
  if (opts.box) headers['x-box'] = opts.box;
  const res = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

async function createSpace(name = 'assets') {
  const r = await call('POST', '/', { as: 'alice', body: { name } });
  expect(r.status).toBe(201);
  return r.body.space as { id: string; name: string };
}

describe('a change for each file write', () => {
  it('a confirmed single PUT is a put with its new version, signing alone is nothing, and a repeat confirm is nothing', async () => {
    const s = await createSpace();
    expect((await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'pr-outbox.md', size: 5 } })).status).toBe(200);
    expect(changes).toEqual([]);
    objects.put(`${s.id}/pr-outbox.md`, 5, 'text/markdown');
    await call('POST', '/assets/files/uploaded', { as: 'alice', body: { path: 'pr-outbox.md' } });
    await call('POST', '/assets/files/uploaded', { as: 'alice', body: { path: 'pr-outbox.md' } });
    expect(changes).toEqual([{ spaceId: s.id, kind: 'put', path: 'pr-outbox.md', etag: objects.etagOf(`${s.id}/pr-outbox.md`) }]);
  });

  it('a box\'s put is a change too', async () => {
    const s = await createSpace();
    await call('POST', '/assets/boxes', { as: 'alice', body: { box: 'alice-box' } });
    objects.put(`${s.id}/notes.md`, 3);
    expect((await call('POST', '/assets/files/uploaded', { as: 'alice', box: 'alicebox', body: { path: 'notes.md' } })).status).toBe(200);
    expect(changes).toMatchObject([{ kind: 'put', path: 'notes.md' }]);
  });

  it('a completed multipart upload is a put', async () => {
    const s = await createSpace();
    const up = await call('POST', '/assets/files/upload', { as: 'alice', body: { path: 'big.bin', size: 65 * 1024 * 1024 } });
    await call('POST', `/assets/uploads/${up.body.uploadId}/complete`, { as: 'alice', body: { path: 'big.bin', parts: [{ partNumber: 1, etag: 'x' }] } });
    expect(changes).toEqual([{ spaceId: s.id, kind: 'put', path: 'big.bin', etag: objects.etagOf(`${s.id}/big.bin`) }]);
  });

  it('a move of a file and of a folder', async () => {
    const s = await createSpace();
    objects.put(`${s.id}/a.txt`, 1);
    objects.put(`${s.id}/d/x.txt`, 2);
    await call('POST', '/assets/files/move', { as: 'alice', body: { from: 'a.txt', to: 'b.txt' } });
    await call('POST', '/assets/files/move', { as: 'alice', body: { from: 'd/', to: 'z/' } });
    expect(changes).toEqual([
      { spaceId: s.id, kind: 'mv', path: 'a.txt', to: 'b.txt' },
      { spaceId: s.id, kind: 'mv', path: 'd/', to: 'z/' },
    ]);
  });

  it('a remove of a file and of a folder', async () => {
    const s = await createSpace();
    objects.put(`${s.id}/a.txt`, 1);
    objects.put(`${s.id}/d/x.txt`, 2);
    await call('DELETE', '/assets/files?path=a.txt', { as: 'alice' });
    await call('DELETE', '/assets/files?path=d/&recursive=1', { as: 'alice' });
    expect(changes).toEqual([{ spaceId: s.id, kind: 'rm', path: 'a.txt' }, { spaceId: s.id, kind: 'rm', path: 'd/' }]);
  });

  it('a refused write is no change', async () => {
    const s = await createSpace();
    objects.put(`${s.id}/a.txt`, 1);
    await call('POST', '/assets/members', { as: 'alice', body: { email: 'bob@example.com', role: 'viewer' } });
    expect((await call('DELETE', '/assets/files?path=a.txt', { as: 'bob' })).status).toBe(403);
    expect((await call('DELETE', '/assets/files?path=nope.txt', { as: 'alice' })).status).toBe(404);
    expect(changes).toEqual([]);
  });
});

describe('GET /:space/files/head', () => {
  it('answers the version with an ETag, and 304 while If-None-Match still matches', async () => {
    const s = await createSpace();
    objects.put(`${s.id}/pr-outbox.md`, 5);
    const first = await call('GET', '/assets/files/head?path=pr-outbox.md', { as: 'alice' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ path: 'pr-outbox.md', size: 5, etag: objects.etagOf(`${s.id}/pr-outbox.md`) });
    expect(first.headers.get('etag')).toBe(first.body.etag);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const same = await call('GET', '/assets/files/head?path=pr-outbox.md', { as: 'alice', headers: { 'if-none-match': first.body.etag } });
    expect(same.status).toBe(304);
    expect(same.body).toBeNull();
    objects.put(`${s.id}/pr-outbox.md`, 9);
    const changed = await call('GET', '/assets/files/head?path=pr-outbox.md', { as: 'alice', headers: { 'if-none-match': first.body.etag } });
    expect(changed.status).toBe(200);
    expect(changed.body.etag).not.toBe(first.body.etag);
  });

  it('is a 404 for a removed file and for someone outside the space', async () => {
    const s = await createSpace();
    objects.put(`${s.id}/a.md`, 1);
    expect((await call('GET', '/assets/files/head?path=gone.md', { as: 'alice' })).body.code).toBe('file_not_found');
    expect((await call('GET', '/assets/files/head?path=a.md', { as: 'bob' })).body.code).toBe('not_found');
  });

  it('records nothing and changes nothing', async () => {
    const s = await createSpace();
    objects.put(`${s.id}/a.md`, 1);
    const before = store.eventRows.length;
    await call('GET', '/assets/files/head?path=a.md', { as: 'alice' });
    expect(store.eventRows.length).toBe(before);
    expect(changes).toEqual([]);
  });
});
