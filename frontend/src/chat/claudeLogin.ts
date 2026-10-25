// What the simple UI may show for Claude Enterprise sign-in. The one-time
// code is typed into a blocked input and sent once; nothing here keeps it.

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

export interface ClaudeLoginView {
  phase: LoginPhase;
  loggedIn: boolean;
  authMethod?: string;
  url?: string;
  error?: string;
}

const CODE_RE = /^[A-Za-z0-9._~+/=-]{8,512}#[A-Za-z0-9._~+/=-]{8,512}$/;
const FLOW = new Set(['starting', 'needs-code', 'submitting', 'failed', 'expired']);

export type LoginTransport = 'offline' | 'missing' | 'no-box' | 'rate' | 'failed' | null;

export interface LoginCardModel {
  mode: 'hidden' | 'signed-in' | 'needed' | 'starting' | 'needs-code' | 'submitting' | 'retry' | 'offline' | 'owner' | 'quiet';
  title: string;
  body: string;
  error?: string;
  url?: string;
  primary?: 'start' | 'retry';
}

/** The SSO authorize URL, or null. Anything else is not opened. */
export function claudeAuthorizeUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 4000) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'claude.com') return null;
  if (parsed.pathname !== '/cai/oauth/authorize') return null;
  if (!parsed.searchParams.get('code_challenge')) return null;
  if (parsed.searchParams.get('login_method') !== 'sso') return null;
  return url;
}

/** Why a paste cannot be sent, or null. The text never includes the paste. */
export function loginCodeError(code: unknown): string | null {
  if (typeof code !== 'string') return 'Paste the full code from the Claude page.';
  const value = code.trim();
  if (/sk-ant/i.test(value)) return 'Paste the one-time code from the Claude page, not a token.';
  if (!CODE_RE.test(value)) return 'Paste the full code from the Claude page, including the #.';
  return null;
}

export function sawLoginFlow(phase: string | undefined): boolean {
  return Boolean(phase && FLOW.has(phase));
}

/**
 * The view a status poll may apply. A read that started before start/submit
 * settled (requestGen behind latestGen) must not replace that result: the
 * poll can still say logged out after the box is signed in.
 * Returns the current view when the read is stale, including null.
 */
const OPEN_LOGIN = new Set(['starting', 'needs-code', 'submitting']);

export function takeLoginView(
  current: ClaudeLoginView | null,
  incoming: ClaudeLoginView,
  requestGen: number,
  latestGen: number,
): ClaudeLoginView | null {
  if (requestGen !== latestGen) return current;
  // A status miss reports unavailable. That must not replace a sign-in that
  // is still waiting for the code: the card would stop polling and hide the
  // paste field while the CLI is still running.
  if (incoming.phase === 'unavailable' && current && OPEN_LOGIN.has(current.phase)) return current;
  return incoming;
}

export function loginTransport(err: unknown): LoginTransport {
  const data = (err as { response?: { status?: number; data?: { code?: string } } })?.response;
  const code = data?.data?.code;
  if (code === 'offline' || data?.status === 503) return 'offline';
  if (code === 'login-missing') return 'missing';
  if (code === 'no-box') return 'no-box';
  if (code === 'rate-limited' || data?.status === 429) return 'rate';
  if (data?.status === 504 || data?.status === 502 || code === 'timeout' || code === 'login-failed') return 'failed';
  if (!data) return 'offline';
  return 'failed';
}

/** A server error the card may show. Anything that looks like a paste is dropped. */
export function safeLoginMessage(error: unknown): string | undefined {
  if (typeof error !== 'string' || !error.trim()) return undefined;
  if (error.length > 240 || /sk-ant|#|code_challenge|oauth\/authorize/i.test(error)) {
    return 'Claude sign-in could not continue. Start again.';
  }
  return error;
}

