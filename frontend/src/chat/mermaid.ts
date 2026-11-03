// Mermaid diagrams, drawn by MermaidDiagram.tsx: a ```mermaid fence in a
// reply or a Markdown file, and a .mmd / .mermaid file in the file view. Mermaid is
// large, so it is imported on the first diagram only (loadMermaid), never by
// the main bundle or the chat's chunk.
//
// Which files and fences are diagrams is mermaidFence.ts, kept apart so the
// bundles that only ask that don't carry this module.
//
// The source is untrusted (files, agent output). Mermaid runs with
// securityLevel 'strict' (labels sanitized, no click handlers, no HTML labels)
// and a diagram's own %%{init}%% or frontmatter can't loosen that (`secure`).
// The SVG it returns is never put in the page's DOM. It is drawn in an iframe
// sandboxed with only `allow-scripts` (an opaque origin: no termag cookies,
// storage or DOM, no popups, forms or navigation), whose own CSP lets only its
// one nonce'd script run (svg-pan-zoom, the pan and zoom mermaid.live uses,
// with Hammer.js for touch)
// and fetches nothing (diagramDocument).
import type { Mermaid, MermaidConfig } from 'mermaid';

/**
 * The diagram's type, its first keyword (`flowchart`, `sequenceDiagram`,
 * `kanban`), past frontmatter, %% comments and directives; null for none.
 */
export function diagramKind(source: string): string | null {
  const lines = source.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i]?.trim() === '---') {
    for (i++; i < lines.length && lines[i].trim() !== '---'; i++);
    i++;
  }
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('%%')) continue;
    return /^[A-Za-z][\w-]*/.exec(line)?.[0] ?? null;
  }
  return null;
}

/** termag's design tokens a diagram is drawn in, read from the page so it follows the theme. */
export interface DiagramTheme {
  dark: boolean;
  /** --bg-surface: the diagram's background. */
  background: string;
  /** --bg-elevated: a node's fill, a kanban card. */
  node: string;
  /** --bg-base: a kanban column, a sequence note. */
  sunken: string;
  /** --border: a node's outline. */
  border: string;
  /** --text-primary. */
  text: string;
  /** --text-secondary: edges, arrowheads, edge labels. */
  muted: string;
  /** --accent. */
  accent: string;
  /** --danger: a gantt chart's critical tasks and today line. */
  danger: string;
  /** --font-ui, a system stack. */
  font: string;
  /** The simple UI's body size. */
  fontSize: string;
}

export const DEFAULT_DIAGRAM_THEME: DiagramTheme = {
  dark: true,
  background: '#161b22',
  node: '#21262d',
  sunken: '#0d1117',
  border: '#30363d',
  text: '#c9d1d9',
  muted: '#8b949e',
  accent: '#58a6ff',
  danger: '#f85149',
  font: '-apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, \'Helvetica Neue\', Arial, sans-serif',
  fontSize: '14px',
};

const LIGHT_FALLBACK: Omit<DiagramTheme, 'font' | 'fontSize'> = {
  dark: false, background: '#ffffff', node: '#f6f8fa', sunken: '#eaeef2', border: '#d0d7de', text: '#1f2328', muted: '#59636e', accent: '#0969da', danger: '#cf222e',
};

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i;

/** 0 (black) to 1 (white), or null for a colour this doesn't read. */
export function luminance(color: string): number | null {
  const c = color.trim();
  let rgb: number[] | null = null;
  if (HEX.test(c)) {
    const h = c.length === 4 ? c.slice(1).split('').map(x => x + x).join('') : c.slice(1);
    rgb = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  } else {
    const m = RGB.exec(c);
    if (m) rgb = [m[1], m[2], m[3]].map(Number);
  }
  if (!rgb) return null;
  const [r, g, b] = rgb.map(v => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

type Rgba = [number, number, number, number];

/** A hex (#rgb, #rgba, #rrggbb, #rrggbbaa) or rgb()/rgba() colour as 0-255 channels and 0-1 alpha; null for anything else. */
export function parseColor(color: string): Rgba | null {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c)?.[1];
  if (hex) {
    const h = hex.length <= 4 ? hex.split('').map(x => x + x).join('') : hex;
    const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    return [r, g, b, h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+)(%?))?\s*\)$/i.exec(c);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[5] ? Number(m[4]) / 100 : Number(m[4]);
  return [m[1], m[2], m[3]].map(v => Math.min(255, Number(v))).concat(Math.min(1, a)) as Rgba;
}

