// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autoGrowHeight, COMPOSER_MAX_ROWS, useAutoGrow } from './useAutoGrow';

describe('autoGrowHeight', () => {
  const m = { lineHeight: 20, paddingY: 20, borderY: 2, maxRows: 8 };

  it('fits the content while it is under the cap', () => {
    expect(autoGrowHeight({ ...m, scrollHeight: 40 })).toEqual({ height: 42, scroll: false });
    expect(autoGrowHeight({ ...m, scrollHeight: 20 * 5 + 20 })).toEqual({ height: 122, scroll: false });
  });

  it('stops at maxRows lines and scrolls past them', () => {
    expect(autoGrowHeight({ ...m, scrollHeight: 20 * 8 + 20 })).toEqual({ height: 182, scroll: false });
    expect(autoGrowHeight({ ...m, scrollHeight: 20 * 30 + 20 })).toEqual({ height: 182, scroll: true });
  });

  it('caps the composer at a few lines, not two', () => {
    expect(COMPOSER_MAX_ROWS).toBeGreaterThanOrEqual(6);
    expect(COMPOSER_MAX_ROWS).toBeLessThanOrEqual(8);
  });
});

// jsdom has no layout: scrollHeight follows the number of lines in the value.
function Harness({ value }: { value: string }) {
  const ref = useAutoGrow<HTMLTextAreaElement>(value);
  return <textarea ref={ref} value={value} readOnly style={{ lineHeight: '20px', padding: '10px 12px', border: '1px solid' }} />;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement) { return this.value.split('\n').length * 20 + 20; },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
});

describe('useAutoGrow', () => {
  it('grows the textarea with each line, then holds at the cap and scrolls', () => {
    const el = () => host.querySelector('textarea')!;
    act(() => root.render(<Harness value="one line" />));
    expect(el().style.height).toBe('42px');
    expect(el().style.overflowY).toBe('hidden');

    act(() => root.render(<Harness value={'a\nb\nc\nd'} />));
    expect(el().style.height).toBe('102px');

    act(() => root.render(<Harness value={Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')} />));
    expect(el().style.height).toBe(`${20 * COMPOSER_MAX_ROWS + 20 + 2}px`);
    expect(el().style.overflowY).toBe('auto');

    act(() => root.render(<Harness value="" />));
    expect(el().style.height).toBe('42px');
  });
});
