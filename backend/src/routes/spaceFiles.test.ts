import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { sharedFileApiRouter, spaceFilesRouter } from './spaceFiles';
import { SpacesUnavailableError } from '../services/spaces/spaceConfig';
import { spaceFolderPagePath } from '../services/spaces/spaceLinks';
import type { PresignerIdentity } from '../services/spaces/spaceObjects';
import { MemorySpaceObjects, MemorySpaceStore } from '../services/spaces/spacesTestkit';

let store: MemorySpaceStore;
let objects: MemorySpaceObjects;
let identities: PresignerIdentity[];
let unavailable = false;
let canStash = true;
const stashed: string[] = [];
let server: Server;
let base: string;
let apiBase: string;
let disallowed: Set<string>;
let sharesOff = false;
let filesUi: Set<string>;

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
    userId: req => req.get('x-user') ?? null,
    signIn: async req => {
      if (req.get('x-okta')) return null;
      if (!canStash) return null;
      stashed.push(req.originalUrl);
      return '/termag/auth/login';
    },
    viewerAllowed: email => !disallowed.has(email),
    sharingDisabled: () => sharesOff,
    folderPage: async (userId, space, dir) => (filesUi.has(userId) ? spaceFolderPagePath('/termag', space, dir) : null),
  }));
  app.use('/termag/api/shared-files', express.json(), sharedFileApiRouter({
    store: liveStore as MemorySpaceStore,
    objects: async () => objects,
    userId: req => req.get('x-user') ?? null,
    viewerAllowed: email => !disallowed.has(email),
    sharingDisabled: () => sharesOff,
  }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `${origin}/termag/files`;
  apiBase = `${origin}/termag/api/shared-files`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

let spaceId: string;

beforeEach(async () => {
  store = new MemorySpaceStore();
  objects = new MemorySpaceObjects();
  identities = [];
  unavailable = false;
  canStash = true;
  stashed.length = 0;
  disallowed = new Set();
  sharesOff = false;
  filesUi = new Set(['alice', 'bob', 'carol', 'dave']);
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

  it('makes SVG and HTML over the size cap octet-stream attachments', async () => {
    objects.put(`${spaceId}/big.html`, 10 * 1024 * 1024 + 1, 'text/html');
    for (const path of ['big.html', 'logo.svg']) {
      expect((await get(`/assets/${path}`, 'alice')).status).toBe(302);
      expect(lastPresign().extra).toEqual({ contentDisposition: expect.stringMatching(/^attachment;/), contentType: 'application/octet-stream' });
    }
  });

  it('opens Markdown inline as plain text', async () => {
    objects.put(`${spaceId}/poems/socket-mode.md`, 50, 'text/markdown');
    expect((await get('/assets/poems/socket-mode.md', 'bob')).status).toBe(302);
    expect(lastPresign().extra).toEqual({ contentDisposition: expect.stringMatching(/^inline;/), contentType: 'text/plain; charset=utf-8' });
  });

  it('serves HTML as a sandboxed page', async () => {
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

  it('keeps HTML an attachment over the size cap, and SVG always', async () => {
    objects.put(`${spaceId}/big.html`, 10 * 1024 * 1024 + 1, 'text/html');
    expect((await get('/assets/big.html', 'bob')).status).toBe(302);
    expect((await get('/assets/logo.svg', 'bob')).status).toBe(302);
    expect(objects.reads).toEqual([]);
    for (const p of objects.presigned) expect(p.extra).toMatchObject({ contentDisposition: expect.stringMatching(/^attachment;/) });
  });

  it('falls back to an attachment when the file grew past the cap after the HEAD', async () => {
    objects.bodies.set(`${spaceId}/page.html`, Buffer.alloc(10 * 1024 * 1024 + 5));
    const r = await get('/assets/page.html', 'bob');
    expect(r.status).toBe(302);
    expect(lastPresign().extra).toMatchObject({ contentDisposition: expect.stringMatching(/^attachment;/) });
    expect(store.eventRows.filter(e => e.action === 'file.get')).toMatchObject([{ path: 'page.html', bytes: 30 }]);
  });

  it('still answers 404 for an HTML page the viewer cannot read', async () => {
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
      get('/assets/nope/', 'alice'),
      get('/assets/docs/', 'carol'),
      get('/assets/docs', 'carol'),
      get('/assets', 'alice'),
      get('/assets/%E0%A4%A', 'alice'),
      get('/assets/a%3Bb', 'alice'),
    ]);
    for (const a of answers) expect({ status: a.status, text: a.text }).toEqual({ status: 404, text: 'Not found' });
    expect(objects.presigned).toHaveLength(0);
  });

  it('sends a member to the space\'s explorer for a folder: a trailing slash, or a path that is a folder', async () => {
    objects.put(`${spaceId}/docs/deep/notes.md`, 5, 'text/markdown');
    for (const [path, dir] of [['/assets/docs/', 'docs/'], ['/assets/docs', 'docs/'], ['/assets/docs/deep/', 'docs/deep/'], ['/assets/', '']]) {
      const r = await get(path, 'bob');
      expect({ path, status: r.status, location: r.location }).toEqual({ path, status: 302, location: `/termag/chat/files/assets?dir=${encodeURIComponent(dir)}` });
    }
    expect(objects.presigned).toHaveLength(0);
    expect(store.eventRows.filter(e => e.action === 'file.get')).toEqual([]);
  });

  it('keeps a folder\'s link a 404 for a member whose simple UI has no Files to show it in', async () => {
    filesUi.delete('bob');
    for (const path of ['/assets/docs/', '/assets/docs', '/assets/']) {
      expect({ path, status: (await get(path, 'bob')).status }).toEqual({ path, status: 404 });
    }
  });

  it('encodes the space and the folder in the explorer\'s address', async () => {
    objects.put(`${spaceId}/My Docs/a.md`, 5, 'text/markdown');
    const r = await get('/assets/My%20Docs/', 'alice');
    expect(r.location).toBe('/termag/chat/files/assets?dir=My%20Docs%2F');
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

describe('a file shared with termag', () => {
  beforeEach(async () => {
    await store.addFileShare(spaceId, 'docs/My Report.pdf', 'alice');
  });

  it('redirects a non-member to a one-minute presigned GET and logs file.get via share', async () => {
    const r = await get('/assets/docs/My%20Report.pdf', 'carol');
    expect(r.status).toBe(302);
    expect(lastPresign()).toMatchObject({ key: `${spaceId}/docs/My Report.pdf`, extra: { ttlS: 60, contentDisposition: expect.stringMatching(/^inline;/) } });
    expect(store.eventRows.filter(e => e.action === 'file.get')).toMatchObject([{ actorUserId: 'carol', via: 'share', path: 'docs/My Report.pdf' }]);
    expect(identities).toEqual([{ kind: 'user', userId: 'carol', email: 'carol@example.com' }]);
  });

  it('serves a shared file to a viewer with no role in the space', async () => {
    expect((await get('/assets/docs/My%20Report.pdf', 'carol')).status).toBe(302);
  });

  it('gives a member their usual link, not the shared one', async () => {
    expect((await get('/assets/docs/My%20Report.pdf', 'bob')).status).toBe(302);
    expect(lastPresign().extra).not.toHaveProperty('ttlS');
    expect(store.eventRows.at(-1)).toMatchObject({ actorUserId: 'bob', via: null });
  });

  it('shares only that file: its folder and the other files stay a 404', async () => {
    objects.put(`${spaceId}/docs/other.pdf`, 5, 'application/pdf');
    for (const path of ['/assets/docs/other.pdf', '/assets/cat.png', '/assets/docs/', '/assets/docs/My%20Report.pdf/x']) {
      expect({ path, status: (await get(path, 'carol')).status }).toEqual({ path, status: 404 });
    }
  });

  it('answers 404 once the share is gone, the file is gone, or the space is deleted', async () => {
    objects.files.delete(`${spaceId}/docs/My Report.pdf`);
    expect((await get('/assets/docs/My%20Report.pdf', 'carol')).status).toBe(404);
    objects.put(`${spaceId}/docs/My Report.pdf`, 20, 'application/pdf');
    await store.removeFileShares(spaceId, { path: 'docs/My Report.pdf' });
    expect((await get('/assets/docs/My%20Report.pdf', 'carol')).status).toBe(404);
    await store.addFileShare(spaceId, 'docs/My Report.pdf', 'alice');
    store.spaces.get(spaceId)!.deletedAt = new Date();
    expect((await get('/assets/docs/My%20Report.pdf', 'carol')).status).toBe(404);
  });

  it('stops working when whoever shared it is no longer an editor, or the space goes read-only', async () => {
    await store.addMember({ spaceId, email: 'dave@example.com', role: 'editor', addedById: 'alice' });
    await store.removeFileShares(spaceId, { path: 'docs/My Report.pdf' });
    await store.addFileShare(spaceId, 'docs/My Report.pdf', 'dave');
    expect((await get('/assets/docs/My%20Report.pdf', 'carol')).status).toBe(302);
    await store.setMemberRole(spaceId, 'dave', 'viewer');
    expect((await get('/assets/docs/My%20Report.pdf', 'carol')).status).toBe(404);
    await store.setMemberRole(spaceId, 'dave', 'editor');
    store.spaces.get(spaceId)!.readOnlyAt = new Date();
    expect((await get('/assets/docs/My%20Report.pdf', 'carol')).status).toBe(404);
  });

  it('answers 404 to a viewer ALLOWED_USERS no longer lets in, and to everyone with the kill switch on', async () => {
    disallowed.add('carol@example.com');
    expect((await get('/assets/docs/My%20Report.pdf', 'carol')).status).toBe(404);
    disallowed.clear();
    sharesOff = true;
    expect((await get('/assets/docs/My%20Report.pdf', 'carol')).status).toBe(404);
    expect((await get('/assets/docs/My%20Report.pdf', 'bob')).status).toBe(302);
    expect(objects.presigned).toHaveLength(1);
  });

  it('still sends someone not signed in to sign in first', async () => {
    const r = await get('/assets/docs/My%20Report.pdf');
    expect(r.location).toBe('/termag/auth/login');
    expect(objects.presigned).toHaveLength(0);
  });
});

describe('the shared-files API', () => {
  async function view(body: unknown, as?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (as) headers['x-user'] = as;
    const res = await fetch(`${apiBase}/view`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  it('answers a non-member the view of a shared file, signed for a minute, with who shared it', async () => {
    await store.addFileShare(spaceId, 'docs/My Report.pdf', 'alice');
    const r = await view({ space: 'assets', path: 'docs/My Report.pdf' }, 'carol');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      url: `https://s3.test/get/${spaceId}/docs/My Report.pdf`, size: 20,
      view: { render: 'frame' },
      share: { shared: true, canShare: false, sharedBy: { displayName: 'alice', email: 'alice@example.com' } },
    });
    expect(lastPresign().extra).toMatchObject({ ttlS: 60 });
    expect(store.eventRows.at(-1)).toMatchObject({ action: 'file.get', via: 'share', actorUserId: 'carol' });
  });

  it('answers 404 for a file that is not shared, a bad path and an unknown space, and 401 with no user', async () => {
    for (const body of [{ space: 'assets', path: 'cat.png' }, { space: 'assets', path: '../x' }, { space: 'nope', path: 'cat.png' }, { path: 'cat.png' }]) {
      expect((await view(body, 'carol')).status).toBe(404);
    }
    expect((await view({ space: 'assets', path: 'cat.png' })).status).toBe(401);
    expect(objects.presigned).toHaveLength(0);
  });
});
