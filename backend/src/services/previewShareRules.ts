/**
 * Preview shares: the pure rules, so the routes and
 * the browser socket's guest path stay thin and these are tested on their own.
 *
 *   - canonicalOrigin / parseRecipe: what a share may name. The agent
 *     (agent/browser-guest.js) applies the same rule again at every attach;
 *     this copy refuses a bad grant before it is stored.
 *   - safeAtPath: the share link's `?at=`, a path only.
 *   - resolveGuestAccess: whether this viewer may open this share now, and if
 *     not, the reason the viewer may be told.
 *   - guestPaneKey: the agent's pane key for a guest, `guest:<share>:<viewer>`.
 *   - Phase 2, link shares: the link token, the PR checks, the PR comment.
 */
import { createHash, createHmac } from 'node:crypto';
import type { PrFacts } from './prReview';

export const MAX_ORIGINS = 8;
/** A per-person share lives 1 hour to 7 days; the default comes from a flag. */
export const MIN_TTL_HOURS = 1;
export const MAX_TTL_HOURS = 168;
export const DEFAULT_TTL_HOURS = 24;
/** Guest browsers per box, as the agent clamps it too (agent/browser-guest.js). */
export const MAX_GUEST_PANES_CEILING = 10;
export const DEFAULT_MAX_GUEST_PANES = 5;
const MAX_AT_CHARS = 2048;

/**
 * Close codes the guest page reads (frontend PreviewPage): a refusal it shows
 * (final), a busy or short box (it redials), a dev stack that isn't there
 * (final), a box that failed the canary (final).
 */
export const GUEST_REFUSED_CLOSE_CODE = 4410;
export const GUEST_BUSY_CLOSE_CODE = 4429;
export const GUEST_STACK_CLOSE_CODE = 4424;
export const GUEST_UNSAFE_CLOSE_CODE = 4500;

/** `repo`: the ports of the checkout's environment file, the first one opened; resolved on the box (agent/browser-guest.js resolveRepoRecipe). */
export type OriginRecipe = { kind: 'webapp-dev-stack' } | { kind: 'repo' } | { kind: 'manual'; origins: string[] };

/**
 * `host:port` for a loopback origin, the form every check compares; null for
 * anything else. Mirrors agent/browser-guest.js canonicalOrigin: WHATWG
 * parsing folds 127.1 and the integer and hex forms into a dotted quad,
 * `localhost` is 127.0.0.1, the port is explicit or the scheme's default.
 */
export function canonicalOrigin(input: unknown, { requirePort = false } = {}): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > 300) return null;
  let raw = s;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (requirePort && !/:\d+$/.test(s)) return null;
    raw = `http://${s}`;
  }
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return null;
  if (url.username || url.password) return null;
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const port = url.port ? Number(url.port) : (secure ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let host = url.hostname.toLowerCase();
  if (host === 'localhost') host = '127.0.0.1';
  if (host === '[::1]') return `[::1]:${port}`;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m || Number(m[1]) !== 127 || m.slice(2).some(p => Number(p) > 255)) return null;
  return `${host}:${port}`;
}

/**
 * A share's recipe as the owner asked for it, or an error. With no origins,
 * the workstream's webapp dev stack; otherwise up to eight loopback origins,
 * each with its port. The first origin keeps its scheme (an https:// app is
 * opened over HTTPS); the rest only need host and port.
 */
export function parseRecipe(input: unknown): { recipe: OriginRecipe } | { error: string } {
  if (input === undefined || input === null) return { recipe: { kind: 'webapp-dev-stack' } };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'recipe must be an object' };
  const r = input as Record<string, unknown>;
  if (r.kind === 'webapp-dev-stack') return { recipe: { kind: 'webapp-dev-stack' } };
  if (r.kind === 'repo') return { recipe: { kind: 'repo' } };
  if (r.kind !== 'manual') return { error: 'recipe.kind must be webapp-dev-stack, repo or manual' };
  if (!Array.isArray(r.origins) || r.origins.length === 0) return { error: 'a manual recipe needs at least one origin' };
  if (r.origins.length > MAX_ORIGINS) return { error: `at most ${MAX_ORIGINS} origins` };
  const seen = new Set<string>();
  const origins: string[] = [];
  for (const o of r.origins) {
    const c = canonicalOrigin(o, { requirePort: true });
    if (!c) return { error: `not a loopback origin with a port: ${String(o).slice(0, 80)}` };
    if (seen.has(c)) continue;
    seen.add(c);
    // Kept as given (trimmed), so the agent sees the first one's scheme.
    origins.push(String(o).trim());
  }
  return { recipe: { kind: 'manual', origins } };
}

