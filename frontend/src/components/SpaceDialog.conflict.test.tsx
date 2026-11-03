// @vitest-environment jsdom
// A browser upload over a space file sends the version the page shows, and a
// newer one is "changed since you opened it" with Reload and Overwrite.
//
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ tree: vi.fn(), uploadFile: vi.fn() }));
vi.mock('../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  spacesApi: { tree: mocks.tree, members: vi.fn(async () => ({ members: [], invites: [] })), boxes: vi.fn(async () => ({ boxes: [] })) },
}));
vi.mock('../services/spaceTransfer', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/spaceTransfer')>()),
  uploadFile: mocks.uploadFile,
}));

import { SpaceDialog } from './SpaceDialog';
import { UploadConflict } from '../services/spaceTransfer';

let root: Root;
let container: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<SpaceDialog space={{ id: 's', name: 'team', description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role: 'editor' }} myBoxes={[]} userId="u1" onClose={() => {}} onChanged={() => {}} />);
  });
  await flush();
}

async function choose(...files: File[]) {
  const input = document.querySelector('input[aria-label="Upload files"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
}

const button = (label: string) => [...document.querySelectorAll('.space-uploads button')].find(b => b.textContent === label) as HTMLButtonElement | undefined;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.tree.mockReset();
  mocks.tree.mockResolvedValue({ prefix: '', dirs: [], files: [{ name: 'notes.md', path: 'notes.md', size: 5, modifiedAt: null, etag: '"v1"' }], nextCursor: null });
  mocks.uploadFile.mockReset();
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('SpaceDialog upload conflicts', () => {
  it('sends the shown version, and on a conflict offers Reload and Overwrite', async () => {
    mocks.uploadFile.mockRejectedValueOnce(new UploadConflict('notes.md', '"v2"', 'bob@example.com', '2026-10-27T10:00:00.000Z', true));
    mocks.uploadFile.mockResolvedValueOnce(undefined);
    await render();
    await choose(new File(['hello'], 'notes.md'));
    expect(mocks.uploadFile.mock.calls[0][0]).toBe('team');
    expect(mocks.uploadFile.mock.calls[0][1]).toBe('notes.md');
    expect(mocks.uploadFile.mock.calls[0][5]).toEqual({ ifMatch: '"v1"' });
    const row = document.querySelector('.space-uploads li')!;
    expect(row.textContent).toContain('Changed since you opened it (by bob@example.com');
    expect(button('Reload')).toBeTruthy();

    // The person reads the conflict a while: the batch's own cleanup has run by the time they choose.
    await act(async () => { await new Promise(r => setTimeout(r, 2700)); });
    expect(button('Overwrite'), 'a conflict row stays until the person chooses').toBeTruthy();
    await act(async () => { button('Overwrite')!.click(); });
    await flush();
    expect(mocks.uploadFile).toHaveBeenCalledTimes(2);
    expect(mocks.uploadFile.mock.calls[1][5], 'Overwrite writes unconditionally').toBeNull();
    expect(document.querySelector('.space-uploads li')!.textContent).toContain('done');
    // A finished Overwrite clears its row like any finished upload (Bugbot sweep 14).
    await act(async () => { await new Promise(r => setTimeout(r, 2700)); });
    expect(document.querySelector('.space-uploads li')).toBeNull();
  }, 10_000);

  it('a name the folder doesn\'t show must be new; Reload drops the row and lists again', async () => {
    mocks.uploadFile.mockRejectedValueOnce(new UploadConflict('fresh.md', '"x1"', null, null, true));
    await render();
    await choose(new File(['x'], 'fresh.md'));
    expect(mocks.uploadFile.mock.calls[0][5]).toEqual({ ifNoneMatch: '*' });
    const listed = mocks.tree.mock.calls.length;
    await act(async () => { button('Reload')!.click(); });
    await flush();
    expect(document.querySelector('.space-uploads li')).toBeNull();
    expect(mocks.tree.mock.calls.length).toBeGreaterThan(listed);
  });
});
