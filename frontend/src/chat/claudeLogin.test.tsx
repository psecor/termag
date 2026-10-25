import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { REPLAY_BLOCK_CLASS } from '../observability';
import { ClaudeLoginPanel } from './ClaudeLoginCard';
import { claudeAuthorizeUrl, loginCard, loginCodeError, loginTransport, safeLoginMessage, takeLoginView, type ClaudeLoginView, type LoginTransport } from './claudeLogin';

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