const toHex = (c: Rgba) => `#${c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** `top` painted over an opaque `bottom`, as #rrggbb. */
function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map(i => top[i] * a + bottom[i] * (1 - a)).concat(1) as Rgba;
}

/** WCAG 2's relative luminance of an opaque colour. */
function relativeLuminance(c: Rgba): number {
  const lin = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG 2's contrast ratio (1 to 21) of `fg` over `bg`; a translucent `fg` is composited on `bg` first. Null for a colour parseColor can't read. */
export function contrastRatio(fg: string, bg: string): number | null {
  const f = parseColor(fg), b = parseColor(bg);
  if (!f || !b) return null;
  const [x, y] = [relativeLuminance(over(f, b)), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `a` mixed with `b`, `amount` (0-1) of the way to `b`, as #rrggbb. */
export function mixColors(a: string, b: string, amount: number): string {
  const x = parseColor(a), y = parseColor(b);
  if (!x || !y) return a;
  return toHex([0, 1, 2].map(i => x[i] + (y[i] - x[i]) * amount).concat(1) as Rgba);
}

/** `color`, moved toward `toward` in small steps until it has `min` contrast on `bg` (or reaches `toward`). */
export function withContrast(color: string, bg: string, min: number, toward: string): string {
  for (let i = 0; i <= 20; i++) {
    const c = i ? mixColors(color, toward, i / 20) : color;
    if ((contrastRatio(c, bg) ?? 0) >= min) return c;
  }
  return toward;
}

/** Label text for a fill an author set: near-black or white, whichever reads better on it (black if neither reaches 4.5:1). */
export function labelColorFor(fill: string, under: string): string | null {
  const f = parseColor(fill), u = parseColor(under);
  if (!f || !u) return null;
  const solid = toHex(over(f, u));
  const dark = contrastRatio(LABEL_DARK, solid)!, light = contrastRatio(LABEL_LIGHT, solid)!;
  if (Math.max(dark, light) >= 4.5) return dark >= light ? LABEL_DARK : LABEL_LIGHT;
  return contrastRatio('#000000', solid)! >= light ? '#000000' : LABEL_LIGHT;
}
const LABEL_DARK = '#1f2328';
const LABEL_LIGHT = '#ffffff';

/**
 * Diagram types whose `classDef` and `style` statements take Mermaid's
 * `color:` for their labels. `flowchart-elk` (the ELK layout) and
 * `swimlane-beta` are flowcharts by another keyword, on the same grammar.
 */
const STYLED_KINDS = new Set(['flowchart', 'flowchart-v2', 'flowchart-elk', 'graph', 'swimlane-beta', 'stateDiagram', 'stateDiagram-v2', 'classDiagram', 'classDiagram-v2', 'block', 'block-beta', 'requirementDiagram']);

/**
 * A diagram whose `classDef` or `style` sets a `fill:` without a `color:`
 * keeps the theme's label colour, which may not read on that fill (termag's
 * light text on a light green). This adds Mermaid's own `color:` to those
 * statements, dark or light by the fill's luminance; an author's `color:` is
 * kept. A fill that isn't a hex or rgb() colour is read through the page's
 * CSS when there is one (`resolve`). Lines are only ever lengthened, never
 * added, so Mermaid's error line numbers still match the source.
 */
export function readableLabels(source: string, theme: DiagramTheme, resolve: (color: string) => string | null = resolveCssColor): string {
  const kind = diagramKind(source);
  if (!kind || !STYLED_KINDS.has(kind)) return source;
  return source.split('\n').map(line => {
    const m = /^(\s*(?:classDef|style)\s+\S+\s+)(.*?)(\s*;?\s*)$/.exec(line);
    if (!m) return line;
    const props = splitStyle(m[2]);
    const value = (key: string) => props.find(p => p.split(':')[0].trim().toLowerCase() === key)?.split(':').slice(1).join(':').replace(/!important/i, '').trim();
    const fill = value('fill');
    if (!fill || value('color') !== undefined) return line;
    const rgb = parseColor(fill) ? fill : resolve(fill);
    const label = rgb ? labelColorFor(rgb, theme.background) : null;
    return label ? `${m[1]}${m[2]},color:${label}${m[3]}` : line;
  }).join('\n');
}

/** A style list's `key:value` parts, split on the commas outside parentheses (`fill:rgb(1,2,3),stroke:#333`). */
function splitStyle(list: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth = Math.max(0, depth - 1);
    else if (list[i] === ',' && depth === 0) { out.push(list.slice(start, i)); start = i + 1; }
  }
  out.push(list.slice(start));
  return out.map(p => p.trim()).filter(Boolean);
}

