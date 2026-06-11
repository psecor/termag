import React, { useEffect, useRef } from 'react';

interface HyperspaceProps {
  activeCount: number;
  typingBoost?: boolean;
  targetWarp?: number;
  onWarpChange?: (warp: number) => void;
}

export function Hyperspace({ activeCount, typingBoost, targetWarp, onWarpChange }: HyperspaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeCountRef = useRef(activeCount);
  activeCountRef.current = activeCount;
  const typingRef = useRef(typingBoost ?? false);
  typingRef.current = typingBoost ?? false;
  const targetWarpRef = useRef(targetWarp);
  targetWarpRef.current = targetWarp;
  const warpRef = useRef(0.1);
  const onWarpChangeRef = useRef(onWarpChange);
  onWarpChangeRef.current = onWarpChange;

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

    function draw() {
      const w = canvas!.width;
      const h = canvas!.height;
      const count = activeCountRef.current;

      const fallbackBaseSpeed = count === 0 ? 0.4 : 0.4 + count * 2;
      const fallbackSpeed = fallbackBaseSpeed + (typingRef.current ? Math.max(0.8, fallbackBaseSpeed * 0.5) : 0);
      const fallbackWarp = fallbackSpeed <= 0.4 ? 0.1 : fallbackSpeed * 0.5;
      const requestedWarp = typeof targetWarpRef.current === 'number' ? targetWarpRef.current : fallbackWarp;
      const speed = requestedWarp <= 0.1 ? 0.4 : requestedWarp * 2.75;

      warpRef.current += (requestedWarp - warpRef.current) * 0.15;

      // Push warp to parent at ~10fps
      const now = Date.now();
      if (now - lastWarpUpdate > 100) {
        lastWarpUpdate = now;
        try { onWarpChangeRef.current?.(warpRef.current); } catch { /* ok */ }
      }

      // Slower fade = longer trails. More opacity when active for even longer streaks.
      const fadeAlpha = count === 0 ? 0.08 : Math.max(0.03, 0.06 - count * 0.005);
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

        const r = Math.min(255, brightness);
        const g = Math.min(255, brightness + (count > 0 ? 30 : 15));
        const b = Math.min(255, brightness + (count > 0 ? 80 : 35));

        ctx!.strokeStyle = `rgb(${r}, ${g}, ${b})`;
        ctx!.lineWidth = size;
        ctx!.lineCap = 'round';
        ctx!.beginPath();
        ctx!.moveTo(px, py);
        ctx!.lineTo(sx, sy);
        ctx!.stroke();

        // Add a glow dot at the head of close stars
        if (depth > 0.5) {
          const glowAlpha = (depth - 0.5) * 2; // 0→1 for the closest 50%
          ctx!.fillStyle = `rgba(${r}, ${g}, ${b}, ${glowAlpha * 0.7})`;
          ctx!.beginPath();
          ctx!.arc(sx, sy, size * 2, 0, Math.PI * 2);
          ctx!.fill();
        }
      }

      animId = requestAnimationFrame(draw);
    }

    draw();

    return () => {
      cancelAnimationFrame(animId);
      resizeObs.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', display: 'block', background: '#0d1117' }}
    />
  );
}
