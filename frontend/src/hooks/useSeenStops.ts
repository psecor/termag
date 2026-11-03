// "Stopped since you looked": this browser's seen times
// (utils/unseenStops.ts) as state, kept in step with other tabs, and whether
// the page is on screen. The Lab's sidebar (ProjectControl) and termag's
// (pages/chat/simpleData.tsx) share it, so opening a session in either clears
// its marker in both.
import { useCallback, useEffect, useRef, useState } from 'react';
import { SEEN_STOPS_KEY, mergeSeenStops, readSeenStops, writeSeenStops, type SeenStops } from '../utils/unseenStops';

export interface SeenStopsState {
  seenStops: SeenStops;
  /** Apply a change over what storage holds now, and save it. */
  updateSeen: (fn: (s: SeenStops) => SeenStops) => void;
  /** The tab is visible: only then is the session on screen seen. */
  pageVisible: boolean;
}

export function useSeenStops(): SeenStopsState {
  const browserStorage = typeof localStorage !== 'undefined' ? localStorage : null;
  const [seenStops, setSeenStops] = useState<SeenStops>(() => readSeenStops(browserStorage, Date.now()));
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const onVisibility = () => setPageVisible(!document.hidden);
    // Another tab opened something: take its seen times.
    const onStorage = (e: StorageEvent) => {
      if (e.key === SEEN_STOPS_KEY) setSeenStops(readSeenStops(localStorage, Date.now()));
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('storage', onStorage);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  // Every change is applied over what storage holds now, merged with this
  // tab's view, and written at once: another tab may have saved since this
  // one last read, and a stale snapshot must not put its markers back.
  const seenRef = useRef(seenStops);
  seenRef.current = seenStops;
  const updateSeen = useCallback((fn: (s: SeenStops) => SeenStops) => {
    const base = mergeSeenStops(seenRef.current, readSeenStops(browserStorage, Date.now()));
    const next = fn(base);
    writeSeenStops(browserStorage, next);
    seenRef.current = next;
    setSeenStops(next);
  }, [browserStorage]);
  return { seenStops, updateSeen, pageVisible };
}
