import React from 'react';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Markdown } from './Markdown';
import { splitFences } from './paneChat';
import {
  contrastRatio, DEFAULT_DIAGRAM_THEME, diagramColors, diagramCss, diagramDocument, diagramError, diagramKind, frameScript, luminance, mermaidConfig, PAN_ZOOM_OPTIONS, readableLabels, readDiagramTheme, sizedSvg, labelColorFor,
} from './mermaid';
import { frameStyle } from './MermaidDiagram';
import { isMermaidFence, isMermaidPath } from './mermaidFence';

describe('isMermaidPath', () => {
  it('takes .mmd and .mermaid in any case, and nothing else', () => {
    for (const p of ['flow.mmd', 'docs/board.mermaid', 'A.MMD', 'x/y/Z.Mermaid']) expect(isMermaidPath(p)).toBe(true);
    for (const p of ['notes.md', 'mmd', '.mmd', 'flow.mmd.txt', 'mermaid.ts', 'x.mm', 'README.markdown']) expect(isMermaidPath(p)).toBe(false);
  });
});

describe('isMermaidFence', () => {
  it('is the info string\'s first word, case-insensitively', () => {
    for (const l of ['mermaid', 'Mermaid', ' MERMAID ', 'mermaid title="x"']) expect(isMermaidFence(l)).toBe(true);
    for (const l of [null, undefined, '', 'mmd', 'mermaidjs', 'js mermaid', 'spec']) expect(isMermaidFence(l)).toBe(false);
  });
});

describe('a ```mermaid fence in Markdown', () => {
  const html = (text: string, streaming = false) => renderToStaticMarkup(<Markdown text={text} streaming={streaming} />);
  const fence = '```mermaid\nflowchart LR\n  A --> B\n```';

  it('is a diagram once its fence closes', () => {
    const out = html(`Here:\n\n${fence}\n\nDone.`);
    expect(out).toContain('class="mmd"');
    expect(out).not.toContain('<pre><code>flowchart');
  });

  it('stays code while it streams, so a half-written diagram shows no error', () => {
    const out = html('Here:\n\n```mermaid\nflowchart LR\n  A --', true);
    expect(out).not.toContain('class="mmd');
    expect(out).toContain('<pre><code>flowchart LR\n  A --</code></pre>');
    expect(out).toContain('<span>mermaid</span>');
  });

  it('leaves every other fence as code', () => {
    const out = html('```js\nconst a = 1;\n```\n\n```\nflowchart LR\n```');
    expect(out).not.toContain('class="mmd');
    expect(out.match(/<pre>/g)).toHaveLength(2);
  });
});

describe('splitFences (pane chat)', () => {
  it('keeps each code part\'s language and marks one with no closing fence', () => {
    expect(splitFences('Look:\n```mermaid\nkanban\n  todo[To do]\n```\nand\n```mermaid\nflowchart')).toEqual([
      { code: false, text: 'Look:' },
      { code: true, text: 'kanban\n  todo[To do]', lang: 'mermaid' },
      { code: false, text: 'and' },
      { code: true, text: 'flowchart', lang: 'mermaid', open: true },
    ]);
    expect(splitFences('```\nplain\n```')).toEqual([{ code: true, text: 'plain' }]);
  });

  // Bugbot on #821: a fence of four or more backticks kept the extra
  // backticks in its language, so a ````mermaid board stayed code.
  it('reads the language after any number of backticks, and closes only on a fence at least as long', () => {
    expect(splitFences('Board:\n````mermaid\nkanban\n  todo[To do]\n````')).toEqual([
      { code: false, text: 'Board:' },
      { code: true, text: 'kanban\n  todo[To do]', lang: 'mermaid' },
    ]);
    expect(splitFences('````md\nan example:\n```mermaid\nflowchart\n```\n````\nafter')).toEqual([
      { code: true, text: 'an example:\n```mermaid\nflowchart\n```', lang: 'md' },
      { code: false, text: 'after' },
    ]);
    expect(splitFences('  ```` mermaid  \nflowchart\n  ````')).toEqual([{ code: true, text: 'flowchart', lang: 'mermaid' }]);
  });
});

describe('diagramKind', () => {
  it('is the first keyword, past frontmatter, comments and directives', () => {
    expect(diagramKind('flowchart LR\n A --> B')).toBe('flowchart');
    expect(diagramKind('\n%% a comment\n%%{init: {"theme": "forest"}}%%\nsequenceDiagram\n A->>B: hi')).toBe('sequenceDiagram');
    expect(diagramKind('---\ntitle: Board\nconfig:\n  kanban: {}\n---\nkanban\n  todo[To do]')).toBe('kanban');
    expect(diagramKind('')).toBeNull();
    expect(diagramKind('%% only a comment')).toBeNull();
  });
});

