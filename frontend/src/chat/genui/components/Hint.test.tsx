// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
// React Aria's overlays read a CSP nonce through CSS.escape, which jsdom lacks.
const css = globalThis as { CSS?: { escape?: (s: string) => string } };
css.CSS ??= {};
css.CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
const { default: GenUiSurface } = await import('../GenUiSurface');
const { default: Hint, HINT_LABEL } = await import('./Hint');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function draw(props: object) {
  const text = JSON.stringify({ root: 'h', elements: { h: { type: 'Hint', props, children: [] } } });
  const block = { type: 'code' as const, lang: 'spec', text, open: false };
  act(() => root.render(<GenUiSurface block={block} itemKey="r" streaming={false} chat={null} fallback={null} />));
}
const button = () => host.querySelector('.genui-hint button') as HTMLButtonElement;
const tooltip = () => document.querySelector('[role="tooltip"]');

describe('Hint', () => {
  it('takes a short text and an optional label', () => {
    const ok = (p: object) => Hint.props.safeParse(p).success;
    expect(ok({ text: 'Counted from status hooks.' })).toBe(true);
    expect(ok({ text: 'Counted from status hooks.', label: 'About working time' })).toBe(true);
    expect(ok({ text: '' })).toBe(false);
    expect(ok({ text: 'x'.repeat(301) })).toBe(false);
    expect(ok({ text: 'ok', label: '' })).toBe(false);
  });

  it('is an info button named by its label, described by its text', () => {
    draw({ text: 'Idle and waiting time are left out.' });
    expect(host.querySelector('.genui-bad')).toBeNull();
    expect(button().getAttribute('aria-label')).toBe(HINT_LABEL);
    expect(document.getElementById(button().getAttribute('aria-describedby')!)?.textContent).toBe('Idle and waiting time are left out.');
    expect(tooltip()).toBeNull();
    draw({ text: 'Idle time is left out.', label: 'About working time' });
    expect(button().getAttribute('aria-label')).toBe('About working time');
  });

  it('shows its text in a tooltip on a press, and hides it on the next', async () => {
    draw({ text: 'Idle and waiting time are left out.' });
    await act(async () => { button().click(); });
    expect(tooltip()?.textContent).toBe('Idle and waiting time are left out.');
    expect(tooltip()?.closest('.genui-layer')).not.toBeNull();
    await act(async () => { button().click(); });
    expect(tooltip()).toBeNull();
  });
});
