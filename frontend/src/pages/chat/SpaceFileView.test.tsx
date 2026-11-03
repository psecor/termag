// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
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
  sharedView: vi.fn<(space: string, path: string) => Promise<SpaceViewUrl>>(),
  tree: vi.fn(async (_space: string, _prefix: string, _cursor?: string | null, _recursive?: boolean): Promise<SpaceTree> => ({ prefix: '', dirs: [], files: [], nextCursor: null })),
  pick: vi.fn((_ref: unknown, _current: string | null) => 'p7'),
  tabs: [] as Array<{ id: string; kind: string }>,
  get: vi.fn(),
  spacesLoaded: true,
  spaceNames: ['beside', 'root', 'pick', 'search'],
}));
vi.mock('./simpleData', () => {
  const data = () => ({
    items: { pick: mocks.pick, state: { items: mocks.tabs } }, rows: [], live: new Map(), setupOf: new Map(), links: [], activeTab: 't1', itemsShown: true,
    spaces: { enabled: true, loaded: mocks.spacesLoaded, spaces: mocks.spacesLoaded ? mocks.spaceNames.map(name => ({ name })) : [], index: new Map() },
  });
  return { WithSimpleData: ({ children }: { children: React.ReactNode }) => children, useSimpleData: data, useSimpleDataIfAny: data };
});
vi.mock('../../services/api', () => ({ spacesApi: { view: mocks.view, sharedView: mocks.sharedView, tree: mocks.tree, get: mocks.get } }));
vi.mock('../../services/spaceTransfer', () => ({ downloadFile: vi.fn(), errorMessage: (_e: unknown, f: string) => f }));

const signed = (view: SpaceViewUrl['view'], size = 10): SpaceViewUrl => ({
  url: 'https://bucket.s3.test/get/x?sig=1', expiresAt: '', size, contentType: null, view,
});

let root: Root;
let host: HTMLDivElement;
let location = '';
let navigate: (to: string) => void = () => {};
function Probe() {
  const l = useLocation();
  navigate = useNavigate();
  location = l.pathname + l.search;
  return null;
}