/** A named or hsl() colour as the page computes it (rgb()), or null when the page can't say. */
function resolveCssColor(color: string): string | null {
  if (typeof document === 'undefined' || !document.body) return null;
  const probe = document.createElement('span');
  probe.style.color = color;
  if (!probe.style.color) return null;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return parseColor(computed) ? computed : null;
}

/**
 * The page's theme: termag's CSS variables on <html> (App.css, ThemeProvider).
 * Dark or light comes from the background's brightness, and from the
 * `color-scheme` when the background isn't a colour this reads.
 */
export function readDiagramTheme(root: Element = document.documentElement): DiagramTheme {
  const css = getComputedStyle(root);
  const read = (name: string) => css.getPropertyValue(name).trim();
  const lum = luminance(read('--bg-surface'));
  const scheme = (css.colorScheme || read('color-scheme') || '').toLowerCase();
  const dark = lum !== null ? lum < 0.5 : scheme.includes('dark') || !scheme.includes('light');
  const base = dark ? DEFAULT_DIAGRAM_THEME : LIGHT_FALLBACK;
  const color = (name: string, fallback: string) => {
    const v = read(name);
    return luminance(v) !== null ? v : fallback;
  };
  return {
    dark,
    background: color('--bg-surface', base.background),
    node: color('--bg-elevated', base.node),
    sunken: color('--bg-base', base.sunken),
    border: color('--border', base.border),
    text: color('--text-primary', base.text),
    muted: color('--text-secondary', base.muted),
    accent: color('--accent', base.accent),
    danger: color('--danger', base.danger),
    font: read('--font-ui') || DEFAULT_DIAGRAM_THEME.font,
    fontSize: DEFAULT_DIAGRAM_THEME.fontSize,
  };
}

export function themeKey(t: DiagramTheme): string {
  return [t.dark ? 'dark' : 'light', t.background, t.node, t.sunken, t.border, t.text, t.muted, t.accent, t.danger, t.font, t.fontSize].join('|');
}

/**
 * Config keys a diagram's own %%{init}%% or frontmatter may not change:
 * Mermaid's defaults (securityLevel among them) plus what keeps labels as
 * SVG text and the look termag's.
 */
const SECURE_KEYS = [
  'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
  'htmlLabels', 'flowchart', 'theme', 'themeVariables', 'themeCSS', 'darkMode', 'fontFamily', 'look',
];

/**
 * termag's look on top of Mermaid's `base` theme: rounded nodes, thin edges,
 * light arrowheads, kanban columns as sunken panels with a heading and cards
 * as termag cards. Mermaid scopes it to the diagram's own id.
 */
