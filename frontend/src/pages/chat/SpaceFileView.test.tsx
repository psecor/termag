// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceTree, SpaceViewUrl } from '../../services/api';
import { SpaceFileView } from './SpaceFileView';
import { ExplorerPanel } from './FileExplorer';
import { ChatChromeProvider, type ChatChrome } from './chatChrome';

const TREE: Record<string, { dirs: string[]; files: string[] }> = {
  '': { dirs: ['docs/', 'src/'], files: ['README.md'] },
  'docs/': { dirs: ['deep/'], files: ['docs/r.pdf'] },
  'docs/deep/': { dirs: [], files: ['docs/deep/plan.md'] },
  'src/': { dirs: [], files: ['src/main.ts'] },
};
const listing = (prefix: string, recursive: boolean): SpaceTree => {
  const t = recursive ? { dirs: [], files: Object.values(TREE).flatMap(x => x.files) } : TREE[prefix];
  const name = (p: string) => p.replace(/\/$/, '').split('/').pop()!;
  return {
    prefix, nextCursor: null,
    dirs: t.dirs.map(d => ({ name: name(d), path: prefix + d })),
    files: t.files.map(path => ({ name: name(path), path, size: 1, modifiedAt: null })),
  };
};
const mocks = vi.hoisted(() => ({
  view: vi.fn<(space: string, path: string) => Promise<SpaceViewUrl>>(),
  tree: vi.fn(async (_space: string, _prefix: string, _cursor?: string | null, _recursive?: boolean): Promise<SpaceTree> => ({ prefix: '', dirs: [], files: [], nextCursor: null })),
  open: vi.fn(),
  tabs: [] as Array<{ id: string; kind: string }>,
}));
vi.mock('./simpleData', () => {
  const data = () => ({
    items: { open: mocks.open, state: { items: mocks.tabs } }, rows: [], live: new Map(), setupOf: new Map(), links: [], activeTab: 't1', itemsShown: true,
    spaces: { enabled: true, loaded: true, spaces: [], index: new Map() },
  });
  return { WithSimpleData: ({ children }: { children: React.ReactNode }) => children, useSimpleData: data, useSimpleDataIfAny: data };
});
vi.mock('../../services/api', () => ({ spacesApi: { view: mocks.view, tree: mocks.tree } }));
vi.mock('../../services/spaceTransfer', () => ({ downloadFile: vi.fn(), errorMessage: (_e: unknown, f: string) => f }));

const signed = (view: SpaceViewUrl['view'], size = 10): SpaceViewUrl => ({
  url: 'https://bucket.s3.test/get/x?sig=1', expiresAt: '', size, contentType: null, view,
});

let root: Root;
let host: HTMLDivElement;
let location = '';
function Probe() {
  const l = useLocation();
  location = l.pathname + l.search;
  return null;
}

beforeEach(() => {
  mocks.tree.mockImplementation(async (_s, prefix, _c, recursive) => listing(prefix, !!recursive));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  mocks.view.mockReset();
  mocks.tabs = [];
});

function touchScreen() {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)', media: q, addEventListener: () => {}, removeEventListener: () => {} }));
}

