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
import { CUE_MS, spaceFileEvents, type SpaceFileFrame } from '../../chat/spaceFileLive';

const MINUTES = 5 * 60_000;

const mocks = vi.hoisted(() => ({
  view: vi.fn<(space: string, path: string) => Promise<SpaceViewUrl>>(),
  tree: vi.fn<(space: string, prefix: string, cursor?: string | null, recursive?: boolean) => Promise<SpaceTree>>(),
  fileHead: vi.fn<(space: string, path: string, etag: string | null) => Promise<SpaceFileHead | null>>(),
}));
vi.mock('./simpleData', () => {
  const data = () => ({
    items: { pick: () => 't1', state: { items: [] } }, rows: [], live: new Map(), setupOf: new Map(), links: [], activeTab: 't1', itemsShown: true,
    spaces: { loaded: true, spaces: [], index: new Map() },
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