export function diagramCss(t: DiagramTheme): string {
  const edge = diagramColors(t).graphic;
  return [
    '.node rect, .node polygon, .node circle, .node path { stroke-width: 1px; }',
    '.node rect { rx: 8px; ry: 8px; }',
    '.flowchart-link, .edge-thickness-normal { stroke-width: 1.25px; }',
    `.marker, marker path { fill: ${t.muted}; stroke: ${t.muted}; stroke-width: 0.5px; }`,
    // Mermaid draws an edge label's box at half opacity, so the edge ran through its text.
    `.edgeLabel rect, .labelBkg { fill: ${t.background}; background-color: ${t.background}; opacity: 1; }`,
    `.edgeLabel text, .edgeLabel tspan { fill: ${t.muted}; }`,
    // A gantt chart's grid in the outline colour (d3 draws its ticks in currentColor, white here).
    `.grid .tick line { stroke: ${edge}; }`,
    '.messageLine0, .messageLine1 { stroke-width: 1.25px; }',
    'rect.actor { rx: 8px; ry: 8px; }',
    'rect.note { rx: 6px; ry: 6px; }',
    // Kanban: each column a sunken panel with a heading, each card a raised one.
    `.cluster rect { fill: ${t.sunken}; stroke: ${edge}; stroke-width: 1px; rx: 10px; ry: 10px; }`,
    `.cluster-label text, .cluster-label tspan { fill: ${t.text}; font-weight: 600; font-size: 13px; }`,
    `.node rect.label-container { fill: ${t.node}; stroke: ${edge}; rx: 8px; ry: 8px; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, ${t.dark ? 0.45 : 0.12})); }`,
  ].join('\n');
}

/**
 * Colours derived from the theme so a diagram meets WCAG AA on it (the audit
 * is improve-termag:artifacts/mermaid-a11y/audit.md). `graphic` is the
 * outline of a node, cluster, actor or task and a lifeline: termag's
 * --border is about 1.4:1 on the canvas, too faint to find a shape's edge,
 * so it is moved toward the muted text until it reaches 3:1. Gantt bars are
 * tints of the surface that keep the page's text at 4.5:1 or more.
 */
export function diagramColors(t: DiagramTheme) {
  const tint = (color: string, amount: number) => {
    // The most of `color` a bar can take with the page's text still at 4.5:1 on it.
    for (let a = amount; a > 0; a -= 0.02) {
      const c = mixColors(t.node, color, a);
      if ((contrastRatio(t.text, c) ?? 0) >= 4.5) return c;
    }
    return t.node;
  };
  return {
    graphic: withContrast(t.border, t.background, 3, t.muted),
    accentLine: withContrast(t.accent, t.background, 3, t.text),
    danger: withContrast(t.danger, t.background, 3, t.text),
    activeTask: tint(t.accent, 0.28),
    critTask: tint(t.danger, 0.28),
  };
}

/**
 * Mermaid's whole config for one render: its `base` theme with termag's
 * tokens, more room around and between nodes, and curved edges.
 */
