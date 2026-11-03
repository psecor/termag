// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnchoredMenu, useMenuAnchor } from './AnchoredMenu';

// React Aria's overlays read a CSP nonce through CSS.escape, which jsdom lacks (as in GenUiSurface.test.tsx).
const css = globalThis as { CSS?: { escape?: (s: string) => string } };
css.CSS ??= {};
css.CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let el: HTMLDivElement;
const onRow = vi.fn();
const onStop = vi.fn();

/** A sidebar row in a clipping scroll area, with its ⋮, as ProjectControl draws one. */
function Row() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <div className="boxes-expanded" style={{ overflow: 'auto', maxHeight: 40 }}>
      <div className="box-item" onClick={onRow}>
        <button className="btn-overflow" onClick={e => { e.stopPropagation(); setAnchor(anchor ? null : e.currentTarget); }}>⋮</button>
        <AnchoredMenu anchor={anchor} onClose={() => setAnchor(null)}>
          <button onClick={() => { onStop(); setAnchor(null); }}>Stop box</button>
        </AnchoredMenu>
      </div>
    </div>
  );
}

beforeEach(() => {
  onRow.mockReset();
  onStop.mockReset();
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root.render(<Row />));
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

const menu = () => document.querySelector('.anchored-menu');

describe('AnchoredMenu', () => {
  it('draws the menu in a portal, outside the scroll area that would clip it', () => {
    expect(menu()).toBe(null);
    act(() => { (el.querySelector('.btn-overflow') as HTMLButtonElement).click(); });
    expect(menu()).not.toBe(null);
    expect(el.querySelector('.boxes-expanded')!.contains(menu())).toBe(false);
    expect(menu()!.classList.contains('project-menu')).toBe(true);
    // React Aria positions the popover itself (it computes top/left, flipping and shifting).
    expect((menu()!.closest('.anchored-menu-popover') as HTMLElement).style.position).toBe('absolute');
  });

  it('an item acts, and its click does not reach the row under the menu', () => {
    act(() => { (el.querySelector('.btn-overflow') as HTMLButtonElement).click(); });
    act(() => { ([...document.querySelectorAll('.anchored-menu button')].find(b => b.textContent === 'Stop box') as HTMLButtonElement).click(); });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onRow).not.toHaveBeenCalled();
    expect(menu()).toBe(null);
  });

  it('closes on Escape', () => {
    act(() => { (el.querySelector('.btn-overflow') as HTMLButtonElement).click(); });
    act(() => { menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(menu()).toBe(null);
  });
});

describe('useMenuAnchor: one menu open across the sidebar', () => {
  /** Two kinds of rows with their own open ids, as ProjectControl's project and box menus have. */
  function TwoKinds() {
    const menus = useMenuAnchor();
    const [projectOpen, setProjectOpen] = useState(false);
    const [boxOpen, setBoxOpen] = useState(false);
    return (
      <div>
        <button className="project-dots" onClick={e => { menus.claim('project:p1', e.currentTarget); setProjectOpen(o => !o); }}>⋮</button>
        <AnchoredMenu anchor={projectOpen ? menus.anchorFor('project:p1') : null} onClose={() => setProjectOpen(false)}>
          <button>Delete project</button>
        </AnchoredMenu>
        <button className="box-dots" onClick={e => { menus.claim('box:b1', e.currentTarget); setBoxOpen(o => !o); }}>⋮</button>
        <AnchoredMenu anchor={boxOpen ? menus.anchorFor('box:b1') : null} onClose={() => setBoxOpen(false)}>
          <button>Stop box</button>
        </AnchoredMenu>
      </div>
    );
  }

  it("opening the box menu leaves no project menu over it, though the project's open id is still set", () => {
    act(() => root.render(<TwoKinds />));
    act(() => { (el.querySelector('.project-dots') as HTMLButtonElement).click(); });
    expect([...document.querySelectorAll('.anchored-menu')].map(m => m.textContent)).toEqual(['Delete project']);
    // The project menu's own state isn't cleared (as in ProjectControl); the box's ⋮ is pressed through it.
    act(() => { (el.querySelector('.box-dots') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect([...document.querySelectorAll('.anchored-menu')].map(m => m.textContent)).toEqual(['Stop box']);
    // Closed by its own ⋮, then opened again: still the box's menu.
    act(() => { (el.querySelector('.box-dots') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.querySelectorAll('.anchored-menu')).toHaveLength(0);
    act(() => { (el.querySelector('.box-dots') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect([...document.querySelectorAll('.anchored-menu')].map(m => m.textContent)).toEqual(['Stop box']);
  });
});
