// A tab page's back arrow (TabClose.tsx) is the same button as Reload (`btn-ghost fv-icon-btn`, a 14px
// icon) at the left of the header, before its title, so those classes alone size and style it: no rule
// names it. `.fv-icon-btn` is 32px tall, the chrome refresh's header buttons' height (the Tools toggle,
// the session ⋯), so Reload, Download and the arrow are that tall whatever else is in their row, and a
// touch screen's 44px comes after it. jsdom does no layout, so this pins the rules; the sizes were
// measured in Chromium (PR #1271).
import { describe, expect, it } from 'vitest';

async function read(name: string): Promise<string> {
  const fs = await import('node:fs' as string) as { readFileSync(path: URL, encoding: 'utf8'): string };
  return fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

const rules = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1].replace(/\s+/g, ' ').trim(), body: m[2].trim(), at: m.index ?? 0 }));
const decl = (body: string, prop: string) => new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(body)?.[1].trim();

describe("a tab page's back arrow", () => {
  it.each(['chat.css', 'chrome.css'])('has no rule of its own in %s, nor the X it replaces', async name => {
    expect(rules(await read(name)).filter(r => /chat-page-(back|close)/.test(r.selector))).toEqual([]);
  });

  it("is as tall as the refresh's header buttons, by .fv-icon-btn, and 44px on a touch screen", async () => {
    const chat = await read('chat.css');
    const icon = rules(chat).find(r => r.selector === '.fv-icon-btn')!;
    const refresh = rules(await read('chrome.css')).find(r => r.selector.includes('.chat-side-toggle') && /(^|;)\s*height:/.test(r.body))!;
    expect(decl(icon.body, 'min-height')).toBe(decl(refresh.body, 'height'));
    const coarse = chat.indexOf('@media (pointer: coarse)');
    const touch = rules(chat).find(r => r.at > coarse && r.selector.split(',').map(x => x.trim()).includes('.fv-icon-btn'))!;
    expect(decl(touch.body, 'min-height')).toBe('44px');
    expect(touch.at).toBeGreaterThan(icon.at);
  });
});
