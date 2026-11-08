// @vitest-environment jsdom
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { RestartNotice } from './RestartNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function show(el: React.ReactElement): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

const line = '[termag] Claude Code was updated to 2.1.320 (automatic nightly run); resuming your session.';

describe('RestartNotice', () => {
  it('is the notice\'s own text, as one line, with when', () => {
    const el = show(<RestartNotice notice={{ id: 'n1', kind: 'tool-update', pane: 'agent', text: line, at: '2026-11-04T03:12:00.000Z' }} />);
    const row = el.querySelector('.chat-restart-notice')!;
    expect(row.getAttribute('role')).toBe('note');
    expect(row.textContent).toContain(line);
    expect(row.querySelector('time')!.getAttribute('dateTime')).toBe('2026-11-04T03:12:00.000Z');
    expect(row.textContent).not.toContain('side terminal');
  });

  it('says where it was printed when that was another pane of the session', () => {
    const el = show(<RestartNotice notice={{ id: 'n1', kind: 'tool-update', pane: 'ctrl', text: line, at: '2026-11-04T03:12:00.000Z' }} />);
    expect(el.textContent).toContain('(in the side terminal)');
  });

  it('is a note without the divider\'s rules for another pane\'s restart', () => {
    const el = show(<RestartNotice side notice={{ id: 'n1', kind: 'tool-update', pane: 'ctrl', text: line, at: '2026-11-04T03:12:00.000Z' }} />);
    expect(el.querySelector('.chat-restart-notice')!.hasAttribute('data-side')).toBe(true);
    const css = readFileSync(join(__dirname, '../pages/chat/chat.css'), 'utf8');
    expect(css).toMatch(/\.chat-restart-notice\[data-side\]::before, \.chat-restart-notice\[data-side\]::after \{ content: none; \}/);
  });

  it('is in the UI font, never monospace', () => {
    const css = readFileSync(join(__dirname, '../pages/chat/chat.css'), 'utf8');
    const rules = css.split('}').filter(r => r.includes('.chat-restart-notice'));
    expect(rules.some(r => r.includes('font-family: var(--font-ui)'))).toBe(true);
    expect(rules.some(r => r.includes('--font-mono'))).toBe(false);
  });
});
