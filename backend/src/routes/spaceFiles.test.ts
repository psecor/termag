import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { spaceFilesRouter } from './spaceFiles';
import { SpacesUnavailableError } from '../services/spaces/spaceConfig';
import type { PresignerIdentity } from '../services/spaces/spaceObjects';
import { MemorySpaceObjects, MemorySpaceStore } from '../services/spaces/spacesTestkit';

let store: MemorySpaceStore;
let objects: MemorySpaceObjects;
let identities: PresignerIdentity[];
let enabled: Set<string>;
let htmlEnabled: Set<string>;
let unavailable = false;
let canStash = true;
const stashed: string[] = [];
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  const liveStore = new Proxy({}, { get: (_t, prop) => (...args: unknown[]) => (store as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[prop](...args) });
  app.use('/termag/files', spaceFilesRouter({
    store: liveStore as MemorySpaceStore,
    objects: async identity => {
      if (unavailable) throw new SpacesUnavailableError('no identity');
      identities.push(identity);
      return objects;
    },
    enabled: async userId => enabled.has(userId),
    htmlEnabled: async userId => htmlEnabled.has(userId),
    userId: req => req.get('x-user') ?? null,
    signIn: async req => {
      if (req.get('x-okta')) return null;
      if (!canStash) return null;
      stashed.push(req.originalUrl);
      return '/termag/auth/login';
    },
  }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/termag/files`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

let spaceId: string;

beforeEach(async () => {
  store = new MemorySpaceStore();
  objects = new MemorySpaceObjects();
  identities = [];
  enabled = new Set(['alice', 'bob', 'carol', 'dave']);
  htmlEnabled = new Set();
  unavailable = false;
  canStash = true;
  stashed.length = 0;
  for (const u of ['alice', 'bob', 'carol', 'dave']) store.addUser(u);
  const space = await store.createSpace({ name: 'assets', description: null, userId: 'alice' });
  spaceId = space.id;
  await store.addMember({ spaceId, email: 'bob@example.com', role: 'viewer', addedById: 'alice' });
  objects.put(`${spaceId}/cat.png`, 10, 'image/png');
  objects.put(`${spaceId}/docs/My Report.pdf`, 20, 'application/pdf');
  objects.put(`${spaceId}/page.html`, 30, 'text/html');
  objects.put(`${spaceId}/logo.svg`, 40, 'image/svg+xml');
});

async function get(path: string, as?: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (as) headers['x-user'] = as;
  const res = await fetch(base + path, { headers, redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), cache: res.headers.get('cache-control'), headers: res.headers, text: await res.text() };
}

function lastPresign() {
  return objects.presigned.at(-1)!;
}

describe('space file links', () => {
  it('redirects a viewer to a presigned GET and logs file.get', async () => {
    const r = await get('/assets/cat.png', 'bob');
    expect(r.status).toBe(302);
    expect(r.location).toBe(`https://s3.test/get/${spaceId}/cat.png`);
    expect(r.cache).toBe('no-store');
    expect(lastPresign()).toEqual({
      op: 'get', key: `${spaceId}/cat.png`,
      extra: { contentDisposition: expect.stringMatching(/^inline;/), contentType: 'image/png' },
    });
    expect(store.eventRows.filter(e => e.action === 'file.get')).toMatchObject([{ actorUserId: 'bob', path: 'cat.png', bytes: 10, actorInstanceId: null }]);
    expect(identities).toEqual([{ kind: 'user', userId: 'bob', email: 'bob@example.com' }]);
  });

  it('decodes percent-encoded paths', async () => {
    const r = await get('/assets/docs/My%20Report.pdf', 'alice');
    expect(r.status).toBe(302);
    expect(lastPresign().key).toBe(`${spaceId}/docs/My Report.pdf`);
  });

  it('makes HTML and SVG octet-stream attachments', async () => {
    for (const path of ['page.html', 'logo.svg']) {
      expect((await get(`/assets/${path}`, 'alice')).status).toBe(302);
      expect(lastPresign().extra).toEqual({ contentDisposition: expect.stringMatching(/^attachment;/), contentType: 'application/octet-stream' });
    }
  });

  it('opens Markdown inline as plain text', async () => {
    objects.put(`${spaceId}/poems/socket-mode.md`, 50, 'text/markdown');
    expect((await get('/assets/poems/socket-mode.md', 'bob')).status).toBe(302);
    expect(lastPresign().extra).toEqual({ contentDisposition: expect.stringMatching(/^inline;/), contentType: 'text/plain; charset=utf-8' });
  });

  it('serves HTML as a sandboxed page with spaces-html-links-enabled', async () => {
    htmlEnabled.add('bob');
    objects.bodies.set(`${spaceId}/page.html`, Buffer.from('<h1>hi</h1>'));
    const r = await get('/assets/page.html', 'bob');
    expect(r.status).toBe(200);
    expect(r.text).toBe('<h1>hi</h1>');
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(r.headers.get('content-security-policy')).toMatch(/^sandbox; default-src 'none';/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.cache).toBe('no-store');
    expect(objects.presigned).toHaveLength(0);
    expect(store.eventRows.filter(e => e.action === 'file.get')).toMatchObject([{ actorUserId: 'bob', path: 'page.html', bytes: 11 }]);
  });

  it('keeps HTML an attachment with the flag off, over the size cap, and SVG always', async () => {
    expect((await get('/assets/page.html', 'bob')).status).toBe(302);
    htmlEnabled.add('bob');
    objects.put(`${spaceId}/big.html`, 10 * 1024 * 1024 + 1, 'text/html');
    expect((await get('/assets/big.html', 'bob')).status).toBe(302);
    expect((await get('/assets/logo.svg', 'bob')).status).toBe(302);
    expect(objects.reads).toEqual([]);
    for (const p of objects.presigned) expect(p.extra).toMatchObject({ contentDisposition: expect.stringMatching(/^attachment;/) });
  });

  it('falls back to an attachment when the file grew past the cap after the HEAD', async () => {
    htmlEnabled.add('bob');
    objects.bodies.set(`${spaceId}/page.html`, Buffer.alloc(10 * 1024 * 1024 + 5));
    const r = await get('/assets/page.html', 'bob');
    expect(r.status).toBe(302);
    expect(lastPresign().extra).toMatchObject({ contentDisposition: expect.stringMatching(/^attachment;/) });
    expect(store.eventRows.filter(e => e.action === 'file.get')).toMatchObject([{ path: 'page.html', bytes: 30 }]);
  });

  it('still answers 404 for an HTML page the viewer cannot read', async () => {
    htmlEnabled.add('carol');
    expect((await get('/assets/page.html', 'carol')).status).toBe(404);
    expect(objects.reads).toEqual([]);
  });

  it('answers the same 404 for no access, an unknown space, a missing file and a bad path', async () => {
    const answers = await Promise.all([
      get('/assets/cat.png', 'carol'),
      get('/nope/cat.png', 'alice'),
      get('/assets/missing.png', 'alice'),
      get('/assets/missing.png', 'carol'),
      get('/assets/%2e%2e/x', 'alice'),
      get('/assets/a//b', 'alice'),
      get('/assets/', 'alice'),
      get('/assets', 'alice'),
      get('/assets/%E0%A4%A', 'alice'),
      get('/assets/a%3Bb', 'alice'),
    ]);
    for (const a of answers) expect({ status: a.status, text: a.text }).toEqual({ status: 404, text: 'Not found' });
    expect(objects.presigned).toHaveLength(0);
  });

  it('answers 404 while spaces-enabled is off for the user', async () => {
    enabled.delete('bob');
    expect((await get('/assets/cat.png', 'bob')).status).toBe(404);
  });

  it('answers 404 once the space is deleted', async () => {
    store.spaces.get(spaceId)!.deletedAt = new Date();
    expect((await get('/assets/cat.png', 'alice')).status).toBe(404);
  });

  it('claims an invite for someone who has not opened the space yet', async () => {
    store.inviteRows.push({ id: 'inv1', spaceId, email: 'dave@example.com', role: 'viewer', addedById: 'alice', createdAt: new Date() });
    expect((await get('/assets/cat.png', 'dave')).status).toBe(302);
  });

  it('sends someone not signed in to sign in, remembering the link', async () => {
    const r = await get('/assets/docs/My%20Report.pdf');
    expect(r.status).toBe(302);
    expect(r.location).toBe('/termag/auth/login');
    expect(stashed).toEqual(['/termag/files/assets/docs/My%20Report.pdf']);
    expect(objects.presigned).toHaveLength(0);
  });

  it('answers 401 when it cannot send them to sign in (okta mode, or the stash refused)', async () => {
    expect((await get('/assets/cat.png', undefined, { 'x-okta': '1' })).status).toBe(401);
    canStash = false;
    expect((await get('/assets/cat.png')).status).toBe(401);
  });

  it('answers 503 when the storage identity is unavailable', async () => {
    unavailable = true;
    expect((await get('/assets/cat.png', 'alice')).status).toBe(503);
  });
});