/** A share's lifetime in hours: the request's, else the flag's, clamped to 1..168. */
export function ttlHours(requested: unknown, flagDefault: number): number {
  const fallback = Number.isFinite(flagDefault) ? flagDefault : DEFAULT_TTL_HOURS;
  const n = requested === undefined || requested === null ? fallback : Number(requested);
  const v = Number.isFinite(n) ? n : fallback;
  return Math.min(MAX_TTL_HOURS, Math.max(MIN_TTL_HOURS, Math.round(v)));
}

/** The flag-sized guest pool, clamped as the agent clamps it. */
export function maxGuestPanes(flagValue: number): number {
  const n = Number.isFinite(flagValue) ? Math.round(flagValue) : DEFAULT_MAX_GUEST_PANES;
  return Math.min(MAX_GUEST_PANES_CEILING, Math.max(0, n));
}

/**
 * The share link's `?at=`: a path, nothing else. It must start with one `/`
 * (never `//` or `/\`), hold no backslash or control character, and fit; the
 * agent resolves it against the share's first origin and checks the origin
 * again. Null for anything else.
 */
export function isShareId(v: unknown): v is string {
  // Length first: the pattern is linear, but the input is bounded before it is matched.
  return typeof v === 'string' && v.length >= 10 && v.length <= 64 && /^[a-z0-9]+$/.test(v);
}

/**
 * A redirect target on this site, under `basePath`: a path, never `//host`,
 * `/\host` or a URL, with no backslash or control character. Null for
 * anything else. Every redirect the share link sends goes through it.
 */
export function localRedirectPath(basePath: string, target: unknown): string | null {
  if (typeof target !== 'string' || target.length > 4096) return null;
  if (!target.startsWith(`${basePath}/`)) return null;
  if (/^\/[/\\]/.test(target)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(target)) return null;
  return target;
}

export function safeAtPath(at: unknown): string | null {
  if (typeof at !== 'string' || !at || at.length > MAX_AT_CHARS) return null;
  if (!/^\/(?![/\\])/.test(at)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(at)) return null;
  let decoded = at;
  try { decoded = decodeURIComponent(at); } catch { return null; }
  if (/^\/[/\\]/.test(decoded)) return null;
  return at;
}

// webapp's seeded owner account, in its QUICKSTART.md: what a reviewer of a
// webapp dev stack signs in with (decision 9).
export const WEBAPP_REVIEWER_ACCOUNT = 'reviewer@example.com / example-password';
const MAX_HINT_CHARS = 200;

/**
 * What the guest page tells a reviewer to sign in with: the project's own
 * hint when it set one, else webapp's seeded account for a webapp dev
 * stack, else nothing.
 */
export function reviewerSignInHint(recipe: OriginRecipe, projectHint?: string | null): string | null {
  const own = typeof projectHint === 'string' ? projectHint.trim().slice(0, MAX_HINT_CHARS) : '';
  if (own) return own;
  return recipe.kind === 'webapp-dev-stack' ? WEBAPP_REVIEWER_ACCOUNT : null;
}

export function guestPaneKey(shareId: string, viewerId: string): string {
  return `guest:${shareId}:${viewerId}`;
}

export interface GuestShare {
  id: string;
  audience: string;
  granteeId: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  endedAt: Date | null;
  endedReason: string | null;
}

export type GuestRefusal = 'not-shared' | 'expired' | 'revoked' | 'ended' | 'viewer-revoked' | 'workstream-gone' | 'project-archived';

export type GuestAccess =
  | { ok: true }
  /** `toGrantee`: whether the viewer may be told this reason; anyone else gets the uniform not-shared. */
  | { ok: false; reason: GuestRefusal; endedReason?: string | null; toGrantee: boolean };

/**
 * Whether `viewerId` may open `share` now. Someone the share isn't for always
 * gets the same `not-shared`, whatever the share's state, so a link reveals
 * nothing to them. The person it is for is told why: expired, revoked, ended,
 * their own access revoked, the workstream or project gone. A grant never
 * gives anything but a guest pane: the owner and full collaborators keep their
 * own path (routes/browserWs.ts), never this one.
 */
