// @vitest-environment jsdom
// Live space files (SpaceFileLive.tsx): the file view and the explorer follow
// `space-file` frames and the one-off checks after a missed frame. Nothing
// polls.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceFileHead, SpaceTree, SpaceViewUrl } from '../../services/api';
import { SpaceFileView } from './SpaceFileView';
import { ExplorerPanel } from './FileExplorer';
import { LiveCue, useSpaceFileLive } from './SpaceFileLive';
import { CUE_MS, recheckFiles, spaceFileEvents, type SpaceFileFrame } from '../../chat/spaceFileLive';

const MINUTES = 5 * 60_000;

const mocks = vi.hoisted(() => ({
  view: vi.fn<(space: string, path: string) => Promise<SpaceViewUrl>>(),
  tree: vi.fn<(space: string, prefix: string, cursor?: string | null, recursive?: boolean) => Promise<SpaceTree>>(),
  fileHead: vi.fn<(space: string, path: string, etag: string | null) => Promise<SpaceFileHead | null>>(),
  /** project-files-enabled: the Files tool's new moments to look again. */
  fresh: false,
  /** The spaces the sidebar lists: one listed is reachable at once, without asking the server. */
  spaceList: [] as Array<{ id: string; name: string; role: string }>,
}));
vi.mock('../../flags', async importOriginal => {
  const actual = await importOriginal<typeof import('../../flags')>();
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (key === 'project-files-enabled' ? mocks.fresh as T : fallback) };
});
vi.mock('./simpleData', () => {
  const data = () => ({
    items: { pick: () => 't1', state: { items: [] } }, rows: [], live: new Map(), setupOf: new Map(), links: [], activeTab: 't1', itemsShown: true,
    spaces: { loaded: true, spaces: mocks.spaceList, index: new Map() },
  });
  return { WithSimpleData: ({ children }: { children: React.ReactNode }) => children, useSimpleData: data, useSimpleDataIfAny: data };
});
// get: the server says each space is the user's, so the explorer lists it (chat/useSpaceReach.ts asks
// about a space the sidebar's list lacks, and this mock's list is empty).
vi.mock('../../services/api', () => ({ spacesApi: { view: mocks.view, tree: mocks.tree, fileHead: mocks.fileHead, get: async (name: string) => ({ space: { name } }) } }));
vi.mock('../../services/spaceTransfer', () => ({ downloadFile: vi.fn(), errorMessage: (_e: unknown, f: string) => f }));

const MD = { contentType: 'text/plain; charset=utf-8', render: 'markdown' as const };
const PDF = { contentType: 'application/pdf', render: 'frame' as const };
const signed = (view: SpaceViewUrl['view'], v = 1): SpaceViewUrl => ({
  url: `https://bucket.s3.test/get/x?v=${v}`, expiresAt: '', size: 10, contentType: null, view,
});
const head = (etag: string): SpaceFileHead => ({ path: 'pr-outbox.md', size: 10, modifiedAt: null, etag });
const notFound = () => Object.assign(new Error('404'), { response: { status: 404, data: { code: 'file_not_found' } } });

let root: Root;
let host: HTMLDivElement;
let version: number;
let seenLoading: boolean;
let observer: MutationObserver;

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });
const send = (frame: Omit<SpaceFileFrame, 'type'>) => act(async () => { spaceFileEvents.publish({ type: 'space-file', ...frame }); });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  version = 1;
  mocks.view.mockImplementation(async () => signed(MD, version));
  mocks.fileHead.mockImplementation(async (_s, _p, etag) => (etag === `"v${version}"` ? null : head(`"v${version}"`)));
  mocks.tree.mockImplementation(async (_s, prefix) => ({ prefix, nextCursor: null, dirs: [], files: [{ name: `f${version}.md`, path: `f${version}.md`, size: 1, modifiedAt: null }] }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(`# Outbox v${new URL(url).searchParams.get('v')}\n\nrow`)));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  seenLoading = false;
  observer = new MutationObserver(() => { if (host.textContent?.includes('Loading…')) seenLoading = true; });
});

afterEach(() => {
  observer.disconnect();
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.fresh = false;
});

