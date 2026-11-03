import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { REPLAY_BLOCK_CLASS } from '../observability';
import { ClaudeLoginPanel } from './ClaudeLoginCard';
import { claudeAuthorizeUrl, claudeSignInApplies, isClaudeAuthError, loginCard, loginCodeError, loginTransport, safeLoginMessage, takeLoginView, type ClaudeLoginView, type LoginTransport } from './claudeLogin';
import type { InstanceStatus } from '../types';

const URL = 'https://claude.com/cai/oauth/authorize?code=true&code_challenge=abc&login_method=sso&state=xyz';
const CODE = 'good-code#good-state';

function view(partial: Partial<ClaudeLoginView> & Pick<ClaudeLoginView, 'phase'>): ClaudeLoginView {
  return { loggedIn: false, authMethod: 'none', ...partial };
}

describe('loginCard', () => {
  const owner = { owner: true, engaged: false, transport: null as LoginTransport };

  it('draws nothing when the box is already signed in', () => {
    expect(loginCard(view({ phase: 'ready', loggedIn: true, authMethod: 'third_party' }), owner)).toBeNull();
  });

  it('asks the owner to sign in, then shows progress, a link, and a retry', () => {
    expect(loginCard(view({ phase: 'needed' }), owner)?.primary).toBe('start');
    expect(loginCard(view({ phase: 'starting' }), owner)?.body).toMatch(/sign-in link/);
    const code = loginCard(view({ phase: 'needs-code', url: URL, error: 'That code was not accepted. Copy the whole code from the browser and try again.' }), owner);
    expect(code?.mode).toBe('needs-code');
    expect(code?.url).toBe(URL);
    expect(code?.error).toMatch(/not accepted/);
    expect(loginCard(view({ phase: 'needs-code', url: 'https://evil.example/go' }), owner)?.url).toBeUndefined();
    expect(loginCard(view({ phase: 'expired' }), owner)?.primary).toBe('retry');
    expect(loginCard(view({ phase: 'ready' }), { ...owner, engaged: true })?.mode).toBe('signed-in');
  });

  it('tells a collaborator to ask the owner and never offers a link', () => {
    const card = loginCard(view({ phase: 'needs-code', url: URL }), { owner: false, engaged: false, transport: null });
    expect(card?.mode).toBe('owner');
    expect(card?.url).toBeUndefined();
    expect(card?.primary).toBeUndefined();
    expect(loginCard(view({ phase: 'ready', loggedIn: true }), { owner: false, engaged: false, transport: null })).toBeNull();
  });

  it('maps transport failures onto waiting, a quiet note, or retry', () => {
    expect(loginCard(null, { ...owner, transport: 'offline' })?.mode).toBe('offline');
    expect(loginCard(null, { ...owner, transport: 'missing' })?.mode).toBe('quiet');
    expect(loginCard(null, { ...owner, transport: 'no-box' })).toBeNull();
    expect(loginCard(view({ phase: 'needed' }), { ...owner, transport: 'no-box' })).toBeNull();
    expect(loginCard(null, { ...owner, transport: 'rate', transportError: 'Too many sign-in attempts. Wait a few minutes and try again.' })?.error).toMatch(/Too many/);
    expect(loginCard(null, owner)).toBeNull();
    const parked = loginCard(view({ phase: 'needed' }), { ...owner, transport: 'failed', transportError: 'This box is stopped. Start it from the Boxes list first.' });
    expect(parked?.mode).toBe('retry');
    expect(parked?.error).toMatch(/stopped/);
    expect(parked?.primary).toBe('retry');
  });
});

