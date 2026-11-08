/**
 * Pure rules for preview links ("Data model"
 * and "Publishing"): the name grammar and its reservation, the publish
 * request's shape, lifetimes, link tokens, and what a renew narrows. No
 * prisma, no express: services/previewLinks.ts applies them.
 *
 * Ported from #167 (`routes/publishedPortRequests.ts`, by its author): the
 * request validation, the label grammar and the TTL ceiling, with its
 * `label` renamed `name` and kept to a DNS label of 3 to 40 characters (PRD
 * P2), its `workstream` name resolved to a workstreamId by the caller (P3),
 * and its `visibility` become the audience.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { AUDIENCE_KINDS, type AudienceKind } from './previewAudience';
import { PREVIEW_HOST_SUFFIX_SOURCE, PREVIEW_NAME_SOURCE } from './previewHostGrammar';

/**
 * A name is a DNS label (PRD P2): 3 to 40 of a-z, 0-9 and `-`, neither end a
 * hyphen. The grammar is previewHostGrammar.ts's, which nginx's preview
 * server_name is generated from too; the backend's host dispatch checks it again.
 */
export const PREVIEW_NAME_RE = new RegExp(`^${PREVIEW_NAME_SOURCE}$`);

/** Names a publish never gets: hostnames people read as something else (SR15, SR19). */
export const RESERVED_PREVIEW_NAMES: ReadonlySet<string> = new Set(['www', 'api', 'auth', 'admin', 'termag', 'preview', 'mail', 'login', 'confirm', 'reverify']);

/** How long a name stays held after its link could last have worked (SR19). */
export const NAME_HOLD_MS = 30 * 24 * 3600_000;

export const MIN_TTL_HOURS = 1;
export const MAX_TTL_HOURS = 168;
export const DEFAULT_TTL_HOURS = 24;
/** People one `people` link may name. */
export const MAX_GRANTS = 50;

/** The audience kinds a publish may ask for: the core's (services/previewAudience.ts). */
export const AUDIENCES = AUDIENCE_KINDS;
/** An audience's kind; kept under this name for the link code that reads it. */
export type PreviewAudience = AudienceKind;
export const HOST_MODES = ['localhost', 'public'] as const;
export type PreviewHostMode = (typeof HOST_MODES)[number];

const WORKSTREAM_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
// A loose shape check; whether each is a termag user is the caller's lookup.
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const REQUEST_ID = /^[a-z0-9]{8,40}$/;

export type NameRefusal = 'invalid' | 'reserved';

/** Why `name` can't be a preview name, or null when it can. */
export function nameRefusal(name: unknown): NameRefusal | null {
  if (typeof name !== 'string' || !PREVIEW_NAME_RE.test(name)) return 'invalid';
  if (RESERVED_PREVIEW_NAMES.has(name)) return 'reserved';
  // `ab--` is reserved by IDNA (RFC 5891 4.2.3.1); `xn--` is punycode, which
  // a browser shows as other letters. Any other `--` is the host suffix's
  // separator, so no name may hold one and pass for another's host.
  if (name.includes('--')) return 'reserved';
  return null;
}

/**
 * A link's own origin (SR19, decided 2026-11-06): its host label is
 * `<name>--<suffix>`, the suffix 6 random base32 characters minted with each
 * new link and kept by renew and extend. A Service Worker an earlier link's
 * app left on the name lives on that link's origin, so it never sees this
 * link's code exchange. The label is at most 40 + 2 + 6 = 48 characters, under
 * DNS's 63.
 */
export const HOST_SUFFIX_RE = new RegExp(`^${PREVIEW_HOST_SUFFIX_SOURCE}$`);
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A new link's host suffix: 6 base32 characters, 30 random bits. */
export function newHostSuffix(random: (n: number) => Buffer = randomBytes): string {
  return [...random(6)].map(b => BASE32[b & 31]).join('');
}

