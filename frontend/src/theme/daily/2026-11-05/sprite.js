// @ts-check
// A small Mars in the bottom-right corner with an orbiter on a tilted ellipse
// around it, and a few faint stars along the top and bottom edges. Plain
// JavaScript, run in the sandboxed sprite frame (../spriteFrame.ts).
const STAR_COUNT = 14;
const MARS_RADIUS = 14;
const ORBIT_RX = 32;
const ORBIT_RY = 11;
const ORBIT_TILT = -0.35;
const ORBIT_PERIOD_MS = 9000;

/** @param {import('../types').SpriteEnv} env */
function makeStars(env) {
  const stars = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    const band = env.height * 0.07;
    const upper = i % 2 === 0;
    stars.push({
      x: Math.random() * env.width,
      y: upper ? Math.random() * band : env.height - Math.random() * band,
      size: 1 + Math.random() * 1.5,
      phase: Math.random() * Math.PI * 2,
    });
  }
  return stars;
}

/** @param {'dark' | 'light'} palette */
function colorsFor(palette) {
  return palette === 'light'
    ? { mars: '#c1440e', shade: '#8a2f0a', cap: '#f3e6dc', probe: '#3a3f47', orbit: 'rgba(58, 63, 71, 0.35)', star: '#8a94a3' }
    : { mars: '#e2672f', shade: '#9a3a14', cap: '#fbefe6', probe: '#e6edf3', orbit: 'rgba(230, 237, 243, 0.3)', star: '#c9d1d9' };
}

/** @type {import('../types').DailySprite} */
export default {
  opacity: 0.5,
  fps: 24,
  create(start) {
    let env = start;
    let stars = makeStars(env);
    let colors = colorsFor(env.palette);
    let elapsed = 0;
    return {
      resize(next) { env = next; stars = makeStars(env); colors = colorsFor(env.palette); },
      draw({ ctx, dt }) {
        elapsed = (elapsed + dt) % (ORBIT_PERIOD_MS * 1000);
        const s = elapsed / 1000;
        ctx.fillStyle = colors.star;
        for (const star of stars) {
          ctx.globalAlpha = 0.5 + 0.5 * Math.sin(s * 1.5 + star.phase);
          ctx.fillRect(star.x, star.y, star.size, star.size);
        }
        ctx.globalAlpha = 1;

        const cx = env.width - 48;
        const cy = env.height - 48;
        const angle = ((elapsed % ORBIT_PERIOD_MS) / ORBIT_PERIOD_MS) * Math.PI * 2;
        const ox = Math.cos(angle) * ORBIT_RX;
        const oy = Math.sin(angle) * ORBIT_RY;
        const px = cx + ox * Math.cos(ORBIT_TILT) - oy * Math.sin(ORBIT_TILT);
        const py = cy + ox * Math.sin(ORBIT_TILT) + oy * Math.cos(ORBIT_TILT);
        const behind = Math.sin(angle) < 0;

        ctx.strokeStyle = colors.orbit;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(cx, cy, ORBIT_RX, ORBIT_RY, ORBIT_TILT, 0, Math.PI * 2);
        ctx.stroke();

        if (behind) drawProbe(ctx, px, py, colors.probe);

        ctx.fillStyle = colors.mars;
        ctx.beginPath();
        ctx.arc(cx, cy, MARS_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = colors.shade;
        ctx.beginPath();
        ctx.arc(cx + 4, cy + 3, MARS_RADIUS * 0.35, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = colors.cap;
        ctx.beginPath();
        ctx.ellipse(cx, cy - MARS_RADIUS + 2.5, 5, 2, 0, 0, Math.PI * 2);
        ctx.fill();

        if (!behind) drawProbe(ctx, px, py, colors.probe);
      },
    };
  },
};

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {string} color
 */
function drawProbe(ctx, x, y, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
  ctx.fillRect(x - 5, y - 0.5, 3, 1);
  ctx.fillRect(x + 2, y - 0.5, 3, 1);
}
