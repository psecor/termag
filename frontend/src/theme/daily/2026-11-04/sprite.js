// @ts-check
// A few leaves drifting down the page, swaying as they fall. Plain JavaScript,
// run in the sandboxed sprite frame (../spriteFrame.ts).
const COLORS = ['#d97706', '#b45309', '#f2a33a', '#9a3412', '#ca8a04'];
const COUNT = 18;

/** @param {import('../types').SpriteEnv} env */
function makeLeaves(env) {
  const leaves = [];
  for (let i = 0; i < COUNT; i++) {
    leaves.push({
      x: Math.random() * env.width,
      y: Math.random() * env.height,
      size: 7 + Math.random() * 7,
      speed: 12 + Math.random() * 18,
      sway: 14 + Math.random() * 22,
      phase: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 1.2,
      color: COLORS[i % COLORS.length],
    });
  }
  return leaves;
}

/** @type {import('../types').DailySprite} */
export default {
  opacity: 0.55,
  fps: 24,
  create(start) {
    let env = start;
    let leaves = makeLeaves(env);
    return {
      resize(next) { env = next; leaves = makeLeaves(env); },
      draw({ ctx, time, dt }) {
        const s = time / 1000;
        for (const leaf of leaves) {
          leaf.y += (leaf.speed * dt) / 1000;
          if (leaf.y > env.height + 20) { leaf.y = -20; leaf.x = Math.random() * env.width; }
          const x = leaf.x + Math.sin(s * 0.8 + leaf.phase) * leaf.sway;
          ctx.save();
          ctx.translate(x, leaf.y);
          ctx.rotate(Math.sin(s * 0.6 + leaf.phase) * 0.8 + leaf.spin * s);
          ctx.fillStyle = leaf.color;
          ctx.beginPath();
          ctx.ellipse(0, 0, leaf.size, leaf.size * 0.5, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = 'rgba(80, 40, 10, 0.6)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(-leaf.size, 0);
          ctx.lineTo(leaf.size * 1.3, 0);
          ctx.stroke();
          ctx.restore();
        }
      },
    };
  },
};
