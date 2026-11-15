// @ts-check
// A small corner of a chessboard in the top-right corner with a pawn standing
// on it, and a sparse column of board squares drifting slowly down the left and
// right edges. Plain JavaScript, run in the sandboxed sprite frame
// (../spriteFrame.ts).
const SQUARE_COUNT = 14;
const BOARD_CELL = 8;
const BOARD_CELLS = 4;
const BOARD_INSET = 22;

/** @param {'dark' | 'light'} palette */
function colorsFor(palette) {
  return palette === 'light'
    ? { light: 'rgba(138, 84, 24, 0.22)', dark: '#7a4a14', piece: '#5c3810', edge: '#8a5418' }
    : { light: 'rgba(240, 217, 181, 0.55)', dark: '#9a6822', piece: '#f0d9b5', edge: '#e3b56b' };
}

/**
 * Squares sit in a narrow band down the left or right edge, never over the
 * middle of the page.
 * @param {number} width
 * @param {number} height
 */
function placeSquares(width, height) {
  const squares = [];
  for (let i = 0; i < SQUARE_COUNT; i++) {
    const left = i % 2 === 0;
    squares.push({
      x: left ? 8 + Math.random() * 28 : width - 14 - Math.random() * 28,
      y: Math.random() * height,
      size: 4 + Math.random() * 4,
      dark: Math.random() < 0.5,
      speed: 6 + Math.random() * 10,
    });
  }
  return squares;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx bottom-centre of the pawn
 * @param {number} by
 * @param {string} color
 */
function drawPawn(ctx, cx, by, color) {
  ctx.fillStyle = color;
  ctx.fillRect(cx - 7, by - 3, 14, 3);
  ctx.beginPath();
  ctx.moveTo(cx - 5, by - 3);
  ctx.lineTo(cx - 2.5, by - 13);
  ctx.lineTo(cx + 2.5, by - 13);
  ctx.lineTo(cx + 5, by - 3);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(cx - 4, by - 15, 8, 2);
  ctx.beginPath();
  ctx.arc(cx, by - 19, 4, 0, Math.PI * 2);
  ctx.fill();
}

/** @type {import('../types').DailySprite} */
export default {
  opacity: 0.55,
  fps: 20,
  create(start) {
    let env = start;
    let colors = colorsFor(env.palette);
    let squares = placeSquares(env.width, env.height);
    return {
      resize(next) {
        env = next;
        colors = colorsFor(env.palette);
        squares = placeSquares(env.width, env.height);
      },
      draw({ ctx, dt }) {
        const step = dt / 1000;
        for (const s of squares) {
          s.y += s.speed * step;
          if (s.y > env.height + 10) s.y = -10;
          ctx.fillStyle = s.dark ? colors.dark : colors.light;
          ctx.fillRect(s.x, s.y, s.size, s.size);
        }

        const size = BOARD_CELL * BOARD_CELLS;
        const bx = env.width - BOARD_INSET - size;
        const by = BOARD_INSET + 12;
        for (let r = 0; r < BOARD_CELLS; r++) {
          for (let c = 0; c < BOARD_CELLS; c++) {
            ctx.fillStyle = (r + c) % 2 === 0 ? colors.light : colors.dark;
            ctx.fillRect(bx + c * BOARD_CELL, by + r * BOARD_CELL, BOARD_CELL, BOARD_CELL);
          }
        }
        ctx.strokeStyle = colors.edge;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.7;
        ctx.strokeRect(bx - 0.5, by - 0.5, size + 1, size + 1);
        ctx.globalAlpha = 1;

        drawPawn(ctx, bx + BOARD_CELL * 1.5, by + BOARD_CELL * 1.5, colors.piece);
      },
    };
  },
};
