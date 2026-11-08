// The preview links' publish routes, browser and CLI, over HTTP: who gets in.
// SR5's pinning test is here: a box's token, valid as it is, gets 401 on
// every session route (it never becomes req.user) and 403 on every CLI one,
// route by route, so a prompt-injected agent can't publish a port.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Router } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { Instance, User } from '@prisma/client';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';

vi.mock('../db', () => ({ prisma: {} }));
// requireAuth itself is real; only its last-seen write is stubbed.
vi.mock('../services/admin/adminAccess', () => ({ touchLastSeen: vi.fn() }));
vi.mock('../services/agentRegistry', () => ({ isProjectAgentConnected: vi.fn(), projectAgentCapabilities: vi.fn(), sendForProject: vi.fn() }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => false), numberVariation: vi.fn(async () => 24) }));

const { previewLinksRouter } = await import('./previewLinks');
const { createCliPreviewLinks } = await import('./cliPreviewLinksPrisma');
const { cliApiRouter } = await import('./cliApi');
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');
const { memoryConfirmationStore, memoryStore } = await import('../services/previewLinksTestStore');
const { previewLinkConfirmRouter } = await import('./previewLinkConfirm');
type PreviewLinkDeps = import('../services/previewLinks').PreviewLinkDeps;

const NOW = Date.parse('2026-10-31T12:00:00Z');
const alice = { id: 'alice', googleEmail: 'alice@x.test', displayName: 'Alice', unixUsername: 'alice' } as User;
const box = { id: 'box1', hostHome: '/home/alice' } as Instance;
const PROJECT = 'cproject00000001';
const DEVICE_ALICE = 'tmcli_' + 'a'.repeat(64);
const BOX_TOKEN = 'tmag_' + 'b'.repeat(40);
/** A device sign-in made on the project's box: its token is readable by anything there. */
const DEVICE_ALICE_ON_BOX = 'tmcli_' + 'c'.repeat(64);

function deps(flags: { enabled: boolean; audiences?: boolean }) {
  const mem = memoryStore();
  const d: PreviewLinkDeps = {
    store: mem.store,
    findProject: async (id) => (id === PROJECT ? { id, name: 'webapp', userId: alice.id, archived: false, instanceId: box.id, instance: box, owner: alice } : null),
    isCollaborator: async () => false,
    findWorkstream: async (_p, name) => (name === 'main' ? { id: null } : undefined),
    findUserByEmail: async (email) => (email === 'bob@x.test' ? ({ id: 'bob', googleEmail: email } as User) : null),
    enabled: async () => flags.enabled,
    audiencesOn: async () => flags.audiences ?? false,
    ttlDefault: async () => 24,
    agent: { connected: () => true, capabilities: () => ['preview-link-v1'], send: async () => ({ listeners: [] }) },
    siteBase: () => 'https://termag.example/termag',
    previewDomain: () => null,
    now: () => new Date(NOW),
  };
  const confirmations = memoryConfirmationStore(() => new Date(NOW));
  const confirm = { links: d, store: confirmations.store, boxName: async () => 'alicebox', secret: () => 'test-secret', audienceOps: mem.audience, log: () => {} };
  return { deps: d, mem, confirm, confirmations };
}

// Each route once, with a body it would accept from its owner.
const SESSION_ROUTES: Array<[string, string, unknown?]> = [
  ['GET', `/projects/${PROJECT}/preview-links`],
  ['GET', `/projects/${PROJECT}/preview-links/listeners?workstream=main`],
  ['POST', `/projects/${PROJECT}/preview-links`, { port: 5173, name: 'my-app' }],
  ['POST', '/preview-links/clink00000001/extend', { ttlHours: 2 }],
  ['DELETE', '/preview-links/clink00000001'],
  ['DELETE', '/preview-links/clink00000001/viewers/bob'],
  ['POST', '/preview-link-requests/creq00000001/decline'],
];

const CLI_ROUTES: Array<[string, string, unknown?]> = [
  ['GET', `/preview-links?project=${PROJECT}`],
  ['GET', '/preview-links'],
  ['POST', '/preview-links', { project: PROJECT, port: 5173, name: 'my-app' }],
  ['POST', '/preview-links/clink00000001/extend', { ttlHours: 2 }],
  ['GET', '/preview-links/confirmations/' + 'x'.repeat(43)],
  ['DELETE', '/preview-links/clink00000001'],
  ['DELETE', '/preview-links/clink00000001/viewers/bob'],
];

