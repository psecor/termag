// What the simple UI may show for Claude Enterprise sign-in. The one-time
// code is typed into a blocked input and sent once; nothing here keeps it.
// Only a box that says it is not signed in, or a sign-in in progress, gets
// the sign-in title. A box that is down or a status read that failed says
// that instead: it is no evidence that sign-in is missing.
import { PROVIDERS } from '../providers/registry';
import type { InstanceStatus } from '../types';

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

/**
 * Why the last request failed. `unreachable` is no answer at all (this
 * browser to termag); `check-failed` is a status read that failed, which is
 * not a failed sign-in; `failed` is a start, paste or cancel that did.
 */
export type LoginTransport = 'offline' | 'unreachable' | 'missing' | 'no-box' | 'rate' | 'failed' | 'check-failed' | null;

/** Whether a provider runs Claude, so its box can need a Claude sign-in. */
export function claudeSignInApplies(provider: string | null | undefined): boolean {
  if (!provider) return false;
  return provider === 'claude' || PROVIDERS[provider]?.chatEngine === 'claude';
}

export interface LoginCardModel {
  mode: 'hidden' | 'signed-in' | 'needed' | 'starting' | 'needs-code' | 'submitting' | 'retry' | 'offline' | 'owner' | 'quiet';
  title: string;
  body: string;
  error?: string;
  url?: string;
  primary?: 'start' | 'retry';
}

// What Claude Code says when its sign-in is gone: "Invalid API key · Please
// run /login", "OAuth token has expired…", an API 401 authentication_error.
const AUTH_ERROR_RE = /please run \/login|oauth token (?:has )?expired|invalid api key|authentication_error|not logged in|failed to authenticate/i;

/** Whether a turn's error text is Claude's sign-in failing (not a model or network error). */
export function isClaudeAuthError(text: unknown): boolean {
  return typeof text === 'string' && AUTH_ERROR_RE.test(text);
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

export function loginTransport(err: unknown, op: 'status' | 'action' = 'action'): LoginTransport {
  const data = (err as { response?: { status?: number; data?: { code?: string } } })?.response;
  if (!data) return 'unreachable';
  const code = data.data?.code;
  if (code === 'offline' || data.status === 503) return 'offline';
  if (code === 'login-missing') return 'missing';
  if (code === 'no-box') return 'no-box';
  if (code === 'rate-limited' || data.status === 429) return 'rate';
  return op === 'status' ? 'check-failed' : 'failed';
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

const LOST = "Claude's sign-in on this box expired or was revoked, so the last turn failed. Sign in again to continue.";

/** A turn failed on the box's sign-in, and Claude may still read as signed in. */
function lost(view: ClaudeLoginView): LoginCardModel {
  if (view.authMethod === 'third_party') {
    return {
      mode: 'quiet',
      title: "Claude couldn't authenticate",
      body: 'This box signs in through the termag gateway, and the gateway refused the last turn. Signing in here will not fix that.',
    };
  }
  return { ...needed(), body: LOST };
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

/** The box or its agent is not answering. The box feed says which. */
function boxDown(box: InstanceStatus | null | undefined): LoginCardModel {
  switch (box) {
    case 'provisioning': case 'awaiting-agent': case 'warming': case 'warm': case 'starting':
      return { mode: 'offline', title: 'Box is starting', body: 'Waiting for this box to come online.' };
    case 'stopping': case 'stopped':
      return { mode: 'offline', title: 'Box is stopped', body: 'Start it from the Boxes list to use it.' };
    case 'hibernating': case 'hibernated':
      return { mode: 'offline', title: 'Box is hibernated', body: 'Start it from the Boxes list to use it.' };
    case 'failed': case 'terminated':
      return { mode: 'offline', title: 'Box is gone', body: 'This box failed or was terminated.' };
    case 'ready':
      return { mode: 'offline', title: "Couldn't reach the agent", body: "This box is running, but its termag agent is not connected. Waiting for it to reconnect." };
    default:
      return { mode: 'offline', title: 'Box is offline', body: 'Waiting for this box to come online.' };
  }
}

const HIDDEN: LoginCardModel = { mode: 'hidden', title: '', body: '' };

/**
 * A failure that says nothing about sign-in: termag, the box or its agent.
 * Hidden when the chat already says the box or its agent is down (its
 * status line, beside the box's own actions): the card does not repeat it.
 */
function notSignIn(transport: LoginTransport, box: InstanceStatus | null | undefined, error?: string, hostShowsBox?: boolean): LoginCardModel | null {
  if (hostShowsBox && (transport === 'offline' || transport === 'unreachable')) return HIDDEN;
  if (transport === 'offline') return boxDown(box);
  if (transport === 'unreachable') {
    return { mode: 'offline', title: "Couldn't reach termag", body: 'Check your connection. This will try again.' };
  }
  if (transport === 'check-failed') {
    return { mode: 'offline', title: "Couldn't reach the agent", body: error || "The box's agent did not answer. This will try again." };
  }
  return null;
}

/**
 * The card for one status. A box that is already signed in (the gateway, or
 * a finished login) draws nothing until this tab has been through a sign-in.
 * A collaborator never gets a link or a button.
 */
export function loginCard(
  view: ClaudeLoginView | null,
  opts: {
    owner: boolean;
    engaged: boolean;
    transport: LoginTransport;
    transportError?: string;
    box?: InstanceStatus | null;
    /** The chat's status line already says the box or its agent is down. */
    hostShowsBox?: boolean;
    /** A turn in this chat failed on Claude's sign-in (sdkChat authFailure). */
    authLost?: boolean;
  },
): LoginCardModel | null {
  const boxCard = () => (opts.hostShowsBox ? HIDDEN : boxDown(opts.box));
  if (!opts.owner) {
    if (opts.transport === 'missing' || opts.transport === 'no-box') return null;
    const down = notSignIn(opts.transport, opts.box, opts.transportError, opts.hostShowsBox);
    if (down) return down;
    if (view?.phase === 'offline') return boxCard();
    if (opts.authLost && view && (view.phase === 'ready' || view.phase === 'owner')) {
      return { mode: 'owner', title: 'Claude Enterprise', body: 'Claude on this box needs to be signed in again. The owner of this box needs to sign in to Claude Enterprise.' };
    }
    if (view?.phase === 'ready' || view?.phase === 'unavailable') return null;
    if (!view) return null;
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
  // A turn failed on the sign-in, so a `ready` view is the dead seat. A
  // failed read or Sign in since then says so; it never falls to "Signed in".
  if (view?.phase === 'ready' && opts.authLost) {
    if (!opts.transport) return lost(view);
    return notSignIn(opts.transport, opts.box, opts.transportError, opts.hostShowsBox)
      ?? (opts.transport === 'rate'
        ? retry(opts.transportError, 'Too many sign-in attempts. Wait a few minutes and try again.')
        : retry(opts.transportError, 'Claude sign-in failed. Try again.'));
  }
  if (view?.phase === 'ready') {
    if (!opts.engaged) return null;
    return { mode: 'signed-in', title: 'Claude Enterprise', body: 'Signed in to Claude. You can send a message.' };
  }
  // An open sign-in keeps its card (and its paste field) through a blip.
  if (!view || !OPEN_LOGIN.has(view.phase)) {
    const down = notSignIn(opts.transport, opts.box, opts.transportError, opts.hostShowsBox);
    if (down) return down;
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
  if (view.phase === 'offline') return boxCard();
  if (view.phase === 'needed') return opts.authLost ? { ...needed(), body: LOST } : needed();
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
