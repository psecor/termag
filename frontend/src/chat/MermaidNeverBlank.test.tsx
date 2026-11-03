// @vitest-environment jsdom
// A diagram is drawn or shows why not, with its source: never an empty frame.
// Mermaid is a stand-in here, so each way of drawing nothing can be had on demand;
// the frame's own side (it says `drawn`, `waiting` or `failed`) is MermaidGestures.test.ts.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MermaidDiagram from './MermaidDiagram';
import { FRAME_MESSAGE, FRAME_START_GRACE_MS } from './mermaid';

const stub = vi.hoisted(() => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>stub</text></svg>' }));
vi.mock('mermaid', () => ({
  default: { initialize: () => {}, parse: async () => ({}), render: async () => ({ svg: stub.svg }) },
}));

let root: Root;
let host: HTMLDivElement;
const SOURCE = 'kanban\n  review[PR review]\n  ready[Ready]\n    r1[941 design: runs push]';

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  stub.svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>stub</text></svg>';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  host.remove();
});

const tick = () => act(() => new Promise(r => setTimeout(r, 10)));

async function settled(): Promise<HTMLElement> {
  for (let i = 0; i < 200; i++) {
    const box = host.querySelector<HTMLElement>('.mmd');
    if (box && box.dataset.state !== 'drawing') return box;
    await tick();
  }
  throw new Error('still drawing');
}

function fromFrame(frame: HTMLIFrameElement, data: Record<string, unknown>) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: { [FRAME_MESSAGE]: 'x', ...data }, source: frame.contentWindow })); });
}

function expectErrorWithSource(box: HTMLElement, text: RegExp) {
  expect(box.dataset.state).toBe('error');
  expect(box.querySelector('iframe')).toBeNull();
  expect(box.querySelector('[role="alert"]')!.textContent).toMatch(text);
  expect(box.querySelector('.mmd-source')!.textContent).toBe(SOURCE);
}

describe('a diagram that draws nothing', () => {
  for (const file of [false, true]) {
    const where = file ? 'a whole file' : 'a fence';
    it(`(${where}) shows an error and its source when Mermaid returns an SVG with no size`, async () => {
      stub.svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
      await act(async () => root.render(<MermaidDiagram source={SOURCE} file={file} />));
      expectErrorWithSource(await settled(), /^Couldn't draw this diagram: Mermaid drew nothing/);
    });

    it(`(${where}) shows the frame's error and the source when the frame can't draw it`, async () => {
      await act(async () => root.render(<MermaidDiagram source={SOURCE} file={file} />));
      const box = await settled();
      fromFrame(box.querySelector('iframe')!, { [FRAME_MESSAGE]: 'failed', message: 'svgPanZoom is not a function' });
      expectErrorWithSource(box, /^Couldn't draw this diagram: svgPanZoom is not a function$/);
    });

    it(`(${where}) shows an error when the frame loads and never says it drew`, async () => {
      await act(async () => root.render(<MermaidDiagram source={SOURCE} file={file} />));
      const box = await settled();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      act(() => { box.querySelector('iframe')!.dispatchEvent(new Event('load')); });
      act(() => { vi.advanceTimersByTime(FRAME_START_GRACE_MS + 1); });
      expectErrorWithSource(box, /^Couldn't draw this diagram: its frame did not start/);
    });

    it(`(${where}) keeps the frame once it says it drew, or that it waits to be shown`, async () => {
      for (const said of ['drawn', 'waiting']) {
        await act(async () => root.render(<MermaidDiagram key={said} source={SOURCE} file={file} />));
        const box = await settled();
        const frame = box.querySelector('iframe')!;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        act(() => { frame.dispatchEvent(new Event('load')); });
        fromFrame(frame, { [FRAME_MESSAGE]: said });
        act(() => { vi.advanceTimersByTime(FRAME_START_GRACE_MS * 3); });
        vi.useRealTimers();
        expect(box.dataset.state).toBe('ok');
        expect(box.querySelector('iframe')).toBe(frame);
      }
    });
  }

  it('ignores a failure posted by any window but its own frame', async () => {
    await act(async () => root.render(<MermaidDiagram source={SOURCE} />));
    const box = await settled();
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { [FRAME_MESSAGE]: 'failed', message: 'x' }, source: window })); });
    expect(box.dataset.state).toBe('ok');
  });
});