export function resolveGuestAccess(input: {
  share: GuestShare | null;
  viewerId: string;
  /** Phase 2: the viewer's row on a link share, made only by the token route. */
  viewerRow?: { revokedAt: Date | null } | null;
  workstream: { archived: boolean } | null;
  projectArchived: boolean;
  now: number;
}): GuestAccess {
  const { share, viewerId, viewerRow, workstream, projectArchived, now } = input;
  if (!share) return { ok: false, reason: 'not-shared', toGrantee: false };
  if (share.audience === 'user') {
    if (share.granteeId !== viewerId) return { ok: false, reason: 'not-shared', toGrantee: false };
  } else if (share.audience === 'link') {
    if (!viewerRow) return { ok: false, reason: 'not-shared', toGrantee: false };
    if (viewerRow.revokedAt) return { ok: false, reason: 'viewer-revoked', toGrantee: true };
  } else {
    return { ok: false, reason: 'not-shared', toGrantee: false };
  }
  return shareLiveness({ share, workstream, projectArchived, now });
}

/**
 * A share's own state, for someone already entitled to know it: live, or
 * why not (revoked, ended, the project or workstream gone, expired). The
 * grantee reaches it through resolveGuestAccess; the share's owner (their
 * "Preview as guest", their own link) directly, whatever its audience.
 */
export function shareLiveness(input: {
  share: GuestShare;
  workstream: { archived: boolean } | null;
  projectArchived: boolean;
  now: number;
}): GuestAccess {
  const { share, workstream, projectArchived, now } = input;
  if (share.revokedAt) return { ok: false, reason: 'revoked', toGrantee: true };
  if (share.endedAt) return { ok: false, reason: 'ended', endedReason: share.endedReason, toGrantee: true };
  if (projectArchived) return { ok: false, reason: 'project-archived', toGrantee: true };
  if (!workstream || workstream.archived) return { ok: false, reason: 'workstream-gone', toGrantee: true };
  if (share.expiresAt.getTime() <= now) return { ok: false, reason: 'expired', toGrantee: true };
  return { ok: true };
}

/** What the guest is told for a refusal, and the close code their pane reads (final: it does not redial). */
export const GUEST_REFUSAL_MESSAGES: Record<GuestRefusal, string> = {
  'not-shared': "This preview isn't shared with you.",
  expired: 'This preview has expired. Ask its owner to share it again.',
  revoked: 'Its owner stopped sharing this preview.',
  ended: 'This preview has ended.',
  'viewer-revoked': 'Its owner removed your access to this preview.',
  'workstream-gone': 'The workstream this preview showed is gone.',
  'project-archived': 'The project this preview showed was archived.',
};

/**
 * What an agent's guest refusal (agent/browser-pane.js attach: `guest-…`
 * codes) becomes for the viewer: a close code, whether the pane redials, and
 * a message. `checkout`: the share shows a checkout that isn't a
 * workstream's own (4d), so its dev-stack messages say "checkout".
 */
export function guestAttachRefusal(message: string, opts: { checkout?: boolean } = {}): { code: number; retry: boolean; message: string } {
  const m = message.match(/^(?:Error: )?(guest-[a-z]+)(?::([a-z-]+))?/);
  const code = m ? m[1] : '';
  const reason = m ? m[2] : '';
  switch (code) {
    case 'guest-busy': {
      // Only the agent's own two sentences are passed on; anything else is
      // told generically. The reviewer never sees the agent's raw text.
      const said = message.replace(/^(Error: )?guest-busy: /, '');
      const known = /^(\d{1,2} reviewers? (is|are) already using this preview|this box takes no reviewers right now)$/.test(said);
      return { code: GUEST_BUSY_CLOSE_CODE, retry: true, message: `${known ? said.charAt(0).toUpperCase() + said.slice(1) : 'This preview is busy right now'}. Trying again shortly.` };
    }
    case 'guest-memory':
      return { code: GUEST_BUSY_CLOSE_CODE, retry: true, message: "The owner's box is short of memory right now. Trying again shortly." };
    case 'guest-stack': {
      const why: Record<string, string> = {
        'stack-not-running': "This workstream's dev stack isn't running on the owner's box.",
        // Another checkout's: another workstream's, another project's, or one
        // outside termag's projects (~/src/webapp). The guest is never told which.
        'other-workstream': "The dev stack running on the owner's box was started from another checkout, not this workstream's.",
        'not-a-dev-stack': "This workstream has no webapp dev stack to show.",
        'no-checkout': "This workstream's checkout isn't on the owner's box.",
        unverifiable: "The owner's box can't confirm which dev stack is running.",
        'no-origins': 'This preview names no address to show.',
        'bad-recipe': 'This preview is set up wrongly. Ask its owner to share it again.',
        'no-environment': "This workstream's environment file names no port to show.",
      };
      if (opts.checkout) {
        Object.assign(why, {
          'stack-not-running': "This checkout's dev stack isn't running on the owner's box.",
          'other-workstream': "The dev stack running on the owner's box was started from another checkout, not the one this preview shows.",
          'not-a-dev-stack': "This checkout has no webapp dev stack to show.",
          'no-checkout': "This checkout isn't on the owner's box any more.",
        });
      }
      return { code: GUEST_STACK_CLOSE_CODE, retry: false, message: why[reason] ?? 'The app this preview shows is not available.' };
    }
    case 'guest-unsafe':
      return { code: GUEST_UNSAFE_CLOSE_CODE, retry: false, message: "The owner's box couldn't confirm a reviewer's browser is kept to the shared app, so it won't open one." };
    case 'guest-unavailable':
      return { code: 4501, retry: false, message: "The owner's box can't run a reviewer's browser yet (it needs an update)." };
    case 'guest-url':
      return { code: 1008, retry: false, message: 'That address is not part of the shared preview.' };
    default:
      // The agent's own error text stays in the server log and the share's
      // events (its owner's to read); the reviewer is told only that it failed.
      return { code: 1011, retry: false, message: "Could not start a browser on the owner's box. Try again in a moment." };
  }
}

