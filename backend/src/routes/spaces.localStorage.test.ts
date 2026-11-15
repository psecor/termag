import express from 'express';
import { mkdtempSync, rmSync } from 'fs';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LocalSpaceObjects } from '../services/spaces/localSpaceObjects';
import { MemorySpaceStore } from '../services/spaces/spacesTestkit';
import type { SpaceCaller } from '../services/spaces/spaceAccess';
import { spaceStorageRouter } from './spaceStorage';
import { spacesRouter } from './spaces';

// The spaces API over local storage, as index.ts wires it with SPACES_STORAGE=local:
// every byte goes through the URLs the API hands out, as a client's would.

let store: MemorySpaceStore;
let objects: LocalSpaceObjects;
let root: string;
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use('/termag/api/space-storage', (req, res, next) => spaceStorageRouter(objects)(req, res, next));
  app.use(express.json());
  app.use('/termag/api/spaces', spacesRouter({
    store: new Proxy({}, { get: (_t, prop) => (...args: unknown[]) => (store as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[prop](...args) }) as MemorySpaceStore,
    objects: async () => objects,
    caller: r => (r.get('x-user') ? { kind: 'user', userId: r.get('x-user')! } satisfies SpaceCaller : null),
    fileLink: (space, path) => `https://ui.example/termag/files/${space}/${path}`,
  }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/termag/api`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

beforeEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), 'spaces-local-'));
  objects = new LocalSpaceObjects({ root, baseUrl: `${base}/space-storage`, secret: 'test-secret' });
  store = new MemorySpaceStore();
  store.addUser('alice');
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/spaces${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-user': 'alice' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** What the CLI's `termag space put` does for a small file. */
async function upload(path: string, content: string, contentType: string, condition: Record<string, string> = {}) {
  const start = await call('POST', '/assets/files/upload', { path, size: Buffer.byteLength(content), contentType, ...condition });
  expect(start.status).toBe(200);
  const put = await fetch(start.body.url, { method: 'PUT', headers: start.body.headers, body: content });
  if (put.status !== 200) return { status: put.status, etag: null };
  const done = await call('POST', '/assets/files/uploaded', { path, ...condition, ...(put.headers.get('etag') ? { etag: put.headers.get('etag') } : {}) });
  return { status: done.status, etag: put.headers.get('etag'), body: done.body };
}

async function download(path: string) {
  const r = await call('POST', '/assets/files/download', { path });
  expect(r.status).toBe(200);
  return (await fetch(r.body.url)).text();
}

describe('spaces on local storage', () => {
  beforeEach(async () => {
    expect((await call('POST', '/', { name: 'assets' })).status).toBe(201);
  });

  it('uploads, lists and downloads through the signed URLs', async () => {
    const up = await upload('notes/a.json', '{"hello":1}', 'application/json');
    expect(up.status).toBe(200);
    expect(up.body.size).toBe(11);
    const tree = await call('GET', '/assets/tree?prefix=notes/');
    expect(JSON.stringify(tree.body)).toContain('a.json');
    expect(await download('notes/a.json')).toBe('{"hello":1}');
  });

  it('refuses a write over a version someone replaced after the URL was signed', async () => {
    const first = await upload('a.txt', 'one', 'text/plain');
    const start = await call('POST', '/assets/files/upload', { path: 'a.txt', size: 3, contentType: 'text/plain', ifMatch: first.etag });
    expect(start.status).toBe(200);
    expect((await upload('a.txt', 'two', 'text/plain')).status).toBe(200);
    const late = await fetch(start.body.url, { method: 'PUT', headers: start.body.headers, body: 'new' });
    expect(late.status).toBe(412);
    expect(await download('a.txt')).toBe('two');
  });

  it('moves and deletes', async () => {
    await upload('a.txt', 'data', 'text/plain');
    expect((await call('POST', '/assets/files/move', { from: 'a.txt', to: 'dir/b.txt' })).status).toBe(200);
    expect(await download('dir/b.txt')).toBe('data');
    expect((await call('POST', '/assets/files/download', { path: 'a.txt' })).status).toBe(404);
    expect((await call('DELETE', '/assets/files?path=dir/b.txt')).status).toBe(200);
    expect((await call('POST', '/assets/files/download', { path: 'dir/b.txt' })).status).toBe(404);
  });
});
