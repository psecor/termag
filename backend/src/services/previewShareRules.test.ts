import { describe, expect, it } from 'vitest';
import {
  GUEST_BUSY_CLOSE_CODE, GUEST_STACK_CLOSE_CODE, GUEST_UNSAFE_CLOSE_CODE, MAX_ORIGINS,
  canonicalOrigin, guestAttachRefusal, guestPaneKey, isShareId, localRedirectPath, maxGuestPanes, parseRecipe, resolveGuestAccess, reviewerSignInHint, safeAtPath, ttlHours,
  type GuestShare,
  activeLinkKeyOf, checkLinkSharePr, endedCommentBody, isLinkToken, linkTokenFor, linkTokenHash, previewCommentBody,
  guestWakeRefusal, wakeBudget,
  autoShareDecision, parseAccountHint, parsePathFilter,
} from './previewShareRules';
import { isAutoHibernateNote } from './boxLifecyclePolicy';
import type { PrFacts } from './prReview';

describe('canonicalOrigin', () => {
  it('folds every spelling of a loopback address into one, with an explicit or default port', () => {
    for (const s of ['127.0.0.1:80', 'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://127.0.0.1./', 'localhost', 'http://LocalHost/x']) {
      expect(canonicalOrigin(s), s).toBe('127.0.0.1:80');
    }
    expect(canonicalOrigin('https://127.0.0.2/')).toBe('127.0.0.2:443');
    expect(canonicalOrigin('[::1]:3000')).toBe('[::1]:3000');
  });

  it('refuses anything that is not loopback, and a grant origin without its port', () => {
    for (const s of ['http://[::ffff:127.0.0.1]/', 'http://0.0.0.0/', 'http://10.0.0.1/', 'http://169.254.169.254/', 'http://example.com/', 'http://a:b@127.0.0.1/', 'file:///etc/passwd', 'ftp://127.0.0.1/', 'http://127.0.0.1:0/', '', 42]) {
      expect(canonicalOrigin(s), String(s)).toBeNull();
    }
    expect(canonicalOrigin('127.0.0.2', { requirePort: true })).toBeNull();
    expect(canonicalOrigin('127.0.0.2:80', { requirePort: true })).toBe('127.0.0.2:80');
  });
});

describe('parseRecipe', () => {
  it('defaults to the workstream\'s webapp dev stack', () => {
    expect(parseRecipe(undefined)).toEqual({ recipe: { kind: 'webapp-dev-stack' } });
    expect(parseRecipe({ kind: 'webapp-dev-stack', extra: 1 })).toEqual({ recipe: { kind: 'webapp-dev-stack' } });
  });

  it('checks manual origins, drops duplicates, keeps the first one\'s scheme as given', () => {
    expect(parseRecipe({ kind: 'manual', origins: ['https://127.0.0.1:4443/', '127.0.0.1:4443', ' 127.0.0.2:3012 '] }))
      .toEqual({ recipe: { kind: 'manual', origins: ['https://127.0.0.1:4443/', '127.0.0.2:3012'] } });
    expect(parseRecipe({ kind: 'manual', origins: ['example.com:80'] })).toEqual({ error: expect.stringMatching(/not a loopback origin/) });
    expect(parseRecipe({ kind: 'manual', origins: [] })).toEqual({ error: expect.stringMatching(/at least one/) });
    expect(parseRecipe({ kind: 'manual', origins: Array.from({ length: MAX_ORIGINS + 1 }, (_, i) => `127.0.0.1:${3000 + i}`) })).toEqual({ error: `at most ${MAX_ORIGINS} origins` });
    expect(parseRecipe({ kind: 'shell' })).toEqual({ error: expect.stringMatching(/recipe.kind/) });
    expect(parseRecipe([1])).toEqual({ error: 'recipe must be an object' });
  });
});

describe('ttlHours and maxGuestPanes', () => {
  it('takes the request, else the flag, and clamps both to their ranges', () => {
    expect(ttlHours(undefined, 24)).toBe(24);
    expect(ttlHours(72, 24)).toBe(72);
    expect(ttlHours(0, 24)).toBe(1);
    expect(ttlHours(10_000, 24)).toBe(168);
    expect(ttlHours('nope', 12)).toBe(12);
    expect(ttlHours(undefined, Number.NaN)).toBe(24);
    expect(ttlHours(undefined, 100_000)).toBe(168, 'a bad flag value cannot make a share that never ends');
    expect(maxGuestPanes(5)).toBe(5);
    expect(maxGuestPanes(50)).toBe(10);
    expect(maxGuestPanes(-1)).toBe(0);
    expect(maxGuestPanes(Number.NaN)).toBe(5);
  });
});