/**
 * An agent's refusal with the stack in the way split off: `guest-stack:<reason>:
 * started from <dir>` (agent/browser-pane.js attach) is `{ reason:
 * 'guest-stack:<reason>', holder: '<dir>' }`, anything else stays whole with a
 * null holder. The holder is the owner's to read (their share's events and
 * list); a guest is only ever told guestAttachRefusal's sentence.
 */
export function splitStackRefusal(message: string): { reason: string; holder: string | null } {
  const m = message.match(/^(?:Error: )?(guest-stack:[a-z-]+): started from (.+)$/s);
  if (!m) return { reason: message, holder: null };
  return { reason: m[1], holder: plainDir(m[2]) };
}

/** An absolute path with nothing to print but the path, or null: what a dir from the box may be shown as. */
function plainDir(dir: unknown): string | null {
  if (typeof dir !== 'string' || !dir.startsWith('/') || dir.length > 1024) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(dir)) return null;
  return dir;
}

/** A stack's compose working dir as its checkout: `<checkout>/dev-stack`. */
function checkoutOfComposeDir(dir: string): string {
  return dir.replace(/\/dev-stack\/*$/, '') || '/';
}

/**
 * A reviewer's last dev-stack refusal on a share, for its owner's list: when,
 * what the reviewer was told, and the checkout whose stack was in the way.
 * Null when there is none, when a reviewer got in after it (`lastOpenedAt` is
 * set by a successful guest attach only), or when the share was renewed
 * after it (`renewedAt`: sharing again, which can change its recipe, is the
 * only way a share's recipe changes).
 */
export function lastStackRefusal(
  event: { reason: string | null; detail: unknown; at: Date } | undefined,
  share: { lastOpenedAt: Date | null; renewedAt?: Date | null; checkout: boolean },
): { at: string; message: string; holder: string | null } | null {
  if (!event || !event.reason || !event.reason.startsWith('guest-stack:')) return null;
  for (const later of [share.lastOpenedAt, share.renewedAt]) {
    if (later && later.getTime() >= event.at.getTime()) return null;
  }
  const holder = plainDir((event.detail as { holder?: unknown } | null)?.holder);
  return {
    at: event.at.toISOString(),
    message: guestAttachRefusal(event.reason, { checkout: share.checkout }).message,
    holder: holder ? checkoutOfComposeDir(holder) : null,
  };
}

/** A dir on the box as its owner reads it: `/home/olive/src/webapp` is `~/src/webapp`. */
export function homeLabel(dir: string): string {
  const m = /^\/(?:home\/[^/]+|root)\/(.+)$/.exec(dir);
  return m ? `~/${m[1]}` : dir;
}

/** The share dialog's look at a workstream's dev stack (routes/previewShares.ts stackCheckFor). */
export type StackCheck =
  /** The box couldn't be asked: offline, asleep, or an agent older than browser-guest-check-v1. */
  | { checked: false }
  | { checked: true; ok: true }
  | {
    checked: true; ok: false; reason: string; message: string;
    /** Whose stack is in the way: its checkout, and the project's workstream that is when it is one. */
    holder: { dir: string; workstream: string | null } | null;
  };

/**
 * What the owner is told before sharing `workstream`'s dev stack, from the
 * agent's `browser-guest-check` answer: whether a reviewer would get in now,
 * and if not, why, in the owner's terms. `checkouts` are the project's live
 * workstreams and their checkouts on the box, as sent with the check, so a
 * stack started from one of them is named by its workstream ("Share it
 * instead"). The agent says which (`holderWorkstream`, compared on the box,
 * where a symlinked checkout resolves); only a name from `checkouts` counts,
 * and an older agent's answer falls back to comparing the paths as spelled.
 */
export function stackCheckView(raw: unknown, ctx: { workstream: string; checkouts: Array<{ workstream: string; dir: string }> }): StackCheck {
  if (!raw || typeof raw !== 'object') return { checked: false };
  const r = raw as { ok?: unknown; reason?: unknown; holder?: unknown; holderWorkstream?: unknown };
  if (r.ok === true) return { checked: true, ok: true };
  const reason = typeof r.reason === 'string' ? r.reason : '';
  const composeDir = plainDir(r.holder);
  const dir = composeDir ? checkoutOfComposeDir(composeDir) : null;
  const named = typeof r.holderWorkstream === 'string' ? ctx.checkouts.find(c => c.workstream === r.holderWorkstream) : undefined;
  const match = named ?? (dir ? ctx.checkouts.find(c => c.dir === dir) : undefined);
  const holder = dir ? { dir, workstream: match && match.workstream !== ctx.workstream ? match.workstream : null } : null;
  const ws = ctx.workstream;
  const refused = 'so a reviewer would be refused';
  let message: string;
  switch (reason) {
    case 'other-workstream':
      message = holder?.workstream
        ? `The dev stack on your box was started from the ${holder.workstream} workstream, not ${ws}, ${refused}. Share ${holder.workstream} instead, or stop that stack and start ${ws}'s.`
        : holder
          ? `The dev stack on your box was started from ${homeLabel(holder.dir)}, not ${ws}'s checkout, ${refused} until ${ws}'s own stack runs.`
          : `Something other than ${ws}'s dev stack answers on its address on your box, ${refused}.`;
      break;
    case 'stack-not-running':
      message = `${ws}'s dev stack isn't running on your box, ${refused} until it is.`;
      break;
    case 'not-a-dev-stack':
      message = `${ws} has no webapp dev stack. Share addresses on this box instead.`;
      break;
    case 'no-checkout':
      message = `${ws}'s checkout isn't on your box.`;
      break;
    case 'unverifiable':
      message = "Your box can't tell which dev stack is running right now.";
      break;
    default:
      message = 'Your box could not check the dev stack.';
  }
  return { checked: true, ok: false, reason, message, holder };
}

/**
 * 4d: a link share's checkout is on another branch than its PR's, so its
 * guest is refused rather than shown it (routes/browserWs.ts). Final: the
 * share stays, and opening it again after the owner switches back works.
 */
export function checkoutMovedMessage(branch: string, prBranch: string): string {
  const shown = branch === 'HEAD' ? 'no branch (a detached HEAD)' : branch;
  return `The owner's checkout is on ${shown} now, not this pull request's ${prBranch}. Open the preview again once they switch back.`;
}

// ── Phase 2: PR link shares ──────────────────────────────────────────────────

/** A link share lives until its PR merges or closes, or this long. */
export const LINK_SHARE_DAYS = 14;

/**
 * A link share's token: 128 bits, an HMAC of the share's id under the
 * server's secret, so its owner can copy the link again while only its hash
 * is stored (PreviewShare.linkTokenHash, which the link route looks up).
 * Nobody without the secret can make one; a new secret retires every link.
 */
export function linkTokenFor(secret: string, shareId: string): string {
  return createHmac('sha256', secret).update(`preview-link|${shareId}`).digest('hex').slice(0, 32);
}

export function linkTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 32 hex characters: never a share id (a cuid), so the link route tells them apart. */
export function isLinkToken(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
}

/**
 * An open link: a link share with no pull request behind it, made from the
 * share dialog with nobody named, for anyone signed in to termag who opens
 * its link. It lasts as a per-person share does (the dialog's lifetime,
 * extendable), and never holds `activeLinkKey`, so a PR's link share of the
 * same workstream never supersedes it.
 */
export function isOpenLink(share: { audience: string; prRepo: string | null; prNumber: number | null }): boolean {
  return share.audience === 'link' && !share.prRepo && share.prNumber === null;
}

/** The value of `activeLinkKey` while a workstream's link share is live: its row id, or `<project>:main`. */
export function activeLinkKeyOf(projectId: string, workstreamId: string | null): string {
  return workstreamId ?? `${projectId}:main`;
}

/**
 * What a link share is for: the PR's checkout as the box reports it (4d,
 * services/prCheckout.ts), or, from a box agent too old to report one, the
 * server's own records: the project's repository and the workstream's branch.
 * GitHub still decides authorship, state, visibility and forks.
 */
export interface LinkShareTarget {
  /** The repository as `owner/name`: the project's (Project.repoUrl), or the checkout's origin (4d); null when there is none. */
  repo: string | null;
  /** The branch: the workstream's (Workstream.branch), or the checkout's (4d). */
  branch: string | null;
  /** A draft may be shared too (browser-pane-pr-draft-shares-enabled, for this repository). */
  draftsOk?: boolean;
}

export type LinkSharePrRefusal = 'not-open' | 'draft' | 'public' | 'other-repo' | 'fork' | 'not-author' | 'other-branch' | 'no-repo';

export const LINK_SHARE_PR_MESSAGES: Record<LinkSharePrRefusal, string> = {
  'not-open': 'That pull request is not open.',
  draft: 'That pull request is a draft. Mark it ready for review, then share it.',
  public: 'Only pull requests in private or internal repositories can be shared: a public one would put the link where anyone can see it.',
  'other-repo': "That pull request is not in this project's repository.",
  fork: "That pull request's branch is in a fork, not in this project's repository.",
  'not-author': 'Only the pull request\'s author can share its preview.',
  'other-branch': "That pull request's branch is not this workstream's.",
  'no-repo': 'This project has no GitHub repository on record, so its pull requests cannot be checked.',
};

/**
 * Whether a PR may have a link share for `target`.
 * Every link share: open, not a draft unless
 * the target allows drafts, a private or internal repository, the target's
 * own repository. A share an
 * owner makes also needs them to be its author (the token's own user, read
 * now) and its head to be the workstream's branch in that repository.
 */
/**
 * The checks that need only GitHub (4d, item 1): run
 * before the box is asked about checkouts, so a PR that could never be
 * shared costs the box nothing. checkLinkSharePr repeats them.
 */
export function checkLinkSharePrOnGithub(
  facts: PrFacts,
  opts: { draftsOk?: boolean },
): { ok: true } | { ok: false; reason: LinkSharePrRefusal; message: string } {
  const no = (reason: LinkSharePrRefusal) => ({ ok: false as const, reason, message: LINK_SHARE_PR_MESSAGES[reason] });
  if (facts.state !== 'OPEN') return no('not-open');
  if (facts.isDraft && !opts.draftsOk) return no('draft');
  if (facts.visibility !== 'PRIVATE' && facts.visibility !== 'INTERNAL') return no('public');
  if (facts.author.id === null || facts.author.id !== facts.viewer.id) return no('not-author');
  if (facts.crossRepo) return no('fork');
  return { ok: true };
}

/** Why no checkout on the box could be shared for a PR (services/prCheckout.ts), as its owner is told. */
export function checkoutRefusalMessage(reason: 'no-checkout' | 'ambiguous-checkout' | 'checkout-unreadable', pr: { repo: string; branch: string }, looked: string[]): string {
  const where = looked.length ? ` It looked in ${looked.join(', ')}.` : '';
  switch (reason) {
    case 'no-checkout':
      return `This box has no checkout of ${pr.repo} on ${pr.branch}, so there is no preview to share.${where}`;
    case 'ambiguous-checkout':
      return `More than one checkout of ${pr.repo} on this box is on ${pr.branch}, and none is at the pull request's head, so termag can't tell which to share.${where}`;
    case 'checkout-unreadable':
      return `termag couldn't read every checkout on this box just now, so it can't tell which one holds ${pr.branch}. Try again in a moment.`;
  }
}

export function checkLinkSharePr(
  facts: PrFacts,
  target: LinkShareTarget,
  madeBy: 'owner' | 'system' = 'owner',
): { ok: true } | { ok: false; reason: LinkSharePrRefusal; message: string } {
  const no = (reason: LinkSharePrRefusal) => ({ ok: false as const, reason, message: LINK_SHARE_PR_MESSAGES[reason] });
  if (!target.repo) return no('no-repo');
  if (facts.state !== 'OPEN') return no('not-open');
  if (facts.isDraft && !target.draftsOk) return no('draft');
  if (facts.visibility !== 'PRIVATE' && facts.visibility !== 'INTERNAL') return no('public');
  if (facts.repo.toLowerCase() !== target.repo.toLowerCase()) return no('other-repo');
  if (madeBy === 'owner') {
    if (facts.author.id === null || facts.author.id !== facts.viewer.id) return no('not-author');
    if (facts.crossRepo) return no('fork');
    if (!target.branch || facts.headBranch !== target.branch) return no('other-branch');
  }
  return { ok: true };
}

/** Marks a preview comment as termag's, with its share. */
export const PREVIEW_COMMENT_MARKER = 'termag-preview-share';

/** The PR comment a link share is announced with. */
export function previewCommentBody(input: { link: string; shareId: string; signInHint: string | null; ownerName: string }): string {
  const signIn = input.signInHint ? ` Sign in as \`${input.signInHint.replace(/`/g, "'")}\`.` : '';
  return [
    `🔍 **Preview this PR on a live dev stack:** ${input.link}${signIn}`,
    '',
    `<sub>Your own browser on ${input.ownerName.replace(/[<>]/g, '')}'s termag box, kept to this PR's app. Any signed-in termag user can open it; it ends when this PR merges or closes, or after ${LINK_SHARE_DAYS} days.</sub>`,
    `<!-- ${PREVIEW_COMMENT_MARKER}:${input.shareId} -->`,
  ].join('\n');
}