describe('which cases get the sign-in title', () => {
  const SIGN_IN = 'Sign in to Claude Enterprise';
  type Case = [string, ClaudeLoginView | null, { owner?: boolean; engaged?: boolean; transport?: LoginTransport; transportError?: string; box?: InstanceStatus | null; hostShowsBox?: boolean; authLost?: boolean }, string | null, RegExp?];
  // [case, view, opts, title (null: no card), body or error]
  const cases: Case[] = [
    ['agent offline, box starting', view({ phase: 'offline' }), { box: 'starting' }, 'Box is starting', /come online/],
    ['agent offline, box provisioning', view({ phase: 'offline' }), { box: 'provisioning' }, 'Box is starting', /come online/],
    ['agent offline, box stopped', view({ phase: 'offline' }), { box: 'stopped' }, 'Box is stopped', /Start it/],
    ['agent offline, box hibernated', view({ phase: 'offline' }), { box: 'hibernated' }, 'Box is hibernated', /Start it/],
    ['agent offline, box gone', view({ phase: 'offline' }), { box: 'terminated' }, 'Box is gone', /terminated/],
    ['agent offline, box running', view({ phase: 'offline' }), { box: 'ready' }, "Couldn't reach the agent", /not connected/],
    ['agent offline, box unknown', view({ phase: 'offline' }), {}, 'Box is offline', /come online/],
    ['503 on the status read', null, { transport: 'offline', box: 'starting' }, 'Box is starting', /come online/],
    ['503 after the box said needed', view({ phase: 'needed' }), { transport: 'offline', box: 'stopped' }, 'Box is stopped', /Start it/],
    ['no answer from termag', null, { transport: loginTransport(new Error('Network Error'), 'status') }, "Couldn't reach termag", /connection/],
    ['status read 502', null, { transport: loginTransport({ response: { status: 502, data: { code: 'status-failed' } } }, 'status'), transportError: "The box's agent could not read Claude's sign-in status." }, "Couldn't reach the agent", /could not read/],
    ['status read 504', null, { transport: loginTransport({ response: { status: 504, data: { code: 'timeout' } } }, 'status') }, "Couldn't reach the agent", /did not answer/],
    ['status read 401 from termag', null, { transport: loginTransport({ response: { status: 401, data: {} } }, 'status'), transportError: 'Not signed in to termag' }, "Couldn't reach the agent", /Not signed in to termag/],
    ['collaborator, agent offline', view({ phase: 'offline' }), { owner: false, box: 'starting' }, 'Box is starting', /come online/],
    ['collaborator, status read failed', null, { owner: false, transport: 'check-failed' }, "Couldn't reach the agent", /did not answer/],
    ['collaborator, owner not signed in', view({ phase: 'owner' }), { owner: false }, 'Claude Enterprise', /owner of this box/],
    ['termag on the box too old', null, { transport: 'missing' }, 'Claude Enterprise', /needs an update/],
    ['no box', null, { transport: 'no-box' }, null],
    ['claude reported no status', view({ phase: 'unavailable' }), {}, 'Claude Enterprise', /did not report/],
    ['signed in', view({ phase: 'ready', loggedIn: true }), {}, null],
    ['signed in, after a sign-in here', view({ phase: 'ready', loggedIn: true }), { engaged: true }, 'Claude Enterprise', /Signed in/],
    ['not signed in', view({ phase: 'needed' }), {}, SIGN_IN, /company account/],
    ['sign-in expired', view({ phase: 'expired' }), {}, SIGN_IN, /expired/],
    ['sign-in failed', view({ phase: 'failed' }), {}, SIGN_IN, /stopped/],
    ['waiting for the paste', view({ phase: 'needs-code', url: URL }), {}, SIGN_IN, /paste the code/],
    ['waiting for the paste, poll blip', view({ phase: 'needs-code', url: URL }), { transport: 'check-failed' }, SIGN_IN, /paste the code/],
    ['Sign in pressed, box parked', view({ phase: 'needed' }), { transport: 'failed', transportError: 'This box is stopped. Start it from the Boxes list first.' }, SIGN_IN, /stopped/],
    ['Sign in pressed, rate limited', view({ phase: 'needed' }), { transport: 'rate' }, SIGN_IN, /Too many/],
    // The chat's status line already says the box is down: the card leaves it there.
    ['agent offline, chat already says so', view({ phase: 'offline' }), { box: 'stopped', hostShowsBox: true }, ''],
    ['503, chat already says so', null, { transport: 'offline', hostShowsBox: true }, ''],
    ['no answer, chat already says so', null, { transport: 'unreachable', hostShowsBox: true }, ''],
    ['collaborator, agent offline, chat already says so', view({ phase: 'offline' }), { owner: false, hostShowsBox: true }, ''],
    ['status read failed, chat shows the box', null, { transport: 'check-failed', hostShowsBox: true }, "Couldn't reach the agent", /did not answer/],
    // A turn failed on Claude's sign-in.
    ['turn failed on auth, Claude still reads signed in', view({ phase: 'ready', loggedIn: true, authMethod: 'claude.ai' }), { authLost: true }, SIGN_IN, /expired or was revoked/],
    ['turn failed on auth, box now reads not signed in', view({ phase: 'needed' }), { authLost: true }, SIGN_IN, /expired or was revoked/],
    ['turn failed on auth, gateway box', view({ phase: 'ready', loggedIn: true, authMethod: 'third_party' }), { authLost: true }, "Claude couldn't authenticate", /gateway/],
    ['turn failed on auth, box offline', view({ phase: 'offline' }), { authLost: true, box: 'starting' }, 'Box is starting', /come online/],
    ['collaborator, turn failed on auth', view({ phase: 'ready', loggedIn: true }), { owner: false, authLost: true }, 'Claude Enterprise', /signed in again/],
    // Auth is lost and the follow-up status read failed: the last view still says ready.
    ['auth lost, status read 502', view({ phase: 'ready', loggedIn: true, authMethod: 'claude.ai' }), { authLost: true, engaged: true, transport: 'check-failed', transportError: "The box's agent could not read Claude's sign-in status." }, "Couldn't reach the agent", /could not read/],
    ['auth lost, no answer from termag', view({ phase: 'ready', loggedIn: true, authMethod: 'claude.ai' }), { authLost: true, engaged: true, transport: 'unreachable' }, "Couldn't reach termag", /connection/],
    ['auth lost, agent offline', view({ phase: 'ready', loggedIn: true, authMethod: 'claude.ai' }), { authLost: true, engaged: true, transport: 'offline', box: 'starting' }, 'Box is starting', /come online/],
    ['auth lost, Sign in rate limited', view({ phase: 'ready', loggedIn: true, authMethod: 'claude.ai' }), { authLost: true, engaged: true, transport: 'rate', transportError: 'Too many sign-in attempts. Wait a few minutes and try again.' }, SIGN_IN, /Too many/],
    ['auth lost, Sign in failed', view({ phase: 'ready', loggedIn: true, authMethod: 'claude.ai' }), { authLost: true, engaged: true, transport: 'failed', transportError: 'Claude sign-in failed. Try again.' }, SIGN_IN, /failed/],
    ['auth lost, not engaged, status read 504', view({ phase: 'ready', loggedIn: true, authMethod: 'claude.ai' }), { authLost: true, transport: 'check-failed' }, "Couldn't reach the agent", /did not answer/],
  ];

  it.each(cases)('%s', (_name, v, opts, title, text) => {
    const card = loginCard(v, { owner: true, engaged: false, transport: null, ...opts });
    if (title == null) { expect(card).toBeNull(); return; }
    if (title === '') { expect(card?.mode).toBe('hidden'); return; }
    if (opts.authLost) expect(card?.mode).not.toBe('signed-in');
    expect(card?.title).toBe(title);
    if (text) expect(`${card?.body} ${card?.error ?? ''}`).toMatch(text);
    if (title !== SIGN_IN) expect(card?.primary).toBeUndefined();
    else if (card?.mode === 'needed') expect(card.primary).toBe('start');
  });

  it("knows Claude's sign-in errors from other turn failures", () => {
    expect(isClaudeAuthError('Invalid API key · Please run /login')).toBe(true);
    expect(isClaudeAuthError('Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}')).toBe(true);
    expect(isClaudeAuthError('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe(false);
    expect(isClaudeAuthError('Interrupted')).toBe(false);
    expect(isClaudeAuthError(undefined)).toBe(false);
  });

  it('only offers Claude sign-in to providers that run Claude', () => {
    expect(claudeSignInApplies('claude')).toBe(true);
    expect(claudeSignInApplies('claude-chat')).toBe(true);
    for (const p of ['pi-chat', 'pi', 'codex', 'devin', 'mistral', null, undefined]) {
      expect(claudeSignInApplies(p)).toBe(false);
    }
  });
});

describe('paste handling', () => {
  it('refuses a token without repeating it, and only opens the SSO link', () => {
    const token = 'sk-ant-oat01-abcdefghijklmnop#statevalue';
    const reason = loginCodeError(token);
    expect(reason).toMatch(/not a token/);
    expect(reason).not.toContain('sk-ant');
    expect(loginCodeError(CODE)).toBeNull();
    expect(claudeAuthorizeUrl(URL)).toBe(URL);
    expect(claudeAuthorizeUrl(URL.replace('login_method=sso', 'login_method=cli'))).toBeNull();
    expect(safeLoginMessage(`nope ${CODE}`)).toBe('Claude sign-in could not continue. Start again.');
    expect(loginTransport({ response: { status: 409, data: { code: 'login-missing' } } })).toBe('missing');
    expect(loginTransport({ response: { status: 503, data: { code: 'offline' } } })).toBe('offline');
  });
});

describe('takeLoginView', () => {
  const ready = view({ phase: 'ready', loggedIn: true, authMethod: 'claude.ai' });
  const needed = view({ phase: 'needed' });

  it('keeps a finished sign-in when an older status poll resolves', () => {
    expect(takeLoginView(ready, needed, 1, 2)).toBe(ready);
    expect(takeLoginView(null, needed, 1, 2)).toBeNull();
  });

  it('applies a status poll that started after the sign-in result', () => {
    expect(takeLoginView(ready, needed, 2, 2)).toBe(needed);
  });

  it('keeps the paste field when a status poll is unavailable, and applies it when nothing is signing in', () => {
    const gone = view({ phase: 'unavailable' });
    const open = view({ phase: 'needs-code', url: URL });
    expect(takeLoginView(open, gone, 2, 2)).toBe(open);
    expect(takeLoginView(view({ phase: 'starting' }), gone, 2, 2)?.phase).toBe('starting');
    expect(takeLoginView(view({ phase: 'submitting', url: URL }), gone, 2, 2)?.phase).toBe('submitting');
    expect(takeLoginView(null, gone, 2, 2)).toBe(gone);
    expect(takeLoginView(needed, gone, 2, 2)?.phase).toBe('unavailable');
    expect(loginCard(gone, { owner: true, engaged: false, transport: null })?.mode).toBe('quiet');
    expect(loginCard(open, { owner: true, engaged: true, transport: null })?.mode).toBe('needs-code');
  });
});

describe('ClaudeLoginPanel', () => {
  it('masks the code field and does not put a rejected link on the page', () => {
    const card = loginCard(view({ phase: 'needs-code', url: URL }), { owner: true, engaged: true, transport: null })!;
    const html = renderToStaticMarkup(
      <ClaudeLoginPanel card={card} busy={false} draft="" localError={undefined} onDraft={() => {}} onStart={() => {}} onSubmit={() => {}} />,
    );
    expect(html).toContain(REPLAY_BLOCK_CLASS);
    expect(html).toContain('chat-claude-login-code');
    expect(html).toContain('type="text"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('name="claude-sign-in-code"');
    expect(html).not.toContain('type="password"');
    expect(html).toContain('aria-label="Claude sign-in code"');
    expect(html).toContain('https://claude.com/cai/oauth/authorize?');
    expect(html).toContain('login_method=sso');
    expect(html).toContain('rel="noopener noreferrer"');
    const blocked = loginCard(view({ phase: 'needs-code', url: 'javascript:alert(1)' }), { owner: true, engaged: true, transport: null })!;
    const safe = renderToStaticMarkup(
      <ClaudeLoginPanel card={blocked} busy={false} draft="" localError="Paste the full code from the Claude page, including the #." onDraft={() => {}} onStart={() => {}} onSubmit={() => {}} />,
    );
    expect(safe).not.toContain('href=');
    expect(safe).toContain('including the #');
    const masked = renderToStaticMarkup(
      <ClaudeLoginPanel card={card} busy={false} draft="abcd" localError={undefined} onDraft={() => {}} onStart={() => {}} onSubmit={() => {}} />,
    );
    expect(masked).toContain('chat-claude-login-discs');
    expect(masked).toContain('aria-hidden="true"');
    expect(masked).toContain('••••');
  });
});