describe('safeAtPath', () => {
  it('takes a path and nothing else', () => {
    expect(safeAtPath('/default/production/features/my-flag')).toBe('/default/production/features/my-flag');
    expect(safeAtPath('/x?y=1#z')).toBe('/x?y=1#z');
    for (const bad of ['//169.254.169.254/latest', '/\\169.254.169.254/x', '\\\\evil.example/x', '/\t/evil.example/x', 'https://example.com/',
      'javascript:alert(1)', '%2F%2Fevil.example', '/%2F%2Fevil.example', '/%5Cevil', 'relative', '', null, '/x'.repeat(2000), '/%E0%A4%A']) {
      expect(safeAtPath(bad), String(bad)).toBeNull();
    }
  });
});

describe('isShareId and localRedirectPath', () => {
  it('a share id is a bounded run of lowercase letters and digits', () => {
    expect(isShareId('cshare0000000001')).toBe(true);
    for (const bad of ['short', 'x'.repeat(65), 'CSHARE0000000001', 'cshare00000000/1', 'a'.repeat(100_000), null, 42]) {
      expect(isShareId(bad), String(bad).slice(0, 20)).toBe(false);
    }
  });

  it('a redirect stays on this site, under its base path', () => {
    expect(localRedirectPath('/termag', '/termag/preview/cshare0000000001?at=%2Fx')).toBe('/termag/preview/cshare0000000001?at=%2Fx');
    expect(localRedirectPath('', '/preview/x')).toBe('/preview/x');
    for (const bad of ['https://evil.example/', '//evil.example/', '/\\evil', '/elsewhere', '/termag', '/termag/\nx', '/termag/a\\b', null]) {
      expect(localRedirectPath('/termag', bad), String(bad)).toBeNull();
    }
    expect(localRedirectPath('', '//evil.example/')).toBeNull();
  });
});

describe('reviewerSignInHint', () => {
  it('takes the project\'s hint, else webapp\'s seeded account for its dev stack, else nothing', () => {
    expect(reviewerSignInHint({ kind: 'webapp-dev-stack' })).toBe('reviewer@example.com / example-password');
    expect(reviewerSignInHint({ kind: 'manual', origins: ['127.0.0.1:3000'] })).toBeNull();
    expect(reviewerSignInHint({ kind: 'manual', origins: ['127.0.0.1:3000'] }, '  demo@example.com / demo  ')).toBe('demo@example.com / demo');
    expect(reviewerSignInHint({ kind: 'webapp-dev-stack' }, '   ')).toBe('reviewer@example.com / example-password');
    expect(reviewerSignInHint({ kind: 'webapp-dev-stack' }, 'x'.repeat(500))).toHaveLength(200);
  });
});

describe('resolveGuestAccess', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const share = (over: Partial<GuestShare> = {}): GuestShare => ({
    id: 's1', audience: 'user', granteeId: 'u-guest', expiresAt: new Date(now + 3600e3), revokedAt: null, endedAt: null, endedReason: null, ...over,
  });
  const ws = { archived: false };
  const run = (s: GuestShare | null, viewerId = 'u-guest', extra: { workstream?: { archived: boolean } | null; projectArchived?: boolean; viewerRow?: { revokedAt: Date | null } | null } = {}) =>
    resolveGuestAccess({ share: s, viewerId, workstream: extra.workstream === undefined ? ws : extra.workstream, projectArchived: extra.projectArchived ?? false, viewerRow: extra.viewerRow, now });

  it('admits the grantee of a live share', () => {
    expect(run(share())).toEqual({ ok: true });
  });

  it('tells the grantee why it is closed', () => {
    expect(run(share({ revokedAt: new Date(now) }))).toMatchObject({ ok: false, reason: 'revoked', toGrantee: true });
    expect(run(share({ endedAt: new Date(now), endedReason: 'merged' }))).toMatchObject({ ok: false, reason: 'ended', endedReason: 'merged', toGrantee: true });
    expect(run(share({ expiresAt: new Date(now) }))).toMatchObject({ ok: false, reason: 'expired', toGrantee: true });
    expect(run(share(), 'u-guest', { projectArchived: true })).toMatchObject({ ok: false, reason: 'project-archived', toGrantee: true });
    expect(run(share(), 'u-guest', { workstream: null })).toMatchObject({ ok: false, reason: 'workstream-gone', toGrantee: true });
    expect(run(share(), 'u-guest', { workstream: { archived: true } })).toMatchObject({ ok: false, reason: 'workstream-gone', toGrantee: true });
  });

  it('gives anyone else the same not-shared, whatever the share\'s state', () => {
    for (const s of [null, share(), share({ revokedAt: new Date(now) }), share({ expiresAt: new Date(0) }), share({ endedAt: new Date(now) })]) {
      expect(run(s, 'u-stranger')).toEqual({ ok: false, reason: 'not-shared', toGrantee: false });
    }
    expect(run(share({ audience: 'nope' }))).toEqual({ ok: false, reason: 'not-shared', toGrantee: false });
  });

  it('admits a link share\'s viewer only with their row, made by the token route (phase 2)', () => {
    const link = share({ audience: 'link', granteeId: null });
    expect(run(link, 'u-any')).toEqual({ ok: false, reason: 'not-shared', toGrantee: false });
    expect(run(link, 'u-any', { viewerRow: { revokedAt: null } })).toEqual({ ok: true });
    expect(run(link, 'u-any', { viewerRow: { revokedAt: new Date(now) } })).toMatchObject({ ok: false, reason: 'viewer-revoked', toGrantee: true });
  });
});

