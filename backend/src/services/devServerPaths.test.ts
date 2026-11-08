// The shared refused dev-server paths (services/devServerPaths.ts): what no
// proxy in front of a box's dev server sends on (SR6, SR9).
import { describe, expect, it } from 'vitest';
import { pathRefusal } from './devServerPaths';

describe('pathRefusal (SR6, SR9)', () => {
  const checkout = '/home/owner/termag/projects/app';

  it('lets the app\'s own paths through, /termag/api/* included (SR3: it is the app\'s path)', () => {
    for (const p of ['/', '/termag/api/projects', '/src/main.ts', '/@vite/client', '/node_modules/.vite/deps/react.js', `/@fs${checkout}/src/x.ts`, '/a%20b']) {
      expect(pathRefusal(p, checkout), p).toBeNull();
    }
  });

  it('refuses launch-editor\'s routes, however spelled', () => {
    for (const p of ['/__open-in-editor?file=/etc/passwd', '/__open-stack-frame-in-editor', '/__OPEN-IN-EDITOR', '//__open-in-editor', '/%5F%5Fopen-in-editor', '/__nextjs_launch-editor']) {
      expect(pathRefusal(p.split('?')[0], checkout), p).toBe('editor');
    }
  });

  it('refuses /@fs/ outside the checkout, a sibling with the same prefix included', () => {
    expect(pathRefusal('/@fs/home/owner/.aws/credentials', checkout)).toBe('fs_outside');
    expect(pathRefusal(`/@fs${checkout}-other/x`, checkout)).toBe('fs_outside');
    expect(pathRefusal('/%40fs/etc/passwd', checkout)).toBe('fs_outside');
    expect(pathRefusal('//@fs/etc/passwd', checkout)).toBe('fs_outside');
    expect(pathRefusal('/@FS/etc/passwd', checkout)).toBe('fs_outside');
  });

  it('refuses any .., %2e, backslash or NUL, raw, decoded or double-encoded', () => {
    for (const p of [`/@fs${checkout}/../../.aws/credentials`, '/a/..', '/%2e%2e/x', '/%2E/x', '/a%5cb', '/a\\b', '/%252e%252e/x', '/a%00', '/%E0%A4%A']) {
      expect(pathRefusal(p, checkout), p).toBe('traversal');
    }
  });

  it('refuses a lone . segment, which a URL parser drops before the dev server routes (Bugbot)', () => {
    for (const p of ['/./__open-in-editor', '/./@fs/etc/passwd', '/.//@fs/etc/passwd', '/a/./b', '/a/.', '/.', '/%2F./@fs/etc/passwd']) {
      expect(pathRefusal(p, checkout), p).toBe('traversal');
    }
    expect(pathRefusal('/./devtools/browser/abc', checkout, true)).toBe('traversal');
    for (const p of ['/.well-known/x', '/a.b/c', '/a/.hidden', '/node_modules/.vite/x']) expect(pathRefusal(p, checkout), p).toBeNull();
  });

  it('refuses the DevTools socket paths on an upgrade only', () => {
    expect(pathRefusal('/devtools/browser/abc', checkout, true)).toBe('devtools');
    expect(pathRefusal('/0f8fad5b-d9cb-469f-a165-70867728950e', checkout, true)).toBe('devtools');
    expect(pathRefusal('/__vite_hmr', checkout, true)).toBeNull();
    expect(pathRefusal('/devtools/x', checkout, false)).toBeNull();
  });
});
