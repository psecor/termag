import React, { useEffect, useRef, useState } from 'react';
import { ConnectionState, starfieldTargets } from '../utils/connection';

interface HyperspaceProps {
  activeCount: number;
  typingBoost?: boolean;
  targetWarp?: number;
  onWarpChange?: (warp: number) => void;
  /**
   * Backend reachability. The starfield is the one thing on screen that keeps
   * moving when the network silently dies, so it must carry the signal:
   * offline drifts to a stop and desaturates, degraded crawls in amber.
   */
  connection?: ConnectionState;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Tracks the OS/browser reduced-motion preference, and follows changes to it.
 *
 * A full-screen starfield that accelerates with activity is exactly the kind of
 * motion this setting exists to suppress, and users with vestibular sensitivity
 * have no other way to turn it off today.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(REDUCED_MOTION_QUERY).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

// Per-frame easing toward the connection look. 0.03 at ~60fps is a time
// constant of roughly half a second, so the drift-to-a-stop reads as a coast
// (about two seconds to settle) rather than a cut, and the colour shift lands
// in step with it.
const CONNECTION_EASE = 0.03;

export function Hyperspace({ activeCount, typingBoost, targetWarp, onWarpChange, connection = 'online' }: HyperspaceProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeCountRef = useRef(activeCount);
  activeCountRef.current = activeCount;
  const typingRef = useRef(typingBoost ?? false);
  typingRef.current = typingBoost ?? false;
  const targetWarpRef = useRef(targetWarp);
  targetWarpRef.current = targetWarp;
  const connectionRef = useRef<ConnectionState>(connection);
  connectionRef.current = connection;
  const warpRef = useRef(0.1);
  const onWarpChangeRef = useRef(onWarpChange);
  onWarpChangeRef.current = onWarpChange;
  // Reduced-motion mode renders a single frame; expose the draw so a
  // connection change can re-render that frame with the new tint.
  const drawOnceRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    const stars: Array<{ x: number; y: number; z: number; pz: number }> = [];
    const NUM_STARS = 600;

    function resize() {
      canvas!.width = canvas!.offsetWidth;
      canvas!.height = canvas!.offsetHeight;
    }

    resize();
    const resizeObs = new ResizeObserver(resize);
    resizeObs.observe(canvas);

    for (let i = 0; i < NUM_STARS; i++) {
      stars.push({
        x: (Math.random() - 0.5) * 2000,
        y: (Math.random() - 0.5) * 2000,
        z: Math.random() * 1000,
        pz: 0,
      });
    }

    let lastWarpUpdate = 0;

    // Eased connection look. Starts at the current state's targets so a page
    // that loads while offline doesn't animate from "healthy" first.
    const initial = starfieldTargets(connectionRef.current);
    let speedScale = initial.speedScale;
    let tintMix = initial.tintMix;
    let tint: [number, number, number] = [...initial.tint];

    function draw() {
      const w = canvas!.width;
      const h = canvas!.height;
      const count = activeCountRef.current;

      const fallbackBaseSpeed = count === 0 ? 0.4 : 0.4 + count * 2;
      const fallbackSpeed = fallbackBaseSpeed + (typingRef.current ? Math.max(0.4, fallbackBaseSpeed * 0.25) : 0);
      const fallbackWarp = fallbackSpeed <= 0.4 ? 0.1 : fallbackSpeed * 0.5;
      const requestedWarp = typeof targetWarpRef.current === 'number' ? targetWarpRef.current : fallbackWarp;

      // Ease toward the look for the current connection state. In reduced-
      // motion mode there is no per-frame loop, so snap instead.
      const want = starfieldTargets(connectionRef.current);
      const ease = prefersReducedMotion ? 1 : CONNECTION_EASE;
      speedScale += (want.speedScale - speedScale) * ease;
      tintMix += (want.tintMix - tintMix) * ease;
      tint = [
        tint[0] + (want.tint[0] - tint[0]) * ease,
        tint[1] + (want.tint[1] - tint[1]) * ease,
        tint[2] + (want.tint[2] - tint[2]) * ease,
      ];
      // Snap the tail so "stopped" is truly zero and trails don't creep.
      if (want.speedScale === 0 && speedScale < 0.005) speedScale = 0;

      const speed = (requestedWarp <= 0.1 ? 0.4 : requestedWarp * 2.75) * speedScale;

      warpRef.current += (requestedWarp - warpRef.current) * 0.15;

      // Push warp to parent at ~10fps
      const now = Date.now();
      if (now - lastWarpUpdate > 100) {
        lastWarpUpdate = now;
        try { onWarpChangeRef.current?.(warpRef.current); } catch { /* ok */ }
      }

      // Slower fade = longer trails. More opacity when active for even longer streaks.
      // While stopped, fade harder so the frozen frame settles to clean dots
      // instead of holding the last streaks indefinitely.
      const fadeAlpha = speedScale === 0 ? 0.2 : count === 0 ? 0.08 : Math.max(0.03, 0.06 - count * 0.005);
      ctx!.fillStyle = `rgba(13, 17, 23, ${fadeAlpha})`;
      ctx!.fillRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;

      for (const star of stars) {
        star.pz = star.z;
        star.z -= speed;

        if (star.z <= 0) {
          star.x = (Math.random() - 0.5) * 2000;
          star.y = (Math.random() - 0.5) * 2000;
          star.z = 1000;
          star.pz = 1000;
        }

        const sx = (star.x / star.z) * cx + cx;
        const sy = (star.y / star.z) * cy + cy;
        const px = (star.x / star.pz) * cx + cx;
        const py = (star.y / star.pz) * cy + cy;

        const depth = 1 - star.z / 1000;

        // Bigger stars, thicker lines when active
        const baseSize = count === 0 ? 5.5 : 6.5 + count * 0.8;
        const size = depth * baseSize;

        // Brighter base, even brighter when active
        const baseBright = count === 0 ? 160 : 200;
        const brightness = Math.floor(depth * 255) + baseBright;

        let r = Math.min(255, brightness);
        let g = Math.min(255, brightness + (count > 0 ? 30 : 15));
        let b = Math.min(255, brightness + (count > 0 ? 80 : 35));

        // Blend toward the connection tint. For offline this collapses the
        // blue-white palette to grey and dims it; for degraded it warms it.
        if (tintMix > 0.001) {
          const lum = (r + g + b) / 3;
          const dim = 1 - tintMix * 0.35;
          r = (r + (tint[0] * (lum / 255) - r) * tintMix) * dim;
          g = (g + (tint[1] * (lum / 255) - g) * tintMix) * dim;
          b = (b + (tint[2] * (lum / 255) - b) * tintMix) * dim;
        }

        const rs = Math.round(r), gs = Math.round(g), bs = Math.round(b);
        ctx!.strokeStyle = `rgb(${rs}, ${gs}, ${bs})`;
        ctx!.lineWidth = size;
        ctx!.lineCap = 'round';
        ctx!.beginPath();
        ctx!.moveTo(px, py);
        ctx!.lineTo(sx, sy);
        ctx!.stroke();

        // Add a glow dot at the head of close stars
        if (depth > 0.5) {
          const glowAlpha = (depth - 0.5) * 2; // 0→1 for the closest 50%
          ctx!.fillStyle = `rgba(${rs}, ${gs}, ${bs}, ${glowAlpha * 0.7})`;
          ctx!.beginPath();
          ctx!.arc(sx, sy, size * 2, 0, Math.PI * 2);
          ctx!.fill();
        }
      }

      // Reduced motion: render one static frame and stop. Skipping the loop
      // also stops the per-frame warp sampling that posts to the backend.
      if (!prefersReducedMotion) animId = requestAnimationFrame(draw);
    }

    drawOnceRef.current = draw;
    draw();

    return () => {
      cancelAnimationFrame(animId);
      resizeObs.disconnect();
      drawOnceRef.current = null;
    };
  }, [prefersReducedMotion]);

  // Reduced motion has no animation loop, so a connection change must redraw
  // the single frame by hand to pick up the new tint.
  useEffect(() => {
    if (prefersReducedMotion) drawOnceRef.current?.();
  }, [connection, prefersReducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', display: 'block', background: '#0d1117' }}
    />
  );
}