beforeEach(() => {
  mocks.get.mockReset().mockRejectedValue({ response: { status: 404, data: { error: 'Not found' } } });
  mocks.spacesLoaded = true;
  mocks.spaceNames = ['beside', 'root', 'pick', 'search'];
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
  mocks.sharedView.mockReset();
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

  it('opens a path that is a folder, not a file, in the space\'s explorer, in the tab that showed it', async () => {
    mocks.view.mockRejectedValue({ response: { status: 404, data: { code: 'file_not_found' } } });
    // Loaded with no ?tab= (a pasted link): the route opened tab t1 on it, which now shows the folder, no second tab.
    await open('docs/deep');
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(mocks.tree).toHaveBeenCalledWith('notes', 'docs/deep/');
    expect(location).toBe('/chat/files/notes?tab=t1&dir=docs%2Fdeep%2F');
  });

  it('keeps the tab the route names when it names one', async () => {
    mocks.view.mockRejectedValue({ response: { status: 404, data: { code: 'file_not_found' } } });
    await open('docs/deep?tab=k9');
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(location).toBe('/chat/files/notes?tab=k9&dir=docs%2Fdeep%2F');
  });

  it('keeps a missing file a missing file when no folder has its name', async () => {
    mocks.view.mockRejectedValue({ response: { status: 404, data: { code: 'file_not_found' } } });
    mocks.tree.mockImplementation(async (_s, prefix) => ({ prefix, dirs: [], files: [], nextCursor: null }));
    await open('docs/gone.md');
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(location).toBe('/chat/f/notes/docs/gone.md');
    expect(host.textContent).toContain('Close its tab from the ⋮ menu.');
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

  it('shows code with line numbers and highlighting, not a frame', async () => {
    mocks.view.mockResolvedValue(signed({ contentType: 'text/plain; charset=utf-8', render: 'frame' }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('const a = 1; /* x\ny */\n')));
    await open('src/main.ts');
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(host.querySelector('iframe')).toBeNull();
    const lines = [...host.querySelectorAll('.cv-line')];
    expect(lines.map(l => l.querySelector('.cv-num')!.textContent)).toEqual(['1', '2']);
    expect(lines[0].querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(lines[1].querySelector('.hljs-comment')?.textContent).toBe('y */');
    expect(host.querySelector('.cv')!.getAttribute('data-wrap')).toBe('off');
  });

  it('keeps the wrap choice for the next code file', async () => {
    localStorage.clear();
    mocks.view.mockResolvedValue(signed({ contentType: 'text/plain; charset=utf-8', render: 'frame' }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x')));
    await open('a.py');
    const button = host.querySelector<HTMLButtonElement>('.cv-wrap')!;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    act(() => button.click());
    expect(host.querySelector('.cv')!.getAttribute('data-wrap')).toBe('on');
    act(() => root.unmount());
    root = createRoot(host);
    await open('b.go');
    expect(host.querySelector('.cv')!.getAttribute('data-wrap')).toBe('on');
    localStorage.clear();
  });

  it('reads the first MiB of a big text file and says so', async () => {
    mocks.view.mockResolvedValue(signed({ contentType: 'text/plain; charset=utf-8', render: 'frame' }, 3 * 1024 * 1024));
    const fetched = vi.fn(async () => new Response('line\n', { status: 206 }));
    vi.stubGlobal('fetch', fetched);
    await open('logs/run.log');
    expect(fetched).toHaveBeenCalledWith('https://bucket.s3.test/get/x?sig=1', { headers: { Range: 'bytes=0-1048575' } });
    expect(host.querySelector('.cv-meta')!.textContent).toBe('1 line · showing the first 1.0 MiB of 3.0 MiB; download for the rest');
  });

  it('offers a download for a type the browser cannot show', async () => {
    mocks.view.mockResolvedValue(signed(null));
    await open('deck.pptx');
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.textContent).toContain("Your browser can't show this kind of file.");
  });

  it('titles the header with one breadcrumb ending in the file, and names its icon buttons', async () => {
    mocks.view.mockResolvedValue(signed(null));
    await open('docs/deep/plan.md', 'notes', { sidePanel: { open: false, toggle: () => {}, revealDir: () => {} } });
    expect(host.querySelector('.chat-title-name')).toBeNull();
    const crumbs = [...host.querySelectorAll('.fv-crumbs > ol:not(.fv-crumbs-measure) > li')].map(li => li.textContent);
    expect(crumbs).toEqual(['notes', '/docs', '/deep', '/plan.md']);
    expect(host.querySelector('[aria-current=page]')?.textContent).toBe('plan.md');
    for (const [cls, label] of [['fv-reload', 'Reload'], ['fv-download', 'Download']]) {
      const b = host.querySelector<HTMLButtonElement>(`button.${cls}`)!;
      expect(b.getAttribute('aria-label')).toBe(label);
      expect(b.dataset.tip).toBeTruthy();
      expect(b.textContent).toBe('');
    }
  });

  it('folds the outer folders into "…" when the path does not fit, and its menu opens them in Files', async () => {
    // Every measured crumb is 10px a character; the breadcrumb has 150px.
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { width: (this.textContent ?? '').length * 10 } as DOMRect;
    });
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('fv-crumbs') ? 150 : 0;
    });
    try {
      const revealDir = vi.fn();
      mocks.view.mockResolvedValue(signed(null));
      await open('docs/deep/plan.md', 'notes', { sidePanel: { open: false, toggle: () => {}, revealDir } });
      // notes 50 + /docs 50 + /deep 50 + /plan.md 80 = 230; with /… (20) and docs, deep folded: 150.
      const crumbs = [...host.querySelectorAll('.fv-crumbs > ol:not(.fv-crumbs-measure) > li')].map(li => li.textContent);
      expect(crumbs).toEqual(['notes', '/…', '/plan.md']);
      const fold = host.querySelector<HTMLButtonElement>('button.fv-crumb-more')!;
      expect(fold.getAttribute('aria-label')).toBe('More of the path: docs / deep');
      act(() => { fold.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 60, clientY: 20 })); });
      const items = [...document.querySelectorAll<HTMLButtonElement>('.chat-ctx-menu [role=menuitem]')];
      expect(items.map(b => b.textContent)).toEqual(['docs', 'deep']);
      act(() => { items[1].click(); });
      expect(revealDir).toHaveBeenCalledWith('docs/deep/');
    } finally {
      rect.mockRestore();
      width.mockRestore();
    }
  });

  it('takes the ⋮ layout when its own width leaves less than … / file beside the buttons', async () => {
    // Crumbs are 10px a character, the buttons 247px; `/… /plan.md` is 100px, under the 160px floor.
    let headerWidth = 360;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { width: this.classList.contains('fv-wide-group') ? 247 : (this.textContent ?? '').length * 10 } as DOMRect;
    });
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('fv-header') ? headerWidth : this.classList.contains('fv-crumbs') ? 100 : 0;
    });
    try {
      mocks.view.mockResolvedValue(signed(null));
      await open('docs/deep/plan.md', 'notes', { sidePanel: { open: true, toggle: () => {}, revealDir: () => {} } });
      expect(host.querySelector('.fv-header')!.hasAttribute('data-compact')).toBe(true); // 360 - 247 = 113 < 160
      act(() => root.unmount());
      root = createRoot(host);
      headerWidth = 407;
      await open('docs/deep/plan.md', 'notes', { sidePanel: { open: true, toggle: () => {}, revealDir: () => {} } });
      expect(host.querySelector('.fv-header')!.hasAttribute('data-compact')).toBe(false); // exactly 160 left
    } finally {
      rect.mockRestore();
      width.mockRestore();
    }
  });

  it('puts its actions under ⋮ on a phone', async () => {
    mocks.view.mockResolvedValue(signed(null));
    await open('README.md', 'phone', { mode: 'drawer' });
    expect(host.querySelector('.fx-panel')).toBeNull();
    act(() => { host.querySelector<HTMLButtonElement>('.fv-more')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 300, clientY: 40 })); });
    expect([...document.querySelectorAll('.chat-ctx-menu [role=menuitem]')].map(b => b.textContent)).toEqual(['Reload', 'Download', 'Copy link']);
  });
});

