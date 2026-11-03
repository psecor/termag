// App.css's two palettes: the dark :root tokens and the html[data-palette="light"]
// block that theme/apply.ts switches on. jsdom does no cascade, so this reads the
// stylesheet: the light block must set every colour :root sets (no token left
// dark), each --x-rgb triplet must be its hex token's colour, and the pairs the
// UI draws must meet WCAG AA in both palettes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_COLOR } from './apply';
import { BASE_BACKGROUND_COLORS } from './schema';
import { TERMINAL_ISLAND_CLASS } from '../components/terminalTheme';
import { HUE } from '../pages/dashboard/chartPalette';
import { PALETTE as SERIES_PALETTE } from './seriesPalette';
import { PROVIDERS } from '../providers/registry';

const css = readFileSync(join(__dirname, '../App.css'), 'utf8');
const indexHtml = readFileSync(join(__dirname, '../../index.html'), 'utf8');

/** Each top-level rule's selector list and body, comments dropped, in file order. */
function rules(): { selectors: string[]; body: string }[] {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...plain.matchAll(/(?:^|\n)([^{}\n@][^{}]*?)\s*\{([^{}]*)\}/g)]
    .map(m => ({ selectors: m[1].split(',').map(s => s.trim()), body: m[2] }));
}

/** The custom properties of the first rule whose selector list includes `selector`. */
function tokens(selector: string): Record<string, string> {
  const rule = rules().find(r => r.selectors.includes(selector));
  if (!rule) return {};
  return Object.fromEntries([...rule.body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
}

const dark = tokens(':root');
const lightOnly = tokens('html[data-palette="light"]');
const light = { ...dark, ...lightOnly };
const PALETTES = { dark, light } as const;

/** A literal colour: a hex, an rgb()/rgba() with numbers, or a bare r, g, b triplet. */
const isColourLiteral = (v: string) =>
  /#[0-9a-f]{3,8}\b/i.test(v) || /rgba?\(\s*\d/.test(v) || /^\d+,\s*\d+,\s*\d+$/.test(v);

function resolve(map: Record<string, string>, name: string, seen = new Set<string>()): string {
  const v = map[name];
  if (v === undefined) throw new Error(`${name} is not defined`);
  if (seen.has(name)) throw new Error(`${name} refers to itself`);
  seen.add(name);
  return v.replace(/var\((--[\w-]+)\)/g, (_, ref: string) => resolve(map, ref, seen));
}

function hex(map: Record<string, string>, name: string): string {
  const v = resolve(map, name);
  expect(v, name).toMatch(/^#[0-9a-f]{6}$/i);
  return v.toLowerCase();
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

const SURFACES = ['--bg-base', '--bg-surface', '--bg-elevated'];

describe('the light palette block', () => {
  it('exists and switches color-scheme', () => {
    expect(Object.keys(lightOnly).length).toBeGreaterThan(0);
    expect(css).toMatch(/html\[data-palette="light"\] \{[^}]*color-scheme: light;/);
  });

  it('sets every colour token that :root sets to a literal, so none is left dark', () => {
    // --terminal-* is read only inside the terminal, which is dark in both palettes.
    const literal = Object.keys(dark).filter(name => isColourLiteral(dark[name]) && !name.startsWith('--terminal-'));
    expect(literal.length).toBeGreaterThan(30);
    expect(literal.filter(name => !(name in lightOnly))).toEqual([]);
  });

  it('sets nothing :root does not define', () => {
    expect(Object.keys(lightOnly).filter(name => !(name in dark))).toEqual([]);
  });

  it('defines the tokens the simple UI will share', () => {
    for (const name of ['--shadow-popover', '--scrim', '--ring-plan']) {
      expect(dark[name], name).toBeDefined();
      expect(lightOnly[name], name).toBeDefined();
    }
  });
});

describe.each(Object.entries(PALETTES))('the %s palette', (_, map) => {
  it('keeps each --x-rgb triplet equal to its --x hex token', () => {
    const triplets = Object.keys(map)
      .filter(n => n.endsWith('-rgb') && n.slice(0, -4) in map && resolve(map, n.slice(0, -4)).startsWith('#'));
    expect(triplets.length).toBeGreaterThanOrEqual(12);
    for (const name of triplets) {
      const h = hex(map, name.slice(0, -4));
      const rgb = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(', ');
      expect(resolve(map, name), name).toBe(rgb);
    }
  });

  it('keeps --unseen-rgb the accent, and --scrim the --scrim-rgb colour', () => {
    expect(resolve(map, '--unseen-rgb')).toBe(resolve(map, '--accent-rgb'));
    expect(resolve(map, '--scrim')).toMatch(new RegExp(`^rgba\\(${resolve(map, '--scrim-rgb')}, [\\d.]+\\)$`));
  });

  it('meets 4.5:1 for text on every surface', () => {
    const text = ['--text-primary', '--text-secondary', '--accent', '--danger', '--success', '--warning'];
    for (const fg of text) for (const bg of SURFACES) {
      expect(contrast(hex(map, fg), hex(map, bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('meets 4.5:1 for syntax colours on the page and panels', () => {
    const code = ['--code-keyword', '--code-string', '--code-number', '--code-comment', '--code-function',
      '--code-type', '--code-tag', '--code-attr'];
    for (const fg of code) for (const bg of ['--bg-base', '--bg-surface']) {
      expect(contrast(hex(map, fg), hex(map, bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('meets 3:1 for status dots, the focus ring and the plan arc', () => {
    const graphics = ['--status-working', '--status-waiting', '--status-ready', '--accent-dim', '--ring-plan'];
    for (const fg of graphics) for (const bg of SURFACES) {
      expect(contrast(hex(map, fg), hex(map, bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('meets 4.5:1 for text on the fills the UI draws it on', () => {
    const pairs: Array<[string, string]> = [
      ['--text-inverse', '--accent'], // the PR prompt, the wizard step, the review button
      ['--text-inverse', '--danger'], // the admin badge
      ['--bg-base', '--warning'], // the degraded connection banner
      ['--text-primary', '--bg-active'],
    ];
    for (const [fg, bg] of pairs) {
      expect(contrast(hex(map, fg), hex(map, bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('box colours (utils/boxColor.ts: a hue at --box-saturation and --box-lightness)', () => {
  /** hsl(h, s%, l%) as #rrggbb. */
  function hsl(h: number, s: number, l: number): string {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  const pct = (map: Record<string, string>, name: string) => {
    const v = resolve(map, name);
    expect(v, name).toMatch(/^\d+(\.\d+)?%$/);
    return parseFloat(v) / 100;
  };

  it('keeps dark at the 55% / 58% it has always drawn', () => {
    expect([resolve(dark, '--box-saturation'), resolve(dark, '--box-lightness')]).toEqual(['55%', '58%']);
  });

  it('meets 3:1 in light for every hue on every surface', () => {
    const [s, l] = [pct(light, '--box-saturation'), pct(light, '--box-lightness')];
    for (let h = 0; h < 360; h++) for (const bg of SURFACES) {
      expect(contrast(hsl(h, s, l), hex(light, bg)), `hue ${h} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('light against dark', () => {
  it('puts white text on the primary fill in light (dark\'s #1f6feb is 4.6:1 already)', () => {
    expect(contrast(hex(light, '--text-on-fill'), hex(light, '--accent-dim'))).toBeGreaterThanOrEqual(4.5);
  });

  it('gives --text-muted no less contrast than dark does, on each surface (dark fails AA; not fixed here)', () => {
    for (const bg of [...SURFACES, '--bg-active']) {
      const d = contrast(hex(dark, '--text-muted'), hex(dark, bg));
      expect(contrast(hex(light, '--text-muted'), hex(light, bg)), bg).toBeGreaterThanOrEqual(d);
    }
  });

  it('makes the theme-color meta each palette\'s --bg-surface, as index.html does', () => {
    expect(THEME_COLOR.dark).toBe(hex(dark, '--bg-surface'));
    expect(THEME_COLOR.light).toBe(hex(light, '--bg-surface'));
    expect(indexHtml).toContain(`content="${THEME_COLOR.dark}"`);
    expect(indexHtml).toContain(`.content = '${THEME_COLOR.light}'`);
  });
});

describe('the terminal island (components/terminalTheme.ts)', () => {
  const island = `html[data-palette="light"] .${TERMINAL_ISLAND_CLASS}`;

  it('gets the whole dark set back in light, from the same rule as :root', () => {
    const rule = rules().find(r => r.selectors.includes(':root'));
    expect(rule?.selectors).toEqual([':root', island]);
    expect(tokens(island)).toEqual(dark);
  });

  it('is opaque in light: the strip xterm leaves is the dark base too', () => {
    const own = rules().filter(r => r.selectors.length === 1 && r.selectors[0] === island);
    expect(own.map(r => r.body)).toEqual([expect.stringMatching(/background:\s*var\(--bg-base\);/)]);
  });

  it('defines the selection, and only for the terminal', () => {
    expect(dark['--terminal-selection']).toBe('#264f7880');
    expect(lightOnly['--terminal-selection']).toBeUndefined();
  });
});

describe('the backdrop per palette (theme/schema.ts BASE_BACKGROUND_COLORS)', () => {
  it('is each palette\'s --bg-base', () => {
    expect(BASE_BACKGROUND_COLORS.dark).toBe(hex(dark, '--bg-base'));
    expect(BASE_BACKGROUND_COLORS.light).toBe(hex(light, '--bg-base'));
  });
});

describe('App.css outside the palettes', () => {
  it('draws no palette colour as a literal, so tints follow the palette', () => {
    const lightEnd = css.indexOf('\n}', css.indexOf('html[data-palette="light"] {'));
    const rest = css.slice(lightEnd).replace(/\/\*[\s\S]*?\*\//g, '');
    const literals = [...rest.matchAll(/#[0-9a-f]{3,8}\b|rgba?\(\s*\d[^)]*\)|:\s*(white|black)\b/gi)].map(m => m[0]);
    // The browser pane's page backing is white in every palette, as a page is.
    expect(literals).toEqual(['#fff']);
  });
});

// The charts (pages/dashboard/chartPalette.ts, the provider registry, the
// series palette). A series mark needs 3:1 against the card it sits on
// (WCAG 1.4.11); the cards are --bg-surface, the page --bg-base.
const CHART_SURFACES = ['--bg-base', '--bg-surface'];

/** `rgba(r, g, b, a)` as an opaque #rrggbb: what the charts draw (opaque()). */
function rgbHex(c: string): string {
  const m = c.match(/^rgba?\((\d+), (\d+), (\d+)(?:, [\d.]+)?\)$/);
  expect(m, c).not.toBeNull();
  return '#' + m!.slice(1, 4).map(v => Number(v).toString(16).padStart(2, '0')).join('');
}

describe('the chart series tokens', () => {
  const names = Object.values(HUE).map(v => v.match(/^var\((--[\w-]+)\)$/)![1]);

  it('are each a hex token in both palettes, and the cursor follows the ink', () => {
    expect(names.length).toBe(11);
    for (const name of names) {
      hex(dark, name);
      expect(lightOnly[name], name).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(dark['--chart-cursor']).toMatch(/^rgba\(var\(--ink-rgb\), [\d.]+\)$/);
    expect(lightOnly['--chart-cursor']).toMatch(/^rgba\(var\(--ink-rgb\), [\d.]+\)$/);
  });

  it.each(Object.entries(PALETTES))('meet 3:1 on the chart surfaces in %s', (_, map) => {
    for (const name of names.filter(n => n !== '--series-unattributed')) for (const bg of CHART_SURFACES) {
      expect(contrast(hex(map, name), hex(map, bg)), `${name} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('keep Unattributed recessive, but no fainter in light than in dark', () => {
    for (const bg of CHART_SURFACES) {
      const d = contrast(hex(dark, '--series-unattributed'), hex(dark, bg));
      expect(contrast(hex(light, '--series-unattributed'), hex(light, bg)), bg).toBeGreaterThanOrEqual(d);
    }
  });
});

describe('the provider colours', () => {
  it('give every provider a light pair, as rgba like the dark one', () => {
    for (const p of Object.values(PROVIDERS)) {
      for (const c of [p.color.base, p.color.bright, p.lightColor.base, p.lightColor.bright]) rgbHex(c);
    }
  });

  it('meet 3:1 (the series fill) and 4.5:1 (the bright, a badge\'s text and border) on the light surfaces', () => {
    for (const p of Object.values(PROVIDERS)) for (const bg of [...CHART_SURFACES, '--bg-elevated']) {
      const surface = hex(light, bg);
      expect(contrast(rgbHex(p.lightColor.base), surface), `${p.id} base on ${bg}`).toBeGreaterThanOrEqual(3);
      expect(contrast(rgbHex(p.lightColor.bright), surface), `${p.id} bright on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('meet 3:1 for the series fill on the dark surfaces too', () => {
    for (const p of Object.values(PROVIDERS)) for (const bg of CHART_SURFACES) {
      expect(contrast(rgbHex(p.color.base), hex(dark, bg)), `${p.id} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('never draw You (the human series) white in light', () => {
    expect(rgbHex(PROVIDERS.human.lightColor.bright)).not.toBe('#ffffff');
    expect(rgbHex(PROVIDERS.human.lightColor.base)).not.toBe('#ffffff');
  });
});

describe('the series palette (one set for both palettes)', () => {
  it.each(Object.entries(PALETTES))('meets 3:1 on the chart surfaces in %s', (_, map) => {
    for (const c of SERIES_PALETTE) for (const bg of CHART_SURFACES) {
      expect(contrast(c, hex(map, bg)), `${c} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });
});
