import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./credentialStore', () => ({ readGithubAccess: vi.fn(async () => null) }));
vi.mock('../slack/app', () => ({ getSlackApp: () => null }));
vi.mock('./briefing/slack', () => ({ slackIdFor: vi.fn() }));
vi.mock('./agentRegistry', () => ({ projectAgentCapabilities: vi.fn(() => []), sendForProject: vi.fn() }));

import { GithubApiError } from './githubCredential';
import type { PrFacts } from './prReview';
import { LINK_SHARE_DAYS } from './previewShareRules';
import { previewShareEnded, registerGuestSocket, resetLiveGuests, type LiveLinkShare, type PreviewShareStore, type ShareRow } from './previewShares';
import { announceLinkShare, installPreviewShareLinkHooks, runLinkShareSweep, sharePrRef, type ShareGithub } from './previewShareLinks';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const owner = { id: 'u-owner', displayName: 'Olive', slackUserId: null, googleEmail: 'olive@x.test' };

function row(over: Partial<ShareRow> = {}): ShareRow {
  return {
    id: 'clink00000000001', projectId: 'p1', workstreamId: 'ws1', ownerId: owner.id, audience: 'link', granteeId: null,
    originRecipe: { kind: 'webapp-dev-stack' }, expiresAt: new Date(NOW + LINK_SHARE_DAYS * 86400e3), revokedAt: null, endedAt: null, endedReason: null,
    lastOpenedAt: null, createdAt: new Date(NOW), prRepo: 'example-org/webapp', prNumber: 42, prCommentId: '9001', prHeadOid: 'a'.repeat(40), ...over,
  };
}

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  state: 'OPEN', isDraft: false, repo: 'example-org/webapp', visibility: 'INTERNAL', headBranch: 'feat/x', headOid: 'a'.repeat(40),
  crossRepo: false, author: { login: 'olive', id: 7 }, viewer: { login: 'olive', id: 7 }, ...over,
});

function github(read: (n: number) => Promise<PrFacts>): ShareGithub & { edited: [string, string][] } {
  const edited: [string, string][] = [];
  return {
    edited,
    readPr: vi.fn(async (ref) => read(ref.number)),
    postComment: vi.fn(async () => ({ id: '1', url: null })),
    editComment: vi.fn(async (_ref, id, body) => { edited.push([id, body]); }),
  };
}

function store(live: ShareRow[]) {
  const rows = live.map(s => ({ ...s }));
  const s = {
    rows,
    liveLinkShares: vi.fn(async (): Promise<LiveLinkShare[]> => rows.filter(r => !r.endedAt).map(share => ({ share, owner, host: { userId: owner.id, instanceId: 'box-1' } }))),
    endOne: vi.fn(async (id: string, reason: string) => {
      const r = rows.find(x => x.id === id && !x.endedAt);
      if (!r) return null;
      r.endedAt = new Date(NOW); r.endedReason = reason;
      return r;
    }),
    setPrHead: vi.fn(async (id: string, oid: string) => { rows.find(x => x.id === id)!.prHeadOid = oid; }),
    setComment: vi.fn(async (id: string, c: string | null) => { rows.find(x => x.id === id)!.prCommentId = c; }),
    claimComment: vi.fn(async (id: string, now: number) => {
      const r = rows.find(x => x.id === id)!;
      if (r.prCommentId !== null) return false;
      r.prCommentId = `pending:${now}`;
      return true;
    }),
    settleComment: vi.fn(async (id: string, at: number, c: string | null) => { const r = rows.find(x => x.id === id)!; if (r.prCommentId === `pending:${at}`) r.prCommentId = c; }),
    shareRow: vi.fn(async (id: string) => rows.find(x => x.id === id) ?? null),
    recordEvent: vi.fn(async () => {}),
    viewerIds: vi.fn(async () => []),
  };
  return s as typeof s & PreviewShareStore;
}

beforeEach(() => resetLiveGuests());