export function mermaidConfig(t: DiagramTheme): MermaidConfig {
  const scale = (prefix: string, value: string) => Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`${prefix}${i}`, value]));
  const c = diagramColors(t);
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    secure: SECURE_KEYS,
    htmlLabels: false,
    flowchart: { htmlLabels: false, padding: 14, nodeSpacing: 46, rankSpacing: 54, curve: 'basis', diagramPadding: 12 },
    sequence: { actorMargin: 56, boxMargin: 12, noteMargin: 12, messageMargin: 36, mirrorActors: false },
    kanban: { padding: 12, sectionWidth: 220 },
    suppressErrorRendering: true,
    look: DIAGRAM_LOOK,
    theme: 'base',
    darkMode: t.dark,
    // Mermaid sizes boxes from text measured in this page and the diagram is
    // drawn in its own frame, so the font is termag's UI stack (system fonts,
    // the same in both), never a web font.
    fontFamily: t.font,
    themeCSS: diagramCss(t),
    themeVariables: {
      darkMode: t.dark,
      fontFamily: t.font,
      fontSize: t.fontSize,
      background: t.background,
      // Nodes: termag's raised surface, an outline at 3:1, the page's text.
      primaryColor: t.node,
      primaryBorderColor: c.graphic,
      primaryTextColor: t.text,
      secondaryColor: t.sunken,
      secondaryBorderColor: c.graphic,
      secondaryTextColor: t.text,
      tertiaryColor: t.background,
      tertiaryBorderColor: c.graphic,
      tertiaryTextColor: t.text,
      mainBkg: t.node,
      nodeBorder: c.graphic,
      nodeTextColor: t.text,
      textColor: t.text,
      titleColor: t.text,
      clusterBkg: t.sunken,
      clusterBorder: c.graphic,
      // Edges in the muted text colour; the accent picks out notes and activations.
      lineColor: t.muted,
      defaultLinkColor: t.muted,
      edgeLabelBackground: t.background,
      actorBkg: t.node,
      actorBorder: c.graphic,
      actorTextColor: t.text,
      actorLineColor: c.graphic,
      signalColor: t.muted,
      signalTextColor: t.text,
      labelBoxBkgColor: t.node,
      labelBoxBorderColor: c.graphic,
      labelTextColor: t.text,
      loopTextColor: t.text,
      noteBkgColor: t.sunken,
      noteBorderColor: c.accentLine,
      noteTextColor: t.text,
      activationBkgColor: t.sunken,
      activationBorderColor: c.accentLine,
      sequenceNumberColor: t.background,
      // The colour scale (kanban columns, among others): one sunken panel
      // colour with the page's text, not Mermaid's rainbow.
      ...scale('cScale', t.sunken),
      ...scale('cScaleLabel', t.text),
      ...scale('cScalePeer', c.graphic),
      // State diagrams: the same outlines; start and end in the edges' colour.
      stateBorder: c.graphic,
      specialStateColor: t.muted,
      innerEndBackground: t.muted,
      compositeBackground: t.node,
      compositeTitleBackground: t.node,
      altBackground: t.sunken,
      // Gantt: every bar keeps the page's text at 4.5:1 (Mermaid's defaults
      // put light text on light grey and red), outlined at 3:1, as is the grid.
      taskBkgColor: t.node,
      taskBorderColor: c.graphic,
      taskTextColor: t.text,
      taskTextLightColor: t.text,
      taskTextDarkColor: t.text,
      taskTextOutsideColor: t.text,
      taskTextClickableColor: t.accent,
      activeTaskBkgColor: c.activeTask,
      activeTaskBorderColor: c.accentLine,
      doneTaskBkgColor: t.sunken,
      doneTaskBorderColor: c.graphic,
      critBkgColor: c.critTask,
      critBorderColor: c.danger,
      todayLineColor: c.danger,
      gridColor: c.graphic,
      sectionBkgColor: t.background,
      sectionBkgColor2: t.background,
      altSectionBkgColor: t.muted,
      excludeBkgColor: t.sunken,
    },
  };
}

/**
 * Mermaid's look. 'neo' (Mermaid 11's newer one) was tried: on termag's dark
 * surfaces its drop shadows and gradient strokes read as noise, so 'classic'
 * with diagramCss is the cleaner of the two.
 */
export const DIAGRAM_LOOK: 'classic' | 'neo' = 'classic';

/** A drawn diagram: its SVG, the size Mermaid laid it out at, and what its frame needs (diagramDocument). */
export interface RenderedDiagram { svg: string; width: number; height: number; theme: DiagramTheme; scripts: FrameScripts }

/**
 * Mermaid's SVG at its own size. Mermaid writes `width="100%"` and a
 * max-width style for an inline SVG; an image needs a real width and height
 * (from the viewBox) or it draws at 300×150.
 */
export function sizedSvg(svg: string): { svg: string; width: number; height: number } {
  const open = /<svg\b[^>]*>/i.exec(svg);
  if (!open) throw new Error('Mermaid returned no SVG');
  const tag = open[0];
  const box = /\bviewBox="\s*([-\d.e]+)[\s,]+([-\d.e]+)[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*"/i.exec(tag);
  const width = box ? Math.ceil(Number(box[3])) : 0;
  const height = box ? Math.ceil(Number(box[4])) : 0;
  if (!width || !height) return { svg, width: 0, height: 0 };
  const sized = tag
    .replace(/\s(width|height)="[^"]*"/gi, '')
    .replace(/\sstyle="[^"]*"/i, '')
    .replace(/^<svg\b/i, `<svg width="${width}" height="${height}"`);
  return { svg: svg.slice(0, open.index) + sized + svg.slice(open.index + tag.length), width, height };
}

