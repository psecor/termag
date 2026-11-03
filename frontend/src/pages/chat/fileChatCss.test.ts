// jsdom does no layout: the rules that keep the file composer from covering
// the file, checked against the stylesheet itself (fileChat.css).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./fileChat.css', import.meta.url), 'utf8');
const rule = (selector: string) => {
  const m = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm').exec(css);
  return m ? m[1] : '';
};

describe('fileChat.css', () => {
  it('keeps the composer in the column under the file, not over it', () => {
    expect(rule('.fv-chat-host')).toContain('flex-shrink: 0');
    expect(rule('.fv-chat-host')).not.toMatch(/position:\s*(absolute|fixed)/);
    expect(rule('.fv-chat')).not.toMatch(/position:\s*(absolute|fixed)/);
    // The conversation's muted viewing line.
    expect(css).toMatch(/\.sdk-user-bubble \.sdk-user-context \{[^}]*opacity: 0\.68/);
    // No fade drawn over the file's last lines.
    expect(rule('.fv-chat::before')).toContain('display: none');
  });

  it('keeps everything above the box to one line of fixed height that never grows', () => {
    const line = rule('.fv-chat-line');
    expect(line).toContain('height: 26px');
    expect(line).toContain('white-space: nowrap');
    expect(line).toContain('overflow: hidden');
    expect(line).not.toMatch(/max-height|min-height|transition|animation/);
    // The agent's name is cut first, at about 16 characters, so the status and Open stay in view.
    expect(rule('.fv-chat-line-name')).toContain('max-width: 16ch');
    expect(rule('.fv-chat-line-name')).toContain('text-overflow: ellipsis');
    expect(rule('.fv-chat-line-name')).toMatch(/flex: 0 100 auto/);
    expect(rule('.fv-chat-line-status')).toContain('text-overflow: ellipsis');
    expect(rule('.fv-chat-line-status')).toContain('min-width: 9ch');
    expect(rule('.fv-chat-open')).toContain('flex-shrink: 0');
    // The growing reply strip and the To chip are gone.
    expect(css).not.toMatch(/\.fv-chat-reply|\.fv-chat-to\b/);
  });

  it('makes the agent picker a small button in the bar, not a chip', () => {
    expect(rule('.fv-chat .fv-chat-agent')).toContain('height: 24px');
    expect(rule('.fv-chat .fv-chat-agent')).toContain('flex-shrink: 0');
  });

  it('gives LaunchPad termag\'s colours, also on what it draws in a portal', () => {
    expect(css).toMatch(/^\.fv-lp, \.fv-chat \{[^}]*--lp-color-bg-overlay-secondary: var\(--bg-elevated\)/m);
    expect(css).toMatch(/^\.fv-lp, \.fv-chat \{[^}]*font-family: var\(--font-ui\)/m);
  });

  it('styles a compose link as an action inside the file, not as a link', () => {
    expect(rule('.fv-md .md-compose')).toContain('cursor: pointer');
    expect(rule('.fv-md .md-compose')).toContain('border-radius: 999px');
    // In a narrow table column the label must not break letter by letter.
    expect(rule('.fv-md .md-compose')).toContain('white-space: nowrap');
    expect(rule('.fv-md .md-compose')).not.toContain('overflow-wrap: anywhere');
  });
});
