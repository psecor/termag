import express from 'express';
import type { AddressInfo } from 'net';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => false), numberVariationForContext: vi.fn(async () => 24) }));
vi.mock('../slack/app', () => ({ getSlackApp: () => null }));
vi.mock('../services/briefing/slack', () => ({ slackIdFor: vi.fn() }));
vi.mock('../services/boxPower', () => ({ instanceStatus: vi.fn(async () => 'ready') }));
vi.mock('../services/userByEmail', () => ({ findUserByEmail: vi.fn() }));
vi.mock('../services/credentialStore', () => ({ readGithubAccess: vi.fn(async () => null) }));
vi.mock('../services/agentRegistry', () => ({
  projectAgentCapabilities: vi.fn(() => ['browser-pane-v1', 'browser-pane-profiles-v1']),
  sendForProject: vi.fn(async () => ({ ok: true })),
}));

import { sendForProject } from '../services/agentRegistry';
import { GithubApiError } from '../services/githubCredential';
import type { PrFacts } from '../services/prReview';
import { linkTokenFor, linkTokenHash, LINK_SHARE_DAYS } from '../services/previewShareRules';
import { onPreviewShareEnded, registerGuestSocket, resetLiveGuests, type GuestShareContext, type PreviewShareStore, type ShareRow } from '../services/previewShares';
import type { ShareGithub } from '../services/previewShareLinks';
import {
  createLinkShareFor, extendShareFor, installAutoPreviewShares, linkSharePath, previewLinkRouter, revokeViewerFor, saveSettingsFor, settingsFor, shareForGrantee,
  type PreviewShareRouteDeps,
} from './previewShares';
import { recordCreatedLink } from '../services/workstreamPrs';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const SECRET = 'test-secret';
const owner = { id: 'u-owner', displayName: 'Olive Owner', googleEmail: 'olive@x.test' } as User;
const viewer = { id: 'uviewer000001', displayName: 'Vic Viewer', googleEmail: 'vic@x.test' } as User;
const stranger = { id: 'ustranger0001', displayName: 'Sam', googleEmail: 'sam@x.test' } as User;
const project = { id: 'p1', name: 'webapp', userId: owner.id, archived: false, instanceId: 'box-1', instance: null, repoUrl: 'https://github.com/example-org/webapp' };

function linkRow(over: Partial<ShareRow> = {}): ShareRow {
  return {
    id: 'clink00000000001', projectId: 'p1', workstreamId: 'ws1', ownerId: owner.id, audience: 'link', granteeId: null,
    originRecipe: { kind: 'webapp-dev-stack' }, expiresAt: new Date(NOW + LINK_SHARE_DAYS * 86400e3), revokedAt: null, endedAt: null, endedReason: null,
    lastOpenedAt: null, createdAt: new Date(NOW), prRepo: 'example-org/webapp', prNumber: 42, prCommentId: null, prHeadOid: 'a'.repeat(40), ...over,
  };
}

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  state: 'OPEN', isDraft: false, repo: 'example-org/webapp', visibility: 'INTERNAL', headBranch: 'feat/x', headOid: 'b'.repeat(40),
  crossRepo: false, author: { login: 'olive', id: 7 }, viewer: { login: 'olive', id: 7 }, ...over,
});

function fakeGithub(over: Partial<ShareGithub> = {}): ShareGithub & { posted: string[]; edited: [string, string][] } {
  const posted: string[] = [];
  const edited: [string, string][] = [];
  return {
    posted, edited,
    readPr: vi.fn(async () => facts()),
    readScope: vi.fn(async () => ({ labels: [], paths: ['static/app.ts'], complete: true })),
    postComment: vi.fn(async (_ref, body) => { posted.push(body); return { id: '9001', url: 'https://github.com/example-org/webapp/pull/42#issuecomment-9001' }; }),
    editComment: vi.fn(async (_ref, id, body) => { edited.push([id, body]); }),
    ...over,
  };
}

