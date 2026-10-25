import { describe, expect, it } from 'vitest';
import {
  allowLoginAttempt, authorizeUrl, createAttemptGate, loginCodeError, loginEmail, loginRpcFailure, loginTargetError, sanitizeLoginView,
} from './claudeLogin';

const URL = 'https://claude.com/cai/oauth/authorize?code=true&code_challenge=abc&login_method=sso&state=xyz';
const CODE = 'good-code#good-state';

describe('loginCodeError', () => {
  it('accepts one code#state and refuses a token without repeating it', () => {
    expect(loginCodeError(`  ${CODE}  `)).toBeNull();
    const token = 'sk-ant-oat01-abcdefghijklmnop#statevalue';
    const reason = loginCodeError(token);
    expect(reason).toMatch(/not a token/);
    expect(reason).not.toContain(token);
    expect(reason).not.toContain('sk-ant');
    expect(loginCodeError('no-hash-here')).toMatch(/including the #/);
    expect(loginCodeError(null)).toMatch(/Paste the full code/);
  });
});

describe('authorizeUrl', () => {
  it('keeps only the claude.com SSO authorize URL', () => {
    expect(authorizeUrl(URL)).toBe(URL);
    expect(authorizeUrl(URL.replace('login_method=sso', 'login_method=cli'))).toBeNull();
    expect(authorizeUrl(URL.replace('https://', 'http://'))).toBeNull();
    expect(authorizeUrl('https://evil.example/cai/oauth/authorize?code_challenge=x&login_method=sso')).toBeNull();
    expect(authorizeUrl(URL.replace('code_challenge=abc', 'code_challenge='))).toBeNull();
  });
});

describe('sanitizeLoginView', () => {
  it('hides the link and the phase from a collaborator', () => {
    const view = sanitizeLoginView({ phase: 'needs-code', loggedIn: false, authMethod: 'none', url: URL, error: 'try again' }, false);
    expect(view.phase).toBe('owner');
    expect(view.url).toBeUndefined();
    expect(view.error).toMatch(/owner of this box/);
  });

  it('a logged-in box is ready and carries no link, even if the agent sent one', () => {
    const view = sanitizeLoginView({ phase: 'needs-code', loggedIn: true, authMethod: 'third_party', url: URL }, true);
    expect(view).toEqual({ phase: 'ready', loggedIn: true, authMethod: 'third_party' });
  });

  it('drops an error that could be a paste or a token', () => {
    const pasted = sanitizeLoginView({ phase: 'failed', loggedIn: false, error: `Login failed: ${CODE}` }, true);
    expect(pasted.error).toBe('Claude sign-in could not continue. Start again.');
    expect(JSON.stringify(pasted)).not.toContain(CODE);
    const token = sanitizeLoginView({ phase: 'failed', loggedIn: false, error: 'saw sk-ant-oat01-abcdefghijklmnop' }, true);
    expect(token.error).not.toContain('sk-ant');
  });

  it('gives the owner the link only while a code is expected', () => {
    expect(sanitizeLoginView({ phase: 'needs-code', loggedIn: false, url: URL }, true).url).toBe(URL);
    expect(sanitizeLoginView({ phase: 'failed', loggedIn: false, url: URL }, true).url).toBeUndefined();
  });
});

describe('loginTargetError and loginRpcFailure', () => {
  it('names offline, no box, and an agent that predates sign-in', () => {
    expect(loginTargetError({ instanceId: null, connected: false, capabilities: [] })?.body.code).toBe('no-box');
    expect(loginTargetError({ instanceId: 'i', connected: false, capabilities: ['claude-login-v1'] })?.status).toBe(503);
    expect(loginTargetError({ instanceId: 'i', connected: true, capabilities: [] })?.body.code).toBe('login-missing');
    expect(loginTargetError({ instanceId: 'i', connected: true, capabilities: ['claude-login-v1'] })).toBeNull();
  });

  it('never forwards the agent error text', () => {
    const failure = loginRpcFailure(`boom ${CODE} sk-ant-oat01-abcdefghijklmnop`);
    expect(failure).toEqual({ status: 502, body: { error: 'Claude sign-in failed. Try again.', code: 'login-failed' } });
    expect(loginRpcFailure('Unknown command: claude-login-status').body.code).toBe('login-missing');
    expect(loginRpcFailure('Agent request timed out: claude-login-start').status).toBe(504);
  });
});

describe('loginEmail and allowLoginAttempt', () => {
  it('keeps a normal address and drops anything the CLI could treat as a flag', () => {
    expect(loginEmail(' person@example.invalid ')).toBe('person@example.invalid');
    expect(loginEmail('-not@example.invalid')).toBeUndefined();
    expect(loginEmail('not an email')).toBeUndefined();
  });

  it('allows a fixed number of attempts inside the window', () => {
    let now = 1_000;
    const gate = createAttemptGate(2, 100, () => now);
    expect(gate('u1')).toBe(true);
    expect(gate('u1')).toBe(true);
    expect(gate('u1')).toBe(false);
    expect(gate('u2')).toBe(true);
    now += 101;
    expect(gate('u1')).toBe(true);
    expect(allowLoginAttempt([10], 20, 1, 100).ok).toBe(false);
  });

  it('counts each project on its own and drops an empty window', () => {
    let now = 1_000;
    const gate = createAttemptGate(1, 100, () => now);
    expect(gate('u1\0p1')).toBe(true);
    expect(gate('u1\0p1')).toBe(false);
    expect(gate('u1\0p2')).toBe(true);
    const closed = createAttemptGate(0, 100, () => now);
    expect(closed('u1\0p1')).toBe(false);
    expect(allowLoginAttempt([10], 1_000, 1, 100)).toEqual({ ok: true, history: [1_000] });
    expect(allowLoginAttempt([], 1_000, 0, 100).history).toEqual([]);
  });
});
