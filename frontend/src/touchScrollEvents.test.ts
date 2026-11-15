// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recorded: Array<{ name: string; attributes: Record<string, unknown> }> = [];
vi.mock('./observability', () => ({
  recordProductEvent: (name: string, attributes: Record<string, unknown>) => { recorded.push({ name, attributes }); },
}));

const { resetTouchScrollForTests, TOUCH_MOMENTUM_MS, touchScroller, watchTouchScroll } = await import('./touchScrollEvents');

function touch(type: 'touchstart' | 'touchmove' | 'touchend', fingers: number, target: EventTarget = document, y = 300) {
  const e = new Event(type, { bubbles: true });
  const touches = Array.from({ length: fingers }, () => ({ clientX: 100, clientY: y }));
  Object.defineProperty(e, 'touches', { value: touches });
  target.dispatchEvent(e);
}
// el moves by `by` px (down by default) and says so.
function scroll(el: Element, by = 10) { el.scrollTop += by; el.dispatchEvent(new Event('scroll')); }
// A finger down on el that pans: up by default, which scrolls down.
function pan(el: Element, dy = -100) { touch('touchstart', 1, el, 300); touch('touchmove', 1, el, 300 + dy); }

function container(html: string, selector: string): Element {
  document.body.innerHTML = html;
  return document.querySelector(selector)!;
}

let clock = 0;
let stop: () => void;
let path = '/chat/abc';

beforeEach(() => {
  recorded.length = 0;
  resetTouchScrollForTests();
  clock = 1_000_000;
  path = '/chat/abc';
  stop = watchTouchScroll(document, () => path, () => clock);
});
afterEach(() => { stop(); document.body.innerHTML = ''; });

describe('touchScroller', () => {
  it('names the chat transcript, the phone list and a terminal by the container, else other', () => {
    expect(touchScroller(container('<div class="chat-transcript"><div id="x"></div></div>', '#x'))).toBe('chat');
    expect(touchScroller(container('<main class="m-scroll"></main>', 'main'))).toBe('mobile');
    expect(touchScroller(container('<div class="xterm"><div class="xterm-viewport"></div></div>', '.xterm-viewport'))).toBe('terminal');
    expect(touchScroller(container('<div class="side-panel"></div>', 'div'))).toBe('other');
    expect(touchScroller(null)).toBe('other');
  });
});

