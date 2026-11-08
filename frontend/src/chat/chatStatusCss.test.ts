// The status line over the composer ("Thinking…", "Running Bash · <command>")
// changes at every step of a turn. A line that wrapped when it was long and
// unwrapped when it was short moved the composer, and the transcript above it,
// at each change. jsdom does no layout, so this pins the rules in
// pages/chat/chat.css that keep it one line at every width; checked in
// Chromium at 480 px and desktop width.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../pages/chat/chat.css'), 'utf8');

/** Every rule (in any media query) whose selector list names `.chat-status` itself, not `.chat-status-*`. */
function statusRules(): string[] {
  return [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(',').some(s => /\.chat-status(?![\w-])/.test(s)))
    .map(m => m[2]);
}

describe('the chat status line', () => {
  it('is one line, cut with an ellipsis', () => {
    const base = statusRules().find(d => /font-size/.test(d)) ?? '';
    expect(base).toMatch(/white-space:\s*nowrap/);
    expect(base).toMatch(/overflow:\s*hidden/);
    expect(base).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('never wraps at a narrower width', () => {
    expect(statusRules().length).toBeGreaterThan(0);
    for (const d of statusRules()) expect(d).not.toMatch(/white-space:\s*(normal|pre-wrap|pre-line|break-spaces)/);
  });
});
