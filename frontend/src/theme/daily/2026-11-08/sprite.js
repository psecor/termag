// @ts-check
// A faint new moon in the top-right corner, a dark disc with a thin earthshine
// rim, and a sparse scatter of small stars along the top and side edges that
// twinkle slowly. Plain JavaScript, run in the sandboxed sprite frame
// (../spriteFrame.ts).
const STAR_COUNT = 16;
const MOON_RADIUS = 14;
const MOON_INSET = 34;

/** @param {'dark' | 'light'} palette */
function colorsFor(palette) {
  return palette === 'light'
    ? { disc: 'rgba(63, 71, 159, 0.18)', rim: '#4a52b5', star: '#3f479f' }
    : { disc: 'rgba(20, 24, 48, 0.9)', rim: '#a9b4ff', star: '#dfe3ff' };
}

/**
 * Stars sit in a band along the top edge or down the left and right edges,
 * never over the middle of the page.
 * @param {number} width
 * @param {number} height
 */
function placeStars(width, height) {
  const stars = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    const edge = i % 3;
    let x;
    let y;
    if (edge === 0) {
      x = Math.random() * width;
      y = 6 + Math.random() * 40;
    } else {
      x = edge === 1 ? 6 + Math.random() * 36 : width - 6 - Math.random() * 36;
      y = 50 + Math.random() * Math.max(0, height - 100);
    }
    stars.push({
      x,
      y,
      r: 0.7 + Math.random() * 0.9,
      phase: Math.random() * Math.PI * 2,
      speed: 0.6 + Math.random() * 0.9,
    });
  }
  return stars;
}

/** @type {import('../types').DailySprite} */
export default {
  opacity: 0.55,
  fps: 20,
  create(start) {
    let env = start;
    let colors = colorsFor(env.palette);
    let stars = placeStars(env.width, env.height);
    let elapsed = 0;
    return {
      resize(next) {
        env = next;
        colors = colorsFor(env.palette);
        stars = placeStars(env.width, env.height);
      },
      draw({ ctx, dt }) {
        elapsed = (elapsed + dt / 1000) % 3600;

        ctx.fillStyle = colors.star;
        for (const s of stars) {
          ctx.globalAlpha = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(s.phase + elapsed * s.speed));
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;

        const mx = env.width - MOON_INSET;
        const my = MOON_INSET;
        ctx.fillStyle = colors.disc;
        ctx.beginPath();
        ctx.arc(mx, my, MOON_RADIUS, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = colors.rim;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(mx, my, MOON_RADIUS, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(mx, my, MOON_RADIUS, -Math.PI * 0.35, Math.PI * 0.35);
        ctx.stroke();
        ctx.globalAlpha = 1;
      },
    };
  },
};
