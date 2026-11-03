// The sidebar's groups under the chrome refresh, as the mock drew them:
// a quiet head whose caret
// and ⋮ show on hover or keyboard focus (and the ⋮ always on a touch screen),
// no rail down a space, and roomier rows. jsdom does no layout or hover, so
// this pins the rules in chrome.css that do it; checked in Chromium on the e2e
// stack. It also holds every rule in the file to the refresh's scope, which is
// what keeps the simple UI unchanged with the flag off.
import { describe, expect, it } from 'vitest';

/** chrome.css as shipped (node:fs through a dynamic import: this package has no node typings). */
async function sheet(): Promise<string> {
  const fs = await import('node:fs' as string) as { readFileSync(path: URL, encoding: 'utf8'): string };
  return fs.readFileSync(new URL('./chrome.css', import.meta.url), 'utf8');
}

interface Rule { selectors: string[]; body: string; at: string[] }

/** A selector list split at its top-level commas (not the ones inside :is()). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth--;
    else if (list[i] === ',' && depth === 0) { out.push(list.slice(from, i)); from = i + 1; }
  }
  out.push(list.slice(from));
  return out.map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Every style rule, with the at-rules (@media, @container, @keyframes) it sits in. */
function rules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const at: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      const prelude = text.slice(start, i).trim();
      if (prelude.startsWith('@')) {
        at.push(prelude.replace(/\s+/g, ' '));
        start = i + 1;
        continue;
      }
      const end = text.indexOf('}', i);
      out.push({ selectors: splitSelectors(prelude), body: text.slice(i + 1, end), at: [...at] });
      i = end;
      start = end + 1;
    } else if (text[i] === '}') {
      at.pop();
      start = i + 1;
    }
  }
  return out;
}

const R = ".chat-root[data-chrome='refresh']";

/** The declarations of every rule listing `selector`, in `media` (or outside any at-rule), joined in file order. */
function decls(all: Rule[], selector: string, media: string | null = null): string {
  return all
    .filter(r => r.selectors.includes(selector) && (media === null ? r.at.length === 0 : r.at.includes(media)))
    .map(r => r.body)
    .join(';');
}

/** The last value `prop` gets in `body`, as the cascade would leave it. */
function value(body: string, prop: string): string | null {
  const all = [...body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, 'g'))];
  return all.length ? all[all.length - 1][1].trim() : null;
}

describe('chrome.css', () => {
  it("keys every rule on the refresh's root or LaunchPad's theme class, so nothing applies with the flag off", async () => {
    const selectors = rules(await sheet())
      .filter(r => !r.at.some(a => a.startsWith('@keyframes')))
      .flatMap(r => r.selectors);
    expect(selectors.length).toBeGreaterThan(200);
    // LaunchPad's overlays sit outside the root, so the palette reaches them only while a refreshed chat is on screen.
    expect(selectors.filter(s => !s.startsWith(R) && !s.startsWith('.lp-theme') && !s.startsWith(`:root:has(${R}) .lp-theme`)
      // The light palette's copies of the two, still keyed on the refresh's root.
      && !s.startsWith(`html[data-palette='light'] ${R}`) && !s.startsWith(`html[data-palette='light']:has(${R}) .lp-theme`))).toEqual([]);
  });

  it("gives the refresh LaunchPad's dark greys and Inter, on its root and on LaunchPad's overlays alike", async () => {
    const all = rules(await sheet());
    const root = decls(all, R);
    // Every overlay but the sidebar's item menu, which keeps termag's own palette (ContextMenu.tsx).
    const overlays = decls(all, `:root:has(${R}) .lp-theme:not(.chat-ctx-popover)`);
    for (const body of [root, overlays]) {
      expect(value(body, '--bg-base')).toBe('#181a1f');
      expect(value(body, '--bg-elevated')).toBe('#23252a');
      expect(value(body, '--text-primary')).toBe('#eceff2');
      expect(value(body, '--accent')).toBe('#7084ff');
      expect(value(body, '--font-ui')).toMatch(/^Inter, /);
      // :root derives these from the palette; a var() resolves where it is declared, so they are derived again.
      expect(value(body, '--status-working')).toBe('var(--success)');
      expect(value(body, '--status-off')).toBe('var(--text-muted)');
    }
    expect(value(root, '--chrome-window')).toBe('#101114');
  });
});

