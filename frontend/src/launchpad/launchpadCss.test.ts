import { describe, expect, it } from 'vitest';
import postcss, { type AtRule } from 'postcss';
import { launchpadComponentsCss, modulePrefixes } from './launchpadCss';

/** The installed stylesheet as shipped (node:fs through a dynamic import: this package has no node typings). */
async function shipped(): Promise<string> {
  const fs = await import('node:fs' as string) as { readFileSync(path: URL, encoding: 'utf8'): string };
  return fs.readFileSync(new URL('../../node_modules/@launchpad-ui/components/dist/style.css', import.meta.url), 'utf8');
}

const FIXTURE = `
html { font-size: 100%; }
*, *::before { box-sizing: border-box; }
body { font: var(--lp-text-body-1-regular); }
:root { color-scheme: light dark; }
h1, h2 { margin: 0; }
[data-theme] { color: black; }
@font-face { font-family: X; src: url(x.woff2); }
.AbCdEf_slider { display: grid; }
.AbCdEf_slider[data-orientation='horizontal'] .AbCdEf_track { height: 8px; }
.AbCdEf_thumb { animation: AbCdEf_pulse 1s; }
.Zz9xQq_button { color: red; }
._1iK3oq_popover { color: blue; }
.AbCdEf_track, .Zz9xQq_button { outline: 0; }
.Zz9xQq_button, h3 { margin: 0; }
@media (forced-colors: active) { .AbCdEf_fill { background: Highlight; } body { color: CanvasText; } }
@media print { body { display: none; } }
@keyframes AbCdEf_pulse { to { opacity: 0.5; } }
@keyframes Zz9xQq_spin { to { rotate: 1turn; } }
`;

describe('launchpadComponentsCss', () => {
  it("keeps every component's rules, and none of the page-wide base", () => {
    const out = launchpadComponentsCss(FIXTURE);
    expect(out).toContain('.AbCdEf_slider { display: grid; }');
    expect(out).toContain(".AbCdEf_slider[data-orientation='horizontal'] .AbCdEf_track");
    expect(out).toContain('.Zz9xQq_button { color: red; }');
    expect(out).toContain('.AbCdEf_track, .Zz9xQq_button { outline: 0; }');
    expect(out).toContain('@media (forced-colors: active) { .AbCdEf_fill');
    expect(out).toContain('@keyframes AbCdEf_pulse');
    for (const gone of ['html', 'box-sizing', 'body', ':root', 'h1', 'h3', '[data-theme]', '@font-face', '@media print', 'Zz9xQq_spin']) {
      expect(out).not.toContain(gone);
    }
  });

  it('takes a module whose hash starts with an underscore', () => {
    expect(modulePrefixes(FIXTURE)).toEqual(['AbCdEf', 'Zz9xQq', '_1iK3oq']);
    expect(launchpadComponentsCss(FIXTURE)).toContain('._1iK3oq_popover { color: blue; }');
  });

  it('fails loudly when the stylesheet has no module classes', () => {
    expect(() => launchpadComponentsCss('html { margin: 0; } .plain { color: red; }')).toThrow(/no \.<hash>_<local>/);
  });

  it('filters the installed @launchpad-ui/components stylesheet to its components', async () => {
    const css = await shipped();
    expect(css).toMatch(/(^|[}\s])html\s*\{/);
    const prefixes = modulePrefixes(css);
    const out = launchpadComponentsCss(css);
    // The components termag uses, and the ones new UI reaches for first.
    const has = (local: string) => prefixes.some(p => out.includes(`.${p}_${local}{`) || out.includes(`.${p}_${local}[`) || out.includes(`.${p}_${local} `));
    for (const local of ['slider', 'button', 'menu', 'popover', 'tooltip', 'tabs']) expect(has(local), local).toBe(true);
    // Modules whose hash holds a `_`: Group (the box a SearchField's input sits in) lost every rule while it read as no module.
    expect(prefixes.filter(p => p.replace(/^_/, '').includes('_')).length).toBeGreaterThan(0);
    for (const local of ['group', 'search']) expect(has(local), local).toBe(true);
    expect(out).toMatch(/\.[A-Za-z0-9_-]{6}_group input\[data-rac\]/);
    // Nothing that styles termag's own elements: every selector names a LaunchPad class.
    postcss.parse(out).walkRules(rule => {
      if (rule.parent?.type === 'atrule' && (rule.parent as AtRule).name === 'keyframes') return;
      for (const s of rule.selectors) expect(prefixes.some(p => s.includes(`.${p}_`)), s).toBe(true);
    });
  });
});

