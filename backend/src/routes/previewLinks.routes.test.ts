// The preview links' publish routes, browser and CLI, over HTTP: who gets in.
// SR5's pinning test is here: a box's token, valid as it is, gets 401 on
// every session route (it never becomes req.user) and 403 on every CLI one,
// route by route, so a prompt-injected agent can't publish a port.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANSWERED_COOLDOWN_HOURS } from '../services/previewLinkRequests';
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

function deps(flags: { enabled: boolean; audiences?: boolean; requests?: boolean }) {
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
  const pushed: string[] = [];
  const confirm = { links: d, store: confirmations.store, boxName: async () => 'alicebox', secret: () => 'test-secret', audienceOps: mem.audience, log: () => {}, requestsChanged: (id: string) => { pushed.push(id); } };
  // `termag preview request`'s side: its rows are the links store's, so the list, Decline and a publish see them.
  const told: Array<{ slack?: string; workspace?: string }> = [];
  const requests = {
    store: {
      claim: async (row: { projectId: string; workstreamId: string | null; boxId: string; port: number; note: string | null }, since: Date, limit: number, answeredSince: Date) => {
        const pending = mem.requests.find(r => r.projectId === row.projectId && r.workstreamId === row.workstreamId && r.port === row.port && r.state === 'pending');
        if (pending) return { kind: 'repeat' as const, row: pending };
        const answered = mem.requests.filter(r => r.projectId === row.projectId && r.workstreamId === row.workstreamId && r.port === row.port && ['approved', 'declined', 'expired'].includes(r.state) && r.decidedAt && r.decidedAt >= answeredSince)
          .sort((a, b) => b.decidedAt!.getTime() - a.decidedAt!.getTime())[0];
        if (answered) return { kind: 'answered' as const, row: answered };
        if (mem.requests.filter(r => r.boxId === row.boxId && r.createdAt >= since && r.state !== 'withdrawn').length >= limit) return { kind: 'limited' as const };
        const r = { ...row, id: `creq${String(mem.requests.length + 1).padStart(8, '0')}`, state: 'pending', createdAt: new Date(NOW), decidedAt: null };
        mem.requests.push(r);
        return { kind: 'created' as const, row: r };
      },
      withdraw: async (id: string, at: Date) => { const r = mem.requests.find(x => x.id === id && x.state === 'pending'); if (r) Object.assign(r, { state: 'withdrawn', decidedAt: at }); },
    },
    findProjectOnBox: async (boxId: string, name: string) => (boxId === box.id && name === 'webapp' ? { ...(await d.findProject(PROJECT))!, owner: { ...alice, slackUserId: null } } as never : null),
    requestsOn: async () => flags.requests ?? true,
    notifySlack: async (_owner: unknown, text: string) => { told.push({ slack: text }); },
    workspaceChanged: (ownerId: string) => { told.push({ workspace: ownerId }); },
    event: () => {},
    now: () => new Date(NOW),
  };
  return { deps: d, mem, confirm, confirmations, requests, told, pushed };
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
let flags: { enabled: boolean; audiences?: boolean; requests?: boolean };
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
  app.use('/api/cli/v1', cliApiRouter({ store: cliStore, codes: new AuthCodeStore(), now: () => new Date(NOW), jwt: Promise.resolve(null as never), previewLinks: createCliPreviewLinks(built.confirm, built.requests) }));
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
      expect(r).toMatchObject({ status: 403, body: { code: 'forbidden', error: expect.stringMatching(/^A box's own credentials can't /) } });
      expect(mem.links).toHaveLength(0);
    });
  }

  // Each refusal names what was refused, and only ways that exist and fit (#1531): no
  // command the CLI lacks, no list for a confirmation, no revoke for one viewer.
  const refusal = async (method: string, path: string, body?: unknown) => (await call(method, `/cli/v1${path}`, boxToken, body)).body.error as string;

  it("a box token's refusal says what was refused, route by route", async () => {
    expect(await refusal('GET', `/preview-links?project=${PROJECT}`)).toContain("can't read preview links");
    expect(await refusal('POST', '/preview-links', { project: PROJECT, port: 5173, name: 'my-app' })).toContain("can't publish a preview link");
    expect(await refusal('POST', '/preview-links/clink00000001/extend', { ttlHours: 2 })).toContain("can't extend a preview link");
    expect(await refusal('GET', '/preview-links/confirmations/' + 'x'.repeat(43))).toContain("can't read a preview link's confirmation");
    expect(await refusal('DELETE', '/preview-links/clink00000001')).toContain("can't revoke a preview link");
    expect(await refusal('DELETE', '/preview-links/clink00000001/viewers/bob')).toContain("can't remove a preview link's viewer");
  });

  it("a box token's list refusal points at the owner's list, not publish", async () => {
    const read = await refusal('GET', `/preview-links?project=${PROJECT}`);
    expect(read).toContain('`termag preview list`');
    expect(read).toContain('`termag login --device <name>`');
    expect(read).not.toContain('publish');
  });

  it("a box token's publish refusal keeps the agent's ask (termag preview request) and the owner's publish", async () => {
    const publish = await refusal('POST', '/preview-links', { project: PROJECT, port: 5173, name: 'my-app' });
    expect(publish).toContain('`termag preview publish`');
    expect(publish).toContain('sign in on the box with `termag login --device <name>`, or ask the owner with `termag preview request`');
  });

  it("a box token's revoke refusal points at the owner's revoke", async () => {
    const revoke = await refusal('DELETE', '/preview-links/clink00000001');
    expect(revoke).toContain('`termag preview revoke`');
    expect(revoke).not.toContain('publish');
  });

  it("a box token's remove-viewer refusal sends the owner to the Share dialog's Remove, never revoke", async () => {
    const remove = await refusal('DELETE', '/preview-links/clink00000001/viewers/bob');
    expect(remove).toContain("Remove beside their name in termag's Share dialog");
    expect(remove).not.toMatch(/revoke|termag preview|termag login/);
  });

  it("a box token's confirmation refusal says the owner confirms in the browser, and suggests no list", async () => {
    const poll = await refusal('GET', '/preview-links/confirmations/' + 'x'.repeat(43));
    expect(poll).toContain('the owner confirms or declines it in their browser');
    expect(poll).toContain("`termag preview publish` that asked for it reads it with the owner's own sign-in");
    expect(poll).not.toMatch(/preview list|preview request/);
  });

  it("a box token's extend refusal sends the owner to Extend, not to publish", async () => {
    const extend = await refusal('POST', '/preview-links/clink00000001/extend', { ttlHours: 2 });
    expect(extend).toContain("Extend in termag's Share dialog");
    expect(extend).not.toMatch(/publish|termag preview|termag login/);
  });

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