describe('the sidebar groups under the chrome refresh', () => {
  it("hides a space head's caret and ⋮ until the head is hovered or has focus, or its menu is open", async () => {
    const all = rules(await sheet());
    expect(value(decls(all, `${R} .chat-items .chat-group-head .chat-group-caret`), 'opacity')).toBe('0');
    expect(value(decls(all, `${R} .chat-items .chat-group-menu`), 'opacity')).toBe('0');
    for (const shown of [
      `${R} .chat-items .chat-group-head:is(:hover, :focus-within) :is(.chat-group-caret, .chat-group-menu)`,
      `${R} .chat-items .chat-group-menu[aria-expanded='true']`,
      // A folded space keeps its caret, turned, so it says it is folded.
      `${R} .chat-items .chat-group[data-folded] .chat-group-head .chat-group-caret`,
    ]) expect(value(decls(all, shown), 'opacity'), shown).toBe('1');
  });

  it('always shows the ⋮ on a touch screen, where nothing hovers, and gives a finger 44px', async () => {
    const all = rules(await sheet());
    expect(value(decls(all, `${R} .chat-items .chat-group-menu`, '@media (hover: none)'), 'opacity')).toBe('1');
    const coarse = decls(all, `${R} .chat-items .chat-group-menu`, '@media (pointer: coarse)');
    expect(value(coarse, 'width')).toBe('44px');
    expect(value(coarse, 'height')).toBe('44px');
    expect(value(decls(all, `${R} .chat-item`, '@media (pointer: coarse)'), 'height')).toBe('44px');
    expect(value(decls(all, `${R} .chat-item-li .item-menu-btn`, '@media (pointer: coarse)'), 'width')).toBe('44px');
    // A one-line Standard row is as tall as its 44px ⋮, and the ⋮ sits at its top, so it never covers the next row
    // (Bugbot on #876). These rules carry .chat-items, so they outrank the Standard rules that come later in the file.
    expect(value(decls(all, `${R} .chat-items .chat-item[data-density='standard']`, '@media (pointer: coarse)'), 'min-height')).toBe('44px');
    expect(value(decls(all, `${R} .chat-items .chat-item[data-density='standard'] + .item-menu-btn`, '@media (pointer: coarse)'), 'top')).toBe('0');
  });

  it("names a space at a normal weight, in the secondary colour, with its count beside the name", async () => {
    const all = rules(await sheet());
    expect(value(decls(all, `${R} .chat-items .chat-group-name`), 'font-weight')).toBe('500');
    expect(value(decls(all, `${R} .chat-items .chat-group-name`), 'flex')).toBe('0 1 auto');
    expect(value(decls(all, `${R} .chat-items .chat-group-toggle`), 'color')).toBe('var(--text-secondary)');
    expect(value(decls(all, `${R} .chat-items .chat-group-toggle:hover`), 'background')).toBe('none');
  });

  it('draws no rail down a space and no indent under its head', async () => {
    const all = rules(await sheet());
    const list = decls(all, `${R} .chat-items .chat-group-list`);
    expect(value(list, 'border-left')).toBe('none');
    expect(value(list, 'margin')).toBe('0');
    expect(value(list, 'padding')).toBe('0');
  });

  it("makes the rows and the gaps between spaces the mock's, and lines a file's icon up with the state marks", async () => {
    const all = rules(await sheet());
    expect(value(decls(all, `${R} .chat-item`), 'height')).toBe('34px');
    expect(value(decls(all, `${R} .chat-group + .chat-group`), 'margin-top')).toBe('14px');
    expect(value(decls(all, `${R} .chat-status-mark`), 'width')).toBe('20px');
    expect(value(decls(all, `${R} .chat-items .chat-item-icon`), 'width')).toBe('20px');
    expect(value(decls(all, `${R} .chat-item[data-density='standard']`), 'min-height')).toBe('34px');
  });
});

