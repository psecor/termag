// demo-kit: one captioned, after-only demo video per PR (Playwright).
//
// CHANGELOG
// - (2026-10-28) moved into the repo.
// - v2 (demo-highlight, 2026-10-28): highlights are a spotlight. Everything outside the highlighted
//   regions is dimmed, and each region gets one still border (one short pulse as it appears), padded
//   so it never touches text: a side with no room for a border (terminal lines touching the next line)
//   gets none, and the dim edge marks it. Matches that touch or overlap (consecutive terminal rows,
//   adjacent cells) merge into one region; separate groups stay separate. New: `highlightText()` for
//   terminals and tables, `{ label }` callouts, light and dark pages, `<pre>` lines. `highlight(sel)`,
//   `highlightGroup(sel)` and `clearHighlights()` keep working as before. Captions honour `captionAt`
//   on every call (it could fall back to the bottom).
// - v1: captions, pulsing outlines (`__dkpulse`), title card.
//
// Usage in a recording script:
//   import { startDemo } from './scripts/demo-kit/demo-kit.mjs';
//   const demo = await startDemo(browser, { dir: 'out', title: 'Share a space from the + menu' });
//   const page = demo.page;
//   await page.goto(url);
//   await demo.caption('The + now opens three items: New agent, New tab, Share space…');
//   await demo.highlight('[data-testid="space-plus"]', { label: 'New' });  // spotlight what changed
//   await demo.hold(2500);                                                  // let the viewer read
//   await demo.clearHighlights();                                           // one region per caption
//   await demo.highlightText('ℹ fail 0', { within: '.xterm-rows' });       // terminal rows, table cells
//   ...
//   const file = await demo.finish('pr-749-demo.webm');      // closes the context, returns the path
//
// Highlight options (both calls): label (a short callout beside the region), pad (border padding,
// default 10), dim (false: no spotlight, border only). highlightText also takes within (CSS scope),
// exclude (text/regex/array: skip rows that match, e.g. ' $ ' for the prompt) and inline (true:
// allow inline elements such as <code> as targets).
//
// Captions sit in a bar at the bottom (or top) of the frame. Everything is drawn in an overlay
// (pointer-events: none, so clicks still land) that is re-injected after every navigation and never
// changes the page's layout.

import { rename } from 'node:fs/promises';
import { join } from 'node:path';

