// A mouse drag that spans a terminal pane's unmount, in Chromium. This runs the
// real Terminal component (frontend/src/components/Terminal.tsx) against a
// stand-in socket that turns mouse tracking on, presses in the pane, unmounts
// it, moves and releases, then drags and clicks elsewhere on the page. It
// reports the page errors and the input the pane sent at each step, and the
// mouse listeners left on the document.
//
//   PLAYWRIGHT_MODULE=<dir>/node_modules/playwright/index.mjs \
//     node scripts/terminal-dispose-drag/repro.mjs [--repo <termag checkout>] \
//       [--xterm <dir> --fit <dir> --web-links <dir>] [--out <file.json>]
//
// --repo is the checkout whose Terminal.tsx runs (default: this one), so one
// copy of the script runs against main and against a branch. --xterm, --fit
// and --web-links swap in other xterm and addon package directories, such as
// @xterm/xterm 6.0.0 with @xterm/addon-fit 0.11.0 and addon-web-links 0.12.0.
// --out writes everything seen as JSON, to diff the live input of two runs.
// Exits 1 when the live pane throws or anything after the unmount throws,
// sends input or leaves a mouse listener on the document, and 2 when frontend/
// has no node_modules/esbuild.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const repo = resolve(opt('repo', join(dirname(fileURLToPath(import.meta.url)), '../..')));
const frontend = join(repo, 'frontend');
if (!existsSync(join(frontend, 'node_modules/esbuild'))) {
  console.error(`no frontend/node_modules/esbuild under ${repo}: run npm ci in frontend/`);
  process.exit(2);
}
const pkg = {
  xterm: resolve(opt('xterm', join(frontend, 'node_modules/xterm'))),
  '@xterm/addon-fit': resolve(opt('fit', join(frontend, 'node_modules/@xterm/addon-fit'))),
  '@xterm/addon-web-links': resolve(opt('web-links', join(frontend, 'node_modules/@xterm/addon-web-links'))),
};
const versionOf = dir => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const out = opt('out', null);
const playwrightPath = process.env.PLAYWRIGHT_MODULE ?? '/opt/playwright/node_modules/playwright/index.mjs';
const { chromium } = await import(playwrightPath);
const esbuild = createRequire(join(frontend, 'package.json'))('esbuild');

const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Terminal } from './src/components/Terminal';

const w = window as any;
w.__phase = 'mount';
w.__errors = [];
w.__sent = [];
w.__eventsDuringUnmount = [];
addEventListener('error', e => { w.__errors.push({ phase: w.__phase, message: e.message, stack: e.error?.stack ?? '' }); });
for (const type of ['mousedown', 'mousemove', 'mouseup', 'click', 'pointerdown', 'pointermove', 'pointerup']) {
  addEventListener(type, () => { if (w.__phase === 'unmount') w.__eventsDuringUnmount.push(type); }, true);
}

const docMouse = new Set<string>();
const keyOf = new WeakMap<object, number>();
let nextKey = 0;
const listenerKey = (type: string, fn: any, o: any) => {
  if (!keyOf.has(fn)) keyOf.set(fn, nextKey++);
  return type + '#' + keyOf.get(fn) + (o === true || o?.capture ? 'c' : '');
};
const add = Document.prototype.addEventListener;
const remove = Document.prototype.removeEventListener;
Document.prototype.addEventListener = function (this: Document, type: string, fn: any, o?: any) {
  if (fn && /^mouse/.test(type)) docMouse.add(listenerKey(type, fn, o));
  return add.call(this, type, fn, o);
} as typeof add;
Document.prototype.removeEventListener = function (this: Document, type: string, fn: any, o?: any) {
  if (fn && /^mouse/.test(type)) docMouse.delete(listenerKey(type, fn, o));
  return remove.call(this, type, fn, o);
} as typeof remove;
w.__docMouseListeners = () => [...docMouse].map(k => k.split('#')[0]).sort();

class PaneSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { w.__socket = this; setTimeout(() => { this.readyState = 1; this.onopen?.(); }); }
  send(data: string) { w.__sent.push({ phase: w.__phase, ...JSON.parse(data) }); }
  close() { this.readyState = 3; }
}
w.WebSocket = PaneSocket;
w.__output = (data: string) => w.__socket.onmessage({ data: JSON.stringify({ type: 'output', data }) });

