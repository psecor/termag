// The phone client's scrolling list with pull to refresh: drop-in for `<main className="m-scroll">`. The touch listeners are
// registered by hand because React's are passive, and a pull must be able to
// cancel the page's own rubber-band bounce.
import React, { useEffect, useRef, useState } from 'react';
import { PULL_IDLE, PULL_TRIGGER_PX, PullState, pullEnd, pullMove, pullStart } from '../../mobile/pullToRefresh';
import { useMobileRefresh } from '../../mobile/useMobileRefresh';

export function PullScroll({ onRefresh, className = 'm-scroll', role, children }: {
  /** Extra work beyond the shared refresh (re-read the project list, reconnect). */
  onRefresh?: () => unknown;
  className?: string;
  role?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const state = useRef<PullState>(PULL_IDLE);
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useMobileRefresh(onRefresh);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { state.current = PULL_IDLE; return; }
      state.current = pullStart(el.scrollTop, e.touches[0].clientY);
    };
    const onMove = (e: TouchEvent) => {
      if (state.current.startY == null) return;
      const next = pullMove(state.current, e.touches[0].clientY);
      state.current = next;
      setDistance(next.distance);
      if (next.distance > 0 && e.cancelable) e.preventDefault();
    };
    const onEnd = () => {
      const { refresh: go, next } = pullEnd(state.current);
      state.current = next;
      setDistance(0);
      if (!go) return;
      setRefreshing(true);
      Promise.resolve(refreshRef.current()).finally(() => setRefreshing(false));
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  const shown = refreshing ? PULL_TRIGGER_PX * 0.6 : distance;
  const armed = distance >= PULL_TRIGGER_PX;
  return (
    <main ref={ref} className={className} role={role}>
      <div
        className="m-pull"
        style={{ height: shown }}
        data-armed={armed || undefined}
        data-refreshing={refreshing || undefined}
        aria-hidden={!refreshing}
        role="status"
      >
        {(shown > 0) && <span className="m-pull-label">{refreshing ? 'Refreshing…' : armed ? 'Release to refresh' : 'Pull to refresh'}</span>}
      </div>
      {children}
    </main>
  );
}
