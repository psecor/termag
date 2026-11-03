// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
const { default: GenUiSurface } = await import('../GenUiSurface');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function draw(spec: object) {
  const block = { type: 'code' as const, lang: 'spec', text: JSON.stringify(spec), open: false };
  act(() => root.render(<GenUiSurface block={block} itemKey="r" streaming={false} chat={null} fallback={null} />));
}
const md = (text: unknown, state?: object) => draw({ root: 'm', elements: { m: { type: 'Markdown', props: { text }, children: [] } }, ...(state ? { state } : {}) });

describe('Markdown', () => {
  it('draws formatting, lists, tables and code', () => {
    md('# Plan\n\nShip **two** things, `fast`:\n\n- [x] tests\n- [ ] docs\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```sh\nmake test\n```');
    const m = host.querySelector('.genui-markdown')!;
    expect(m.querySelector('h4')?.textContent).toBe('Plan');
    expect(m.querySelector('strong')?.textContent).toBe('two');
    expect(m.querySelector('code.md-code')?.textContent).toBe('fast');
    expect(m.querySelectorAll('li.md-task input:checked')).toHaveLength(1);
    expect(m.querySelector('.md-table td')?.textContent).toBe('1');
    expect(m.querySelector('.md-pre pre')?.textContent).toBe('make test');
  });

  it('never draws a link or an image, whatever the text says, and so never one built from state', () => {
    md({ $template: 'See [the report](https://example.com/?q=${/typed}) and https://example.com/raw ![chart](https://example.com/c.png)' }, { typed: 'secret' });
    const m = host.querySelector('.genui-markdown')!;
    expect(m.querySelector('a')).toBeNull();
    expect(m.querySelector('img')).toBeNull();
    expect(m.textContent).toContain('the report');
    expect(m.textContent).not.toContain('secret');
  });

  it('draws a spec fence in the text as code, never as another surface', () => {
    md('```spec\n{"op":"add","path":"/root","value":"x"}\n```');
    expect(host.querySelectorAll('.genui-surface')).toHaveLength(1);
    expect(host.querySelector('.genui-markdown .md-pre pre')?.textContent).toContain('/root');
  });
});