const ENDED_TEXT: Record<string, string> = {
  merged: 'Preview ended: this PR merged.',
  closed: 'Preview ended: this PR closed.',
  expired: `Preview ended after ${LINK_SHARE_DAYS} days.`,
  revoked: 'Preview stopped by its owner.',
  'workstream-removed': 'Preview ended: its workstream was removed.',
  'project-archived': 'Preview ended: its project was archived.',
  'token-invalid': 'Preview ended: its owner\'s GitHub access lapsed.',
};

/** What a preview comment becomes when its share ends (the link is gone from it). */
export function endedCommentBody(reason: string, shareId: string, supersededBy?: number | null): string {
  const text = reason === 'superseded'
    ? `Preview moved${supersededBy ? ` to #${supersededBy}` : ''}: this workstream now previews another PR.`
    : ENDED_TEXT[reason] ?? 'Preview ended.';
  return `🔍 ~~Preview this PR on a live dev stack~~\n\n${text}\n<!-- ${PREVIEW_COMMENT_MARKER}:${shareId} -->`;
}

// ── Phase 2, 4b: waking the box ─────────────────────────────────────────────

/** A reviewer's wakes, per owner across all their shares: one per 30 minutes, six in any 24 hours. */
export const WAKE_EVERY_MS = 30 * 60 * 1000;
export const WAKES_PER_DAY = 6;
const DAY_MS = 24 * 3600 * 1000;

