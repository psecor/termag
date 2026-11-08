// @ts-check
// A small sun half set behind a horizon line in the bottom-right corner, its
// glow slowly breathing, and a few warm specks drifting up along the bottom
// edge. Plain JavaScript, run in the sandboxed sprite frame (../spriteFrame.ts).
const SPECK_COUNT = 12;
const SUN_RADIUS = 13;
const HORIZON_HALF = 46;
const GLOW_PERIOD_S = 6;

/** @param {import('../types').SpriteEnv} env */
function makeSpecks(env) {
  const specks = [];
  for (let i = 0; i < SPECK_COUNT; i++) {
    specks.push({
      x: Math.random() * env.width,
      y: env.height - Math.random() * env.height * 0.08,
      size: 1 + Math.random() * 1.5,
      speed: 4 + Math.random() * 6,
      phase: Math.random() * Math.PI * 2,
    });
  }
  return specks;
}

/** @param {'dark' | 'light'} palette */
function colorsFor(palette) {
  return palette === 'light'
    ? { sun: '#e8794a', glow: 'rgba(214, 74, 110, 0.18)', horizon: 'rgba(120, 40, 70, 0.45)', speck: '#c2416b' }
    : { sun: '#ffb27a', glow: 'rgba(255, 158, 181, 0.2)', horizon: 'rgba(255, 190, 205, 0.45)', speck: '#ffc2d1' };
}

/** @type {import('../types').DailySprite} */
export default {
  opacity: 0.5,
  fps: 24,
  create(start) {
    let env = start;
    let specks = makeSpecks(env);
    let colors = colorsFor(env.palette);
    let elapsed = 0;
    return {
      resize(next) { env = next; specks = makeSpecks(env); colors = colorsFor(env.palette); },
      draw({ ctx, dt }) {
        elapsed = (elapsed + dt / 1000) % 3600;
        const band = env.height * 0.08;

        ctx.fillStyle = colors.speck;
        for (const speck of specks) {
          speck.y -= (speck.speed * dt) / 1000;
          if (speck.y < env.height - band) {
            speck.y = env.height;
            speck.x = Math.random() * env.width;
          }
          ctx.globalAlpha = 0.4 + 0.4 * Math.sin(elapsed * 1.2 + speck.phase);
          ctx.fillRect(speck.x, speck.y, speck.size, speck.size);
        }
        ctx.globalAlpha = 1;

        const cx = env.width - 52;
        const cy = env.height - 40;
        const breath = 0.5 + 0.5 * Math.sin((elapsed / GLOW_PERIOD_S) * Math.PI * 2);

        ctx.fillStyle = colors.glow;
        ctx.beginPath();
        ctx.arc(cx, cy, SUN_RADIUS * (2 + 0.3 * breath), Math.PI, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = colors.sun;
        ctx.beginPath();
        ctx.arc(cx, cy, SUN_RADIUS, Math.PI, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = colors.horizon;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - HORIZON_HALF, cy + 0.5);
        ctx.lineTo(cx + HORIZON_HALF, cy + 0.5);
        ctx.stroke();
      },
    };
  },
};
