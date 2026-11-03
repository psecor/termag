// The simple UI's item menu, for sidebar tabs and explorer items. It opens
// from the item's ⋮ button (always shown on a touch screen, on hover or focus
// otherwise), on a right click at the pointer, or from the keyboard (the
// context menu key, or Shift+F10) under the focused item. All three give the
// same menu, LaunchPad's Menu in its Popover, so React Aria runs it: arrow
// keys, Home, End and typeahead move through it, Enter picks, and Escape or a
// press outside closes it and gives focus back. Nothing else does, so it
// stays open while an agent streams into the chat beside it. Something
// with no ⋮ (a space's head) opens its menu on a long press too (useLongPress).
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Menu as LpMenu, MenuItem, Popover } from '@launchpad-ui/components';
import { LP_THEME } from '../../launchpad/theme';

export interface MenuAction { label: string; onSelect: () => void; disabled?: boolean; /** A second, quieter line. */ hint?: string }

/** A right click, the menu key or Shift+F10 on the item, or a click on its ⋮ button. */
export type MenuTrigger = React.MouseEvent | React.KeyboardEvent;

interface Open {
  key: string | null; label: string; actions: MenuAction[];
  /**
   * It hangs from this (a ⋮ button), or from `point`: a right click's point
   * (`h` 0), or the item a key opened it under (2 px above it to 2 px below).
   */
  anchor?: HTMLElement; point?: { x: number; y: number; h: number };
  /** A finger opened it, so no item is highlighted as if a keyboard were in play: the menu itself has focus. */
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

/** Whether a key opens the context menu. */
export function isMenuKey(e: React.KeyboardEvent): boolean {
  return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
}

/**
 * A ⋮'s keys: Enter, Space and Down open its menu on the key, as React Aria's
 * MenuTrigger does, so focus goes straight to the first item. (Left to the
 * button's click, Enter is a click with no pointer, which React Aria takes
 * for a screen reader's and focuses the menu itself.)
 */
export function menuButtonKeys(open: (e: React.KeyboardEvent) => void): (e: React.KeyboardEvent) => void {
  return e => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') open(e); };
}

/** The ⋮ that opens an item's menu, and the same menu as a right click on the item. */
export function MenuButton({ label, open, expanded, className = '', tip = 'Options' }: {
  label: string; open: (e: MenuTrigger) => void; expanded: boolean; className?: string; tip?: string;
}) {
  return (
    <button type="button" className={`item-menu-btn ${className}`.trim()} aria-label={`Options for ${label}`} aria-haspopup="menu"
      aria-expanded={expanded} data-tip={tip} onPointerDown={e => { e.currentTarget.dataset.pointer = e.pointerType; }}
      onClick={open} onKeyDown={menuButtonKeys(open)}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <circle cx="8" cy="3.5" r="1.4" fill="currentColor" /><circle cx="8" cy="8" r="1.4" fill="currentColor" /><circle cx="8" cy="12.5" r="1.4" fill="currentColor" />
      </svg>
    </button>
  );
}

const LONG_PRESS_MS = 500;
/** How far a held finger may move, in px, before it is a scroll rather than a press. */
const LONG_PRESS_SLOP = 10;

type PressHandlers = Required<Pick<React.DOMAttributes<HTMLElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>>;

/** How long after a long press's lift a click on the pressed element is still the lift's. */
const LIFT_CLICK_MS = 400;

/**
 * Swallows the one click that a long press's lift may make on `el` (some
 * browsers send one, iOS and Android usually don't). The click has to be on
 * `el` and come within LIFT_CLICK_MS, so the next real tap elsewhere (on the
 * menu the press just opened) is never eaten, as a document-wide swallow
 * would be when no lift click comes.
 */
function swallowLiftClick(el: HTMLElement): void {
  const swallow = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); done(); };
  const done = () => { el.removeEventListener('click', swallow, true); window.clearTimeout(timer); };
  const timer = window.setTimeout(done, LIFT_CLICK_MS);
  el.addEventListener('click', swallow, true);
}

/**
 * A finger held on an element opens its menu, as a right click does: iOS
 * sends no contextmenu for one. Moving the finger is a scroll and cancels
 * it. Once the press fires the element captures the finger, so its lift
 * (and any move or cancel) still reaches it if the finger drifts off; a
 * plain tap is never captured, so its click lands where it was. The click a
 * lift makes on the element goes nowhere. Other pointers are left alone.
 * Returns the handlers for one element's `open`; one press at a time.
 */
export function useLongPress(): (open: (e: MenuTrigger) => void) => PressHandlers {
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean; el: HTMLElement } | null>(null);
  const clear = useCallback(() => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useEffect(() => clear, [clear]);
  return useMemo(() => (open: (e: MenuTrigger) => void): PressHandlers => ({
    onPointerDown: e => {
      if (e.pointerType !== 'touch') return;
      clear();
      const el = e.currentTarget as HTMLElement;
      const { clientX, clientY, pointerId } = e;
      const p = { x: clientX, y: clientY, fired: false, timer: 0, el };
      p.timer = window.setTimeout(() => {
        p.fired = true;
        try { el.setPointerCapture?.(pointerId); } catch { /* the pointer is already gone */ }
        // A stand-in for the contextmenu event: useContextMenu's open reads only the element, the point and the two calls.
        open({ type: 'contextmenu', target: el, currentTarget: el, clientX, clientY, nativeEvent: { pointerType: 'touch' }, preventDefault() {}, stopPropagation() {} } as unknown as React.MouseEvent);
      }, LONG_PRESS_MS);
      press.current = p;
    },
    onPointerMove: e => {
      const p = press.current;
      if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP) clear();
    },
    onPointerUp: () => {
      if (press.current?.fired) swallowLiftClick(press.current.el);
      clear();
    },
    onPointerCancel: clear,
  }), [clear]);
}

