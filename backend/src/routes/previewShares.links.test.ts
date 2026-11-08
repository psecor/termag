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
import { WEBAPP_REVIEWER_ACCOUNT, linkTokenFor, linkTokenHash, LINK_SHARE_DAYS } from '../services/previewShareRules';
import { onPreviewShareEnded, registerGuestSocket, resetLiveGuests, type GuestShareContext, type PreviewShareStore, type ShareRow } from '../services/previewShares';
import type { ShareGithub } from '../services/previewShareLinks';
import {
  createLinkShareFor, createShareFor, extendShareFor, installAutoPreviewShares, linkSharePath, previewLinkRouter, revokeViewerFor, saveSettingsFor, settingsFor, shareForGrantee,
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
    lastOpenedAt: null, createdAt: new Date(NOW), prRepo: 'example-org/webapp', prNumber: 42, prCommentId: null, prHeadOid: 'a'.repeat(40),
    prHeadBranch: null, checkoutDir: null, ...over,
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
  const opened: any[] = [];
  const store = {
    rows, viewers, events, hashes, opened,
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
    // A project whose owner never saved its settings: prLinksEnabled is null.
    prefs: { recipe: null as any, accountHint: null as string | null, prLinksEnabled: null as boolean | null, pathFilter: [] as string[] },
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
      if (input.samePr) {
        const same = rows.find(r => !r.endedAt && r.ownerId === input.ownerId && r.prRepo?.toLowerCase() === input.prRepo.toLowerCase() && r.prNumber === input.prNumber);
        if (same) return { share: same, existing: true, ended: null };
      }
      const share = linkRow({
        id: `clink${String(rows.length + 1).padStart(11, '0')}`, workstreamId: input.workstreamId, prRepo: input.prRepo, prNumber: input.prNumber, prHeadOid: input.prHeadOid,
        expiresAt: input.expiresAt, originRecipe: input.recipe, prHeadBranch: input.prHeadBranch ?? null, checkoutDir: input.checkoutDir ?? null,
      });
      store.opened.push(input);
      rows.push(share);
      keys.set(input.linkKey, share.id);
      hashes.set(input.hashFor(share.id), share.id);
      return { share, existing: false, ended };
    }),
    extend: vi.fn(async (projectId: string, id: string, expiresAt: Date) => {
      const s = rows.find(r => r.id === id && r.projectId === projectId && !r.endedAt);
      if (!s) return null;
      s.expiresAt = expiresAt;
      return s;
    }),
    // Open links: a link share with no PR, renewed rather than made twice.
    liveOpenLink: vi.fn(async ({ projectId, workstreamIds, now }: { projectId: string; workstreamIds: (string | null)[]; now: Date }) => rows.find(r => r.projectId === projectId
      && r.audience === 'link' && !r.prRepo && r.prNumber === null && workstreamIds.includes(r.workstreamId) && !r.revokedAt && !r.endedAt && r.expiresAt.getTime() > now.getTime()) ?? null),
    createOpenLink: vi.fn(async (input: any) => {
      const share = linkRow({
        id: `copen${String(rows.length + 1).padStart(11, '0')}`, workstreamId: input.workstreamId, prRepo: null, prNumber: null, prHeadOid: null,
        originRecipe: input.recipe, expiresAt: input.expiresAt,
      });
      rows.push(share);
      hashes.set(input.hashFor(share.id), share.id);
      return share;
    }),
    renew: vi.fn(async (projectId: string, id: string, { recipe, expiresAt }: any) => {
      const s = rows.find(r => r.id === id && r.projectId === projectId && !r.revokedAt && !r.endedAt);
      if (!s) return null;
      s.originRecipe = recipe; s.expiresAt = expiresAt;
      return s;
    }),
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
    autoShareDefault: vi.fn(async () => false),
    draftSharesOn: vi.fn(async () => false),
    listWorkstreams: vi.fn(async () => [{ id: null, name: 'main' }, { id: 'ws1', name: 'feature-x' }]),
    // A box agent too old to report its checkouts: the share is bound to the project's repository and the workstream's branch.
    findCheckout: vi.fn(async () => ({ ok: false as const, reason: 'outdated-agent' as const, looked: [] })),
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
    expect(github.posted[0]).toContain(WEBAPP_REVIEWER_ACCOUNT);
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

  it('shares a draft when its repository allows drafts, asking only about a draft', async () => {
    const draftsOn = vi.fn(async () => true);
    const d = deps({ draftSharesOn: draftsOn }, fakeStore(), fakeGithub({ readPr: vi.fn(async () => facts({ isDraft: true })) }));
    expect((await createLinkShareFor(d, asUser(owner), 'p1', ask)).status).toBe(201);
    expect(draftsOn).toHaveBeenCalledWith(owner, project.instance, 'example-org/webapp');
    const ready = deps({ draftSharesOn: draftsOn });
    draftsOn.mockClear();
    expect((await createLinkShareFor(ready, asUser(owner), 'p1', ask)).status).toBe(201);
    expect(draftsOn).not.toHaveBeenCalled();
  });

  it('refuses a project without a repository on record, a PR outside the orgs, and someone else\'s project', async () => {
    const noRepo = deps({ findOwnedProject: vi.fn(async () => ({ ...project, repoUrl: null })) });
    expect(await createLinkShareFor(noRepo, asUser(owner), 'p1', ask)).toMatchObject({ status: 409, body: { code: 'no-repo' } });
    expect((await createLinkShareFor(deps(), asUser(owner), 'p1', { ...ask, repo: 'evil/webapp' })).status).toBe(400);
    expect((await createLinkShareFor(deps(), asUser(owner), 'p1', { ...ask, number: 'x' })).status).toBe(400);
    expect((await createLinkShareFor(deps(), asUser(stranger), 'p1', ask)).status).toBe(404);
    expect((await createLinkShareFor(deps(), asUser(owner), 'p1', { ...ask, workstream: 'gone' })).status).toBe(404);
  });

  it('needs the owner\'s GitHub', async () => {
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

describe('an open link: the share dialog with nobody named', () => {
  const openDeps = (over: Partial<PreviewShareRouteDeps> = {}, store = fakeStore(), github = fakeGithub()) => deps({
    findWorkstream: vi.fn(async (_p: string, name: string) => (name === 'feature-x' ? { id: 'ws1' } : name === 'main' ? { id: null } : undefined)),
    ...over,
  }, store, github);

  it('makes a link share with no PR for the dialog\'s lifetime, its link its token, and asks GitHub nothing', async () => {
    const github = fakeGithub();
    const d = openDeps({}, fakeStore(), github);
    const r = await createShareFor(d, asUser(owner), 'p1', { audience: 'link', workstream: 'feature-x', ttlHours: 72 });
    expect(r.status).toBe(201);
    const body = r.body as any;
    const token = linkTokenFor(SECRET, body.id);
    expect(body).toMatchObject({ link: `/p/${token}`, linkPath: `/p/${token}`, ttlHours: 72, expiresAt: new Date(NOW + 72 * 3600e3).toISOString() });
    expect(d.store.hashes.get(linkTokenHash(token))).toBe(body.id);
    expect(d.store.rows[0]).toMatchObject({ audience: 'link', workstreamId: 'ws1', prRepo: null, prNumber: null, granteeId: null });
    expect(d.store.events).toEqual([expect.objectContaining({ shareId: body.id, kind: 'created', actorId: owner.id, detail: { audience: 'link', ttlHours: 72 } })]);
    expect(d.githubFor).not.toHaveBeenCalled();
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it('lets in whoever opens its link, once that made their viewer row, and nobody by its id alone', async () => {
    const d = openDeps();
    const id = ((await createShareFor(d, asUser(owner), 'p1', { audience: 'link', workstream: 'feature-x' })).body as any).id;
    expect(await shareForGrantee(d, asUser(viewer), id)).toMatchObject({ status: 404 });
    await d.store.addViewer(id, viewer.id);
    expect(await shareForGrantee(d, asUser(viewer), id)).toMatchObject({ status: 200, body: { state: 'active', pr: null } });
    expect(await shareForGrantee(d, asUser(stranger), id)).toMatchObject({ status: 404 });
  });

  it('sharing by link again renews the workstream\'s open link, same link; a PR\'s link share there is another share', async () => {
    const d = openDeps({}, fakeStore([linkRow()]));
    const first = await createShareFor(d, asUser(owner), 'p1', { audience: 'link', workstream: 'feature-x' });
    expect(first.status).toBe(201);
    const { id, link } = first.body as any;
    expect(id).not.toBe('clink00000000001');
    const again = await createShareFor(d, asUser(owner), 'p1', { audience: 'link', workstream: 'feature-x', ttlHours: 168 });
    expect(again).toMatchObject({ status: 200, body: { id, link, renewed: true, expiresAt: new Date(NOW + 168 * 3600e3).toISOString() } });
    // A shorter lifetime asked for now keeps the later end.
    expect(await createShareFor(d, asUser(owner), 'p1', { audience: 'link', workstream: 'feature-x', ttlHours: 1 })).toMatchObject({ status: 200, body: { id, expiresAt: new Date(NOW + 168 * 3600e3).toISOString() } });
    expect(d.store.rows).toHaveLength(2);
    expect(d.store.rows[0].endedAt).toBeNull();
  });

  it('is extended like a share by name', async () => {
    const d = openDeps();
    const id = ((await createShareFor(d, asUser(owner), 'p1', { audience: 'link', workstream: 'feature-x' })).body as any).id;
    expect(await extendShareFor(d, asUser(owner), 'p1', id, { ttlHours: 168 })).toMatchObject({ status: 200, body: { id, expiresAt: new Date(NOW + 168 * 3600e3).toISOString() } });
  });

  it('is never what a missing email means', async () => {
    const d = openDeps();
    expect(await createShareFor(d, asUser(owner), 'p1', { workstream: 'feature-x' })).toMatchObject({ status: 400, body: { error: 'email is required' } });
    // Naming someone and asking for a link is refused, never widened to everyone.
    expect(await createShareFor(d, asUser(owner), 'p1', { audience: 'link', email: 'gus@x.test', workstream: 'feature-x' })).toMatchObject({ status: 400, body: { code: 'email-with-link' } });
    expect(await createShareFor(d, asUser(owner), 'p1', { audience: 'link', email: '  ', workstream: 'feature-x' })).toMatchObject({ status: 201 });
    d.store.rows.length = 0;
    expect(await createShareFor(d, asUser(stranger), 'p1', { audience: 'link', workstream: 'feature-x' })).toMatchObject({ status: 404 });
    expect(d.store.rows).toHaveLength(0);
  });
});

describe('4d: a link share from the PR\'s own checkout', () => {
  const olive = { ...owner, unixUsername: 'olive' } as User;
  // webapp#76005's setup: the project's folder is another repository, and webapp lives in ~/src beside it.
  const handbook = { ...project, name: 'Webapp', repoUrl: 'https://github.com/example-team/ffeld-termag' };
  const src = '/home/olive/src/webapp';
  const onMain = { workstream: 'main', repo: 'example-org/webapp', number: 42 };
  const fromSrc = { ok: true as const, dir: src, realDir: src, workstream: null, repo: 'example-org/webapp', branch: 'feat/x', head: 'b'.repeat(40) };
  const d4 = (over: Partial<PreviewShareRouteDeps> = {}, store = fakeStore(), github: ShareGithub | null = fakeGithub()) => deps({
    findOwnedProject: vi.fn(async (userId: string, id: string) => (userId === owner.id && id === 'p1' ? handbook : null)),
    findUser: vi.fn(async (id: string) => (id === owner.id ? olive : [viewer, stranger].find(u => u.id === id) ?? null)),
    findCheckout: vi.fn(async () => fromSrc),
    ...over,
  }, store, github);

  it('shares a PR from ~/src/<repo> when the project\'s own checkout is another repository, keyed by box and directory', async () => {
    const d = d4();
    const r = await createLinkShareFor(d, asUser(owner), 'p1', onMain);
    expect(r.status).toBe(201);
    expect((r.body as any).checkoutDir).toBe(src);
    expect(d.store.opened[0]).toMatchObject({ workstreamId: null, checkoutDir: src, prHeadBranch: 'feat/x', samePr: true, linkKey: expect.stringMatching(/^box:box-1:dir:[0-9a-f]{16}$/) });
    expect(d.findCheckout).toHaveBeenCalledWith(expect.objectContaining({
      host: { userId: owner.id, instanceId: 'box-1' }, home: '/home/olive', asking: '/home/olive/termag/projects/Webapp',
      repo: 'example-org/webapp', branch: 'feat/x', headOid: 'b'.repeat(40),
      candidates: [
        { dir: '/home/olive/termag/projects/Webapp', workstream: { id: null, name: 'main' }, worktrees: true },
        { dir: '/home/olive/termag/projects/Webapp/.worktrees/feature-x', workstream: { id: 'ws1', name: 'feature-x' }, worktrees: false },
        { dir: src, workstream: null, worktrees: true },
      ],
    }));
  });

  it('looks in ~/src under GitHub\'s spelling of the name and in lowercase, and keys a symlinked one where it resolves', async () => {
    const d = d4({ findCheckout: vi.fn(async () => ({ ...fromSrc, realDir: '/data/olive/webapp' })) }, fakeStore(), fakeGithub({ readPr: vi.fn(async () => facts({ repo: 'example-org/Webapp' })) }));
    expect((await createLinkShareFor(d, asUser(owner), 'p1', onMain)).status).toBe(201);
    const { candidates } = (d.findCheckout as any).mock.calls[0][0];
    expect(candidates.filter((c: any) => c.workstream === null).map((c: any) => c.dir)).toEqual(['/home/olive/src/Webapp', src]);
    expect(d.store.opened[0].checkoutDir).toBe(src);
    expect(d.store.opened[0].linkKey).not.toBe((await import('../services/prCheckout')).checkoutLinkKey({ userId: owner.id, instanceId: 'box-1' }, src));
    expect(d.store.opened[0].linkKey).toBe((await import('../services/prCheckout')).checkoutLinkKey({ userId: owner.id, instanceId: 'box-1' }, '/data/olive/webapp'));
  });

  it('an asking workstream the list misses keeps its own row, so a match is never stored as the project\'s main', async () => {
    const own = { ...fromSrc, dir: '/home/olive/termag/projects/Webapp/.worktrees/feature-x', realDir: '/home/olive/termag/projects/Webapp/.worktrees/feature-x', workstream: { id: 'ws1', name: 'feature-x' } };
    const d = d4({ listWorkstreams: vi.fn(async () => [{ id: null, name: 'main' }]), findCheckout: vi.fn(async () => own) });
    expect((await createLinkShareFor(d, asUser(owner), 'p1', { ...onMain, workstream: 'feature-x' })).status).toBe(201);
    expect((d.findCheckout as any).mock.calls[0][0].candidates[0]).toEqual({ dir: '/home/olive/termag/projects/Webapp/.worktrees/feature-x', workstream: { id: 'ws1', name: 'feature-x' }, worktrees: false });
    expect(d.store.opened[0]).toMatchObject({ workstreamId: 'ws1', checkoutDir: null, linkKey: 'ws1' });
  });

  it('a match that is a workstream\'s own checkout is that workstream\'s share, as today', async () => {
    const d = d4({ findCheckout: vi.fn(async () => ({ ...fromSrc, dir: '/home/olive/termag/projects/Webapp/.worktrees/feature-x', workstream: { id: 'ws1', name: 'feature-x' } })) });
    expect((await createLinkShareFor(d, asUser(owner), 'p1', onMain)).status).toBe(201);
    expect(d.store.opened[0]).toMatchObject({ workstreamId: 'ws1', checkoutDir: null, linkKey: 'ws1' });
  });

  it('tells the owner which repository and branch it looked for, and where, when no checkout can be shared', async () => {
    const looked = ['/home/olive/termag/projects/Webapp', src];
    for (const reason of ['no-checkout', 'ambiguous-checkout', 'checkout-unreadable'] as const) {
      const d = d4({ findCheckout: vi.fn(async () => ({ ok: false as const, reason, looked })) });
      const r = await createLinkShareFor(d, asUser(owner), 'p1', onMain);
      expect(r, reason).toMatchObject({ status: 409, body: { code: reason } });
      expect((r.body as any).error).toContain('feat/x');
      expect(d.store.openLinkShare).not.toHaveBeenCalled();
    }
    const none = d4({ findCheckout: vi.fn(async () => ({ ok: false as const, reason: 'no-checkout' as const, looked })) });
    expect(((await createLinkShareFor(none, asUser(owner), 'p1', onMain)).body as any).error).toBe(
      `This box has no checkout of example-org/webapp on feat/x, so there is no preview to share. It looked in /home/olive/termag/projects/Webapp, ${src}.`,
    );
  });

  it('in a multi-repo project looks in each workstream\'s worktree of the PR\'s repository, and shares that directory', async () => {
    const shop = { ...handbook, name: 'shop', repoUrl: null, repos: [{ name: 'web', url: 'https://github.com/acme/web.git' }, { name: 'webapp', url: 'https://github.com/example-org/webapp.git' }] };
    const root = '/home/olive/termag/projects/shop';
    const inWs = { ...fromSrc, dir: `${root}/.worktrees/feature-x/webapp`, realDir: `${root}/.worktrees/feature-x/webapp`, workstream: { id: 'ws1', name: 'feature-x' } };
    const d = d4({ findOwnedProject: vi.fn(async () => shop), findCheckout: vi.fn(async () => inWs) });
    expect((await createLinkShareFor(d, asUser(owner), 'p1', { ...onMain, workstream: 'feature-x' })).status).toBe(201);
    const asked = (d.findCheckout as any).mock.calls[0][0];
    expect(asked.asking).toBe(`${root}/.worktrees/feature-x/webapp`);
    expect(asked.candidates.filter((c: any) => c.workstream).map((c: any) => [c.dir, c.worktrees])).toEqual([
      [`${root}/.worktrees/feature-x/webapp`, false], [`${root}/webapp`, true],
    ]);
    expect(d.store.opened[0]).toMatchObject({
      workstreamId: 'ws1', checkoutDir: `${root}/.worktrees/feature-x/webapp`,
      linkKey: (await import('../services/prCheckout')).checkoutLinkKey({ userId: owner.id, instanceId: 'box-1' }, `${root}/.worktrees/feature-x/webapp`),
    });

    // A PR of a repository the project does not hold: only ~/src is a candidate.
    const other = d4({ findOwnedProject: vi.fn(async () => ({ ...shop, repos: [shop.repos[0]] })) });
    await createLinkShareFor(other, asUser(owner), 'p1', onMain);
    expect((other.findCheckout as any).mock.calls[0][0].candidates.every((c: any) => c.workstream === null)).toBe(true);
  });

  it('in a multi-repo project, a PR of a repository it holds follows the project\'s saved settings', async () => {
    const shop = { ...handbook, name: 'shop', repoUrl: null, repos: [{ name: 'web', url: 'https://github.com/acme/web.git' }, { name: 'webapp', url: 'https://github.com/Example-Org/Webapp.git' }] };
    const inWs = { ...fromSrc, dir: '/home/olive/termag/projects/shop/.worktrees/feature-x/webapp', realDir: '/home/olive/termag/projects/shop/.worktrees/feature-x/webapp', workstream: { id: 'ws1', name: 'feature-x' } };
    const auto = (d: ReturnType<typeof deps>) => createLinkShareFor(d, asUser(owner), 'p1', { ...onMain, workstream: 'feature-x' }, { auto: true });

    // The project's saved choice wins over the repository's default.
    const off = d4({ findOwnedProject: vi.fn(async () => shop), autoShareDefault: vi.fn(async () => true), findCheckout: vi.fn(async () => inWs) });
    off.store.prefs.prLinksEnabled = false;
    expect(await auto(off)).toEqual({ status: 200, body: { skipped: 'off' } });

    // Its path filter applies, and its reviewer hint goes on the comment.
    const filtered = d4({ findOwnedProject: vi.fn(async () => shop), findCheckout: vi.fn(async () => inWs) });
    filtered.store.prefs = { ...filtered.store.prefs, prLinksEnabled: true, pathFilter: ['internal/'] };
    expect(await auto(filtered)).toEqual({ status: 200, body: { skipped: 'paths' } });
    const github = fakeGithub();
    const hinted = d4({ findOwnedProject: vi.fn(async () => shop), findCheckout: vi.fn(async () => inWs) }, fakeStore(), github);
    hinted.store.prefs = { ...hinted.store.prefs, prLinksEnabled: true, accountHint: 'shop reviewer' };
    expect((await auto(hinted)).status).toBe(201);
    expect(github.posted[0]).toContain('shop reviewer');

    // Before a first save, the PR's repository's default decides.
    const unsaved = d4({ findOwnedProject: vi.fn(async () => shop), autoShareDefault: vi.fn(async () => true), findCheckout: vi.fn(async () => inWs) });
    expect((await auto(unsaved)).status).toBe(201);
    expect(unsaved.autoShareDefault).toHaveBeenCalledWith(olive, shop.instance, 'example-org/webapp');
  });

  it('an agent without the light form keeps today\'s rule', async () => {
    const d = d4({ findCheckout: vi.fn(async () => ({ ok: false as const, reason: 'outdated-agent' as const, looked: [] })) });
    expect(await createLinkShareFor(d, asUser(owner), 'p1', onMain)).toMatchObject({ status: 409, body: { code: 'other-repo' } });
    // In the project's own repository on the workstream's branch, today's rule shares it.
    const own = d4({ findOwnedProject: vi.fn(async () => project), findCheckout: vi.fn(async () => ({ ok: false as const, reason: 'outdated-agent' as const, looked: [] })) });
    expect((await createLinkShareFor(own, asUser(owner), 'p1', ask)).status).toBe(201);
    expect(own.store.opened[0]).toMatchObject({ workstreamId: 'ws1', checkoutDir: null, linkKey: 'ws1' });
  });

  it('asks GitHub first: a PR that could never be shared costs the box nothing', async () => {
    for (const [over, code] of [[{ author: { login: 'gus', id: 8 } }, 'not-author'], [{ state: 'CLOSED' }, 'not-open'], [{ visibility: 'PUBLIC' }, 'public'], [{ crossRepo: true }, 'fork']] as [Partial<PrFacts>, string][]) {
      const d = d4({}, fakeStore(), fakeGithub({ readPr: vi.fn(async () => facts(over)) }));
      expect(await createLinkShareFor(d, asUser(owner), 'p1', onMain), code).toMatchObject({ status: 409, body: { code } });
      expect(d.findCheckout).not.toHaveBeenCalled();
    }
  });

  it('keeps a PR on its first live share, so it never gets a second comment', async () => {
    const github = fakeGithub();
    const store = fakeStore();
    const first = await createLinkShareFor(d4({}, store, github), asUser(owner), 'p1', onMain);
    const again = await createLinkShareFor(
      d4({ findCheckout: vi.fn(async () => ({ ...fromSrc, dir: '/home/olive/termag/projects/Webapp/.worktrees/feature-x', workstream: { id: 'ws1', name: 'feature-x' } })) }, store, github),
      asUser(owner), 'p1', { ...onMain, workstream: 'feature-x' },
    );
    expect(again).toMatchObject({ status: 200, body: { id: (first.body as any).id, existing: true } });
    expect(github.posted).toHaveLength(1);
  });

  it('reads the draft flag for the PR\'s repository', async () => {
    const draftsOn = vi.fn(async () => true);
    const d = d4({ draftSharesOn: draftsOn }, fakeStore(), fakeGithub({ readPr: vi.fn(async () => facts({ isDraft: true })) }));
    expect((await createLinkShareFor(d, asUser(owner), 'p1', onMain)).status).toBe(201);
    expect(draftsOn).toHaveBeenCalledWith(olive, handbook.instance, 'example-org/webapp');
  });

  describe('automatic shares in another repository follow that repository\'s default alone (decision 16)', () => {
    const auto = (d: ReturnType<typeof deps>) => createLinkShareFor(d, asUser(owner), 'p1', { ...onMain, repo: 'Example-Org/Webapp' }, { auto: true });

    it('the repository\'s default decides, read lowercased, whatever the project saved', async () => {
      const on = d4({ autoShareDefault: vi.fn(async () => true) });
      on.store.prefs.prLinksEnabled = false;
      expect((await auto(on)).status).toBe(201);
      expect(on.autoShareDefault).toHaveBeenCalledWith(olive, handbook.instance, 'example-org/webapp');

      const off = d4({ autoShareDefault: vi.fn(async () => false) });
      off.store.prefs.prLinksEnabled = true;
      expect(await auto(off)).toEqual({ status: 200, body: { skipped: 'off' } });
    });

    it('the project\'s path filter and reviewer hint stay with its own repository', async () => {
      const github = fakeGithub();
      const d = d4({ autoShareDefault: vi.fn(async () => true) }, fakeStore(), github);
      d.store.prefs = { ...d.store.prefs, prLinksEnabled: true, pathFilter: ['docs/'], accountHint: 'handbook reviewer' };
      expect((await auto(d)).status).toBe(201);
      expect(github.posted[0]).not.toContain('handbook reviewer');
      expect(github.posted[0]).toContain(WEBAPP_REVIEWER_ACCOUNT);
    });

    it('the label and the path filter skip a PR before the box is asked', async () => {
      const labelled = d4({ autoShareDefault: vi.fn(async () => true) }, fakeStore(), fakeGithub({ readScope: vi.fn(async () => ({ labels: ['no-preview'], paths: ['static/a.ts'], complete: true })) }));
      expect(await auto(labelled)).toEqual({ status: 200, body: { skipped: 'label' } });
      expect(labelled.findCheckout).not.toHaveBeenCalled();
      const filtered = d4({ findOwnedProject: vi.fn(async () => project) }, fakeStore(), fakeGithub());
      filtered.store.prefs = { ...filtered.store.prefs, prLinksEnabled: true, pathFilter: ['internal/'] };
      expect(await createLinkShareFor(filtered, asUser(owner), 'p1', ask, { auto: true })).toEqual({ status: 200, body: { skipped: 'paths' } });
      expect(filtered.findCheckout).not.toHaveBeenCalled();
    });

    it('in the project\'s own repository, its saved choice still wins', async () => {
      const own = d4({ findOwnedProject: vi.fn(async () => project), autoShareDefault: vi.fn(async () => true), findCheckout: vi.fn(async () => ({ ...fromSrc, dir: '/home/olive/termag/projects/webapp/.worktrees/feature-x', workstream: { id: 'ws1', name: 'feature-x' } })) });
      own.store.prefs.prLinksEnabled = false;
      expect(await createLinkShareFor(own, asUser(owner), 'p1', ask, { auto: true })).toEqual({ status: 200, body: { skipped: 'off' } });
    });
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

  it('before the owner saves, the repository\'s default decides; a saved choice wins over it', async () => {
    const on = deps({ autoShareDefault: vi.fn(async () => true) });
    expect((await auto(on)).status).toBe(201);
    expect(on.autoShareDefault).toHaveBeenCalledWith(owner, project.instance, 'example-org/webapp');

    const savedOff = deps({ autoShareDefault: vi.fn(async () => true) });
    savedOff.store.prefs.prLinksEnabled = false;
    expect(await auto(savedOff)).toEqual({ status: 200, body: { skipped: 'off' } });
    expect(savedOff.autoShareDefault).not.toHaveBeenCalled();
  });

  it('shares a draft the moment it is opened when its repository allows drafts', async () => {
    const draft = () => fakeGithub({ readPr: vi.fn(async () => facts({ isDraft: true })) });
    const allowed = deps({ autoShareDefault: vi.fn(async () => true), draftSharesOn: vi.fn(async () => true) }, fakeStore(), draft());
    expect((await auto(allowed)).status).toBe(201);
    const refused = deps({ autoShareDefault: vi.fn(async () => true) }, fakeStore(), draft());
    expect(await auto(refused)).toMatchObject({ status: 409, body: { code: 'draft' } });
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

  it('shows the repository\'s default until the first save, which keeps what the dialog showed', async () => {
    const d = deps({ autoShareDefault: vi.fn(async () => true) });
    expect((await settingsFor(d, asUser(owner), 'p1')).body).toMatchObject({ prLinksEnabled: true });
    // Saving only the path filter keeps automatic shares on...
    expect((await saveSettingsFor(d, asUser(owner), 'p1', { pathFilter: 'static/' })).body).toMatchObject({ prLinksEnabled: true, pathFilter: ['static/'] });
    expect(d.store.prefs.prLinksEnabled).toBe(true);
    // ...and from then on the saved choice holds, whatever the default says.
    vi.mocked(d.autoShareDefault).mockResolvedValue(false);
    expect((await settingsFor(d, asUser(owner), 'p1')).body).toMatchObject({ prLinksEnabled: true });
  });

  it('only the owner', async () => {
    expect((await settingsFor(deps(), asUser(stranger), 'p1')).status).toBe(404);
    expect((await saveSettingsFor(deps(), asUser(stranger), 'p1', {})).status).toBe(404);
  });
});
