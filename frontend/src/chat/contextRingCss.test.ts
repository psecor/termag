// The context popover (chat/ContextRing.tsx) is a fixed 272 px wide and must not
// grow or shrink as its numbers change: every
// row is one line, a long label ends in an ellipsis (its full text is its
// tooltip), and a value never shrinks. jsdom does no layout, so this pins the
// rules in pages/chat/chat.css that do it; checked in Chromium with
// "This chat · $123.45 since cleared" / "$1234.56".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../pages/chat/chat.css'), 'utf8');
/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|\\n|\\})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? m[2] : '';
}

describe('context popover rows', () => {
  it('keeps a row to one line, the label cut with an ellipsis and the value whole', () => {
    expect(rule('.chat-ring-row')).toMatch(/white-space:\s*nowrap/);
    const label = rule('.chat-ring-row-label');
    expect(label).toMatch(/overflow:\s*hidden/);
    expect(label).toMatch(/text-overflow:\s*ellipsis/);
    expect(label).toMatch(/min-width:\s*0/);
    expect(rule('.chat-ring-row b')).toMatch(/flex-shrink:\s*0/);
  });

  it('keeps the sub line and the notes to one line too', () => {
    for (const sel of ['.chat-ring-sub', '.chat-ring-note']) {
      const r = rule(sel);
      expect(r, sel).toMatch(/white-space:\s*nowrap/);
      expect(r, sel).toMatch(/text-overflow:\s*ellipsis/);
    }
  });
});

const appCss = readFileSync(join(__dirname, '../App.css'), 'utf8');
const decl = (body: string, prop: string) => new RegExp(`(^|;|\\s)${prop}:\\s*([^;]+)`).exec(body)?.[2].trim() ?? null;

describe('context action buttons: one enabled look, one disabled look (review on #738)', () => {
  it('shows an enabled button in btn-tiny\'s own hover look at rest, so hovering adds no third look', () => {
    const hover = /(?:^|\n)\.btn-tiny:hover\s*\{([^}]*)\}/.exec(appCss)?.[1] ?? '';
    const enabled = rule('.chat-ring-actions .btn-tiny:not(:disabled), .sdk-divider .btn-tiny:not(:disabled)');
    expect(enabled, 'the enabled rule').not.toBe('');
    expect(decl(enabled, 'color')).toBe(decl(hover, 'color'));
    expect(decl(enabled, 'border-color')).toBe(decl(hover, 'border-color'));
  });

  it('keeps a disabled button in btn-tiny\'s resting colours even under the pointer (btn-tiny:hover would brighten it: a third look)', () => {
    const rest = /(?:^|\n)\.btn-tiny\s*\{([^}]*)\}/.exec(appCss)?.[1] ?? '';
    const disabled = rule('.chat-ring-actions .btn-tiny:disabled, .sdk-divider .btn-tiny:disabled');
    expect(disabled, 'the disabled rule').not.toBe('');
    expect(decl(disabled, 'color')).toBe(decl(rest, 'color'));
    expect(decl(disabled, 'border-color')).toBeTruthy();
    expect(decl(rest, 'border')).toContain(decl(disabled, 'border-color')!);
    // The opacity stays btn-tiny:disabled's own.
    expect(decl(disabled, 'opacity')).toBeNull();
  });
});
