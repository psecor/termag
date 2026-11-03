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
const { default: CopyText, COPIED_MS } = await import('./CopyText');

let root: Root;
let host: HTMLDivElement;
let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'clipboard');
});

const line = (op: object) => JSON.stringify(op);
/** As JSONL patches, so the same spec can be drawn while its fence is still open (the surface locked). */
function draw(props: object, { locked = false } = {}) {
  const text = [
    line({ op: 'add', path: '/root', value: 's' }),
    line({ op: 'add', path: '/elements/s', value: { type: 'Stack', props: {}, children: ['c', 'x'] } }),
    line({ op: 'add', path: '/elements/c', value: { type: 'CopyText', props, children: [] } }),
    line({ op: 'add', path: '/elements/x', value: { type: 'Checkbox', props: { label: 'Other input' }, children: [] } }),
  ].join('\n');
  const block = { type: 'code' as const, lang: 'spec', text, open: locked };
  act(() => root.render(<GenUiSurface block={block} itemKey="r" streaming={locked} chat={null} fallback={null} />));
}
const button = () => host.querySelector('.genui-copytext button') as HTMLButtonElement;
const tooltip = () => document.querySelector('[role="tooltip"]');
const status = () => host.querySelector('.genui-copytext [role="status"]')?.textContent;

describe('CopyText', () => {
  it('takes a value up to 2000 characters and an optional label', () => {
    const ok = (p: object) => CopyText.props.safeParse(p).success;
    expect(ok({ value: 'git switch main' })).toBe(true);
    expect(ok({ value: 'x'.repeat(2000), label: 'Branch', code: false })).toBe(true);
    expect(ok({ value: '' })).toBe(false);
    expect(ok({ value: 'x'.repeat(2001) })).toBe(false);
    expect(ok({ value: 'ok', label: '' })).toBe(false);
  });

  it('shows the value in monospace by default, as text when code is false', () => {
    draw({ label: 'Branch', value: 'fix/titles' });
    expect(host.querySelector('.genui-bad')).toBeNull();
    expect(host.querySelector('code.genui-copytext-value')?.textContent).toBe('fix/titles');
    expect(host.querySelector('.genui-copytext')?.getAttribute('aria-labelledby')).toBe(host.querySelector('.genui-copytext-label')?.id);
    expect(button().getAttribute('aria-label')).toBe('Copy Branch');
    draw({ value: 'A plain sentence.', code: false });
    expect(host.querySelector('code')).toBeNull();
    expect(host.querySelector('.genui-copytext-value')?.textContent).toBe('A plain sentence.');
    expect(button().getAttribute('aria-label')).toBe('Copy');
  });

  it('copies the value, says Copied, then goes back to Copy', async () => {
    vi.useFakeTimers();
    draw({ label: 'Check it out', value: 'git fetch && git switch fix/titles' });
    await act(async () => { button().click(); });
    expect(writeText).toHaveBeenCalledWith('git fetch && git switch fix/titles');
    expect(status()).toBe('Copied');
    expect(tooltip()?.textContent).toBe('Copied');
    await act(async () => { vi.advanceTimersByTime(COPIED_MS); });
    expect(status()).toBe('');
    expect(tooltip()).toBeNull();
  });

  it('copies on a locked surface, where inputs are disabled', async () => {
    draw({ value: 'sdk-chat-3f9c2a71' }, { locked: true });
    expect(host.querySelector('.genui-surface[data-streaming]')).not.toBeNull();
    expect((host.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
    expect(button().disabled).toBe(false);
    await act(async () => { button().click(); });
    expect(writeText).toHaveBeenCalledWith('sdk-chat-3f9c2a71');
  });

  it('fails quietly when the clipboard refuses, or there is none', async () => {
    writeText.mockImplementation(() => Promise.reject(new Error('denied')));
    draw({ value: 'abc' });
    await act(async () => { button().click(); });
    expect(status()).toBe('');
    Reflect.deleteProperty(navigator, 'clipboard');
    await act(async () => { button().click(); });
    expect(status()).toBe('');
    expect(host.querySelector('.genui-bad')).toBeNull();
  });
});
