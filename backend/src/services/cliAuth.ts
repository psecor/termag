/**
 * `termag` CLI sign-in: token format and lifetime, the browser-loopback
 * authorization code (PKCE S256), and the approval page.
 *
 * Flow: the CLI listens on 127.0.0.1:<port> and opens
 * /auth/cli/authorize?port&state&code_challenge&code_challenge_method=S256&device_name.
 * That page sits behind the normal browser sign-in (Okta at the ALB in
 * production). Approving it issues a single-use code and redirects to the
 * loopback; the CLI trades code + verifier at POST /api/cli/v1/token for a
 * device token. The token never appears in a URL.
 *
 * Pure: no Prisma, no Express. routes/cliAuthorize.ts and routes/cliApi.ts wire it.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

export const CLI_TOKEN_PREFIX = 'tmcli_';
export const CLI_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const CLI_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// lastUsedAt drives the idle window; a write per request buys nothing.
export const CLI_TOUCH_INTERVAL_MS = 60 * 1000;
export const AUTH_CODE_TTL_MS = 60 * 1000;
const AUTH_CODE_MAX_PENDING = 1000;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function generateCliToken(): { token: string; tokenHash: string; tokenPrefix: string } {
  const token = CLI_TOKEN_PREFIX + randomBytes(32).toString('hex');
  return { token, tokenHash: sha256Hex(token), tokenPrefix: token.slice(0, 14) + '…' };
}

export interface CliSessionTimes {
  createdAt: Date;
  lastUsedAt: Date;
  revokedAt: Date | null;
}

export interface CliSessionValidity {
  valid: boolean;
  reason?: 'revoked' | 'idle' | 'expired';
  /** When the token stops working if it is not used again. */
  expiresAt: Date;
  /** The hard limit, regardless of use. */
  maxExpiresAt: Date;
}

export function cliSessionValidity(s: CliSessionTimes, now: Date): CliSessionValidity {
  const maxExpiresAt = new Date(s.createdAt.getTime() + CLI_MAX_AGE_MS);
  const idleExpiresAt = new Date(s.lastUsedAt.getTime() + CLI_IDLE_MS);
  const expiresAt = idleExpiresAt < maxExpiresAt ? idleExpiresAt : maxExpiresAt;
  if (s.revokedAt) return { valid: false, reason: 'revoked', expiresAt, maxExpiresAt };
  if (now >= maxExpiresAt) return { valid: false, reason: 'expired', expiresAt, maxExpiresAt };
  if (now >= idleExpiresAt) return { valid: false, reason: 'idle', expiresAt, maxExpiresAt };
  return { valid: true, expiresAt, maxExpiresAt };
}

/** The validity after a use at `now`, which slides the idle window. */
export function cliSessionAfterUse(s: CliSessionTimes, now: Date): CliSessionValidity {
  return cliSessionValidity({ ...s, lastUsedAt: now }, now);
}

export function shouldTouch(lastUsedAt: Date, now: Date): boolean {
  return now.getTime() - lastUsedAt.getTime() >= CLI_TOUCH_INTERVAL_MS;
}

// RFC 7636: verifier is 43-128 unreserved characters; S256 challenge is 43
// base64url characters.
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const DEVICE_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function isValidDeviceName(name: unknown): name is string {
  return typeof name === 'string' && DEVICE_RE.test(name);
}

export interface AuthorizeParams {
  port: number;
  state: string;
  codeChallenge: string;
  deviceName: string;
}

/** Validate the authorize query (GET) or form (POST). Every field is required. */
export function parseAuthorizeParams(input: Record<string, unknown>): AuthorizeParams | { error: string } {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const portText = str('port');
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  if (!(port >= 1024 && port <= 65535)) return { error: 'port must be a loopback port between 1024 and 65535' };
  const state = str('state');
  if (!STATE_RE.test(state)) return { error: 'state is missing or malformed' };
  if (str('code_challenge_method') !== 'S256') return { error: 'code_challenge_method must be S256' };
  const codeChallenge = str('code_challenge');
  if (!CHALLENGE_RE.test(codeChallenge)) return { error: 'code_challenge is missing or malformed' };
  const deviceName = str('device_name');
  if (!isValidDeviceName(deviceName)) return { error: 'device_name must be 1-64 letters, digits, spaces, ".", "_" or "-"' };
  return { port, state, codeChallenge, deviceName };
}

export function loopbackRedirect(port: number, query: Record<string, string>): string {
  return `http://127.0.0.1:${port}/callback?${new URLSearchParams(query).toString()}`;
}

interface PendingCode {
  userId: string;
  deviceName: string;
  codeChallenge: string;
  expiresAt: number;
}

