// @vitest-environment jsdom
// Project icons in the sidebar: the glyph draws the chosen image, or
// each repository's detected one (split on the diagonal), else the letters, and a broken image falls
// back to its letter; the picker lists Automatic, the letters, each candidate once and an upload, and
// Change icon… saves what was picked.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { glyphIconsOf, ProjectGlyph } from './ProjectGlyph';
import { ChangeIconDialog, effectivePick, iconTiles, keyOfPick, pickOf, pickSrc, ProjectIconPicker, useRepoIconCandidates } from './ProjectIconPicker';
import { RepoStep } from './RepoStep';

const mocks = vi.hoisted(() => ({
  icons: vi.fn(async (): Promise<unknown> => ({
    choice: 'auto', imageId: null, upload: null,
    repos: [{ repoKey: 'example-org/termag', detectedId: 'fav', checkedAt: null, candidates: [{ id: 'fav', path: 'frontend/public/favicon.png', mimeType: 'image/png', src: 'data:image/png;base64,ZmF2' }] }],
  })),
  setIcon: vi.fn(async () => ({ ok: true })),
  reload: vi.fn(async () => {}),
}));
vi.mock('../../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return { ...actual, userProjectsApi: { ...actual.userProjectsApi, icons: mocks.icons, setIcon: mocks.setIcon } };
});
const listedIcon = vi.hoisted(() => ({ current: { choice: 'auto', imageId: null, src: null } as { choice: string; imageId: string | null; src: string | null } }));
vi.mock('./simpleData', () => ({
  useSimpleDataIfAny: () => ({
    userProjects: {
      reload: mocks.reload,
      list: [{ id: 'up-1', name: 'termag', icon: listedIcon.current, repos: [{ repoKey: 'example-org/termag', name: 'termag', url: 'https://github.com/example-org/termag', defaultBranch: 'main' }] }],
    },
  }),
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = (node: React.ReactNode) => act(() => root.render(node));
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

const url = (id: string) => `data:image/png;base64,${id}`;
const repo = (repoKey: string, iconId: string | null = null) => ({
  repoKey, name: repoKey.split('/')[1], url: `https://github.com/${repoKey}`, defaultBranch: 'main', iconId, iconSrc: iconId ? url(iconId) : null,
});

describe('glyphIconsOf', () => {
  it("is each repository's detected icon while automatic, the image when chosen, nothing for the letters", () => {
    expect(glyphIconsOf({ icon: { choice: 'auto', imageId: null }, repos: [repo('o/a', 'i1'), repo('o/b')] })).toEqual({ repos: { 'o/a': url('i1') } });
    expect(glyphIconsOf({ icon: { choice: 'image', imageId: 'up', src: url('up') }, repos: [repo('o/a', 'i1')] })).toEqual({ image: url('up') });
    expect(glyphIconsOf({ icon: { choice: 'letter', imageId: null }, repos: [repo('o/a', 'i1')] })).toBeUndefined();
    // An older backend (no icon field) or nothing found: the letters, as before.
    expect(glyphIconsOf({ repos: [repo('o/a', 'i1')] })).toBeUndefined();
    expect(glyphIconsOf({ icon: { choice: 'auto', imageId: null }, repos: [repo('o/a')] })).toBeUndefined();
  });
});

describe('ProjectGlyph', () => {
  it('draws the letters with no icons, as it always has', () => {
    render(<ProjectGlyph repos={['example-org/termag']} />);
    expect(host.querySelector('.pg-letter')?.textContent).toBe('T');
    expect(host.querySelector('img')).toBeNull();
  });

  it('fills the square with a chosen image, even for a multi-repo project', () => {
    render(<ProjectGlyph repos={['o/a', 'o/b']} icons={{ image: url('up') }} />);
    expect(host.querySelectorAll('img')).toHaveLength(1);
    expect(host.querySelector('.pg-img')?.getAttribute('data-half')).toBeNull();
    expect(host.querySelector('.pg-split')).toBeNull();
  });

  it("splits a multi-repo project's detected icons on the diagonal, a letter where one has none", () => {
    render(<ProjectGlyph repos={['o/alpha', 'o/beta']} icons={{ repos: { 'o/alpha': url('a') } }} />);
    expect(host.querySelector('.pg-split .pg-img[data-half="a"] img')?.getAttribute('src')).toBe(url('a'));
    expect(host.querySelector('.pg-split .pg-letter[data-half="b"]')?.textContent).toBe('B');
  });

  it("finds a repository's icon by a checkout's own key, whatever its case or a trailing .git", () => {
    render(<ProjectGlyph repos={['Example-Org/Termag.git']} icons={{ repos: { 'example-org/termag': url('t') } }} />);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(url('t'));
  });

  it("falls back to the letter when an image won't load", async () => {
    render(<ProjectGlyph repos={['o/alpha']} icons={{ repos: { 'o/alpha': url('a') } }} />);
    await act(async () => { host.querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.pg-letter')?.textContent).toBe('A');
  });

  it('keeps Scratch dashed', () => {
    render(<ProjectGlyph repos={[]} />);
    expect(host.querySelector('.pg-scratch')).not.toBeNull();
  });
});

describe('the picker', () => {
  const repos = [
    { repoKey: 'o/a', detectedId: 'fa', checkedAt: null, candidates: [{ id: 'fa', path: 'public/favicon.png', mimeType: 'image/png', src: url('fa') }, { id: 'ap', path: 'apple-touch-icon.png', mimeType: 'image/png', src: url('ap') }] },
    // The same image in a second repository is one tile.
    { repoKey: 'o/b', detectedId: 'fa', checkedAt: null, candidates: [{ id: 'fa', path: 'favicon.png', mimeType: 'image/png', src: url('fa') }] },
  ];

  it('lists Automatic, the letters, each candidate once, then uploads', () => {
    const tiles = iconTiles(['o/a', 'o/b'], repos, [{ id: 'up', path: null, mimeType: 'image/png', src: url('up') }]);
    expect(tiles.map(t => [t.key, t.caption])).toEqual([
      ['auto', 'Automatic'], ['letter', 'Letters'], ['img:fa', 'favicon.png'], ['img:ap', 'apple-touch-icon.png'], ['img:up', 'Uploaded'],
    ]);
    expect(tiles[4].icons).toEqual({ image: url('up') });
    expect(tiles[0].icons).toEqual({ repos: { 'o/a': url('fa'), 'o/b': url('fa') } });
  });

  it('reads a choice and keys it', () => {
    expect(pickOf({ choice: 'image', imageId: 'x' })).toEqual({ choice: 'image', iconId: 'x' });
    expect(pickOf({ choice: 'image', imageId: null })).toEqual({ choice: 'auto' });
    expect(pickOf(undefined)).toEqual({ choice: 'auto' });
    expect(keyOfPick({ choice: 'image', iconId: 'x' })).toBe('img:x');
    expect(keyOfPick({ choice: 'letter' })).toBe('letter');
  });

  it('picks a tile', async () => {
    const onChange = vi.fn();
    render(<ProjectIconPicker repoKeys={['o/a', 'o/b']} read={{ kind: 'ready', repos, upload: null }} value={{ choice: 'auto' }} onChange={onChange}
      uploads={[]} onUploaded={vi.fn()} />);
    const radios = [...host.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(radios).toHaveLength(4);
    await act(async () => { radios[3].click(); });
    expect(onChange).toHaveBeenLastCalledWith({ choice: 'image', iconId: 'ap' });
  });

  it("turns a choice no tile shows (a repository since unpicked) into Automatic, so what's saved is what's shown", async () => {
    const onChange = vi.fn();
    render(<ProjectIconPicker repoKeys={['o/a']} read={{ kind: 'ready', repos: [], upload: null }} value={{ choice: 'image', iconId: 'gone' }} onChange={onChange}
      uploads={[]} onUploaded={vi.fn()} />);
    await flush();
    expect(onChange).toHaveBeenCalledWith({ choice: 'auto' });
  });

  it("keeps an upload the caller holds across a remount (New project's Back, then its repositories again)", async () => {
    const onChange = vi.fn();
    const up = { id: 'up', path: null, mimeType: 'image/png', src: url('up') };
    render(<ProjectIconPicker repoKeys={['o/a']} read={{ kind: 'ready', repos, upload: null }} value={{ choice: 'image', iconId: 'up' }} onChange={onChange}
      uploads={[up]} onUploaded={vi.fn()} />);
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    expect((host.querySelector('input[type="radio"]:checked') as HTMLInputElement | null)?.value).toBe('img:up');
  });

  it("gives a pick's image, from the candidates or this draft's uploads", () => {
    const up = { id: 'up', path: null, mimeType: 'image/png', src: url('up') };
    expect(pickSrc({ kind: 'ready', repos, upload: null }, [], { choice: 'image', iconId: 'ap' })).toBe(url('ap'));
    expect(pickSrc({ kind: 'loading' }, [up], { choice: 'image', iconId: 'up' })).toBe(url('up'));
    expect(pickSrc({ kind: 'ready', repos, upload: null }, [], { choice: 'letter' })).toBeNull();
  });

  it('lets the caller go when it unmounts mid-upload', async () => {
    const onBusyChange = vi.fn();
    render(<ProjectIconPicker repoKeys={['o/a']} read={{ kind: 'ready', repos, upload: null }} value={{ choice: 'auto' }} onChange={vi.fn()}
      uploads={[]} onUploaded={vi.fn()} onBusyChange={onBusyChange} />);
    act(() => root.render(<div />));
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('saves only what it shows: Automatic while reading, or for an icon of a repository since unpicked', () => {
    const pick = { choice: 'image' as const, iconId: 'ap' };
    expect(effectivePick(['o/a'], { kind: 'loading' }, [], pick)).toEqual({ choice: 'auto' });
    expect(effectivePick(['o/a'], { kind: 'failed', error: 'x' }, [], pick)).toEqual({ choice: 'auto' });
    expect(effectivePick(['o/a'], { kind: 'ready', repos, upload: null }, [], pick)).toEqual(pick);
    expect(effectivePick(['o/b'], { kind: 'ready', repos: [repos[1]], upload: null }, [], pick)).toEqual({ choice: 'auto' });
    // An upload of this draft is shown whatever is still being read.
    expect(effectivePick(['o/a'], { kind: 'loading' }, [{ id: 'up', path: null, mimeType: 'image/png', src: url('up') }], { choice: 'image', iconId: 'up' }))
      .toEqual({ choice: 'image', iconId: 'up' });
    expect(effectivePick(['o/a'], { kind: 'loading' }, [], { choice: 'letter' })).toEqual({ choice: 'letter' });
  });

  it('says when an upload is under way, so the caller holds its Save or Create', async () => {
    const onBusyChange = vi.fn();
    render(<ProjectIconPicker repoKeys={['o/a']} read={{ kind: 'ready', repos, upload: null }} value={{ choice: 'auto' }} onChange={vi.fn()}
      uploads={[]} onUploaded={vi.fn()} onBusyChange={onBusyChange} />);
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [new File(['x'], 'a.png', { type: 'image/png' })], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    // jsdom can't draw the image, so the upload ends in its error; busy went on, then off.
    expect(onBusyChange.mock.calls.map(c => c[0])).toEqual([false, true, false]);
  });
});

describe("RepoStep's icon slot", () => {
  it('keeps ↵ there for its own controls, not the step\'s Create', async () => {
    const onAction = vi.fn();
    render(<RepoStep title="New project “x”" catalog={{ kind: 'ready', repos: [] } as never} onRetryCatalog={vi.fn()} picked={[]} onPicked={vi.fn()} max={8}
      action="Create" onAction={onAction} onBack={vi.fn()} extra={<button type="button" className="probe">Upload…</button>} />);
    const probe = host.querySelector('.probe') as HTMLButtonElement;
    await act(async () => { probe.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe('ChangeIconDialog', () => {
  it("reads the project's icons, saves the pick, and reloads the projects", async () => {
    const onClose = vi.fn();
    render(<ChangeIconDialog project={{ id: 'up-1', name: 'termag' }} onClose={onClose} />);
    await flush();
    expect(mocks.icons).toHaveBeenCalledWith('up-1');
    const radios = [...document.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(radios).toHaveLength(3);
    await act(async () => { radios[1].click(); });
    await act(async () => { [...document.querySelectorAll('button')].find(b => b.textContent === 'Save')!.click(); });
    await flush();
    expect(mocks.setIcon).toHaveBeenCalledWith('up-1', { choice: 'letter' });
    expect(mocks.reload).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the image a project shows in view when its icons can't be read, so Save can move off it", async () => {
    mocks.icons.mockRejectedValueOnce(new Error('down'));
    listedIcon.current = { choice: 'image', imageId: 'cur', src: url('cur') };
    render(<ChangeIconDialog project={{ id: 'up-1', name: 'termag' }} onClose={vi.fn()} />);
    await flush();
    const radios = [...document.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(radios.map(r => r.value)).toEqual(['auto', 'letter', 'img:cur']);
    expect(radios.find(r => r.checked)?.value).toBe('img:cur');
    await act(async () => { radios[0].click(); });
    await act(async () => { [...document.querySelectorAll('button')].find(b => b.textContent === 'Save')!.click(); });
    await flush();
    expect(mocks.setIcon).toHaveBeenCalledWith('up-1', { choice: 'auto' });
    listedIcon.current = { choice: 'auto', imageId: null, src: null };
  });

  it('offers nothing to pick until its read answers, so the answer never replaces a pick', async () => {
    let answer: (v: unknown) => void = () => {};
    mocks.icons.mockReturnValueOnce(new Promise(r => { answer = r; }));
    render(<ChangeIconDialog project={{ id: 'up-1', name: 'termag' }} onClose={vi.fn()} />);
    await flush();
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    await act(async () => { answer({ choice: 'auto', imageId: null, upload: null, repos: [] }); });
    expect(document.querySelectorAll('input[type="radio"]').length).toBeGreaterThan(0);
  });

  it("still offers the letters, Automatic and Upload… for the project's repositories when its icons can't be read", async () => {
    mocks.icons.mockRejectedValueOnce(new Error('down'));
    const onClose = vi.fn();
    render(<ChangeIconDialog project={{ id: 'up-1', name: 'termag' }} onClose={onClose} />);
    await flush();
    const radios = [...document.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(radios.map(r => r.value)).toEqual(['auto', 'letter']);
    // Its letter, from the list's repositories, not Scratch's dashed square.
    expect(document.querySelector('.pi-tile .pg-letter')?.textContent).toBe('T');
    await act(async () => { radios[1].click(); });
    const save = [...document.querySelectorAll('button')].find(b => b.textContent === 'Save')!;
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); });
    await flush();
    expect(mocks.setIcon).toHaveBeenCalledWith('up-1', { choice: 'letter' });
  });

  it('closes without a write when nothing changed', async () => {
    const onClose = vi.fn();
    render(<ChangeIconDialog project={{ id: 'up-1', name: 'termag' }} onClose={onClose} />);
    await flush();
    await act(async () => { [...document.querySelectorAll('button')].find(b => b.textContent === 'Save')!.click(); });
    await flush();
    expect(mocks.setIcon).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe('useRepoIconCandidates', () => {
  it('reads as loading for repositories it has not looked at yet, never as an empty "nothing found"', () => {
    const seen: string[] = [];
    function Probe({ keys }: { keys: string[] }) { seen.push(useRepoIconCandidates(keys).kind); return null; }
    render(<Probe keys={[]} />);
    const before = seen.length;
    render(<Probe keys={['o/a']} />);
    expect(seen.slice(0, before).every(k => k === 'ready')).toBe(true);
    // The first render for the picked repository, before its look starts: loading, not "No icon found".
    expect(seen[before]).toBe('loading');
  });
});
