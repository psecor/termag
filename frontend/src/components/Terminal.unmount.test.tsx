// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from './Terminal';

class PaneSocket {
  static OPEN = 1;
  static made: PaneSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: { type: string; data?: string }[] = [];
  constructor() { PaneSocket.made.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}
class StillObserver { observe() {} disconnect() {} }

let root: Root;
let host: HTMLDivElement;
let uncaught: unknown[];
const onError = (e: ErrorEvent) => { uncaught.push(e.error); e.preventDefault(); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.stubGlobal('ResizeObserver', StillObserver);
  vi.stubGlobal('WebSocket', PaneSocket);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  // jsdom lays nothing out, so xterm would measure a 0x0 character and report no mouse positions.
  const measured = (size: number) => function (this: HTMLElement) {
    return this.classList.contains('xterm-char-measure-element') ? size : 0;
  };
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(measured(256));
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(measured(16));
  PaneSocket.made = [];
  uncaught = [];
  window.addEventListener('error', onError);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  window.removeEventListener('error', onError);
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mouse = (type: string, target: EventTarget, buttons: number) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX: 40, clientY: 40 }));

const MOUSE_TRACKING_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';

async function pressedPane() {
  await act(async () => { root.render(<Terminal sessionName="dev-proj-ctrl" active />); });
  await act(async () => { vi.advanceTimersByTime(20); });
  const ws = PaneSocket.made[0];
  await act(async () => { ws.readyState = 1; ws.onopen!(); });
  await act(async () => {
    ws.onmessage!({ data: JSON.stringify({ type: 'output', data: MOUSE_TRACKING_ON }) });
    vi.advanceTimersByTime(20);
  });
  act(() => { mouse('mousedown', host.querySelector('.xterm-screen')!, 1); });
  expect(ws.sent.filter(m => m.type === 'input').map(m => m.data)).toEqual([expect.stringMatching(/^\x1b\[<0;/)]);
  return ws;
}

describe('Terminal unmounted while a mouse button is held', () => {
  it('throws nothing and sends no input as the drag finishes, nor on any drag or click after it', async () => {
    const ws = await pressedPane();
    const sentBefore = ws.sent.length;
    act(() => root.render(<></>));
    mouse('mousemove', document, 1);
    mouse('mousemove', document, 1);
    mouse('mouseup', document, 0);
    mouse('mousedown', document.body, 1);
    mouse('mousemove', document, 1);
    mouse('mouseup', document, 0);
    expect(uncaught).toEqual([]);
    expect(ws.sent.slice(sentBefore)).toEqual([]);
  });
});
