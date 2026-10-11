import { describe, it, expect } from 'vitest';
import type { Session, SessionData } from 'express-session';
import { cliReturnPath, stashPostLoginReturn, takePostLoginRedirect } from './postLoginReturn';

const AUTHORIZE = '/termag/auth/cli/authorize?port=53682&state=abcdefghijklmnop&device_name=mbp';

function session(): Session & Partial<SessionData> {
  return {} as Session & Partial<SessionData>;
}

describe('cliReturnPath', () => {
  it('accepts this server\'s CLI approval page', () => {
    expect(cliReturnPath('/termag', AUTHORIZE)).toBe(AUTHORIZE);
    expect(cliReturnPath('', '/auth/cli/authorize?port=1')).toBe('/auth/cli/authorize?port=1');
  });

  it('refuses anything that could leave the approval page', () => {
    for (const url of [
      'https://evil.example/termag/auth/cli/authorize?x=1',
      '//evil.example/termag/auth/cli/authorize?x=1',
      '/termag/auth/cli/authorize',
      '/termag/auth/cli/authorizex?x=1',
      '/termag/auth/cli/authorize/../../../evil?x=1',
      '/termag/auth/cli/authorize?\\evil',
      '/termag/auth/cli/authorize? x',
      '/other/auth/cli/authorize?x=1',
      `/termag/auth/cli/authorize?${'a'.repeat(3000)}`,
      undefined,
      42,
    ]) {
      expect(cliReturnPath('/termag', url)).toBeNull();
    }
  });
});

describe('stash and take', () => {
  it('returns to the stashed approval page once, then to the app root', () => {
    const s = session();
    expect(stashPostLoginReturn(s, '/termag', AUTHORIZE)).toBe(true);
    expect(takePostLoginRedirect(s, '/termag', 'https://ui.example')).toBe(`https://ui.example${AUTHORIZE}`);
    expect(takePostLoginRedirect(s, '/termag', 'https://ui.example')).toBe('https://ui.example/termag/');
  });

  it('does not stash a foreign URL and ignores a tampered stash', () => {
    const s = session();
    expect(stashPostLoginReturn(s, '/termag', 'https://evil.example/')).toBe(false);
    expect(s.postLoginReturnTo).toBeUndefined();
    s.postLoginReturnTo = '//evil.example/';
    expect(takePostLoginRedirect(s, '/termag', 'https://ui.example')).toBe('https://ui.example/termag/');
  });

  it('copes with no session at all', () => {
    expect(stashPostLoginReturn(undefined, '/termag', AUTHORIZE)).toBe(false);
    expect(takePostLoginRedirect(undefined, '/termag', 'https://ui.example')).toBe('https://ui.example/termag/');
  });
});
