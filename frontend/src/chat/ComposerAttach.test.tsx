// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerAttach } from './ComposerAttach';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('ComposerAttach', () => {
  it('picks the same file again after a pick: every press clears the input before it opens the picker', async () => {
    const onFiles = vi.fn();
    await act(async () => { root.render(<ComposerAttach onFiles={onFiles} />); });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const button = container.querySelector<HTMLButtonElement>('button')!;
    // jsdom keeps a file input's value empty; stand in for the browser's, which holds the last pick.
    let value = '';
    Object.defineProperty(input, 'value', { configurable: true, get: () => value, set: v => { value = v; } });
    const opened = vi.spyOn(input, 'click').mockImplementation(() => {});
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    const choose = async () => {
      await act(async () => { button.click(); });
      // Opening the picker on a value the last pick left would fire no change for the same file.
      expect(value).toBe('');
      value = 'C:\\fakepath\\shot.png';
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    };
    await choose();
    await choose();
    expect(opened).toHaveBeenCalledTimes(2);
    expect(onFiles).toHaveBeenCalledTimes(2);
    expect(onFiles.mock.calls[1][0]).toEqual([file]);
  });
});
