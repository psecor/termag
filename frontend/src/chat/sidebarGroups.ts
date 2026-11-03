// The sidebar's groups under the chrome refresh's view options
// (chat/sidebarView.ts): the spaces' own groups with the filters applied, or
// every agent by its state (chat/rowState.ts) and then the files and new tabs.
// Pure, for the tests; OpenItems.tsx draws what it returns.
import type { OpenItem } from './openItems';
import type { RowStateKind } from './rowState';
import type { SidebarView } from './sidebarView';

export interface StatusGroup { key: string; name: string; kinds: readonly RowStateKind[] }

/** By state, in the order they need you. */
export const STATUS_GROUPS: readonly StatusGroup[] = [
  { key: 'needs-you', name: 'Needs you', kinds: ['approval', 'unread', 'error'] },
  { key: 'working', name: 'Working', kinds: ['working'] },
  { key: 'recent', name: 'Recent', kinds: ['done'] },
  { key: 'off', name: 'Not running', kinds: ['off'] },
];
export const FILES_GROUP = { key: 'files', name: 'Files' } as const;

export interface ViewGroup {
  /** The space a space group is, null for No space and for a state's group. */
  space: string | null;
  /** The state's group, or null for a space's. */
  status: { key: string; name: string } | null;
  items: OpenItem[];
  /** How many it had before the filters: a space emptied by them is not "Nothing open". */
  total: number;
}

/**
 * `stateOf` is an agent tab's state, or null when its row is unknown (kept, so
 * a filter never hides what it can't judge). `openTab` is the tab on screen,
 * which no filter hides: the sidebar never loses what is open, as a folded
 * space keeps it too.
 */
export function viewGroups(
  groups: ReadonlyArray<{ space: string | null; items: readonly OpenItem[] }>,
  view: Pick<SidebarView, 'groupBy' | 'showFiles' | 'showIdle'>,
  stateOf: (item: OpenItem) => RowStateKind | null,
  openTab: string | null = null,
): ViewGroup[] {
  const keep = (item: OpenItem) => {
    if (item.id === openTab) return true;
    if (item.kind !== 'chat') return view.showFiles;
    return view.showIdle || stateOf(item) !== 'off';
  };
  if (view.groupBy === 'space') {
    return groups.map(g => ({ space: g.space, status: null, items: g.items.filter(keep), total: g.items.length }));
  }
  const all = groups.flatMap(g => g.items).filter(keep);
  const out: ViewGroup[] = STATUS_GROUPS.map(sg => {
    const items = all.filter(i => {
      if (i.kind !== 'chat') return false;
      const kind = stateOf(i);
      // An agent whose state is unknown counts as recent rather than vanishing.
      return kind == null ? sg.key === 'recent' : sg.kinds.includes(kind);
    });
    return { space: null, status: { key: sg.key, name: sg.name }, items, total: items.length };
  });
  const files = all.filter(i => i.kind !== 'chat');
  out.push({ space: null, status: { ...FILES_GROUP }, items: files, total: files.length });
  return out.filter(g => g.items.length > 0);
}
