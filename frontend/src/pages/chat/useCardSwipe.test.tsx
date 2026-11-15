// @vitest-environment jsdom
// A card's swipe on a phone (useCardSwipe.ts) on a real element: one action on release, the lift's click swallowed,
// composed with another set of pointer handlers (the long press), and a drag that goes down is left to scrolling.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bothPress, useCardSwipe } from './useCardSwipe';

let root: Root;
let host: HTMLDivElement;
const pin = vi.fn();
const archive = vi.fn();
const otherDown = vi.fn();

function Card() {
  const swipe = useCardSwipe(true);
  return (
    <ul>
      <li className="sc-li" {...bothPress({ onPointerDown: otherDown }, swipe({ pin, pinned: false, archive }))}>
        <div className="sc-wrap"><a href="#open">open</a></div>
      </li>
    </ul>
  );
}

function pointer(el: Element, type: string, x: number, y = 10, timeStamp?: number) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  if (timeStamp !== undefined) Object.defineProperty(e, 'timeStamp', { value: timeStamp });
  Object.defineProperty(e, 'pointerType', { value: 'touch' });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  act(() => { el.dispatchEvent(e); });
}

function drag(el: Element, from: number, to: number, y = 10, endY = y) {
  pointer(el, 'pointerdown', from, y);
  for (let i = 1; i <= 6; i++) pointer(el, 'pointermove', from + ((to - from) * i) / 6, y + ((endY - y) * i) / 6);
  pointer(el, 'pointerup', to, endY);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  pin.mockReset(); archive.mockReset(); otherDown.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Card />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const li = () => host.querySelector('.sc-li')!;

describe('useCardSwipe on a card', () => {
  it('pins on a swipe right and archives on a swipe left, once each, and the other handlers still run', () => {
    drag(li(), 20, 200);
    expect(pin).toHaveBeenCalledTimes(1);
    expect(archive).not.toHaveBeenCalled();
    drag(li(), 250, 60);
    expect(archive).toHaveBeenCalledTimes(1);
    expect(pin).toHaveBeenCalledTimes(1);
    expect(otherDown).toHaveBeenCalledTimes(2);
  });

  it('swallows the click the lift makes, so a swipe never opens the session', () => {
    drag(li(), 20, 200);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { host.querySelector('a')!.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
  });

  it('lets the next real tap through: only a click right at the release is swallowed', async () => {
    drag(li(), 20, 200);
    await new Promise(r => setTimeout(r, 120));
    const tap = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { host.querySelector('a')!.dispatchEvent(tap); });
    expect(tap.defaultPrevented).toBe(false);
  });

  it('ignores a second finger while one swipes, and still acts once for the first', () => {
    const card = li();
    pointer(card, 'pointerdown', 20);
    for (const x of [40, 80, 120, 160]) pointer(card, 'pointermove', x);
    const second = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 300, clientY: 10 });
    Object.defineProperty(second, 'pointerType', { value: 'touch' });
    Object.defineProperty(second, 'pointerId', { value: 2 });
    act(() => { card.dispatchEvent(second); });
    pointer(card, 'pointermove', 200);
    pointer(card, 'pointerup', 200);
    expect(pin).toHaveBeenCalledTimes(1);
    expect((card as HTMLElement).dataset.swipe).toBeUndefined();
  });

  it('never swipes after a long press: a finger held still until the menu opens, then slid, does nothing', () => {
    const card = li();
    pointer(card, 'pointerdown', 20, 10, 1000);
    for (const x of [60, 120, 180, 240]) pointer(card, 'pointermove', x, 10, 2000);
    pointer(card, 'pointerup', 240, 10, 2100);
    expect(pin).not.toHaveBeenCalled();
    expect((card as HTMLElement).dataset.swipe).toBeUndefined();
  });

  it('leaves a drag that goes down to scrolling, and a short one acts on nothing', () => {
    drag(li(), 20, 40, 10, 200);
    drag(li(), 20, 40);
    expect(pin).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    expect((li() as HTMLElement).dataset.swipe).toBeUndefined();
    expect((li().firstElementChild as HTMLElement).style.transform).toBe('');
  });
});
