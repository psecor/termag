// Closing the simple UI's tabs, shared by the sidebar (OpenItems.tsx: a tab's
// X and menu, a space's Close all) and the back arrow at the left of a tab
// page's header (a space file, a space's explorer, the agents in no space).
// A close only takes tabs off the list; when it takes the open one, the route
// goes to the tab openItems.tabAfterClose picks: the tab acted on when it
// stays, else the tab shown most recently that is still open
// (OpenItemsState.recent), else the next tab in the open tab's space.
import React, { startTransition, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { rowKey as inboxRowKey } from '../../mobile/inbox';
import { chatHomeSpace } from '../../chat/chatSpaces';
import { groupOpenItems, itemHref, itemKey, tabAfterClose, type OpenItem, type OpenItemGroup } from '../../chat/openItems';
import { useSimpleData, useSimpleDataIfAny } from './simpleData';
import { useReviewsData } from './reviewsData';

/**
 * The sidebar's groups of tabs, by space (openItems.groupOpenItems). A review
 * session is in the sidebar's Reviews section (ReviewsSidebar.tsx), not its
 * space, so it is in no group. Nothing until the spaces load: every tab would
 * show under No space first.
 */
export function useTabGroups(): OpenItemGroup[] {
  const { items, rows, spaces } = useSimpleData();
  const byKey = useMemo(() => new Map(rows.map(r => [inboxRowKey(r.projectId, r.workstream), r])), [rows]);
  const { sessionKeys: reviewSessions } = useReviewsData();
  const tabs = useMemo(
    () => (reviewSessions.size ? items.state.items.filter(i => i.kind !== 'chat' || !reviewSessions.has(inboxRowKey(i.projectId, i.workstream))) : items.state.items),
    [items.state.items, reviewSessions],
  );
  return useMemo(() => {
    if (!spaces.loaded) return [];
    const spaceOf = (c: Parameters<typeof itemKey>[0]) => {
      const row = c.kind === 'chat' ? byKey.get(inboxRowKey(c.projectId, c.workstream)) : undefined;
      return row ? chatHomeSpace(row, spaces.spaces, spaces.index) : undefined;
    };
    return groupOpenItems(tabs, spaces.spaces.map(s => s.name), spaceOf);
  }, [tabs, spaces.loaded, spaces.spaces, spaces.index, byKey]);
}

export type CloseTabs = (ids: readonly string[], opts?: { stay?: OpenItem }) => OpenItem | undefined;

/**
 * Closes tabs `ids`. When that closes the open tab, the route goes to the tab
 * tabAfterClose picks (`stay`, the tab acted on, then the tabs shown most
 * recently, a review session's among them), else Home. Returns the tab it goes to, if it goes to one.
 */
export function useCloseTabs(groups: readonly OpenItemGroup[]): CloseTabs {
  const { items, activeTab } = useSimpleData();
  const navigate = useNavigate();
  // Review sessions' tabs, in the sidebar's Reviews rather than a group: still open, so a close can go back to one.
  const { sessionKeys: reviewSessions } = useReviewsData();
  const reviewTabs = useMemo(
    () => (reviewSessions.size ? items.state.items.filter(i => i.kind === 'chat' && reviewSessions.has(inboxRowKey(i.projectId, i.workstream))) : []),
    [items.state.items, reviewSessions],
  );
  return (ids, opts = {}) => {
    if (ids.length === 0) return undefined;
    const next = tabAfterClose(groups, ids, activeTab, { stay: opts.stay, recent: items.state.recent, also: reviewTabs });
    if (next === null) { items.dismiss(ids); return undefined; }
    startTransition(() => {
      items.dismiss(ids);
      navigate(next ? itemHref(next, next.id) : '/chat');
    });
    return next;
  };
}

/** The back arrow at the left of a tab page's header, before its title: closes that tab and goes back to the one shown before it. */
export function CloseAndBackButton() {
  const simple = useSimpleDataIfAny();
  // A page outside the simple UI's tabs (no data, or a route no tab shows) has nothing to close.
  if (!simple?.activeTab) return null;
  return <CloseAndBack tab={simple.activeTab} />;
}

/** A left arrow on the 16px grid of the header's other icons (SpaceFileView's ReloadIcon, DownloadIcon), at their 14px. */
function BackIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M13 8H3.5M7.5 4 3.5 8l4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseAndBack({ tab }: { tab: string }) {
  const close = useCloseTabs(useTabGroups());
  // Hand-rolled, not LaunchPad's IconButton, because it has to be the same
  // button as Reload and Download in the space file's header (`btn-ghost
  // fv-icon-btn`, a 14px icon, a `data-tip` tooltip), at their size, border and
  // hover on every header it is in. IconButton's box and padding are its own,
  // and LaunchPad's icons are drawn on a 20px grid and blur at the row's 14px
  // (gotcha simple-ui-launchpad-controls). No key closes a tab, so the tooltip
  // names none; Escape stays the page's own.
  return (
    <button type="button" className="btn-ghost fv-icon-btn chat-page-back" aria-label="Close and go back" data-tip="Close and go back"
      onClick={() => { close([tab]); }}>
      <BackIcon />
    </button>
  );
}
