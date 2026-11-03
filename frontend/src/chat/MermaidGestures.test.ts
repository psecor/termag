// The gestures a diagram's frame takes (mermaid.ts frameScript), run the way
// the browser runs the frame: its whole document in its own JSDOM, with
// stand-ins for svg-pan-zoom and Hammer.js that record what reaches them.
// svg-pan-zoom zooms on any wheel event that reaches its own listener on the
// SVG, so "the wheel zooms" is "the wheel reached it". The same checks run
// in Chromium against the e2e stack (improve-termag:artifacts/mermaid/).
import { describe, expect, it } from 'vitest';
import { DEFAULT_DIAGRAM_THEME, diagramDocument, PAN_ZOOM_OPTIONS, type FrameMode } from './mermaid';

type Jsdom = new (html: string, options: { runScripts: 'dangerously'; beforeParse?: (window: Window) => void }) => { window: Window & typeof globalThis };
const jsdomModule = 'jsdom';
const { JSDOM } = (await import(/* @vite-ignore */ jsdomModule)) as { JSDOM: Jsdom };

interface Recorded {
  wheels: number;
  calls: string[];
  attached: number;
  destroyed: number;
  options: Record<string, unknown> & { beforePan: () => boolean };
  hammer: { options: { touchAction: string; enable: boolean }; sets: Array<{ enable: boolean; touchAction: string }> };
  posted: unknown[];
}

const HAMMER = `
window.Hammer = function (el, options) {
  var h = { options: options, sets: [], set: function (o) { h.sets.push(o); }, get: function () { return { set: function () {}, recognizeWith: function () {} }; }, on: function () {}, destroy: function () {} };
  window.__rec.hammer = h;
  return h;
};
window.Hammer.TouchInput = 'touch';
window.Hammer.DIRECTION_ALL = 30;`;

const PAN_ZOOM = `
window.svgPanZoom = function (svg, options) {
  window.__rec.attached++;
  window.__rec.options = options;
  svg.addEventListener('wheel', function () { window.__rec.wheels++; });
  options.customEventsHandler.init({ svgElement: svg, instance: {} });
  if (window.__failInit) throw new Error(window.__failInit);
  var rec = function (name) { return function () { window.__rec.calls.push(name); }; };
  return {
    zoomIn: rec('zoomIn'), zoomOut: rec('zoomOut'), panBy: rec('panBy'), fit: rec('fit'), center: rec('center'),
    resize: function () { window.__rec.calls.push('resize'); if (window.__failRefit) throw new Error("Failed to execute 'inverse' on 'SVGMatrix': The matrix is not invertible."); },
    // svg-pan-zoom's zoom: NaN when it measured the SVG at 0 x 0.
    getZoom: function () { return window.__zoom === undefined ? 1 : window.__zoom; },
    destroy: function () { window.__rec.destroyed++; svg.removeAttribute('viewBox'); },
  };
};`;

/**
 * The frame's own viewport and its SVG's box, as the browser sizes them: both
 * 0 × 0 while the page hides the frame (display: none, a 0-wide box). jsdom
 * does no layout, so the SVG's box is a stand-in (`svgBoxIs`).
 */
function resizeTo(window: Window, width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
  svgBoxIs(window, width, height);
}
function svgBoxIs(window: Window, width: number, height: number) {
  (window as unknown as { __svgBox: [number, number] }).__svgBox = [width, height];
}

/** Before the frame's script: the SVG's box stand-in, and a ResizeObserver whose callbacks the test runs (`layout`). */
function prepare(window: Window, size: { width: number; height: number }, svgBox?: { width: number; height: number }) {
  resizeTo(window, size.width, size.height);
  if (svgBox) svgBoxIs(window, svgBox.width, svgBox.height);
  const w = window as unknown as { __svgBox: [number, number]; __observers: Array<() => void>; SVGElement: typeof SVGElement; ResizeObserver: unknown };
  w.SVGElement.prototype.getBoundingClientRect = function () {
    const [width, height] = w.__svgBox;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
  };
  w.__observers = [];
  w.ResizeObserver = class { constructor(cb: () => void) { w.__observers.push(cb); } observe() {} disconnect() {} };
}