interface Layer { route?: { path: string; methods: Record<string, boolean> } }
const routesOf = (router: Router) => (router.stack as Layer[]).filter(l => l.route).map(l => `${Object.keys(l.route!.methods)[0].toUpperCase()} ${l.route!.path}`);

let server: Server;
let base: string;
let flags: { enabled: boolean; audiences?: boolean };
let built: ReturnType<typeof deps>;
let mem: ReturnType<typeof memoryStore>;

const cliStore: CliStore = {
  async findSessionByHash(hash) {
    const row = { userId: alice.id, user: alice as CliUser, tokenPrefix: 'tmcli_xxx', createdAt: new Date(NOW), lastUsedAt: new Date(NOW), revokedAt: null };
    if (hash === sha256Hex(DEVICE_ALICE)) return { ...row, id: 's-alice', deviceName: 'mbp', issuedOnBoxId: null } as CliSessionRecord;
    if (hash === sha256Hex(DEVICE_ALICE_ON_BOX)) return { ...row, id: 's-alice-box', deviceName: 'alicebox', issuedOnBoxId: box.id } as CliSessionRecord;
    return null;
  },
  async validateAgentToken(raw) { return raw === BOX_TOKEN ? { user: alice as CliUser, instanceId: box.id } : null; },
  createSession: async () => { throw new Error('unused'); },
  touchSession: async () => {},
  revokeSession: async () => {},
  listBoxes: async () => [],
  listProjects: async () => [],
  listDevices: async () => [],
  revokeDevice: async () => false,
};

