// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (text: string, streaming = false) => act(() => root.render(<Markdown text={text} streaming={streaming} />));
const all = () => [...host.querySelectorAll('details')];

describe('Markdown details', () => {
  it('keeps a reader\'s toggle while a reply streams, for details the source opened or not', () => {
    const block = '<details open>\n<summary>A</summary>\n\nbody\n</details>\n\n<details>\n<summary>B</summary>\n\nmore\n</details>';
    const cells = '\n\n| x |\n|---|\n| <details open><summary>C</summary>c</details> |';
    render(block + cells + '\n\nso far', true);
    expect(all().map(d => d.open)).toEqual([true, false, true]);
    // The reader collapses the open ones and opens the closed one.
    act(() => { all().forEach(d => { d.open = !d.open; }); });
    render(block + cells + '\n\nso far, and more', true);
    render(block + cells + '\n\nso far, and more.\n\nDone.');
    expect(all().map(d => d.open)).toEqual([false, true, false]);
  });
});