/**
 * Single-use authorization codes, held in memory: the orchestrator runs as one
 * replica, and a restart inside the 60 s window only means logging in again.
 * Codes are stored hashed so a heap dump does not hand out live codes.
 */
export class AuthCodeStore {
  private pending = new Map<string, PendingCode>();

  issue(grant: { userId: string; deviceName: string; codeChallenge: string }, now = Date.now()): string {
    this.sweep(now);
    if (this.pending.size >= AUTH_CODE_MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    const code = randomBytes(32).toString('base64url');
    this.pending.set(sha256Hex(code), { ...grant, expiresAt: now + AUTH_CODE_TTL_MS });
    return code;
  }

  /** Any attempt consumes the code, so a wrong verifier can't be retried. */
  redeem(code: string, verifier: string, now = Date.now()): { userId: string; deviceName: string } | null {
    if (typeof code !== 'string' || typeof verifier !== 'string' || !VERIFIER_RE.test(verifier)) return null;
    const key = sha256Hex(code);
    const entry = this.pending.get(key);
    if (!entry) return null;
    this.pending.delete(key);
    if (now >= entry.expiresAt) return null;
    const expected = Buffer.from(entry.codeChallenge);
    const actual = Buffer.from(pkceChallenge(verifier));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return { userId: entry.userId, deviceName: entry.deviceName };
  }

  get size(): number {
    return this.pending.size;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.pending) {
      if (now >= entry.expiresAt) this.pending.delete(key);
    }
  }
}

/**
 * CSRF guard for the approval POST. A browser sends Sec-Fetch-Site on every
 * request; anything other than same-origin is refused, including same-site
 * (sibling *.example.com hosts are exactly the attacker the audit's F7 names).
 * Without the header, fall back to an exact Origin match.
 */
export function isSameOriginPost(
  headers: { secFetchSite?: string; origin?: string },
  allowedOrigins: string[],
): boolean {
  if (headers.secFetchSite !== undefined) return headers.secFetchSite === 'same-origin';
  if (!headers.origin || headers.origin === 'null') return false;
  return allowedOrigins.includes(headers.origin);
}

/**
 * The approval page may only post back to itself, and the post's redirect may
 * only go to the CLI's loopback port.
 */
export function approvalPageHeaders(port: number): Record<string, string> {
  return {
    'Content-Security-Policy':
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1:${port}; ` +
      `frame-ancestors 'none'; base-uri 'none'`,
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

export const messagePageHeaders: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PAGE_STYLE =
  'body{font-family:system-ui,sans-serif;background:#0b0e14;color:#e6e6e6;display:flex;' +
  'justify-content:center;padding-top:12vh;margin:0}main{max-width:30rem;padding:2rem;' +
  'border:1px solid #2a2f3a;border-radius:12px;background:#121722}h1{font-size:1.25rem;margin-top:0}' +
  'code{background:#1d2330;padding:.1rem .35rem;border-radius:4px}.row{display:flex;gap:.75rem;margin-top:1.5rem}' +
  'button{font:inherit;padding:.55rem 1.1rem;border-radius:8px;border:1px solid #3a4150;background:#1d2330;color:inherit;cursor:pointer}' +
  'button.primary{background:#2f6fed;border-color:#2f6fed;color:#fff}p.muted{color:#9aa3b2;font-size:.9rem}';

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${PAGE_STYLE}</style></head>` +
    `<body><main>${body}</main></body></html>`;
}

export function renderApprovalPage(p: AuthorizeParams & { email: string; action: string }): string {
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  return page('Authorize termag CLI', [
    '<h1>Sign in the termag CLI?</h1>',
    `<p>The <code>termag</code> command line on <strong>${escapeHtml(p.deviceName)}</strong> is asking to act as ` +
      `<strong>${escapeHtml(p.email)}</strong>: list, create and manage your boxes and projects.</p>`,
    '<p class="muted">Only approve this if you just ran <code>termag login</code> yourself. The sign-in lasts until ' +
      'it goes unused for 7 days, or 30 days at most, and can be revoked from the web UI.</p>',
    `<form method="post" action="${escapeHtml(p.action)}">`,
    hidden('port', String(p.port)),
    hidden('state', p.state),
    hidden('code_challenge', p.codeChallenge),
    hidden('code_challenge_method', 'S256'),
    hidden('device_name', p.deviceName),
    '<div class="row"><button class="primary" type="submit" name="decision" value="approve">Authorize</button>',
    '<button type="submit" name="decision" value="deny">Cancel</button></div></form>',
  ].join(''));
}

export function renderMessagePage(title: string, message: string, linkHref?: string, linkText?: string): string {
  const link = linkHref ? `<p><a href="${escapeHtml(linkHref)}" style="color:#7aa7ff">${escapeHtml(linkText ?? linkHref)}</a></p>` : '';
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${link}`);
}