/** The host label a link is served on. */
export function previewHostLabel(name: string, hostSuffix: string): string {
  return `${name}--${hostSuffix}`;
}

/**
 * A preview host's label as its name and suffix, split at the last `--`: the
 * suffix holds none. A label with no suffix there is the bare name (suffix
 * null), which is only ever sent to the landing page. Null when the name fails
 * the grammar. A name published before 2026-11-06 may hold `--` itself
 * (`abc--d` gets `abc--d--<suffix>`); no new one can, so no new name passes
 * for another's host.
 */
export function parseHostLabel(label: string): { name: string; suffix: string | null } | null {
  const at = label.lastIndexOf('--');
  const tail = at < 0 ? null : label.slice(at + 2);
  const suffixed = tail !== null && HOST_SUFFIX_RE.test(tail);
  const name = suffixed ? label.slice(0, at) : label;
  if (!PREVIEW_NAME_RE.test(name)) return null;
  return { name, suffix: suffixed ? tail : null };
}

/**
 * A name suggested from the project and workstream (`<project>-<workstream>`,
 * main left off): lowercased, every run of other characters one hyphen, cut to
 * 40. Null when nothing usable is left; the caller checks it is free.
 */
export function suggestName(project: string, workstream: string): string | null {
  const raw = workstream === 'main' ? project : `${project}-${workstream}`;
  const label = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
  return nameRefusal(label) === null ? label : null;
}

/** A served TTL flag value as hours, within 1..168 (a bad value is the default). */
export function clampTtlHours(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_TTL_HOURS;
  return Math.min(MAX_TTL_HOURS, Math.max(MIN_TTL_HOURS, Math.round(n)));
}

export interface PublishRequest {
  workstream: string;
  port: number;
  name: string;
  audience: PreviewAudience;
  /** Lowercased and deduplicated; empty for `owner`. */
  emails: string[];
  /** Null: the caller applies the TTL flag's default. */
  ttlHours: number | null;
  hostMode: PreviewHostMode;
  requestId: string | null;
}

export type PublishRequestInput = Partial<Record<keyof PublishRequest, unknown>>;

export type Invalid = { ok: false; status: 400; error: string; code: string };
const invalid = (error: string, code = 'invalid_request'): Invalid => ({ ok: false, status: 400, error, code });

/** `ttlHours` as a request gives it: a whole number of hours, 1 to 168. */
export function parseTtlHours(raw: unknown): { ok: true; hours: number } | Invalid {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < MIN_TTL_HOURS || raw > MAX_TTL_HOURS) {
    return invalid(`ttlHours must be a whole number of hours, ${MIN_TTL_HOURS} to ${MAX_TTL_HOURS}`);
  }
  return { ok: true, hours: raw };
}

/**
 * Validate and normalize a publish body (`POST …/preview-links`): shape,
 * grammar and lifetime only. Who may publish, whether the workstream exists,
 * whether each email is a termag user, the audience flag and the name's
 * reservation are the caller's.
 */
