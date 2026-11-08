import { describe, expect, it } from 'vitest';
import { basisHolds as basisHoldsOf, decide as decideOf, isAccessBasis, type AccessAudience, type AccessBasis, type AccessDelivery, type AccessViewer } from './previewLinkAccess';
import { linkTokenHash, type PreviewAudience } from './previewLinkRules';

const NOW = new Date('2026-10-31T12:00:00Z');
const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA';
const OTHER_TOKEN = 'BBBBBBBBBBBBBBBBBBBBBB';
const ON = { enabled: true, killSwitch: false };

// A link as the rule sees it: its audience (kind, expiry, end) and the delivery (its token hash), in one object.
type AccessLink = AccessAudience & AccessDelivery;
const decide = (l: AccessLink, ...rest: [AccessViewer, string | null, { enabled: boolean; killSwitch: boolean }, Date]) => decideOf(l, l, ...rest);
const basisHolds = (b: AccessBasis, h: string | null, l: AccessLink, ...rest: [AccessViewer, { enabled: boolean; killSwitch: boolean }, Date]) => basisHoldsOf(b, h, l, l, ...rest);

function link(audience: PreviewAudience, over: Partial<AccessLink> = {}): AccessLink {
  return {
    kind: audience,
    linkTokenHash: audience === 'link' ? linkTokenHash(TOKEN) : null,
    expiresAt: new Date(NOW.getTime() + 3600_000),
    endedAt: null,
    ...over,
  };
}

const nobody: AccessViewer = { isProjectOwner: false, isCollaborator: false, hasGrant: false, removed: false };
const VIEWERS: Record<string, AccessViewer> = {
  projectOwner: { ...nobody, isProjectOwner: true },
  collaborator: { ...nobody, isCollaborator: true },
  grantee: { ...nobody, hasGrant: true },
  stranger: nobody,
};
const TOKENS: Record<string, string | null> = { none: null, right: TOKEN, wrong: OTHER_TOKEN, malformed: 'not-a-token' };

// What a live link lets in, by audience, viewer and token: the basis, or null for the 404.
const EXPECTED: Record<PreviewAudience, Record<string, Record<string, AccessBasis | null>>> = {
  owner: {
    projectOwner: { none: 'owner', right: 'owner', wrong: 'owner', malformed: 'owner' },
    collaborator: { none: 'collaborator', right: 'collaborator', wrong: 'collaborator', malformed: 'collaborator' },
    grantee: { none: null, right: null, wrong: null, malformed: null },
    stranger: { none: null, right: null, wrong: null, malformed: null },
  },
  people: {
    projectOwner: { none: 'owner', right: 'owner', wrong: 'owner', malformed: 'owner' },
    collaborator: { none: 'collaborator', right: 'collaborator', wrong: 'collaborator', malformed: 'collaborator' },
    grantee: { none: 'grant', right: 'grant', wrong: 'grant', malformed: 'grant' },
    stranger: { none: null, right: null, wrong: null, malformed: null },
  },
  link: {
    projectOwner: { none: 'owner', right: 'owner', wrong: 'owner', malformed: 'owner' },
    collaborator: { none: 'collaborator', right: 'collaborator', wrong: 'collaborator', malformed: 'collaborator' },
    grantee: { none: 'grant', right: 'grant', wrong: 'grant', malformed: 'grant' },
    stranger: { none: null, right: 'token', wrong: null, malformed: null },
  },
};

