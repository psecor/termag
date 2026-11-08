import { useEffect, useMemo, useRef, useState } from 'react';
import { usePalette } from '../usePalette';
import { newNonce, readSpriteMessage, spriteDocument } from './spriteFrame';
import { MAX_DECOR_OPACITY } from './types';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
// Any coarse pointer, not just the primary one (the mobile redirect's
// TOUCH_MEDIA_QUERY): an iPad whose primary pointer is a trackpad still scrolls
// by touch, and the frame would stop that.
export const TOUCH_ANY_QUERY = '(any-pointer: coarse)';
const DEFAULT_OPACITY = 0.6;

function useMediaMatch(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const on = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

export const clampOpacity = (o: number | null) => Math.min(Math.max(o ?? DEFAULT_OPACITY, 0), MAX_DECOR_OPACITY);

/**
 * The day's sprite, run in a sandboxed frame over the whole page
 * (spriteFrame.ts): an opaque origin with no network, so the sprite's code
 * can't act as termag. The frame takes no clicks and is hidden from screen
 * readers; its opacity is set and capped here, and lint.ts keeps a day's CSS
 * off this element, so a day can't lift it. The frame caps the frame rate and
 * stops a sprite that throws or runs slow; then this removes the frame and the
 * rest of the day stays. The frame is invisible until its sprite says it started.
 *
 * Not on a touch screen (any coarse pointer): on iOS Safari a fixed full-screen
 * iframe over the page stops one-finger scrolling of what is under it, though
 * it has `pointer-events: none` and taps still go through (the simple UI's
 * transcript would not scroll, 2026-11-06). The day's colours still apply.
 */
export function DailyDecor({ source }: { source: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const palette = usePalette();
  const reducedMotion = useMediaMatch(REDUCED_MOTION_QUERY);
  const touch = useMediaMatch(TOUCH_ANY_QUERY);
  const [opacity, setOpacity] = useState<number | null>(null);
  const [stopped, setStopped] = useState(false);
  const doc = useMemo(() => spriteDocument(source, { palette, reducedMotion }, newNonce()), [source, palette, reducedMotion]);
  useEffect(() => setOpacity(null), [doc]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const m = readSpriteMessage(e.data);
      if (m?.type === 'ready') setOpacity(clampOpacity(m.opacity));
      else if (m?.type === 'stopped') {
        console.warn(`[daily-theme] sprite stopped: ${m.why}`);
        setStopped(true);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (stopped || touch) return null;
  return (
    <iframe
      ref={frameRef}
      className="daily-theme-decor"
      // Never add allow-same-origin: the sprite would run as termag.
      sandbox="allow-scripts"
      srcDoc={doc}
      title="Theme of the day decoration"
      aria-hidden="true"
      tabIndex={-1}
      style={{
        position: 'fixed', inset: 0, width: '100vw', height: '100vh', border: 0,
        background: 'transparent', colorScheme: palette,
        pointerEvents: 'none', zIndex: 90,
        opacity: opacity ?? 0,
      }}
    />
  );
}
