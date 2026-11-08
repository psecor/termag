// Theme of the day's preview: screenshots of a
// day's theme in both UIs and both palettes, before and after, and axe-core's
// colour-contrast rule over each, against a running e2e stack with the flag on:
//
//   make e2e-up E2E_FLAGS='{"daily-theme-enabled":true}'
//
//   node scripts/daily-theme/preview.mjs <YYYY-MM-DD> [--ui http://localhost:5174/termag/] [--out <dir>]
//
// Writes <out>/<ui>-<palette>.png and <ui>-<palette>-before.png, and
// <out>/contrast.json. Exits 1 when the theme adds a contrast violation that
// the same page without it does not have, or lowers the ratio of one it
// already has (the app's own are not the day's to fix, but it may not make
// them worse), 2 on a usage or setup error. The default out is
// .termag/theme-of-the-day/out/<date>/screenshots (gitignored).
//
// Screenshots are taken with reduced motion, so a sprite draws one still frame.
// The signed-in user's theme is switched through the API for the palettes and
// put back at the end. So run one preview at a time against a stack: two at once
// switch the same user's palette under each other, and report the other
// palette's colours.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
if (!date) {
  console.error('usage: preview.mjs <YYYY-MM-DD> [--ui <url>] [--out <dir>]');
  process.exit(2);
}
if (!existsSync(join(repo, 'frontend/src/theme/daily', date, 'meta.json'))) {
  console.error(`no theme for ${date} in frontend/src/theme/daily/`);
  process.exit(2);
}
const ui = opt('ui', 'http://localhost:5174/termag/').replace(/\/?$/, '/');
const out = resolve(opt('out', join(repo, '.termag/theme-of-the-day/out', date, 'screenshots')));
const axePath = join(repo, 'frontend/node_modules/axe-core/axe.min.js');
if (!existsSync(axePath)) {
  console.error('axe-core is missing: run npm ci in frontend/');
  process.exit(2);
}
const playwrightPath = process.env.PLAYWRIGHT_MODULE ?? '/opt/playwright/node_modules/playwright/index.mjs';
const { chromium } = await import(playwrightPath);
mkdirSync(out, { recursive: true });

const PAGES = [
  { name: 'full', path: '' },
  { name: 'simple', path: 'chat' },
];
const PALETTES = ['dark', 'light'];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const page = await ctx.newPage();
const api = async (method, path, data) => {
  const res = await ctx.request.fetch(`${ui}${path}`, { method, data });
  if (!res.ok()) throw new Error(`${method} ${path}: HTTP ${res.status()} ${await res.text()}`);
  return res.json().catch(() => null);
};

let failed = false;
const report = { date, ui, pages: [] };
let original = null;
try {
  await page.goto(`${ui}auth/login`);
  const me = await api('GET', 'auth/me');
  original = me?.theme ?? {};

  // Run axe's colour-contrast rule: each failing node, by selector, with its ratio.
  const contrast = async () => {
    await page.addScriptTag({ path: axePath });
    const result = await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      const r = await axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] }, resultTypes: ['violations'] });
      return r.violations.flatMap(v => v.nodes.map(n => ({
        target: n.target.join(' '),
        ratio: [...n.any, ...n.all, ...n.none].find(c => typeof c.data?.contrastRatio === 'number')?.data.contrastRatio ?? null,
        summary: n.failureSummary,
      })));
    });
    return result;
  };
  const load = async (path, theme) => {
    await page.goto(`${ui}${path}?dailyTheme=${theme ? date : 'off'}`);
    if (theme) {
      await page.waitForSelector(`html[data-daily-theme="${date}"]`, { state: 'attached', timeout: 120_000 }).catch(() => {
        throw new Error(`the day never applied. Is daily-theme-enabled on? make e2e-up E2E_FLAGS='{"daily-theme-enabled":true}'`);
      });
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);
  };

  for (const palette of PALETTES) {
    await api('PUT', 'auth/me/preferences', { theme: { version: 1, background: { mode: 'hyperspace' }, palette } });
    for (const p of PAGES) {
      await load(p.path, false);
      await page.screenshot({ path: join(out, `${p.name}-${palette}-before.png`) });
      const before = new Map((await contrast()).map(v => [v.target, v.ratio]));
      await load(p.path, true);
      await page.screenshot({ path: join(out, `${p.name}-${palette}.png`) });
      // New failures, and old ones the theme made worse (a lower ratio).
      const added = (await contrast()).filter(v => {
        if (!before.has(v.target)) return true;
        const was = before.get(v.target);
        return was != null && v.ratio != null && v.ratio < was - 0.005;
      }).map(v => ({ ...v, before: before.get(v.target) ?? null }));
      report.pages.push({ ui: p.name, palette, added });
      console.log(`${added.length ? 'FAIL' : 'ok  '} ${p.name} ${palette}: ${added.length} new or worse contrast violation(s)`);
      for (const v of added.slice(0, 10)) {
        const ratio = v.before != null ? `${v.before} → ${v.ratio}` : `${v.ratio ?? '?'}`;
        console.log(`       ${v.target} (${ratio}:1)\n         ${String(v.summary).split('\n').slice(1, 2).join(' ').trim()}`);
      }
      if (added.length) failed = true;
    }
  }
} catch (err) {
  console.error(`preview failed: ${err.message}`);
  process.exitCode = 2;
} finally {
  // The palette goes back explicitly: dark is stored as an absent key, and the
  // server fills an absent key from the stored theme, which is the last palette
  // this run set (the same reason Appearance's Reset sends palette: 'dark').
  if (original) {
    await api('PUT', 'auth/me/preferences', {
      theme: { version: 1, background: { mode: 'hyperspace' }, ...original, palette: original.palette === 'light' ? 'light' : 'dark' },
    }).catch(err => console.error(`could not put the theme back: ${err.message}`));
  }
  writeFileSync(join(out, 'contrast.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
console.log(`screenshots and contrast.json in ${out}`);
if (failed && !process.exitCode) process.exitCode = 1;