describe('previewLinkAccess.decide', () => {
  for (const audience of ['owner', 'people', 'link'] as const) {
    for (const [who, viewer] of Object.entries(VIEWERS)) {
      for (const [tokenName, token] of Object.entries(TOKENS)) {
        const basis = EXPECTED[audience][who][tokenName];
        it(`${audience} link, ${who}, ${tokenName} token: ${basis ?? '404'}`, () => {
          const d = decide(link(audience), viewer, token, ON, NOW);
          if (basis === null) expect(d).toEqual({ ok: false, reason: 'no_access' });
          else expect(d).toEqual({ ok: true, basis, tokenHash: basis === 'token' ? linkTokenHash(TOKEN) : null });
        });

        // Whatever the viewer and token, a link that can't serve refuses, and says why.
        const states: Array<[string, AccessLink, typeof ON, string]> = [
          ['ended', link(audience, { endedAt: new Date(NOW.getTime() - 1) }), ON, 'ended'],
          ['expired', link(audience, { expiresAt: new Date(NOW.getTime() - 1) }), ON, 'expired'],
          ['expiring this instant', link(audience, { expiresAt: NOW }), ON, 'expired'],
          ['flag off', link(audience), { enabled: false, killSwitch: false }, 'disabled'],
          ['kill switch on', link(audience), { enabled: true, killSwitch: true }, 'kill_switch'],
        ];
        for (const [state, l, flags, reason] of states) {
          it(`${audience} link ${state}, ${who}, ${tokenName} token: 404 (${reason})`, () => {
            expect(decide(l, viewer, token, flags, NOW)).toEqual({ ok: false, reason });
          });
        }

        it(`${audience} link, ${who} removed, ${tokenName} token: 404 (removed)`, () => {
          expect(decide(link(audience), { ...viewer, removed: true }, token, ON, NOW)).toEqual({ ok: false, reason: 'removed' });
        });
      }
    }
  }

  it('compares the token against the hash, so a link without one admits no token', () => {
    expect(decide(link('link', { linkTokenHash: null }), nobody, TOKEN, ON, NOW)).toEqual({ ok: false, reason: 'no_access' });
  });

  it('records the hash of the token it matched, never the token', () => {
    const d = decide(link('link'), nobody, TOKEN, ON, NOW);
    expect(d).toMatchObject({ ok: true, basis: 'token' });
    expect(JSON.stringify(d)).not.toContain(TOKEN);
  });
});

describe('previewLinkAccess.basisHolds', () => {
  const tokenHash = linkTokenHash(TOKEN);

  it('holds for each basis while its standing does', () => {
    expect(basisHolds('owner', null, link('owner'), VIEWERS.projectOwner, ON, NOW)).toEqual({ ok: true });
    expect(basisHolds('collaborator', null, link('owner'), VIEWERS.collaborator, ON, NOW)).toEqual({ ok: true });
    expect(basisHolds('grant', null, link('people'), VIEWERS.grantee, ON, NOW)).toEqual({ ok: true });
    expect(basisHolds('grant', null, link('link'), VIEWERS.grantee, ON, NOW)).toEqual({ ok: true });
    expect(basisHolds('token', tokenHash, link('link'), nobody, ON, NOW)).toEqual({ ok: true });
  });

  it('fails once the standing is gone: a collaborator unshared, a grant removed', () => {
    expect(basisHolds('collaborator', null, link('owner'), nobody, ON, NOW)).toEqual({ ok: false, reason: 'no_access' });
    expect(basisHolds('grant', null, link('people'), nobody, ON, NOW)).toEqual({ ok: false, reason: 'no_access' });
  });

  it('fails a grant once the audience narrows to owner', () => {
    expect(basisHolds('grant', null, link('owner'), VIEWERS.grantee, ON, NOW)).toEqual({ ok: false, reason: 'no_access' });
  });

  it('fails a token session once the token rotates or the audience stops being link', () => {
    expect(basisHolds('token', tokenHash, link('link', { linkTokenHash: linkTokenHash(OTHER_TOKEN) }), nobody, ON, NOW)).toEqual({ ok: false, reason: 'no_access' });
    expect(basisHolds('token', tokenHash, link('people'), nobody, ON, NOW)).toEqual({ ok: false, reason: 'no_access' });
    expect(basisHolds('token', null, link('link'), nobody, ON, NOW)).toEqual({ ok: false, reason: 'no_access' });
  });

  it('does not let a basis stand in for another: an owner basis needs the project owner', () => {
    expect(basisHolds('owner', null, link('owner'), VIEWERS.collaborator, ON, NOW)).toEqual({ ok: false, reason: 'no_access' });
  });

  it('refuses every basis on a link that can no longer serve, or a removed viewer', () => {
    for (const basis of ['owner', 'collaborator', 'grant', 'token'] as const) {
      const viewer = { ...VIEWERS.projectOwner, isCollaborator: true, hasGrant: true };
      expect(basisHolds(basis, tokenHash, link('link', { endedAt: NOW }), viewer, ON, NOW)).toEqual({ ok: false, reason: 'ended' });
      expect(basisHolds(basis, tokenHash, link('link'), viewer, { enabled: true, killSwitch: true }, NOW)).toEqual({ ok: false, reason: 'kill_switch' });
      expect(basisHolds(basis, tokenHash, link('link'), { ...viewer, removed: true }, ON, NOW)).toEqual({ ok: false, reason: 'removed' });
    }
  });
});

describe('isAccessBasis', () => {
  it('knows the four bases and nothing else', () => {
    for (const b of ['owner', 'collaborator', 'grant', 'token']) expect(isAccessBasis(b)).toBe(true);
    for (const b of ['', 'link', 'people', null, 1]) expect(isAccessBasis(b)).toBe(false);
  });
});
