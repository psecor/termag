// The simple UI's tooltips: one rounded bubble, styled like its menus,
// instead of the browser's box. It shows the `data-tip` of whatever the
// pointer rests on (after a moment) or keyboard focus reaches (at once). An
// element under .chat-root with a plain `title` has it moved to `data-tip`
// the first time, so the browser's own tooltip never shows; a title that was
// the element's only name becomes its aria-label. Frames keep their title,
// which names them. Without `titles` (simple-ui-side-panel-enabled off) only
// `data-tip` is shown and every `title` stays the browser's, as on main.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const DELAY_MS = 450;

function tipText(el: HTMLElement, titles: boolean): string {
  const title = titles ? el.getAttribute('title') : null;
  if (title != null) {
    el.removeAttribute('title');
    el.setAttribute('data-tip', title);
    if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && !el.textContent?.trim()) el.setAttribute('aria-label', title);
  }
  return el.getAttribute('data-tip') ?? '';
}

function tipTarget(t: EventTarget | null, titles: boolean): HTMLElement | null {
  if (!(t instanceof Element)) return null;
  const el = t.closest<HTMLElement>(titles ? '[data-tip],[title]' : '[data-tip]');
  if (!el || el.tagName === 'IFRAME' || !el.closest('.chat-root')) return null;
  return el;
}

function focusVisible(el: Element): boolean {
  try { return el.matches(':focus-visible'); } catch { return false; }
}

export function Tooltips({ titles }: { titles: boolean }) {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => { clearTimeout(timer); current = null; setTip(null); };
    const show = (el: HTMLElement, now: boolean) => {
      if (el === current) return;
      hide();
      const text = tipText(el, titles);
      if (!text) return;
      current = el;
      const go = () => { if (current === el && el.isConnected) setTip({ text, rect: el.getBoundingClientRect() }); };
      if (now) go(); else timer = setTimeout(go, DELAY_MS);
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = tipTarget(e.target, titles);
      if (el) show(el, false);
      else if (current && !current.contains(e.target as Node)) hide();
    };
    const onFocus = (e: FocusEvent) => {
      const el = tipTarget(e.target, titles);
      if (el && focusVisible(el)) show(el, true);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    document.addEventListener('pointerover', onOver);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide);
    document.addEventListener('scroll', hide, true);
    document.addEventListener('dragstart', hide);
    window.addEventListener('keydown', onKey);
    return () => {
      hide();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', hide);
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('dragstart', hide);
      window.removeEventListener('keydown', onKey);
    };
  }, [titles]);
  return tip ? <Bubble text={tip.text} rect={tip.rect} /> : null;
}

function Bubble({ text, rect }: { text: string; rect: DOMRect }) {
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
    <div ref={ref} className="chat-tip" role="tooltip" style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}>{text}</div>,
    document.body,
  );
}