// An agent asking (`termag preview request`; SR5, row 6): the one route a box token may call, and all it can do is ask.
describe('an agent on the box asking for a link', () => {
  const ask = (headers: Record<string, string>, body: unknown) => call('POST', '/cli/v1/preview-link-requests', headers, body);
  const idOf = (text: string) => /\/previews\/confirm\/([A-Za-z0-9_-]{43})/.exec(text)![1];

  it('records a pending request for the owner, tells them in the workspace and on Slack, and hands the agent nothing more', async () => {
    const r = await ask(boxToken, { project: 'webapp', port: 5173, note: 'the <b>Vite</b> app <!channel>' });
    expect(r).toMatchObject({ status: 201, body: { state: 'pending', request: { id: 'creq00000001', port: 5173, note: 'the <b>Vite</b> app <!channel>' } } });
    expect(JSON.stringify(r.body)).not.toContain('/previews/confirm/');
    expect(mem.requests).toMatchObject([{ projectId: PROJECT, workstreamId: null, boxId: box.id, port: 5173, state: 'pending' }]);
    expect(mem.links).toEqual([]);
    expect(built.told[0]).toEqual({ workspace: 'alice' });
    // The note can't mention anyone or link anything in Slack.
    expect(built.told[1].slack).toContain('`the &lt;b&gt;Vite&lt;/b&gt; app &lt;!channel&gt;`');
    expect(built.told[1].slack).not.toContain('<!channel>');
    // The confirmation it holds is the owner's, for "only me" and this request.
    const [row] = [...built.confirmations.rows.values()];
    expect(row).toMatchObject({ userId: 'alice', fromBoxId: 'box1', kind: 'publish', state: 'pending', request: { workstream: 'main', port: 5173, name: 'webapp', audience: 'owner', requestId: 'creq00000001' } });
    expect(idOf(built.told[1].slack!)).toHaveLength(43);
  });

  it('can only ask: naming an audience, people, a name or a lifetime is refused, and nothing is recorded', async () => {
    for (const extra of [{ audience: 'link' }, { emails: ['bob@x.test'] }, { name: 'my-app' }, { ttlHours: 168 }, { hostMode: 'public' }, { requestId: 'creq00000009' }]) {
      expect(await ask(boxToken, { project: 'webapp', port: 5173, ...extra })).toMatchObject({ status: 400, body: { code: 'not_allowed' } });
    }
    expect(mem.requests).toEqual([]);
    expect(built.told).toEqual([]);
  });

  it('is for a box token only: a device sign-in, on a box or not, publishes instead', async () => {
    for (const h of [device, deviceOnBox]) {
      expect(await ask(h, { project: 'webapp', port: 5173 })).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    }
    expect((await ask({}, { project: 'webapp', port: 5173 })).status).toBe(401);
    expect(mem.requests).toEqual([]);
  });

  it('answers 404 with either flag off, or for a project that isn\'t on this box', async () => {
    flags.requests = false;
    expect(await ask(boxToken, { project: 'webapp', port: 5173 })).toEqual({ status: 404, body: { error: 'Not found', code: 'not_found' } });
    flags.requests = true;
    flags.enabled = false;
    expect((await ask(boxToken, { project: 'webapp', port: 5173 })).status).toBe(404);
    flags.enabled = true;
    expect((await ask(boxToken, { project: 'someone-else', port: 5173 })).status).toBe(404);
    expect(mem.requests).toEqual([]);
  });

  it('a repeat of a pending ask answers it again without telling the owner twice; past 10 an hour a box is refused', async () => {
    await ask(boxToken, { project: 'webapp', port: 5173 });
    expect(await ask(boxToken, { project: 'webapp', port: 5173 })).toMatchObject({ status: 200, body: { repeated: true, request: { id: 'creq00000001' } } });
    expect(built.told.filter(t => t.slack)).toHaveLength(1);
    for (let p = 3001; p <= 3009; p++) expect((await ask(boxToken, { project: 'webapp', port: p })).status).toBe(201);
    expect(await ask(boxToken, { project: 'webapp', port: 4000 })).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
    expect(mem.requests).toHaveLength(10);
  });

  it('the owner approves in the browser: the confirm page shows the note as quoted text, and Publish makes an "only me" link and approves the request', async () => {
    await ask(boxToken, { project: 'webapp', port: 5173, note: '<script>alert(1)</script> trust me' });
    const id = idOf(built.told[1].slack!);
    const page = await fetch(`${base.replace(/\/api$/, '')}/termag/previews/confirm/${id}`, { headers: signedIn });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('<blockquote>&lt;script&gt;alert(1)&lt;/script&gt; trust me</blockquote>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('an agent on the box');
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    // A box token can't approve: the page needs the owner's browser session.
    const asBox = await fetch(`${base.replace(/\/api$/, '')}/termag/previews/confirm/${id}`, { method: 'POST', headers: { ...boxToken, 'content-type': 'application/x-www-form-urlencoded' }, body: `decision=publish&csrf=${csrf}`, redirect: 'manual' });
    expect(asBox.status).toBe(401);
    expect(mem.links).toEqual([]);
    const ok = await fetch(`${base.replace(/\/api$/, '')}/termag/previews/confirm/${id}`, { method: 'POST', headers: { ...signedIn, 'content-type': 'application/x-www-form-urlencoded' }, body: `decision=publish&csrf=${csrf}`, redirect: 'manual' });
    expect(ok.status).toBe(303);
    expect(mem.links).toMatchObject([{ name: 'webapp', port: 5173, audience: 'owner', requestId: 'creq00000001' }]);
    expect(mem.requests[0].state).toBe('approved');
    // An open Share dialog reloads, dropping the request it no longer offers (Bugbot, #1568).
    expect(built.pushed).toEqual(['alice']);
    // The pending page said both lifetimes: the link's and the request's (Bugbot, #1568).
    expect(html).toMatch(/This link works until .* UTC\. The agent's request waits in the project's Share dialog until .* UTC\./);
    // The agent never sees the link, so the owner gets it on the page (Bugbot, #1568).
    const after = await (await fetch(`${base.replace(/\/api$/, '')}/termag/previews/confirm/${id}`, { headers: signedIn })).text();
    expect(after).toContain('<a href="https://termag.example/termag/previews/webapp">https://termag.example/termag/previews/webapp</a>');
    expect(after).not.toContain('The terminal that asked shows the link');
  });

  it('a request already answered in the Share dialog settles its confirm: neither button can contradict it (Bugbot, #1568)', async () => {
    await ask(boxToken, { project: 'webapp', port: 5173 });
    const id = idOf(built.told[1].slack!);
    const page = `${base.replace(/\/api$/, '')}/termag/previews/confirm/${id}`;
    const csrf = /name="csrf" value="([^"]+)"/.exec(await (await fetch(page, { headers: signedIn })).text())![1];
    // Declined in the links list first.
    expect((await call('POST', '/preview-link-requests/creq00000001/decline', signedIn)).status).toBe(200);
    const after = await (await fetch(page, { headers: signedIn })).text();
    expect(after).toContain('already answered in the project&#39;s Share dialog (declined)');
    expect(after).not.toContain('name="decision" value="publish"');
    await fetch(page, { method: 'POST', headers: { ...signedIn, 'content-type': 'application/x-www-form-urlencoded' }, body: `decision=publish&csrf=${csrf}`, redirect: 'manual' });
    expect(mem.links).toEqual([]);
    expect(mem.requests[0].state).toBe('declined');
  });

  it('after the link lapses, a request answered in Share still says so, not that it waits (Bugbot, #1568)', async () => {
    await ask(boxToken, { project: 'webapp', port: 5173 });
    const id = idOf(built.told[1].slack!);
    expect((await call('POST', '/preview-link-requests/creq00000001/decline', signedIn)).status).toBe(200);
    // Ten minutes on: the confirmation reads as expired first.
    const [row] = [...built.confirmations.rows.values()];
    row.expiresAt = new Date(NOW - 1000);
    const page = await (await fetch(`${base.replace(/\/api$/, '')}/termag/previews/confirm/${id}`, { headers: signedIn })).text();
    expect(page).toContain('already answered in the project&#39;s Share dialog (declined)');
    expect(page).not.toContain('waits in the project');
  });

  // Pinning (Bugbot, #1568): approving an agent's ask makes a link for its port; it never renews another live link
  // under the same name, moving its port and narrowing its audience.
  it('two asks of one workstream get names of their own, and a request\'s publish never renews a live link (Bugbot, #1568)', async () => {
    const page = (id: string) => `${base.replace(/\/api$/, '')}/termag/previews/confirm/${id}`;
    const publish = async (id: string) => {
      const csrf = /name="csrf" value="([^"]+)"/.exec(await (await fetch(page(id), { headers: signedIn })).text())![1];
      return fetch(page(id), { method: 'POST', headers: { ...signedIn, 'content-type': 'application/x-www-form-urlencoded' }, body: `decision=publish&csrf=${csrf}`, redirect: 'manual' });
    };
    await ask(boxToken, { project: 'webapp', port: 5173 });
    await ask(boxToken, { project: 'webapp', port: 3000 });
    const dms = built.told.filter(t => t.slack).map(t => t.slack!);
    expect(dms[0]).toContain('as `webapp`:');
    expect(dms[1]).toContain('as `webapp-3000`:');
    await publish(idOf(dms[0]));
    await publish(idOf(dms[1]));
    expect(mem.links.map(l => [l.name, l.port]).sort()).toEqual([['webapp', 5173], ['webapp-3000', 3000]]);
    // With "webapp" live, a new ask for another port is named for its port.
    await ask(boxToken, { project: 'webapp', port: 4000 });
    expect(built.told.filter(t => t.slack).at(-1)!.slack).toContain('as `webapp-4000`:');
    // Asked again at once, the approved request answers it, with no DM (#1568).
    expect(await ask(boxToken, { project: 'webapp', port: 3000 })).toMatchObject({ status: 200, body: { state: 'approved', repeated: true } });
    expect(built.told.filter(t => t.slack)).toHaveLength(3);
    // Past the cool-down, with its link still live: never a port's name that is live already, the next free one
    // (Bugbot, #1568).
    built.requests.now = () => new Date(NOW + 13 * 3600_000);
    await ask(boxToken, { project: 'webapp', port: 3000 });
    expect(built.told.filter(t => t.slack).at(-1)!.slack).toContain('as `webapp-3000-2`:');
  });

  // Pinning (Bugbot, #1568): preview names are global, so an ask is never named for one held elsewhere.
  it('an ask is never named for a name another owner holds, here or in another project (Bugbot, #1568)', async () => {
    const held = { ownerId: 'bob', reservedUntil: new Date(NOW + 30 * 24 * 3600_000), linkId: null };
    mem.names.set('webapp', { name: 'webapp', ...held } as never);
    mem.names.set('webapp-5173', { name: 'webapp-5173', ...held } as never);
    await ask(boxToken, { project: 'webapp', port: 5173 });
    expect(built.told.filter(t => t.slack).at(-1)!.slack).toContain('as `webapp-5173-2`:');
    // The name back with its owner, but another ask of the workstream still pending: the port's own name.
    mem.names.set('webapp', { name: 'webapp', ownerId: 'alice', reservedUntil: new Date(NOW + 3600_000), linkId: null } as never);
    await ask(boxToken, { project: 'webapp', port: 4000 });
    expect(built.told.filter(t => t.slack).at(-1)!.slack).toContain('as `webapp-4000`:');
  });

  it('a request\'s one click refuses, rather than renews, a name that went live since it was asked (Bugbot, #1568)', async () => {
    await ask(boxToken, { project: 'webapp', port: 5173 });
    const id = idOf(built.told.filter(t => t.slack)[0].slack!);
    // Meanwhile the owner publishes "webapp" themselves, for another port.
    expect((await call('POST', `/projects/${PROJECT}/preview-links`, signedIn, { port: 4000, name: 'webapp' })).status).toBe(201);
    const url = `${base.replace(/\/api$/, '')}/termag/previews/confirm/${id}`;
    const csrf = /name="csrf" value="([^"]+)"/.exec(await (await fetch(url, { headers: signedIn })).text())![1];
    await fetch(url, { method: 'POST', headers: { ...signedIn, 'content-type': 'application/x-www-form-urlencoded' }, body: `decision=publish&csrf=${csrf}`, redirect: 'manual' });
    expect(mem.links).toMatchObject([{ name: 'webapp', port: 4000 }]);
    expect(mem.requests[0].state).toBe('pending');
    expect(await (await fetch(url, { headers: signedIn })).text()).toContain('is a live link already; publish this request under another name');
  });

  it('an expired confirm says the request still waits in Share only while it does (Bugbot, #1568)', async () => {
    await ask(boxToken, { project: 'webapp', port: 5173 });
    const id = idOf(built.told[1].slack!);
    const page = async () => (await fetch(`${base.replace(/\/api$/, '')}/termag/previews/confirm/${id}`, { headers: signedIn })).text();
    const now = built.deps.now;
    try {
      // The 10-minute link lapsed; the request has hours left.
      built.deps.now = () => new Date(NOW + 11 * 60_000);
      expect(await page()).toContain("The agent's request waits in the project's Share dialog until 2026-11-01 12:00 UTC.");
      // A day on: the request is past its 24 hours too, swept or not.
      built.deps.now = () => new Date(NOW + 25 * 3600_000);
      const late = await page();
      expect(late).toContain("the agent's request has expired too");
      expect(late).not.toContain('waits in the project');
      built.deps.now = () => new Date(NOW + 11 * 60_000);
      mem.requests[0].state = 'expired';
      expect(await page()).toContain("the agent's request has expired too");
    } finally {
      built.deps.now = now;
    }
  });

  it('asks taken back because the owner couldn\'t be told don\'t spend the box\'s hourly limit (Devin, #1568)', async () => {
    const create = built.confirm.store.create;
    built.confirm.store.create = async () => { throw new Error('db down'); };
    for (let i = 0; i < 12; i++) expect(await ask(boxToken, { project: 'webapp', port: 5173 })).toMatchObject({ status: 503, body: { code: 'try_again' } });
    built.confirm.store.create = create;
    expect(await ask(boxToken, { project: 'webapp', port: 5173 })).toMatchObject({ status: 201 });
    expect(built.told.filter(t => t.slack)).toHaveLength(1);
  });

  it('an ask whose owner couldn\'t be asked is taken back, so the retry asks afresh (Bugbot, #1568)', async () => {
    const create = built.confirm.store.create;
    built.confirm.store.create = async () => { throw new Error('db down'); };
    expect(await ask(boxToken, { project: 'webapp', port: 5173 })).toMatchObject({ status: 503, body: { code: 'try_again' } });
    expect(mem.requests[0].state).toBe('withdrawn');
    built.confirm.store.create = create;
    expect(await ask(boxToken, { project: 'webapp', port: 5173 })).toMatchObject({ status: 201, body: { request: { id: 'creq00000002' } } });
    expect(built.told.filter(t => t.slack)).toHaveLength(1);
  });

  it('a request whose owner was never asked (taking it back failed too) asks them on the retry, not just answers it (Bugbot, #1568)', async () => {
    const create = built.confirm.store.create;
    const withdraw = built.requests.store.withdraw;
    built.confirm.store.create = async () => { throw new Error('db down'); };
    built.requests.store.withdraw = async () => { throw new Error('db down'); };
    expect(await ask(boxToken, { project: 'webapp', port: 5173 })).toMatchObject({ status: 503, body: { code: 'try_again' } });
    expect(mem.requests[0].state).toBe('pending');
    built.confirm.store.create = create;
    built.requests.store.withdraw = withdraw;
    expect(await ask(boxToken, { project: 'webapp', port: 5173 })).toMatchObject({ status: 200, body: { repeated: true, request: { id: 'creq00000001' } } });
    expect(built.told.filter(t => t.slack)).toHaveLength(1);
    expect(built.told.filter(t => t.workspace)).toHaveLength(1);
    // Asked now: a further repeat tells them nothing more.
    await ask(boxToken, { project: 'webapp', port: 5173 });
    expect(built.told.filter(t => t.slack)).toHaveLength(1);
  });

  it('a box-made sign-in can\'t answer an agent\'s request, so its confirm never wears the ask\'s framing or note (#1568)', async () => {
    flags.audiences = true;
    await ask(boxToken, { project: 'webapp', port: 5173, note: 'the Vite app' });
    const asked = built.confirmations.rows.size;
    for (const audience of ['link', 'owner']) {
      const r = await call('POST', '/cli/v1/preview-links', deviceOnBox, { project: PROJECT, port: 5173, name: 'my-app', audience, requestId: 'creq00000001' });
      expect(r).toMatchObject({ status: 400, body: { code: 'not_allowed' } });
    }
    expect(built.confirmations.rows.size).toBe(asked);
    expect(mem.links).toEqual([]);
    expect(mem.requests).toMatchObject([{ id: 'creq00000001', state: 'pending' }]);
    // Without one, the box's wider publish is held as ever, and its page is no agent's ask.
    const held = await call('POST', '/cli/v1/preview-links', deviceOnBox, { project: PROJECT, port: 5173, name: 'my-app', audience: 'link' });
    expect(held).toMatchObject({ status: 202 });
    const page = `${base.replace(/\/api$/, '')}${new URL(held.body.confirm.url as string).pathname}`;
    const html = await (await fetch(page, { headers: signedIn })).text();
    expect(html).not.toContain('the Vite app');
    expect(html).not.toContain('termag preview request');
    expect(html).toContain('a sign-in made on the box');
  });

  it('the Slack DM says who "only me" lets in: the owner and the project\'s collaborators (#1568)', async () => {
    await ask(boxToken, { project: 'webapp', port: 5173 });
    expect(built.told[1].slack).toContain("for you and the project's collaborators only");
  });

  // Pinning (#1568): a looping or prompt-injected agent can't turn each decline or expiry into a fresh
  // one-click DM. A request answered lately answers the repeat, telling the agent how and when, and never the link.
  it('a repeat after a decline or an expiry is answered for 12 hours, with no new request and no DM, then may ask again (#1568)', async () => {
    await ask(boxToken, { project: 'webapp', port: 5173 });
    expect((await call('POST', '/preview-link-requests/creq00000001/decline', signedIn)).status).toBe(200);
    const again = await ask(boxToken, { project: 'webapp', port: 5173 });
    expect(again).toMatchObject({ status: 200, body: { state: 'declined', repeated: true, decidedAt: new Date(NOW).toISOString(), askAgainAfter: new Date(NOW + ANSWERED_COOLDOWN_HOURS * 3600_000).toISOString(), request: { id: 'creq00000001' } } });
    expect(mem.requests).toHaveLength(1);
    expect(built.told.filter(t => t.slack)).toHaveLength(1);
    // An expiry answers it just the same, for another port.
    await ask(boxToken, { project: 'webapp', port: 3000 });
    Object.assign(mem.requests[1], { state: 'expired', decidedAt: new Date(NOW) });
    expect(await ask(boxToken, { project: 'webapp', port: 3000 })).toMatchObject({ status: 200, body: { state: 'expired', repeated: true } });
    expect(built.told.filter(t => t.slack)).toHaveLength(2);
    // Answered lately doesn't spend the hour: no row was made for either repeat.
    expect(mem.requests).toHaveLength(2);
    // Past the window, the owner may be asked once more.
    built.requests.now = () => new Date(NOW + (ANSWERED_COOLDOWN_HOURS * 3600_000) + 60_000);
    expect(await ask(boxToken, { project: 'webapp', port: 5173 })).toMatchObject({ status: 201, body: { request: { id: 'creq00000003' } } });
    expect(built.told.filter(t => t.slack)).toHaveLength(3);
  });

  it('a repeat after the owner published it says approved, and when, but never the link or its address (#1568)', async () => {
    await ask(boxToken, { project: 'webapp', port: 5173 });
    const id = idOf(built.told[1].slack!);
    const page = `${base.replace(/\/api$/, '')}/termag/previews/confirm/${id}`;
    const csrf = /name="csrf" value="([^"]+)"/.exec(await (await fetch(page, { headers: signedIn })).text())![1];
    await fetch(page, { method: 'POST', headers: { ...signedIn, 'content-type': 'application/x-www-form-urlencoded' }, body: `decision=publish&csrf=${csrf}`, redirect: 'manual' });
    expect(mem.links).toHaveLength(1);
    const r = await ask(boxToken, { project: 'webapp', port: 5173 });
    expect(r).toMatchObject({ status: 200, body: { state: 'approved', repeated: true, decidedAt: expect.any(String) } });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(mem.links[0].name);
    expect(text).not.toMatch(/https?:\/\/|previews\//);
    expect(built.told.filter(t => t.slack)).toHaveLength(1);
  });

  it('a repeat while the first ask is still telling the owner joins it: one confirm, one DM, the request still pending (Bugbot, #1568)', async () => {
    const create = built.confirm.store.create;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    built.confirm.store.create = async (...a: Parameters<typeof create>) => { await gate; return create(...a); };
    const first = ask(boxToken, { project: 'webapp', port: 5173 });
    // The first ask has claimed the request and is holding its confirm when the agent retries.
    for (let i = 0; i < 50 && mem.requests.length === 0; i++) await new Promise(r => setTimeout(r, 5));
    const second = ask(boxToken, { project: 'webapp', port: 5173 });
    await new Promise(r => setTimeout(r, 50));
    release();
    expect(await first).toMatchObject({ status: 201, body: { request: { id: 'creq00000001' } } });
    expect(await second).toMatchObject({ status: 200, body: { repeated: true, request: { id: 'creq00000001' } } });
    built.confirm.store.create = create;
    expect(built.confirmations.rows.size).toBe(1);
    expect(built.told.filter(t => t.slack)).toHaveLength(1);
    expect(mem.requests).toMatchObject([{ id: 'creq00000001', state: 'pending' }]);
  });

  it('a repeat whose own try would fail can\'t withdraw the request the first ask is still telling the owner about (Bugbot, #1568)', async () => {
    const create = built.confirm.store.create;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let calls = 0;
    // The first ask's confirm is slow and succeeds; any other try fails at once.
    built.confirm.store.create = async (...a: Parameters<typeof create>) => {
      if (++calls > 1) throw new Error('db down');
      await gate;
      return create(...a);
    };
    const first = ask(boxToken, { project: 'webapp', port: 5173 });
    for (let i = 0; i < 50 && mem.requests.length === 0; i++) await new Promise(r => setTimeout(r, 5));
    const second = ask(boxToken, { project: 'webapp', port: 5173 });
    await new Promise(r => setTimeout(r, 50));
    release();
    expect(await first).toMatchObject({ status: 201 });
    expect(await second).toMatchObject({ status: 200, body: { repeated: true } });
    built.confirm.store.create = create;
    expect(calls).toBe(1);
    // The owner's confirm link is for a request that is still pending, not one taken back under it.
    expect(mem.requests).toMatchObject([{ id: 'creq00000001', state: 'pending' }]);
    expect(built.told.filter(t => t.slack)).toHaveLength(1);
  });

  it('Decline whose request can\'t be declined leaves the confirm pending, not declined (Bugbot, #1568)', async () => {
    await ask(boxToken, { project: 'webapp', port: 5173 });
    const id = idOf(built.told[1].slack!);
    const page = `${base.replace(/\/api$/, '')}/termag/previews/confirm/${id}`;
    const csrf = /name="csrf" value="([^"]+)"/.exec(await (await fetch(page, { headers: signedIn })).text())![1];
    const withName = mem.store.withName;
    mem.store.withName = async () => { throw new Error('db down'); };
    await fetch(page, { method: 'POST', headers: { ...signedIn, 'content-type': 'application/x-www-form-urlencoded' }, body: `decision=decline&csrf=${csrf}`, redirect: 'manual' });
    mem.store.withName = withName;
    expect(mem.requests[0].state).toBe('pending');
    expect([...built.confirmations.rows.values()][0].state).toBe('pending');
  });

  it('Decline on the confirm page declines the request too', async () => {
    await ask(boxToken, { project: 'webapp', port: 5173 });
    const id = idOf(built.told[1].slack!);
    const html = await (await fetch(`${base.replace(/\/api$/, '')}/termag/previews/confirm/${id}`, { headers: signedIn })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    await fetch(`${base.replace(/\/api$/, '')}/termag/previews/confirm/${id}`, { method: 'POST', headers: { ...signedIn, 'content-type': 'application/x-www-form-urlencoded' }, body: `decision=decline&csrf=${csrf}`, redirect: 'manual' });
    expect(mem.requests[0].state).toBe('declined');
    expect(mem.links).toEqual([]);
    expect(built.pushed).toEqual(['alice']);
  });
});