/**
 * A render's failure in a line: Mermaid's first line, with what it expected
 * when that is a parse error ("Parse error on line 3: Expecting 'SQE', got
 * 'PS'"), cut short. The source itself is shown beside it.
 */
export function diagramError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : (err as { message?: unknown })?.message;
  const lines = String(raw ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return 'This diagram could not be drawn.';
  const expecting = lines.find(l => /^Expecting\b/.test(l));
  const line = lines[0].endsWith(':') && expecting ? `${lines[0]} ${expecting}` : lines[0];
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** svg-pan-zoom's options in each diagram's frame: no visible controls; the frame's script wires the gestures. */
export const PAN_ZOOM_OPTIONS = {
  controlIconsEnabled: false,
  zoomScaleSensitivity: 0.3,
  fit: true,
  center: true,
  mouseWheelZoomEnabled: true,
  dblClickZoomEnabled: false,
} as const;

/** How a frame takes gestures: a whole file is always live; a diagram in a reply or a Markdown file waits for a click. */
export type FrameMode = 'file' | 'embed';

/**
 * What a diagram's frame says to the page (`active`; and `waiting`, `drawn`
 * or `failed` with a `message`, see frameScript) and what the page may say
 * back (`deactivate`).
 */
export const FRAME_MESSAGE = 'termagMermaid';

/**
 * How long after its load a frame has to say anything (`waiting`, `drawn`,
 * `failed`) before the page takes its script for dead and shows the source
 * with an error instead of an empty frame. Its script is inline and runs
 * before the load event, so the wait is only the message's trip.
 */
export const FRAME_START_GRACE_MS = 2000;

/**
 * The frame's own script, after Hammer.js and svg-pan-zoom: svg-pan-zoom on
 * the SVG, with Hammer.js as its `customEventsHandler` for touch, as in
 * svg-pan-zoom's own mobile demo (one-finger pan, pinch around its centre),
 * double-click or double-tap to fit again, and its documented resize.
 *
 * An embed starts inactive, so the page around it scrolls as usual: a plain
 * wheel never reaches svg-pan-zoom (Ctrl/⌘ + wheel and a trackpad pinch, which
 * arrives as one, still zoom), nothing pans, and touch is the browser's.
 * A click or tap, or Enter, makes it active: then the wheel zooms around the
 * pointer, a drag pans, touch is Hammer's, +/- zoom and the arrows pan.
 * Escape, the frame losing focus (a click anywhere else) or the page's
 * `deactivate` makes it inactive again. Each change is posted to the page,
 * which draws the active frame's accent border.
 */
export function frameScript(mode: FrameMode): string {
  return `(function () {
  var FILE = ${mode === 'file'};
  var svg = document.querySelector('body > svg');
  var active = FILE;
  var hammer = null;
  var panZoom = null;
  function show() {
    document.body.classList.toggle('active', active);
    document.body.title = active ? '' : 'Click to zoom and pan';
    if (hammer) hammer.set({ enable: active, touchAction: active ? 'none' : 'auto' });
  }
  function setActive(on) {
    if (FILE || on === active) return;
    active = on;
    show();
    try { parent.postMessage({ ${FRAME_MESSAGE}: 'active', active: active }, '*'); } catch (e) { /* no page */ }
  }
  // svg-pan-zoom measures the SVG once, when it starts, and fits to that. A
  // frame the page hides (display: none, a 0-wide box) has a 0 x 0 SVG, and
  // so does one whose script runs before its document is laid out, which
  // Chrome does with this out-of-process frame while the window already has
  // its size. Fitted there, svg-pan-zoom's zoom is NaN (matrix(0,0,0,0,0,0)),
  // and every refit after it throws, so the diagram stayed blank. So it
  // starts only once the SVG itself has a box (on load, a resize, or the
  // SVG's ResizeObserver), isn't refitted while hidden again, and is thrown
  // away when its zoom comes out unusable or a refit throws: the SVG is then
  // the browser's plain picture at its viewBox until the next layout tries
  // again. The page is told 'waiting', 'drawn' or 'failed' (MermaidDiagram.tsx
  // shows the source and the error for a frame that fails or says nothing).
  var VIEW_BOX = svg.getAttribute('viewBox');
  var told = null;
  function tell(what, message) {
    if (what === told) return;
    told = what;
    var data = { ${FRAME_MESSAGE}: what };
    if (message) data.message = message;
    try { parent.postMessage(data, '*'); } catch (e) { /* no page */ }
  }
  function sized() {
    var box = svg.getBoundingClientRect();
    return innerWidth > 0 && innerHeight > 0 && box.width > 0 && box.height > 0;
  }
  function usable() {
    var zoom = panZoom.getZoom();
    return typeof zoom === 'number' && isFinite(zoom) && zoom > 0;
  }
  function drop() {
    var old = panZoom;
    panZoom = null;
    try { old.destroy(); } catch (e) { /* it was half made */ }
    var viewport = svg.querySelector('.svg-pan-zoom_viewport');
    if (viewport) { viewport.removeAttribute('transform'); viewport.removeAttribute('style'); }
    if (VIEW_BOX) svg.setAttribute('viewBox', VIEW_BOX);
  }
  function start() {
    if (panZoom) return;
    if (!sized()) { tell('waiting'); return; }
    try {
      panZoom = svgPanZoom(svg, options);
    } catch (e) {
      panZoom = null;
      if (VIEW_BOX) svg.setAttribute('viewBox', VIEW_BOX);
      tell('failed', String((e && e.message) || e));
      return;
    }
    if (!usable()) { drop(); return; }
    show();
    tell('drawn');
  }
  function refit() {
    if (!panZoom) { start(); return; }
    if (!sized()) return;
    try {
      panZoom.resize(); panZoom.fit(); panZoom.center();
    } catch (e) {
      drop();
      return;
    }
    if (!usable()) drop();
  }
  var eventsHandler = {
    haltEventListeners: ['touchstart', 'touchend', 'touchmove', 'touchleave', 'touchcancel'],
    init: function (options) {
      var instance = options.instance, initialScale = 1, pannedX = 0, pannedY = 0;
      hammer = new Hammer(options.svgElement, { inputClass: Hammer.TouchInput, touchAction: active ? 'none' : 'auto', enable: active });
      hammer.get('pinch').set({ enable: true });
      hammer.get('pan').set({ direction: Hammer.DIRECTION_ALL });
      hammer.get('pinch').recognizeWith(hammer.get('pan'));
      hammer.on('doubletap', function () { refit(); });
      hammer.on('panstart panmove', function (ev) {
        if (ev.type === 'panstart') { pannedX = 0; pannedY = 0; }
        instance.panBy({ x: ev.deltaX - pannedX, y: ev.deltaY - pannedY });
        pannedX = ev.deltaX; pannedY = ev.deltaY;
      });
      hammer.on('pinchstart pinchmove', function (ev) {
        if (ev.type === 'pinchstart') initialScale = instance.getZoom();
        instance.zoomAtPoint(initialScale * ev.scale, { x: ev.center.x, y: ev.center.y });
      });
      options.svgElement.addEventListener('touchmove', function (e) { if (active) e.preventDefault(); }, { passive: false });
    },
    destroy: function () { if (hammer) hammer.destroy(); }
  };
  var options = ${JSON.stringify(PAN_ZOOM_OPTIONS)};
  options.customEventsHandler = eventsHandler;
  options.beforePan = function () { return active; };
  // Inactive, a plain wheel scrolls the page: it never reaches svg-pan-zoom's own listener.
  addEventListener('wheel', function (e) { if (!active && !e.ctrlKey && !e.metaKey) e.stopPropagation(); }, { capture: true, passive: true });
  show();
  start();
  addEventListener('resize', refit);
  addEventListener('load', refit);
  if (typeof ResizeObserver === 'function') new ResizeObserver(refit).observe(svg);
  svg.addEventListener('dblclick', function () { if (active && panZoom) refit(); });
  document.addEventListener('click', function () { setActive(true); });
  addEventListener('blur', function () { setActive(false); });
  addEventListener('message', function (e) {
    if (e.source === parent && e.data && e.data.${FRAME_MESSAGE} === 'deactivate') setActive(false);
  });
  addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { setActive(false); return; }
    if (e.key === 'Enter') { setActive(true); return; }
    if (!active || !panZoom) return;
    var step = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[e.key];
    if (e.key === '+' || e.key === '=') panZoom.zoomIn();
    else if (e.key === '-' || e.key === '_') panZoom.zoomOut();
    else if (step) panZoom.panBy({ x: step[0], y: step[1] });
    else return;
    e.preventDefault();
  });
})();`;
}

/** The libraries a frame runs, as source: Hammer.js, then svg-pan-zoom. */
export interface FrameScripts { hammer: string; panZoom: string }

/**
 * A diagram's frame document: the SVG, then Hammer.js, svg-pan-zoom and
 * frameScript in one script carrying `nonce`. The CSP runs only that script,
 * so no handler attribute in a diagram runs, and loads nothing from
 * anywhere. The frame is sandboxed with `allow-scripts` alone, so its origin
 * is opaque. The only styling is the frame's size and the grab cursor.
 */
export function diagramDocument(svg: string, theme: DiagramTheme, scripts: FrameScripts, nonce: string, mode: FrameMode): string {
  const n = nonce.replace(/[^\w-]/g, '');
  const csp = `default-src 'none'; script-src 'nonce-${n}'; style-src 'unsafe-inline'; img-src data:; font-src data:`;
  const safe = (js: string) => js.replace(/<\/script/gi, '<\\/script');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<style>',
    `html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; color-scheme: ${theme.dark ? 'dark' : 'light'}; }`,
    'body > svg { display: block; width: 100% !important; height: 100% !important; max-width: none !important; }',
    'body.active > svg { cursor: grab; } body.active > svg:active { cursor: grabbing; }',
    '</style></head><body>',
    svg,
    `<script nonce="${n}">${safe(scripts.hammer)}\n${safe(scripts.panZoom)}\n${frameScript(mode)}</script>`,
    '</body></html>',
  ].join('\n');
}