/** The store's link-share half, in memory: one active link share per key, viewers per share. */
function fakeStore(initial: ShareRow[] = []) {
  const rows = [...initial];
  const viewers = new Map<string, { revokedAt: Date | null }>();
  const keys = new Map<string, string>();
  const hashes = new Map<string, string>();
  const events: any[] = [];
  for (const r of initial) if (!r.endedAt) keys.set(r.workstreamId ?? `${r.projectId}:main`, r.id);
  const store = {
    rows, viewers, events, hashes,
    guestContext: vi.fn(async (id: string, viewerId?: string): Promise<GuestShareContext | null> => {
      const s = rows.find(r => r.id === id);
      if (!s) return null;
      return {
        share: s,
        project: { id: 'p1', name: 'webapp', userId: owner.id, archived: false, instanceId: 'box-1', setupStatus: 'ready', ownerUnixUsername: 'olive', instance: null },
        owner, workstream: { name: 'feature-x', archived: false },
        ...(viewerId !== undefined && s.audience === 'link' ? { viewerRow: viewers.get(`${id}:${viewerId}`) ?? null } : {}),
      };
    }),
    prefs: { recipe: null as any, accountHint: null as string | null, prLinksEnabled: false, pathFilter: [] as string[] },
    settings: vi.fn(async function (this: any) { return { ...store.prefs }; }),
    saveSettings: vi.fn(async (_p: string, next: any) => { store.prefs = { ...next }; return { ...store.prefs }; }),
    recordEvent: vi.fn(async (shareId: string, kind: string, opts?: any) => { events.push({ shareId, kind, ...opts }); }),
    viewerIds: vi.fn(async (s: ShareRow) => [s.ownerId, ...[...viewers.keys()].filter(k => k.startsWith(`${s.id}:`)).map(k => k.split(':')[1])]),
    setComment: vi.fn(async (id: string, commentId: string | null) => { rows.find(r => r.id === id)!.prCommentId = commentId; }),
    claimComment: vi.fn(async (id: string, now: number) => {
      const r = rows.find(x => x.id === id)!;
      if (r.prCommentId !== null) return false;
      r.prCommentId = `pending:${now}`;
      return true;
    }),
    settleComment: vi.fn(async (id: string, at: number, commentId: string | null) => {
      const r = rows.find(x => x.id === id)!;
      if (r.prCommentId === `pending:${at}`) r.prCommentId = commentId;
    }),
    shareRow: vi.fn(async (id: string) => rows.find(x => x.id === id) ?? null),
    supersededBy: vi.fn(async (_id: string): Promise<number | null> => null),
    linkShareId: vi.fn(async (hash: string) => hashes.get(hash) ?? null),
    addViewer: vi.fn(async (id: string, userId: string) => {
      const key = `${id}:${userId}`;
      if (!viewers.has(key)) viewers.set(key, { revokedAt: null });
      return viewers.get(key)!;
    }),
    revokeViewer: vi.fn(async (projectId: string, id: string, userId: string) => {
      const v = viewers.get(`${id}:${userId}`);
      if (!v || v.revokedAt || !rows.some(r => r.id === id && r.projectId === projectId)) return false;
      v.revokedAt = new Date(NOW);
      return true;
    }),
    openLinkShare: vi.fn(async (input: any) => {
      const activeId = keys.get(input.linkKey);
      const active = rows.find(r => r.id === activeId);
      let ended: ShareRow | null = null;
      if (active) {
        if (!active.endedAt && active.prRepo === input.prRepo && active.prNumber === input.prNumber) return { share: active, existing: true, ended: null };
        active.endedAt = input.now; active.endedReason = 'superseded';
        ended = active;
      }
      const share = linkRow({ id: `clink${String(rows.length + 1).padStart(11, '0')}`, workstreamId: input.workstreamId, prRepo: input.prRepo, prNumber: input.prNumber, prHeadOid: input.prHeadOid, expiresAt: input.expiresAt, originRecipe: input.recipe });
      rows.push(share);
      keys.set(input.linkKey, share.id);
      hashes.set(input.hashFor(share.id), share.id);
      return { share, existing: false, ended };
    }),
    extend: vi.fn(async () => null),
  };
  return store as typeof store & PreviewShareStore;
}