async function open(path: string, space = 'notes', chrome?: Partial<ChatChrome>) {
  const page = (
    <MemoryRouter initialEntries={[`/chat/f/${space}/${path}`]}>
      <Routes><Route path="/chat/f/:space/*" element={<SpaceFileView />} /></Routes>
      <Probe />
    </MemoryRouter>
  );
  await act(async () => {
    root.render(chrome
      ? <ChatChromeProvider value={{ mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, ...chrome }}>{page}</ChatChromeProvider>
      : page);
  });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

describe('SpaceFileView', () => {
  it('frames a PDF for the browser viewer without a sandbox', async () => {
    mocks.view.mockResolvedValue(signed({ contentType: 'application/pdf', render: 'frame' }));
    await open('docs/r.pdf');
    const frame = host.querySelector('iframe.fv-frame')!;
    expect(mocks.view).toHaveBeenCalledWith('notes', 'docs/r.pdf');
    expect(frame.getAttribute('src')).toBe('https://bucket.s3.test/get/x?sig=1');
    expect(frame.hasAttribute('sandbox')).toBe(false);
  });

  it('offers Open PDF on a touch screen, where a framed PDF shows a page or nothing', async () => {
    touchScreen();
    mocks.view.mockResolvedValue(signed({ contentType: 'application/pdf', render: 'frame' }, 2048));
    await open('docs/r.pdf');
    expect(host.querySelector('iframe')).toBeNull();
    const link = host.querySelector<HTMLAnchorElement>('a.fv-open-btn')!;
    expect(link.textContent).toBe('Open PDF');
    expect(link.getAttribute('href')).toBe('https://bucket.s3.test/get/x?sig=1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(host.textContent).toContain("can't show a PDF inside the page");
  });

  it('shows an image as an <img> scaled to fit, not a frame', async () => {
    mocks.view.mockResolvedValue(signed({ contentType: 'image/png', render: 'frame' }));
    await open('architecture.png');
    expect(host.querySelector('iframe')).toBeNull();
    const img = host.querySelector<HTMLImageElement>('.fv-image img')!;
    expect(img.getAttribute('src')).toBe('https://bucket.s3.test/get/x?sig=1');
    expect(img.getAttribute('alt')).toBe('architecture.png');
  });

  it('plays video and audio inline in the browser\'s player, not a frame', async () => {
    mocks.view.mockResolvedValue(signed({ contentType: 'video/mp4', render: 'frame' }));
    await open('demo/clip.mp4');
    expect(host.querySelector('iframe')).toBeNull();
    const video = host.querySelector('video')!;
    expect(video.getAttribute('src')).toBe('https://bucket.s3.test/get/x?sig=1');
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    act(() => root.unmount());
    root = createRoot(host);
    mocks.view.mockResolvedValue(signed({ contentType: 'audio/mpeg', render: 'frame' }));
    await open('demo/song.mp3');
    expect(host.querySelector('audio')?.hasAttribute('controls')).toBe(true);
  });

  it('renders HTML as the srcdoc of a frame sandboxed with no allowances, never by URL', async () => {
    const html = '<h1>Demo</h1><script>parent.document.title = "pwned"</script>';
    mocks.view.mockResolvedValue(signed({ contentType: 'text/plain; charset=utf-8', render: 'html' }));
    const fetched = vi.fn(async () => new Response(html));
    vi.stubGlobal('fetch', fetched);
    await open('demo/page.html');
    const frame = host.querySelector('iframe.fv-frame')!;
    expect(fetched).toHaveBeenCalledWith('https://bucket.s3.test/get/x?sig=1', {});
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toBe(html);
    expect(frame.hasAttribute('src')).toBe(false);
  });

  it('says when an HTML preview is cut at the cap', async () => {
    mocks.view.mockResolvedValue(signed({ contentType: 'text/plain; charset=utf-8', render: 'html' }, 1024 * 1024));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<p>start', { status: 206 })));
    await open('demo/big.html');
    expect(host.querySelector('iframe.fv-html')).not.toBeNull();
    expect(host.querySelector('.fv-note')?.textContent).toBe('Showing the first 256 KiB of 1.0 MiB; download for the rest.');
  });

  it('tells you to close a gone file\'s tab from its ⋮ menu', async () => {
    mocks.view.mockRejectedValue({ response: { status: 404, data: { code: 'file_not_found' } } });
    await open('docs/gone.md');
    expect(host.textContent).toContain('Close its tab from the ⋮ menu.');
    expect(host.textContent).not.toContain('×');
  });

  it('shows SVG as a data: URL in an <img>, not a frame', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>';
    mocks.view.mockResolvedValue(signed({ contentType: 'text/plain; charset=utf-8', render: 'svg' }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(svg)));
    await open('logo.svg');
    expect(host.querySelector('iframe')).toBeNull();
    const img = host.querySelector<HTMLImageElement>('.fv-svg img')!;
    expect(img.getAttribute('src')).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  });

  it('renders markdown itself and frames nothing', async () => {
    mocks.view.mockResolvedValue(signed({ contentType: 'text/plain; charset=utf-8', render: 'markdown' }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('# Title\n\nbody')));
    await open('README.md');
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.querySelector('.fv-md')?.textContent).toContain('Title');
    expect(host.querySelector('.fv-md')?.textContent).not.toContain('#');
  });

  it('offers a download for a type the browser cannot show', async () => {
    mocks.view.mockResolvedValue(signed(null));
    await open('deck.pptx');
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.textContent).toContain("Your browser can't show this kind of file.");
  });

  it('puts its actions under ⋮ on a phone', async () => {
    mocks.view.mockResolvedValue(signed(null));
    await open('README.md', 'phone', { mode: 'drawer' });
    expect(host.querySelector('.fx-panel')).toBeNull();
    act(() => { host.querySelector<HTMLButtonElement>('.fv-more')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 300, clientY: 40 })); });
    expect([...document.querySelectorAll('.chat-ctx-menu [role=menuitem]')].map(b => b.textContent)).toEqual(['Reload', 'Copy link', 'Download']);
  });
});

