// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ view: vi.fn(), sharedView: vi.fn() }));
vi.mock('../../services/api', () => ({ spacesApi: api }));

import { Markdown, MarkdownLinkContext } from '../../chat/Markdown';
import { SpaceMarkdownImages } from './SpaceMarkdownImage';

let root: Root;
let host: HTMLDivElement;
const fileLink = (space: string, path: string) => `${window.location.origin}/files/${space}/${path}`;
const signedImage = (url: string) => ({ url, size: 10, expiresAt: '', view: { contentType: 'image/png', render: 'frame' } });
const notFound = () => Object.assign(new Error('nope'), { response: { status: 404, data: { code: 'file_not_found' } } });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.view.mockReset();
  api.sharedView.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function show(text: string, { path = 'artifacts/md-images/demo.md', viaShare = false } = {}) {
  await act(async () => root.render(
    <SpaceMarkdownImages space="improve-termag" path={path} viaShare={viaShare}><Markdown text={text} /></SpaceMarkdownImages>,
  ));
}

describe('images in a space file\'s Markdown', () => {
  it('shows a relative image from the same space inline, linked to the file', async () => {
    api.view.mockResolvedValue(signedImage('https://s3.test/strip?sig=1'));
    await show('![strip](../empty-box/1-strip.png)');
    expect(api.view).toHaveBeenCalledWith('improve-termag', 'artifacts/empty-box/1-strip.png');
    const img = host.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://s3.test/strip?sig=1');
    expect(img.getAttribute('alt')).toBe('strip');
    expect(img.closest('a')!.getAttribute('href')).toBe(fileLink('improve-termag', 'artifacts/empty-box/1-strip.png'));
  });

  it('opens the file in place on a plain click', async () => {
    api.view.mockResolvedValue(signedImage('https://s3.test/a'));
    const opened: string[] = [];
    await act(async () => root.render(
      <MarkdownLinkContext.Provider value={href => { opened.push(href); return true; }}>
        <SpaceMarkdownImages space="improve-termag" path="demo.md" viaShare={false}><Markdown text="![a](a.png)" /></SpaceMarkdownImages>
      </MarkdownLinkContext.Provider>,
    ));
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    host.querySelector('img')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(opened).toEqual([fileLink('improve-termag', 'a.png')]);
  });

  it('asks the share route for a viewer who came through a share', async () => {
    api.sharedView.mockResolvedValue(signedImage('https://s3.test/b'));
    await show('![b](b.png)', { viaShare: true });
    expect(api.view).not.toHaveBeenCalled();
    expect(api.sharedView).toHaveBeenCalledWith('improve-termag', 'artifacts/md-images/b.png');
  });

  it('shows a missing file as its alt text, linked, and "(missing)"', async () => {
    api.view.mockRejectedValue(notFound());
    await show('![strip](gone.png)');
    expect(host.querySelector('img')).toBeNull();
    const a = host.querySelector('a')!;
    expect(a.textContent).toBe('strip');
    expect(a.getAttribute('href')).toBe(fileLink('improve-termag', 'artifacts/md-images/gone.png'));
    expect(host.textContent).toContain('strip (missing)');
  });

  it('links a file that is not an image instead of drawing it', async () => {
    api.view.mockResolvedValue({ url: 'https://s3.test/n', size: 3, expiresAt: '', view: { contentType: 'text/markdown', render: 'markdown' } });
    await show('![notes](notes.md)');
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('a')!.textContent).toBe('notes');
  });

  it('never fetches an external image, another space\'s, or a data: URL', async () => {
    await show('![ext](https://x.dev/p.png) ![other](notes:a.png) ![inline](data:image/png;base64,AAAA)');
    expect(api.view).not.toHaveBeenCalled();
    expect(host.querySelector('img')).toBeNull();
    const links = [...host.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([['ext', 'https://x.dev/p.png'], ['other', fileLink('notes', 'a.png')]]);
    expect(host.textContent).toContain('inline');
  });

  it('never fetches a path that climbs out of the space', async () => {
    await show('![up](../../../../etc/x.png)');
    expect(api.view).not.toHaveBeenCalled();
    expect(host.querySelector('a, img')).toBeNull();
    expect(host.textContent).toBe('up');
  });
});

describe('images in a chat reply', () => {
  it('keeps a relative image as its alt text and an http(s) one as a link, fetching neither', async () => {
    await act(async () => root.render(<Markdown text="![strip](strip.png) ![p](https://x.dev/p.png)" />));
    expect(api.view).not.toHaveBeenCalled();
    expect(host.querySelector('img')).toBeNull();
    expect([...host.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual(['https://x.dev/p.png']);
    expect(host.textContent).toContain('strip');
  });
});