export type WakeRefusal = 'not-wakeable' | 'no-box' | 'awake' | 'not-auto' | 'too-soon' | 'daily';

export const WAKE_MESSAGES: Record<WakeRefusal, string> = {
  'not-wakeable': "This preview can't wake its box. Ask its owner to start it.",
  'no-box': 'This preview has no box to wake.',
  awake: 'The box is not asleep.',
  'not-auto': "Its owner put this box to sleep themselves, so only they can start it. Ask them to.",
  'too-soon': 'This box was woken for a reviewer a few minutes ago. Try again later, or ask its owner.',
  daily: "This owner's box has been woken for reviewers as often as it may be today. Ask its owner to start it.",
};

/**
 * Whether a reviewer may wake this box (Phase 2
 * item 5): only one the idle sweep stopped (`sweepStopped`,
 * boxLifecyclePolicy.isSweepStopped), or hibernated before parking became a
 * stop, and nobody has touched since; never one its owner stopped or
 * hibernated, which may hold work in progress or come back without its dev
 * stack. Null when it may;
 * the owner's power checks (boxPowerPolicy.powerRequestError) still run after this.
 */
export function guestWakeRefusal(
  box: { status: string; lifecycleNote: string | null; autoTerminatedAt: Date | null; parkedAt?: Date | null } | null,
  isAutoNote: (note: string | null) => boolean,
  sweepStopped: (box: { parkedAt?: Date | null; lifecycleNote: string | null }) => boolean,
): WakeRefusal | null {
  if (!box || box.autoTerminatedAt) return 'no-box';
  if (box.status === 'stopped') return sweepStopped(box) ? null : 'not-auto';
  if (box.status !== 'hibernated') return 'awake';
  if (!isAutoNote(box.lifecycleNote)) return 'not-auto';
  return null;
}

