// The redesign's card and head styles (sessionCard.css). jsdom does no
// layout or hover, so this pins what keeps them right: every rule names a card-only class, a head's
// class or the sidebar's [data-sidebar-ux] (so nothing changes with user-projects-enabled off), and
// the hover controls' rules sit outside any media query (a stray one once hid every head on desktop).
import { describe, expect, it } from 'vitest';

async function sheet(): Promise<string> {
  const fs = await import('node:fs' as string) as { readFileSync(path: URL, encoding: 'utf8'): string };
  return fs.readFileSync(new URL('./sessionCard.css', import.meta.url), 'utf8');
}

interface Rule { selectors: string[]; at: string[]; body: string }

/** Every style rule with the at-rules it sits in; throws on unbalanced braces. */
function rules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const at: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      const prelude = text.slice(start, i).trim();
      if (prelude.startsWith('@')) { at.push(prelude.replace(/\s+/g, ' ')); start = i + 1; continue; }
      const end = text.indexOf('}', i);
      const nested = text.indexOf('{', i + 1);
      if (end < 0 || (nested >= 0 && nested < end)) throw new Error(`unclosed: ${prelude}`);
      out.push({ selectors: prelude.split(/,(?![^(]*\))/).map(s => s.replace(/\s+/g, ' ').trim()), at: [...at], body: text.slice(i + 1, end) });
      i = end;
      start = end + 1;
    } else if (text[i] === '}') {
      if (!at.length) throw new Error(`a stray } at ${i}`);
      at.pop();
      start = i + 1;
    }
  }
  if (at.length) throw new Error(`unclosed: ${at.join(' > ')}`);
  return out;
}

type Weight = [ids: number, classes: number, types: number];
const byWeight = (x: Weight, y: Weight) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

/** A selector's specificity, for the shapes these sheets use: :is(), :not() and :has() count their heaviest argument. */
function specificity(selector: string): Weight {
  const out: Weight = [0, 0, 0];
  const rest = selector.replace(/:(is|not|has|where)\(((?:[^()]|\([^()]*\))*)\)/g, (_m, fn: string, args: string) => {
    if (fn !== 'where') {
      const heaviest = args.split(/,(?![^(]*\))/).map(a => specificity(a.trim())).sort(byWeight).pop()!;
      for (let i = 0; i < 3; i++) out[i] += heaviest[i];
    }
    return ' ';
  });
  out[0] += (rest.match(/#[\w-]+/g) ?? []).length;
  out[1] += (rest.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):[\w-]+/g) ?? []).length;
  out[2] += (rest.match(/::[\w-]+|(?:^|[\s>+~])[a-z][\w-]*/g) ?? []).length;
  return out;
}
const heavier = (a: string, b: string) => byWeight(specificity(a), specificity(b)) > 0;

