// @vitest-environment jsdom
// The redesigned sidebar's keys (useListKeys.ts): focus follows a card that moves, and is never taken back once the
// person has moved it on.
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useListKeys, type CardKeyActions } from './useListKeys';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

/** A list of cards in two sections; `actions` act on the DOM directly, as a re-render would. */
function List({ actions }: { actions: Map<string, CardKeyActions> }) {
  const list = useRef<HTMLUListElement>(null);
  const map = useRef(actions);
  useListKeys(list, map, true);
  return (
    <ul ref={list}>
      <li><ul className="pinned" /></li>
      <li><ul className="rest">
        {['a', 'b', 'c'].map(k => (
          <li key={k} data-flip={`row:${k}`}>
            <div className="sc-wrap"><a href={`#${k}`} className="sc">{k}</a><span className="sc-over"><button type="button" className="sc-pin">pin</button></span></div>
          </li>
        ))}
      </ul></li>
    </ul>
  );
}
const card = (k: string) => host.querySelector<HTMLElement>(`[data-flip="row:${k}"] .sc`)!;
const key = (k: string, at: Element = document.activeElement!) => act(() => { at.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

describe('useListKeys', () => {
  it('follows a card that p moves at once', async () => {
    const actions = new Map<string, CardKeyActions>();
    actions.set('b', {
      // The optimistic pin moves the card synchronously: a new element in Pinned.
      pin: () => {
        card('b').closest('li')!.remove();
        const li = document.createElement('li');
        li.dataset.flip = 'row:b';
        li.innerHTML = '<div class="sc-wrap"><a href="#b" class="sc">b</a></div>';
        host.querySelector('.pinned')!.appendChild(li);
      },
    });
    act(() => root.render(<List actions={actions} />));
    card('b').focus();
    key('p');
    await settle();
    expect(document.activeElement).toBe(card('b'));
    expect(document.activeElement?.closest('.pinned')).not.toBeNull();
  });

  it('keeps focus on an archived card until it leaves, then moves on to the card in its place', async () => {
    const actions = new Map<string, CardKeyActions>([['a', { archive: () => {} }]]);
    act(() => root.render(<List actions={actions} />));
    card('a').focus();
    key('e');
    // It may ask first: nothing moves until the card has gone.
    expect(document.activeElement).toBe(card('a'));
    card('a').closest('li')!.remove();
    await settle();
    expect(document.activeElement).toBe(card('b'));
  });

  it("keeps watching while focus is on the card's own controls, then moves on once it leaves", async () => {
    const actions = new Map<string, CardKeyActions>([['a', { archive: () => {} }]]);
    act(() => root.render(<List actions={actions} />));
    const pin = card('a').closest('li')!.querySelector<HTMLElement>('.sc-pin')!;
    pin.focus();
    key('e');
    // A redraw while focus is on its Pin (a chip ticks) doesn't end the watch.
    card('c').textContent = 'c ';
    await settle();
    card('a').closest('li')!.remove();
    await settle();
    expect(document.activeElement).toBe(card('b'));
  });

  it('waits out a confirm that outlives the card, then puts focus in its place when the confirm closes', async () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'alertdialog');
    const ok = document.createElement('button');
    dialog.appendChild(ok);
    const actions = new Map<string, CardKeyActions>([['a', { archive: () => { document.body.appendChild(dialog); ok.focus(); } }]]);
    act(() => root.render(<List actions={actions} />));
    card('a').focus();
    key('e');
    expect(document.activeElement).toBe(ok);
    // Confirmed: the card leaves while the dialog still has focus, then the dialog closes with nothing to give it to.
    card('a').closest('li')!.remove();
    await settle();
    expect(document.activeElement).toBe(ok);
    act(() => { dialog.remove(); });
    await settle();
    expect(document.activeElement).toBe(card('b'));
  });

  it('archives with e, and never takes focus back once the person moved it', async () => {
    let archived = 0;
    const actions = new Map<string, CardKeyActions>([['a', { archive: () => { archived += 1; } }]]);
    act(() => root.render(<List actions={actions} />));
    card('a').focus();
    key('e');
    expect(archived).toBe(1);
    // They go to the composer; then the list redraws (the archived card leaves, a chip ticks).
    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    composer.focus();
    card('a').closest('li')!.remove();
    card('c').textContent = 'c ';
    await settle();
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });
});