function frame(mode: FrameMode, size: { width: number; height: number } = { width: 400, height: 300 }, opts: { svgBox?: { width: number; height: number }; setup?: string } = {}) {
  const html = diagramDocument('<svg viewBox="0 0 10 10"><text>x</text></svg>', DEFAULT_DIAGRAM_THEME, { hammer: HAMMER, panZoom: PAN_ZOOM }, 'n', mode)
    .replace('<body>', `<body><script>window.__rec = { wheels: 0, calls: [], attached: 0, destroyed: 0, posted: [] };${opts.setup ?? ''}</script>`);
  const { window } = new JSDOM(html, { runScripts: 'dangerously', beforeParse: w => prepare(w, size, opts.svgBox) });
  const rec = (window as unknown as { __rec: Recorded }).__rec;
  // The frame's parent is itself in a lone JSDOM; record what it tells the page.
  window.addEventListener('message', e => { rec.posted.push(e.data); });
  const svg = window.document.querySelector('body > svg')!;
  const wheel = (init: WheelEventInit = {}) => svg.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, ...init }));
  const key = (key: string) => window.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
  const click = () => svg.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const active = () => window.document.body.classList.contains('active');
  // The browser laying the frame out again: its ResizeObservers run.
  const layout = () => (window as unknown as { __observers: Array<() => void> }).__observers.forEach(cb => cb());
  const told = (what: string) => rec.posted.filter(p => (p as Record<string, unknown>)?.termagMermaid === what);
  return { window, rec, wheel, key, click, active, layout, told, flush: () => new Promise(r => setTimeout(r, 0)) };
}

describe('a whole file\'s diagram', () => {
  it('is live from the start: the wheel zooms, a drag pans, the grab cursor shows, touch is Hammer\'s', () => {
    const f = frame('file');
    expect(f.rec.options).toMatchObject(PAN_ZOOM_OPTIONS);
    expect(f.rec.options.controlIconsEnabled).toBe(false);
    expect(f.active()).toBe(true);
    f.wheel();
    expect(f.rec.wheels).toBe(1);
    expect(f.rec.options.beforePan()).toBe(true);
    expect(f.rec.hammer.options).toMatchObject({ enable: true, touchAction: 'none' });
    expect(f.window.document.body.title).toBe('');
  });

  it('stays live through Escape', () => {
    const f = frame('file');
    f.key('Escape');
    f.wheel();
    expect(f.rec.wheels).toBe(1);
  });
});

