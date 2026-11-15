// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeptChatFile, UploadProgress } from './chatSpaceFiles';
import { useComposerAttachments, type BoxFileUpload, type ComposerAttachments } from './useComposerAttachments';

// A zip: not text (a NUL), so it goes to the upload.
const zip = () => new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 1, 2])], 'logs.zip', { type: 'application/zip' });

describe('useComposerAttachments with a space upload', () => {
  let container: HTMLDivElement;
  let root: Root;
  let held: ComposerAttachments;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  function mount(upload: BoxFileUpload) {
    function Probe() { held = useComposerAttachments({ upload }); return null; }
    act(() => root.render(<Probe />));
  }

  it('shows the file going to the space, how far, then kept there with its link', async () => {
    let progress: ((p: UploadProgress) => void) | undefined;
    let finish: (k: KeptChatFile) => void = () => {};
    mount((_f, _w, p) => { progress = p; return new Promise(r => { finish = r; }); });
    await act(async () => { await held.attach([zip()]); });
    expect(held.boxFiles).toMatchObject([{ name: 'logs.zip', status: 'uploading', path: null }]);
    expect(held.uploading).toBe(true);
    act(() => progress!({ sent: 5, space: 'team-alpha' }));
    expect(held.boxFiles[0]).toMatchObject({ space: 'team-alpha', sent: 5 });
    const path = 'attachments/ws1/20261107T101500Z-a1b2c3/logs.zip';
    await act(async () => { finish({ path, name: 'logs.zip', size: 10, space: 'team-alpha', url: `https://app.example/termag/files/team-alpha/${path}` }); });
    expect(held.boxFiles).toMatchObject([{ status: 'kept', path, space: 'team-alpha', url: `https://app.example/termag/files/team-alpha/${path}` }]);
    expect(held.boxFiles[0].sent).toBeUndefined();
    expect(held.uploading).toBe(false);
  });

  it('forgets the space when the upload turns to the box, and says why it is there', async () => {
    let progress: ((p: UploadProgress) => void) | undefined;
    let finish: (k: KeptChatFile) => void = () => {};
    mount((_f, _w, p) => { progress = p; return new Promise(r => { finish = r; }); });
    await act(async () => { await held.attach([zip()]); });
    act(() => progress!({ sent: 5, space: 'team-alpha' }));
    act(() => progress!({ sent: 0, space: null }));
    expect(held.boxFiles[0].space).toBeUndefined();
    await act(async () => { finish({ path: '.termag-attachments/0123456789abcdef/logs.zip', name: 'logs.zip', size: 10, fellBack: 'you can only read team-alpha' }); });
    expect(held.boxFiles).toMatchObject([{ status: 'kept', path: '.termag-attachments/0123456789abcdef/logs.zip', fellBack: 'you can only read team-alpha' }]);
    expect(held.boxFiles[0].space).toBeUndefined();
  });

  it('drops the chip and says why when neither took it', async () => {
    mount(async () => { throw new Error('the box is gone (and team-alpha didn\'t take it: you can\'t write there)'); });
    await act(async () => { await held.attach([zip()]); await Promise.resolve(); });
    expect(held.boxFiles).toEqual([]);
    expect(held.note).toBe("logs.zip wasn't attached: the box is gone (and team-alpha didn't take it: you can't write there)");
  });
});
