import { describe, expect, it, vi } from 'vitest';
import type { OpenItem } from './openItems';
import { spaceHeaderContextActions } from './spaceHeaderActions';

const items: OpenItem[] = [
  { kind: 'chat', projectId: 'a', workstream: 'main', id: 'c1', openedAt: 3 },
  { kind: 'file', space: 'notes', path: 'plan.md', id: 'f1', openedAt: 2 },
  { kind: 'explorer', space: 'notes', id: 'e1', openedAt: 1 },
  { kind: 'file', space: 'notes', path: 'q3.pdf', id: 'f2', openedAt: 0 },
];

describe('spaceHeaderContextActions', () => {
  it('closes every tab, or only the file tabs, in their order', () => {
    const close = vi.fn();
    const [all, files] = spaceHeaderContextActions(items, close);
    expect([all.label, files.label]).toEqual(['Close all tabs', 'Close file tabs']);
    expect([all.disabled, files.disabled]).toEqual([false, false]);
    all.onSelect();
    files.onSelect();
    expect(close.mock.calls).toEqual([[['c1', 'f1', 'e1', 'f2']], [['f1', 'f2']]]);
  });

  it('disables what has nothing to close', () => {
    expect(spaceHeaderContextActions([], vi.fn()).map(a => a.disabled)).toEqual([true, true]);
    expect(spaceHeaderContextActions(items.filter(i => i.kind !== 'file'), vi.fn()).map(a => a.disabled)).toEqual([false, true]);
  });
});