describe('a diagram in a reply or a Markdown file', () => {
  it('starts as a picture: a plain wheel passes to the page, nothing pans, touch is the browser\'s', () => {
    const f = frame('embed');
    expect(f.active()).toBe(false);
    expect(f.window.document.body.title).toBe('Click to zoom and pan');
    f.wheel();
    expect(f.rec.wheels).toBe(0);
    expect(f.rec.options.beforePan()).toBe(false);
    expect(f.rec.hammer.options).toMatchObject({ enable: false, touchAction: 'auto' });
  });

  it('zooms on Ctrl/⌘ + wheel (and a trackpad pinch, which arrives as one) even before a click', () => {
    const f = frame('embed');
    f.wheel({ ctrlKey: true });
    f.wheel({ metaKey: true });
    expect(f.rec.wheels).toBe(2);
    expect(f.active()).toBe(false);
  });

  it('becomes live on a click: the wheel zooms, a drag pans, touch is Hammer\'s, and the page is told', async () => {
    const f = frame('embed');
    f.click();
    await f.flush();
    expect(f.active()).toBe(true);
    f.wheel();
    expect(f.rec.wheels).toBe(1);
    expect(f.rec.options.beforePan()).toBe(true);
    expect(f.rec.hammer.sets.at(-1)).toEqual({ enable: true, touchAction: 'none' });
    expect(f.rec.posted.at(-1)).toEqual({ termagMermaid: 'active', active: true });
  });

  it('goes back to a picture on Escape, on blur, and when the page says so', async () => {
    for (const leave of [
      (f: ReturnType<typeof frame>) => f.key('Escape'),
      (f: ReturnType<typeof frame>) => f.window.dispatchEvent(new f.window.FocusEvent('blur')),
      (f: ReturnType<typeof frame>) => f.window.dispatchEvent(new f.window.MessageEvent('message', { data: { termagMermaid: 'deactivate' }, source: f.window.parent })),
    ]) {
      const f = frame('embed');
      f.click();
      leave(f);
      await f.flush();
      expect(f.active()).toBe(false);
      f.wheel();
      expect(f.rec.wheels).toBe(0);
      expect(f.rec.posted.at(-1)).toEqual({ termagMermaid: 'active', active: false });
    }
  });

  it('ignores a deactivate from anyone but its page', () => {
    const f = frame('embed');
    f.click();
    f.window.dispatchEvent(new f.window.MessageEvent('message', { data: { termagMermaid: 'deactivate' }, source: null }));
    expect(f.active()).toBe(true);
  });

  it('takes the keyboard: Enter activates, then +/- zoom and the arrows pan', () => {
    const f = frame('embed');
    f.key('+');
    expect(f.rec.calls).toEqual([]);
    f.key('Enter');
    expect(f.active()).toBe(true);
    f.key('+'); f.key('-'); f.key('ArrowLeft'); f.key('ArrowDown');
    expect(f.rec.calls).toEqual(['zoomIn', 'zoomOut', 'panBy', 'panBy']);
  });

  it('refits on a double-click only while live, and on every resize', () => {
    const f = frame('embed');
    const svg = f.window.document.querySelector('body > svg')!;
    svg.dispatchEvent(new f.window.MouseEvent('dblclick', { bubbles: true }));
    expect(f.rec.calls).toEqual([]);
    f.click();
    svg.dispatchEvent(new f.window.MouseEvent('dblclick', { bubbles: true }));
    expect(f.rec.calls).toEqual(['resize', 'fit', 'center']);
    f.window.dispatchEvent(new f.window.Event('resize'));
    expect(f.rec.calls).toHaveLength(6);
  });
});

// A frame the page hides while it loads (a collapsed <details>, the chat pane
// hidden behind a page on a narrow screen, a 0-wide box) has a 0 × 0 viewport.
// svg-pan-zoom fitted there zooms to 0, and every refit after it throws
// ("The matrix is not invertible"), so the diagram stayed blank once shown.
describe('a frame drawn while hidden', () => {
  for (const mode of ['embed', 'file'] as const) {
    it(`(${mode}) waits for a size before svg-pan-zoom fits the diagram, then fits it once`, () => {
      const f = frame(mode, { width: 0, height: 0 });
      expect(f.rec.attached).toBe(0);
      f.window.dispatchEvent(new f.window.Event('resize'));
      expect(f.rec.attached).toBe(0);
      resizeTo(f.window, 0, 300);
      f.window.dispatchEvent(new f.window.Event('resize'));
      expect(f.rec.attached).toBe(0);

      resizeTo(f.window, 400, 300);
      f.window.dispatchEvent(new f.window.Event('resize'));
      expect(f.rec.attached).toBe(1);
      expect(f.rec.options).toMatchObject(PAN_ZOOM_OPTIONS);
      expect(f.active()).toBe(mode === 'file');
      expect(f.rec.calls).toEqual([]);
    });
  }

  it('takes no keys or double-clicks before it has a size', () => {
    const f = frame('embed', { width: 0, height: 0 });
    f.key('Enter');
    f.key('+');
    f.window.document.querySelector('body > svg')!.dispatchEvent(new f.window.MouseEvent('dblclick', { bubbles: true }));
    expect(f.rec.calls).toEqual([]);
  });

  it('is not refitted to 0 when the page hides it again, and refits when it shows', () => {
    const f = frame('file');
    expect(f.rec.attached).toBe(1);
    resizeTo(f.window, 0, 0);
    f.window.dispatchEvent(new f.window.Event('resize'));
    expect(f.rec.calls).toEqual([]);
    resizeTo(f.window, 500, 300);
    f.window.dispatchEvent(new f.window.Event('resize'));
    expect(f.rec.calls).toEqual(['resize', 'fit', 'center']);
    expect(f.rec.attached).toBe(1);
  });
});