beforeEach(async () => {
  flags = { enabled: true };
  built = deps(flags);
  mem = built.mem;
  const app = express();
  app.use(express.json());
  // The CLI router is mounted ahead of the cookie stack, as in index.ts.
  app.use('/api/cli/v1', cliApiRouter({ store: cliStore, codes: new AuthCodeStore(), now: () => new Date(NOW), jwt: Promise.resolve(null as never), previewLinks: createCliPreviewLinks(built.confirm) }));
  // The browser session, as passport would leave it: a user only for a signed-in cookie.
  app.use((req, _res, next) => { if (req.headers.cookie === 'termag.sid=alice') req.user = alice as Express.User; next(); });
  app.use('/api', previewLinksRouter(built.deps));
  app.use('/termag/previews/confirm', previewLinkConfirmRouter('/termag', { confirm: built.confirm, userOf: req => (req.user as never) ?? null }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as any };
}
const boxToken = { authorization: `Bearer ${BOX_TOKEN}` };
const signedIn = { cookie: 'termag.sid=alice' };
const device = { authorization: `Bearer ${DEVICE_ALICE}` };
const deviceOnBox = { authorization: `Bearer ${DEVICE_ALICE_ON_BOX}` };

describe('the session publish routes', () => {
  it('are exactly these, so a new one must be added to the tests below', () => {
    expect(routesOf(previewLinksRouter(deps(flags).deps))).toEqual(SESSION_ROUTES.map(([m, p]) => `${m} ${p.replace(/\?.*/, '')
      .replace(PROJECT, ':id').replace('clink00000001', ':id').replace('creq00000001', ':id').replace('/bob', '/:userId')}`));
  });

  // SR5.
  for (const [method, path, body] of SESSION_ROUTES) {
    it(`${method} ${path} answers a box token 401, and does nothing`, async () => {
      expect(await call(method, path, boxToken, body)).toEqual({ status: 401, body: { error: 'Unauthorized' } });
      expect(mem.links).toHaveLength(0);
      expect(mem.events).toHaveLength(0);
    });
  }

  for (const [method, path, body] of SESSION_ROUTES) {
    it(`${method} ${path} answers 404 not_found with preview-links-enabled off`, async () => {
      flags.enabled = false;
      expect(await call(method, path, signedIn, body)).toEqual({ status: 404, body: { error: 'Not found', code: 'not_found' } });
    });
  }

  it('publishes for a signed-in owner', async () => {
    const r = await call('POST', `/projects/${PROJECT}/preview-links`, signedIn, { port: 5173, name: 'my-app' });
    expect(r).toMatchObject({ status: 201, body: { shareUrl: 'https://termag.example/termag/previews/my-app', link: { name: 'my-app', host: null } } });
    expect(mem.links).toHaveLength(1);
  });
});

describe('the CLI publish routes', () => {
  // SR5, for the CLI: a box token is a valid bearer there, so it must be refused by kind.
  for (const [method, path, body] of CLI_ROUTES) {
    it(`${method} ${path} answers a box token 403 forbidden, and does nothing`, async () => {
      const r = await call(method, `/cli/v1${path}`, boxToken, body);
      expect(r).toMatchObject({ status: 403, body: { code: 'forbidden', error: expect.stringContaining('termag login --device <name>') } });
      expect(mem.links).toHaveLength(0);
    });
  }

  it('need a bearer at all', async () => {
    expect((await call('GET', '/cli/v1/preview-links', {})).status).toBe(401);
  });

  it('publish, list and revoke for a device sign-in', async () => {
    const published = await call('POST', '/cli/v1/preview-links', device, { project: PROJECT, port: 5173, name: 'my-app' });
    expect(published).toMatchObject({ status: 201, body: { link: { name: 'my-app' } } });
    const id = published.body.link.id;
    expect((await call('GET', '/cli/v1/preview-links', device)).body.links.map((l: any) => l.name)).toEqual(['my-app']);
    expect((await call('GET', `/cli/v1/preview-links?project=${PROJECT}`, device)).body.links.map((l: any) => l.id)).toEqual([id]);
    expect(await call('DELETE', `/cli/v1/preview-links/${id}`, device)).toMatchObject({ status: 200, body: { link: { live: false, endReason: 'revoked' } } });
  });

  it('refuses a missing or malformed project', async () => {
    expect(await call('POST', '/cli/v1/preview-links', device, { port: 5173, name: 'my-app' })).toMatchObject({ status: 400 });
    expect(await call('GET', '/cli/v1/preview-links?project=../x', device)).toMatchObject({ status: 400 });
  });

  it('answer 404 not_found with preview-links-enabled off', async () => {
    flags.enabled = false;
    expect(await call('POST', '/cli/v1/preview-links', device, { project: PROJECT, port: 5173, name: 'my-app' })).toEqual({ status: 404, body: { error: 'Not found', code: 'not_found' } });
    expect(await call('GET', `/cli/v1/preview-links?project=${PROJECT}`, device)).toMatchObject({ status: 404 });
  });
});

describe('a device sign-in made on a box (SR5: an agent there can use it)', () => {
  beforeEach(() => { flags.audiences = true; });

  it('publishes an "only me" link at once', async () => {
    expect(await call('POST', '/cli/v1/preview-links', deviceOnBox, { project: PROJECT, port: 5173, name: 'my-app' })).toMatchObject({ status: 201, body: { link: { audience: 'owner' } } });
  });

  it('gets 202 and a confirm URL for a wider audience, and nothing is live until the person confirms', async () => {
    const r = await call('POST', '/cli/v1/preview-links', deviceOnBox, { project: PROJECT, port: 5173, name: 'my-app', audience: 'people', emails: ['bob@x.test'] });
    expect(r).toMatchObject({ status: 202, body: { code: 'confirm_in_browser', confirm: { url: expect.stringMatching(/^https:\/\/termag\.example\/termag\/previews\/confirm\//) } } });
    expect(mem.links).toEqual([]);
    const status = r.body.confirm.status as string;
    expect(await call('GET', `/cli/v1${status}`, deviceOnBox)).toMatchObject({ status: 200, body: { state: 'pending', link: null } });
  });

  it('a laptop sign-in publishes the wider audience directly', async () => {
    expect(await call('POST', '/cli/v1/preview-links', device, { project: PROJECT, port: 5173, name: 'my-app', audience: 'link' })).toMatchObject({ status: 201, body: { link: { audience: 'link' } } });
  });

  it('may revoke and remove viewers: they only narrow access', async () => {
    const pub = await call('POST', '/cli/v1/preview-links', device, { project: PROJECT, port: 5173, name: 'my-app', audience: 'people', emails: ['bob@x.test'] });
    const id = pub.body.link.id;
    // Bob is no termag user here (the store's users), so his viewer row isn't made; the route answers all the same.
    expect(await call('DELETE', `/cli/v1/preview-links/${id}/viewers/bob`, deviceOnBox)).toMatchObject({ status: 200, body: { removed: true } });
    expect(await call('DELETE', `/cli/v1/preview-links/${id}`, deviceOnBox)).toMatchObject({ status: 200, body: { link: { live: false } } });
  });

  it('the confirm page: the person\'s own session, no framing, no referrer, no script; Publish needs its CSRF token', async () => {
    const r = await call('POST', '/cli/v1/preview-links', deviceOnBox, { project: PROJECT, port: 5173, name: 'my-app', audience: 'link' });
    const url = new URL(r.body.confirm.url as string);
    const page = `${base.replace(/\/api$/, '')}${url.pathname}`;
    // Not signed in: no page.
    expect((await fetch(page, { redirect: 'manual' })).status).toBe(401);
    const res = await fetch(page, { headers: signedIn });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'.*frame-ancestors 'none'/);
    const html = await res.text();
    expect(html).not.toMatch(/<script/i);
    expect(html).toMatch(/Publish a preview link\?/);
    expect(html).toContain('anyone signed in to termag who has the link');
    expect(html).toContain('<code>alicebox</code>');
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    const post = (form: Record<string, string>) => fetch(page, { method: 'POST', redirect: 'manual', headers: { ...signedIn, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
    expect((await post({ decision: 'publish' })).status).toBe(403);
    expect((await post({ decision: 'publish', csrf: 'forged' })).status).toBe(403);
    expect(mem.links).toEqual([]);
    const ok = await post({ decision: 'publish', csrf });
    expect(ok.status).toBe(303);
    // The redirect's Location, and the request it leads to, hold the id: no Referer from it.
    expect(ok.headers.get('referrer-policy')).toBe('no-referrer');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(mem.links).toHaveLength(1);
    expect(mem.links[0]).toMatchObject({ name: 'my-app', audience: 'link' });
    expect(await (await fetch(page, { headers: signedIn })).text()).toMatch(/<h1>Published<\/h1>/);
    const done = await call('GET', `/cli/v1${r.body.confirm.status}`, deviceOnBox);
    expect(done).toMatchObject({ status: 200, body: { state: 'confirmed', link: { name: 'my-app' }, shareUrl: expect.stringMatching(/\/previews\/my-app\/[A-Za-z0-9_-]{22}$/) } });
  });

  it("another person's session gets the not-found page", async () => {
    const r = await call('POST', '/cli/v1/preview-links', deviceOnBox, { project: PROJECT, port: 5173, name: 'my-app', audience: 'link' });
    const page = `${base.replace(/\/api$/, '')}${new URL(r.body.confirm.url as string).pathname}`;
    // Bob has no session cookie the test middleware knows, so he's "signed in" as nobody; a session for Bob:
    const bobApp = express();
    bobApp.use((req, _res, next) => { req.user = { id: 'bob', googleEmail: 'bob@x.test' } as Express.User; next(); });
    bobApp.use('/termag/previews/confirm', previewLinkConfirmRouter('/termag', { confirm: built.confirm, userOf: req => (req.user as never) ?? null }));
    const bobServer = await new Promise<Server>(resolve => { const s = bobApp.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const at = `http://127.0.0.1:${(bobServer.address() as AddressInfo).port}${new URL(page).pathname}`;
      expect((await fetch(at)).status).toBe(404);
      expect((await fetch(at, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'decision=publish&csrf=x' })).status).toBe(404);
    } finally {
      await new Promise<void>(resolve => bobServer.close(() => resolve()));
    }
    expect(mem.links).toEqual([]);
  });

  it('sends someone not signed in to sign in without the id as a Referer', async () => {
    const r = await call('POST', '/cli/v1/preview-links', deviceOnBox, { project: PROJECT, port: 5173, name: 'my-app', audience: 'link' });
    const path = new URL(r.body.confirm.url as string).pathname;
    const anonApp = express();
    anonApp.use('/termag/previews/confirm', previewLinkConfirmRouter('/termag', { confirm: built.confirm, userOf: () => null, signIn: async () => '/termag/auth/login' }));
    const anon = await new Promise<Server>(resolve => { const s = anonApp.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${(anon.address() as AddressInfo).port}${path}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/termag/auth/login');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    } finally {
      await new Promise<void>(resolve => anon.close(() => resolve()));
    }
  });
});
