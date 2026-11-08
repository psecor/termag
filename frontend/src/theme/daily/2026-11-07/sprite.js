// @ts-check
// A small three-car train gliding left to right along a thin track at the
// bottom of the page, with a few station dots on the line and a green signal
// that blinks softly at the right end. Plain JavaScript, run in the sandboxed
// sprite frame (../spriteFrame.ts).
const CAR_COUNT = 3;
const CAR_WIDTH = 22;
const CAR_HEIGHT = 8;
const CAR_GAP = 3;
const SPEED_PX_S = 40;
const STATION_COUNT = 5;
const TRACK_OFFSET = 10;

/** @param {'dark' | 'light'} palette */
function colorsFor(palette) {
  return palette === 'light'
    ? { car: '#14753f', pane: '#ffffff', track: 'rgba(20, 60, 40, 0.35)', station: '#11663a', signal: '#1fa45a' }
    : { car: '#5fd38d', pane: '#0d1117', track: 'rgba(170, 230, 195, 0.35)', station: '#8fe3b0', signal: '#7cf0a8' };
}

/** @type {import('../types').DailySprite} */
export default {
  opacity: 0.5,
  fps: 24,
  create(start) {
    let env = start;
    let colors = colorsFor(env.palette);
    const trainLength = CAR_COUNT * CAR_WIDTH + (CAR_COUNT - 1) * CAR_GAP;
    let x = env.width * 0.2;
    let elapsed = 0;
    return {
      resize(next) { env = next; colors = colorsFor(env.palette); },
      draw({ ctx, dt }) {
        elapsed = (elapsed + dt / 1000) % 3600;
        x += (SPEED_PX_S * dt) / 1000;
        if (x > env.width + 10) x = -trainLength - 10;

        const trackY = env.height - TRACK_OFFSET;

        ctx.strokeStyle = colors.track;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, trackY + 0.5);
        ctx.lineTo(env.width, trackY + 0.5);
        ctx.stroke();

        ctx.fillStyle = colors.station;
        for (let i = 1; i <= STATION_COUNT; i++) {
          const sx = (env.width * i) / (STATION_COUNT + 1);
          ctx.beginPath();
          ctx.arc(sx, trackY + 0.5, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }

        const carTop = trackY - CAR_HEIGHT - 2;
        for (let i = 0; i < CAR_COUNT; i++) {
          const cx = x + i * (CAR_WIDTH + CAR_GAP);
          ctx.fillStyle = colors.car;
          ctx.beginPath();
          ctx.roundRect(cx, carTop, CAR_WIDTH, CAR_HEIGHT, 2);
          ctx.fill();
          ctx.fillStyle = colors.pane;
          for (let w = 0; w < 3; w++) {
            ctx.fillRect(cx + 3 + w * 6.5, carTop + 2, 4, 2.5);
          }
        }

        const blink = 0.5 + 0.5 * Math.sin(elapsed * 2);
        ctx.globalAlpha = 0.4 + 0.6 * blink;
        ctx.fillStyle = colors.signal;
        ctx.beginPath();
        ctx.arc(env.width - 14, trackY - 14, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      },
    };
  },
};
