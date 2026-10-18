import { useEffect, useRef, useState } from 'react';
import { easeWarp } from '../utils/warp';

// How often the sidebar speed readout steps toward its target. The starfield
// used to report at this rate from its draw loop; a timer keeps the readout
// alive when the canvas is not mounted (solid background, the feature-flag kill switch)
// or not animating (reduced motion).
export const WARP_READOUT_INTERVAL_MS = 100;

export function useEasedWarp(target: number, initial = 0.1): number {
  const [warp, setWarp] = useState(initial);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const elapsed = now - last;
      last = now;
      // An unchanged value makes React skip the re-render, so a settled readout costs nothing.
      setWarp(current => easeWarp(current, targetRef.current, elapsed));
    }, WARP_READOUT_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return warp;
}
