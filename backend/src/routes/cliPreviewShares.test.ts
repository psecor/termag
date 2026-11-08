import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { Instance, User } from '@prisma/client';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../middleware/auth', () => ({ requireAuth: () => {} }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => false), numberVariationForContext: vi.fn(async () => 24) }));
vi.mock('../slack/app', () => ({ getSlackApp: () => null }));
vi.mock('../services/briefing/slack', () => ({ slackIdFor: vi.fn() }));
vi.mock('../services/boxPower', () => ({ instanceStatus: vi.fn(async () => 'ready') }));
vi.mock('../services/userByEmail', () => ({ findUserByEmail: vi.fn() }));
vi.mock('../services/agentRegistry', () => ({
  projectAgentCapabilities: vi.fn(() => ['browser-pane-v1', 'browser-pane-profiles-v1']),
  sendForProject: vi.fn(async () => ({ ok: true })),
}));

const { cliApiRouter } = await import('./cliApi');
const { createCliPreviewShares } = await import('./cliPreviewSharesPrisma');
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');
type PreviewShareRouteDeps = import('./previewShares').PreviewShareRouteDeps;
type ShareRow = import('../services/previewShares').ShareRow;

const NOW = Date.parse('2026-10-29T12:00:00Z');
const alice = { id: 'alice', googleEmail: 'alice@x.test', displayName: 'Alice', unixUsername: 'alice' } as User;
const bob = { id: 'bob', googleEmail: 'bob@x.test', displayName: 'Bob', unixUsername: 'bob' } as User;
const box = { id: 'box-1', name: 'alicebox', kind: 'ec2', hostHome: '/home/alice' } as Instance;
const project = { id: 'p1', name: 'webapp', userId: alice.id, archived: false, instanceId: box.id, instance: box, repoUrl: 'https://github.com/example-org/webapp' };

const DEVICE_ALICE = 'tmcli_' + 'a'.repeat(64);
const DEVICE_BOB = 'tmcli_' + 'b'.repeat(64);
const BOX_TOKEN = 'tmag_box';

