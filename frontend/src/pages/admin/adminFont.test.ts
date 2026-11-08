// The admin pages (/admin/*) read in the UI font; monospace is only for code
// (CLAUDE.md, "monospace only for code"). The body stays monospace for the full UI's terminals,
// so the switch is scoped to the pages' root. jsdom computes no fonts, so this pins the rules in
// App.css and the root classes the pages render.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { kernelParts } from './rebootPending';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const css = read('../../App.css');
/** The declarations of the first rule whose selector list is exactly `selector`. */
const rule = (selector: string) => {
  const m = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm').exec(css);
  return m ? m[1] : '';
};

describe('admin font', () => {
  it('puts the admin pages on the UI font', () => {
    expect(rule('.admin-page')).toMatch(/font-family:\s*var\(--font-ui\)/);
  });

  it('keeps code monospace inside them', () => {
    expect(rule('.admin-page :where(code, kbd, pre, samp)')).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(rule('.admin-mono')).toMatch(/font-family:\s*var\(--font-mono\)/);
    // The Software tab's host matrix: every cell is a version or a commit.
    expect(rule('.admin-sw-matrix td .admin-sw:not(.admin-sw--words)')).toMatch(/font-family:\s*var\(--font-mono\)/);
  });

  it('leaves the body, and so the full UI and its terminals, monospace', () => {
    expect(rule('body')).toMatch(/font-family:\s*var\(--font-mono\)/);
  });

  it('is the class on the pages\' root', () => {
    expect(read('../Admin.tsx')).toMatch(/className="dash-page admin-page"/);
  });
});

describe('kernelParts', () => {
  it('marks the kernel versions in a reboot line, so only they are monospace', () => {
    const line = 'Reboot pending since 2026-11-02 06:10 UTC (1 d): kernel 6.8.0-1068-aws installed · packages: linux-base. The next boot takes it.';
    const parts = kernelParts(line);
    expect(parts.filter(p => p.kernel).map(p => p.text)).toEqual(['6.8.0-1068-aws']);
    expect(parts.map(p => p.text).join('')).toBe(line);
  });
  it('leaves a line with no kernel as one part of words', () => {
    expect(kernelParts('Reboot pending: reboot-required.')).toEqual([{ text: 'Reboot pending: reboot-required.', kernel: false }]);
  });
});
