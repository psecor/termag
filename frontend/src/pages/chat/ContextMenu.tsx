// The simple UI's item menu, for sidebar tabs and explorer items. It opens
// from the item's ⋮ button (always shown on a touch screen, on hover or focus
// otherwise), on a right click at the pointer, or from the keyboard (the
// context menu key, or Shift+F10) under the focused item. All three give the
// same menu. Arrow keys, Home and End move through it, Enter picks, and
// Escape or Tab closes it and gives focus back to what opened it.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

export interface MenuAction { label: string; onSelect: () => void; disabled?: boolean }

/** A right click, the menu key or Shift+F10 on the item, or a click on its ⋮ button. */
export type MenuTrigger = React.MouseEvent | React.KeyboardEvent;

interface Open {
  key: string | null; label: string; actions: MenuAction[];
  /** At the pointer, or under the item; a ⋮ button's menu hangs from the button's right edge. */
  x: number; y: number; alignRight: boolean; above: number;
  /** A finger opened it, so no item is highlighted as if a keyboard were in play. */
  touch: boolean;
}

const COARSE = '(pointer: coarse)';
const coarseNow = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(COARSE).matches;
const onCoarseChange = (cb: () => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia(COARSE);
  mq.addEventListener?.('change', cb);
  return () => mq.removeEventListener?.('change', cb);
};

/** The main pointer is a finger: no hover, and no drag and drop. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(onCoarseChange, coarseNow, () => false);
}

/**
 * After a press outside an open menu closes it, the click that press makes
 * goes nowhere, as with the browser's own menus: on a phone, tapping away
 * from a menu would otherwise open whatever row was under the finger, and
 * pressing the ⋮ that opened it closes it rather than opening it again.
 */
export function swallowNextClick(): void {
  const swallow = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); done(); };
  const done = () => { document.removeEventListener('click', swallow, true); window.clearTimeout(timer); };
  const timer = window.setTimeout(done, 800);
  document.addEventListener('click', swallow, true);
}

/** Whether a key opens the context menu. */
export function isMenuKey(e: React.KeyboardEvent): boolean {
  return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
}

/** The ⋮ that opens an item's menu, and the same menu as a right click on the item. */
export function MenuButton({ label, open, expanded, className = '' }: {
  label: string; open: (e: React.MouseEvent) => void; expanded: boolean; className?: string;
}) {
  return (
    <button type="button" className={`item-menu-btn ${className}`.trim()} aria-label={`Options for ${label}`} aria-haspopup="menu"
      aria-expanded={expanded} data-tip="Options" onPointerDown={e => { e.currentTarget.dataset.pointer = e.pointerType; }} onClick={open}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <circle cx="8" cy="3.5" r="1.4" fill="currentColor" /><circle cx="8" cy="8" r="1.4" fill="currentColor" /><circle cx="8" cy="12.5" r="1.4" fill="currentColor" />
      </svg>
    </button>
  );
}

export function useContextMenu(): {
  /**
   * Opens the menu: for a contextmenu event at the pointer, for a key under
   * the focused element, for a click on a ⋮ button hanging from it. `key`
   * names the item, for its button's aria-expanded.
   */
  open: (e: MenuTrigger, label: string, actions: MenuAction[], key?: string) => void;
  /** The key of the item whose menu is open. */
  openKey: string | null;
  menu: React.ReactNode;
} {
  const [state, setState] = useState<Open | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const open = useCallback((e: MenuTrigger, label: string, actions: MenuAction[], key?: string) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    returnTo.current = el.matches('a,button,[tabindex]') ? el : el.querySelector<HTMLElement>('a,button') ?? el;
    const base = { key: key ?? null, label, actions };
    if (e.type === 'click') {
      const m = e as React.MouseEvent;
      // A click from Enter or Space has no pointer: the keyboard is in play.
      // Not every browser's click is a PointerEvent, so the button's own
      // pointerdown is the record of what pressed it.
      const pointer = (m.nativeEvent as PointerEvent).pointerType || el.dataset.pointer;
      delete el.dataset.pointer;
      const touch = m.detail > 0 && pointer === 'touch';
      setState({ ...base, x: r.right, y: r.bottom + 2, alignRight: true, above: r.top - 2, touch });
      return;
    }
    const at = 'clientX' in e && (e.clientX !== 0 || e.clientY !== 0);
    const p = e as React.MouseEvent;
    setState({ ...base, x: at ? p.clientX : r.left + 12, y: at ? p.clientY : r.bottom + 2, alignRight: false, above: at ? p.clientY : r.top - 2, touch: false });
  }, []);

  const close = useCallback((refocus: boolean) => {
    setState(null);
    if (refocus) returnTo.current?.focus();
  }, []);
  return { open, openKey: state?.key ?? null, menu: state ? <Menu state={state} close={close} /> : null };
}

function Menu({ state, close }: { state: Open; close: (refocus: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: state.y, left: state.x });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const x = state.alignRight ? state.x - w : state.x;
    // No room below: it opens upwards from the item, or from the pointer.
    const top = state.y + h > vh - 8 ? state.above - h : state.y;
    setPos({ left: Math.max(8, Math.min(x, vw - w - 8)), top: Math.max(8, top) });
    if (state.touch) el.focus();
    else el.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)')?.focus();
  }, [state]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      swallowNextClick();
      close(false);
    };
    const onScroll = (e: Event) => { if (!ref.current?.contains(e.target as Node)) close(false); };
    const onResize = () => close(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [close]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not(:disabled)') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); close(true); }
  };

  return createPortal(
    <div ref={ref} className="chat-add-menu chat-add-menu-fixed chat-ctx-menu" role="menu" aria-label={state.label} tabIndex={-1}
      style={{ top: pos.top, left: pos.left }} onKeyDown={onKeyDown} onContextMenu={e => e.preventDefault()}>
      {state.actions.map(a => (
        <button key={a.label} type="button" role="menuitem" tabIndex={-1} disabled={a.disabled}
          onMouseMove={e => { if (!a.disabled && document.activeElement !== e.currentTarget) e.currentTarget.focus(); }}
          onClick={() => { close(!state.touch); a.onSelect(); }}>
          <span className="chat-add-label">{a.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