export function useContextMenu(): {
  /**
   * Opens the menu: for a contextmenu event at the pointer, for a key under
   * the focused element, for a click on a ⋮ button hanging from it. `key`
   * names the item, for its button's aria-expanded. With `anchor` (the
   * item's ⋮), any trigger hangs the menu from it, as its click does, so a
   * right click or a key gives the same menu in the same place.
   */
  open: (e: MenuTrigger, label: string, actions: MenuAction[], key?: string, anchor?: HTMLElement | null) => void;
  /** The key of the item whose menu is open. */
  openKey: string | null;
  menu: React.ReactNode;
} {
  const [state, setState] = useState<Open | null>(null);

  const open = useCallback((e: MenuTrigger, label: string, actions: MenuAction[], key?: string, anchor?: HTMLElement | null) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const base = { key: key ?? null, label, actions };
    // A finger's contextmenu (a long press, ours or the browser's) opens the menu in touch mode,
    // as a tap on a ⋮ does: no item highlighted.
    const fingered = e.type === 'contextmenu' && (e as React.MouseEvent).nativeEvent && ((e as React.MouseEvent).nativeEvent as PointerEvent).pointerType === 'touch';
    if (anchor && anchor !== el) { setState({ ...base, anchor, touch: fingered }); return; }
    if (e.type === 'click') {
      const m = e as React.MouseEvent;
      // Not every browser's click is a PointerEvent, so the button's own
      // pointerdown is the record of what pressed it.
      const pointer = (m.nativeEvent as PointerEvent).pointerType || el.dataset.pointer;
      delete el.dataset.pointer;
      setState({ ...base, anchor: el, touch: m.detail > 0 && pointer === 'touch' });
      return;
    }
    // A ⋮'s own key (menuButtonKeys).
    if (el.getAttribute('aria-haspopup') === 'menu') { setState({ ...base, anchor: el, touch: false }); return; }
    const r = el.getBoundingClientRect();
    const at = 'clientX' in e && (e.clientX !== 0 || e.clientY !== 0);
    const p = e as React.MouseEvent;
    setState({ ...base, point: at ? { x: p.clientX, y: p.clientY, h: 0 } : { x: r.left + 12, y: r.top - 2, h: r.height + 4 }, touch: fingered });
  }, []);

  const close = useCallback(() => setState(null), []);
  return { open, openKey: state?.key ?? null, menu: state ? <Menu state={state} close={close} /> : null };
}

/** A zero-width mark at the point, for the menu to hang from: React Aria's popovers hang from an element. */
function PointMark({ point, markRef }: { point: { x: number; y: number; h: number }; markRef: React.RefObject<HTMLSpanElement | null> }) {
  return createPortal(
    <span ref={markRef} aria-hidden="true" style={{ position: 'fixed', left: point.x, top: point.y, width: 0, height: point.h, pointerEvents: 'none' }} />,
    document.body,
  );
}

/**
 * LaunchPad's menu in LaunchPad's popover, a modal one, drawn as termag's
 * own menu (chat.css: the classes undo LaunchPad's look). The popover
 * renders at the end of the body, so it carries LP_THEME itself, as every
 * LaunchPad overlay must (launchpad/theme.css). It opens below
 * its ⋮, right edges aligned, or at its point, and 8 px inside the window,
 * as the hand-rolled menu it replaced did. React Aria moves focus into it
 * (onto the first item, except for a finger), gives it the arrow keys, Home,
 * End and typeahead, flips it above when there is no room below, holds the
 * page still under it, and closes it on Escape, a pick or a press
 * outside (which lands on its underlay, so nothing under it is clicked),
 * giving focus back to what had it. Nothing else closes it: not a re-render,
 * and not the chat's transcript scrolling to new output.
 */
function Menu({ state, close }: { state: Open; close: () => void }) {
  const markRef = useRef<HTMLSpanElement>(null);
  const anchorRef = useMemo(() => ({ current: state.anchor ?? null }), [state.anchor]);
  const triggerRef = state.point ? markRef : anchorRef;
  // The mark is committed with the popover, before React Aria measures it in its layout effects.
  return (
    <>
      {state.point && <PointMark point={state.point} markRef={markRef} />}
      <Popover triggerRef={triggerRef} isOpen onOpenChange={o => { if (!o) close(); }}
        placement={state.point ? 'bottom start' : 'bottom end'} offset={state.point ? 0 : 2} containerPadding={8}
        className={`${LP_THEME} chat-add-menu chat-ctx-popover`}>
        <LpMenu aria-label={state.label} className="chat-ctx-menu" autoFocus={state.touch ? true : 'first'}
          disabledKeys={state.actions.flatMap((a, i) => (a.disabled ? [String(i)] : []))}
          onAction={k => state.actions[Number(k)]?.onSelect()} onClose={close}>
          {state.actions.map((a, i) => (
            <MenuItem key={i} id={String(i)} textValue={a.label} className="chat-ctx-item">
              <span className="chat-add-label">{a.label}</span>
              {a.hint && <span className="chat-add-hint">{a.hint}</span>}
            </MenuItem>
          ))}
        </LpMenu>
      </Popover>
    </>
  );
}
