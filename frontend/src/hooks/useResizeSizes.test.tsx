// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ instancesApi: {} as Record<string, unknown> }));
vi.mock('../services/api', () => ({ instancesApi: mocks.instancesApi }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let el: HTMLDivElement;
beforeEach(() => {
  vi.resetModules();
  for (const k of Object.keys(mocks.instancesApi)) delete mocks.instancesApi[k];
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

async function render() {
  const { useResizeSizes } = await import('./useBoxResize');
  function Label() {
    const sizes = useResizeSizes('b1');
    return <span>{sizes ? sizes.map(s => s.size).join(',') : 'none'}</span>;
  }
  await act(async () => root.render(<Label />));
  await act(async () => { await Promise.resolve(); });
}

describe("useResizeSizes: the menu label's size table", () => {
  it('reads the sizes from the box\'s resize info', async () => {
    mocks.instancesApi.resizeInfo = vi.fn().mockResolvedValue({ sizes: [{ size: 'small' }, { size: 'medium' }] });
    await render();
    expect(el.textContent).toBe('small,medium');
  });

  it('a lookup that throws at once leaves the label without sizes and the view standing', async () => {
    mocks.instancesApi.resizeInfo = vi.fn(() => { throw new Error('boom'); });
    await render();
    expect(el.textContent).toBe('none');
  });

  it('a rejected lookup leaves the label without sizes', async () => {
    mocks.instancesApi.resizeInfo = vi.fn().mockRejectedValue(new Error('offline'));
    await render();
    expect(el.textContent).toBe('none');
  });
});
