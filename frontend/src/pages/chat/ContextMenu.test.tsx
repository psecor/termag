// @vitest-environment jsdom
// The item menu's popover is a LaunchPad overlay at the end of the body, so it
// carries lp-theme itself (launchpad/theme.css): without it LaunchPad's
// --lp-color-* tokens have no value there. It keeps termag's own palette, as
// before it was LaunchPad's: chromePaletteCss.test.ts holds the chrome
// refresh's palettes to skipping it.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LP_THEME } from '../../launchpad/theme';
import { MenuButton, useContextMenu } from './ContextMenu';

function Row() {
  const ctx = useContextMenu();
  const actions = [{ label: 'New agent', hint: 'Starts on its own box', onSelect: () => {} }, { label: 'Close file tabs', disabled: true, onSelect: () => {} }];
  const open = (e: React.MouseEvent | React.KeyboardEvent) => ctx.open(e, 'notes', actions, 'notes');
  return (
    <div className="row" onContextMenu={open}>
      notes <MenuButton label="notes" open={open} expanded={ctx.openKey === 'notes'} />
      {ctx.menu}
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Row />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const popover = () => document.querySelector<HTMLElement>('.chat-ctx-popover');
/** React Aria moves focus into a menu a click with no pointer opened a frame late. */
const nextFrame = () => act(async () => { await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))); });
const escape = () => act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });

describe('the item menu', () => {
  it('renders its popover in the body with lp-theme, from a ⋮ and from a right click', async () => {
    act(() => host.querySelector<HTMLElement>('button[aria-label="Options for notes"]')!.click());
    expect(popover()!.classList.contains(LP_THEME)).toBe(true);
    expect(host.contains(popover())).toBe(false);
    expect(popover()!.querySelector('.chat-ctx-menu')!.getAttribute('aria-label')).toBe('notes');
    await nextFrame();
    escape();
    expect(popover()).toBeNull();

    act(() => { host.querySelector('.row')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })); });
    expect(popover()!.classList.contains(LP_THEME)).toBe(true);
  });

  it('draws its rows as before: a title, and the grey hint under it', () => {
    act(() => host.querySelector<HTMLElement>('button[aria-label="Options for notes"]')!.click());
    const rows = [...popover()!.querySelectorAll('[role=menuitem]')];
    expect(rows.map(r => [r.querySelector('.chat-add-label')!.textContent, r.querySelector('.chat-add-hint')?.textContent ?? null])).toEqual([
      ['New agent', 'Starts on its own box'],
      ['Close file tabs', null],
    ]);
    expect(rows[1].getAttribute('aria-disabled')).toBe('true');
  });
});