describe('SpaceFileView through a share', () => {
  const panel = { sidePanel: { open: false, toggle: () => {}, revealDir: () => {} } };
  const notMember = () => Object.assign(new Error('not found'), { response: { status: 404, data: {} } });
  const share = { shared: true, canShare: false, sharedBy: { displayName: 'Ann' } } as unknown as SpaceViewUrl['share'];

  it('shows no member controls while it loads, nor after', async () => {
    let resolve: (v: SpaceViewUrl) => void = () => {};
    mocks.view.mockRejectedValue(notMember());
    mocks.sharedView.mockReturnValue(new Promise(r => { resolve = r; }));
    await open('deck.pptx', 'notes', panel);
    expect(host.querySelector('.fv-download')).toBeNull();
    expect(host.querySelector('.fv-tools')).toBeNull();
    await act(async () => { resolve({ ...signed(null), share }); });
    expect(host.textContent).toContain('Shared by Ann');
    expect(host.querySelector('.fv-download')).toBeNull();
    expect(host.querySelector('.fv-tools')).toBeNull();
    expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Download')).toBe(false);
  });

  it('offers no in-page Download for a PDF it cannot frame', async () => {
    touchScreen();
    mocks.view.mockRejectedValue(notMember());
    mocks.sharedView.mockResolvedValue({ ...signed({ contentType: 'application/pdf', render: 'frame' }), share });
    await open('docs/r.pdf');
    expect(host.querySelector('a.fv-open-btn')?.textContent).toBe('Open PDF');
    expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Download')).toBe(false);
  });

  it('says a file is not shared with you, not that it is gone, when the share is missing', async () => {
    mocks.view.mockRejectedValue(notMember());
    mocks.sharedView.mockRejectedValue(notMember());
    await open('docs/deep/plan.md', 'notes', panel);
    expect(host.textContent).toContain("This file isn't shared with you.");
    expect(host.textContent).not.toContain('gone from');
    expect(host.querySelector('.fv-download')).toBeNull();
    expect(host.querySelector('.fv-tools')).toBeNull();
  });

  it('drops the last file\'s Share button while the next file loads', async () => {
    mocks.view.mockResolvedValueOnce({ ...signed(null), share: { shared: false, canShare: true } as SpaceViewUrl['share'] });
    await open('README.md', 'notes', panel);
    expect(host.querySelector('.fv-share-main')).not.toBeNull();
    mocks.view.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => { navigate('/chat/f/notes/docs/deep/plan.md'); });
    expect(host.querySelector('[aria-current=page]')?.textContent).toBe('plan.md');
    expect(host.querySelector('.fv-share-main')).toBeNull();
    expect(host.querySelector('.fv-tools')).not.toBeNull();
  });

  it('drops an open Share confirmation when another file opens, so it cannot share that one', async () => {
    mocks.view.mockResolvedValueOnce({ ...signed(null), share: { shared: false, canShare: true } as SpaceViewUrl['share'] });
    await open('README.md', 'notes', panel);
    await act(async () => { host.querySelector<HTMLButtonElement>('.fv-share-main')!.click(); });
    expect(document.querySelector('.fv-share-dialog')).not.toBeNull();
    mocks.view.mockResolvedValueOnce({ ...signed(null), share: { shared: false, canShare: true } as SpaceViewUrl['share'] });
    await act(async () => { navigate('/chat/f/notes/docs/deep/plan.md'); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(host.querySelector('[aria-current=page]')?.textContent).toBe('plan.md');
    expect(document.querySelector('.fv-share-dialog')).toBeNull();
    // Nor does it come back with the first file.
    mocks.view.mockResolvedValueOnce({ ...signed(null), share: { shared: false, canShare: true } as SpaceViewUrl['share'] });
    await act(async () => { navigate('/chat/f/notes/README.md'); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(host.querySelector('[aria-current=page]')?.textContent).toBe('README.md');
    expect(document.querySelector('.fv-share-dialog')).toBeNull();
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

  it('lists nothing in a space the server says the user can\'t open, and says so', async () => {
    mocks.tree.mockClear();
    await explorer('README.md', 'secret');
    expect(mocks.get).toHaveBeenCalledWith('secret');
    expect(host.querySelector('.fx-panel .fx-panel-body')!.textContent).toBe('You don\'t have access to secret.');
    expect(mocks.tree.mock.calls.filter(c => c[0] === 'secret')).toEqual([]);
  });

  it('doesn\'t search a space the user can\'t open', async () => {
    mocks.tree.mockClear();
    await explorer('README.md', 'secret');
    const input = host.querySelector<HTMLInputElement>('.fx-search input')!;
    expect(input.disabled).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'plan');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(mocks.tree.mock.calls.filter(c => c[0] === 'secret')).toEqual([]);
    expect(host.querySelector('.fx-panel .fx-panel-body')!.textContent).toBe('You don\'t have access to secret.');
  });

  it('asks for no tree while the spaces are still loading, so a link opened before access caches no error', async () => {
    const notFound = { response: { status: 404, data: { error: 'Not found' } } };
    mocks.tree.mockImplementation(async (s, prefix, _c, recursive) => { if (s === 'later') throw notFound; return listing(prefix, !!recursive); });
    mocks.spacesLoaded = false;
    await explorer('README.md', 'later');
    expect(mocks.tree.mock.calls.filter(c => c[0] === 'later')).toEqual([]);
    expect(host.querySelector('.fx-search input')!.hasAttribute('disabled')).toBe(true);
    // The owner adds them, and the list now has the space: its tree loads, with no earlier error.
    mocks.tree.mockImplementation(async (_s, prefix, _c, recursive) => listing(prefix, !!recursive));
    mocks.spacesLoaded = true;
    mocks.spaceNames = [...mocks.spaceNames, 'later'];
    await explorer('README.md', 'later');
    expect(mocks.tree.mock.calls.some(c => c[0] === 'later')).toBe(true);
    expect(host.querySelector('.fx-panel .fx-error')).toBeNull();
    expect(host.querySelector('.fx-panel .fx-name')).not.toBeNull();
  });

  it('drops a listing error once access comes back, so Files lists again without a reload', async () => {
    const notFound = { response: { status: 404, data: { error: 'Not found' } } };
    // Listed, but the tree fails (removed meanwhile): the error is shown and cached.
    mocks.spaceNames = [...mocks.spaceNames, 'again'];
    mocks.tree.mockImplementation(async (s, prefix, _c, recursive) => { if (s === 'again') throw notFound; return listing(prefix, !!recursive); });
    await explorer('README.md', 'again');
    expect(host.querySelector('.fx-panel .fx-error')!.textContent).toBe('Not found');
    // The list reloads without it (no access), then they're added back.
    mocks.spaceNames = mocks.spaceNames.filter(n => n !== 'again');
    await explorer('README.md', 'again');
    expect(host.querySelector('.fx-panel .fx-panel-body')!.textContent).toBe('You don\'t have access to again.');
    mocks.tree.mockImplementation(async (_s, prefix, _c, recursive) => listing(prefix, !!recursive));
    mocks.spaceNames = [...mocks.spaceNames, 'again'];
    await explorer('README.md', 'again');
    expect(host.querySelector('.fx-panel .fx-error')).toBeNull();
    expect(host.querySelector('.fx-panel .fx-name')).not.toBeNull();
  });

  it('drops a listing error when access comes back, even after a visit to another space in between', async () => {
    const notFound = { response: { status: 404, data: { error: 'Not found' } } };
    mocks.spaceNames = [...mocks.spaceNames, 'away'];
    mocks.tree.mockImplementation(async (s, prefix, _c, recursive) => { if (s === 'away') throw notFound; return listing(prefix, !!recursive); });
    await explorer('README.md', 'away');
    expect(host.querySelector('.fx-panel .fx-error')!.textContent).toBe('Not found');
    // Removed from it (no access), then the same panel moves to another, reachable space.
    mocks.spaceNames = mocks.spaceNames.filter(n => n !== 'away');
    await explorer('README.md', 'away');
    expect(host.querySelector('.fx-panel .fx-panel-body')!.textContent).toBe('You don\'t have access to away.');
    await explorer('README.md', 'beside');
    expect(host.querySelector('.fx-panel .fx-error')).toBeNull();
    // Added back: going back to it lists it again, without a Refresh.
    mocks.tree.mockImplementation(async (_s, prefix, _c, recursive) => listing(prefix, !!recursive));
    mocks.spaceNames = [...mocks.spaceNames, 'away'];
    await explorer('README.md', 'away');
    expect(host.querySelector('.fx-panel .fx-error')).toBeNull();
    expect(host.querySelector('.fx-panel .fx-name')).not.toBeNull();
  });

  it('lists a space the sidebar\'s list lacks once the server says it is the user\'s', async () => {
    mocks.get.mockResolvedValue({ space: { name: 'fresh', role: 'viewer' } });
    await explorer('README.md', 'fresh');
    expect(host.querySelector('.fx-panel .fx-panel-body')!.textContent).not.toContain('access');
    expect(mocks.tree.mock.calls.some(c => c[0] === 'fresh')).toBe(true);
  });

  it('lists the space\'s root for a file at the top level', async () => {
    await explorer('README.md', 'root');
    expect([...host.querySelectorAll('.fx-panel .fx-name')].map(n => n.textContent)).toEqual(['docs', 'src', 'README.md']);
    expect(host.querySelector('.fx-panel .fx-row.active')!.textContent).toBe('README.md');
  });

  it('shows a file picked in it in the tab the store picks', async () => {
    await explorer('README.md', 'pick');
    const main = [...host.querySelectorAll<HTMLAnchorElement>('.fx-panel a.fx-row')].find(a => a.textContent === 'README.md')!;
    expect(main.getAttribute('href')).toBe('/chat/f/pick/README.md');
    act(() => { [...host.querySelectorAll<HTMLButtonElement>('.fx-dir')][1].click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const ts = [...host.querySelectorAll<HTMLAnchorElement>('.fx-panel a.fx-row')].find(a => a.textContent === 'main.ts')!;
    await act(async () => { ts.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
    expect(mocks.pick).toHaveBeenCalledWith({ kind: 'file', space: 'pick', path: 'src/main.ts' }, 't1', undefined, 'pick');
    expect(location).toBe('/chat/f/pick/src/main.ts?tab=p7');
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
