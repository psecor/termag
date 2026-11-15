// The simple UI's tooltips: one rounded bubble, styled like its menus,
// instead of the browser's box. It shows the `data-tip` of whatever the
// pointer rests on (after a moment) or keyboard focus reaches (at once). An
// element under .chat-root with a plain `title` has it moved to `data-tip`
// the first time, so the browser's own tooltip never shows; a title that was
// the element's only name becomes its aria-label. Frames keep their title,
// which names them.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { scrollMoves } from '../../utils/scrollMoves';

const DELAY_MS = 450;
const RETIP_EVENT = 'termag:retip';

/**
 * `el`'s data-tip just changed after it was pressed (a Copy link's "Link copied"): its bubble shows the new text now,
 * though the press that changed it hid the old one. With `onlyIfShown` (the text going back), only a bubble already up
 * for `el` changes, so none pops up after the pointer has gone. An `el` no longer on the page takes its bubble with it.
 */
export function retip(el: HTMLElement | null, onlyIfShown = false): void {
  if (el) document.dispatchEvent(new CustomEvent(RETIP_EVENT, { detail: { el, onlyIfShown } }));
}

function tipText(el: HTMLElement): string {
  const title = el.getAttribute('title');
  if (title != null) {
    el.removeAttribute('title');
    el.setAttribute('data-tip', title);
    if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && !el.textContent?.trim()) el.setAttribute('aria-label', title);
  }
  return el.getAttribute('data-tip') ?? '';
}

function tipTarget(t: EventTarget | null): HTMLElement | null {
  if (!(t instanceof Element)) return null;
  const el = t.closest<HTMLElement>('[data-tip],[title]');
  if (!el || el.tagName === 'IFRAME') return null;
  if (el.closest('.chat-root')) return el;
  // A dialog portalled out of .chat-root (New session's box picker) opts in with `data-tips`, for its own data-tip
  // only: a plain title there stays the browser's.
  return el.hasAttribute('data-tip') && el.closest('[data-tips]') ? el : null;
}

function focusVisible(el: Element): boolean {
  try { return el.matches(':focus-visible'); } catch { return false; }
}

export function Tooltips() {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect; over: boolean } | null>(null);
  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => { clearTimeout(timer); current = null; setTip(null); };
    const show = (el: HTMLElement, now: boolean) => {
      if (el === current) return;
      hide();
      const text = tipText(el);
      if (!text) return;
      current = el;
      const go = () => { if (current === el && el.isConnected) setTip({ text, rect: el.getBoundingClientRect(), over: !el.closest('.chat-root') }); };
      if (now) go(); else timer = setTimeout(go, DELAY_MS);
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = tipTarget(e.target);
      if (el) show(el, false);
      else if (current && !current.contains(e.target as Node)) hide();
    };
    const onFocus = (e: FocusEvent) => {
      const el = tipTarget(e.target);
      if (el && focusVisible(el)) show(el, true);
    };
    const onRetip = (e: Event) => {
      const { el, onlyIfShown } = (e as CustomEvent<{ el: HTMLElement; onlyIfShown: boolean }>).detail;
      if (!el) return;
      // Gone from the page (its view unmounted): its bubble goes with it.
      if (!el.isConnected) { if (el === current) hide(); return; }
      if (!el.closest('.chat-root') || (onlyIfShown && el !== current)) return;
      // Shown again, with the text it has now.
      current = null;
      show(el, true);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    // Only a scroll that moves the element: the chat streaming beside it leaves its tip up.
    const onScroll = (e: Event) => { if (scrollMoves(e, current)) hide(); };
    document.addEventListener('pointerover', onOver);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('dragstart', hide);
    document.addEventListener(RETIP_EVENT, onRetip);
    window.addEventListener('keydown', onKey);
    return () => {
      hide();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', hide);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('dragstart', hide);
      document.removeEventListener(RETIP_EVENT, onRetip);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  return tip ? <Bubble text={tip.text} rect={tip.rect} over={tip.over} /> : null;
}

/** `over`: its element is in a dialog outside .chat-root (data-tips), whose backdrop sits above the page's bubbles. */
function Bubble({ text, rect, over }: { text: string; rect: DOMRect; over: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const below = rect.bottom + 6;
    const top = below + h > window.innerHeight - 8 ? rect.top - h - 6 : below;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - 8));
    setPos({ top, left });
  }, [text, rect]);
  return createPortal(
    <div ref={ref} className="chat-tip" role="tooltip" data-over={over || undefined} style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}>{text}</div>,
    document.body,
  );
}
