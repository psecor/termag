// A tab's X sits right of its ⋮ (OpenItems.tsx), so the ⋮ always stands left of where it did, and the
// row makes room for both whenever the ⋮ shows. The ⋮ shows on hover, on focus in the row, and while
// its menu is open, which takes focus out of the row into the portaled menu (Bugbot on #1024), so the
// rules that make that room cover all three. jsdom does no layout, so this pins the selectors.
import { describe, expect, it } from 'vitest';

async function read(name: string): Promise<string> {
  const fs = await import('node:fs' as string) as { readFileSync(path: URL, encoding: 'utf8'): string };
  return fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** A selector list split at its top-level commas (not the ones inside :is() or :has()). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth--;
    else if (list[i] === ',' && depth === 0) { out.push(list.slice(from, i)); from = i + 1; }
  }
  return [...out, list.slice(from)];
}

/** Every selector in the sheet that names a closable row in a state (`.chat-item-closable:`). */
async function stateSelectors(name: string): Promise<string[]> {
  const css = await read(name);
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{/g)) {
    for (const sel of splitSelectors(m[1])) {
      const s = sel.replace(/\s+/g, ' ').trim();
      if (s.includes('.chat-item-closable:')) out.push(s);
    }
  }
  return out;
}

const SHOWN = ".chat-item-closable:is(:hover, :focus-within, :has(> .chat-item-menu[aria-expanded='true']))";

describe("the room a tab's ⋮ and X take", () => {
  for (const name of ['chat.css', 'chrome.css']) {
    it(`${name}: makes it on hover, focus and while the ⋮'s menu is open`, async () => {
      const sels = await stateSelectors(name);
      expect(sels.length).toBeGreaterThan(0);
      for (const s of sels) expect(s).toContain(SHOWN);
    });
  }
});
