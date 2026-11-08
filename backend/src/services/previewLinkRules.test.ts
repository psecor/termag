import { describe, expect, it } from 'vitest';
import {
  cappedExpiry, clampTtlHours, holdUntil, lifetimeCap, MAX_LINK_LIFETIME_MS, laterExpiry, laterOf, linkTokenHash, LINK_TOKEN_RE, nameDecision, nameRefusal, nameSweepable, NAME_HOLD_MS, newLinkToken,
  newHostSuffix, parseHostLabel, parsePublishRequest, previewHostLabel, renewNarrowing, suggestName, tokenMatches, type NameReservation,
} from './previewLinkRules';

const NOW = new Date('2026-10-31T12:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const DAY = 24 * 3600_000;

describe('nameRefusal (the name grammar, PRD P2)', () => {
  it('accepts a DNS label of 3 to 40 lowercase letters, digits and inner hyphens', () => {
    for (const ok of ['abc', 'my-awesome-preview', 'a1b', '0ab', 'a'.repeat(40), 'a-b', 'webapp-pr-1234']) expect(nameRefusal(ok), ok).toBeNull();
  });

  // From #167's label tests: nothing that would smear across URL segments or hosts.
  it('refuses anything else', () => {
    for (const bad of ['', 'ab', 'a'.repeat(41), 'UPPER', 'has space', '..', '-web', 'web-', 'we.b', 'we_b', 'wéb', 'web/x', 'web\n', null, 3]) {
      expect(nameRefusal(bad), String(bad)).toBe('invalid');
    }
  });

  it('refuses the reserved names (SR15, SR19)', () => {
    for (const name of ['www', 'api', 'auth', 'admin', 'termag', 'preview', 'mail', 'login', 'confirm', 'reverify']) expect(nameRefusal(name), name).toBe('reserved');
  });

  it('refuses punycode, the other IDNA-reserved labels, and any `--`, the host suffix\'s separator (SR19)', () => {
    expect(nameRefusal('xn--80ak6aa92e')).toBe('reserved');
    expect(nameRefusal('ab--cd')).toBe('reserved');
    // A name holding `--` could pass for another's host: `my-app--abcdef` is my-app's link's.
    expect(nameRefusal('abc--d')).toBe('reserved');
    expect(nameRefusal('my-app--abcdef')).toBe('reserved');
    expect(nameRefusal('my-app')).toBeNull();
  });
});

describe('host labels (SR19: each link its own origin)', () => {
  it('mints a 6-character base32 suffix, new each time', () => {
    const a = newHostSuffix();
    expect(a).toMatch(/^[a-z2-7]{6}$/);
    expect(new Set(Array.from({ length: 50 }, () => newHostSuffix())).size).toBeGreaterThan(45);
    expect(newHostSuffix(() => Buffer.from([0, 31, 32, 255, 26, 1]))).toBe('a7a72b');
  });

  it('a 40-character name and its suffix stay a DNS label (63 at most)', () => {
    const label = previewHostLabel('a'.repeat(40), 'abcdef');
    expect(label).toHaveLength(48);
    expect(label.length).toBeLessThanOrEqual(63);
  });

  it('parses <name>--<suffix> at the last `--`, and a bare name', () => {
    expect(parseHostLabel('my-app--abcdef')).toEqual({ name: 'my-app', suffix: 'abcdef' });
    expect(parseHostLabel('my-app--abcd')).toEqual({ name: 'my-app', suffix: 'abcd' });
    expect(parseHostLabel('my-app')).toEqual({ name: 'my-app', suffix: null });
    // A name published before `--` was refused keeps working: its host is <name>--<suffix> too (Devin).
    expect(parseHostLabel('abc--d--abcdef')).toEqual({ name: 'abc--d', suffix: 'abcdef' });
  });

  it('reads a label whose tail is no suffix as a bare name (only ever sent to the landing page), and refuses a bad name', () => {
    for (const bare of ['my-app--abc', 'my-app--abcdefg', 'my-app--abc1ef', 'abc--d']) {
      expect(parseHostLabel(bare), bare).toEqual({ name: bare, suffix: null });
    }
    for (const bad of ['--abcdef', 'my-app--', '-x---abcdef', 'My-App--abcdef', 'a--abcdef']) expect(parseHostLabel(bad), bad).toBeNull();
  });
});

describe('suggestName', () => {
  it('is <project>-<workstream>, main left off', () => {
    expect(suggestName('webapp', 'main')).toBe('webapp');
    expect(suggestName('My_Awesome App', 'feature/X')).toBe('my-awesome-app-feature-x');
  });

  it('cuts to 40 without a trailing hyphen, and gives up on nothing usable', () => {
    expect(suggestName('a'.repeat(39), 'b')).toBe('a'.repeat(39));
    expect(suggestName('__', 'main')).toBeNull();
    expect(suggestName('admin', 'main')).toBeNull();
  });
});

describe('parsePublishRequest', () => {
  it('applies the defaults to the minimal shape', () => {
    expect(parsePublishRequest({ port: 5173, name: 'my-app' })).toEqual({
      ok: true,
      request: { workstream: 'main', port: 5173, name: 'my-app', audience: 'owner', emails: [], ttlHours: null, hostMode: 'localhost', requestId: null },
    });
  });

  it('takes every field', () => {
    expect(parsePublishRequest({
      workstream: 'feature-x', port: 3000, name: 'my-app', audience: 'people', emails: [' Bob@X.test ', 'bob@x.test', 'carol@x.test'],
      ttlHours: 168, hostMode: 'public', requestId: 'creq00000001',
    })).toEqual({
      ok: true,
      request: { workstream: 'feature-x', port: 3000, name: 'my-app', audience: 'people', emails: ['bob@x.test', 'carol@x.test'], ttlHours: 168, hostMode: 'public', requestId: 'creq00000001' },
    });
  });

  // #167's port and TTL cases, on the spec's bounds.
  it('refuses an out-of-range or non-integer port', () => {
    for (const port of [0, 65536, 3.5, '3000', null, undefined]) expect(parsePublishRequest({ port, name: 'my-app' }), String(port)).toMatchObject({ ok: false, status: 400 });
  });

  it('takes a lifetime of 1 to 168 whole hours', () => {
    expect(parsePublishRequest({ port: 1, name: 'abc', ttlHours: 1 })).toMatchObject({ ok: true, request: { ttlHours: 1 } });
    for (const ttlHours of [0, -1, 169, 1.5, 'forever', Number.POSITIVE_INFINITY]) {
      expect(parsePublishRequest({ port: 1, name: 'abc', ttlHours }), String(ttlHours)).toMatchObject({ ok: false, status: 400 });
    }
  });

  it('says why a name is refused', () => {
    expect(parsePublishRequest({ port: 1, name: 'Web' })).toMatchObject({ ok: false, code: 'invalid_name' });
    expect(parsePublishRequest({ port: 1, name: 'admin' })).toMatchObject({ ok: false, code: 'name_reserved' });
  });

  it('holds the audience and the people named together', () => {
    expect(parsePublishRequest({ port: 1, name: 'abc', audience: 'public' })).toMatchObject({ ok: false });
    expect(parsePublishRequest({ port: 1, name: 'abc', audience: 'owner', emails: ['bob@x.test'] })).toMatchObject({ ok: false });
    expect(parsePublishRequest({ port: 1, name: 'abc', audience: 'people' })).toMatchObject({ ok: false });
    expect(parsePublishRequest({ port: 1, name: 'abc', audience: 'people', emails: ['not an email'] })).toMatchObject({ ok: false });
    expect(parsePublishRequest({ port: 1, name: 'abc', audience: 'people', emails: Array.from({ length: 51 }, (_, i) => `u${i}@x.test`) })).toMatchObject({ ok: false });
    expect(parsePublishRequest({ port: 1, name: 'abc', audience: 'link' })).toMatchObject({ ok: true, request: { audience: 'link', emails: [] } });
  });

  it('refuses a bad workstream, host mode or request id', () => {
    expect(parsePublishRequest({ port: 1, name: 'abc', workstream: '../x' })).toMatchObject({ ok: false });
    expect(parsePublishRequest({ port: 1, name: 'abc', hostMode: 'other' })).toMatchObject({ ok: false });
    expect(parsePublishRequest({ port: 1, name: 'abc', requestId: 'x' })).toMatchObject({ ok: false });
  });

  it('reads an empty or odd body as a validation error, not a crash', () => {
    expect(parsePublishRequest(null)).toMatchObject({ ok: false, status: 400 });
    expect(parsePublishRequest('x' as never)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('clampTtlHours', () => {
  it('keeps a served value within 1..168', () => {
    expect(clampTtlHours(24)).toBe(24);
    expect(clampTtlHours(0)).toBe(1);
    expect(clampTtlHours(1000)).toBe(168);
    expect(clampTtlHours(Number.NaN)).toBe(24);
    expect(clampTtlHours('12')).toBe(24);
  });
});

describe('nameDecision (reservations, SR19)', () => {
  const publish = { publisherId: 'alice', projectId: 'p1', workstreamId: 'ws1' };
  const row = (over: Partial<NameReservation> = {}): NameReservation => ({ name: 'my-app', ownerId: 'alice', reservedUntil: at(31 * DAY), link: null, ...over });
  const liveLink = { id: 'l1', projectId: 'p1', workstreamId: 'ws1', expiresAt: at(DAY), endedAt: null };

  it('creates a reservation for a name nobody holds', () => {
    expect(nameDecision(null, publish, NOW)).toEqual({ kind: 'create' });
  });

  it("renews this project's and workstream's live link, whoever publishes", () => {
    expect(nameDecision(row({ link: liveLink }), publish, NOW)).toEqual({ kind: 'renew', linkId: 'l1' });
    expect(nameDecision(row({ ownerId: 'bob', link: liveLink }), publish, NOW)).toEqual({ kind: 'renew', linkId: 'l1' });
    expect(nameDecision(row({ link: { ...liveLink, workstreamId: null } }), { ...publish, workstreamId: null }, NOW)).toEqual({ kind: 'renew', linkId: 'l1' });
  });

  it('never rebinds a live name to another workstream or project, even for its owner', () => {
    expect(nameDecision(row({ link: liveLink }), { ...publish, workstreamId: 'ws2' }, NOW)).toMatchObject({ kind: 'refuse', code: 'name_in_use' });
    expect(nameDecision(row({ link: liveLink }), { ...publish, workstreamId: null }, NOW)).toMatchObject({ kind: 'refuse', code: 'name_in_use' });
    expect(nameDecision(row({ link: liveLink }), { ...publish, projectId: 'p2' }, NOW)).toMatchObject({ kind: 'refuse', code: 'name_in_use' });
  });

  it('lets the owner take their own name back at any time once no link is live', () => {
    expect(nameDecision(row(), publish, NOW)).toEqual({ kind: 'take' });
    expect(nameDecision(row({ link: { ...liveLink, endedAt: at(-1) } }), { ...publish, projectId: 'p9' }, NOW)).toEqual({ kind: 'take' });
    expect(nameDecision(row({ link: { ...liveLink, expiresAt: at(-1) } }), publish, NOW)).toEqual({ kind: 'take' });
  });

  it("refuses someone else's name until its hold passes, then lets them reclaim it", () => {
    const bob = { ...publish, publisherId: 'bob' };
    expect(nameDecision(row(), bob, NOW)).toMatchObject({ kind: 'refuse', code: 'name_taken' });
    expect(nameDecision(row({ reservedUntil: at(1) }), bob, NOW)).toMatchObject({ kind: 'refuse', code: 'name_taken' });
    expect(nameDecision(row({ reservedUntil: NOW }), bob, NOW)).toEqual({ kind: 'reclaim' });
    expect(nameDecision(row({ reservedUntil: at(-1), link: { ...liveLink, endedAt: at(-DAY) } }), bob, NOW)).toEqual({ kind: 'reclaim' });
  });

  it('keeps a name refused to another owner for 30 days after its project, and so its link, was deleted', () => {
    // The link's expiry was a day out when it was shared; the project went a moment later (linkId set null).
    const expiresAt = at(DAY);
    const reservation = row({ reservedUntil: holdUntil(expiresAt), link: null });
    const bob = { publisherId: 'bob', projectId: 'p2', workstreamId: null };
    expect(nameDecision(reservation, bob, at(2 * DAY))).toMatchObject({ kind: 'refuse', code: 'name_taken' });
    expect(nameDecision(reservation, bob, at(DAY + 30 * DAY - 1))).toMatchObject({ kind: 'refuse', code: 'name_taken' });
    expect(nameDecision(reservation, bob, at(DAY + 30 * DAY))).toEqual({ kind: 'reclaim' });
  });

  it('frees a link that expires naturally to another owner 30 days later', () => {
    const link = { ...liveLink, expiresAt: at(DAY) };
    const reservation = row({ reservedUntil: holdUntil(link.expiresAt), link });
    const bob = { publisherId: 'bob', projectId: 'p2', workstreamId: null };
    expect(nameDecision(reservation, bob, NOW)).toMatchObject({ kind: 'refuse', code: 'name_in_use' });
    expect(nameDecision(reservation, bob, at(DAY))).toMatchObject({ kind: 'refuse', code: 'name_taken' });
    expect(nameDecision(reservation, bob, at(31 * DAY))).toEqual({ kind: 'reclaim' });
  });
});

describe('reservation times', () => {
  it('holds a name 30 days past its expiry, and never moves it earlier', () => {
    expect(holdUntil(NOW).getTime() - NOW.getTime()).toBe(NAME_HOLD_MS);
    expect(laterOf(at(5), at(1))).toEqual(at(5));
    expect(laterOf(at(1), at(5))).toEqual(at(5));
    expect(laterOf(null, at(1))).toEqual(at(1));
  });

  it('moves a renewed expiry only later', () => {
    expect(laterExpiry(at(48 * 3600_000), NOW, 24)).toEqual(at(48 * 3600_000));
    expect(laterExpiry(at(3600_000), NOW, 24)).toEqual(at(24 * 3600_000));
    expect(laterExpiry(null, NOW, 2)).toEqual(at(2 * 3600_000));
  });

  it('lets the sweep delete a reservation only past its hold with no live link', () => {
    const base: NameReservation = { name: 'abc', ownerId: 'a', reservedUntil: at(-1), link: null };
    expect(nameSweepable(base, NOW)).toBe(true);
    expect(nameSweepable({ ...base, reservedUntil: at(1) }, NOW)).toBe(false);
    expect(nameSweepable({ ...base, link: { id: 'l', projectId: 'p', workstreamId: null, expiresAt: at(-2), endedAt: at(-2) } }, NOW)).toBe(true);
    expect(nameSweepable({ ...base, link: { id: 'l', projectId: 'p', workstreamId: null, expiresAt: at(DAY), endedAt: null } }, NOW)).toBe(false);
  });
});

describe('link tokens', () => {
  it('are 128 bits of base64url, stored only as their sha256', () => {
    const { token, hash } = newLinkToken();
    expect(token).toMatch(LINK_TOKEN_RE);
    expect(Buffer.from(token, 'base64url')).toHaveLength(16);
    expect(hash).toBe(linkTokenHash(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('match only their own hash', () => {
    const { token, hash } = newLinkToken();
    expect(tokenMatches(token, hash)).toBe(true);
    expect(tokenMatches(newLinkToken().token, hash)).toBe(false);
    expect(tokenMatches(token, null)).toBe(false);
    expect(tokenMatches(null, hash)).toBe(false);
    expect(tokenMatches('short', linkTokenHash('short'))).toBe(false);
    expect(tokenMatches(token, 'abcd')).toBe(false);
  });
});

describe('renewNarrowing', () => {
  const h1 = linkTokenHash('AAAAAAAAAAAAAAAAAAAAAA');
  const h2 = linkTokenHash('BBBBBBBBBBBBBBBBBBBBBB');

  it("revokes a removed grant's sessions, and keeps the rest", () => {
    expect(renewNarrowing(
      { audience: 'people', linkTokenHash: null, grantUserIds: ['bob', 'carol'] },
      { audience: 'people', linkTokenHash: null, grantUserIds: ['carol', 'dave'] },
    )).toEqual({ grantUserIds: ['bob'], allGrants: false, keepTokenHash: null });
  });

  it('revokes every grant session when the audience becomes owner', () => {
    expect(renewNarrowing(
      { audience: 'people', linkTokenHash: null, grantUserIds: ['bob'] },
      { audience: 'owner', linkTokenHash: null, grantUserIds: [] },
    )).toEqual({ grantUserIds: [], allGrants: true, keepTokenHash: null });
  });

  it('keeps token sessions only on a link that stays link with the same token', () => {
    expect(renewNarrowing({ audience: 'link', linkTokenHash: h1, grantUserIds: [] }, { audience: 'link', linkTokenHash: h1, grantUserIds: [] }).keepTokenHash).toBe(h1);
    expect(renewNarrowing({ audience: 'link', linkTokenHash: h1, grantUserIds: [] }, { audience: 'link', linkTokenHash: h2, grantUserIds: [] }).keepTokenHash).toBe(h2);
    expect(renewNarrowing({ audience: 'link', linkTokenHash: h1, grantUserIds: [] }, { audience: 'people', linkTokenHash: null, grantUserIds: ['bob'] }).keepTokenHash).toBeNull();
  });
});

describe('cappedExpiry (SR23)', () => {
  const pub = NOW;
  it('moves the expiry as far as 30 days from the first publish, and refuses past it', () => {
    expect(MAX_LINK_LIFETIME_MS).toBe(30 * DAY);
    expect(lifetimeCap(pub)).toEqual(at(30 * DAY));
    expect(cappedExpiry(at(DAY), at(DAY), 24, pub)).toEqual({ ok: true, expiresAt: at(2 * DAY) });
    expect(cappedExpiry(at(29 * DAY), at(29 * DAY), 48, pub)).toEqual({ ok: true, expiresAt: at(30 * DAY) });
    expect(cappedExpiry(at(30 * DAY), at(29 * DAY), 48, pub)).toEqual({ ok: false });
    // Asking for no more than it has is fine even at the cap.
    expect(cappedExpiry(at(30 * DAY), at(29 * DAY), 1, pub)).toEqual({ ok: true, expiresAt: at(30 * DAY) });
  });
});
