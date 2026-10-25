// "Keep screen on" while following an agent. A screen
// wake lock is dropped by the browser whenever the page is hidden, so it is
// taken again each time the page comes back while the toggle is on.
import { useEffect, useState } from 'react';

interface WakeLockSentinelLike { release(): Promise<void>; released?: boolean }
interface WakeLockLike { request(type: 'screen'): Promise<WakeLockSentinelLike> }

export function wakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

/** Returns whether the lock is currently held. */
export function useWakeLock(enabled: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!enabled || !wakeLockSupported()) { setHeld(false); return; }
    const wl = (navigator as Navigator & { wakeLock: WakeLockLike }).wakeLock;
    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return;
      try {
        const s = await wl.request('screen');
        if (cancelled) { void s.release(); return; }
        sentinel = s;
        setHeld(true);
        (s as unknown as EventTarget).addEventListener?.('release', () => { if (!cancelled) setHeld(false); });
      } catch {
        setHeld(false); // battery saver, or not allowed here
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void acquire(); };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (sentinel) void sentinel.release().catch(() => {});
      setHeld(false);
    };
  }, [enabled]);
  return held;
}
