// The simple UI's Claude Enterprise sign-in, orchestrator side.
// The box runs `claude auth login` (agent/claude-login.js). This module decides
// who may see what, and drops anything that is not a phase, a fixed error, or
// the SSO authorize URL. The one-time code is checked here so a token-shaped
// paste never reaches the box.

export const CLAUDE_LOGIN_CAPABILITY = 'claude-login-v1';

const PHASES = new Set(['ready', 'needed', 'starting', 'needs-code', 'submitting', 'failed', 'expired', 'unavailable']);
const CODE_RE = /^[A-Za-z0-9._~+/=-]{8,512}#[A-Za-z0-9._~+/=-]{8,512}$/;
const METHOD_RE = /^[a-z0-9._-]{1,40}$/i;

export type LoginPhase =
  | 'ready'
  | 'needed'
  | 'starting'
  | 'needs-code'
  | 'submitting'
  | 'failed'
  | 'expired'
  | 'unavailable'
  | 'owner'
  | 'offline';

export interface LoginView {
  phase: LoginPhase;
  loggedIn: boolean;
  authMethod: string;
  url?: string;
  error?: string;
}

/** Why a paste cannot be forwarded, or null. The text never includes the paste. */
export function loginCodeError(code: unknown): string | null {
  if (typeof code !== 'string') return 'Paste the full code from the Claude page.';
  const value = code.trim();
  if (/sk-ant/i.test(value)) return 'Paste the one-time code from the Claude page, not a token.';
  if (!CODE_RE.test(value)) return 'Paste the full code from the Claude page, including the #.';
  return null;
}

/** The SSO authorize URL Claude printed, or null. */
export function authorizeUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 4000) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'claude.com') return null;
  if (parsed.pathname !== '/cai/oauth/authorize') return null;
  if (!parsed.searchParams.get('code_challenge')) return null;
  if (parsed.searchParams.get('login_method') !== 'sso') return null;
  return url;
}

function safeError(error: unknown): string | undefined {
  if (typeof error !== 'string' || !error.trim()) return undefined;
  if (error.length > 240 || /sk-ant|#|code_challenge|oauth\/authorize/i.test(error)) {
    return 'Claude sign-in could not continue. Start again.';
  }
  return error;
}

/**
 * The view a browser may see. A collaborator learns that the owner must sign
 * in, and never receives the authorize URL. A logged-in box (the gateway, or
 * a finished sign-in) is always `ready`, with no URL.
 */
export function sanitizeLoginView(raw: unknown, owner: boolean): LoginView {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const loggedIn = body.loggedIn === true;
  const authMethod = typeof body.authMethod === 'string' && METHOD_RE.test(body.authMethod) ? body.authMethod : 'none';
  let phase: string = typeof body.phase === 'string' && PHASES.has(body.phase) ? body.phase : (loggedIn ? 'ready' : 'needed');
  if (loggedIn) phase = 'ready';
  if (!owner && !loggedIn && phase !== 'unavailable') {
    return {
      phase: 'owner',
      loggedIn: false,
      authMethod,
      error: 'The owner of this box needs to sign in to Claude Enterprise.',
    };
  }
  const view: LoginView = { phase: phase as LoginPhase, loggedIn, authMethod };
  const url = authorizeUrl(body.url);
  if (owner && url && (phase === 'needs-code' || phase === 'submitting')) view.url = url;
  const error = safeError(body.error);
  if (error && phase !== 'ready') view.error = error;
  return view;
}

export function loginTargetError(target: {
  instanceId: string | null;
  connected: boolean;
  capabilities: readonly string[];
}): { status: number; body: { error: string; code: string } } | null {
  if (target.instanceId == null) {
    return { status: 409, body: { error: 'This project has no box to sign Claude in on.', code: 'no-box' } };
  }
  if (!target.connected) {
    return { status: 503, body: { error: "The box's agent is offline.", code: 'offline' } };
  }
  if (!target.capabilities.includes(CLAUDE_LOGIN_CAPABILITY)) {
    return { status: 409, body: { error: "This box's termag needs an update before it can sign in to Claude here.", code: 'login-missing' } };
  }
  return null;
}

/** An agent error as the route's answer. The agent's text is not forwarded. */
export function loginRpcFailure(message: string): { status: number; body: { error: string; code: string } } {
  if (/Unknown command/.test(message)) {
    return { status: 409, body: { error: "This box's termag needs an update before it can sign in to Claude here.", code: 'login-missing' } };
  }
  if (/^Agent request timed out: claude-login-/.test(message)) {
    return { status: 504, body: { error: 'Claude sign-in took too long. Try again.', code: 'timeout' } };
  }
  return { status: 502, body: { error: 'Claude sign-in failed. Try again.', code: 'login-failed' } };
}

/** A login hint for `claude auth login --email`. Anything else is omitted. */
export function loginEmail(email: unknown): string | undefined {
  if (typeof email !== 'string') return undefined;
  const value = email.trim();
  if (value.length < 3 || value.length > 200 || value.startsWith('-')) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return undefined;
  return value;
}

export interface Attempt {
  ok: boolean;
  history: number[];
}

/** A sliding window of attempts. `history` is the timestamps to keep. */
export function allowLoginAttempt(history: readonly number[], now: number, limit: number, windowMs: number): Attempt {
  const next = history.filter(t => now - t < windowMs);
  if (next.length >= limit) return { ok: false, history: next };
  next.push(now);
  return { ok: true, history: next };
}

/**
 * Sliding window keyed by the caller. The route passes user and project, so
 * one chat does not spend another's attempts. The key is never a paste.
 * A window that has nothing left in it is dropped instead of kept empty.
 */
export function createAttemptGate(limit: number, windowMs: number, now: () => number = () => Date.now()): (key: string) => boolean {
  const histories = new Map<string, number[]>();
  return (key: string) => {
    const attempt = allowLoginAttempt(histories.get(key) ?? [], now(), limit, windowMs);
    if (attempt.history.length === 0) histories.delete(key);
    else histories.set(key, attempt.history);
    return attempt.ok;
  };
}
