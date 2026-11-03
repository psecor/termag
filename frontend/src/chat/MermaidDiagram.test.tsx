// @vitest-environment jsdom
// The real Mermaid, drawing in jsdom. jsdom does no layout, so text measures
// as 8 px a character (getBBox below); the diagrams' sizes are wrong, their
// content is not.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import MermaidDiagram from './MermaidDiagram';
import { Markdown } from './Markdown';

beforeAll(() => {
  const proto = SVGElement.prototype as unknown as { getBBox: () => DOMRect; getComputedTextLength: () => number };
  proto.getBBox = function (this: SVGElement) {
    const n = (this.textContent ?? '').length;
    return { x: 0, y: 0, width: n * 8, height: 16 } as DOMRect;
  };
  proto.getComputedTextLength = function (this: SVGElement) { return (this.textContent ?? '').length * 8; };
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.documentElement.removeAttribute('style');
});

/** Waits for the diagram to finish drawing (or failing). */
async function settled(): Promise<HTMLElement> {
  for (let i = 0; i < 200; i++) {
    const box = host.querySelector<HTMLElement>('.mmd');
    if (box && box.dataset.state !== 'drawing') return box;
    await act(() => new Promise(r => setTimeout(r, 10)));
  }
  throw new Error(`still drawing: ${host.innerHTML.slice(0, 300)}`);
}

/** The SVG a diagram's frame shows, read from its srcdoc. */
function svgOf(frame: HTMLIFrameElement): string {
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  const doc = new DOMParser().parseFromString(frame.getAttribute('srcdoc') ?? '', 'text/html');
  const svg = doc.querySelector('body > svg');
  expect(svg).not.toBeNull();
  return svg!.outerHTML;
}

/** The words a diagram's SVG shows, one space apart (Mermaid puts each word of a label in its own <tspan>). */
function textOf(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  return [...doc.querySelectorAll('text')].map(t => {
    const words = [...t.querySelectorAll('tspan.text-inner-tspan')].map(w => w.textContent ?? '');
    return words.length ? words.join(' ') : t.textContent ?? '';
  }).join(' ').replace(/\s+/g, ' ');
}

async function draw(source: string): Promise<HTMLElement> {
  await act(async () => root.render(<MermaidDiagram source={source} />));
  return settled();
}

const FLOWCHART = 'flowchart LR\n  A[Write the plan] --> B{Reviewed?}\n  B -->|yes| C[Ship it]\n  B -->|no| A';
const SEQUENCE = 'sequenceDiagram\n  participant Browser\n  participant Backend\n  Browser->>Backend: GET /api/spaces\n  Backend-->>Browser: 200 OK';
const KANBAN = [
  'kanban',
  '  todo[To do]',
  '    t1[Write the Mermaid tests]',
  '  doing[In progress]',
  '    t2[Lazy-load Mermaid]',
  '  done[Done]',
  '    t3[Pin mermaid 11.17.2]',
].join('\n');