export function parsePublishRequest(body: PublishRequestInput | null | undefined): { ok: true; request: PublishRequest } | Invalid {
  const b = body && typeof body === 'object' ? body : {};
  const { workstream = 'main', port, name, audience = 'owner', emails, ttlHours, hostMode = 'localhost', requestId } = b;
  if (typeof workstream !== 'string' || !WORKSTREAM_NAME.test(workstream)) return invalid('workstream must be a workstream name');
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return invalid('port must be an integer 1-65535');
  const refusal = nameRefusal(name);
  if (refusal === 'invalid') return invalid('name must be 3 to 40 lowercase letters, digits and hyphens, not starting or ending with a hyphen', 'invalid_name');
  if (refusal === 'reserved') return invalid(`"${name}" is reserved`, 'name_reserved');
  if (typeof audience !== 'string' || !(AUDIENCES as readonly string[]).includes(audience)) return invalid(`audience must be one of: ${AUDIENCES.join(', ')}`);
  let list: string[] = [];
  if (emails !== undefined && emails !== null) {
    if (!Array.isArray(emails) || emails.some(e => typeof e !== 'string' || !EMAIL.test(e.trim()))) return invalid('emails must be a list of email addresses');
    list = [...new Set((emails as string[]).map(e => e.trim().toLowerCase()))];
  }
  if (audience === 'owner' && list.length > 0) return invalid('an "owner" link names nobody; use audience "people"');
  if (audience === 'people' && list.length === 0) return invalid('a "people" link names at least one person in emails');
  if (list.length > MAX_GRANTS) return invalid(`at most ${MAX_GRANTS} people per link`);
  let ttl: number | null = null;
  if (ttlHours !== undefined && ttlHours !== null) {
    const parsed = parseTtlHours(ttlHours);
    if (!parsed.ok) return parsed;
    ttl = parsed.hours;
  }
  if (typeof hostMode !== 'string' || !(HOST_MODES as readonly string[]).includes(hostMode)) return invalid(`hostMode must be one of: ${HOST_MODES.join(', ')}`);
  if (requestId !== undefined && requestId !== null && (typeof requestId !== 'string' || !REQUEST_ID.test(requestId))) return invalid('requestId is not a request id');
  return {
    ok: true,
    request: {
      workstream, port, name: name as string, audience: audience as PreviewAudience, emails: list, ttlHours: ttl,
      hostMode: hostMode as PreviewHostMode, requestId: (requestId as string | undefined) ?? null,
    },
  };
}

// ── Names ─────────────────────────────────────────────────────────────────

/** A link as the name rules see it. */
export interface NamedLink {
  id: string;
  projectId: string;
  workstreamId: string | null;
  expiresAt: Date;
  endedAt: Date | null;
}

/** A PreviewLinkName row, with the link it serves (null once that is deleted). */
export interface NameReservation {
  name: string;
  ownerId: string;
  reservedUntil: Date;
  link: NamedLink | null;
}

export function isLive(link: Pick<NamedLink, 'expiresAt' | 'endedAt'>, now: Date): boolean {
  return link.endedAt === null && link.expiresAt.getTime() > now.getTime();
}

export type NameDecision =
  /** No reservation: make one. */
  | { kind: 'create' }
  /** This project's and workstream's live link: renew it in place (P5). */
  | { kind: 'renew'; linkId: string }
  /** The publisher's own name, with no live link: a new link takes it. */
  | { kind: 'take' }
  /** Someone else's name, past its hold, with no live link: rewrite its owner and link. */
  | { kind: 'reclaim' }
  | { kind: 'refuse'; status: 409; code: 'name_in_use' | 'name_taken'; error: string };

/**
 * What publishing under a name does, from its reservation as it is now (read
 * under the name's lock). In the spec's order: a live link of the same
 * project and workstream is renewed, whoever publishes; a live link anywhere
 * else is never rebound, even for its owner; a name of one's own with no live
 * link is taken at any time; anyone else's only once its hold has passed.
 */
export function nameDecision(
  row: NameReservation | null,
  publish: { publisherId: string; projectId: string; workstreamId: string | null },
  now: Date,
): NameDecision {
  if (!row) return { kind: 'create' };
  const live = row.link && isLive(row.link, now) ? row.link : null;
  if (live) {
    if (live.projectId === publish.projectId && live.workstreamId === publish.workstreamId) return { kind: 'renew', linkId: live.id };
    return { kind: 'refuse', status: 409, code: 'name_in_use', error: `"${row.name}" is published from another workstream or project; revoke that link first` };
  }
  if (row.ownerId === publish.publisherId) return { kind: 'take' };
  if (row.reservedUntil.getTime() <= now.getTime()) return { kind: 'reclaim' };
  return { kind: 'refuse', status: 409, code: 'name_taken', error: `"${row.name}" is taken` };
}