function needed(): LoginCardModel {
  return {
    mode: 'needed',
    title: 'Sign in to Claude Enterprise',
    body: 'This box is not signed in through the termag gateway. You will sign in with your company account in the browser. This page never sees your password, and the login stays on the box.',
    primary: 'start',
  };
}

function retry(error: string | undefined, fallback: string): LoginCardModel {
  return {
    mode: 'retry',
    title: 'Sign in to Claude Enterprise',
    body: 'Sign-in did not finish.',
    error: error || fallback,
    primary: 'retry',
  };
}

/**
 * The card for one status. A box that is already signed in (the gateway, or
 * a finished login) draws nothing until this tab has been through a sign-in.
 * A collaborator never gets a link or a button.
 */
export function loginCard(
  view: ClaudeLoginView | null,
  opts: { owner: boolean; engaged: boolean; transport: LoginTransport; transportError?: string },
): LoginCardModel | null {
  if (!opts.owner) {
    if (view?.phase === 'ready' || view?.phase === 'unavailable') return null;
    if (opts.transport === 'missing' || opts.transport === 'no-box') return null;
    if (!view && !opts.transport) return null;
    return {
      mode: 'owner',
      title: 'Claude Enterprise',
      body: 'The owner of this box needs to sign in to Claude Enterprise.',
    };
  }
  // A chat with no box cannot sign in here. Saying so on every visit is noise.
  if (opts.transport === 'no-box') return null;
  if (opts.transport === 'missing') {
    return { mode: 'quiet', title: 'Claude Enterprise', body: "This box's termag needs an update before sign-in can happen here." };
  }
  if (view?.phase === 'ready') {
    if (!opts.engaged) return null;
    return { mode: 'signed-in', title: 'Claude Enterprise', body: 'Signed in to Claude. You can send a message.' };
  }
  if (opts.transport === 'offline' && (!view || view.phase === 'needed' || view.phase === 'offline')) {
    return {
      mode: 'offline',
      title: 'Sign in to Claude Enterprise',
      body: 'Waiting for this box to come online. Sign-in will be here once it is.',
    };
  }
  if (opts.transport === 'rate') return retry(opts.transportError, 'Too many sign-in attempts. Wait a few minutes and try again.');
  // A failed Sign in keeps the loaded `needed` view. That view used to win
  // and redraw the same button with no error.
  if (opts.transport === 'failed' && (!view || view.phase === 'needed')) {
    return retry(opts.transportError, 'Claude sign-in failed. Try again.');
  }
  if (!view) return null;
  if (view.phase === 'unavailable') {
    return { mode: 'quiet', title: 'Claude Enterprise', body: 'Claude on this box did not report a sign-in status.' };
  }
  if (view.phase === 'owner') {
    return { mode: 'owner', title: 'Claude Enterprise', body: view.error || 'The owner of this box needs to sign in to Claude Enterprise.' };
  }
  if (view.phase === 'offline') {
    return { mode: 'offline', title: 'Sign in to Claude Enterprise', body: view.error || 'Waiting for this box to come online. Sign-in will be here once it is.' };
  }
  if (view.phase === 'needed') return needed();
  if (view.phase === 'starting') {
    return { mode: 'starting', title: 'Sign in to Claude Enterprise', body: 'Asking the box for a sign-in link…' };
  }
  if (view.phase === 'submitting') {
    return { mode: 'submitting', title: 'Sign in to Claude Enterprise', body: 'Checking that code…' };
  }
  if (view.phase === 'needs-code') {
    const extra = opts.transport === 'failed' ? opts.transportError : undefined;
    return {
      mode: 'needs-code',
      title: 'Sign in to Claude Enterprise',
      body: 'Open the page, sign in, and paste the code it shows. The code is a long string, a #, and more characters.',
      error: extra || view.error,
      url: claudeAuthorizeUrl(view.url) ?? undefined,
    };
  }
  return retry(view.error, view.phase === 'expired' ? 'That sign-in expired. Start again.' : 'Claude sign-in stopped. Start again.');
}
