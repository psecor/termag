// On a phone every field in the simple UI is 16px so iOS does not zoom into it on focus, now that
// /chat lifts the zoom lock there (hooks/useZoomableViewport.ts). jsdom does no layout or media
// queries, so this pins the rule: phone-gated, on <html>'s marker (portalled menus and dialogs
// sit outside .chat-root), covering text inputs, textareas and selects but not xterm's helper.
import { describe, expect, it } from 'vitest';

async function read(name: string): Promise<string> {
  const fs = await import('node:fs' as string) as { readFileSync(path: URL, encoding: 'utf8'): string };
  return fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

describe("the simple UI's phone fields", () => {
  it('are 16px at a phone width with a coarse pointer, everywhere under html[data-simple-ui]', async () => {
    const css = await read('chat.css');
    const at = css.indexOf('@media (max-width: 767px) and (pointer: coarse)');
    expect(at).toBeGreaterThan(-1);
    const rule = /html\[data-simple-ui\]\s*:is\(([\s\S]*?)\)\s*\{([^}]*)\}/.exec(css.slice(at));
    expect(rule).not.toBeNull();
    const [, targets, body] = rule!;
    expect(body).toMatch(/font-size:\s*16px\s*!important/);
    expect(targets).toMatch(/(^|\s)input:not\(/);
    expect(targets).toMatch(/textarea:not\(\.xterm-helper-textarea\)/);
    expect(targets).toMatch(/(^|,)\s*select\s*$/m);
    // Toggles and buttons are not text fields.
    for (const t of ['checkbox', 'radio', 'range', 'button', 'submit']) expect(targets).toContain(`[type='${t}']`);
  });
});
