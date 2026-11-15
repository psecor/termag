// @ts-check
// A few soft wisps of fog drifting slowly left to right along the very bottom
// edge of the page, past a small sun low in the bottom-right corner. Plain
// JavaScript, run in the sandboxed sprite frame (../spriteFrame.ts).
const WISP_COUNT = 9;
const BAND_OFFSET = 4;
const SUN_RADIUS = 6;
const SUN_INSET = 16;

/** @param {'dark' | 'light'} palette */
function colorsFor(palette) {
  return palette === 'light'
    ? { fog: 'rgba(90, 110, 130, 1)', sun: '#e0a21a', halo: 'rgba(224, 162, 26, 0.25)' }
    : { fog: 'rgba(205, 220, 235, 1)', sun: '#ffd27a', halo: 'rgba(255, 210, 122, 0.22)' };
}

/** @param {number} width */
function placeWisps(width) {
  const wisps = [];
  for (let i = 0; i < WISP_COUNT; i++) {
    wisps.push({
      x: (width * (i + Math.random() * 0.6)) / WISP_COUNT,
      dy: (Math.random() - 0.5) * 2,
      rx: 40 + Math.random() * 50,
      ry: 2 + Math.random() * 1.5,
      alpha: 0.18 + Math.random() * 0.16,
      speed: 6 + Math.random() * 8,
    });
  }
  return wisps;
}

/** @type {import('../types').DailySprite} */
export default {
  opacity: 0.55,
  fps: 20,
  create(start) {
    let env = start;
    let colors = colorsFor(env.palette);
    let wisps = placeWisps(env.width);
    return {
      resize(next) {
        env = next;
        colors = colorsFor(env.palette);
        wisps = placeWisps(env.width);
      },
      draw({ ctx, dt }) {
        const sx = env.width - SUN_INSET;
        const sy = env.height - SUN_INSET;
        ctx.fillStyle = colors.halo;
        ctx.beginPath();
        ctx.arc(sx, sy, SUN_RADIUS + 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = colors.sun;
        ctx.beginPath();
        ctx.arc(sx, sy, SUN_RADIUS, 0, Math.PI * 2);
        ctx.fill();

        const baseY = env.height - BAND_OFFSET;
        ctx.fillStyle = colors.fog;
        for (const w of wisps) {
          w.x += (w.speed * dt) / 1000;
          if (w.x - w.rx > env.width) w.x = -w.rx;
          for (let k = 0; k < 3; k++) {
            ctx.globalAlpha = w.alpha * (1 - k * 0.3);
            ctx.beginPath();
            ctx.ellipse(w.x, baseY + w.dy, w.rx * (1 - k * 0.3), w.ry * (1 + k * 0.4), 0, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      },
    };
  },
};