function overlay() {
  if (document.getElementById('__demo-kit')) return;  // setContent() swaps the document but keeps window
  const NS = 'http://www.w3.org/2000/svg';
  const T = 5, CLEAR = 2, TOUCH = 12;  // border thickness (3px amber + 1px dark edge each side), gap to text, merge distance
  const root = document.createElement('div');
  root.id = '__demo-kit';
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font:600 18px/1.35 system-ui,sans-serif';
  const style = document.createElement('style');
  style.textContent = '@keyframes __dkin{0%{opacity:0}25%{opacity:1}55%{opacity:.4}100%{opacity:1}}'
    + '#__demo-kit .dk-fresh{animation:__dkin .7s ease-out 1}';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;overflow:visible');
  const layer = document.createElement('div');
  layer.style.cssText = 'position:absolute;inset:0';
  const bar = document.createElement('div');
  bar.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);max-width:80%;padding:10px 16px;border-radius:10px;background:rgba(13,17,23,.92);color:#f0f6fc;box-shadow:0 4px 24px rgba(0,0,0,.5);border:1px solid #3d444d;display:none;text-align:center';
  root.append(style, svg, layer, bar);

  const norm = s => s.replace(/\u00a0/g, ' ');
  const toMatcher = m => {
    const list = (Array.isArray(m) ? m : [m]).filter(x => x != null);
    const tests = list.map(x => (typeof x === 'object' && 're' in x)
      ? (re => s => re.test(s))(new RegExp(x.re, x.flags.replace('g', '')))
      : s => s.includes(String(x)));
    return s => tests.some(t => t(s));
  };
  const visible = el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
  };
  const transparent = c => !c || c === 'transparent' || /rgba\(.*,\s*0(\.0+)?\)$/.test(c);
  const rectOf = r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  const union = rs => ({ left: Math.min(...rs.map(r => r.left)), top: Math.min(...rs.map(r => r.top)), right: Math.max(...rs.map(r => r.right)), bottom: Math.max(...rs.map(r => r.bottom)) });
  const hit = (a, b, slack = 0) => a.left < b.right + slack && b.left < a.right + slack && a.top < b.bottom + slack && b.top < a.bottom + slack;
  const PRE = /^(pre|pre-wrap|break-spaces)$/;

  // The rects of a text node's visible characters, leading and trailing spaces trimmed.
  const textRects = node => {
    const s = node.data, i = s.search(/\S/);
    if (i < 0) return [];
    const j = s.length - s.split('').reverse().join('').search(/\S/);
    const range = document.createRange(); range.setStart(node, i); range.setEnd(node, j);
    return [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0).map(rectOf);
  };
  const textNodes = (el, max = 6000) => {
    const out = [], w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: n =>
      (root.contains(n) || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(n.parentElement?.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    for (let n; (n = w.nextNode()) && out.length < max;) out.push(n);
    return out;
  };

  // A target is an element, or one line of a <pre>. box: what merging compares (consecutive rows
  // touch); fit: what the border goes round (a text-only element shrinks to its text).
  const elementTarget = el => ({
    el,
    box() { return visible(el) ? rectOf(el.getBoundingClientRect()) : null; },
    fit() {
      const r = this.box(); if (!r) return null;
      const cs = getComputedStyle(el);
      const plain = cs.display !== 'inline' && transparent(cs.backgroundColor) && !parseFloat(cs.borderTopWidth) && !parseFloat(cs.borderLeftWidth)
        && !el.querySelector('img,svg,canvas,video,input,textarea,select,button,iframe');
      if (!plain) return r;
      const rs = textNodes(el, 400).flatMap(textRects);
      if (!rs.length) return r;
      const t = union(rs);
      return { left: t.left, right: t.right, top: r.top, bottom: r.bottom };
    },
  });
  const lineTargets = (el, test, skip) => {
    const nodes = textNodes(el, 2000); let all = '';
    const at = []; for (const n of nodes) { at.push(all.length); all += n.data; }
    const pos = k => { let i = at.length - 1; while (i > 0 && at[i] > k) i--; return [nodes[i], k - at[i]]; };
    const out = []; let start = 0;
    for (const line of all.split('\n')) {
      const t = norm(line);
      if (t.trim() && test(t) && !skip(t)) {
        const a = start + line.search(/\S/), b = start + line.trimEnd().length;
        const range = document.createRange(); range.setStart(...pos(a)); range.setEnd(...pos(b));
        const fit = () => {
          const rs = [...range.getClientRects()].filter(r => r.width); if (!rs.length) return null;
          const u = union(rs.map(rectOf)), lh = parseFloat(getComputedStyle(el).lineHeight) || (u.bottom - u.top) * 1.2;
          const grow = Math.max(0, (lh * rs.length - (u.bottom - u.top)) / 2);  // the line box, so consecutive lines touch
          return { ...u, top: u.top - grow, bottom: u.bottom + grow };
        };
        out.push({ el, box() { const f = fit(); if (!f) return null; const p = el.getBoundingClientRect(); return { ...f, left: p.left, right: p.right }; }, fit });
      }
      start += line.length + 1;
    }
    return out;
  };
  // The smallest visible, non-inline elements under `within` whose text matches.
  const findText = ({ match, within, exclude, inline }) => {
    const test = toMatcher(match), skip = exclude == null ? () => false : toMatcher(exclude);
    const scopes = within ? [...document.querySelectorAll(within)] : [document.body];
    const hits = [];
    for (const scope of scopes) for (const el of [scope, ...scope.querySelectorAll('*')]) {
      if (root.contains(el) || /^(SCRIPT|STYLE|NOSCRIPT|HEAD)$/.test(el.tagName)) continue;
      const t = norm(el.textContent || '');
      if (!t.trim() || !test(t) || !visible(el)) continue;
      if (!inline && getComputedStyle(el).display === 'inline') continue;
      hits.push(el);
    }
    const smallest = hits.filter(el => !hits.some(d => d !== el && el.contains(d)));
    return smallest.flatMap(el => {
      if (PRE.test(getComputedStyle(el).whiteSpace) && el.textContent.includes('\n')) return lineTargets(el, test, skip);
      return skip(norm(el.textContent)) ? [] : [elementTarget(el)];
    });
  };

  let groups = [], fresh = false, lastSig = '', lastFull = 0, lastFind = 0;
  const captionRect = () => (bar.style.display === 'none' ? null : rectOf(bar.getBoundingClientRect()));

  const draw = () => {
    if (fresh || Date.now() - lastFind > 400) { lastFind = Date.now(); for (const g of groups) if (g.query) g.targets = findText(g.query); }
    // Merge: union each 'all' group, then join regions whose boxes touch until nothing changes.
    let regions = [];
    for (const g of groups) {
      const parts = g.targets.map(t => ({ box: t.box(), fit: t.fit(), t })).filter(p => p.box && p.fit);
      if (!parts.length) continue;
      const items = g.merge === 'all' ? [{ box: union(parts.map(p => p.box)), fit: union(parts.map(p => p.fit)), ts: parts.map(p => p.t) }] : parts.map(p => ({ box: p.box, fit: p.fit, ts: [p.t] }));
      items.sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
      items.forEach((it, i) => regions.push({ ...it, g, label: i ? '' : g.label }));  // one callout per call, on its first region
    }
    for (let joined = true; joined;) {
      joined = false;
      for (let i = 0; i < regions.length && !joined; i++) for (let j = i + 1; j < regions.length && !joined; j++) {
        const a = regions[i], b = regions[j];
        if (!hit(a.box, b.box, TOUCH)) continue;
        regions[i] = { box: union([a.box, b.box]), fit: union([a.fit, b.fit]), ts: [...a.ts, ...b.ts], g: a.g, label: a.label || b.label };
        regions.splice(j, 1); joined = true;
      }
    }
    const sig = JSON.stringify([regions.map(r => [r.fit, r.label]), innerWidth, innerHeight, captionRect()]);
    if (sig === lastSig && !fresh && Date.now() - lastFull < 1000) return;
    lastSig = sig; lastFull = Date.now();

    // Text a border must stay clear of: every visible character outside its own region (another
    // region's text included).
    const text = regions.length ? textNodes(document.body).filter(n => n.parentElement && visible(n.parentElement)).flatMap(textRects)
      .filter(r => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) : [];
    const outside = regions.map(reg => text.filter(r => !hit(r, reg.fit, -1)));
    const foreign = text.filter(r => !regions.some(reg => hit(r, reg.fit, -1)));

    const shapes = regions.map((reg, ri) => {
      const R = reg.fit, P = reg.g.pad ?? 10, mine = outside[ri];
      const clearOf = rect => !mine.some(f => hit(rect, f, 1));
      const gaps = { top: R.top, bottom: innerHeight - R.bottom, left: R.left, right: innerWidth - R.right };
      for (const f of mine) {
        // Level with the region (diagonal text is left to the segment check below).
        const besideV = f.top < R.bottom - 1 && f.bottom > R.top + 1, besideH = f.left < R.right - 1 && f.right > R.left + 1;
        if (besideH && f.bottom <= R.top + 1) gaps.top = Math.min(gaps.top, R.top - f.bottom);
        if (besideH && f.top >= R.bottom - 1) gaps.bottom = Math.min(gaps.bottom, f.top - R.bottom);
        if (besideV && f.right <= R.left + 1) gaps.left = Math.min(gaps.left, R.left - f.right);
        if (besideV && f.left >= R.right - 1) gaps.right = Math.min(gaps.right, f.left - R.right);
      }
      const pad = {}, room = {};  // room: a border fits on that side
      for (const s in gaps) {
        const g = Math.max(0, gaps[s]);
        room[s] = g >= T + CLEAR + 1;
        pad[s] = room[s] ? Math.min(P, g - T - CLEAR) : Math.max(0, Math.min(P, g - 1));
      }
      const cut = { left: R.left - pad.left, top: R.top - pad.top, right: R.right + pad.right, bottom: R.bottom + pad.bottom };
      // Border segments along the outside of the cut-out; a side without room only keeps short
      // corner ticks from its neighbours, and any segment that would touch text is dropped.
      const x0 = cut.left - T / 2, x1 = cut.right + T / 2, y0 = cut.top - T / 2, y1 = cut.bottom + T / 2;
      const seg = (ax, ay, bx, by) => ({ ax, ay, bx, by, rect: { left: Math.min(ax, bx) - T / 2, right: Math.max(ax, bx) + T / 2, top: Math.min(ay, by) - T / 2, bottom: Math.max(ay, by) + T / 2 } });
      const tick = s => Math.max(0, Math.min(12, pad[s] - 2));
      // A side line runs the full frame only where the sides it meets have room; otherwise it stops
      // at the cut-out, so it never reaches into a neighbouring row.
      const IN = T / 2 + 1, ya = room.top ? y0 : cut.top + IN, yb = room.bottom ? y1 : cut.bottom - IN, xa = room.left ? x0 : cut.left + IN, xb = room.right ? x1 : cut.right - IN;
      const side = {
        left: room.left && seg(x0, ya, x0, yb), right: room.right && seg(x1, ya, x1, yb),
        top: room.top && seg(xa, y0, xb, y0), bottom: room.bottom && seg(xa, y1, xb, y1),
      };
      for (const k in side) if (side[k] && !clearOf(side[k].rect)) side[k] = false;
      const box = Object.values(side).every(Boolean);
      // Without a full box, only opposite pairs: [ ] brackets (corner ticks where they fit) or = lines.
      const segs = [];
      if (!box && side.left && side.right) {
        segs.push(side.left, side.right);
        for (const [y, open] of [[y0, !room.top], [y1, !room.bottom]]) if (open) for (const t of [tick('left') && seg(x0, y, x0 + tick('left'), y), tick('right') && seg(x1, y, x1 - tick('right'), y)]) if (t && clearOf(t.rect)) segs.push(t);
      } else if (!box && side.top && side.bottom) segs.push(side.top, side.bottom);
      return { reg, cut, box, frame: { left: x0 - T / 2, top: y0 - T / 2, right: x1 + T / 2, bottom: y1 + T / 2 }, segs };
    });

    // Light or dark: the background behind the first region.
    let light = matchMedia('(prefers-color-scheme: light)').matches;
    const first = regions[0]?.ts[0]?.el;
    for (let e = first; e; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      if (!transparent(c)) { const [r, g, b] = c.match(/[\d.]+/g).map(Number); light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 140; break; }
    }
    const dim = groups.some(g => g.dim !== false) ? (light ? 'rgba(15,23,42,.5)' : 'rgba(1,4,9,.62)') : 'transparent';

    window.__demoKitShapes = shapes;  // for debugging a recording script
    svg.replaceChildren();
    layer.replaceChildren();
    if (!shapes.length) return;
    const el = (name, attrs, parent = svg) => { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.appendChild(e); return e; };
    const mask = el('mask', { id: '__dkmask' }, el('defs', {}));
    el('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: '#fff' }, mask);
    for (const s of shapes) el('rect', { x: s.cut.left, y: s.cut.top, width: s.cut.right - s.cut.left, height: s.cut.bottom - s.cut.top, rx: s.box ? 6 : 2, fill: '#000' }, mask);
    el('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: dim, mask: 'url(#__dkmask)', style: 'transition:fill .25s' });
    const lines = el('g', { class: fresh ? 'dk-fresh' : '', fill: 'none', 'stroke-linecap': 'square' });
    for (const s of shapes) {
      if (s.box) {
        const a = { x: s.cut.left - T / 2, y: s.cut.top - T / 2, width: s.cut.right - s.cut.left + T, height: s.cut.bottom - s.cut.top + T, rx: 7 };
        el('rect', { ...a, stroke: '#1c1300', 'stroke-width': T }, lines);
        el('rect', { ...a, stroke: '#f5b82e', 'stroke-width': T - 2 }, lines);
      } else for (const g of s.segs) {
        const d = `M${g.ax},${g.ay}L${g.bx},${g.by}`;
        el('path', { d, stroke: '#1c1300', 'stroke-width': T }, lines);
        el('path', { d, stroke: '#f5b82e', 'stroke-width': T - 2, 'stroke-linecap': 'butt' }, lines);
      }
    }

    // Callouts: beside their region, clear of every region and of the caption, over as little text as can be.
    const avoid = [...shapes.map(s => s.frame), captionRect()].filter(Boolean);
    for (const s of shapes) {
      if (!s.reg.label) continue;
      const tag = document.createElement('div');
      tag.textContent = s.reg.label;
      tag.className = fresh ? 'dk-fresh' : '';
      tag.style.cssText = 'position:absolute;padding:5px 11px;border-radius:7px;background:#f5b82e;color:#1c1300;font:650 15px/1.3 system-ui,sans-serif;box-shadow:0 0 0 1px #1c1300,0 4px 16px rgba(0,0,0,.45);white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis';
      layer.appendChild(tag);
      const w = tag.offsetWidth, h = tag.offsetHeight, f = s.frame, G = 10;
      const cy = Math.max(f.top, Math.min(f.bottom - h, (f.top + f.bottom - h) / 2));
      const spots = [[f.right + G, cy], [f.left - G - w, cy], [f.left, f.bottom + G], [f.right - w, f.bottom + G], [f.left, f.top - G - h], [f.right - w, f.top - G - h]];
      let best = null;
      spots.forEach(([x, y], i) => {
        const r = { left: x, top: y, right: x + w, bottom: y + h };
        if (r.left < 8 || r.top < 8 || r.right > innerWidth - 8 || r.bottom > innerHeight - 8 || avoid.some(a => hit(r, a, 6))) return;
        const cover = foreign.filter(t => hit(r, t, 2)).length;
        const score = cover * 10 + i;
        if (!best || score < best.score) best = { x, y, score };
      });
      if (!best) { tag.remove(); continue; }
      Object.assign(tag.style, { left: best.x + 'px', top: best.y + 'px' });
      avoid.push({ left: best.x, top: best.y, right: best.x + w, bottom: best.y + h });
    }
    fresh = false;
  };
  addEventListener('scroll', () => { lastSig = ''; }, true);
  setInterval(() => { try { draw(); } catch (e) { console.warn('demo-kit', e); } }, 100);

  const add = g => { groups.push(g); fresh = true; lastSig = ''; draw(); return g.targets.length; };
  window.__demoKit = {
    caption(text, at) {
      bar.textContent = text; bar.style.display = text ? 'block' : 'none';
      const top = (at || window.__demoKitCaptionAt) === 'top';
      Object.assign(bar.style, { top: top ? '64px' : '', bottom: top ? '' : '28px' });
      lastSig = '';
    },
    highlight(selector, o = {}) { return add({ ...o, targets: [...document.querySelectorAll(selector)].map(elementTarget) }); },
    // One region around every match together (a list of rows), touching or not.
    highlightGroup(selector, o = {}) { return add({ ...o, merge: 'all', targets: [...document.querySelectorAll(selector)].map(elementTarget) }); },
    highlightText(o) { return add({ ...o, query: o, targets: findText(o) }); },
    clear() { groups = []; lastSig = ''; draw(); },
  };
  (document.body || document.documentElement).appendChild(root);
}
// Exported for an app in an iframe: `await frame.evaluate(OVERLAY)`, then `frame.evaluate(s => window.__demoKit.highlight(s), sel)`.
export const OVERLAY = `(${overlay.toString()})();`;

// A string, RegExp or array of them, in a form page.evaluate can carry.
const wire = m => (Array.isArray(m) ? m.map(wire) : m instanceof RegExp ? { re: m.source, flags: m.flags } : m);

// captionAt: 'bottom' (default) or 'top', for an app whose controls sit at the bottom of the frame.
// colorScheme: optional, e.g. 'dark'.
// storageState: a signed-in session prepared in an unrecorded context, so the video starts on the title card.
export async function startDemo(browser, { dir, title, viewport = { width: 1440, height: 900 }, captionAt = 'bottom', colorScheme, storageState }) {
  const context = await browser.newContext({ viewport, recordVideo: { dir, size: viewport }, ...(colorScheme ? { colorScheme } : {}), ...(storageState ? { storageState } : {}) });
  await context.addInitScript(`window.__demoKitCaptionAt = ${JSON.stringify(captionAt)};`);
  await context.addInitScript(`addEventListener('DOMContentLoaded', () => { ${OVERLAY} })`);
  const page = await context.newPage();
  const ensure = () => page.evaluate(OVERLAY).catch(() => {});
  let lastCaption = '';
  const demo = {
    page,
    async caption(text) { lastCaption = text; await ensure(); await page.evaluate(([t, at]) => window.__demoKit.caption(t, at), [text, captionAt]); },
    // Spotlight the elements matching a CSS selector; touching ones merge into one region. Returns the match count.
    async highlight(selector, opts = {}) { await ensure(); return page.evaluate(([s, o]) => window.__demoKit.highlight(s, o), [selector, opts]); },
    async highlightGroup(selector, opts = {}) { await ensure(); return page.evaluate(([s, o]) => window.__demoKit.highlightGroup(s, o), [selector, opts]); },
    // Spotlight the smallest elements whose text matches (terminal rows, table cells, <pre> lines).
    // Follows the text while it stays highlighted, so it works on output that is still streaming.
    async highlightText(match, opts = {}) {
      await ensure();
      const o = { ...opts, match: wire(match), ...(opts.exclude != null ? { exclude: wire(opts.exclude) } : {}) };
      return page.evaluate(q => window.__demoKit.highlightText(q), o);
    },
    async clearHighlights() { await ensure(); await page.evaluate(() => window.__demoKit.clear()); },
    async hold(ms = 2000) { await page.waitForTimeout(ms); },
    async finish(name) {
      const video = page.video();
      await context.close();
      const from = await video.path();
      const to = join(dir, name);
      await rename(from, to);
      return to;
    },
  };
  // Re-show the current caption after any navigation.
  page.on('load', async () => { await ensure(); if (lastCaption) await demo.caption(lastCaption).catch(() => {}); });
  // The card animates (a slow fade and drift) so the recorder keeps writing frames: a still page
  // gets one frame, and the card then shows only for an instant (or as white) in the video.
  if (title) {
    // Playwright drops the first frames of a recording: start on a blank page so the card isn't lost.
    await page.setContent('<body style="margin:0;background:#0d1117"></body>'); await demo.hold(1200);
    await page.setContent(`<style>@keyframes __dkin{from{opacity:.25;transform:translateY(6px)}to{opacity:1;transform:none}}</style><body style="margin:0;display:grid;place-items:center;height:100vh;background:#0d1117;color:#f0f6fc;font:600 34px system-ui"><div style="animation:__dkin 2.4s ease-out both">${title.replace(/</g, '&lt;')}</div></body>`);
    await demo.hold(3000);
  }
  return demo;
}