async function openFile(path = 'pr-outbox.md', space = 'improve-termag') {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/chat/f/${space}/${path}`]}>
        <Routes><Route path="/chat/f/:space/*" element={<SpaceFileView />} /></Routes>
      </MemoryRouter>,
    );
  });
  await flush();
  observer.observe(host, { childList: true, subtree: true, characterData: true });
}

const cue = () => host.querySelector<HTMLElement>('.fv-live-cue');
const md = () => host.querySelector('.fv-md')?.textContent ?? '';

describe('the file view', () => {
  it('reloads in place on a put of its file: no Loading…, same scroller, scroll kept, the cue', async () => {
    await openFile();
    expect(md()).toContain('Outbox v1');
    const scroller = host.querySelector<HTMLElement>('.chat-transcript')!;
    const section = host.querySelector('section.chat-conv');
    scroller.scrollTop = 420;
    version = 2;
    await send({ space: 'improve-termag', kind: 'put', path: 'pr-outbox.md', etag: '"v2"' });
    await flush();
    expect(md()).toContain('Outbox v2');
    expect(seenLoading).toBe(false);
    expect(host.querySelector('.chat-transcript')).toBe(scroller);
    expect(host.querySelector('section.chat-conv')).toBe(section);
    expect(scroller.scrollTop).toBe(420);
    expect(cue()!.hidden).toBe(false);
    expect(cue()!.textContent).toBe('Updated');
    expect(cue()!.getAttribute('role')).toBe('status');
  });

  it('ignores a frame for another file, another space, or the version it already shows', async () => {
    await openFile();
    await flush();
    await send({ space: 'improve-termag', kind: 'put', path: 'plan-outbox.md', etag: '"x"' });
    await send({ space: 'other', kind: 'put', path: 'pr-outbox.md', etag: '"x"' });
    await send({ space: 'improve-termag', kind: 'put', path: 'pr-outbox.md', etag: '"v1"' });
    await flush();
    expect(mocks.view).toHaveBeenCalledTimes(1);
    expect(cue()!.hidden).toBe(true);
  });

  it('says a removed file is gone, and a moved one where it went', async () => {
    await openFile();
    await send({ space: 'improve-termag', kind: 'rm', path: 'pr-outbox.md' });
    expect(host.textContent).toContain('This file is gone from improve-termag');
    expect(cue()!.textContent).toBe('Deleted');
    act(() => root.unmount());
    root = createRoot(host);
    await openFile('d/pr-outbox.md');
    await send({ space: 'improve-termag', kind: 'mv', path: 'd/', to: 'archive/d/' });
    expect(host.textContent).toContain('This file is gone from improve-termag');
    const link = cue()!.querySelector('a')!;
    expect(cue()!.textContent).toBe('Moved to archive/d/pr-outbox.md');
    expect(link.getAttribute('href')).toBe('/chat/f/improve-termag/archive/d/pr-outbox.md');
  });

  it('keeps a PDF where the reader is: the cue offers Reload instead', async () => {
    mocks.view.mockImplementation(async () => signed(PDF, version));
    await openFile('r.pdf');
    const frame = host.querySelector('iframe.fv-frame')!;
    version = 2;
    await send({ space: 'improve-termag', kind: 'put', path: 'r.pdf', etag: '"v2"' });
    await flush();
    expect(host.querySelector('iframe.fv-frame')).toBe(frame);
    expect(mocks.view).toHaveBeenCalledTimes(1);
    expect(cue()!.textContent).toContain('Changed');
    await act(async () => { cue()!.querySelector('button')!.click(); });
    await flush();
    expect(host.querySelector('iframe.fv-frame')!.getAttribute('src')).toBe('https://bucket.s3.test/get/x?v=2');
    expect(seenLoading).toBe(false);
  });

  it('never asks on a timer: one check when the file opens, then none, so an unconfirmed upload stays as shown', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/chat/f/improve-termag/pr-outbox.md']}>
          <Routes><Route path="/chat/f/:space/*" element={<SpaceFileView />} /></Routes>
        </MemoryRouter>,
      );
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(mocks.fileHead).toHaveBeenCalledTimes(1);
    expect(mocks.fileHead).toHaveBeenLastCalledWith('improve-termag', 'pr-outbox.md', null);
    version = 2; // a presigned PUT nobody confirmed: no frame
    await act(async () => { await vi.advanceTimersByTimeAsync(MINUTES); });
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(mocks.fileHead).toHaveBeenCalledTimes(1);
    expect(mocks.view).toHaveBeenCalledTimes(1);
    expect(md()).toContain('Outbox v1');
  });

  it('checks once when the status socket reopens, with If-None-Match, and reloads a version that moved meanwhile', async () => {
    await openFile();
    mocks.fileHead.mockClear();
    await act(async () => { spaceFileEvents.notifyReconnect(); });
    await flush();
    expect(mocks.fileHead).toHaveBeenCalledTimes(1);
    expect(mocks.fileHead).toHaveBeenLastCalledWith('improve-termag', 'pr-outbox.md', '"v1"');
    expect(mocks.view).toHaveBeenCalledTimes(1); // a 304: nothing changed
    version = 2; // written while the socket was down
    await send({ resync: true }); // the server's LISTEN connection came back
    await flush();
    expect(mocks.fileHead).toHaveBeenCalledTimes(2);
    expect(md()).toContain('Outbox v2');
    expect(seenLoading).toBe(false);
    expect(cue()!.textContent).toBe('Updated');
  });

  it('checks once for a frame of its space that came without paths', async () => {
    await openFile();
    mocks.fileHead.mockClear();
    version = 2;
    await send({ space: 'improve-termag', kind: 'mv' });
    await send({ space: 'other', kind: 'mv' });
    await flush();
    expect(mocks.fileHead).toHaveBeenCalledTimes(1);
    expect(md()).toContain('Outbox v2');
  });

  it('checks once when the status socket reopens, and finds a file removed meanwhile', async () => {
    await openFile();
    mocks.fileHead.mockRejectedValue(notFound());
    await act(async () => { spaceFileEvents.notifyReconnect(); });
    await flush();
    expect(host.textContent).toContain('This file is gone from improve-termag');
  });
});

describe('someone who is not a member (a file shared with everyone on termag, #718)', () => {
  type Shown = { state: string };
  let states: Shown[];
  let reloads: number;
  function Reader({ reader }: { reader?: 'member' | 'share' | 'unknown' }) {
    const [loaded, setLoaded] = React.useState<Shown>({ state: 'ok' });
    const live = useSpaceFileLive<Shown>({
      space: 'improve-termag', path: 'pr-outbox.md', loaded, reader,
      setLoaded: v => { states.push(v); setLoaded(v); }, reload: () => { reloads++; }, gone: { state: 'gone' },
    });
    return <MemoryRouter><LiveCue space="improve-termag" cue={live.cue} onReload={live.applyPending} /><p className="state">{loaded.state}</p></MemoryRouter>;
  }
  const mount = (reader?: 'member' | 'share' | 'unknown') => act(async () => { root.render(<Reader reader={reader} />); });
  const missed = async () => {
    await act(async () => { spaceFileEvents.notifyReconnect(); });
    await send({ resync: true });
    await send({ space: 'improve-termag', kind: 'mv' });
    await flush();
  };

  beforeEach(() => { states = []; reloads = 0; });

  it('never asks files/head for a reader through a share: not on open, a reconnect, a resync or a frame', async () => {
    await mount('share');
    await flush();
    await missed();
    await send({ space: 'improve-termag', kind: 'put', path: 'pr-outbox.md', etag: '"v9"' });
    await send({ space: 'improve-termag', kind: 'rm', path: 'pr-outbox.md' });
    await flush();
    expect(mocks.fileHead).not.toHaveBeenCalled();
    expect(reloads).toBe(0);
    expect(states).toEqual([]);
    expect(cue()!.hidden).toBe(true);
  });

  it('waits while it isn\'t known yet, and starts once the reader turns out to be a member', async () => {
    await mount('unknown');
    await flush();
    await missed();
    expect(mocks.fileHead).not.toHaveBeenCalled();
    await mount('member');
    await flush();
    expect(mocks.fileHead).toHaveBeenCalledTimes(1);
  });

  it('a check the server refuses for the space (not_found) shows nothing and stops asking', async () => {
    mocks.fileHead.mockRejectedValue(Object.assign(new Error('404'), { response: { status: 404, data: { code: 'not_found' } } }));
    await openFile();
    expect(mocks.fileHead).toHaveBeenCalledTimes(1);
    await missed();
    expect(mocks.fileHead).toHaveBeenCalledTimes(1);
    expect(md()).toContain('Outbox v1');
    expect(host.textContent).not.toContain('This file is gone');
    expect(cue()!.hidden).toBe(true);
    expect(mocks.view).toHaveBeenCalledTimes(1);
  });
});

describe('LiveCue', () => {
  it('shows Updated briefly', async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(<MemoryRouter><LiveCue space="s" cue={{ kind: 'updated', n: 1 }} onReload={() => {}} /></MemoryRouter>);
    });
    expect(cue()!.hidden).toBe(false);
    await act(async () => { vi.advanceTimersByTime(CUE_MS + 10); });
    expect(cue()!.hidden).toBe(true);
  });
});

describe('the explorer', () => {
  async function openExplorer(space = 'live-x') {
    await act(async () => {
      root.render(<MemoryRouter><ExplorerPanel space={space} /></MemoryRouter>);
    });
    await flush();
  }
  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 350)); });
  const file = (path: string) => ({ name: path, path, size: 1, modifiedAt: null });
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
  }

  it('refetches its open folders in place on a change in its space, not another', async () => {
    await openExplorer();
    expect(host.textContent).toContain('f1.md');
    const calls = mocks.tree.mock.calls.length;
    version = 2;
    await send({ space: 'elsewhere', kind: 'put', path: 'f2.md' });
    await act(async () => { await new Promise(r => setTimeout(r, 350)); });
    expect(mocks.tree.mock.calls.length).toBe(calls);
    await send({ space: 'live-x', kind: 'put', path: 'f2.md' });
    expect(host.textContent).toContain('f1.md'); // kept until the new listing lands
    await act(async () => { await new Promise(r => setTimeout(r, 350)); });
    await flush();
    expect(mocks.tree).toHaveBeenLastCalledWith('live-x', '');
    expect(host.textContent).toContain('f2.md');
    expect(host.textContent).not.toContain('Loading…');
  });

  it('keeps the pages More loaded through a live refresh', async () => {
    mocks.tree.mockImplementation(async (_s, prefix, cursor) => (cursor === 'c2'
      ? { prefix, nextCursor: null, dirs: [], files: [file(`p2-v${version}.md`)] }
      : { prefix, nextCursor: 'c2', dirs: [], files: [file(`p1-v${version}.md`)] }));
    await openExplorer('live-more');
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === 'More')!.click(); });
    await flush();
    expect(host.textContent).toContain('p2-v1.md');
    version = 2;
    await send({ space: 'live-more', kind: 'put', path: 'p2-v2.md' });
    await settle();
    await flush();
    expect(host.textContent).toContain('p1-v2.md');
    expect(host.textContent).toContain('p2-v2.md');
    expect([...host.querySelectorAll('button')].some(b => b.textContent === 'More')).toBe(false);
  });

  it('shows the newest refresh when an older one answers last or first', async () => {
    await openExplorer('live-race');
    const older = deferred<SpaceTree>();
    const newer = deferred<SpaceTree>();
    mocks.tree.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    await send({ space: 'live-race', kind: 'put', path: 'a.md' });
    await settle();
    await send({ space: 'live-race', kind: 'put', path: 'b.md' });
    await settle();
    // The older request answers first, then the newer one.
    await act(async () => { older.resolve({ prefix: '', nextCursor: null, dirs: [], files: [file('older.md')] }); });
    await flush();
    await act(async () => { newer.resolve({ prefix: '', nextCursor: null, dirs: [], files: [file('newer.md')] }); });
    await flush();
    expect(host.textContent).toContain('newer.md');
    expect(host.textContent).not.toContain('older.md');
    // And the other way round: the newer answers first, the older last.
    const older2 = deferred<SpaceTree>();
    const newer2 = deferred<SpaceTree>();
    mocks.tree.mockImplementationOnce(() => older2.promise).mockImplementationOnce(() => newer2.promise);
    await send({ space: 'live-race', kind: 'put', path: 'c.md' });
    await settle();
    await send({ space: 'live-race', kind: 'put', path: 'd.md' });
    await settle();
    await act(async () => { newer2.resolve({ prefix: '', nextCursor: null, dirs: [], files: [file('newest.md')] }); });
    await flush();
    await act(async () => { older2.resolve({ prefix: '', nextCursor: null, dirs: [], files: [file('stale.md')] }); });
    await flush();
    expect(host.textContent).toContain('newest.md');
    expect(host.textContent).not.toContain('stale.md');
  });

  it('lists the search index again when a change lands while it is loading', async () => {
    await openExplorer('live-search');
    const first = deferred<SpaceTree>();
    mocks.tree.mockImplementation(async (_s, prefix, _c, recursive) => (recursive
      ? { prefix, nextCursor: null, dirs: [], files: [file('notes-new.md')] }
      : { prefix, nextCursor: null, dirs: [], files: [] }));
    mocks.tree.mockImplementationOnce(() => first.promise);
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, 'notes'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(host.textContent).toContain('Searching files…');
    await send({ space: 'live-search', kind: 'put', path: 'notes-new.md' });
    await settle();
    // The index load that started before the change answers with what it saw then.
    await act(async () => { first.resolve({ prefix: '', nextCursor: null, dirs: [], files: [file('notes-old.md')] }); });
    await flush();
    expect(host.textContent).toContain('notes-new.md');
    expect(host.textContent).not.toContain('notes-old.md');
  });

  it('refetches a folder still loading when a change lands, and its first load (from before) can\'t replace that', async () => {
    const first = deferred<SpaceTree>();
    mocks.tree.mockImplementationOnce(() => first.promise);
    mocks.tree.mockImplementation(async prefix => ({ prefix: '', nextCursor: null, dirs: [], files: [file('after.md')] }));
    await act(async () => {
      root.render(<MemoryRouter><ExplorerPanel space="live-loading" /></MemoryRouter>);
    });
    expect(host.textContent).toContain('Loading…');
    await send({ space: 'live-loading', kind: 'put', path: 'after.md' });
    await settle();
    await flush();
    await act(async () => { first.resolve({ prefix: '', nextCursor: null, dirs: [], files: [file('before.md')] }); });
    await flush();
    expect(host.textContent).toContain('after.md');
    expect(host.textContent).not.toContain('before.md');
    expect(host.textContent).not.toContain('Loading…');
  });

  it('a More that answers after a live refresh can\'t put the old first page back', async () => {
    const page2 = deferred<SpaceTree>();
    mocks.tree.mockImplementation(async (_s, prefix, cursor) => (cursor === 'c2'
      ? page2.promise
      : { prefix, nextCursor: 'c2', dirs: [], files: [file(`first-v${version}.md`)] }));
    await openExplorer('live-more-race');
    expect(host.textContent).toContain('first-v1.md');
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === 'More')!.click(); });
    version = 2;
    await send({ space: 'live-more-race', kind: 'put', path: 'first-v2.md' });
    await settle();
    await flush();
    expect(host.textContent).toContain('first-v2.md');
    // The More started before the change answers now, built on the old first page.
    await act(async () => { page2.resolve({ prefix: '', nextCursor: null, dirs: [], files: [file('second-v1.md')] }); });
    await flush();
    expect(host.textContent).toContain('first-v2.md');
    expect(host.textContent).not.toContain('first-v1.md');
  });

  it('a refetch that fails for a folder still loading shows its error, not Loading… forever', async () => {
    const first = deferred<SpaceTree>();
    mocks.tree.mockImplementationOnce(() => first.promise);
    mocks.tree.mockImplementation(async () => { throw new Error('offline'); });
    await act(async () => {
      root.render(<MemoryRouter><ExplorerPanel space="live-loading-err" /></MemoryRouter>);
    });
    await send({ space: 'live-loading-err', kind: 'put', path: 'x.md' });
    await settle();
    await flush();
    await act(async () => { first.resolve({ prefix: '', nextCursor: null, dirs: [], files: [file('before.md')] }); });
    await flush();
    expect(host.textContent).not.toContain('Loading…');
    expect(host.textContent).toContain('Could not list this folder');
  });
});


// (From review: "agent created this file but i don't see it listed in 'My files'? … i had to manually refresh").
// Only a shown explorer hears frames, and its listings are kept for the page, so a write while My files wasn't on
// screen showed only after a reload. Under project-files-enabled the list and the open file look again when they're
// shown, when the window or tab comes back, and when the open session's turn ends. Still no timer.
describe('under project-files-enabled: the moments to look again', () => {
  beforeEach(() => { mocks.fresh = true; });
  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 350)); });
  async function openExplorer(space = 'my-files') {
    await act(async () => { root.render(<MemoryRouter><ExplorerPanel space={space} /></MemoryRouter>); });
    await flush();
  }

  it("shows an agent's file after its turn ends, with no frame and no reload, keeping the list in place", async () => {
    await openExplorer();
    expect(host.textContent).toContain('f1.md');
    const body = host.querySelector('.fx-body, .fx-panel, [class^="fx"]');
    version = 2; // the agent wrote f2.md; its frame was missed
    await act(async () => { recheckFiles(); });
    expect(host.textContent).toContain('f1.md'); // kept until the new listing lands
    await settle();
    await flush();
    expect(host.textContent).toContain('f2.md');
    expect(host.textContent).not.toContain('Loading…');
    if (body) expect(host.querySelector('.fx-body, .fx-panel, [class^="fx"]')).toBe(body);
  });

  it('lists afresh in place when shown again (the Files tool opened, or Project files and My files switched)', async () => {
    await openExplorer();
    expect(host.textContent).toContain('f1.md');
    act(() => root.unmount());
    root = createRoot(host);
    version = 2; // written while it wasn't shown: no explorer heard the frame
    await send({ space: 'my-files', kind: 'put', path: 'f2.md' });
    await openExplorer();
    await flush();
    expect(host.textContent).toContain('f2.md');
    expect(host.textContent).not.toContain('Loading…');
  });

  // Bugbot on #1874: a first visit's own placeholders read as kept listings, so it listed twice.
  it('lists a folder once on a first visit, and only refetches what an earlier visit kept', async () => {
    mocks.spaceList = [{ id: 'sp-first', name: 'first-visit', role: 'owner' }];
    mocks.tree.mockClear();
    try {
      await openExplorer('first-visit');
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      expect(mocks.tree.mock.calls.filter(c => c[0] === 'first-visit')).toHaveLength(1);
    } finally {
      mocks.spaceList = [];
    }
  });

  // Devin on #1874: a listing that failed was kept as it was when the Files tool opened again.
  it('lists again a folder that failed on an earlier visit, when shown again', async () => {
    mocks.spaceList = [{ id: 'sp-failed', name: 'failed-once', role: 'owner' }];
    try {
      mocks.tree.mockRejectedValueOnce(new Error('down'));
      await openExplorer('failed-once');
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      expect(host.textContent).not.toContain('f1.md');
      act(() => root.unmount());
      root = createRoot(host);
      await openExplorer('failed-once');
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      expect(host.textContent).toContain('f1.md');
    } finally {
      mocks.spaceList = [];
    }
  });

  it('keeps what it kept with the flag off, as before', async () => {
    mocks.fresh = false;
    await openExplorer('kept-off');
    act(() => root.unmount());
    root = createRoot(host);
    version = 2;
    await openExplorer('kept-off');
    await act(async () => { recheckFiles(); });
    await settle();
    expect(host.textContent).toContain('f1.md');
    expect(host.textContent).not.toContain('f2.md');
  });

  it('checks the open file when the window comes back, once for focus and visibility together, and reloads it in place', async () => {
    await openFile();
    mocks.fileHead.mockClear();
    version = 2;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(mocks.fileHead).toHaveBeenCalledTimes(1);
    expect(mocks.fileHead).toHaveBeenLastCalledWith('improve-termag', 'pr-outbox.md', '"v1"');
    expect(md()).toContain('Outbox v2');
    expect(seenLoading).toBe(false);
    expect(cue()!.textContent).toBe('Updated');
  });

  it("says a file deleted meanwhile is gone after a turn ends, and offers to close it in place", async () => {
    await openFile();
    mocks.fileHead.mockRejectedValue(notFound());
    await act(async () => { recheckFiles(); });
    await flush();
    expect(host.textContent).toContain("This file isn't in improve-termag anymore: it was moved or deleted.");
    expect(host.querySelector('.fv-gone-close')?.textContent).toBe('Close');
  });

  // Bugbot on #1874: a moved file is gone from here too, and its words mustn't say deleted beside "Moved to".
  it("doesn't call a moved file deleted: the words fit a move, beside its Moved to cue", async () => {
    await openFile('d/pr-outbox.md');
    await send({ space: 'improve-termag', kind: 'mv', path: 'd/', to: 'archive/d/' });
    expect(cue()!.textContent).toBe('Moved to archive/d/pr-outbox.md');
    expect(host.textContent).toContain('it was moved or deleted');
    expect(host.textContent).not.toContain('was deleted from');
  });

  // Bugbot on #1874: a recheck while a files/head was in flight was dropped, so the file could stay stale.
  it('asks again when a recheck comes while a check is in flight, and shows what the second one finds', async () => {
    await openFile();
    let answer: (v: SpaceFileHead | null) => void = () => {};
    mocks.fileHead.mockClear();
    mocks.fileHead.mockImplementationOnce(() => new Promise(r => { answer = r; }));
    await act(async () => { recheckFiles(); }); // the window came back: a check goes out
    version = 2; // the agent's turn wrote it after that check went out
    await act(async () => { recheckFiles(); });
    expect(mocks.fileHead).toHaveBeenCalledTimes(1);
    await act(async () => { answer(null); }); // the first saw the old version (a 304)
    await flush();
    expect(mocks.fileHead).toHaveBeenCalledTimes(2);
    expect(md()).toContain('Outbox v2');
  });

  // An editor on the viewer passes `dirty`: a change elsewhere never replaces its edits.
  it('never clobbers edits not saved: says the file changed, Reload asks first, Keep mine keeps them', async () => {
    let reloads = 0;
    function Editing() {
      const [loaded, setLoaded] = React.useState<{ state: string }>({ state: 'ok' });
      const live = useSpaceFileLive({ space: 'improve-termag', path: 'pr-outbox.md', loaded, setLoaded, reload: () => { reloads++; }, gone: { state: 'gone' }, dirty: () => true });
      return <MemoryRouter><LiveCue space="improve-termag" cue={live.cue} onReload={live.applyPending} name="pr-outbox.md" onKeepMine={live.keepMine} /></MemoryRouter>;
    }
    await act(async () => { root.render(<Editing />); });
    await flush();
    await send({ space: 'improve-termag', kind: 'put', path: 'pr-outbox.md', etag: '"v2"' });
    await flush();
    expect(reloads).toBe(0);
    expect(cue()!.hidden).toBe(false);
    expect(cue()!.textContent).toContain('pr-outbox.md changed since you opened it');
    const button = (name: string) => [...cue()!.querySelectorAll('button')].find(b => b.textContent === name)!;
    await act(async () => { button('Reload').click(); });
    expect(reloads).toBe(0); // asks first
    expect(cue()!.textContent).toContain('Drop your unsaved changes?');
    await act(async () => { button('Cancel').click(); });
    await act(async () => { button('Keep mine').click(); });
    expect(cue()!.hidden).toBe(true);
    expect(reloads).toBe(0);
    // Another change asks again; this time Reload, confirmed, drops the edits.
    await send({ space: 'improve-termag', kind: 'put', path: 'pr-outbox.md', etag: '"v3"' });
    await flush();
    await act(async () => { button('Reload').click(); });
    await act(async () => { button('Reload').click(); });
    expect(reloads).toBe(1);
  });

  // Devin on #1874: a delete replaced the view even with edits held.
  it('keeps edits not saved when the file is deleted elsewhere, and says so', async () => {
    let shown = 'ok';
    function Editing() {
      const [loaded, setLoaded] = React.useState<{ state: string }>({ state: 'ok' });
      shown = loaded.state;
      const live = useSpaceFileLive({ space: 'improve-termag', path: 'pr-outbox.md', loaded, setLoaded, reload: () => {}, gone: { state: 'gone' }, dirty: () => true });
      return <MemoryRouter><LiveCue space="improve-termag" cue={live.cue} onReload={live.applyPending} name="pr-outbox.md" onKeepMine={live.keepMine} /></MemoryRouter>;
    }
    await act(async () => { root.render(<Editing />); });
    await flush();
    await send({ space: 'improve-termag', kind: 'rm', path: 'pr-outbox.md' });
    await flush();
    expect(shown).toBe('ok');
    expect(cue()!.textContent).toContain('pr-outbox.md was deleted since you opened it; your changes are kept');
  });
});