const sessionFor = (u: User, id: string): CliSessionRecord => ({
  id, userId: u.id, user: u as CliUser, deviceName: 'mbp', tokenPrefix: 'tmcli_xxx', createdAt: new Date(NOW), lastUsedAt: new Date(NOW), revokedAt: null,
});
const cliStore: CliStore = {
  async findSessionByHash(hash) {
    if (hash === sha256Hex(DEVICE_ALICE)) return sessionFor(alice, 's-alice');
    return hash === sha256Hex(DEVICE_BOB) ? sessionFor(bob, 's-bob') : null;
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

function row(over: Partial<ShareRow>): ShareRow {
  return {
    id: 'cshare0000000001', projectId: 'p1', workstreamId: 'ws1', ownerId: alice.id, audience: 'user', granteeId: bob.id,
    originRecipe: { kind: 'webapp-dev-stack' }, expiresAt: new Date(NOW + 3600e3), revokedAt: null, endedAt: null, endedReason: null,
    lastOpenedAt: null, createdAt: new Date(NOW), prRepo: null, prNumber: null, prCommentId: null, prHeadOid: null, prHeadBranch: null, checkoutDir: null,
    ...over,
  };
}

/** The owner's handlers' deps, in memory: the browser routes run over the same (previewShares.test.ts). */
function shareDeps() {
  const rows: ShareRow[] = [];
  const nextId = (prefix: string) => `${prefix}${String(rows.length + 1).padStart(16 - prefix.length, '0')}`;
  const store = {
    rows,
    guestContext: vi.fn(async (id: string) => {
      const share = rows.find(r => r.id === id);
      return share ? {
        share, owner: alice, workstream: { name: 'feature-x', archived: false },
        project: { id: 'p1', name: 'webapp', userId: alice.id, archived: false, instanceId: box.id, setupStatus: 'ready', ownerUnixUsername: 'alice', instance: box },
      } : null;
    }),
    liveFor: vi.fn(async () => null),
    liveOpenLink: vi.fn(async () => null),
    create: vi.fn(async (input: any) => { const s = row({ id: nextId('cuser'), workstreamId: input.workstreamId, granteeId: input.granteeId, expiresAt: input.expiresAt }); rows.push(s); return s; }),
    createOpenLink: vi.fn(async (input: any) => { const s = row({ id: nextId('copen'), audience: 'link', granteeId: null, workstreamId: input.workstreamId, expiresAt: input.expiresAt }); rows.push(s); return s; }),
    openLinkShare: vi.fn(async (input: any) => {
      const s = row({ id: nextId('clink'), audience: 'link', granteeId: null, workstreamId: input.workstreamId, expiresAt: input.expiresAt, prRepo: input.prRepo, prNumber: input.prNumber, prHeadOid: input.prHeadOid });
      rows.push(s);
      return { share: s, existing: false, ended: null };
    }),
    listForProject: vi.fn(async (projectId: string) => rows.filter(r => r.projectId === projectId).map(r => ({ id: r.id, audience: r.audience, workstream: 'feature-x' }))),
    revoke: vi.fn(async (projectId: string, id: string) => {
      const s = rows.find(r => r.id === id && r.projectId === projectId && !r.revokedAt);
      if (!s) return null;
      s.revokedAt = new Date(NOW); s.endedAt = new Date(NOW); s.endedReason = 'revoked';
      return s;
    }),
    extend: vi.fn(async (projectId: string, id: string, expiresAt: Date) => {
      const s = rows.find(r => r.id === id && r.projectId === projectId && !r.revokedAt);
      if (!s) return null;
      s.expiresAt = expiresAt;
      return s;
    }),
    settings: vi.fn(async () => ({ prLinksEnabled: null, pathFilter: [], accountHint: null, recipe: null })),
    claimComment: vi.fn(async () => true),
    settleComment: vi.fn(async () => {}),
    shareRow: vi.fn(async (id: string) => rows.find(r => r.id === id) ?? null),
    recordEvent: vi.fn(async () => {}),
    viewerIds: vi.fn(async (s: ShareRow) => [s.ownerId]),
  };
  const github = {
    readPr: vi.fn(async () => ({
      state: 'OPEN', isDraft: false, repo: 'example-org/webapp', visibility: 'INTERNAL', headBranch: 'feature-x', headOid: 'b'.repeat(40),
      crossRepo: false, author: { login: 'alice', id: 7 }, viewer: { login: 'alice', id: 7 },
    })),
    readScope: vi.fn(),
    postComment: vi.fn(async () => ({ id: '9001', url: 'https://github.com/example-org/webapp/pull/42#issuecomment-9001' })),
    editComment: vi.fn(),
  };
  const deps = {
    store,
    findOwnedProject: vi.fn(async (userId: string, id: string) => (userId === alice.id && id === 'p1' ? project : null)),
    findWorkstream: vi.fn(async (_p: string, name: string) => (name === 'feature-x' ? { id: 'ws1' } : name === 'main' ? { id: null } : undefined)),
    findBranch: vi.fn(async (_p: string, name: string) => (name === 'feature-x' ? { id: 'ws1', branch: 'feature-x' } : undefined)),
    listWorkstreams: vi.fn(async () => [{ id: null, name: 'main' }, { id: 'ws1', name: 'feature-x' }]),
    findCheckout: vi.fn(async () => ({ ok: false as const, reason: 'outdated-agent' as const, looked: [] })),
    findUserByEmail: vi.fn(async (email: string) => (email === bob.googleEmail ? bob : null)),
    findUser: vi.fn(async (id: string) => [alice, bob].find(u => u.id === id) ?? null),
    autoShareDefault: vi.fn(async () => false),
    draftSharesOn: vi.fn(async () => false),
    ttlDefault: vi.fn(async () => 24),
    checkStack: vi.fn(async () => ({ ok: true, primaryUrl: 'http://localhost/' })),
    githubFor: vi.fn(async () => github),
    siteBase: () => 'https://termag.example/termag',
    linkSecret: () => 'test-secret',
    now: () => NOW,
  };
  return { deps, store, github };
}

let fake: ReturnType<typeof shareDeps>;
let search: ReturnType<typeof vi.fn>;
let server: Server;
let base: string;

beforeEach(async () => {
  fake = shareDeps();
  search = vi.fn(async () => [{ email: 'bob@x.test', displayName: 'Bob' }]);
  const previewShares = createCliPreviewShares({ shares: fake.deps as unknown as PreviewShareRouteDeps, people: { search } });
  const app = express();
  app.use(express.json());
  app.use('/api/cli/v1', cliApiRouter({ store: cliStore, codes: new AuthCodeStore(), now: () => new Date(NOW), jwt: Promise.resolve(null as never), previewShares }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cli/v1`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as any };
}

const EVERY_ROUTE: Array<[string, string, unknown?]> = [
  ['POST', '/projects/p1/preview-shares', { email: 'bob@x.test', workstream: 'feature-x' }],
  ['GET', '/projects/p1/preview-shares'],
  ['GET', '/projects/p1/preview-share-stack?workstream=feature-x'],
  ['PATCH', '/projects/p1/preview-shares/cshare0000000001', { ttlHours: 72 }],
  ['DELETE', '/projects/p1/preview-shares/cshare0000000001'],
  ['POST', '/projects/p1/preview-shares/link', { workstream: 'feature-x', repo: 'example-org/webapp', number: 42 }],
  ['GET', '/users/search?q=bo'],
];

describe('the desktop\'s preview shares, for its owner\'s device sign-in', () => {
  it('shares a workstream with a named person, and by open link, as the browser route answers', async () => {
    const named = await call('POST', '/projects/p1/preview-shares', DEVICE_ALICE, { email: 'bob@x.test', workstream: 'feature-x' });
    expect(named).toEqual({ status: 201, body: { id: 'cuser00000000001', expiresAt: new Date(NOW + 24 * 3600e3).toISOString(), link: '/p/cuser00000000001', ttlHours: 24 } });
    expect(fake.store.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', workstreamId: 'ws1', ownerId: alice.id, granteeId: bob.id }));

    const open = await call('POST', '/projects/p1/preview-shares', DEVICE_ALICE, { audience: 'link', workstream: 'feature-x', ttlHours: 4 });
    expect(open).toMatchObject({ status: 201, body: { id: 'copen00000000002', ttlHours: 4, linkPath: expect.stringMatching(/^\/p\/[0-9a-f]{32}$/) } });
    expect(open.body.link).toBe(open.body.linkPath);
  });

  it('lists the project\'s shares, extends one and stops it', async () => {
    fake.store.rows.push(row({}), row({ id: 'copen00000000002', audience: 'link', granteeId: null }));
    const list = await call('GET', '/projects/p1/preview-shares', DEVICE_ALICE);
    expect(list.status).toBe(200);
    expect(list.body.shares).toEqual([
      { id: 'cshare0000000001', audience: 'user', workstream: 'feature-x' },
      { id: 'copen00000000002', audience: 'link', workstream: 'feature-x', linkPath: expect.stringMatching(/^\/p\/[0-9a-f]{32}$/) },
    ]);

    const extended = await call('PATCH', '/projects/p1/preview-shares/cshare0000000001', DEVICE_ALICE, { ttlHours: 72 });
    expect(extended).toEqual({ status: 200, body: { id: 'cshare0000000001', expiresAt: new Date(NOW + 72 * 3600e3).toISOString() } });

    expect(await call('DELETE', '/projects/p1/preview-shares/cshare0000000001', DEVICE_ALICE)).toEqual({ status: 200, body: { ok: true } });
    expect(fake.store.revoke).toHaveBeenCalledWith('p1', 'cshare0000000001', alice.id);
    expect(fake.store.rows[0].endedReason).toBe('revoked');
  });

  it('makes a PR\'s link share, read on GitHub with the owner\'s token and announced on the PR', async () => {
    const r = await call('POST', '/projects/p1/preview-shares/link', DEVICE_ALICE, { workstream: 'feature-x', repo: 'example-org/webapp', number: 42 });
    expect(r).toMatchObject({
      status: 201,
      body: {
        id: 'clink00000000001', existing: false, link: expect.stringMatching(/^https:\/\/termag\.example\/termag\/p\/[0-9a-f]{32}$/),
        pr: { repo: 'example-org/webapp', number: 42, url: 'https://github.com/example-org/webapp/pull/42' }, comment: { state: 'posted' },
      },
    });
    expect(fake.deps.githubFor).toHaveBeenCalledWith(alice.id);
    expect(fake.github.readPr).toHaveBeenCalledWith(expect.objectContaining({ owner: 'example-org', name: 'webapp', number: 42 }));
  });

  it('asks the box about the workstream\'s dev stack before sharing it', async () => {
    const r = await call('GET', '/projects/p1/preview-share-stack?workstream=feature-x', DEVICE_ALICE);
    expect(r).toEqual({ status: 200, body: { checked: true, ok: true } });
    expect(fake.deps.checkStack).toHaveBeenCalledWith({ userId: alice.id, instanceId: box.id }, expect.objectContaining({ cwd: '/home/alice/termag/projects/webapp/.worktrees/feature-x' }));
  });

  it('finds people to share with, never the caller', async () => {
    expect(await call('GET', '/users/search?q=bo', DEVICE_ALICE)).toEqual({ status: 200, body: { people: [{ email: 'bob@x.test', displayName: 'Bob' }] } });
    expect(search).toHaveBeenCalledWith('bo', alice.id);
    expect((await call('GET', `/users/search?q=${'x'.repeat(101)}`, DEVICE_ALICE)).status).toBe(400);
  });

  it('keeps the browser routes\' own checks: their preview-share flags and their validation', async () => {
    expect(await call('POST', '/projects/p1/preview-shares', DEVICE_ALICE, { audience: 'link', email: 'bob@x.test' })).toMatchObject({ status: 400, body: { code: 'email-with-link' } });
    expect(fake.store.create).not.toHaveBeenCalled();
    expect(fake.store.createOpenLink).not.toHaveBeenCalled();
  });
});

describe('who the desktop\'s preview shares refuse', () => {
  it('a box\'s own token, with 403 forbidden, before anything is read; no token at all, with 401', async () => {
    for (const [method, path, body] of EVERY_ROUTE) {
      const r = await call(method, path, BOX_TOKEN, body);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.code, `${method} ${path}`).toBe('forbidden');
      expect((await call(method, path, null, body)).status, `${method} ${path}`).toBe(401);
    }
    expect(fake.deps.findOwnedProject).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('someone else\'s project, as a route that isn\'t there', async () => {
    fake.store.rows.push(row({}));
    for (const [method, path, body] of EVERY_ROUTE.filter(([, p]) => p.startsWith('/projects/'))) {
      expect(await call(method, path, DEVICE_BOB, body), `${method} ${path}`).toMatchObject({ status: 404, body: { code: 'not_found' } });
    }
    expect(fake.store.create).not.toHaveBeenCalled();
    expect(fake.store.revoke).not.toHaveBeenCalled();
    expect(fake.store.extend).not.toHaveBeenCalled();
    expect(fake.deps.checkStack).not.toHaveBeenCalled();
    expect(fake.deps.githubFor).not.toHaveBeenCalled();
  });

  it('a person past the browser routes\' rate limit, and only that person', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 31; i += 1) codes.push((await call('GET', '/projects/p1/preview-shares', DEVICE_ALICE)).status);
    expect(codes.slice(0, 30).every(c => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
    // Bob, from the same address, has his own bucket: someone else's project, so the 404.
    expect((await call('GET', '/projects/p1/preview-shares', DEVICE_BOB)).status).toBe(404);
  });

  it('a project with no box, which the desktop can\'t reach', async () => {
    fake.deps.findOwnedProject.mockResolvedValue({ ...project, instanceId: null, instance: null });
    expect(await call('GET', '/projects/p1/preview-shares', DEVICE_ALICE)).toMatchObject({ status: 404, body: { code: 'not_found' } });
  });
});