/**
 * The owner's wake budget against the wakes already made for their shares
 * (any viewer, any share), in the last 24 hours: the next one waits 30
 * minutes after the last, and there are six in any rolling day. `retryAt`
 * is when the next would fit.
 */
export function wakeBudget(wokeAt: Date[], now: number): { ok: true } | { ok: false; reason: 'too-soon' | 'daily'; retryAt: number } {
  const recent = wokeAt.map(d => d.getTime()).filter(t => now - t < DAY_MS).sort((a, b) => a - b);
  const last = recent[recent.length - 1];
  // The day's cap first: when both apply, the later of the two is when a wake fits again.
  if (recent.length >= WAKES_PER_DAY) {
    const dayFrees = recent[recent.length - WAKES_PER_DAY] + DAY_MS;
    return { ok: false, reason: 'daily', retryAt: last !== undefined ? Math.max(dayFrees, last + WAKE_EVERY_MS) : dayFrees };
  }
  if (last !== undefined && now - last < WAKE_EVERY_MS) return { ok: false, reason: 'too-soon', retryAt: last + WAKE_EVERY_MS };
  return { ok: true };
}

// ── Phase 2, 4c: automatic shares ───────────────────────────────────────────

/** A PR with this label is never shared automatically (an owner can still share it by hand). */
export const NO_PREVIEW_LABEL = 'no-preview';
export const MAX_PATH_FILTERS = 20;
const MAX_PATH_CHARS = 200;
const MAX_HINT_INPUT = 200;

