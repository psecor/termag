// @vitest-environment jsdom
// svg-pan-zoom is attached once to each drawn diagram, in the diagram's own
// frame, with no visible controls, and afresh when the theme redraws it. The real Mermaid draws; the
// library's source is a stand-in that records each call, and every frame
// document is run in its own JSDOM, as the browser runs the srcdoc.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import MermaidDiagram from './MermaidDiagram';
import { PAN_ZOOM_OPTIONS } from './mermaid';

vi.mock('svg-pan-zoom/dist/svg-pan-zoom.min.js?raw', () => ({
  default: 'window.svgPanZoom = function (svg, options) { (window.__attached = window.__attached || []).push({ tag: svg && svg.tagName, options: options }); return { getZoom: function () { return 1; } }; };',
}));
vi.mock('hammerjs/hammer.min.js?raw', () => ({ default: 'window.Hammer = function () {};' }));

beforeAll(() => {
  const proto = SVGElement.prototype as unknown as { getBBox: () => DOMRect; getComputedTextLength: () => number };
  proto.getBBox = function (this: SVGElement) { return { x: 0, y: 0, width: (this.textContent ?? '').length * 8, height: 16 } as DOMRect; };
  proto.getComputedTextLength = function (this: SVGElement) { return (this.textContent ?? '').length * 8; };
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
  document.documentElement.removeAttribute('style');
});

// jsdom itself (the test environment's own package; it ships no types).
type Jsdom = new (html: string, options: { runScripts: 'dangerously'; beforeParse?: (window: Window) => void }) => { window: Window };
const jsdomModule = 'jsdom';
const { JSDOM } = (await import(/* @vite-ignore */ jsdomModule)) as { JSDOM: Jsdom };

/** Runs a frame's srcdoc as the browser would and returns what svg-pan-zoom was called with. */
function attachments(frame: HTMLIFrameElement): Array<{ tag: string; options: Record<string, unknown> }> {
  // jsdom does no layout: give the SVG the box a browser would, or the frame waits for one (frameScript).
  const dom = new JSDOM(frame.getAttribute('srcdoc') ?? '', {
    runScripts: 'dangerously',
    beforeParse: w => {
      (w as unknown as { SVGElement: typeof SVGElement }).SVGElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON: () => ({}) }) as DOMRect;
    },
  });
  const calls = (dom.window as unknown as { __attached?: Array<{ tag: string; options: Record<string, unknown> }> }).__attached ?? [];
  dom.window.close();
  return calls;
}

function expectOneAttachment(frame: HTMLIFrameElement) {
  const calls = attachments(frame);
  expect(calls).toHaveLength(1);
  expect(calls[0].tag).toBe('svg');
  expect(calls[0].options).toMatchObject(PAN_ZOOM_OPTIONS);
  expect(calls[0].options.controlIconsEnabled).toBe(false);
  expect(typeof (calls[0].options.customEventsHandler as { init?: unknown })?.init).toBe('function');
}

async function frameAfter(previous: string | null): Promise<HTMLIFrameElement> {
  for (let i = 0; i < 300; i++) {
    const f = host.querySelector<HTMLIFrameElement>('iframe.mmd-frame');
    if (f && f.getAttribute('srcdoc') !== previous) return f;
    await act(() => new Promise(r => setTimeout(r, 10)));
  }
  throw new Error('no new frame');
}

describe('svg-pan-zoom on a diagram', () => {
  it('is attached once per drawn diagram, and again when a theme change redraws it', async () => {
    await act(async () => root.render(<MermaidDiagram source={'flowchart LR\n  A[Plan] --> B[Ship]'} />));
    const first = await frameAfter(null);
    expect(host.querySelectorAll('iframe')).toHaveLength(1);
    expectOneAttachment(first);

    const before = first.getAttribute('srcdoc');
    await act(async () => { document.documentElement.style.setProperty('--bg-surface', '#ffffff'); });
    const second = await frameAfter(before);
    expect(host.querySelectorAll('iframe')).toHaveLength(1);
    expectOneAttachment(second);
  });

  it('is not attached to a diagram that does not parse', async () => {
    await act(async () => root.render(<MermaidDiagram source={'flowchart LR\n  A -->'} />));
    for (let i = 0; i < 300 && host.querySelector('.mmd')?.getAttribute('data-state') === 'drawing'; i++) {
      await act(() => new Promise(r => setTimeout(r, 10)));
    }
    expect(host.querySelector('.mmd')?.getAttribute('data-state')).toBe('error');
    expect(host.querySelector('iframe')).toBeNull();
  });
});
