// The chrome refresh's two palettes in chrome.css: LaunchPad's dark greys on
// .chat-root[data-chrome="refresh"], and its light ones under
// html[data-palette="light"] (theme/apply.ts). They replace App.css's tokens
// inside the refresh, so App.css's palette test can't see them: this holds
// the light set to the dark one (no token left dark) and both to WCAG AA.
import { describe, expect, it } from 'vitest';

/** chrome.css as shipped (node:fs through a dynamic import: this package has no node typings). */
async function sheet(): Promise<string> {
  const fs = await import('node:fs' as string) as { readFileSync(path: URL, encoding: 'utf8'): string };
  return fs.readFileSync(new URL('./chrome.css', import.meta.url), 'utf8');
}

/** The custom properties of the first rule whose selector list starts with `selector`. */
function tokens(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(`\n${selector}`);
  if (at < 0) return {};
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, '');
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
}

function luminance(h: string): number {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const isLiteral = (v: string) => /^#[0-9a-f]{6}$/i.test(v) || /^rgba\(/.test(v) || /^\d+, \d+, \d+$/.test(v);

type Tokens = Record<string, string>;

async function palettes(): Promise<{ dark: Tokens; lightOnly: Tokens; light: Tokens }> {
  const css = await sheet();
  const dark: Tokens = {
    ...tokens(css, ".chat-root[data-chrome='refresh'],"),
    '--chrome-window': tokens(css, ".chat-root[data-chrome='refresh'] {")['--chrome-window'],
  };
  const lightOnly: Tokens = {
    ...tokens(css, "html[data-palette='light'] .chat-root[data-chrome='refresh'],"),
    '--chrome-window': tokens(css, "html[data-palette='light'] .chat-root[data-chrome='refresh'] {")['--chrome-window'],
  };
  return { dark, lightOnly, light: { ...dark, ...lightOnly } };
}

const hex = (map: Record<string, string>, name: string) => {
  const v = map[name];
  expect(v, name).toMatch(/^#[0-9a-f]{6}$/i);
  return v;
};

// The window, a card, and the composer / menus.
const SURFACES = ['--chrome-window', '--bg-base', '--bg-surface', '--bg-elevated'];

describe('the chrome refresh palettes', () => {
  it('sets light values for every colour the dark set gives a literal, so none is left dark', async () => {
    const { dark, lightOnly } = await palettes();
    const literal = Object.keys(dark).filter(n => isLiteral(dark[n]));
    expect(literal.length).toBeGreaterThan(15);
    expect(literal.filter(n => !(n in lightOnly))).toEqual([]);
    expect(Object.keys(lightOnly).filter(n => !(n in dark))).toEqual([]);
  });

  it('keeps --status-ready-rgb and --unseen-rgb the colours they stand for', async () => {
    const { dark, light } = await palettes();
    for (const map of [dark, light]) {
      const rgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(', ');
      expect(map['--status-ready-rgb']).toBe(rgb(hex(map, '--status-ready')));
      expect(map['--unseen-rgb']).toBe(rgb(hex(map, '--accent')));
    }
  });

  it.each(['dark', 'light'] as const)('meets AA in %s', async (name) => {
    const map = (await palettes())[name];
    const text = ['--text-primary', '--text-secondary', '--text-muted', '--accent', '--success', '--warning', '--danger'];
    for (const fg of text) for (const bg of SURFACES) {
      expect(contrast(hex(map, fg), hex(map, bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(hex(map, '--text-secondary'), hex(map, '--bg-active')), 'secondary on active').toBeGreaterThanOrEqual(4.5);
    // App.css's --text-on-fill is white in both palettes.
    expect(contrast('#ffffff', hex(map, '--accent-dim')), 'white on accent-dim').toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex(map, '--text-inverse'), hex(map, '--text-primary')), 'inverse on primary').toBeGreaterThanOrEqual(4.5);
  });
});

describe("the sidebar's item menu (ContextMenu.tsx)", () => {
  it("keeps termag's palette: both of the refresh's palettes skip its popover, though it carries lp-theme", async () => {
    const css = await sheet();
    const palettes = css.split('\n').filter(l => l.includes(":has(.chat-root[data-chrome='refresh']) .lp-theme"));
    expect(palettes).toHaveLength(2);
    for (const l of palettes) expect(l).toContain('.lp-theme:not(.chat-ctx-popover) {');
  });
});