// The screenshot this answers (2026-10-29): the caret hung in the gutter left of the swatch, and a
// nested row's highlight started 14px in, so the tree read as a stray triangle and a ragged edge.
describe("a session's agents as a tree under the chrome refresh", () => {
  const row = `${R} .chat-items .chat-tree-li > .chat-item`;
  const twisty = `${R} .chat-items .chat-item-li.chat-tree-li > .chat-twisty`;

  it('spans a nested row across the list and steps its mark and name in 16px a level instead', async () => {
    const body = decls(rules(await sheet()), row);
    expect(value(body, 'margin-left')).toBe('0');
    expect(value(body, 'padding-left')).toBe('calc(8px + var(--chat-depth) * 16px)');
  });

  it("draws a guide under each ancestor's mark, as an image the row's hover and active fills don't reset", async () => {
    const all = rules(await sheet());
    const body = decls(all, row);
    // A line at the start of every 16px, one per level, from the centre of a depth-0 mark (8px + 20px / 2).
    expect(value(body, 'background-image')).toBe('repeating-linear-gradient(to right, var(--chrome-tree-guide) 0 1px, transparent 1px 16px)');
    expect(value(body, 'background-size')).toBe('calc(var(--chat-depth) * 16px) 100%');
    expect(value(body, 'background-position')).toBe('17.5px 0');
    expect(value(body, 'background-repeat')).toBe('no-repeat');
    expect(value(decls(all, R), '--chrome-tree-guide')).toMatch(/^color-mix\(/);
    // The fills are shorthands, which reset the image; this selector outranks them (one class more).
    expect(value(decls(all, `${R} .chat-item:hover`), 'background')).toBe('var(--chrome-row-hover)');
    expect(value(decls(all, `${R} .chat-item.active`), 'background')).toBe('var(--chrome-row-active)');
  });

  it("puts a parent's caret in its mark's place, hidden at rest while the mark has something to show", async () => {
    const all = rules(await sheet());
    const body = decls(all, twisty);
    expect(value(body, 'left')).toBe('calc(8px + var(--chat-depth) * 16px)');
    expect(value(body, 'top')).toBe('7px');
    expect(value(body, 'width')).toBe('20px');
    expect(value(body, 'height')).toBe('20px');
    expect(value(body, 'opacity')).toBe('0');
    for (const shown of [
      `${R} .chat-items .chat-tree-li:has(> .chat-item > .chat-status-mark:empty) > .chat-twisty`,
      `${R} .chat-items .chat-tree-li:is(:hover, :has(:focus-visible)) > .chat-twisty`,
    ]) expect(value(decls(all, shown), 'opacity'), shown).toBe('1');
    // Shown over a mark, the caret takes its place rather than sitting on top of a spinner.
    expect(value(decls(all, `${R} .chat-items .chat-tree-li:has(> .chat-twisty):is(:hover, :has(:focus-visible)) > .chat-item > .chat-status-mark`), 'visibility')).toBe('hidden');
    expect(value(decls(all, `${R} .chat-items .chat-tree-li:has(> .chat-item[data-density='standard']) > .chat-twisty`), 'top')).toBe('9px');
  });

  it("gives a finger the mark's whole column at the row's height, with the caret where the mark is", async () => {
    const coarse = decls(rules(await sheet()), twisty, '@media (pointer: coarse)');
    expect(value(coarse, 'left')).toBe('calc(var(--chat-depth) * 16px)');
    expect(value(coarse, 'width')).toBe('36px');
    expect(value(coarse, 'height')).toBe('44px');
    expect(value(coarse, 'top')).toBe('0');
    // Bugbot on #1014: the Standard rule's 9px outranks that top: 0 (its :has() counts), so a Standard row's says it again.
    const standard = decls(rules(await sheet()), `${R} .chat-items .chat-tree-li:has(> .chat-item[data-density='standard']) > .chat-twisty`, '@media (pointer: coarse)');
    expect(value(standard, 'top')).toBe('0');
    expect(value(standard, 'height')).toBe('38px');
  });

  it("lines an automation's Show all up with its runs' names", async () => {
    const body = decls(rules(await sheet()), `${R} .chat-items .chat-tree-li > .chat-item.chat-runs-all`);
    expect(value(body, 'padding-left')).toBe('calc(38px + var(--chat-depth) * 16px)');
  });

  it("sets a folded parent's count right after its name, as a space's head does", async () => {
    const all = rules(await sheet());
    expect(value(decls(all, `${R} .chat-items .chat-item-folded`), 'margin-right')).toBe('auto');
    expect(value(decls(all, `${R} .chat-items :is(.chat-item, .chat-item-top):has(> .chat-item-folded) > .chat-item-name`), 'flex')).toBe('0 1 auto');
  });

});