describe('ui.touch.scrolled', () => {
  it('records a scroll during a touch, with the container and the view', () => {
    const el = container('<div class="chat-transcript"></div>', '.chat-transcript');
    pan(el);
    scroll(el);
    expect(recorded).toEqual([{ name: 'ui.touch.scrolled', attributes: { 'termag.scroller': 'chat', 'termag.view': 'simple' } }]);
  });

  it('records each kind of container once per page load', () => {
    document.body.innerHTML = '<div class="chat-transcript"></div><div class="xterm"><div class="xterm-viewport"></div></div>';
    const chat = document.querySelector('.chat-transcript')!;
    const term = document.querySelector('.xterm-viewport')!;
    pan(chat);
    scroll(chat); scroll(chat);
    touch('touchend', 0, chat);
    path = '/';
    pan(term);
    scroll(term); scroll(term);
    expect(recorded.map(r => r.attributes)).toEqual([
      { 'termag.scroller': 'chat', 'termag.view': 'simple' },
      { 'termag.scroller': 'terminal', 'termag.view': 'full' },
    ]);
  });

  it('counts momentum after the finger lifts, but not a scroll with no touch behind it', () => {
    const el = container('<main class="m-scroll"></main>', 'main');
    scroll(el);
    expect(recorded).toEqual([]);
    pan(el);
    touch('touchend', 0, el);
    clock += TOUCH_MOMENTUM_MS + 1;
    scroll(el);
    expect(recorded).toEqual([]);
    pan(el);
    touch('touchend', 0, el);
    clock += 200;
    path = '/m';
    scroll(el);
    expect(recorded).toEqual([{ name: 'ui.touch.scrolled', attributes: { 'termag.scroller': 'mobile', 'termag.view': 'mobile' } }]);
  });

  it('ignores a follow-bottom scroll of the chat during a tap or a pan elsewhere', () => {
    document.body.innerHTML = '<div class="chat-transcript"></div><button id="b"></button><div class="side-panel"></div>';
    const chat = document.querySelector('.chat-transcript')!;
    touch('touchstart', 1, document.querySelector('#b')!);
    scroll(chat);
    touch('touchend', 0, document.querySelector('#b')!);
    scroll(chat);
    touch('touchstart', 1, chat);
    scroll(chat);
    touch('touchend', 0, chat);
    pan(document.querySelector('.side-panel')!);
    scroll(chat);
    expect(recorded).toEqual([]);
  });

  it('ignores a scroll that moves against the finger, like output followed mid-swipe', () => {
    const el = container('<div class="chat-transcript"></div>', '.chat-transcript');
    el.scrollTop = 500;
    pan(el, 100); // the finger moves down, asking to scroll up
    scroll(el, 40); // but the container moved down
    expect(recorded).toEqual([]);
    scroll(el, -40);
    expect(recorded.map(r => r.attributes['termag.scroller'])).toEqual(['chat']);
  });

  it('records the first upward swipe of a container already scrolled before any scroll event', () => {
    const el = container('<div class="chat-transcript"><div id="row"></div></div>', '.chat-transcript');
    el.scrollTop = 500; // scrolled with no scroll event seen, as on a restored page
    pan(document.querySelector('#row')!, 100); // the finger moves down, asking to scroll up
    scroll(el, -10); // 500 -> 490
    expect(recorded.map(r => r.attributes['termag.scroller'])).toEqual(['chat']);
  });

  it('records the first upward swipe of an already-scrolled terminal viewport beside the touched screen', () => {
    document.body.innerHTML = '<div class="xterm"><div class="xterm-viewport"></div><div class="xterm-screen"><canvas></canvas></div></div>';
    const viewport = document.querySelector('.xterm-viewport')!;
    viewport.scrollTop = 500;
    pan(document.querySelector('canvas')!, 100);
    scroll(viewport, -10);
    expect(recorded.map(r => r.attributes['termag.scroller'])).toEqual(['terminal']);
  });

  it('ignores the chat\'s follow-bottom even when it moves the way the finger did', async () => {
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { useFollowBottom } = await import('./chat/useFollowBottom');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '<div id="root"></div>';
    const el = document.createElement('div');
    el.className = 'chat-transcript';
    document.body.append(el);
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    // The transcript stands in for the scroller the view would render.
    function View({ c }: { c: unknown }) {
      const { scroller } = useFollowBottom(c, 'k');
      (scroller as { current: HTMLDivElement | null }).current = el;
      return null;
    }
    const root = createRoot(document.querySelector('#root')!);
    act(() => root.render(createElement(View, { c: ['a'] })));
    pan(el); // a swipe up, swallowed: the finger asks to scroll down
    el.scrollTop = 0;
    act(() => root.render(createElement(View, { c: ['a', 'b'] }))); // a streamed chunk: follow-bottom jumps down
    el.dispatchEvent(new Event('scroll'));
    expect(el.scrollTop).toBeGreaterThan(0);
    expect(recorded).toEqual([]);
    pan(el, 100); // a real swipe down that scrolls up
    scroll(el, -10);
    expect(recorded.map(r => r.attributes['termag.scroller'])).toEqual(['chat']);
    act(() => root.unmount());
  });

  it('counts a pan that chains to a scrolling ancestor', () => {
    const inner = container('<main class="m-scroll"><div id="row"></div></main>', '#row');
    pan(inner);
    scroll(document.querySelector('main')!);
    expect(recorded.map(r => r.attributes['termag.scroller'])).toEqual(['mobile']);
  });

  it('counts a pan on the terminal screen that scrolls its sibling viewport, but not another terminal', () => {
    document.body.innerHTML =
      '<div class="xterm" id="a"><div class="xterm-viewport"></div><div class="xterm-screen"><canvas></canvas></div></div>' +
      '<div class="xterm" id="b"><div class="xterm-viewport"></div><div class="xterm-screen"></div></div>';
    const otherViewport = document.querySelector('#b .xterm-viewport')!;
    pan(document.querySelector('#a canvas')!);
    scroll(otherViewport);
    expect(recorded).toEqual([]);
    scroll(document.querySelector('#a .xterm-viewport')!);
    touch('touchend', 0, document.querySelector('#a canvas')!);
    expect(recorded.map(r => r.attributes['termag.scroller'])).toEqual(['terminal']);
  });

  it('ignores a programmatic terminal scroll with no touch behind it', () => {
    document.body.innerHTML = '<div class="xterm"><div class="xterm-viewport"></div><div class="xterm-screen"></div></div>';
    scroll(document.querySelector('.xterm-viewport')!);
    expect(recorded).toEqual([]);
  });

  it('stops listening once cleaned up', () => {
    stop();
    const el = container('<div class="chat-transcript"></div>', '.chat-transcript');
    touch('touchstart', 1, el);
    scroll(el);
    expect(recorded).toEqual([]);
    stop = () => {};
  });
});