function deps(over: Partial<PreviewShareRouteDeps> = {}, store = fakeStore(), github: ShareGithub | null = fakeGithub()): PreviewShareRouteDeps & { store: ReturnType<typeof fakeStore> } {
  return {
    store,
    findOwnedProject: vi.fn(async (userId: string, id: string) => (userId === owner.id && id === 'p1' ? project : null)),
    findWorkstream: vi.fn(),
    findBranch: vi.fn(async (_p: string, name: string) => (name === 'feature-x' ? { id: 'ws1', branch: 'feat/x' } : name === 'main' ? { id: null, branch: null } : undefined)),
    findUserByEmail: vi.fn(),
    findUser: vi.fn(async (id: string) => [owner, viewer, stranger].find(u => u.id === id) ?? null),
    isCollaborator: vi.fn(async () => false),
    sharingOn: vi.fn(async () => true),
    prLinksOn: vi.fn(async () => true),
    ttlDefault: vi.fn(async () => 24),
    boxStatus: vi.fn(async () => 'ready'),
    notifyWake: vi.fn(async () => true),
    githubFor: vi.fn(async () => github),
    siteBase: () => 'https://termag.test/termag',
    linkSecret: () => SECRET,
    now: () => NOW,
    ...over,
  } as any;
}

const asUser = (u: User) => ({ id: u.id }) as Express.User;
const ask = { workstream: 'feature-x', repo: 'example-org/webapp', number: 42 };

beforeEach(() => { resetLiveGuests(); vi.mocked(sendForProject).mockClear(); });

