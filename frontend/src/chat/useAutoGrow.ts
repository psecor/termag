// The chat composer grows with what is typed, up to a few lines, then scrolls.
import { useLayoutEffect, useRef } from 'react';

export const COMPOSER_MAX_ROWS = 8;

export interface GrowMetrics {
  /** The textarea's scrollHeight with its height set to auto: content plus padding. */
  scrollHeight: number;
  lineHeight: number;
  paddingY: number;
  borderY: number;
  maxRows: number;
}

/** The border-box height to give the textarea, and whether it must scroll. */
export function autoGrowHeight(m: GrowMetrics): { height: number; scroll: boolean } {
  const max = m.lineHeight * m.maxRows + m.paddingY + m.borderY;
  const want = m.scrollHeight + m.borderY;
  return want > max ? { height: Math.ceil(max), scroll: true } : { height: Math.ceil(want), scroll: false };
}

function px(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** Sizes the textarea to its value on every change; its CSS min-height still applies. */
export function useAutoGrow<T extends HTMLTextAreaElement>(value: string, maxRows = COMPOSER_MAX_ROWS) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cs = window.getComputedStyle(el);
    const fontSize = px(cs.fontSize) || 14;
    const lineHeight = cs.lineHeight === 'normal' || !px(cs.lineHeight) ? fontSize * 1.45 : px(cs.lineHeight);
    el.style.height = 'auto';
    const { height, scroll } = autoGrowHeight({
      scrollHeight: el.scrollHeight,
      lineHeight,
      paddingY: px(cs.paddingTop) + px(cs.paddingBottom),
      borderY: px(cs.borderTopWidth) + px(cs.borderBottomWidth),
      maxRows,
    });
    el.style.height = `${height}px`;
    el.style.overflowY = scroll ? 'auto' : 'hidden';
  }, [value, maxRows]);
  return ref;
}