describe('the link share sweep', () => {
  it('ends a share whose PR merged or closed, and keeps an open one\'s head current', async () => {
    const st = store([row(), row({ id: 'clink00000000002', prNumber: 43 }), row({ id: 'clink00000000003', prNumber: 44 })]);
    const gh = github(async (n) => facts(n === 42 ? { state: 'MERGED' } : n === 43 ? { state: 'CLOSED' } : { headOid: 'c'.repeat(40) }));
    const close = vi.fn();
    const off = registerGuestSocket('clink00000000001', { close, reconnect: vi.fn() });
    const notifyOwner = vi.fn(async () => {});
    const r = await runLinkShareSweep(NOW, { store: st, githubFor: async () => gh, notifyOwner });
    off();
    expect(r).toEqual({ checked: 3, ended: { merged: 1, closed: 1 }, skipped: 0 });
    expect(st.rows.map(x => x.endedReason)).toEqual(['merged', 'closed', null]);
    expect(st.rows[2].prHeadOid).toBe('c'.repeat(40));
    expect(close).toHaveBeenCalledWith('This preview has ended.');
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it('ends one past its 14 days without asking GitHub', async () => {
    const st = store([row({ expiresAt: new Date(NOW - 1) })]);
    const gh = github(async () => facts());
    const r = await runLinkShareSweep(NOW, { store: st, githubFor: async () => gh, notifyOwner: vi.fn() });
    expect(r.ended).toEqual({ expired: 1 });
    expect(gh.readPr).not.toHaveBeenCalled();
  });

  it('a PR the owner\'s token can no longer read (401, 404, no token) ends the share, and the owner is told', async () => {
    for (const [why, githubFor] of [
      ['401', async () => github(async () => { throw new GithubApiError('bad credentials', 401); })],
      ['404', async () => github(async () => { throw new GithubApiError('gone', 404); })],
      ['no token', async () => null],
    ] as const) {
      const st = store([row()]);
      const notifyOwner = vi.fn(async () => {});
      const r = await runLinkShareSweep(NOW, { store: st, githubFor: githubFor as any, notifyOwner });
      expect(r.ended, why).toEqual({ 'token-invalid': 1 });
      expect(notifyOwner, why).toHaveBeenCalledWith(owner, expect.stringContaining('example-org/webapp#42'));
    }
  });

  it('a credential store that can\'t be read (KMS, the database) ends nothing: the next pass tries again', async () => {
    const st = store([row(), row({ id: 'clink00000000002', prNumber: 43 })]);
    const notifyOwner = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runLinkShareSweep(NOW, { store: st, githubFor: async () => { throw new Error('KMS throttled'); }, notifyOwner });
    warn.mockRestore();
    expect(r).toEqual({ checked: 2, ended: {}, skipped: 2 });
    expect(st.rows.every(x => x.endedAt === null)).toBe(true);
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it('a stored PR that no longer parses ends the share, and its owner is told', async () => {
    const st = store([row({ prRepo: 'gone-org/webapp' })]);
    const notifyOwner = vi.fn(async () => {});
    const githubFor = vi.fn();
    const r = await runLinkShareSweep(NOW, { store: st, githubFor, notifyOwner });
    expect(r.ended).toEqual({ 'token-invalid': 1 });
    expect(githubFor).not.toHaveBeenCalled();
    expect(notifyOwner).toHaveBeenCalledWith(owner, expect.stringContaining('termag no longer checks pull requests in that repository'));
  });

  it('GitHub failing otherwise (a 502, a timeout) leaves the share for the next pass', async () => {
    const st = store([row()]);
    const r = await runLinkShareSweep(NOW, { store: st, githubFor: async () => github(async () => { throw new GithubApiError('down', 502); }), notifyOwner: vi.fn() });
    expect(r).toEqual({ checked: 1, ended: {}, skipped: 1 });
    expect(st.rows[0].endedAt).toBeNull();
  });

  it('asks for each owner\'s GitHub once per pass, and runs one pass at a time', async () => {
    const st = store([row(), row({ id: 'clink00000000002', prNumber: 43 })]);
    const githubFor = vi.fn(async () => github(async () => facts()));
    let release!: () => void;
    const slow = vi.fn(() => new Promise<LiveLinkShare[]>(r => { release = () => r([]); }));
    const busy = { ...st, liveLinkShares: slow } as unknown as PreviewShareStore;
    const first = runLinkShareSweep(NOW, { store: busy, githubFor, notifyOwner: vi.fn() });
    expect(await runLinkShareSweep(NOW, { store: busy, githubFor, notifyOwner: vi.fn() })).toEqual({ checked: 0, ended: {}, skipped: 0 });
    release();
    await first;
    await runLinkShareSweep(NOW, { store: st, githubFor, notifyOwner: vi.fn() });
    expect(githubFor).toHaveBeenCalledTimes(1);
  });
});

describe('a link share ending, whatever ended it', () => {
  it('its comment loses the link and says why; a superseded one says where it moved', async () => {
    const gh = github(async () => facts());
    const off = installPreviewShareLinkHooks(async () => gh);
    try {
      await previewShareEnded(row(), 'merged');
      await previewShareEnded(row(), 'superseded', { supersededBy: 43 });
      // A per-person share, a link share with no comment, or one whose comment is still being posted, has nothing to edit.
      await previewShareEnded(row({ audience: 'user', granteeId: 'g' }), 'revoked');
      await previewShareEnded(row({ prCommentId: null }), 'revoked');
      await previewShareEnded(row({ prCommentId: 'pending:1' }), 'revoked');
    } finally { off(); }
    expect(gh.edited).toHaveLength(2);
    expect(gh.edited[0][0]).toBe('9001');
    expect(gh.edited[0][1]).toContain('this PR merged');
    expect(gh.edited[0][1]).not.toContain('/p/');
    expect(gh.edited[1][1]).toContain('moved to #43');
  });

  it('an edit GitHub refuses is logged, not thrown', async () => {
    const gh = github(async () => facts());
    vi.mocked(gh.editComment).mockRejectedValueOnce(new GithubApiError('nope', 403));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const off = installPreviewShareLinkHooks(async () => gh);
    try {
      await expect(previewShareEnded(row(), 'closed')).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('an end hook failed'));
    } finally { off(); warn.mockRestore(); }
  });
});

describe('announcing a link share', () => {
  it('posts once and keeps the comment id; a share with a comment keeps it', async () => {
    const st = store([row({ prCommentId: null })]);
    const gh = github(async () => facts());
    expect(await announceLinkShare(st, gh, st.rows[0], { link: 'https://t/p/x', signInHint: null, ownerName: 'Olive' })).toEqual({ state: 'posted', url: null });
    expect(st.rows[0].prCommentId).toBe('1');
    expect(await announceLinkShare(st, gh, st.rows[0], { link: 'https://t/p/x', signInHint: null, ownerName: 'Olive' })).toEqual({ state: 'kept' });
    expect(gh.postComment).toHaveBeenCalledTimes(1);
  });

  it('reads a stored PR back only inside the orgs termag works in', () => {
    expect(sharePrRef({ prRepo: 'example-org/webapp', prNumber: 42 })).toEqual({ owner: 'example-org', name: 'webapp', number: 42 });
    expect(sharePrRef({ prRepo: 'evil/webapp', prNumber: 42 })).toBeNull();
    expect(sharePrRef({ prRepo: null, prNumber: null })).toBeNull();
  });

  it('another request posting it now is "posting", not "kept"', async () => {
    const st = store([row({ prCommentId: 'pending:1' })]);
    const gh = github(async () => facts());
    expect(await announceLinkShare(st, gh, st.rows[0], { link: 'L', signInHint: null, ownerName: 'O', now: 2 })).toEqual({ state: 'posting' });
    expect(gh.postComment).not.toHaveBeenCalled();
  });

  it('a comment that landed keeps its id even when storing it fails once, and says so when it fails twice', async () => {
    const st = store([row({ prCommentId: null })]);
    const gh = github(async () => facts());
    const settle = st.settleComment;
    let fails = 1;
    st.settleComment = vi.fn(async (...a: Parameters<typeof settle>) => { if (fails-- > 0) throw new Error('db blip'); return settle(...a); }) as typeof settle;
    expect(await announceLinkShare(st, gh, st.rows[0], { link: 'L', signInHint: null, ownerName: 'O', now: 5 })).toEqual({ state: 'posted', url: null });
    expect(st.rows[0].prCommentId).toBe('1');
    const st2 = store([row({ id: 'clink00000000002', prCommentId: null })]);
    st2.settleComment = vi.fn(async () => { throw new Error('db down'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await announceLinkShare(st2, gh, st2.rows[0], { link: 'L', signInHint: null, ownerName: 'O', now: 5 })).toEqual({ state: 'posted', url: null });
      expect(err).toHaveBeenCalledWith(expect.stringContaining('comment 1 (null) is on example-org/webapp#42 but its id could not be stored'));
    } finally { err.mockRestore(); }
  });
});