describe('the explorer (the side panel\'s Files) on a file', () => {
  async function explorer(path: string, space: string) {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[`/chat/f/${space}/${path}`]}>
          <Routes><Route path="/chat/f/:space/*" element={<ExplorerPanel space={space} activePath={path} />} /></Routes>
          <Probe />
        </MemoryRouter>,
      );
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  }

  it('opens the file\'s folders and marks it', async () => {
    await explorer('docs/deep/plan.md', 'beside');
    const panel = host.querySelector('.fx-panel')!;
    expect(panel.getAttribute('aria-label')).toBe('Explorer for beside');
    expect([...panel.querySelectorAll('.fx-dir[aria-expanded="true"]')].map(d => d.textContent)).toEqual(['docs', 'deep']);
    expect(panel.querySelector('.fx-row.active')!.textContent).toBe('plan.md');
    expect(panel.querySelector('.fx-search input')).not.toBeNull();
    expect(panel.querySelector('.fx-collapse')).toBeNull();
  });

  it('lists the space\'s root for a file at the top level', async () => {
    await explorer('README.md', 'root');
    expect([...host.querySelectorAll('.fx-panel .fx-name')].map(n => n.textContent)).toEqual(['docs', 'src', 'README.md']);
    expect(host.querySelector('.fx-panel .fx-row.active')!.textContent).toBe('README.md');
  });

  it('shows a file picked in it in this tab', async () => {
    await explorer('README.md', 'pick');
    const main = [...host.querySelectorAll<HTMLAnchorElement>('.fx-panel a.fx-row')].find(a => a.textContent === 'README.md')!;
    expect(main.getAttribute('href')).toBe('/chat/f/pick/README.md');
    act(() => { [...host.querySelectorAll<HTMLButtonElement>('.fx-dir')][1].click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const ts = [...host.querySelectorAll<HTMLAnchorElement>('.fx-panel a.fx-row')].find(a => a.textContent === 'main.ts')!;
    await act(async () => { ts.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    expect(mocks.open).toHaveBeenCalledWith({ kind: 'file', space: 'pick', path: 'src/main.ts' }, 't1');
    expect(location).toBe('/chat/f/pick/src/main.ts?tab=t1');
  });

  it('searches file names at every depth, highlighting the match', async () => {
    await explorer('README.md', 'search');
    const input = host.querySelector<HTMLInputElement>('.fx-search input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'plan');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(mocks.tree).toHaveBeenCalledWith('search', '', null, true);
    const hits = [...host.querySelectorAll('.fx-hit')];
    expect(hits.map(h => h.querySelector('.fx-name')!.textContent)).toEqual(['plan.md']);
    expect(hits[0].querySelector('mark')!.textContent).toBe('plan');
    expect(hits[0].querySelector('.fx-where')!.textContent).toBe('docs/deep');
  });
});

describe('SpaceFileView with the side panel', () => {
  it('has no explorer column and offers Tools in its header and ⋮', async () => {
    mocks.view.mockResolvedValue(signed({ contentType: 'text/plain; charset=utf-8', render: 'markdown' }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('hi')));
    const toggle = vi.fn();
    await open('README.md', 'notes', { sidePanel: { open: false, toggle } });
    expect(host.querySelector('.fx-panel')).toBeNull();
    expect(host.querySelector('.fv-tools .chat-side-toggle')?.textContent).toBe('Tools');
    act(() => (host.querySelector('.fv-more') as HTMLButtonElement).click());
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent === 'Show tools') as HTMLButtonElement;
    act(() => item.click());
    expect(toggle).toHaveBeenCalled();
  });
});
