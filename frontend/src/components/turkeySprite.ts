// The Thanksgiving starfield's turkey (theme key starfieldTurkeys): drawn once
// onto an offscreen canvas, front-on so it reads as flying at the viewer, and
// stamped per turkey per frame with drawImage. Drawing the shapes for every
// turkey every frame would cost a dozen paths each.

export const TURKEY_SPRITE_SIZE = 128;

// Tail feathers, outermost first, each a band of two colours.
const FEATHERS: Array<[string, string]> = [
  ['#8a4b2a', '#f2b33d'],
  ['#b5432a', '#f6d27a'],
  ['#e07b2a', '#8a4b2a'],
  ['#f2b33d', '#b5432a'],
  ['#e07b2a', '#8a4b2a'],
  ['#b5432a', '#f6d27a'],
  ['#8a4b2a', '#f2b33d'],
];

/** The turkey on a TURKEY_SPRITE_SIZE square canvas, or null where there is no 2D context (jsdom). */
export function makeTurkeySprite(doc: Document = document): HTMLCanvasElement | null {
  const canvas = doc.createElement('canvas');
  canvas.width = TURKEY_SPRITE_SIZE;
  canvas.height = TURKEY_SPRITE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // Draw on a 64-unit grid; the sprite is drawn at 2x so large turkeys stay crisp.
  ctx.scale(TURKEY_SPRITE_SIZE / 64, TURKEY_SPRITE_SIZE / 64);

  // Tail fan behind the body, from lower left over the top to lower right.
  const fanX = 32, fanY = 38;
  FEATHERS.forEach(([outer, band], i) => {
    const angle = Math.PI * (-0.95 + (0.9 * i) / (FEATHERS.length - 1));
    ctx.save();
    ctx.translate(fanX, fanY);
    ctx.rotate(angle + Math.PI / 2);
    ctx.fillStyle = outer;
    ctx.beginPath();
    ctx.ellipse(0, -16, 6, 16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = band;
    ctx.beginPath();
    ctx.ellipse(0, -26, 4.5, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  // Feet.
  ctx.strokeStyle = '#e8902a';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (const x of [27, 37]) {
    ctx.beginPath();
    ctx.moveTo(x, 52);
    ctx.lineTo(x, 59);
    ctx.moveTo(x - 3, 61);
    ctx.lineTo(x, 59);
    ctx.lineTo(x + 3, 61);
    ctx.stroke();
  }

  // Body and belly.
  ctx.fillStyle = '#6b3f22';
  ctx.beginPath();
  ctx.ellipse(32, 41, 13, 14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#8f5d36';
  ctx.beginPath();
  ctx.ellipse(32, 45, 8, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  // Head.
  ctx.fillStyle = '#a0703f';
  ctx.beginPath();
  ctx.arc(32, 24, 8, 0, Math.PI * 2);
  ctx.fill();

  // Eyes.
  for (const x of [29, 35]) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, 22, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111111';
    ctx.beginPath();
    ctx.arc(x, 22.4, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }

  // Beak, then the wattle hanging beside it.
  ctx.fillStyle = '#f2a516';
  ctx.beginPath();
  ctx.moveTo(29.5, 25.5);
  ctx.lineTo(34.5, 25.5);
  ctx.lineTo(32, 29.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#d6332a';
  ctx.beginPath();
  ctx.ellipse(34.5, 30.5, 1.8, 3.4, -0.3, 0, Math.PI * 2);
  ctx.fill();

  return canvas;
}

// The splat a turkey leaves when it hits the screen: a cranberry-and-gravy
// blob with droplets thrown out around it and a few loose feathers. Drawn from
// a fixed seed, so every splat is the same mark (each is rotated when drawn).
const SPLAT_SEED = [0.13, 0.71, 0.42, 0.88, 0.27, 0.59, 0.05, 0.94, 0.36, 0.67, 0.19, 0.81, 0.52, 0.3, 0.76, 0.09];

/** The splat on a TURKEY_SPRITE_SIZE square canvas, or null where there is no 2D context (jsdom). */
export function makeSplatSprite(doc: Document = document): HTMLCanvasElement | null {
  const canvas = doc.createElement('canvas');
  canvas.width = TURKEY_SPRITE_SIZE;
  canvas.height = TURKEY_SPRITE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(TURKEY_SPRITE_SIZE / 64, TURKEY_SPRITE_SIZE / 64);
  const r = (i: number) => SPLAT_SEED[i % SPLAT_SEED.length];

  // The blob: a body with lobes round its edge, then droplets further out.
  ctx.fillStyle = '#8a2a1c';
  ctx.beginPath();
  ctx.ellipse(32, 32, 15, 12, 0, 0, Math.PI * 2);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + r(i) * 0.5;
    const d = 12 + r(i + 3) * 5;
    const rad = 3 + r(i + 5) * 3;
    ctx.moveTo(32 + Math.cos(a) * d + rad, 32 + Math.sin(a) * d);
    ctx.arc(32 + Math.cos(a) * d, 32 + Math.sin(a) * d, rad, 0, Math.PI * 2);
  }
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + r(i + 7) * 0.6;
    const d = 22 + r(i + 1) * 8;
    const rad = 0.8 + r(i + 9) * 1.6;
    ctx.moveTo(32 + Math.cos(a) * d + rad, 32 + Math.sin(a) * d);
    ctx.arc(32 + Math.cos(a) * d, 32 + Math.sin(a) * d, rad, 0, Math.PI * 2);
  }
  ctx.fill();

  // A darker gravy middle.
  ctx.fillStyle = '#5c2416';
  ctx.beginPath();
  ctx.ellipse(32, 33, 9, 7, 0.2, 0, Math.PI * 2);
  ctx.fill();

  // Loose feathers flung out from the impact.
  FEATHERS.forEach(([outer, band], i) => {
    const a = (i / FEATHERS.length) * Math.PI * 2 + r(i + 2);
    ctx.save();
    ctx.translate(32 + Math.cos(a) * 20, 32 + Math.sin(a) * 20);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillStyle = outer;
    ctx.beginPath();
    ctx.ellipse(0, 0, 2.6, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = band;
    ctx.beginPath();
    ctx.ellipse(0, -4.5, 2, 1.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  return canvas;
}
