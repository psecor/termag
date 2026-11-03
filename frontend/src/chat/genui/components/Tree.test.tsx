// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
// React Aria finds a pressed row by its key through CSS.escape, which jsdom lacks.
const css = globalThis as { CSS?: { escape?: (s: string) => string } };
css.CSS ??= {};
css.CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
const { default: GenUiSurface } = await import('../GenUiSurface');
const { default: TreeDef, measureTree, TREE_MAX_DEPTH, TREE_MAX_NODES } = await import('./Tree');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const tree = (props: object) => JSON.stringify({ root: 't', elements: { t: { type: 'Tree', props, children: [] } } });
function draw(props: object) {
  const block = { type: 'code' as const, lang: 'spec', text: tree(props), open: false };
  act(() => root.render(<GenUiSurface block={block} itemKey="r" streaming={false} chat={null} fallback={null} />));
}
const rows = () => [...host.querySelectorAll('[role="row"]')].map(r => r.querySelector('.genui-tree-label')?.textContent);

/** A chain of nodes n levels deep. */
const chain = (n: number): object => ({ id: `n${n}`, label: `Level ${n}`, ...(n > 1 ? { children: [chain(n - 1)] } : {}) });
const items = [
  { id: 'src', label: 'src', detail: '3 files', children: [
    { id: 'src/a.ts', label: 'a.ts', detail: '+12 −3' },
    { id: 'src/lib', label: 'lib', children: [{ id: 'src/lib/b.ts', label: 'b.ts' }] },
  ] },
  { id: 'README.md', label: 'README.md' },
];

describe('Tree', () => {
  it('takes nested nodes up to its depth and size, with ids of their own', () => {
    const ok = (p: object) => TreeDef.props.safeParse({ label: 'Files', ...p }).success;
    expect(ok({ items })).toBe(true);
    expect(ok({ items, defaultExpanded: 'all' })).toBe(true);
    expect(ok({ items, defaultExpanded: ['src', 'src/lib'] })).toBe(true);
    expect(ok({ items: [chain(TREE_MAX_DEPTH)] })).toBe(true);
    expect(ok({ items: [chain(TREE_MAX_DEPTH + 1)] })).toBe(false);
    const wide = (n: number) => [{ id: 'root', label: 'root', children: Array.from({ length: n - 1 }, (_, i) => ({ id: `c${i}`, label: `c${i}` })) }];
    expect(ok({ items: wide(TREE_MAX_NODES) })).toBe(true);
    expect(ok({ items: wide(TREE_MAX_NODES + 1) })).toBe(false);
    expect(ok({ items: [{ id: 'a', label: 'a', children: [{ id: 'a', label: 'again' }] }] })).toBe(false);
    expect(ok({ items: [] })).toBe(false);
    expect(ok({ items: [{ id: 'a', label: 'x'.repeat(201) }] })).toBe(false);
    expect(ok({ items, defaultExpanded: 'some' })).toBe(false);
    expect(measureTree(items)).toEqual({ nodes: 5, depth: 3, repeated: null });
  });

  it('draws only the top level by default, named by its label', () => {
    draw({ label: 'Files changed', items });
    expect(host.querySelector('.genui-bad')).toBeNull();
    expect(host.querySelector('[role="treegrid"]')?.getAttribute('aria-label')).toBe('Files changed');
    expect(rows()).toEqual(['src', 'README.md']);
    expect(host.querySelector('[role="row"][aria-expanded="false"]')?.textContent).toContain('3 files');
  });

  it('opens every branch for "all", or the ids it is given', () => {
    draw({ label: 'Files', items, defaultExpanded: 'all' });
    expect(rows()).toEqual(['src', 'a.ts', 'lib', 'b.ts', 'README.md']);
    expect([...host.querySelectorAll('[role="row"]')].map(r => r.getAttribute('aria-level'))).toEqual(['1', '2', '2', '3', '1']);
    // What opens first is read once, when the tree mounts.
    act(() => root.unmount());
    root = createRoot(host);
    draw({ label: 'Files', items: [...items.slice(0, 1), { id: 'docs', label: 'docs', children: [{ id: 'docs/x.md', label: 'x.md' }] }], defaultExpanded: ['docs'] });
    expect(rows()).toEqual(['src', 'docs', 'x.md']);
  });

  it('opens a branch from its chevron', async () => {
    draw({ label: 'Files', items });
    const chevron = host.querySelector('[role="row"] button[slot="chevron"], [role="row"] button') as HTMLButtonElement;
    expect(chevron.getAttribute('aria-label')).toBe('Expand');
    await act(async () => { chevron.click(); });
    expect(rows()).toEqual(['src', 'a.ts', 'lib', 'README.md']);
  });

  it('keeps a row\'s label and detail in one box, the one Tree.css indents for a leaf', () => {
    draw({ label: 'Files', defaultExpanded: 'all', items: [{ id: 'src', label: 'src', children: [{ id: 'a', label: 'a.ts', detail: '+12' }] }] });
    const leaf = [...host.querySelectorAll('[role="row"]')].find(r => r.textContent?.startsWith('a.ts'))!;
    const cells = leaf.querySelectorAll(':scope > [role="gridcell"] > *');
    // No chevron on a leaf: its one child holds the label and the detail, so the detail keeps its place at the row's end.
    expect(cells).toHaveLength(1);
    expect(cells[0].querySelector(':scope > .genui-tree-label')?.textContent).toBe('a.ts');
    expect(cells[0].querySelector(':scope > .genui-tree-detail')?.textContent).toBe('+12');
  });

  it('shows labels in monospace only when code', () => {
    draw({ label: 'Files', items, code: true });
    expect(host.querySelector('.genui-tree-code')).not.toBeNull();
    draw({ label: 'Teams', items });
    expect(host.querySelector('.genui-tree-code')).toBeNull();
  });

  it('draws a note, not a tree, when an id repeats', () => {
    draw({ label: 'Files', items: [{ id: 'a', label: 'a' }, { id: 'a', label: 'b' }] });
    expect(host.querySelector('.genui-bad')?.textContent).toMatch(/^Tree could not be drawn \(items: every node needs its own id\)/);
  });
});