describe('making a PR link share', () => {
  it('checks the PR on GitHub, makes the share for 14 days, and posts its link on the PR', async () => {
    const github = fakeGithub();
    const d = deps({}, fakeStore(), github);
    const r = await createLinkShareFor(d, asUser(owner), 'p1', ask);
    expect(r.status).toBe(201);
    const body = r.body as any;
    const token = linkTokenFor(SECRET, body.id);
    expect(body).toMatchObject({
      link: `https://termag.test/termag/p/${token}`, linkPath: `/p/${token}`, existing: false,
      expiresAt: new Date(NOW + 14 * 86400e3).toISOString(),
      pr: { repo: 'example-org/webapp', number: 42, url: 'https://github.com/example-org/webapp/pull/42' },
      comment: { state: 'posted' },
    });
    expect(github.readPr).toHaveBeenCalledWith({ owner: 'example-org', name: 'webapp', number: 42 });
    expect(d.store.openLinkShare).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', workstreamId: 'ws1', linkKey: 'ws1', prHeadOid: 'b'.repeat(40) }));
    // Only the token's hash is kept, and the link is in the comment.
    expect(d.store.hashes.get(linkTokenHash(token))).toBe(body.id);
    expect(github.posted[0]).toContain(body.link);
    expect(github.posted[0]).toContain('reviewer@example.com / example-password');
    expect(d.store.rows[0].prCommentId).toBe('9001');
  });

  it('a second ask for the same PR returns the same share, and posts no second comment', async () => {
    const github = fakeGithub();
    const d = deps({}, fakeStore(), github);
    const first = await createLinkShareFor(d, asUser(owner), 'p1', ask);
    const again = await createLinkShareFor(d, asUser(owner), 'p1', ask);
    expect(again).toMatchObject({ status: 200, body: { id: (first.body as any).id, link: (first.body as any).link, existing: true, comment: { state: 'kept' } } });
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });

  it('another PR for the workstream supersedes the first: its guests close and its comment says where it moved', async () => {
    const github = fakeGithub();
    const store = fakeStore();
    const d = deps({}, store, github);
    const ended: [string, string, unknown][] = [];
    const off = onPreviewShareEnded((s, reason, detail) => { ended.push([s.id, reason, detail]); });
    try {
      const first = await createLinkShareFor(d, asUser(owner), 'p1', ask);
      const firstId = (first.body as any).id;
      const close = vi.fn();
      const unregister = registerGuestSocket(firstId, { viewerId: viewer.id, close, reconnect: vi.fn() });
      const second = await createLinkShareFor(d, asUser(owner), 'p1', { ...ask, number: 43 });
      unregister();
      expect(second.status).toBe(201);
      expect((second.body as any).id).not.toBe(firstId);
      expect(close).toHaveBeenCalledWith('This preview has ended.');
      expect(ended).toEqual([[firstId, 'superseded', { supersededBy: 43 }]]);
    } finally { off(); }
  });

  it('refuses a PR that is not the owner\'s, open, ready, private, this repo\'s or this branch\'s, with GitHub\'s reason', async () => {
    const cases: [Partial<PrFacts>, string][] = [
      [{ state: 'MERGED' }, 'not-open'], [{ isDraft: true }, 'draft'], [{ visibility: 'PUBLIC' }, 'public'],
      [{ repo: 'example-org/termag' }, 'other-repo'], [{ author: { login: 'gus', id: 8 } }, 'not-author'],
      [{ headBranch: 'other' }, 'other-branch'], [{ crossRepo: true }, 'fork'],
    ];
    for (const [over, code] of cases) {
      const d = deps({}, fakeStore(), fakeGithub({ readPr: vi.fn(async () => facts(over)) }));
      const r = await createLinkShareFor(d, asUser(owner), 'p1', ask);
      expect(r, code).toMatchObject({ status: 409, body: { code } });
      expect(d.store.openLinkShare).not.toHaveBeenCalled();
    }
  });

  it('refuses a project without a repository on record, a PR outside the orgs, and someone else\'s project', async () => {
    const noRepo = deps({ findOwnedProject: vi.fn(async () => ({ ...project, repoUrl: null })) });
    expect(await createLinkShareFor(noRepo, asUser(owner), 'p1', ask)).toMatchObject({ status: 409, body: { code: 'no-repo' } });
    expect((await createLinkShareFor(deps(), asUser(owner), 'p1', { ...ask, repo: 'evil/webapp' })).status).toBe(400);
    expect((await createLinkShareFor(deps(), asUser(owner), 'p1', { ...ask, number: 'x' })).status).toBe(400);
    expect((await createLinkShareFor(deps(), asUser(stranger), 'p1', ask)).status).toBe(404);
    expect((await createLinkShareFor(deps(), asUser(owner), 'p1', { ...ask, workstream: 'gone' })).status).toBe(404);
  });

  it('needs both flags, and the owner\'s GitHub', async () => {
    expect(await createLinkShareFor(deps({ prLinksOn: vi.fn(async () => false) }), asUser(owner), 'p1', ask)).toMatchObject({ status: 403, body: { code: 'pr-links-disabled' } });
    expect(await createLinkShareFor(deps({ sharingOn: vi.fn(async () => false) }), asUser(owner), 'p1', ask)).toMatchObject({ status: 403 });
    expect(await createLinkShareFor(deps({}, fakeStore(), null), asUser(owner), 'p1', ask)).toMatchObject({ status: 409, body: { code: 'github-not-connected' } });
    const refused = deps({}, fakeStore(), fakeGithub({ readPr: vi.fn(async () => { throw new GithubApiError('no', 401); }) }));
    expect(await createLinkShareFor(refused, asUser(owner), 'p1', ask)).toMatchObject({ status: 502, body: { code: 'github-reconnect' } });
    const missing = deps({}, fakeStore(), fakeGithub({ readPr: vi.fn(async () => { throw new GithubApiError('no', 404); }) }));
    expect(await createLinkShareFor(missing, asUser(owner), 'p1', ask)).toMatchObject({ status: 404, body: { code: 'no-such-pr' } });
  });

  it('a credential store that can\'t be read is a retry, not a missing token', async () => {
    const d = deps({ githubFor: vi.fn(async () => { throw new Error('KMS throttled'); }) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await createLinkShareFor(d, asUser(owner), 'p1', ask)).toMatchObject({ status: 503, body: { code: 'credential-unavailable' } });
    warn.mockRestore();
    expect(d.store.openLinkShare).not.toHaveBeenCalled();
  });

  it('two asks at once post one comment', async () => {
    let release!: () => void;
    const github = fakeGithub({ postComment: vi.fn(() => new Promise<{ id: string; url: null }>(r => { release = () => r({ id: '9001', url: null }); })) });
    const d = deps({}, fakeStore(), github);
    const first = createLinkShareFor(d, asUser(owner), 'p1', ask);
    await vi.waitFor(() => expect(github.postComment).toHaveBeenCalledTimes(1));
    const second = await createLinkShareFor(d, asUser(owner), 'p1', ask);
    // The first holds the claim and is posting it: the second says so, rather than that it is on the PR.
    expect((second.body as any).comment).toEqual({ state: 'posting' });
    release();
    expect(((await first).body as any).comment).toMatchObject({ state: 'posted' });
    expect(github.postComment).toHaveBeenCalledTimes(1);
    expect(d.store.rows[0].prCommentId).toBe('9001');
  });

  it('a share that ends while its comment is posted gets its comment edited once it lands', async () => {
    let release!: () => void;
    const github = fakeGithub({ postComment: vi.fn(() => new Promise<{ id: string; url: null }>(r => { release = () => r({ id: '9001', url: null }); })) });
    const d = deps({}, fakeStore(), github);
    const made = createLinkShareFor(d, asUser(owner), 'p1', ask);
    await vi.waitFor(() => expect(github.postComment).toHaveBeenCalledTimes(1));
    const row = d.store.rows[0];
    row.endedAt = new Date(NOW); row.endedReason = 'revoked';
    release();
    await made;
    expect(github.edited).toEqual([['9001', expect.stringContaining('stopped by its owner')]]);
  });

  it('one superseded while its comment is posted says which PR it moved to', async () => {
    let release!: () => void;
    const github = fakeGithub({ postComment: vi.fn(() => new Promise<{ id: string; url: null }>(r => { release = () => r({ id: '9001', url: null }); })) });
    const d = deps({}, fakeStore(), github);
    vi.mocked(d.store.supersededBy).mockResolvedValue(43);
    const made = createLinkShareFor(d, asUser(owner), 'p1', ask);
    await vi.waitFor(() => expect(github.postComment).toHaveBeenCalledTimes(1));
    const row = d.store.rows[0];
    row.endedAt = new Date(NOW); row.endedReason = 'superseded';
    release();
    await made;
    expect(d.store.supersededBy).toHaveBeenCalledWith(row.id);
    expect(github.edited).toEqual([['9001', expect.stringContaining('moved to #43')]]);
  });

  it('a token that may not comment still makes the share: the owner is told, and can copy the link', async () => {
    const github = fakeGithub({ postComment: vi.fn(async () => { throw new GithubApiError('Resource not accessible', 403); }) });
    const d = deps({}, fakeStore(), github);
    const r = await createLinkShareFor(d, asUser(owner), 'p1', ask);
    expect(r.status).toBe(201);
    expect((r.body as any).comment).toEqual({ state: 'failed', error: expect.stringContaining('Pull requests: write') });
    expect(d.store.rows[0].prCommentId).toBeNull();
    // Asking again tries the comment again.
    vi.mocked(github.postComment).mockResolvedValueOnce({ id: '77', url: null });
    expect(((await createLinkShareFor(d, asUser(owner), 'p1', ask)).body as any).comment).toEqual({ state: 'posted', url: null });
  });

  it('a link share is not extended: its PR decides', async () => {
    const d = deps({}, fakeStore([linkRow()]));
    expect(await extendShareFor(d, asUser(owner), 'p1', 'clink00000000001', { ttlHours: 168 })).toMatchObject({ status: 409, body: { code: 'link-share' } });
  });
});

describe('a link share\'s viewers', () => {
  it('only someone with a viewer row is let in, and the owner can revoke one viewer alone', async () => {
    const store = fakeStore([linkRow()]);
    const d = deps({}, store);
    // Nobody has opened its link: the share id alone shows nothing.
    expect(await shareForGrantee(d, asUser(viewer), 'clink00000000001')).toMatchObject({ status: 404 });
    await store.addViewer('clink00000000001', viewer.id);
    const seen = await shareForGrantee(d, asUser(viewer), 'clink00000000001');
    expect(seen).toMatchObject({ status: 200, body: { state: 'active', pr: { repo: 'example-org/webapp', number: 42, headOid: 'a'.repeat(40) } } });
    const close = vi.fn();
    const other = vi.fn();
    const off1 = registerGuestSocket('clink00000000001', { viewerId: viewer.id, close, reconnect: vi.fn() });
    const off2 = registerGuestSocket('clink00000000001', { viewerId: stranger.id, close: other, reconnect: vi.fn() });
    expect(await revokeViewerFor(d, asUser(owner), 'p1', 'clink00000000001', viewer.id)).toMatchObject({ status: 200 });
    off1(); off2();
    expect(close).toHaveBeenCalledWith('Its owner removed your access to this preview.');
    expect(other).not.toHaveBeenCalled();
    expect(sendForProject).toHaveBeenCalledWith(expect.anything(), 'browser-profile-forget', { profileKey: `guest:clink00000000001:${viewer.id}` }, 15000);
    expect(await shareForGrantee(d, asUser(viewer), 'clink00000000001')).toMatchObject({ status: 200, body: { state: 'viewer-revoked' } });
    // Not twice, not by someone else, not for a stranger.
    expect((await revokeViewerFor(d, asUser(owner), 'p1', 'clink00000000001', viewer.id)).status).toBe(404);
    expect((await revokeViewerFor(d, asUser(stranger), 'p1', 'clink00000000001', viewer.id)).status).toBe(404);
  });
});

describe('the share link for a link share', () => {
  async function get(store: ReturnType<typeof fakeStore>, path: string, userId: string | null, collaborator = false) {
    const a = express();
    a.use('/termag/p', previewLinkRouter('/termag', { store, isCollaborator: vi.fn(async () => collaborator), userId: () => userId, signIn: vi.fn(async () => '/termag/auth/login') }));
    const server = await new Promise<ReturnType<typeof a.listen>>(resolve => { const s = a.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { redirect: 'manual' });
      return { status: res.status, location: res.headers.get('location') };
    } finally { server.close(); }
  }

  it('the token makes the opener a viewer and sends them to the guest page; its owner goes to their own pane', async () => {
    const store = fakeStore([linkRow()]);
    const token = linkTokenFor(SECRET, 'clink00000000001');
    store.hashes.set(linkTokenHash(token), 'clink00000000001');
    expect(linkSharePath(SECRET, 'clink00000000001')).toBe(`/p/${token}`);
    expect(await get(store, `/termag/p/${token}?at=/flags`, viewer.id)).toEqual({ status: 302, location: '/termag/preview/clink00000000001?at=%2Fflags' });
    expect(store.viewers.get(`clink00000000001:${viewer.id}`)).toEqual({ revokedAt: null });
    const mine = await get(store, `/termag/p/${token}`, owner.id);
    expect(mine.location).toMatch(/^\/termag\/\?project=p1&ws=feature-x&browser=open&browserShare=clink00000000001/);
    expect(store.viewers.has(`clink00000000001:${owner.id}`)).toBe(false);
  });

  it('a wrong token is the uniform not-shared, and the share id alone makes nobody a viewer', async () => {
    const store = fakeStore([linkRow()]);
    expect((await get(store, `/termag/p/${'0'.repeat(32)}`, viewer.id)).status).toBe(404);
    expect(await get(store, '/termag/p/clink00000000001', viewer.id)).toEqual({ status: 302, location: '/termag/preview/clink00000000001' });
    expect(store.viewers.size).toBe(0);
  });

  it('someone signed out signs in first, and their viewer row waits for them to come back', async () => {
    const store = fakeStore([linkRow()]);
    const token = linkTokenFor(SECRET, 'clink00000000001');
    store.hashes.set(linkTokenHash(token), 'clink00000000001');
    expect(await get(store, `/termag/p/${token}`, null)).toEqual({ status: 302, location: '/termag/auth/login' });
    expect(store.viewers.size).toBe(0);
  });
});

describe('automatic shares of the PRs an owner opens (4c)', () => {
  const auto = (d: ReturnType<typeof deps>) => createLinkShareFor(d, asUser(owner), 'p1', ask, { auto: true });

  it('shares nothing, and asks GitHub nothing, unless the project says so', async () => {
    const github = fakeGithub();
    const d = deps({}, fakeStore(), github);
    expect(await auto(d)).toEqual({ status: 200, body: { skipped: 'off' } });
    expect(github.readPr).not.toHaveBeenCalled();
    // The owner's own click needs no opt-in.
    expect((await createLinkShareFor(d, asUser(owner), 'p1', ask)).status).toBe(201);
  });

  it('with the project opted in: the same checks as a click, then the label and the path filter', async () => {
    const github = fakeGithub();
    const d = deps({}, fakeStore(), github);
    d.store.prefs.prLinksEnabled = true;
    expect((await auto(d)).status).toBe(201);
    expect(github.readScope).toHaveBeenCalledWith({ owner: 'example-org', name: 'webapp', number: 42 });

    const labelled = deps({}, fakeStore(), fakeGithub({ readScope: vi.fn(async () => ({ labels: ['no-preview'], paths: ['static/a.ts'], complete: true })) }));
    labelled.store.prefs.prLinksEnabled = true;
    expect(await auto(labelled)).toEqual({ status: 200, body: { skipped: 'label' } });
    expect(labelled.store.openLinkShare).not.toHaveBeenCalled();

    const filtered = deps({}, fakeStore(), fakeGithub());
    filtered.store.prefs = { ...filtered.store.prefs, prLinksEnabled: true, pathFilter: ['internal/'] };
    expect(await auto(filtered)).toEqual({ status: 200, body: { skipped: 'paths' } });

    // A PR that isn't the owner's is refused before anything else, as for a click.
    const theirs = deps({}, fakeStore(), fakeGithub({ readPr: vi.fn(async () => facts({ author: { login: 'gus', id: 8 } })) }));
    theirs.store.prefs.prLinksEnabled = true;
    expect(await auto(theirs)).toMatchObject({ status: 409, body: { code: 'not-author' } });
  });

  it('runs on the pr_created milestone, through the workstream link it records', async () => {
    const github = fakeGithub();
    const d = deps({}, fakeStore(), github);
    d.store.prefs.prLinksEnabled = true;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const off = installAutoPreviewShares(d);
    try {
      await recordCreatedLink('olive-webapp-feature-x-agent', 'box-1', 'https://github.com/example-org/webapp/pull/42', {
        resolve: vi.fn(async () => ({ userId: owner.id, instanceId: 'box-1', projectId: 'p1', workstream: 'feature-x' })),
        store: { record: vi.fn(async () => true), list: vi.fn(), detach: vi.fn() },
      });
      await vi.waitFor(() => expect(d.store.openLinkShare).toHaveBeenCalledTimes(1));
      expect(d.store.openLinkShare).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', workstreamId: 'ws1', prNumber: 42 }));
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('shared automatically')));
    } finally { off(); log.mockRestore(); }
  });
});

