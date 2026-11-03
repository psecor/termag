// @vitest-environment jsdom
// Mermaid is imported the first time a diagram shows, and not before: a reply,
// a Markdown file, the pane chat and a code file with no diagram never load it.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from './Markdown';
import { BlockView } from './Blocks';
import { CodeView } from '../pages/chat/CodeView';

const loaded = vi.hoisted(() => ({ count: 0 }));
vi.mock('mermaid', () => {
  loaded.count++;
  return {
    default: {
      initialize: () => {},
      parse: async () => ({}),
      render: async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>stub</text></svg>' }),
    },
  };
});

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

const tick = () => act(() => new Promise(r => setTimeout(r, 20)));

describe('loading Mermaid', () => {
  it('never happens without a diagram, then happens once for the first one', async () => {
    await act(async () => root.render(
      <>
        <Markdown text={'# Notes\n\n```js\nconst a = 1;\n```\n\n```mermaid\nflowchart LR\n  A --'} streaming />
        <BlockView agentLabel="pi" block={{ kind: 'agent', text: 'Here:\n```ts\nlet x = 1;\n```\n```mermaid\nflowchart' }} />
        <CodeView path="flow.ts" text="const flow = 'mermaid';" />
      </>,
    ));
    await tick();
    expect(loaded.count).toBe(0);
    expect(host.querySelector('.mmd')).toBeNull();

    await act(async () => root.render(<Markdown text={'```mermaid\nflowchart LR\n  A --> B\n```'} />));
    for (let i = 0; i < 50 && !host.querySelector('.mmd iframe'); i++) await tick();
    expect(loaded.count).toBe(1);
    expect(host.querySelector('.mmd iframe')?.getAttribute('srcdoc')).toContain('<text>stub</text>');
  });

  it('draws a closed mermaid fence in the pane chat, and leaves an open one as code', async () => {
    await act(async () => root.render(<BlockView agentLabel="pi" block={{ kind: 'agent', text: 'Board:\n```mermaid\nkanban\n  todo[To do]\n```\nNext:\n```mermaid\nflowchart' }} />));
    for (let i = 0; i < 50 && !host.querySelector('.mmd iframe'); i++) await tick();
    expect(host.querySelectorAll('.mmd')).toHaveLength(1);
    expect(host.querySelector('.mmd iframe')).not.toBeNull();
    expect(host.querySelector('pre.m-code')!.textContent).toBe('flowchart');
  });
});
