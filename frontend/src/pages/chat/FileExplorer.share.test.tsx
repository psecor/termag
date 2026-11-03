// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announceShared } from '../../chat/fileShare';

const mocks = vi.hoisted(() => ({ tree: vi.fn() }));
vi.mock('./simpleData', () => {
  const data = () => ({
    items: { pick: () => 't1', state: { items: [] } }, rows: [], live: new Map(), setupOf: new Map(), links: [], activeTab: 't1', itemsShown: true,
    spaces: { enabled: true, loaded: true, spaces: [{ name: 'notes' }], index: new Map() },
  });
  return { WithSimpleData: ({ children }: { children: React.ReactNode }) => children, useSimpleData: data, useSimpleDataIfAny: data };
});
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ projects: [] }) }));
vi.mock('../../services/api', () => ({ spacesApi: { tree: mocks.tree } }));

import { ExplorerPanel } from './FileExplorer';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.tree.mockResolvedValue({ prefix: '', dirs: [], files: [{ name: 'plan.md', path: 'plan.md', size: 10 }], nextCursor: null });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function open() {
  await act(async () => root.render(<MemoryRouter><ExplorerPanel space="notes" /></MemoryRouter>));
  await act(async () => {});
}
const marked = () => host.querySelector('.fx-file .fx-shared') !== null;

describe('the explorer\'s shared mark', () => {
  it('follows a share made from the file view while the explorer is open', async () => {
    await open();
    expect(host.querySelector('.fx-file')?.textContent).toContain('plan.md');
    expect(marked()).toBe(false);
    act(() => announceShared('notes', 'plan.md', true));
    expect(marked()).toBe(true);
    act(() => announceShared('notes', 'plan.md', false));
    expect(marked()).toBe(false);
  });

  it('follows a share made while the explorer was closed (Tools shut), from the listing it kept', async () => {
    await open();
    expect(marked()).toBe(false);
    const fetches = mocks.tree.mock.calls.length;
    act(() => root.render(<MemoryRouter><div /></MemoryRouter>));
    act(() => announceShared('notes', 'plan.md', true));
    await open();
    // The listing is the one kept for the page's life, not a new fetch.
    expect(mocks.tree).toHaveBeenCalledTimes(fetches);
    expect(marked()).toBe(true);
    act(() => root.render(<MemoryRouter><div /></MemoryRouter>));
    act(() => announceShared('notes', 'plan.md', false));
    await open();
    expect(marked()).toBe(false);
  });
});
