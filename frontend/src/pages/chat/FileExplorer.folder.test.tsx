// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceTree } from '../../services/api';

const TREE: Record<string, { dirs: string[]; files: string[] }> = {
  '': { dirs: ['artifacts/', 'plans/'], files: ['board.md'] },
  'artifacts/': { dirs: ['bugs/', 'e2e/'], files: [] },
  'artifacts/bugs/': { dirs: [], files: ['artifacts/bugs/demo.md'] },
};
const mocks = vi.hoisted(() => ({ tree: vi.fn() }));
vi.mock('./simpleData', () => {
  const data = () => ({
    items: { pick: () => 't1', state: { items: [] } }, rows: [], live: new Map(), setupOf: new Map(), links: [], activeTab: 't1', itemsShown: true,
    spaces: { enabled: true, loaded: true, spaces: [{ name: 'notes' }, { name: 'other' }], index: new Map() },
  });
  return { WithSimpleData: ({ children }: { children: React.ReactNode }) => children, useSimpleData: data, useSimpleDataIfAny: data };
});
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ projects: [] }) }));
vi.mock('../../services/api', () => ({ spacesApi: { tree: mocks.tree } }));

import { ExplorerPanel } from './FileExplorer';

let root: Root;
let host: HTMLDivElement;
let scrolled: string[];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.tree.mockImplementation(async (_space: string, prefix: string): Promise<SpaceTree> => {
    const t = TREE[prefix] ?? { dirs: [], files: [] };
    const name = (p: string) => p.replace(/\/$/, '').split('/').pop()!;
    return {
      prefix, nextCursor: null,
      dirs: t.dirs.map(d => ({ name: name(d), path: prefix + d })),
      files: t.files.map(path => ({ name: name(path), path, size: 1, modifiedAt: null })),
    };
  });
  scrolled = [];
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.dataset.dir ?? this.textContent ?? ''); };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  mocks.tree.mockReset();
});

async function open(props: React.ComponentProps<typeof ExplorerPanel>) {
  await act(async () => root.render(<MemoryRouter><ExplorerPanel {...props} /></MemoryRouter>));
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
const dirRow = (dir: string) => host.querySelector<HTMLButtonElement>(`[data-dir="${dir}"]`);

describe('a folder shown in the explorer (a link to a folder)', () => {
  it('opens the folder and every folder above it, scrolls to it and highlights it like the file shown', async () => {
    await open({ space: 'notes', activeDir: 'artifacts/bugs/' });
    expect(mocks.tree.mock.calls.map(c => c[1]).sort()).toEqual(['', 'artifacts/', 'artifacts/bugs/']);
    const row = dirRow('artifacts/bugs/')!;
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(dirRow('artifacts/')!.getAttribute('aria-expanded')).toBe('true');
    expect(row.classList.contains('active')).toBe(true);
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(dirRow('artifacts/')!.classList.contains('active')).toBe(false);
    expect(dirRow('plans/')!.classList.contains('active')).toBe(false);
    expect([...host.querySelectorAll('.fx-file')].map(f => f.textContent)).toEqual(['demo.md', 'board.md']);
    expect(scrolled).toEqual(['artifacts/bugs/']);
  });

  it('keeps it highlighted while other folders open and shut', async () => {
    await open({ space: 'other', activeDir: 'artifacts/bugs/' });
    act(() => dirRow('plans/')!.click());
    expect(dirRow('artifacts/bugs/')!.classList.contains('active')).toBe(true);
  });
});