/** The reservation a link expiring at `expiresAt` needs: 30 days past it. */
export function holdUntil(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() + NAME_HOLD_MS);
}

/** A reservation moved to `candidate`, never earlier than it is. */
export function laterOf(current: Date | null | undefined, candidate: Date): Date {
  return current && current.getTime() > candidate.getTime() ? current : candidate;
}

/** A sweep may delete a reservation past its hold whose link is gone or ended. */
export function nameSweepable(row: NameReservation, now: Date): boolean {
  return row.reservedUntil.getTime() <= now.getTime() && (row.link === null || !isLive(row.link, now));
}

// ── Link tokens ───────────────────────────────────────────────────────────

/** A link token is 128 bits, base64url: 22 characters. */
export const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

export function linkTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A fresh link token and its hash; only the hash is stored. */
export function newLinkToken(random: (n: number) => Buffer = randomBytes): { token: string; hash: string } {
  const token = random(16).toString('base64url');
  return { token, hash: linkTokenHash(token) };
}

/** Whether `token` is the one `hash` was made from, compared in constant time. */
export function tokenMatches(token: string | null | undefined, hash: string | null | undefined): boolean {
  if (!token || !hash || !LINK_TOKEN_RE.test(token)) return false;
  const a = Buffer.from(linkTokenHash(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Lifetimes ─────────────────────────────────────────────────────────────

/** A renewed or extended link's expiry: `ttlHours` from now, never earlier than it already was. */
export function laterExpiry(current: Date | null, now: Date, ttlHours: number): Date {
  return laterOf(current, new Date(now.getTime() + ttlHours * 3600_000));
}

/**
 * A link's whole life is capped at 30 days from its first publish (security
 * review SR23, decided 2026-11-04): extends and renews move its expiry only
 * up to `publishedAt + MAX_LINK_LIFETIME_MS`. Publishing again once it has
 * ended or expired makes a new link, with a new 30 days.
 */
export const MAX_LINK_LIFETIME_MS = 30 * 24 * 3600_000;

export function lifetimeCap(publishedAt: Date): Date {
  return new Date(publishedAt.getTime() + MAX_LINK_LIFETIME_MS);
}

/**
 * The expiry a renew or extend may set: laterExpiry's, cut to the cap. Refused
 * (`lifetime_cap`) only when the link already sits at its cap and more was
 * asked, so a request that can still move it does, as far as the cap.
 */
export function cappedExpiry(current: Date, now: Date, ttlHours: number, publishedAt: Date): { ok: true; expiresAt: Date } | { ok: false } {
  const wanted = laterExpiry(current, now, ttlHours);
  const cap = lifetimeCap(publishedAt);
  if (wanted.getTime() <= cap.getTime()) return { ok: true, expiresAt: wanted };
  if (current.getTime() >= cap.getTime()) return { ok: false };
  return { ok: true, expiresAt: cap };
}

// ── Renewing ──────────────────────────────────────────────────────────────

export interface LinkAccessShape {
  audience: PreviewAudience;
  linkTokenHash: string | null;
  grantUserIds: readonly string[];
}

/**
 * Which sessions a renew must revoke in the same transaction, from the link
 * as it was and as it will be: a removed grant's sessions; every `grant`
 * session once the audience is `owner`; and every `token` session whose
 * token hash isn't the link's from now on (`keepTokenHash`; null, once the
 * audience stops being `link`, revokes them all). It doesn't wait for the
 * hourly re-check.
 */
export function renewNarrowing(before: LinkAccessShape, after: LinkAccessShape): {
  grantUserIds: string[];
  allGrants: boolean;
  keepTokenHash: string | null;
} {
  const allGrants = after.audience === 'owner';
  const kept = new Set(after.grantUserIds);
  return {
    grantUserIds: allGrants ? [] : before.grantUserIds.filter(id => !kept.has(id)),
    allGrants,
    keepTokenHash: after.audience === 'link' ? after.linkTokenHash : null,
  };
}