describe('sessionCard.css', () => {
  it('weighs selectors as the browser does', () => {
    expect(specificity(".chat-root[data-chrome='refresh'] :is(.chat-archived-fold, .chat-projects-fold)")).toEqual([0, 3, 0]);
    expect(specificity(".chat-root[data-chrome='refresh'] .pj-head .pj-fold:is(:focus-visible, [data-focus-visible])")).toEqual([0, 5, 0]);
    expect(specificity('#a li.b::after')).toEqual([1, 1, 2]);
    expect(specificity(':where(.a) .b')).toEqual([0, 1, 0]);
  });

  it('closes every block', async () => {
    expect(() => rules('a { b: c } @media (x) { d { e: f }')).toThrow(/unclosed/);
    expect(() => rules('a { b: c } .pj-head { color: red')).toThrow(/unclosed/);
    expect(() => rules('.pj-head { color: red .sc { top: 0 }')).toThrow(/unclosed/);
    expect(rules(await sheet()).length).toBeGreaterThan(40);
  });

  it("names only the cards' and heads' own classes, or the sidebar under the flag", async () => {
    const own = /\.(sc|pg|pj|sb)(-[a-z0-9-]+)?\b|\[data-sidebar-ux\]/;
    const loose = rules(await sheet())
      .filter(r => !r.at.some(a => a.startsWith('@keyframes')))
      .flatMap(r => r.selectors)
      // The refresh root's own variables are the one rule with no class of ours.
      .filter(s => !own.test(s) && s !== ".chat-root[data-chrome='refresh']" && s !== "html[data-palette='light'] .chat-root[data-chrome='refresh']");
    expect(loose).toEqual([]);
  });

  it("lets a click on the chevron or a resting mark through to the head's fold", async () => {
    const all = rules(await sheet());
    const props = (selector: string) => all.filter(r => r.at.length === 0 && r.selectors.includes(selector)).map(r => r.body).join(';');
    const R = ".chat-root[data-chrome='refresh']";
    expect(props(`${R} .pj-over`)).toMatch(/pointer-events:\s*none/);
    expect(props(`${R} .pj-over > :not(.pj-chev)`)).toMatch(/pointer-events:\s*auto/);
    expect(props(`${R} .pj-folded-mark`)).toMatch(/pointer-events:\s*none/);
  });

  // Measured on the stack too (0 gaps over every scroll position, both ways); these pin what makes it so.
  it('sticks heads flush and hands them over with no gap: no list padding at the top, spacing inside the section', async () => {
    const all = rules(await sheet());
    const body = (selector: string) => all.filter(r => r.at.length === 0 && r.selectors.includes(selector)).map(r => r.body).join(';');
    const R = ".chat-root[data-chrome='refresh']";
    const UX = `${R} .chat-sidebar[data-sidebar-ux]`;
    expect(body(`${UX} .chat-projects`)).toMatch(/padding-top:\s*0/);
    expect(body(`${UX} .chat-projects > .chat-group`)).toMatch(/margin:\s*0;\s*padding:\s*0/);
    expect(body(`${UX} .chat-projects > .chat-group::after`)).toMatch(/height:\s*18px/);
    const head = body(`${R} .pj-head`);
    expect(head).toMatch(/position:\s*sticky;\s*top:\s*0/);
    expect(head).toMatch(/margin:\s*0/);
    expect(head).toMatch(/border-radius:\s*0/);
    expect(head).toMatch(/background:\s*var\(--sb-bg/);
    expect(body(`${R} .sb-dock`)).toMatch(/margin:\s*0/);
  });

  // the QA pass measured the stuck state, which was flush, not the change into it. The first section's 6 px
  // margin sat inside the scroller, so its head rested 6 px below the spot every head sticks to and jumped up 6 px on
  // the first scroll. Measured on the stack (Chromium and WebKit, DPR 1 and 2, 0.5 px steps): the first head now rests
  // at the list's top, at 0, and stays there. These pin what makes it so.
  it('rests the first head exactly where every head sticks: the space above the list is outside the scroller', async () => {
    const all = rules(await sheet());
    const UX = ".chat-root[data-chrome='refresh'] .chat-sidebar[data-sidebar-ux]";
    // Nothing inside the list may push the first section down from the list's top edge.
    const child = (s: string) => s.startsWith(`${UX} .chat-projects > `) && !/[\s>+~]/.test(s.slice(`${UX} .chat-projects > `.length));
    const inside = all.filter(r => r.at.length === 0 && r.selectors.some(child));
    expect(inside.length).toBeGreaterThan(0);
    for (const r of inside) expect(r.body, r.selectors.join(', ')).not.toMatch(/margin(-top)?:\s*(?!0[;\s]|0$)[\d.]+px/);
    expect(all.some(r => r.selectors.some(s => /\.chat-projects > [^,]*:first-(of-type|child)/.test(s)))).toBe(false);
    const list = all.filter(r => r.at.length === 0 && r.selectors.includes(`${UX} .chat-projects`)).map(r => r.body).join(';');
    expect(list).toMatch(/margin-top:\s*6px/);
    expect(list).toMatch(/padding-top:\s*0/);
  });

  // with a short or empty list the bottom row sat right under the last card. The list is a column and the row
  // takes the slack above it, so it's flush with the sidebar's bottom at any length; a long list scrolls under it.
  it('keeps the bottom row flush at the bottom however short the list is', async () => {
    const all = rules(await sheet());
    const body = (selector: string) => all.filter(r => r.at.length === 0 && r.selectors.includes(selector)).map(r => r.body).join(';');
    const R = ".chat-root[data-chrome='refresh']";
    const UX = `${R} .chat-sidebar[data-sidebar-ux]`;
    const list = body(`${UX} .chat-projects`);
    expect(list).toMatch(/display:\s*flex;\s*flex-direction:\s*column/);
    expect(body(`${UX} .chat-projects > *`)).toMatch(/flex:\s*none/);
    for (const end of ['.sb-dock', '.sb-end']) {
      const b = body(`${R} ${end}`);
      expect(b, end).toMatch(/margin-top:\s*auto/);
      expect(b, end).toMatch(/position:\s*sticky;\s*bottom:\s*0/);
      // The auto margin comes after the shorthand, or the shorthand would reset it.
      expect(b.lastIndexOf('margin-top'), end).toBeGreaterThan(b.lastIndexOf('margin:'));
    }
  });

  it('fades only past an edge, never in the way of a pointer', async () => {
    const all = rules(await sheet());
    const fades = all.filter(r => r.selectors.some(x => x.includes('[data-more-above]') || x.includes('[data-more-below]')));
    expect(fades.length).toBeGreaterThanOrEqual(2);
    for (const f of fades) expect(f.body).toMatch(/pointer-events:\s*none/);
  });

  // The head's fold also carries the old Projects view's .chat-projects-fold, which chrome.css styles later. At equal
  // weight those won: every head's name in the secondary grey, under brighter titles, and a 2 px ring on keyboard focus.
  it("outweighs chrome.css's old fold rules, so a head's name is strong and its focus is a fill", async () => {
    const fs = await import('node:fs' as string) as { readFileSync(path: URL, encoding: 'utf8'): string };
    const chrome = rules(fs.readFileSync(new URL('./chrome.css', import.meta.url), 'utf8')).filter(r => r.at.length === 0);
    const old = (prop: RegExp) => chrome.filter(r => prop.test(r.body)).flatMap(r => r.selectors)
      .filter(s => s.includes('.chat-projects-fold') && !s.includes(':hover'));
    const R = ".chat-root[data-chrome='refresh']";
    const mine = rules(await sheet()).filter(r => r.at.length === 0);
    const body = (selector: string) => mine.filter(r => r.selectors.includes(selector)).map(r => r.body).join(';');
    const name = `${R} .pj-head .pj-fold`;
    const focus = `${R} .pj-head .pj-fold:is(:focus-visible, [data-focus-visible])`;
    expect(body(name)).toMatch(/(^|;)\s*color:\s*var\(--text-primary\)/);
    expect(body(focus)).toMatch(/outline:\s*none/);
    const colours = old(/(^|;)\s*color:/);
    const rings = old(/outline:/);
    expect(colours.length).toBeGreaterThan(0);
    expect(rings.length).toBeGreaterThan(0);
    for (const s of colours) expect(heavier(name, s), s).toBe(true);
    for (const s of rings) expect(heavier(focus, s), s).toBe(true);
  });

  it('shows the hover controls on every pointer, not only inside a media query', async () => {
    const top = rules(await sheet()).filter(r => r.at.length === 0).flatMap(r => r.selectors);
    expect(top).toContain(".chat-root[data-chrome='refresh'] .pj-head:is(:hover, :focus-within) .pj-over");
    expect(top).toContain(".chat-root[data-chrome='refresh'] .sc-wrap:is(:hover, :focus-within) .sc-over");
    expect(top).toContain(".chat-root[data-chrome='refresh'] .chat-items .pj-over .chat-project-menu");
  });
});