describe('guestAttachRefusal and guestPaneKey', () => {
  it('maps the agent\'s guest refusals for the viewer: busy redials, the rest are final', () => {
    expect(guestAttachRefusal('guest-busy: 5 reviewers are already using this preview')).toMatchObject({ code: GUEST_BUSY_CLOSE_CODE, retry: true, message: expect.stringMatching(/^5 reviewers are already using this preview/) });
    expect(guestAttachRefusal('guest-busy: 1 reviewer is already using this preview').message).toBe('1 reviewer is already using this preview. Trying again shortly.');
    expect(guestAttachRefusal('guest-busy: this box takes no reviewers right now').message).toBe('This box takes no reviewers right now. Trying again shortly.');
    expect(guestAttachRefusal('guest-busy: /home/owner/secret path').message).toBe('This preview is busy right now. Trying again shortly.');
    expect(guestAttachRefusal('Error: guest-memory: the box is low on memory')).toMatchObject({ code: GUEST_BUSY_CLOSE_CODE, retry: true });
    expect(guestAttachRefusal('guest-stack:other-workstream')).toMatchObject({ code: GUEST_STACK_CLOSE_CODE, retry: false, message: expect.stringMatching(/another workstream/) });
    expect(guestAttachRefusal('guest-stack:stack-not-running')).toMatchObject({ code: GUEST_STACK_CLOSE_CODE, message: expect.stringMatching(/isn't running/) });
    expect(guestAttachRefusal('guest-unsafe: this box could not confirm …')).toMatchObject({ code: GUEST_UNSAFE_CLOSE_CODE, retry: false });
    expect(guestAttachRefusal('guest-unavailable: no launcher')).toMatchObject({ code: 4501 });
    expect(guestAttachRefusal('guest-url: that address is not part of the shared preview')).toMatchObject({ code: 1008 });
    expect(guestAttachRefusal('Agent not connected')).toMatchObject({ code: 1011, retry: false });
    // The agent's raw text never reaches the reviewer.
    expect(guestAttachRefusal("Error: ENOENT: no such file or directory, open '/home/owner/src/termag/agent/agent.config.json'").message)
      .toBe("Could not start a browser on the owner's box. Try again in a moment.");
    expect(guestPaneKey('s1', 'u1')).toBe('guest:s1:u1');
  });
});

describe('link shares (phase 2)', () => {
  const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
    state: 'OPEN', isDraft: false, repo: 'example-org/webapp', visibility: 'INTERNAL', headBranch: 'feat/x', headOid: 'a'.repeat(40),
    crossRepo: false, author: { login: 'olive', id: 7 }, viewer: { login: 'olive', id: 7 }, ...over,
  });
  const target = { repo: 'example-org/webapp', branch: 'feat/x' };

  it('a token is 128 bits from the share id and the secret: the same each time, never a share id, nothing without the secret', () => {
    const t = linkTokenFor('s3cret', 'cshare0000000001');
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(linkTokenFor('s3cret', 'cshare0000000001')).toBe(t);
    expect(linkTokenFor('other', 'cshare0000000001')).not.toBe(t);
    expect(linkTokenFor('s3cret', 'cshare0000000002')).not.toBe(t);
    expect(isLinkToken(t)).toBe(true);
    expect(isLinkToken('cshare0000000001')).toBe(false);
    expect(isLinkToken(t.toUpperCase())).toBe(false);
    expect(linkTokenHash(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(linkTokenHash(t)).not.toContain(t);
  });

  it('keys a workstream\'s active link share by its row, or the project\'s implicit main', () => {
    expect(activeLinkKeyOf('p1', 'ws1')).toBe('ws1');
    expect(activeLinkKeyOf('p1', null)).toBe('p1:main');
  });

  it('takes an open, ready PR the owner wrote, in the project\'s private or internal repo, on the workstream\'s branch', () => {
    expect(checkLinkSharePr(facts(), target)).toEqual({ ok: true });
    expect(checkLinkSharePr(facts({ visibility: 'PRIVATE', repo: 'Example-Org/Webapp' }), target)).toEqual({ ok: true });
  });

  it('refuses each other case, with its reason', () => {
    const reason = (f: Partial<PrFacts>, t = target) => { const r = checkLinkSharePr(facts(f), t); return r.ok ? 'ok' : r.reason; };
    expect(reason({}, { repo: null, branch: 'feat/x' })).toBe('no-repo');
    expect(reason({ state: 'MERGED' })).toBe('not-open');
    expect(reason({ state: 'CLOSED' })).toBe('not-open');
    expect(reason({ isDraft: true })).toBe('draft');
    expect(reason({ visibility: 'PUBLIC' })).toBe('public');
    expect(reason({ visibility: '' })).toBe('public');
    expect(reason({ repo: 'example-org/termag' })).toBe('other-repo');
    expect(reason({ author: { login: 'gus', id: 8 } })).toBe('not-author');
    expect(reason({ author: { login: null, id: null } })).toBe('not-author');
    // The same login is not enough: the token's own user is who counts.
    expect(reason({ author: { login: 'olive', id: 9 } })).toBe('not-author');
    expect(reason({ crossRepo: true })).toBe('fork');
    expect(reason({ headBranch: 'feat/y' })).toBe('other-branch');
    expect(reason({}, { repo: 'example-org/webapp', branch: null })).toBe('other-branch');
  });

  it('a share nobody\'s own (a fleet\'s) skips only the owner-made checks', () => {
    const f = facts({ author: { login: 'gus', id: 8 }, headBranch: 'feat/y', crossRepo: true });
    expect(checkLinkSharePr(f, target, 'system')).toEqual({ ok: true });
    expect(checkLinkSharePr({ ...f, visibility: 'PUBLIC' }, target, 'system')).toMatchObject({ ok: false, reason: 'public' });
    expect(checkLinkSharePr({ ...f, isDraft: true }, target, 'system')).toMatchObject({ ok: false, reason: 'draft' });
  });

  it('writes the comment with the link, the sign-in hint and its marker; the ended one keeps no link', () => {
    const body = previewCommentBody({ link: 'https://t.test/termag/p/abc', shareId: 'cshare0000000001', signInHint: 'reviewer@example.com / example-password', ownerName: 'Olive <Owner>' });
    expect(body).toContain('https://t.test/termag/p/abc');
    expect(body).toContain('`reviewer@example.com / example-password`');
    expect(body).toContain("Olive Owner's termag box");
    expect(body).toContain('<!-- termag-preview-share:cshare0000000001 -->');
    expect(previewCommentBody({ link: 'L', shareId: 's', signInHint: null, ownerName: 'O' })).not.toContain('Sign in');
    const ended = endedCommentBody('merged', 'cshare0000000001');
    expect(ended).toContain('this PR merged');
    expect(ended).not.toContain('/p/');
    expect(endedCommentBody('superseded', 's', 42)).toContain('moved to #42');
    expect(endedCommentBody('who-knows', 's')).toContain('Preview ended.');
  });
});

describe('waking the box (4b)', () => {
  const auto = (note: string | null) => isAutoHibernateNote(note);
  const box = (over: Record<string, unknown> = {}) => ({ status: 'hibernated', lifecycleNote: 'Hibernated automatically after 2 h idle. Start it to resume where you left off.', autoTerminatedAt: null, ...over }) as any;

  it('wakes only a box the idle sweep hibernated and nobody touched since', () => {
    expect(guestWakeRefusal(box(), auto)).toBeNull();
    expect(guestWakeRefusal(box({ lifecycleNote: null }), auto)).toBe('not-auto');
    expect(guestWakeRefusal(box({ lifecycleNote: 'Terminated automatically.' }), auto)).toBe('not-auto');
    expect(guestWakeRefusal(box({ status: 'stopped' }), auto)).toBe('not-auto');
    expect(guestWakeRefusal(box({ status: 'ready' }), auto)).toBe('awake');
    expect(guestWakeRefusal(box({ autoTerminatedAt: new Date() }), auto)).toBe('no-box');
    expect(guestWakeRefusal(null, auto)).toBe('no-box');
  });

  it('allows one wake per 30 minutes and six in any 24 hours, per owner', () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    const ago = (min: number) => new Date(now - min * 60e3);
    expect(wakeBudget([], now)).toEqual({ ok: true });
    expect(wakeBudget([ago(31)], now)).toEqual({ ok: true });
    expect(wakeBudget([ago(10)], now)).toEqual({ ok: false, reason: 'too-soon', retryAt: now + 20 * 60e3 });
    const six = [ago(60), ago(120), ago(180), ago(240), ago(300), ago(1400)];
    expect(wakeBudget(six, now)).toEqual({ ok: false, reason: 'daily', retryAt: now - 1400 * 60e3 + 24 * 3600e3 });
    // Both at once: the day's cap decides when the next fits, never a 30-minute retry that is refused again.
    const full = [ago(5), ago(100), ago(200), ago(300), ago(400), ago(500)];
    expect(wakeBudget(full, now)).toEqual({ ok: false, reason: 'daily', retryAt: now - 500 * 60e3 + 24 * 3600e3 });
    // A wake older than a day no longer counts.
    expect(wakeBudget([...six.slice(0, 5), ago(1500)], now)).toEqual({ ok: true });
  });
});

describe('automatic shares (4c)', () => {
  it('reads a path filter as prefixes, and refuses what could climb out', () => {
    expect(parsePathFilter(undefined)).toEqual({ filter: [] });
    expect(parsePathFilter(' static/, ./internal/api  /docs\nstatic/ ')).toEqual({ filter: ['static/', 'internal/api', 'docs'] });
    expect(parsePathFilter(['a', 'b'])).toEqual({ filter: ['a', 'b'] });
    expect(parsePathFilter('a/../b')).toMatchObject({ error: expect.stringContaining('not a path prefix') });
    expect(parsePathFilter('a\\b')).toMatchObject({ error: expect.any(String) });
    expect(parsePathFilter(42)).toMatchObject({ error: expect.any(String) });
    expect(parsePathFilter(Array.from({ length: 21 }, (_, i) => `p${i}`))).toMatchObject({ error: 'at most 20 path prefixes' });
  });

  it('reads a sign-in hint as one short line', () => {
    expect(parseAccountHint('  me@x / pw ')).toEqual({ hint: 'me@x / pw' });
    expect(parseAccountHint('')).toEqual({ hint: null });
    expect(parseAccountHint('a\nb')).toMatchObject({ error: expect.any(String) });
    expect(parseAccountHint('x'.repeat(201))).toMatchObject({ error: expect.any(String) });
  });

  it('shares a new PR only when the project says so, never with no-preview, and under the path filter only', () => {
    const base = { enabled: true, filter: [] as string[], labels: [] as string[], paths: ['static/a.ts'], complete: true };
    expect(autoShareDecision(base)).toEqual({ share: true });
    expect(autoShareDecision({ ...base, enabled: false })).toEqual({ share: false, why: 'off' });
    expect(autoShareDecision({ ...base, labels: ['No-Preview'] })).toEqual({ share: false, why: 'label' });
    expect(autoShareDecision({ ...base, filter: ['static/'] })).toEqual({ share: true });
    expect(autoShareDecision({ ...base, filter: ['static'] })).toEqual({ share: true });
    expect(autoShareDecision({ ...base, filter: ['stat'] })).toEqual({ share: false, why: 'paths' });
    expect(autoShareDecision({ ...base, filter: ['internal/'] })).toEqual({ share: false, why: 'paths' });
    expect(autoShareDecision({ ...base, filter: ['static/a.ts'] })).toEqual({ share: true });
    // Too big to read every path: shared.
    expect(autoShareDecision({ ...base, filter: ['internal/'], complete: false })).toEqual({ share: true });
  });
});
