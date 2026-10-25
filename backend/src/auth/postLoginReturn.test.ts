import { describe, it, expect } from 'vitest';
import type { Session, SessionData } from 'express-session';
import { cliReturnPath, fileLinkReturnPath, previewLinkReturnPath, stashPostLoginReturn, takePostLoginRedirect } from './postLoginReturn';
import { spaceFileLinkPath } from '../services/spaces/spaceLinks';

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

describe('fileLinkReturnPath', () => {
  it('accepts a space file link under this base path, exactly as sent', () => {
    expect(fileLinkReturnPath('/termag', '/termag/files/assets/docs/My%20Report.pdf')).toBe('/termag/files/assets/docs/My%20Report.pdf');
    expect(fileLinkReturnPath('', '/files/assets/a.png')).toBe('/files/assets/a.png');
  });

  it('keeps percent-encoded filenames and nested folders unchanged', () => {
    for (const url of [
      '/termag/files/assets/My%20Q3%20Report.pdf',
      '/termag/files/assets/notes%23draft%3F.txt',
      '/termag/files/assets/a%2Fb.png',
      '/termag/files/assets/done%E2%9C%93.png',
      '/termag/files/assets/2026/q3/charts/final%20v2.png',
      '/termag/files/assets/deep/er/%E2%9C%93%20%23%3F%2F.png',
      spaceFileLinkPath('/termag', 'assets', 'a+b,c:d=e@f[g].png'),
      spaceFileLinkPath('/termag', 'assets', 'reports/2026 Q3/résumé ✓ #1?.pdf'),
    ]) {
      expect(fileLinkReturnPath('/termag', url)).toBe(url);
    }
    expect(fileLinkReturnPath('/termag', '//evil.com/termag/files/assets/My%20Q3%20Report.pdf')).toBeNull();
    expect(fileLinkReturnPath('/termag', 'https://evil.com/termag/files/assets/a%2Fb.png')).toBeNull();
  });

  it('refuses anything that could leave the link or be rewritten on the way', () => {
    for (const url of [
      'https://evil.example/termag/files/assets/a.png',
      '//evil.example/termag/files/assets/a.png',
      '/termag/files/../auth/logout',
      '/termag/files/assets/../../evil',
      '/termag/files/assets/a b.png',
      '/termag/files/assets\\a.png',
      '/termag/filesx/assets/a.png',
      '/termag/files',
      '/other/files/assets/a.png',
      `/termag/files/${'a'.repeat(3000)}`,
      undefined,
    ]) {
      expect(fileLinkReturnPath('/termag', url)).toBeNull();
    }
  });
});

describe('previewLinkReturnPath', () => {
  it('accepts a preview share link under this base path, exactly as sent', () => {
    expect(previewLinkReturnPath('/termag', '/termag/p/cshare0000000001')).toBe('/termag/p/cshare0000000001');
    expect(previewLinkReturnPath('/termag', '/termag/p/cshare0000000001?at=%2Fdefault%2Fflags')).toBe('/termag/p/cshare0000000001?at=%2Fdefault%2Fflags');
  });

  it('refuses anything else under /p, or that could leave it', () => {
    for (const url of ['/termag/p/', '/termag/p/a/b', '/termag/p/../files/x', '/termag/p/%2e%2e', '/termag/p/a b', '//evil.example/termag/p/x',
      'https://evil.example/termag/p/x', '/termag/p/A-B', '/other/p/abc', '/termag/p/abc\\x', '/termag/preview/abc']) {
      expect(previewLinkReturnPath('/termag', url), url).toBeNull();
    }
  });

  it('is stashed and taken like the others', () => {
    const s = session();
    expect(stashPostLoginReturn(s, '/termag', '/termag/p/cshare0000000001?at=%2Fflags')).toBe(true);
    expect(takePostLoginRedirect(s, '/termag', 'https://ui.example')).toBe('https://ui.example/termag/p/cshare0000000001?at=%2Fflags');
  });
});

describe('stash and take', () => {
  it('returns to a stashed file link', () => {
    const s = session();
    expect(stashPostLoginReturn(s, '/termag', '/termag/files/assets/a.png')).toBe(true);
    expect(takePostLoginRedirect(s, '/termag', 'https://ui.example')).toBe('https://ui.example/termag/files/assets/a.png');
  });

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