describe('luminance', () => {
  it('reads hex and rgb colours, and nothing else', () => {
    expect(luminance('#000')).toBe(0);
    expect(luminance('#ffffff')).toBeCloseTo(1);
    expect(luminance('#161b22')!).toBeLessThan(0.5);
    expect(luminance('rgb(250, 250, 250)')!).toBeGreaterThan(0.5);
    expect(luminance('var(--x)')).toBeNull();
    expect(luminance('')).toBeNull();
  });
});

describe('mermaidConfig', () => {
  it('is strict, draws labels as SVG text, and a diagram\'s own config cannot loosen either', () => {
    const c = mermaidConfig(DEFAULT_DIAGRAM_THEME);
    expect(c.securityLevel).toBe('strict');
    expect(c.htmlLabels).toBe(false);
    expect(c.flowchart?.htmlLabels).toBe(false);
    expect(c.startOnLoad).toBe(false);
    expect(c.secure).toEqual(expect.arrayContaining(['securityLevel', 'secure', 'htmlLabels', 'flowchart', 'themeCSS', 'maxTextSize']));
  });

  it('is Mermaid\'s base theme in termag\'s tokens, not one of its stock themes', () => {
    const t = DEFAULT_DIAGRAM_THEME;
    const c = mermaidConfig(t);
    expect(c).toMatchObject({ theme: 'base', darkMode: true, look: 'classic', fontFamily: t.font });
    expect(c.themeVariables).toMatchObject({
      darkMode: true,
      fontFamily: t.font,
      fontSize: '14px',
      background: '#161b22',             // --bg-surface
      primaryColor: '#21262d',           // --bg-elevated: node fill
      mainBkg: '#21262d',
      primaryBorderColor: '#626a72',     // --border, raised toward --text-secondary to 3:1 on the canvas
      nodeBorder: '#626a72',
      primaryTextColor: '#c9d1d9',       // --text-primary
      textColor: '#c9d1d9',
      lineColor: '#8b949e',              // --text-secondary: edges and arrowheads
      signalColor: '#8b949e',
      noteBorderColor: '#58a6ff',        // --accent
      activationBorderColor: '#58a6ff',
      actorBkg: '#21262d',
      clusterBkg: '#0d1117',             // --bg-base: kanban columns
      cScale0: '#0d1117',
      cScale11: '#0d1117',
      cScaleLabel0: '#c9d1d9',
      cScaleLabel11: '#c9d1d9',
    });
  });

  it('gives flowcharts more room and curved edges, and sequence diagrams and kanban boards more spacing', () => {
    const c = mermaidConfig(DEFAULT_DIAGRAM_THEME);
    expect(c.flowchart).toMatchObject({ htmlLabels: false, padding: 14, nodeSpacing: 46, rankSpacing: 54, curve: 'basis' });
    expect(c.sequence).toMatchObject({ actorMargin: 56, mirrorActors: false });
    expect(c.kanban).toMatchObject({ padding: 12, sectionWidth: 220 });
    expect(c.secure).toEqual(expect.arrayContaining(['look', 'themeVariables', 'theme']));
  });

  it('rounds nodes and cards, thins edges, and shades cards like termag\'s, all in the theme\'s colours', () => {
    const css = diagramCss(DEFAULT_DIAGRAM_THEME);
    expect(css).toContain('.node rect { rx: 8px; ry: 8px; }');
    expect(css).toContain('.flowchart-link, .edge-thickness-normal { stroke-width: 1.25px; }');
    expect(css).toContain('.marker, marker path { fill: #8b949e; stroke: #8b949e;');
    expect(css).toMatch(/\.cluster rect \{ fill: #0d1117; stroke: #626a72;/);
    expect(css).toMatch(/\.cluster-label text, \.cluster-label tspan \{ fill: #c9d1d9; font-weight: 600;/);
    expect(css).toMatch(/\.node rect\.label-container \{ fill: #21262d; stroke: #626a72; rx: 8px; ry: 8px; filter: drop-shadow/);
    expect(mermaidConfig(DEFAULT_DIAGRAM_THEME).themeCSS).toBe(css);
  });

  it('follows a light page in the same way', () => {
    const light = { ...DEFAULT_DIAGRAM_THEME, dark: false, background: '#ffffff', node: '#f6f8fa', text: '#1f2328' };
    expect(mermaidConfig(light)).toMatchObject({
      theme: 'base', darkMode: false,
      themeVariables: { background: '#ffffff', primaryColor: '#f6f8fa', primaryTextColor: '#1f2328', cScaleLabel1: '#1f2328' },
    });
  });
});

describe('readDiagramTheme', () => {
  it('reads termag\'s tokens from <html>, and falls back to the defaults for any it cannot read', () => {
    const root = { } as Element;
    const vars: Record<string, string> = {
      '--bg-surface': '#ffffff', '--bg-elevated': '#f6f8fa', '--bg-base': '#eaeef2', '--border': '#d0d7de',
      '--text-primary': '#1f2328', '--text-secondary': '#59636e', '--accent': 'var(--nope)', '--font-ui': 'system-ui',
    };
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (n: string) => vars[n] ?? '', colorScheme: '' }));
    try {
      expect(readDiagramTheme(root)).toEqual({
        dark: false, background: '#ffffff', node: '#f6f8fa', sunken: '#eaeef2', border: '#d0d7de',
        text: '#1f2328', muted: '#59636e', accent: '#0969da', danger: '#cf222e', font: 'system-ui', fontSize: '14px',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('diagramDocument', () => {
  const scripts = { hammer: 'window.Hammer = function () {};', panZoom: 'window.svgPanZoom = function () {};' };
  const doc = diagramDocument('<svg viewBox="0 0 10 10"><text>x</text></svg>', DEFAULT_DIAGRAM_THEME, scripts, 'abc123', 'embed');

  it('runs only its own nonce\'d script and loads nothing from anywhere', () => {
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-abc123'; style-src 'unsafe-inline'; img-src data:; font-src data:">`);
    expect(doc.match(/<script\b/g)).toHaveLength(1);
    expect(doc).toContain('<script nonce="abc123">window.Hammer = function () {};\nwindow.svgPanZoom = function () {};');
  });

  it('attaches svg-pan-zoom once, with no visible controls and Hammer.js as its touch handler', () => {
    expect(doc.match(/svgPanZoom\(/g)).toHaveLength(1);
    expect(PAN_ZOOM_OPTIONS).toEqual({
      controlIconsEnabled: false, zoomScaleSensitivity: 0.3, fit: true, center: true, mouseWheelZoomEnabled: true, dblClickZoomEnabled: false,
    });
    expect(doc).toContain(`var options = ${JSON.stringify(PAN_ZOOM_OPTIONS)};`);
    expect(doc).toContain('options.customEventsHandler = eventsHandler;');
    expect(doc).toContain("haltEventListeners: ['touchstart', 'touchend', 'touchmove', 'touchleave', 'touchcancel']");
    expect(doc).not.toContain('svg-pan-zoom-control');
  });

  it('is live from the start for a whole file, and waits for a click in an embed', () => {
    expect(frameScript('file')).toContain('var FILE = true;');
    expect(frameScript('embed')).toContain('var FILE = false;');
    expect(diagramDocument('<svg/>', DEFAULT_DIAGRAM_THEME, scripts, 'n', 'file')).toContain('var FILE = true;');
  });

  it('cannot be closed early by a library\'s text, or by a nonce', () => {
    expect(diagramDocument('<svg/>', DEFAULT_DIAGRAM_THEME, { hammer: 'a = "</script>";', panZoom: '' }, 'n', 'file')).not.toMatch(/a = "<\/script>"/);
    expect(diagramDocument('<svg/>', DEFAULT_DIAGRAM_THEME, scripts, 'n"><script>', 'file')).toContain('<script nonce="nscript">');
  });
});

describe('frameStyle in the file view', () => {
  // Bugbot on #821: a height from the window (100vh - 140px) can outgrow the
  // file pane, and .mmd's overflow: hidden then cuts the diagram off. A
  // whole-file frame takes the pane's height instead.
  it('sets no height of its own, only the width cap that keeps the fit from enlarging the diagram', () => {
    expect(frameStyle({ width: 100, height: 50 }, true)).toEqual({ width: 'min(100%, 220px)' });
    expect(frameStyle({ width: 900, height: 2400 }, true)).toEqual({ width: 'min(100%, 900px)' });
  });

  it('is a flex child that fills the pane and may shrink below its content (mermaid.css)', () => {
    const css = readFileSync(join(__dirname, 'mermaid.css'), 'utf8');
    const rule = /\.mmd-file \.mmd-frame \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/flex: 1( 1 0(px|%)?)?;/);
    expect(rule).toMatch(/min-height: 0;/);
    expect(/\.mmd-file \{([^}]*)\}/.exec(css)?.[1]).toMatch(/min-height: 0;/);
  });
});

describe('frameStyle', () => {
  it('is never wider than the diagram, fits the box\'s width at its aspect, and leaves room for the icons', () => {
    expect(frameStyle({ width: 400, height: 100 }, false)).toEqual({
      width: 'min(100%, 400px)', height: 'calc(min(100cqw * 0.2500, 100px) + 16px)', maxHeight: 'min(70vh, 720px)',
    });
    expect(frameStyle({ width: 0, height: 0 }, true)).toBeUndefined();
    expect(frameStyle({ width: 0, height: 0 }, false)).toBeUndefined();
  });
});

describe('sizedSvg', () => {
  it('gives the SVG its viewBox size, so the <img> draws at that size', () => {
    const svg = '<svg id="m1" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 412.5px;" viewBox="-8 -8 412.5 120.2"><g/></svg>';
    const out = sizedSvg(svg);
    expect(out).toMatchObject({ width: 413, height: 121 });
    expect(out.svg).toBe('<svg width="413" height="121" id="m1" xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 412.5 120.2"><g/></svg>');
  });

  it('leaves an SVG with no viewBox alone, and refuses no SVG at all', () => {
    expect(sizedSvg('<svg><g/></svg>')).toEqual({ svg: '<svg><g/></svg>', width: 0, height: 0 });
    expect(() => sizedSvg('<div>nope</div>')).toThrow();
  });
});

describe('diagramError', () => {
  it('is Mermaid\'s first line, cut short', () => {
    expect(diagramError(new Error('Parse error on line 2:\n...A -->\n-------^\nExpecting \'X\', got \'EOF\''))).toBe('Parse error on line 2: Expecting \'X\', got \'EOF\'');
    expect(diagramError(new Error('Parse error on line 2:\n...A -->'))).toBe('Parse error on line 2:');
    expect(diagramError(new Error(`No diagram type detected matching given configuration for text: ${'x'.repeat(400)}`))).toHaveLength(160);
    expect(diagramError({ message: 'Lexical error' })).toBe('Lexical error');
    expect(diagramError(undefined)).toBe('This diagram could not be drawn.');
  });
});

describe('Mermaid stays out of the bundles', () => {
  it('is only ever imported dynamically, by chat/mermaid.ts', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(join(__dirname, '..'));
    const statics = files.filter(f => /^\s*import\s+(?!type\b)[^;]*from\s+['"]mermaid['"]/m.test(readFileSync(f, 'utf8')));
    expect(statics).toEqual([]);
    const dynamic = files.filter(f => /import\(\s*['"]mermaid['"]\s*\)/.test(readFileSync(f, 'utf8')));
    // Relative to frontend/, not sliced at the first `src/`: a checkout can sit
    // under a directory of that name (~/src/termag on a box).
    const frontend = join(__dirname, '..', '..');
    expect(dynamic.map(f => relative(frontend, f).split(sep).join('/'))).toEqual(['src/chat/mermaid.ts']);
  });
});

const LIGHT = { ...DEFAULT_DIAGRAM_THEME, dark: false, background: '#ffffff', node: '#f6f8fa', sunken: '#eaeef2', border: '#d0d7de', text: '#1f2328', muted: '#59636e', accent: '#0969da', danger: '#cf222e' };

describe('readableLabels', () => {
  const reported = [
    'graph LR',
    '  pr909["#909 head"]',
    '  pr909 -.- pr918',
    '  classDef head fill:#d4f5d4,stroke:#2a7a2a;',
    '  class pr909 head;',
  ].join('\n');

  it('gives a classDef that sets a light fill dark label text, keeping its line', () => {
    const out = readableLabels(reported, DEFAULT_DIAGRAM_THEME);
    expect(out.split('\n')).toHaveLength(5);
    expect(out.split('\n')[3]).toBe('  classDef head fill:#d4f5d4,stroke:#2a7a2a,color:#1f2328;');
    expect(contrastRatio('#1f2328', '#d4f5d4')!).toBeGreaterThanOrEqual(4.5);
  });

  it('gives a dark fill light text, through style as well as classDef, rgb() included', () => {
    const out = readableLabels('flowchart TD\n  A --> B\n  style A fill:#1f6feb\n  classDef x fill:rgb(20, 30, 40),stroke:#333', LIGHT).split('\n');
    expect(out[2]).toBe('  style A fill:#1f6feb,color:#ffffff');
    expect(out[3]).toBe('  classDef x fill:rgb(20, 30, 40),stroke:#333,color:#ffffff');
  });

  it('keeps an author\'s own color, and leaves statements with no fill alone', () => {
    const src = 'flowchart TD\n  classDef a fill:#fff,color:#f00\n  classDef b stroke:#333\n  style C color:red';
    expect(readableLabels(src, DEFAULT_DIAGRAM_THEME)).toBe(src);
  });

  it('reads a translucent fill over the canvas it sits on', () => {
    const out = readableLabels('stateDiagram-v2\n  classDef t fill:#ffffff10', DEFAULT_DIAGRAM_THEME);
    expect(out).toBe('stateDiagram-v2\n  classDef t fill:#ffffff10,color:#ffffff');
  });

  it('asks the page for a named colour, and changes nothing it cannot read', () => {
    const named = (c: string) => (c === 'lightgreen' ? 'rgb(144, 238, 144)' : null);
    expect(readableLabels('graph LR\n  style A fill:lightgreen', DEFAULT_DIAGRAM_THEME, named)).toBe('graph LR\n  style A fill:lightgreen,color:#1f2328');
    expect(readableLabels('graph LR\n  style A fill:url(#g)', DEFAULT_DIAGRAM_THEME, named)).toBe('graph LR\n  style A fill:url(#g)');
  });

  // flowchart-elk (the ELK layout) and swimlane-beta are flowcharts by another keyword: the same grammar, classDef and style included.
  it.each(['flowchart-elk TD', 'swimlane-beta LR'])('gives %s\'s author fills a label colour like any flowchart', header => {
    const out = readableLabels(`${header}\n  A --> B\n  classDef head fill:#d4f5d4;\n  style B fill:#1f6feb`, DEFAULT_DIAGRAM_THEME).split('\n');
    expect(out[2]).toBe('  classDef head fill:#d4f5d4,color:#1f2328;');
    expect(out[3]).toBe('  style B fill:#1f6feb,color:#ffffff');
  });

  it('only touches diagrams whose classDef and style take a color', () => {
    const src = 'sequenceDiagram\n  style A fill:#fff';
    expect(readableLabels(src, DEFAULT_DIAGRAM_THEME)).toBe(src);
  });

  it('picks whichever text reads at 4.5:1 on any fill', () => {
    for (let v = 0; v <= 255; v += 5) {
      const fill = `rgb(${v}, ${v}, ${v})`;
      expect(contrastRatio(labelColorFor(fill, '#000000')!, fill)!).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// The audit's pairs (improve-termag:artifacts/mermaid-a11y/audit.md), for
// termag's dark tokens and the light fallback: WCAG AA, 4.5:1 for text and
// 3:1 for the graphics a reader needs (outlines, edges, arrowheads, lifelines).
describe('the diagram theme meets WCAG AA', () => {
  for (const [name, t] of [['dark', DEFAULT_DIAGRAM_THEME], ['light', LIGHT]] as const) {
    it(name, () => {
      const v = mermaidConfig(t).themeVariables as Record<string, string>;
      const c = diagramColors(t);
      const text: Array<[string, string, string]> = [
        ['node text', v.nodeTextColor, v.mainBkg],
        ['edge label', t.muted, v.edgeLabelBackground],
        ['cluster title', t.text, v.clusterBkg],
        ['actor text', v.actorTextColor, v.actorBkg],
        ['message text', v.signalTextColor, t.background],
        ['note text', v.noteTextColor, v.noteBkgColor],
        ['loop label', v.labelTextColor, v.labelBoxBkgColor],
        ['task text', v.taskTextColor, v.taskBkgColor],
        ['active task text', v.taskTextDarkColor, v.activeTaskBkgColor],
        ['done task text', v.taskTextDarkColor, v.doneTaskBkgColor],
        ['critical task text', v.taskTextColor, v.critBkgColor],
        ['kanban column', v.cScaleLabel0, v.cScale0],
      ];
      for (const [what, fg, bg] of text) expect([what, contrastRatio(fg, bg)! >= 4.5]).toEqual([what, true]);
      const graphics: Array<[string, string]> = [
        ['node outline', v.nodeBorder], ['cluster outline', v.clusterBorder], ['actor outline', v.actorBorder], ['lifeline', v.actorLineColor],
        ['edge', v.lineColor], ['message line', v.signalColor], ['note outline', v.noteBorderColor], ['task outline', v.taskBorderColor],
        ['active task outline', v.activeTaskBorderColor], ['critical task outline', v.critBorderColor], ['today line', v.todayLineColor],
        ['start state', v.specialStateColor], ['gantt grid', v.gridColor], ['outline in themeCSS', c.graphic],
      ];
      for (const [what, fg] of graphics) expect([what, contrastRatio(fg, t.background)! >= 3]).toEqual([what, true]);
    });
  }
});
