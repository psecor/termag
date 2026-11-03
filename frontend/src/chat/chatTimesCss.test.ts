// A call's and a run's times (pages/chat/ChatTimes.tsx)
// are laid over the right of the head row and fade in on hover, so showing
// them moves nothing; only a running call's live counter always shows. jsdom
// does no layout, so this pins the rules in pages/chat/chat.css that do it;
// checked in Chromium (the PR's screenshots).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../pages/chat/chat.css'), 'utf8');
/** The declarations of the first rule whose selector list is exactly `selector`, anchored to a line start. */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|\\n|\\})${esc}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? m[2] : '';
}

describe('chat times', () => {
  const slot = rule('.sdk-tool-time, .sdk-run-time');

  it('takes no room in the row: absolutely placed in a positioned head', () => {
    expect(slot).toMatch(/position:\s*absolute/);
    expect(rule('.sdk-tool-head, .sdk-run-head')).toMatch(/position:\s*relative/);
    expect(slot).toMatch(/white-space:\s*nowrap/);
  });

  it('is quiet: muted, small, hidden until hover, except the live counter', () => {
    expect(slot).toMatch(/color:\s*var\(--text-muted\)/);
    expect(slot).toMatch(/font-size:\s*11px/);
    expect(slot).toMatch(/opacity:\s*0/);
    const shown = /([^}]*)\{\s*opacity:\s*1;\s*\}/g;
    const selectors = [...css.matchAll(shown)].map(m => m[1]).find(s => s.includes('.sdk-tool-time[data-live]')) ?? '';
    expect(selectors).toMatch(/\.sdk-tool:hover \.sdk-tool-time/);
    expect(selectors).toMatch(/\.sdk-run-head:hover \.sdk-run-time/);
  });

  it('is in the UI font, not monospace', () => {
    expect(slot).not.toMatch(/font-mono/);
    expect(rule('.sdk-reply-meta')).not.toMatch(/font-mono/);
  });
});
