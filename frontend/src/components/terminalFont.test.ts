import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { terminalFontFamily, TERMINAL_FONT } from './terminalFont';

const STACK = "'JetBrains Mono Variable', 'JetBrains Mono', monospace";
const fonts = join(dirname(fileURLToPath(import.meta.url)), '../fonts');

describe('terminalFontFamily', () => {
  it('puts Maple Mono ahead of the stack by default', () => {
    expect(terminalFontFamily(STACK, undefined)).toBe(`'Maple Mono', ${STACK}`);
    expect(terminalFontFamily(STACK, 'maple')).toBe(`'Maple Mono', ${STACK}`);
  });

  it('is the JetBrains Mono stack itself when Appearance chooses it', () => {
    expect(terminalFontFamily(STACK, 'jetbrains')).toBe(STACK);
  });
});

describe('bundled terminal font', () => {
  it('declares woff2 faces that exist, beside its licence', () => {
    const sheet = join(fonts, 'maple-mono/maple-mono.css');
    const css = readFileSync(sheet, 'utf8');
    const faces = css.match(/@font-face\s*{[^}]*}/g) ?? [];
    // Regular, italic, bold and bold italic: what xterm draws.
    expect(faces).toHaveLength(4);
    for (const face of faces) {
      expect(face).toContain(`font-family: ${TERMINAL_FONT};`);
      const url = /url\(\.\/([^)]+)\)/.exec(face)?.[1];
      expect(url).toMatch(/\.woff2$/);
      expect(existsSync(join(dirname(sheet), url!))).toBe(true);
    }
    expect(existsSync(join(dirname(sheet), 'LICENSE.txt'))).toBe(true);
  });

  it('is the only font bundled for terminals', () => {
    expect(existsSync(join(fonts, 'monaspace-argon'))).toBe(false);
  });
});