describe('a project\'s preview settings (4c)', () => {
  it('its owner reads and saves them; a bad filter, hint or recipe is refused', async () => {
    const d = deps();
    expect(await settingsFor(d, asUser(owner), 'p1')).toEqual({ status: 200, body: { prLinksEnabled: false, pathFilter: [], reviewerAccountHint: null, recipe: null } });
    const saved = await saveSettingsFor(d, asUser(owner), 'p1', { prLinksEnabled: true, pathFilter: 'static/ internal/api', reviewerAccountHint: ' me@x / pw ' });
    expect(saved).toEqual({ status: 200, body: { prLinksEnabled: true, pathFilter: ['static/', 'internal/api'], reviewerAccountHint: 'me@x / pw', recipe: null } });
    // What isn't sent stays.
    expect((await saveSettingsFor(d, asUser(owner), 'p1', { prLinksEnabled: false })).body).toMatchObject({ pathFilter: ['static/', 'internal/api'], reviewerAccountHint: 'me@x / pw' });
    expect((await saveSettingsFor(d, asUser(owner), 'p1', { recipe: { kind: 'manual', origins: ['127.0.0.2:3000'] } })).body).toMatchObject({ recipe: { kind: 'manual', origins: ['127.0.0.2:3000'] } });
    expect((await saveSettingsFor(d, asUser(owner), 'p1', { recipe: null })).body).toMatchObject({ recipe: null });
    for (const bad of [{ prLinksEnabled: 'yes' }, { pathFilter: 'a/../b' }, { reviewerAccountHint: 'a\nb' }, { recipe: { kind: 'manual', origins: ['example.com:80'] } }]) {
      expect((await saveSettingsFor(d, asUser(owner), 'p1', bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('only the owner, and saving needs the flags', async () => {
    expect((await settingsFor(deps(), asUser(stranger), 'p1')).status).toBe(404);
    expect((await saveSettingsFor(deps(), asUser(stranger), 'p1', {})).status).toBe(404);
    expect(await saveSettingsFor(deps({ prLinksOn: vi.fn(async () => false) }), asUser(owner), 'p1', { prLinksEnabled: true })).toMatchObject({ status: 403 });
  });
});