describe('MermaidDiagram', () => {
  it.each([
    ['a flowchart', FLOWCHART, 'flowchart', ['Write the plan', 'Reviewed?', 'Ship it']],
    ['a sequence diagram', SEQUENCE, 'sequenceDiagram', ['Browser', 'Backend', 'GET /api/spaces', '200 OK']],
    ['a kanban board', KANBAN, 'kanban', ['To do', 'In progress', 'Done', 'Write the Mermaid tests', 'Lazy-load Mermaid', 'Pin mermaid 11.17.2']],
  ])('draws %s as an image of its SVG', async (_name, source, kind, labels) => {
    const box = await draw(source);
    expect(box.dataset.state).toBe('ok');
    expect(box.dataset.kind).toBe(kind);
    const frame = box.querySelector<HTMLIFrameElement>('iframe.mmd-frame')!;
    expect(frame.title).toBe(`${kind} diagram. Click or press Enter to zoom and pan, Escape to stop.`);
    const svg = svgOf(frame);
    expect(svg).toMatch(/^<svg width="\d+" height="\d+"/);
    for (const label of labels) expect(textOf(svg)).toContain(label);
    // Labels are SVG text, never HTML in a foreignObject.
    expect(svg).not.toContain('<foreignObject');
    // Nothing of the diagram is left in the page's own DOM.
    expect(document.querySelector('svg')).toBeNull();
  });

  it('draws a label on a light classDef fill in dark text, and the source it shows is the author\'s', async () => {
    const source = 'graph LR\n  pr909["#909 head"]\n  pr918["#918 babysitter"]\n  pr909 -.- pr918\n  classDef head fill:#d4f5d4,stroke:#2a7a2a;\n  class pr909 head;';
    const box = await draw(source);
    expect(box.dataset.state).toBe('ok');
    const doc = new DOMParser().parseFromString(svgOf(box.querySelector<HTMLIFrameElement>('iframe.mmd-frame')!), 'image/svg+xml');
    const node = [...doc.querySelectorAll('g.node')].find(n => n.classList.contains('head'))!;
    expect(node.querySelector('rect')!.getAttribute('style')).toContain('fill:#d4f5d4');
    expect(node.querySelector('.label')!.getAttribute('style')).toMatch(/color:#1f2328/);
    const other = [...doc.querySelectorAll('g.node')].find(n => !n.classList.contains('head'))!;
    expect(other.querySelector('.label')!.getAttribute('style') ?? '').not.toMatch(/#1f2328/);
    const toggle = [...box.querySelectorAll('button')].find(b => b.textContent === 'View source')!;
    await act(async () => toggle.click());
    expect(box.querySelector('.mmd-source')!.textContent).toBe(source);
  });

  it('shows the source with a short error when the diagram does not parse', async () => {
    const box = await draw('flowchart LR\n  A[Start] -->\n  this is not mermaid ]]]');
    expect(box.dataset.state).toBe('error');
    expect(box.querySelector('iframe')).toBeNull();
    const alert = box.querySelector('[role="alert"]')!;
    expect(alert.textContent).toMatch(/^Couldn't draw this diagram: .{1,160}$/);
    expect(alert.textContent).not.toContain('\n');
    expect(box.querySelector('.mmd-source')!.textContent).toBe('flowchart LR\n  A[Start] -->\n  this is not mermaid ]]]');
    // Mermaid leaves no "Syntax error" bomb behind in the page.
    expect(document.body.textContent).not.toMatch(/Syntax error in text/);
  });

  it('shows the source on a toggle, and the diagram again', async () => {
    const box = await draw(FLOWCHART);
    const toggle = [...box.querySelectorAll('button')].find(b => b.textContent === 'View source')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await act(async () => toggle.click());
    expect(box.querySelector('.mmd-source')!.textContent).toBe(FLOWCHART);
    expect(box.querySelector('iframe')).toBeNull();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await act(async () => toggle.click());
    expect(box.querySelector('iframe.mmd-frame')).not.toBeNull();
  });

  it('runs nothing a diagram carries: no click handlers, no HTML, no loosened security', async () => {
    const box = await draw([
      '%%{init: {"securityLevel": "loose", "htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%',
      'flowchart LR',
      '  A["<img src=x onerror=alert(1)>"] --> B["<script>alert(2)</script>"]',
      '  click A call alert("3")',
      '  click B "javascript:alert(4)"',
    ].join('\n'));
    expect(box.querySelector('[role="alert"]')?.textContent ?? 'ok').toBe('ok');
    const svg = svgOf(box.querySelector('iframe')!);
    expect(svg).not.toMatch(/onerror|<script|javascript:|onclick|<foreignObject|<img/i);
  });

  it('draws again in the page\'s new theme when it changes', async () => {
    const box = await draw(FLOWCHART);
    const dark = svgOf(box.querySelector('iframe')!);
    await act(async () => {
      document.documentElement.style.setProperty('--bg-surface', '#ffffff');
      document.documentElement.style.setProperty('--text-primary', '#1f2328');
    });
    let light = dark;
    for (let i = 0; i < 200 && light === dark; i++) {
      await act(() => new Promise(r => setTimeout(r, 10)));
      light = svgOf(host.querySelector('iframe')!);
    }
    expect(light).not.toBe(dark);
    expect(textOf(light)).toContain('Write the plan');
  });
});

describe('labels as SVG text in every diagram type', () => {
  // Bugbot on #821 suspected that htmlLabels: false only reached flowcharts,
  // leaving class, state and other diagrams on HTML labels in <foreignObject>.
  // In Mermaid 11 every diagram reads the top-level `htmlLabels`
  // (getEffectiveHtmlLabels; `flowchart.htmlLabels` is the deprecated
  // fallback), which mermaidConfig sets and `secure` locks. These hold that.
  // (A mindmap needs a 2D canvas jsdom lacks; it is checked in Chromium.)
  it.each([
    ['a class diagram', 'classDiagram\n  class Box {\n    +String name\n    +start()\n  }\n  Box <|-- Instance'],
    ['a state diagram', 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Working: prompt\n  Working --> Idle: done'],
    ['an ER diagram', 'erDiagram\n  PROJECT ||--o{ WORKSTREAM : has\n  PROJECT {\n    string name\n  }'],
    ['a timeline', 'timeline\n  title Mermaid in termag\n  Round 1 : file view : chat\n  Round 2 : look : gestures'],
    ['a requirement diagram', 'requirementDiagram\n  requirement safe {\n    id: 1\n    text: no HTML\n    risk: low\n    verifymethod: test\n  }'],
    ['a block diagram', 'block-beta\n  columns 2\n  a["Draw"] b["Show"]'],
    ['a flowchart with an %%{init}%% asking for HTML labels', '%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}, "class": {"htmlLabels": true}}}%%\nclassDiagram\n  class A'],
  ])('draws %s with no foreignObject, in the frame or in the page while it draws', async (_name, source) => {
    const added: string[] = [];
    const observer = new MutationObserver(records => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n instanceof Element && (n.localName === 'foreignObject' || n.querySelector('foreignObject'))) added.push(n.localName);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      const box = await draw(source);
      expect(box.querySelector('[role="alert"]')?.textContent ?? 'drawn').toBe('drawn');
      expect(svgOf(box.querySelector<HTMLIFrameElement>('iframe.mmd-frame')!)).not.toMatch(/<foreignObject/i);
      expect(added).toEqual([]);
    } finally {
      observer.disconnect();
    }
  });
});

describe('MermaidDiagram given a new source', () => {
  it('drops the old picture at once, rather than showing it under the new diagram\'s kind until the new one is drawn', async () => {
    await draw(FLOWCHART);
    // Hold the next render: the new source must not show the flowchart meanwhile.
    const mermaid = (await import('mermaid')).default;
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const parse = mermaid.parse.bind(mermaid);
    mermaid.parse = (async (...args: Parameters<typeof mermaid.parse>) => { await held; return parse(...args); }) as typeof mermaid.parse;
    try {
      await act(async () => root.render(<MermaidDiagram source={KANBAN} />));
      const box = host.querySelector<HTMLElement>('.mmd')!;
      expect(box.dataset.kind).toBe('kanban');
      expect(box.dataset.state).toBe('drawing');
      expect(box.querySelector('iframe')).toBeNull();
      release();
      const done = await settled();
      expect(textOf(svgOf(done.querySelector('iframe')!))).toContain('Pin mermaid 11.17.2');
    } finally {
      mermaid.parse = parse;
      release();
    }
  });
});

describe('a mermaid fence in a reply', () => {
  it('draws the kanban board once the fence has closed', async () => {
    const start = 'The board:\n\n```mermaid\n' + KANBAN.split('\n').slice(0, 3).join('\n');
    await act(async () => root.render(<Markdown text={start} streaming />));
    expect(host.querySelector('.mmd')).toBeNull();
    expect(host.querySelector('.md-pre code')!.textContent).toContain('To do');
    await act(async () => root.render(<Markdown text={'The board:\n\n```mermaid\n' + KANBAN + '\n```\n'} />));
    const box = await settled();
    expect(box.dataset.kind).toBe('kanban');
    expect(textOf(svgOf(box.querySelector('iframe')!))).toContain('Pin mermaid 11.17.2');
  });
});
