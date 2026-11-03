import { describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_MAX_BYTES, HIGHLIGHT_MAX_LINES, extensionOf, highlightable, languageFor,
  splitHighlightedLines, textLines, wrapsByDefault,
} from './codeView';

describe('languageFor', () => {
  it('picks a grammar by extension, case-insensitively', () => {
    expect(languageFor('src/main.ts')).toBe('typescript');
    expect(languageFor('App.TSX')).toBe('typescript');
    expect(languageFor('deploy/setup.sh')).toBe('bash');
    expect(languageFor('config.yml')).toBe('yaml');
    expect(languageFor('Cargo.toml')).toBe('ini');
  });

  it('is null for prose, logs, Terraform and files with no extension', () => {
    for (const p of ['notes.txt', 'run.log', 'main.tf', 'Makefile', '.env', 'dir.v2/README']) {
      expect(languageFor(p)).toBeNull();
    }
  });

  it('reads the extension from the last path segment only', () => {
    expect(extensionOf('a.b/c')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('x/y.tar.gz')).toBe('gz');
  });
});

describe('highlightable', () => {
  it('stops at the byte cap', () => {
    expect(highlightable('x'.repeat(HIGHLIGHT_MAX_BYTES))).toBe(true);
    expect(highlightable('x'.repeat(HIGHLIGHT_MAX_BYTES + 1))).toBe(false);
  });

  it('stops at the line cap', () => {
    expect(highlightable('\n'.repeat(HIGHLIGHT_MAX_LINES - 1))).toBe(true);
    expect(highlightable('\n'.repeat(HIGHLIGHT_MAX_LINES))).toBe(false);
  });
});

describe('wrapsByDefault', () => {
  it('leaves code and tables unwrapped and wraps prose', () => {
    expect(wrapsByDefault('a.ts')).toBe(false);
    expect(wrapsByDefault('a.csv')).toBe(false);
    expect(wrapsByDefault('server.log')).toBe(false);
    expect(wrapsByDefault('notes.txt')).toBe(true);
    expect(wrapsByDefault('LICENSE')).toBe(true);
  });
});

describe('textLines', () => {
  it('splits on LF and CRLF and drops the empty line after a final newline', () => {
    expect(textLines('a\r\nb\n')).toEqual(['a', 'b']);
    expect(textLines('a\n\n')).toEqual(['a', '']);
    expect(textLines('')).toEqual(['']);
  });
});

describe('splitHighlightedLines', () => {
  it('closes a span open across lines and reopens it on the next', () => {
    const html = 'x <span class="hljs-comment">/* one\ntwo */</span> y\nz';
    expect(splitHighlightedLines(html)).toEqual([
      'x <span class="hljs-comment">/* one</span>',
      '<span class="hljs-comment">two */</span> y',
      'z',
    ]);
  });

  it('reopens nested spans in order', () => {
    const html = '<span class="a">1<span class="b">2\n3</span>4</span>';
    expect(splitHighlightedLines(html)).toEqual([
      '<span class="a">1<span class="b">2</span></span>',
      '<span class="a"><span class="b">3</span>4</span>',
    ]);
  });

  it('matches textLines on a trailing newline and CRLF', () => {
    expect(splitHighlightedLines('<span class="k">a</span>\r\nb\n')).toEqual(['<span class="k">a</span>', 'b']);
    expect(splitHighlightedLines('a\n\n')).toEqual(['a', '']);
  });
});
