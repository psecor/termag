import React, { useEffect, useRef, useState } from 'react';
import { ConnectionState, starfieldTargets } from '../utils/connection';
import { BASE_BACKGROUND_COLOR } from '../theme/schema';
import { TURKEY_SPRITE_SIZE, makeSplatSprite, makeTurkeySprite } from './turkeySprite';

interface HyperspaceProps {
  activeCount: number;
  typingBoost?: boolean;
  targetWarp?: number;
  /**
   * Backend reachability. The starfield is the one thing on screen that keeps
   * moving when the network silently dies, so it must carry the signal:
   * offline drifts to a stop and desaturates, degraded crawls in amber.
   */
  connection?: ConnectionState;
  /** Thanksgiving: little turkeys instead of stars (theme key starfieldTurkeys). */
  turkeys?: boolean;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Tracks the OS/browser reduced-motion preference, and follows changes to it.
 *
 * A full-screen starfield that accelerates with activity is exactly the kind of
 * motion this setting exists to suppress: it freezes the stars in place. To be
 * rid of them entirely, Settings → Appearance swaps in a solid colour.
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

// Turkeys are far bigger than stars, so fewer of them fill the screen.
const NUM_TURKEYS = 160;
// Each turkey's trail colour, picked at spawn: gold, amber, pumpkin, rust.
const TRAIL_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [255, 209, 102], [242, 179, 61], [224, 123, 42], [194, 65, 12],
];
// A turkey this close that is still on screen has hit it: it goes splat
// instead of flying past. Frames the splat lasts, about two thirds of a second.
const SPLAT_Z = 120;
const SPLAT_FRAMES = 40;
// Share of turkeys aimed at the viewer: spawned close enough to the centre
// line that they are still on screen at SPLAT_Z. The rest fly past the edges.
const SPLAT_SHARE = 0.12;

interface Splat { frames: number; x: number; y: number; size: number; angle: number }

export function Hyperspace({ activeCount, typingBoost, targetWarp, connection = 'online', turkeys = false }: HyperspaceProps) {
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
  // Reduced-motion mode renders a single frame; expose the draw so a
  // connection change can re-render that frame with the new tint.
  const drawOnceRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    // Null without a 2D context, which leaves the stars.
    const turkey = turkeys ? makeTurkeySprite() : null;
    const splatSprite = turkey ? makeSplatSprite() : null;
    // `spin` is each turkey's tumble phase and `hue` its trail colour; stars ignore both.
    // `splat` is set while a turkey that hit the screen is squashed there.
    const stars: Array<{ x: number; y: number; z: number; pz: number; spin: number; hue: number; splat: Splat | null }> = [];
    const NUM_STARS = turkey ? NUM_TURKEYS : 600;

    function resize() {
      canvas!.width = canvas!.offsetWidth;
      canvas!.height = canvas!.offsetHeight;
    }

    resize();
    const resizeObs = new ResizeObserver(resize);
    resizeObs.observe(canvas);

    // Where a star (or turkey) starts, across ±1000; a turkey aimed at the
    // viewer starts within SPLAT_Z of the centre line so it is in view when it hits.
    const spread = () => (turkey && Math.random() < SPLAT_SHARE ? SPLAT_Z * 2 : 2000);
    for (let i = 0; i < NUM_STARS; i++) {
      const range = spread();
      stars.push({
        x: (Math.random() - 0.5) * range,
        y: (Math.random() - 0.5) * range,
        z: Math.random() * 1000,
        pz: 0,
        spin: Math.random() * Math.PI * 2,
        hue: Math.floor(Math.random() * TRAIL_COLORS.length),
        splat: null,
      });
    }

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

      // Slower fade = longer trails. More opacity when active for even longer streaks.
      // While stopped, fade harder so the frozen frame settles to clean dots
      // instead of holding the last streaks indefinitely.
      // Turkeys fade hard: a long smear of sprites reads as mud, not a streak,
      // so their streak is a drawn trail instead.
      const fadeAlpha = turkey
        ? (speedScale === 0 ? 0.6 : 0.5)
        : speedScale === 0 ? 0.2 : count === 0 ? 0.08 : Math.max(0.03, 0.06 - count * 0.005);
      // BASE_BACKGROUND_COLOR as r, g, b. Dark only: App.tsx mounts no starfield in light.
      ctx!.fillStyle = `rgba(13, 17, 23, ${fadeAlpha})`;
      ctx!.fillRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;

      for (const star of stars) {
        // A squashed turkey stays where it hit, then flies in again from afar.
        // It plays out at any speed, so a stopped (offline) frame still clears.
        if (star.splat) {
          drawSplat(ctx!, turkey!, splatSprite, star.splat, tintMix);
          if (--star.splat.frames <= 0) {
            star.splat = null;
            const range = spread();
            star.x = (Math.random() - 0.5) * range;
            star.y = (Math.random() - 0.5) * range;
            star.z = 1000;
            star.pz = 1000;
          }
          continue;
        }

        star.pz = star.z;
        star.z -= speed;

        if (turkey && star.z < SPLAT_Z && star.z > 0) {
          const hx = (star.x / star.z) * cx + cx;
          const hy = (star.y / star.z) * cy + cy;
          if (hx > 0 && hx < w && hy > 0 && hy < h) {
            const d = 1 - star.z / 1000;
            star.splat = {
              frames: SPLAT_FRAMES,
              x: hx,
              y: hy,
              size: 6 + d * d * (count === 0 ? 70 : 80 + count * 4),
              angle: Math.random() * Math.PI * 2,
            };
            drawSplat(ctx!, turkey, splatSprite, star.splat, tintMix);
            star.splat.frames--;
            continue;
          }
        }

        if (star.z <= 0) {
          const range = spread();
          star.x = (Math.random() - 0.5) * range;
          star.y = (Math.random() - 0.5) * range;
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

        // A turkey's trail is its autumn colour, brighter as it nears.
        const autumn = turkey ? TRAIL_COLORS[star.hue] : null;
        const glow = 0.55 + depth * 0.45;
        let r = autumn ? autumn[0] * glow : Math.min(255, brightness);
        let g = autumn ? autumn[1] * glow : Math.min(255, brightness + (count > 0 ? 30 : 15));
        let b = autumn ? autumn[2] * glow : Math.min(255, brightness + (count > 0 ? 80 : 35));

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

        if (turkey) {
          // The trail runs back to where the turkey was a stretch of depth
          // ago, longer at warp, rather than one frame's travel.
          const tailZ = Math.min(1000, star.z + Math.min(260, 25 + speed * 16));
          const tx = (star.x / tailZ) * cx + cx;
          const ty = (star.y / tailZ) * cy + cy;
          drawTurkey(ctx!, turkey, star, sx, sy, tx, ty, depth, count, speedScale, tintMix, `rgb(${rs}, ${gs}, ${bs})`);
          continue;
        }

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

      // drawTurkey leaves its transform and alpha set rather than paying for
      // a save/restore per turkey; put them back once for the frame.
      if (turkey) {
        ctx!.setTransform(1, 0, 0, 1, 0, 0);
        ctx!.globalAlpha = 1;
      }

      // Reduced motion: render one static frame and stop. The sidebar speed
      // readout is stepped by its own timer (hooks/useEasedWarp.ts), so
      // nothing else depends on this loop running.
      if (!prefersReducedMotion) animId = requestAnimationFrame(draw);
    }

    drawOnceRef.current = draw;
    draw();

    return () => {
      cancelAnimationFrame(animId);
      resizeObs.disconnect();
      drawOnceRef.current = null;
    };
  }, [prefersReducedMotion, turkeys]);

  // Reduced motion has no animation loop, so a connection change must redraw
  // the single frame by hand to pick up the new tint.
  useEffect(() => {
    if (prefersReducedMotion) drawOnceRef.current?.();
  }, [connection, prefersReducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', display: 'block', background: BASE_BACKGROUND_COLOR }}
    />
  );
}

