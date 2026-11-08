/**
 * Who may open a preview link ("Opening a
 * link", step 2, and "The session check"): pure, so every audience × viewer ×
 * token × state is a unit test. The landing page calls `decide`; the code
 * exchange and each session check call `basisHolds` with the basis the
 * viewer was let in on, against the link as it is now.
 *
 * Both take the audience (services/previewAudience.ts: its kind, expiry and
 * end) and the delivery (the link: its own token hash), since who may see a
 * preview is the audience's and the token is each delivery's own (SR11).
 *
 * - `owner`: the viewer is the project's owner or a collaborator on it;
 * - `people`: that, or the viewer is a live grantee of the audience;
 * - `link`: that, or sha256(token) is the delivery's linkTokenHash, compared
 *   in constant time.
 *
 * Every refusal is the same 404 to the viewer (A4); its reason is for the
 * audit log only (O3). The viewer is always a termag user already: the
 * landing page sits behind the session and the ALB bridge (A2).
 */
import { audienceLive, type AudienceKind } from './previewAudience';
import { linkTokenHash, tokenMatches } from './previewLinkRules';

/** Why the viewer was let in, as PreviewLinkCode.basis and PreviewLinkSession.basis store it. */
export type AccessBasis = 'owner' | 'collaborator' | 'grant' | 'token';
export const ACCESS_BASES: readonly AccessBasis[] = ['owner', 'collaborator', 'grant', 'token'];

export function isAccessBasis(v: unknown): v is AccessBasis {
  return typeof v === 'string' && (ACCESS_BASES as readonly string[]).includes(v);
}

export type AccessRefusal =
  /** preview-links-enabled is off for the link's owner and box. */
  | 'disabled'
  /** preview-links-kill-switch is on. */
  | 'kill_switch'
  | 'ended'
  | 'expired'
  /** The owner removed this viewer (A3). */
  | 'removed'
  /** None of the audience's ways in holds. */
  | 'no_access';

/** The audience half: who is in it, and whether it still lives. */
export interface AccessAudience {
  kind: AudienceKind;
  expiresAt: Date;
  endedAt: Date | null;
}

/** The delivery half: the link's own token. */
export interface AccessDelivery {
  linkTokenHash: string | null;
}

/** What is true of the viewer now, looked up by the caller. */
export interface AccessViewer {
  /** The project's owner. */
  isProjectOwner: boolean;
  /** Has a ProjectShare on the project. */
  isCollaborator: boolean;
  /** Is a live grantee of the audience (previewAudience.ts granteeLive). */
  hasGrant: boolean;
  /** Their PreviewAudienceViewer row has revokedAt set. */
  removed: boolean;
}

export interface AccessFlags {
  enabled: boolean;
  killSwitch: boolean;
}

export type Decision =
  | { ok: true; basis: AccessBasis; tokenHash: string | null }
  | { ok: false; reason: AccessRefusal };

/** The audience's state, before any viewer: null when it may serve. */
function stateRefusal(audience: AccessAudience, flags: AccessFlags, now: Date): AccessRefusal | null {
  if (!flags.enabled) return 'disabled';
  if (flags.killSwitch) return 'kill_switch';
  if (audience.endedAt !== null) return 'ended';
  if (!audienceLive(audience, now)) return 'expired';
  return null;
}

/**
 * Whether the viewer may open the link, and on what basis. The narrowest
 * basis that the viewer's own standing gives wins over a token: an owner
 * or collaborator with the link's token is let in as themselves, so rotating
 * the token never shuts them out.
 */
export function decide(audience: AccessAudience, delivery: AccessDelivery, viewer: AccessViewer, token: string | null, flags: AccessFlags, now: Date): Decision {
  const state = stateRefusal(audience, flags, now);
  if (state) return { ok: false, reason: state };
  if (viewer.removed) return { ok: false, reason: 'removed' };
  if (viewer.isProjectOwner) return { ok: true, basis: 'owner', tokenHash: null };
  if (viewer.isCollaborator) return { ok: true, basis: 'collaborator', tokenHash: null };
  if (audience.kind !== 'owner' && viewer.hasGrant) return { ok: true, basis: 'grant', tokenHash: null };
  if (audience.kind === 'link' && token && tokenMatches(token, delivery.linkTokenHash)) {
    return { ok: true, basis: 'token', tokenHash: linkTokenHash(token) };
  }
  return { ok: false, reason: 'no_access' };
}

/**
 * Whether a basis the viewer was let in on still holds, against the link as
 * it is now (the code exchange, every session check, a re-verification).
 * `tokenHash` is the one the session or code recorded: a token basis holds
 * only while the link is still a `link` audience with that same hash, so a
 * revoke-and-republish, or a renew that rotates the token, shuts it out.
 */
export function basisHolds(
  basis: AccessBasis,
  tokenHash: string | null,
  audience: AccessAudience,
  delivery: AccessDelivery,
  viewer: AccessViewer,
  flags: AccessFlags,
  now: Date,
): { ok: true } | { ok: false; reason: AccessRefusal } {
  const state = stateRefusal(audience, flags, now);
  if (state) return { ok: false, reason: state };
  if (viewer.removed) return { ok: false, reason: 'removed' };
  const holds = (() => {
    switch (basis) {
      case 'owner': return viewer.isProjectOwner;
      case 'collaborator': return viewer.isCollaborator;
      case 'grant': return audience.kind !== 'owner' && viewer.hasGrant;
      case 'token': return audience.kind === 'link' && tokenHash !== null && delivery.linkTokenHash === tokenHash;
    }
  })();
  return holds ? { ok: true } : { ok: false, reason: 'no_access' };
}