const root = createRoot(document.getElementById('pane')!);
w.__mount = () => flushSync(() => root.render(<Terminal sessionName="dev-repro-ctrl" active />));
w.__unmount = () => {
  w.__phase = 'unmount';
  root.unmount();
  w.__socketClosedByUnmount = w.__socket.readyState === 3;
  w.__phase = 'after unmount';
};
`;

const built = await esbuild.build({
  stdin: { contents: harness, loader: 'tsx', resolveDir: frontend, sourcefile: 'harness.tsx' },
  bundle: true,
  write: false,
  outdir: 'repro-out',
  format: 'iife',
  jsx: 'automatic',
  alias: pkg,
  loader: { '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'empty', '.onnx': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"MODE":"production","PROD":true,"DEV":false}' },
  logLevel: 'error',
});
const asset = ext => built.outputFiles.filter(f => f.path.endsWith(ext)).map(f => f.text).join('\n');
const files = {
  '/': ['text/html', '<!doctype html><html><head><link rel="stylesheet" href="/harness.css"><style>body{margin:0;background:#111}#pane{width:800px;height:400px;margin:40px}#elsewhere{width:800px;height:200px;margin:40px}</style></head><body><div id="pane"></div><div id="elsewhere"></div><script src="/harness.js"></script></body></html>'],
  '/harness.js': ['text/javascript', asset('.js')],
  '/harness.css': ['text/css', asset('.css')],
};

const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';

async function openPane(browser) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.route('http://repro.test/**', route => {
    const [contentType, body] = files[new URL(route.request().url()).pathname] ?? ['text/plain', ''];
    return route.fulfill({ contentType, body });
  });
  await page.goto('http://repro.test/');
  await page.evaluate(() => window.__mount());
  await page.waitForFunction(() => window.__socket?.readyState === 1);
  await page.evaluate(d => { window.__phase = 'live'; window.__output(d); }, `${MOUSE_ON}$ `);
  await page.waitForSelector('.xterm.enable-mouse-events');
  const pane = await page.locator('.xterm-screen').boundingBox();
  const elsewhere = await page.locator('#elsewhere').boundingBox();
  const point = (box, fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  return {
    page,
    pageErrors,
    inPane: (fx, fy) => point(pane, fx, fy),
    outside: (fx, fy) => point(elsewhere, fx, fy),
    phase: p => page.evaluate(x => { window.__phase = x; }, p),
  };
}

const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))));

async function report(pane, steps) {
  await settle(pane.page);
  const seen = await pane.page.evaluate(() => ({
    errors: window.__errors,
    sent: window.__sent,
    docMouseListeners: window.__docMouseListeners(),
    eventsDuringUnmount: window.__eventsDuringUnmount,
    socketClosedByUnmount: window.__socketClosedByUnmount ?? null,
  }));
  const byPhase = steps.map(name => ({
    step: name,
    errors: seen.errors.filter(e => e.phase === name).length,
    input: seen.sent.filter(s => s.phase === name && s.type === 'input').map(s => s.data),
  }));
  await pane.page.close();
  return { ...seen, pageErrors: pane.pageErrors.length, steps: byPhase };
}

async function live(browser) {
  const pane = await openPane(browser);
  const m = pane.page.mouse;
  const steps = {
    click: async () => { await m.move(...pane.inPane(0.1, 0.2)); await m.down(); await m.up(); },
    'drag selection': async () => {
      await m.move(...pane.inPane(0.1, 0.3));
      await m.down();
      await m.move(...pane.inPane(0.6, 0.6), { steps: 8 });
      await m.up();
    },
    'drag out of the pane': async () => {
      await m.move(...pane.inPane(0.5, 0.5));
      await m.down();
      await m.move(...pane.outside(0.5, 0.5), { steps: 6 });
      await m.up();
    },
    wheel: async () => { await m.move(...pane.inPane(0.5, 0.5)); await m.wheel(0, -120); await m.wheel(0, 120); },
    'right click': async () => { await m.move(...pane.inPane(0.3, 0.3)); await m.down({ button: 'right' }); await m.up({ button: 'right' }); },
  };
  for (const [name, run] of Object.entries(steps)) {
    await pane.phase(name);
    await run();
    await settle(pane.page);
  }
  return report(pane, Object.keys(steps));
}

async function laterDrags(pane) {
  const m = pane.page.mouse;
  await pane.phase('later drag elsewhere');
  await m.move(...pane.outside(0.1, 0.5));
  await m.down();
  await m.move(...pane.outside(0.9, 0.5), { steps: 10 });
  await m.up();
  await pane.phase('later click elsewhere');
  await m.down();
  await m.up();
}

async function dragAcrossUnmount(browser) {
  const pane = await openPane(browser);
  const m = pane.page.mouse;
  await pane.phase('press');
  await m.move(...pane.inPane(0.2, 0.4));
  await m.down();
  await settle(pane.page);
  await pane.page.evaluate(() => window.__unmount());
  await pane.phase('drag after unmount');
  await m.move(...pane.inPane(0.5, 0.5), { steps: 10 });
  await pane.phase('release after unmount');
  await m.up();
  await laterDrags(pane);
  return report(pane, ['press', 'unmount', 'drag after unmount', 'release after unmount', 'later drag elsewhere', 'later click elsewhere']);
}

async function unmountWithNoButtonDown(browser) {
  const pane = await openPane(browser);
  await pane.page.evaluate(() => window.__unmount());
  await laterDrags(pane);
  return report(pane, ['unmount', 'later drag elsewhere', 'later click elsewhere']);
}

const browser = await chromium.launch();
const result = {
  repo,
  head: execFileSync('git', ['-C', repo, 'log', '-1', '--format=%h %s'], { encoding: 'utf8' }).trim(),
  engine: Object.fromEntries(Object.entries(pkg).map(([name, dir]) => [name, `${versionOf(dir).name}@${versionOf(dir).version}`])),
  live: await live(browser),
  dragAcrossUnmount: await dragAcrossUnmount(browser),
  unmountWithNoButtonDown: await unmountWithNoButtonDown(browser),
};
await browser.close();

const show = s => JSON.stringify(s).replace(/\\u001b/g, '\\e');
const digest = input => createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 12);
console.log(`repo ${repo} (${result.head})`);
console.log(`engine ${Object.values(result.engine).join(', ')}`);
for (const scenario of ['live', 'dragAcrossUnmount', 'unmountWithNoButtonDown']) {
  const r = result[scenario];
  console.log(`\n${scenario}: ${r.pageErrors} page errors, document mouse listeners left: [${r.docMouseListeners.join(', ')}]` +
    (r.socketClosedByUnmount === null ? '' : `, socket closed by unmount: ${r.socketClosedByUnmount}, events dispatched during unmount: [${r.eventsDuringUnmount.join(', ')}]`));
  for (const s of r.steps) {
    console.log(`  ${s.step.padEnd(24)} errors ${String(s.errors).padStart(2)}  input ${s.input.length} ${s.input.length ? `sha ${digest(s.input)} ${show(s.input).slice(0, 90)}` : ''}`);
  }
  const first = r.errors.find(e => e.phase !== 'live');
  if (first) console.log(`  first error: ${first.message}\n    ${first.stack.split('\n').slice(1, 5).map(l => l.trim()).join('\n    ')}`);
}
if (out) writeFileSync(out, JSON.stringify(result, null, 2));

const afterUnmount = ['unmount', 'drag after unmount', 'release after unmount', 'later drag elsewhere', 'later click elsewhere'];
const broken = ['dragAcrossUnmount', 'unmountWithNoButtonDown'].some(name => {
  const r = result[name];
  return r.docMouseListeners.length > 0 ||
    r.steps.some(s => afterUnmount.includes(s.step) && (s.errors > 0 || s.input.length > 0));
}) || result.live.pageErrors > 0;
console.log(`\n${broken ? 'FAIL' : 'PASS'}: a drag across a pane's unmount ${broken ? 'throws, sends input or leaves listeners behind' : 'is clean'}`);
process.exit(broken ? 1 : 0);
