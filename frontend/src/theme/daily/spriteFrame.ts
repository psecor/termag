// The sandboxed frame a day's sprite runs in ("The
// sprite's frame"). A sprite is code an agent wrote from research on the web,
// so it never runs as termag: DailyDecor puts this document in an iframe with
// sandbox="allow-scripts" and nothing else (an opaque origin: no termag
// cookies, storage or DOM, no popups, forms or navigation), and its CSP allows
// only the scripts carrying this document's nonce and no network at all
// (default-src 'none': no fetch, no images, no fonts). The same shape as the
// Mermaid frame (chat/mermaid.ts). Never add allow-same-origin to that
// sandbox or a connect-src to this CSP.
//
// The page and the frame talk only through postMessage: the frame says
// `ready` (with the opacity the sprite asks for, which the page clamps) or
// `stopped`, and the page reads only its own frame's window.

import { MAX_DECOR_FPS } from './types';

export const SPRITE_MESSAGE = 'termag-daily-sprite';
// Frames this slow this many times in a row stop the sprite.
export const SLOW_FRAME_MS = 12;
export const SLOW_FRAME_LIMIT = 20;
export const MAX_DPR = 2;

export interface SpriteFrameSettings {
  palette: 'dark' | 'light';
  reducedMotion: boolean;
}

export type SpriteFrameMessage = { type: 'ready'; opacity: number | null } | { type: 'stopped'; why: string };

/** A message from a sprite frame, or null for anything else. Read nothing more from it. */
export function readSpriteMessage(data: unknown): SpriteFrameMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (m.source !== SPRITE_MESSAGE) return null;
  if (m.type === 'ready') return { type: 'ready', opacity: typeof m.opacity === 'number' && Number.isFinite(m.opacity) ? m.opacity : null };
  if (m.type === 'stopped') return { type: 'stopped', why: String(m.why ?? '').slice(0, 200) };
  return null;
}

/** A fresh nonce for one frame document. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// Runs first: any error from here on stops the sprite.
const guardScript = `
window.addEventListener('error', function (e) {
  parent.postMessage({ source: '${SPRITE_MESSAGE}', type: 'stopped', why: 'error: ' + (e && e.message) }, '*');
});`;

// Runs last: sizes the canvas, starts the sprite and drives its frames.
function runnerScript(settings: SpriteFrameSettings): string {
  const s = JSON.stringify({ ...settings, maxFps: MAX_DECOR_FPS, maxDpr: MAX_DPR, slowMs: SLOW_FRAME_MS, slowLimit: SLOW_FRAME_LIMIT });
  return `
(function () {
  var S = ${s};
  var post = function (m) { m.source = '${SPRITE_MESSAGE}'; parent.postMessage(m, '*'); };
  var sprite = window.__dailySprite;
  var canvas = document.getElementById('c');
  var ctx = canvas.getContext('2d');
  var dead = false;
  var stop = function (why) { if (!dead) { dead = true; post({ type: 'stopped', why: String(why) }); } };
  if (!sprite || typeof sprite.create !== 'function') return stop('no sprite');
  var env;
  var size = function () {
    var dpr = Math.min(window.devicePixelRatio || 1, S.maxDpr);
    var w = window.innerWidth, h = window.innerHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    env = { width: w, height: h, palette: S.palette, reducedMotion: S.reducedMotion };
  };
  size();
  var inst;
  try { inst = sprite.create(env); } catch (e) { return stop('create threw: ' + e); }
  if (!inst || typeof inst.draw !== 'function') return stop('create returned no draw');
  var fps = Math.min(Math.max(Number(sprite.fps) || 24, 1), S.maxFps);
  var frameMs = 1000 / fps, start = performance.now(), last = 0, slow = 0;
  var drawAt = function (now) {
    var t0 = performance.now();
    try {
      ctx.save();
      ctx.clearRect(0, 0, env.width, env.height);
      inst.draw({ ctx: ctx, width: env.width, height: env.height, palette: env.palette, reducedMotion: env.reducedMotion, time: now - start, dt: last ? now - last : 0 });
    } catch (e) { return stop('draw threw: ' + e); } finally { ctx.restore(); }
    last = now;
    slow = performance.now() - t0 > S.slowMs ? slow + 1 : 0;
    if (slow >= S.slowLimit) stop('frames too slow');
  };
  window.addEventListener('resize', function () {
    if (dead) return;
    size();
    try { if (inst.resize) inst.resize(env); } catch (e) { return stop('resize threw: ' + e); }
    if (S.reducedMotion) drawAt(start);
  });
  post({ type: 'ready', opacity: typeof sprite.opacity === 'number' ? sprite.opacity : null });
  if (S.reducedMotion) { drawAt(start); return; }
  var tick = function (now) {
    if (dead) return;
    // Browsers stop animation frames for a hidden page, but don't count on it.
    if (!document.hidden && now - last >= frameMs) drawAt(now);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;
}

/**
 * The frame document for a sprite's source (a day's sprite.js). Its one
 * `export default` (lint.ts holds it to exactly one, at the start of a line)
 * becomes window.__dailySprite in a script of its own, between the guard and
 * the runner, all three carrying `nonce`.
 */
export function spriteDocument(source: string, settings: SpriteFrameSettings, nonce: string): string {
  const n = nonce.replace(/[^\w-]/g, '');
  const csp = `default-src 'none'; script-src 'nonce-${n}'; style-src 'unsafe-inline'`;
  const safe = (js: string) => js.replace(/<\/script/gi, '<\\/script');
  const sprite = source.replace(/^export default\s/m, 'window.__dailySprite = ');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<style>',
    `html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; color-scheme: ${settings.palette}; }`,
    'canvas { display: block; }',
    '</style></head><body><canvas id="c"></canvas>',
    `<script nonce="${n}">${safe(guardScript)}</script>`,
    `<script nonce="${n}">${safe(sprite)}</script>`,
    `<script nonce="${n}">${safe(runnerScript(settings))}</script>`,
    '</body></html>',
  ].join('\n');
}