/**
 * A project's path filter as its owner typed it: path prefixes (`static/`,
 * `internal/api`), one per entry, matched against a PR's changed paths. A
 * leading `./` or `/` is dropped; `..`, a backslash or a control character
 * is refused. Empty means any PR.
 */
export function parsePathFilter(input: unknown): { filter: string[] } | { error: string } {
  if (input === undefined || input === null) return { filter: [] };
  const raw = typeof input === 'string' ? input.split(/[\s,]+/) : Array.isArray(input) ? input : null;
  if (!raw) return { error: 'pathFilter must be a list of path prefixes' };
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return { error: 'pathFilter must be a list of path prefixes' };
    const p = entry.trim().replace(/^\.?\/+/, '');
    if (!p) continue;
    // eslint-disable-next-line no-control-regex
    if (p.length > MAX_PATH_CHARS || /(^|\/)\.\.(\/|$)|[\\\u0000-\u001f\u007f]/.test(p)) return { error: `not a path prefix: ${p.slice(0, 60)}` };
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > MAX_PATH_FILTERS) return { error: `at most ${MAX_PATH_FILTERS} path prefixes` };
  return { filter: out };
}

/** The reviewer sign-in hint as typed: trimmed, at most 200 characters, null when empty. */
export function parseAccountHint(input: unknown): { hint: string | null } | { error: string } {
  if (input === undefined || input === null) return { hint: null };
  if (typeof input !== 'string') return { error: 'reviewerAccountHint must be text' };
  const h = input.trim();
  if (h.length > MAX_HINT_INPUT) return { error: `reviewerAccountHint is at most ${MAX_HINT_INPUT} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(h)) return { error: 'reviewerAccountHint is one line of text' };
  return { hint: h || null };
}

/** Whether a changed path is under a filter entry: the entry itself, or a path below it. */
function underPrefix(path: string, prefix: string): boolean {
  if (prefix.endsWith('/')) return path.startsWith(prefix);
  return path === prefix || path.startsWith(`${prefix}/`);
}

export type AutoShareSkip = 'off' | 'label' | 'paths';

/**
 * Whether a PR its owner just opened is shared automatically (docs/
 * preview-share.md, Phase 2 item 6): only when the project says so, never
 * with the `no-preview` label, and with a path filter only when the PR
 * changes a path under it. A PR too big to read every path of (`complete`
 * false) with no match among those read is shared: its size says it most
 * likely touches the app. The PR checks of a link share run as well.
 */
export function autoShareDecision(input: { enabled: boolean; filter: string[]; labels: string[]; paths: string[]; complete: boolean }): { share: true } | { share: false; why: AutoShareSkip } {
  if (!input.enabled) return { share: false, why: 'off' };
  if (input.labels.some(l => l.toLowerCase() === NO_PREVIEW_LABEL)) return { share: false, why: 'label' };
  if (input.filter.length === 0) return { share: true };
  if (input.paths.some(p => input.filter.some(f => underPrefix(p, f)))) return { share: true };
  return input.complete ? { share: false, why: 'paths' } : { share: true };
}