// Seen in Chrome (the frame is out of process): the frame's script can run
// while its document is still loading, with the window already sized but the
// SVG not yet laid out (0 x 0). svg-pan-zoom fitted then came out at zoom NaN,
// matrix(0,0,0,0,0,0), and every refit after that threw, so 11 of 30 loads of
// a board in the file view stayed blank. The frame now goes by the SVG's own
// box, and checks what svg-pan-zoom made of it.
describe('a frame whose SVG is not laid out yet', () => {
  it('waits for the SVG\'s own box, not the window\'s, then fits once', async () => {
    const f = frame('file', { width: 778, height: 212 }, { svgBox: { width: 0, height: 0 } });
    expect(f.rec.attached).toBe(0);
    await f.flush();
    expect(f.told('waiting')).toHaveLength(1);
    svgBoxIs(f.window, 778, 212);
    f.layout();
    expect(f.rec.attached).toBe(1);
    await f.flush();
    expect(f.told('drawn')).toHaveLength(1);
    f.layout();
    expect(f.rec.attached).toBe(1);
  });

  it('starts on a window resize as well, where there is no ResizeObserver to say so', () => {
    const f = frame('embed', { width: 778, height: 212 }, { svgBox: { width: 0, height: 0 } });
    svgBoxIs(f.window, 778, 212);
    f.window.dispatchEvent(new f.window.Event('resize'));
    expect(f.rec.attached).toBe(1);
  });

  it('throws svg-pan-zoom away when it comes out with no zoom, keeps the plain picture, and tries again on the next layout', async () => {
    const f = frame('file', undefined, { setup: 'window.__zoom = NaN;' });
    expect(f.rec.attached).toBe(1);
    expect(f.rec.destroyed).toBe(1);
    // The SVG is drawn by the browser at its own viewBox meanwhile.
    expect(f.window.document.querySelector('body > svg')!.getAttribute('viewBox')).toBe('0 0 10 10');
    await f.flush();
    expect(f.told('drawn')).toHaveLength(0);
    // Every layout until then tries again (the frame's load event is one).
    const tries = f.rec.attached;
    expect(f.rec.destroyed).toBe(tries);
    (f.window as unknown as { __zoom: number }).__zoom = 0.7;
    f.layout();
    expect(f.rec.attached).toBe(tries + 1);
    expect(f.rec.destroyed).toBe(tries);
    await f.flush();
    expect(f.told('drawn')).toHaveLength(1);
  });

  it('recovers from a refit that throws, instead of staying blank', () => {
    const f = frame('file');
    const errors: string[] = [];
    f.window.addEventListener('error', e => errors.push(e.message));
    (f.window as unknown as { __failRefit: boolean }).__failRefit = true;
    f.window.dispatchEvent(new f.window.Event('resize'));
    expect(errors).toEqual([]);
    expect(f.rec.destroyed).toBe(1);
    expect(f.window.document.querySelector('body > svg')!.getAttribute('viewBox')).toBe('0 0 10 10');
    (f.window as unknown as { __failRefit: boolean }).__failRefit = false;
    f.layout();
    expect(f.rec.attached).toBe(2);
  });

  it('tells the page when svg-pan-zoom cannot start at all, with its message, and keeps the plain picture', async () => {
    const f = frame('embed', undefined, { setup: 'window.__failInit = "boom";' });
    await f.flush();
    expect(f.told('failed')).toEqual([{ termagMermaid: 'failed', message: 'boom' }]);
    expect(f.window.document.querySelector('body > svg')!.getAttribute('viewBox')).toBe('0 0 10 10');
  });
});