/**
 * One turkey at its projected position: a streak in its trail colour back to
 * (tx, ty), drawn like a star's, then the sprite, growing as it nears and
 * tumbling a little as it flies. Kept to one stroke and one drawImage: no
 * gradients, filters or save/restore, which cost too much at 160 a frame.
 * Leaves the transform and globalAlpha set; the caller resets them once.
 */
function drawTurkey(
  ctx: CanvasRenderingContext2D,
  sprite: HTMLCanvasElement,
  star: { spin: number },
  sx: number, sy: number, tx: number, ty: number,
  depth: number, count: number, speedScale: number, tintMix: number,
  trailColor: string,
) {
  const size = 6 + depth * depth * (count === 0 ? 70 : 80 + count * 4);

  if (speedScale > 0) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 0.25 + depth * 0.6;
    ctx.strokeStyle = trailColor;
    ctx.lineWidth = Math.max(1, size * 0.18);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(sx, sy);
    ctx.stroke();
    star.spin += 0.04 * speedScale;
  }

  // Offline dims the sprite; its trail carries the grey, from the caller's tint.
  ctx.globalAlpha = Math.min(1, 0.25 + depth) * (1 - tintMix * 0.35);
  const angle = Math.sin(star.spin) * 0.5;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  ctx.setTransform(cos, sin, -sin, cos, sx, sy);
  ctx.drawImage(sprite, 0, 0, TURKEY_SPRITE_SIZE, TURKEY_SPRITE_SIZE, -size / 2, -size / 2, size, size);
}

/**
 * A turkey that hit the screen: over the first few frames it flattens out
 * (wider, much shorter) as the splat mark spreads under it, holds there, then
 * both fade before it flies in again. Two drawImage calls, like drawTurkey's
 * one; leaves the transform and alpha for the caller to reset.
 */
function drawSplat(
  ctx: CanvasRenderingContext2D,
  turkey: HTMLCanvasElement,
  splatSprite: HTMLCanvasElement | null,
  splat: Splat,
  tintMix: number,
) {
  const t = 1 - splat.frames / SPLAT_FRAMES; // 0 at impact, 1 at the end
  const impact = Math.min(1, t / 0.15);
  const fade = t > 0.55 ? 1 - (t - 0.55) / 0.45 : 1;
  const dim = 1 - tintMix * 0.35;
  const size = splat.size;
  const cos = Math.cos(splat.angle), sin = Math.sin(splat.angle);

  if (splatSprite) {
    const spread = size * 1.7 * (0.4 + 0.6 * impact);
    ctx.globalAlpha = 0.9 * fade * dim;
    ctx.setTransform(cos, sin, -sin, cos, splat.x, splat.y);
    ctx.drawImage(splatSprite, 0, 0, TURKEY_SPRITE_SIZE, TURKEY_SPRITE_SIZE, -spread / 2, -spread / 2, spread, spread);
  }

  ctx.globalAlpha = fade * dim;
  ctx.setTransform(1 + 0.55 * impact, 0, 0, 1 - 0.6 * impact, splat.x, splat.y);
  ctx.drawImage(turkey, 0, 0, TURKEY_SPRITE_SIZE, TURKEY_SPRITE_SIZE, -size / 2, -size / 2, size, size);
}
