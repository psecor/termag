// The person on #743: nested rows stay one line. jsdom does no layout, so this pins the
// chat.css rules that keep a nested sidebar row (.chat-row-compact) and a nested tab one line.
import { describe, expect, it } from 'vitest';

/** chat.css as shipped (node:fs through a dynamic import: this package has no node typings). */
async function css(): Promise<string> {
  const fs = await import('node:fs' as string) as { readFileSync(path: URL, encoding: 'utf8'): string };
  return fs.readFileSync(new URL('./chat.css', import.meta.url), 'utf8');
}

/** The rule whose selector starts a line, from its brace to the next. */
const rule = (sheet: string, selector: string) => {
  const at = sheet.indexOf(`\n${selector} {`);
  return at < 0 ? null : sheet.slice(at + 1, sheet.indexOf('}', at) + 1);
};

describe('compact nested rows', () => {
  it('keeps a nested sidebar row to one cut line, like a tab', async () => {
    const sheet = await css();
    expect(rule(sheet, '.chat-row.chat-row-compact')).toMatch(/padding-top: 4px; padding-bottom: 4px;/);
    expect(rule(sheet, '.chat-row-name')).toMatch(/white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/);
    expect(rule(sheet, '.chat-row-compact .chat-row-folded')).toMatch(/flex-shrink: 0/);
  });

  it('keeps a tab, nested or not, one fixed-height line', async () => {
    const sheet = await css();
    expect(rule(sheet, '.chat-item')).toMatch(/height: 28px; box-sizing: border-box;/);
    expect(rule(sheet, '.chat-tree-li > .chat-item')).toMatch(/margin-left: calc\(var\(--chat-depth\) \* 14px\)/);
  });
});
