import { describe, expect, it } from 'vitest';
import { launchpadComponentsCss } from './launchpadCss';

/** A file beside this one or under node_modules (node:fs through a dynamic import: this package has no node typings). */
async function read(path: string): Promise<string> {
  const fs = await import('node:fs' as string) as { readFileSync(path: URL, encoding: 'utf8'): string };
  return fs.readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** Each custom property declared in the .lp-theme rule, with its value. */
function declared(css: string): Map<string, string> {
  const start = css.indexOf('.lp-theme {');
  const body = css.slice(start, css.indexOf('\n}', start));
  return new Map([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
}

const used = (css: string, prefix: string) => [...new Set([...css.matchAll(new RegExp(`var\\((${prefix}[a-z0-9-]+)`, 'g'))].map(m => m[1]))].sort();

// Read by an icons rule termag never renders: BadgeIcon's brand fills.
const NOT_MAPPED = new Set([
  '--lp-color-brand-blue-light', '--lp-color-brand-lime-base', '--lp-color-brand-orange-base',
  '--lp-color-brand-purple-base', '--lp-color-white-900', '--lp-color-black-700',
]);

describe('the LaunchPad theme map', () => {
  it('maps every colour token the shipped components and icons read', async () => {
    const theme = declared(await read('./theme.css'));
    // What the build keeps of the components' stylesheet (vite.config.ts), so
    // the page base it drops (Alert's :root variables among it) is not asked for.
    const components = launchpadComponentsCss(await read('../../node_modules/@launchpad-ui/components/dist/style.css'));
    const icons = await read('../../node_modules/@launchpad-ui/icons/dist/style.css');
    const missing = used(components + icons, '--lp-color-').filter(t => !theme.has(t) && !NOT_MAPPED.has(t));
    expect(missing).toEqual([]);
  });

  it("declares each text token the components read again, with the tokens package's value, so it takes termag's font", async () => {
    const theme = declared(await read('./theme.css'));
    const tokens = new Map([...(await read('../../node_modules/@launchpad-ui/tokens/dist/index.css'))
      .matchAll(/(--lp-text-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
    const components = await read('../../node_modules/@launchpad-ui/components/dist/style.css');
    for (const token of used(components, '--lp-text-')) {
      expect(tokens.get(token), token).toBeDefined();
      expect(theme.get(token), token).toBe(tokens.get(token));
    }
    expect(theme.get('--lp-font-family-base')).toBe('var(--font-ui)');
    expect(theme.get('--lp-font-family-monospace')).toBe('var(--font-mono)');
  });

  it("sets lightningcss's light/dark switch to dark, as LaunchPad's [data-theme=dark] does, so Popover and Modal draw their border and shadow", async () => {
    const theme = declared(await read('./theme.css'));
    // An empty value: the regex's lone space, trimmed.
    expect(theme.get('--lightningcss-light')).toBe('');
    expect(theme.get('--lightningcss-dark')).toBe('initial');
    // The pair LaunchPad's page base sets for dark, which the build drops.
    const style = await read('../../node_modules/@launchpad-ui/components/dist/style.css');
    expect(style).toContain('[data-theme=dark]{--lightningcss-light: ;--lightningcss-dark:initial;');
    // And the kept rules that read it: Popover's and Modal's borders.
    const kept = launchpadComponentsCss(style);
    expect(kept).toMatch(/_popover\{[^}]*border:1px solid var\(--lightningcss-light,transparent\)/);
    expect(kept).toMatch(/_base\{[^}]*border:1px solid var\(--lightningcss-light,transparent\)/);
    expect(kept).not.toMatch(/--lightningcss-(light|dark):/);
  });

  it("maps only to termag's variables, never LaunchPad's palette", async () => {
    const theme = declared(await read('./theme.css'));
    for (const [token, value] of theme) {
      if (!token.startsWith('--lp-color-') && !token.startsWith('--alert-color-')) continue;
      expect(value, token).not.toMatch(/var\(--lp-/);
    }
  });
});