let frameScripts: Promise<FrameScripts> | null = null;

/** Hammer.js's and svg-pan-zoom's source, fetched beside Mermaid on the first diagram and run inside each frame. */
export function loadFrameScripts(): Promise<FrameScripts> {
  if (!frameScripts) {
    frameScripts = Promise.all([
      import('hammerjs/hammer.min.js?raw'),
      import('svg-pan-zoom/dist/svg-pan-zoom.min.js?raw'),
    ]).then(([h, p]) => ({ hammer: h.default, panZoom: p.default }));
    frameScripts.catch(() => { frameScripts = null; });
  }
  return frameScripts;
}

/** A fresh nonce for one frame document. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

let mermaid: Promise<Mermaid> | null = null;

/** Mermaid itself, imported on first use; a failed import is tried again next time. */
export function loadMermaid(): Promise<Mermaid> {
  if (!mermaid) {
    mermaid = import('mermaid').then(m => m.default);
    mermaid.catch(() => { mermaid = null; });
  }
  return mermaid;
}

// Mermaid's config is global, so renders take turns: each sets its theme,
// parses and draws before the next starts.
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;

export function renderMermaid(source: string, theme: DiagramTheme): Promise<RenderedDiagram> {
  const run = async (): Promise<RenderedDiagram> => {
    const [m, scripts] = await Promise.all([loadMermaid(), loadFrameScripts()]);
    m.initialize(mermaidConfig(theme));
    const id = `termag-mmd-${++seq}`;
    try {
      const drawn = readableLabels(source, theme);
      await m.parse(drawn);
      const { svg } = await m.render(id, drawn);
      const sized = sizedSvg(svg);
      // An SVG with no size would be an empty frame: say so, with the source.
      if (!sized.width || !sized.height) throw new Error('Mermaid drew nothing for this diagram (its SVG has no size).');
      return { svg: sized.svg, width: sized.width, height: sized.height, theme, scripts };
    } finally {
      // Mermaid draws in a scratch element it may leave behind on a failure.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}
