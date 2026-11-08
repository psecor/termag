import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DAILY_THEME_DATE } from './date';
import { dailyThemeDates, loadDailyTheme } from './registry';
import { dayScope, keyframesPrefix, lintDayFiles, lintMeta, lintSprite, lintThemeCss } from './lint';

const D = '2026-11-05';
const S = dayScope(D);
const here = dirname(fileURLToPath(import.meta.url));
const days = readdirSync(here).filter(f => statSync(join(here, f)).isDirectory());

describe('every day in theme/daily', () => {
  it('is a dated directory the registry finds', () => {
    for (const d of days) expect(DAILY_THEME_DATE.test(d), `${d} is not named YYYY-MM-DD`).toBe(true);
    expect(dailyThemeDates()).toEqual([...days].sort());
  });

  it.each(days)('%s keeps the rules', async date => {
    const dir = join(here, date);
    const files = readdirSync(dir);
    const errors = lintDayFiles(date, files);
    const theme = await loadDailyTheme(date);
    expect(theme, `${date} did not load`).not.toBeNull();
    // The file itself, not what the registry made of it (it is null when a check fails).
    let parsed: unknown = null;
    try { parsed = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch (e) { errors.push(`${date}/meta.json: not JSON: ${(e as Error).message}`); }
    errors.push(...lintMeta(parsed, date));
    errors.push(...lintThemeCss(readFileSync(join(dir, 'theme.css'), 'utf8'), date));
    if (files.includes('sprite.js')) {
      errors.push(...lintSprite(readFileSync(join(dir, 'sprite.js'), 'utf8'), date));
      expect(typeof theme!.sprite).toBe('string');
    }
    expect(errors).toEqual([]);
  });
});

describe('the registry', () => {
  it('reads every day file as text and never imports one as a module', () => {
    const src = readFileSync(join(here, 'registry.ts'), 'utf8');
    const globs = [...src.matchAll(/import\.meta\.glob<[^>]+>\(([^)]*)\)/g)].map(m => m[1]);
    expect(globs).toHaveLength(3);
    for (const g of globs) expect(g, g).toMatch(/query: '\?(raw|inline)'/);
    expect(src).not.toMatch(/import\(\s*`?\.\/\$\{|import\(\s*'\.\/\d{4}/);
  });
});

describe('lintDayFiles', () => {
  it('wants meta.json and theme.css and nothing but the three files', () => {
    expect(lintDayFiles(D, ['meta.json', 'theme.css'])).toEqual([]);
    expect(lintDayFiles(D, ['meta.json', 'theme.css', 'sprite.js'])).toEqual([]);
    expect(lintDayFiles(D, ['meta.json', 'theme.css', 'sprite.ts'])).toEqual([expect.stringMatching(/only/)]);
    expect(lintDayFiles(D, ['meta.ts', 'theme.css'])).toEqual([expect.stringMatching(/only/), expect.stringMatching(/meta\.json is missing/)]);
    expect(lintDayFiles(D, ['meta.json'])).toEqual([expect.stringMatching(/theme\.css is missing/)]);
    expect(lintDayFiles(D, ['meta.json', 'theme.css', 'helper.ts'])).toEqual([expect.stringMatching(/only/)]);
    expect(lintDayFiles('latest', ['meta.json', 'theme.css'])).toEqual([expect.stringMatching(/YYYY-MM-DD/)]);
  });
});

describe('lintThemeCss', () => {
  const ok = (css: string) => expect(lintThemeCss(css, D)).toEqual([]);
  const bad = (css: string, why: RegExp) => expect(lintThemeCss(css, D)).toEqual([expect.stringMatching(why)]);

  it('passes scoped rules, palette variants, data images and guarded motion', () => {
    ok(`${S} { --accent: #e07b2a; }`);
    ok(`${S}[data-palette="light"] .chat-root, ${S} .app-sidebar > a:hover { color: #222; }`);
    ok(`${S} .x { background: url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E"); }`);
    ok(`@keyframes ${keyframesPrefix(D)}sway { from { opacity: 0 } to { opacity: 1 } }
        @media (prefers-reduced-motion: no-preference) { ${S} .x { animation: ${keyframesPrefix(D)}sway 2s; } }`);
    ok(`${S} .x { transition: none; }`);
  });

  it('fails a selector outside the day, or another day', () => {
    bad(`.app-sidebar { color: red; }`, /does not start with/);
    bad(`html[data-daily-theme="2026-11-04"] .x { color: red; }`, /does not start with/);
    bad(`${S}x .y { color: red; }`, /does not start with/);
    bad(`${S} .x, body { color: red; }`, /"body"/);
  });

  it('fails fetches, imports, fonts, !important and the engine layer', () => {
    bad(`${S} .x { background: url(https://example.com/a.png); }`, /data:image/);
    bad(`@import "x.css";`, /@import/);
    bad(`@font-face { font-family: x; }`, /@font-face/);
    bad(`${S} .x { color: red !important; }`, /!important/);
    expect(lintThemeCss(`${S} .daily-theme-decor { opacity: 1; }`, D)).toEqual([expect.stringMatching(/engine/)]);
  });

  it('fails motion outside a reduced-motion guard and keyframes without the prefix', () => {
    bad(`${S} .x { animation: spin 1s; }`, /prefers-reduced-motion/);
    bad(`@keyframes spin { from { opacity: 0 } }`, /start with dt-20261105-/);
  });

  it('fails CSS that does not parse or is too big', () => {
    expect(lintThemeCss(`${S} .x { color: red;`, D)[0]).toMatch(/does not parse/);
    expect(lintThemeCss(`${S} { --a: "${'x'.repeat(17000)}"; }`, D)[0]).toMatch(/bytes/);
  });
});

describe('lintSprite', () => {
  const body = `const COLORS = ['#fff'];\nexport default { create: () => ({ draw: ({ ctx, width }) => { const a = [1, 2]; ctx.fillStyle = COLORS[0]; ctx.fillRect(a[0], a[1 + 0], width, 1); } }) };\n`;
  it('passes a sprite that only draws', () => expect(lintSprite(body, D)).toEqual([]));
  it('fails any import, a missing default, a nested or second export default, and TypeScript', () => {
    expect(lintSprite(`import x from './x.js';\n` + body, D)).toEqual([expect.stringMatching(/imports nothing/)]);
    expect(lintSprite(`const x = 1;`, D)).toEqual([expect.stringMatching(/export default/)]);
    expect(lintSprite(`export const x = 1;\n` + body, D)).toEqual([expect.stringMatching(/one export/)]);
    expect(lintSprite(`  export default {};\n`, D)).toContainEqual(expect.stringMatching(/starts a line/));
    expect(lintSprite(body + `const s = \`\nexport default 1\`;\n`, D)).toEqual([expect.stringMatching(/exactly one line/)]);
    expect(lintSprite(`const n: number = 1;\n` + body, D).length).toBeGreaterThan(0);
  });
  it('fails a reach for the page, the network, timers or code', () => {
    for (const reach of ['window.alert(1)', 'fetch("/x")', 'setTimeout(() => 0, 1)', 'new Function("x")', 'import("x")', 'ctx.canvas.ownerDocument', 'ctx["constructor"]', 'eval("1")']) {
      expect(lintSprite(`const f = (ctx) => { ${reach}; };\n` + body, D).length, reach).toBeGreaterThan(0);
    }
  });
});
