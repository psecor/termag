// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Tooltip, tooltipPosition } from './Tooltip';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = () => host.querySelector('button') as HTMLButtonElement;
const tip = () => document.querySelector('[role="tooltip"]');

/** jsdom has no PointerEvent; React reads pointerType off the native event. */
function pointer(el: Element, type: 'pointerover' | 'pointerout' | 'pointerdown', pointerType = 'mouse') {
  const e = new MouseEvent(type, { bubbles: true, relatedTarget: type === 'pointerover' ? document.body : null });
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  act(() => { el.dispatchEvent(e); });
}

function render(expanded?: boolean, onPointerDown?: () => void) {
  act(() => root.render(
    <Tooltip content={<><strong>Full access</strong> runs commands</>}>
      <button type="button" aria-expanded={expanded} aria-describedby="own" onPointerDown={onPointerDown}>Pill</button>
    </Tooltip>,
  ));
}

describe('Tooltip', () => {
  it('shows at once on a mouse hover, describing the control, and hides on leave', () => {
    render();
    expect(tip()).toBeNull();
    pointer(button(), 'pointerover');
    expect(tip()?.textContent).toBe('Full access runs commands');
    expect(button().getAttribute('aria-describedby')).toBe(`own ${tip()!.id}`);
    pointer(button(), 'pointerout');
    expect(tip()).toBeNull();
    expect(button().getAttribute('aria-describedby')).toBe('own');
  });

  it('never shows for touch, and hides on a press, keeping the control’s own handler', () => {
    let pressed = 0;
    render(undefined, () => { pressed++; });
    pointer(button(), 'pointerover', 'touch');
    expect(tip()).toBeNull();
    pointer(button(), 'pointerover');
    expect(tip()).not.toBeNull();
    pointer(button(), 'pointerdown');
    expect(tip()).toBeNull();
    expect(pressed).toBe(1);
  });

  it('hides on Escape, and stays hidden while the control’s menu is open', () => {
    render();
    pointer(button(), 'pointerover');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(tip()).toBeNull();
    pointer(button(), 'pointerover');
    expect(tip()).not.toBeNull();
    render(true);
    expect(tip()).toBeNull();
  });

  it('stays up while the chat above the composer streams, and hides when the page scrolls', () => {
    const transcript = document.createElement('div');
    document.body.appendChild(transcript);
    try {
      render();
      pointer(button(), 'pointerover');
      // New output: the transcript grows and follows it down.
      for (let i = 0; i < 4; i++) {
        act(() => {
          transcript.append(Object.assign(document.createElement('p'), { textContent: `step ${i}` }));
          transcript.dispatchEvent(new Event('scroll'));
        });
      }
      expect(tip()).not.toBeNull();
      act(() => { document.dispatchEvent(new Event('scroll')); });
      expect(tip()).toBeNull();
    } finally {
      transcript.remove();
    }
  });

  it('sits centred above the control, below it with no room, and inside the viewport', () => {
    const tipSize = { width: 100, height: 30 };
    expect(tooltipPosition({ top: 200, bottom: 228, left: 300, width: 80 }, tipSize, { width: 1000 }))
      .toEqual({ top: 162, left: 290, side: 'top' });
    expect(tooltipPosition({ top: 10, bottom: 38, left: 300, width: 80 }, tipSize, { width: 1000 }).side).toBe('bottom');
    expect(tooltipPosition({ top: 10, bottom: 38, left: 300, width: 80 }, tipSize, { width: 1000 }).top).toBe(46);
    expect(tooltipPosition({ top: 200, bottom: 228, left: 0, width: 20 }, tipSize, { width: 1000 }).left).toBe(8);
    expect(tooltipPosition({ top: 200, bottom: 228, left: 980, width: 20 }, tipSize, { width: 1000 }).left).toBe(892);
  });
});
