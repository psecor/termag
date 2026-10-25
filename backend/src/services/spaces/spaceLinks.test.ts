import { describe, expect, it } from 'vitest';
import { HTML_LINK_HEADERS, fileLinkResponseHeaders, isHtmlLink, parseSpaceFileLink, spaceFileLinkPath } from './spaceLinks';

describe('spaceFileLinkPath', () => {
  it('builds /files/<space>/<path> under the base path, each segment encoded', () => {
    expect(spaceFileLinkPath('/termag', 'assets', 'logo.png')).toBe('/termag/files/assets/logo.png');
    expect(spaceFileLinkPath('/termag', 'assets', 'docs/My Report (v2) #1?.pdf'))
      .toBe('/termag/files/assets/docs/My%20Report%20(v2)%20%231%3F.pdf');
    expect(spaceFileLinkPath('', 'assets', 'r\u00e9sum\u00e9.txt')).toBe('/files/assets/r%C3%A9sum%C3%A9.txt');
  });

  it('round-trips through parseSpaceFileLink', () => {
    for (const path of ['a.png', 'deep/er/x y.txt', '100%/50% off.pdf', 'q?/h#/e=.txt', 'r\u00e9sum\u00e9.txt']) {
      const full = spaceFileLinkPath('/termag', 'my-space', path);
      expect(parseSpaceFileLink(full.slice('/termag/files'.length))).toEqual({ space: 'my-space', path });
    }
  });
});

describe('parseSpaceFileLink', () => {
  it('refuses anything that is not /<space>/<path>', () => {
    for (const raw of ['', '/', '/assets', '/assets/', 'assets/x', '/Assets/x', '/a/x', '/as%2Fsets/x', '/assets/%E0%A4%A']) {
      expect(parseSpaceFileLink(raw)).toBeNull();
    }
  });

  it('decodes segments and leaves validation of the path to normalizeFilePath', () => {
    expect(parseSpaceFileLink('/assets/%2e%2e/x')).toEqual({ space: 'assets', path: '../x' });
    expect(parseSpaceFileLink('/assets/a%2Fb')).toEqual({ space: 'assets', path: 'a/b' });
  });
});

describe('fileLinkResponseHeaders', () => {
  it('serves images, PDFs and plain text inline with a type chosen here', () => {
    expect(fileLinkResponseHeaders('img/cat.PNG')).toEqual({
      contentDisposition: 'inline; filename="cat.PNG"; filename*=UTF-8\'\'cat.PNG',
      contentType: 'image/png',
    });
    expect(fileLinkResponseHeaders('a.pdf').contentType).toBe('application/pdf');
    expect(fileLinkResponseHeaders('notes.txt').contentType).toBe('text/plain; charset=utf-8');
  });

  it.each([
    ['demo.webm', 'video/webm'], ['a.mp4', 'video/mp4'], ['a.m4v', 'video/mp4'], ['a.mov', 'video/quicktime'],
    ['a.ogv', 'video/ogg'], ['a.mp3', 'audio/mpeg'], ['a.wav', 'audio/wav'], ['a.m4a', 'audio/mp4'],
    ['a.ogg', 'audio/ogg'], ['a.oga', 'audio/ogg'], ['a.flac', 'audio/flac'],
  ])('serves %s inline as %s', (path, type) => {
    expect(fileLinkResponseHeaders(`dir/${path}`)).toEqual({
      contentDisposition: `inline; filename="${path}"; filename*=UTF-8''${path}`,
      contentType: type,
    });
  });

  it.each(['md', 'markdown', 'json', 'csv', 'tsv', 'log', 'diff', 'patch', 'yaml', 'yml', 'toml'])(
    'serves .%s inline as plain text, never its own type', ext => {
      const h = fileLinkResponseHeaders(`notes/file.${ext}`);
      expect(h.contentDisposition).toMatch(/^inline;/);
      expect(h.contentType).toBe('text/plain; charset=utf-8');
    });

  it('matches extensions case-insensitively', () => {
    expect(fileLinkResponseHeaders('Demo.WEBM').contentType).toBe('video/webm');
    expect(fileLinkResponseHeaders('README.Md').contentType).toBe('text/plain; charset=utf-8');
    expect(fileLinkResponseHeaders('x.HTML').contentDisposition).toMatch(/^attachment;/);
  });

  it('makes HTML, SVG and everything else an octet-stream attachment', () => {
    for (const path of [
      'x.html', 'x.htm', 'x.svg', 'x.xhtml', 'x.xml', 'x.js', 'x.mjs', 'X.SVG', 'x.md.html', 'archive.zip', 'noext', '.md',
    ]) {
      const h = fileLinkResponseHeaders(path);
      expect(h.contentDisposition).toMatch(/^attachment;/);
      expect(h.contentType).toBe('application/octet-stream');
    }
  });
});

describe('HTML pages', () => {
  it('recognises .html and .htm, in any case, and nothing else', () => {
    for (const path of ['a.html', 'dir/A.HTM', 'x.Html']) expect(isHtmlLink(path)).toBe(true);
    for (const path of ['a.xhtml', 'a.svg', 'html', 'a.html.txt', '.html']) expect(isHtmlLink(path)).toBe(false);
  });

  it('sandboxes the page with no script, no network and no framing', () => {
    const csp = HTML_LINK_HEADERS['Content-Security-Policy'].split(/;\s*/);
    expect(csp[0]).toBe('sandbox');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp.join(' ')).not.toMatch(/allow-|script-src|https?:|'self'/);
    expect(HTML_LINK_HEADERS['X-Content-Type-Options']).toBe('nosniff');
  });
});
