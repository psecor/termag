// The simple UI's sidebar of tabs (simple-ui-side-panel-enabled,
// chat/openItems.ts), grouped by space: agents, space files and new tabs,
// one fixed-height line each, in the person's order. A new tab goes on top
// of its space; dragging a row or Alt+Up/Down on it moves it within its
// space, and a drag over another space is refused with a note. Each space's
// + starts an agent in it or opens a new tab, its recents beside Files. A
// tab's ⋮ (on hover or focus, always on a touch screen), a right click, the
// context menu key or Shift+F10 opens its menu, which has Close tab. A touch
// screen has no drag, and tabs keep their order there.
// Agents whose box has no space are under "No space", which has no +.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import type { InboxRow } from '../../mobile/inbox';
import { chatLiveKey } from '../../chat/chatLiveStatus';
import { canStartChatIn } from '../../chat/chatSpaces';
import { agentLabel } from '../../chat/explorerAgents';
import { groupOpenItems, itemHref, itemKey, newTabId, type OpenItem } from '../../chat/openItems';
import { chatRowName, sidebarLine } from '../../chat/simpleChat';
import { spaceColorStyle } from '../../chat/spaceColors';
import { isMenuKey, MenuButton, swallowNextClick, useCoarsePointer, useContextMenu, type MenuTrigger } from './ContextMenu';
import { useSimpleData } from './simpleData';
import { SpaceSwatch } from './SpaceSwatch';

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

export function FileIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" d="M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" d="M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z" />
    </svg>
  );
}

/** An agent: a bot's head, with its status as a dot on the corner (none when it isn't running). */
export function AgentIcon({ status }: { status: string }) {
  return (
    <span className="chat-agent-icon" data-status={status} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="14" height="14">
        <path fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" d="M8 1.8v2.2" />
        <rect x="2.5" y="4" width="11" height="9" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="6" cy="8.5" r="1.1" fill="currentColor" />
        <circle cx="10" cy="8.5" r="1.1" fill="currentColor" />
      </svg>
      <span className="chat-agent-dot" />
    </span>
  );
}

/** A plain left click, which the app handles; a modifier or middle click is the browser's. */
export function plainClick(e: React.MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** `href` (an app route) in a new browser tab. */
export function openInBrowserTab(href: string): void {
  window.open(`${import.meta.env.BASE_URL.replace(/\/$/, '')}${href}`, '_blank', 'noopener');
}

const rowKey = (r: InboxRow) => itemKey({ kind: 'chat', projectId: r.projectId, workstream: r.workstream });

function useDismissOnOutside(open: boolean, close: () => void, inside: Array<React.RefObject<HTMLElement>>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (inside.some(r => r.current?.contains(e.target as Node))) return;
      swallowNextClick();
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onScroll = (e: Event) => { if (!inside.some(r => r.current?.contains(e.target as Node))) close(); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close, inside]);
}

/** A space's + and its menu: a new agent, or a new tab on the space's explorer. */
function SpaceAdd({ space }: { space: string }) {
  const navigate = useNavigate();
  const { spaces } = useSimpleData();
  // The list scrolls and would clip the menu, so it is portaled to the body at the button's place.
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useMemo(() => () => setMenu(null), []);
  const inside = useMemo(() => [button, menuRef] as Array<React.RefObject<HTMLElement>>, []);
  useDismissOnOutside(menu !== null, close, inside);
  const toggle = () => {
    if (menu) { setMenu(null); return; }
    const r = button.current!.getBoundingClientRect();
    setMenu({ top: r.bottom + 4, left: Math.max(8, r.left) });
  };
  // The + sits at the sidebar's right edge, so on a phone a menu starting at it would run off the screen.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const left = Math.max(8, Math.min(menu.left, vw - el.offsetWidth - 8));
    if (left !== menu.left) setMenu({ ...menu, left });
  }, [menu]);
  const canStart = canStartChatIn(space, spaces.spaces);
  const pick = (fn: () => void) => () => { setMenu(null); fn(); };
  return (
    <>
      <button ref={button} type="button" className="chat-group-new chat-group-add" aria-label={`New in ${space}`}
        data-tip={`New agent or tab in ${space}`}
        aria-haspopup="menu" aria-expanded={menu !== null} onClick={toggle}>+</button>
      {menu && createPortal(
        <div ref={menuRef} className="chat-add-menu chat-add-menu-fixed" role="menu" aria-label={`New in ${space}`} style={{ top: menu.top, left: menu.left }}>
          <button type="button" role="menuitem" disabled={!canStart} onClick={pick(() => navigate(`/chat/new?space=${encodeURIComponent(space)}`))}>
            <span className="chat-add-label">New agent</span>
            <span className="chat-add-hint">{canStart ? `Starts on its own box, with access to ${space}` : `You can't start agents in ${space}`}</span>
          </button>
          <button type="button" role="menuitem" onClick={pick(() => navigate(itemHref({ kind: 'explorer', space }, newTabId()), { state: { openTools: true } }))}>
            <span className="chat-add-label">New tab</span>
            <span className="chat-add-hint">Browse {space}'s agents and files</span>
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

type Drop = { group: string; index: number };
const NO_SPACE = '\u0000none';

/** The groups and their tabs. */
export function OpenItemsGroups() {
  const { items, rows, live, setupOf, spaces, activeTab, titlesShown } = useSimpleData();
  const navigate = useNavigate();
  const byKey = useMemo(() => new Map(rows.map(r => [rowKey(r), r])), [rows]);
  const groups = useMemo(
    // Nothing until the spaces load: every tab would show under No space first.
    () => (spaces.loaded ? groupOpenItems(items.state.items, spaces.spaces.map(s => s.name), c => byKey.get(itemKey(c))?.instanceId, spaces.index, spaces.current) : []),
    [items.state.items, spaces.loaded, spaces.spaces, spaces.index, spaces.current, byKey],
  );
  const ctx = useContextMenu();
  const coarse = useCoarsePointer();

  const list = useRef<HTMLUListElement>(null);
  const [drag, setDrag] = useState<{ group: string; id: string; label: string } | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  // Moving a row re-inserts its node, which drops focus; put it back after the render.
  const refocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    [...(list.current?.querySelectorAll<HTMLElement>('a[data-tab]') ?? [])].find(a => a.dataset.tab === id)?.focus();
  }, [items.state.items]);

  const nameOf = (space: string | null) => space ?? 'No space';

  function close(item: OpenItem) {
    items.dismiss(item.id);
    if (item.id !== activeTab) return;
    const own = groups.find(g => g.items.some(i => i.id === item.id));
    const next = own?.items.find(i => i.id !== item.id) ?? groups.flatMap(g => g.items).find(i => i.id !== item.id);
    navigate(next ? itemHref(next, next.id) : '/chat');
  }

  function move(groupName: string, ids: string[], id: string, to: number, label: string) {
    const from = ids.indexOf(id);
    if (to < 0 || to >= ids.length) {
      setAnnounce(`${label} is already ${to < 0 ? 'first' : 'last'} in ${groupName}. Tabs stay in their space.`);
      return;
    }
    if (to === from) return;
    items.reorder(ids, id, to);
    setAnnounce(`${label} moved to position ${to + 1} of ${ids.length} in ${groupName}`);
  }

  const end = () => { setDrag(null); setDrop(null); setDenied(null); };
  // While a row is dragged nothing outside its own space takes it: the browser
  // shows its no-drop cursor, and a space it is over says why.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const refuse = (e: DragEvent) => {
      e.preventDefault();
      if (e.type === 'dragover' && e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', refuse);
    window.addEventListener('drop', refuse);
    window.addEventListener('dragend', end);
    return () => { window.removeEventListener('dragover', refuse); window.removeEventListener('drop', refuse); window.removeEventListener('dragend', end); };
  }, [dragging]);

  const groupProps = (groupId: string, groupName: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      if (groupId !== drag.group) {
        e.dataTransfer.dropEffect = 'none';
        if (denied !== groupId) {
          setDenied(groupId);
          setDrop(null);
          setAnnounce(`Can't move ${drag.label} to ${groupName}. Tabs stay in their space.`);
        }
        return;
      }
      e.dataTransfer.dropEffect = 'move';
      if (denied) setDenied(null);
      if ((e.target as HTMLElement).closest('.chat-group-head') && (drop?.group !== groupId || drop.index !== 0)) setDrop({ group: groupId, index: 0 });
    },
    onDrop: (e: React.DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      const g = groups.find(x => (x.space ?? NO_SPACE) === drag.group);
      if (g && groupId === drag.group && drop?.group === drag.group) {
        const ids = g.items.map(i => i.id);
        const from = ids.indexOf(drag.id);
        move(nameOf(g.space), ids, drag.id, drop.index > from ? drop.index - 1 : drop.index, drag.label);
      }
      end();
    },
  });

  function row(item: OpenItem, index: number, groupId: string, groupName: string, ids: string[]) {
    const isActive = item.id === activeTab;
    let icon: React.ReactNode;
    let name: React.ReactNode;
    let label: string;
    let tip: string;
    let status: string | null = null;
    let band: string | undefined;
    if (item.kind === 'chat') {
      const r = byKey.get(itemKey(item))!;
      const line = sidebarLine(r, live.get(chatLiveKey(r.projectId, r.workstream)), setupOf.get(r.projectId));
      icon = <AgentIcon status={line.glyph} />;
      // One line: Claude's title for the session with the project after it, or the project as before.
      const named = chatRowName(r, titlesShown);
      name = named.title
        ? <>{named.title}<span className="chat-row-ws"> · {named.where}</span></>
        : <>{r.projectName}{r.workstream !== 'main' && <span className="chat-row-ws"> · {r.workstream}</span>}</>;
      label = named.title ? `${named.title} · ${named.where}` : agentLabel(r);
      status = line.state;
      tip = [label, line.state, line.message].filter(Boolean).join('\n');
      band = r.band;
    } else if (item.kind === 'file') {
      icon = <span className="chat-item-icon" aria-hidden="true"><FileIcon /></span>;
      name = label = baseName(item.path);
      tip = `${item.space}:${item.path}`;
    } else {
      icon = <span className="chat-item-icon" aria-hidden="true"><FolderIcon /></span>;
      name = 'New tab';
      label = `New tab in ${item.space}`;
      tip = `${item.space}'s recent files and agents`;
    }
    const dropHere = drop && drop.group === groupId && drag && drag.id !== item.id ? drop.index : null;
    const menu = (e: MenuTrigger) => ctx.open(e, label, [
      { label: 'Duplicate tab', onSelect: () => navigate(itemHref(item, items.duplicate(item.id))) },
      { label: 'Open in new browser tab', onSelect: () => openInBrowserTab(itemHref(item)) },
      { label: 'Close tab', onSelect: () => close(item) },
    ], item.id);
    return (
      <li key={item.id} className={`chat-item-li${drag?.id === item.id ? ' dragging' : ''}${dropHere === index ? ' drop-before' : ''}${dropHere === index + 1 && index === ids.length - 1 ? ' drop-after' : ''}`}
        draggable={!coarse}
        onContextMenu={menu}
        onDragStart={e => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', label);
          setDrag({ group: groupId, id: item.id, label });
        }}
        onDragOver={e => {
          if (!drag || drag.group !== groupId) return;
          e.preventDefault();
          const box = e.currentTarget.getBoundingClientRect();
          const at = e.clientY < box.top + box.height / 2 ? index : index + 1;
          if (drop?.group !== groupId || drop.index !== at) setDrop({ group: groupId, index: at });
        }}
        onDragEnd={end}>
        {/* The href has no tab, so a modifier click opens the thing itself in a new browser tab. */}
        <Link to={itemHref(item)} draggable={false} data-tab={item.id} className={`chat-item${isActive ? ' active' : ''}`}
          aria-current={isActive ? 'page' : undefined} aria-describedby="chat-items-move-hint"
          data-kind={item.kind} data-band={band} data-tip={tip}
          onClick={e => {
            if (!plainClick(e)) return;
            e.preventDefault();
            navigate(itemHref(item, item.id));
          }}
          onKeyDown={e => {
            if (isMenuKey(e)) { menu(e); return; }
            if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
            e.preventDefault();
            refocus.current = item.id;
            move(groupName, ids, item.id, index + (e.key === 'ArrowUp' ? -1 : 1), label);
          }}>
          {icon}
          <span className="chat-item-name">{name}</span>
          {status && <span className="chat-sr">, {status}</span>}
        </Link>
        <MenuButton label={label} open={menu} expanded={ctx.openKey === item.id} className="chat-item-menu" />
      </li>
    );
  }

  return (
    <>
      <ul ref={list} className="chat-list chat-items">
        {!spaces.loaded && <li className="chat-list-empty">Loading…</li>}
        {groups.map(g => {
          const id = g.space ?? NO_SPACE;
          const name = nameOf(g.space);
          const ids = g.items.map(i => i.id);
          const refused = denied === id && drag !== null;
          return (
            <li key={id} className={`chat-group${refused ? ' drop-denied' : ''}`} data-group={id} data-space={g.space ? undefined : 'none'}
              style={spaceColorStyle(g.space, spaces.colorOf)} {...groupProps(id, name)}>
              <div className="chat-group-head">
                <SpaceSwatch space={g.space} />
                <span className="chat-group-name">{name}</span>
                {g.space && <SpaceAdd space={g.space} />}
              </div>
              <ul className="chat-group-list" aria-label={name}>
                {g.items.length === 0 && <li className="chat-group-empty">Nothing open. Use + for a new agent or tab.</li>}
                {g.items.map((item, i) => row(item, i, id, name, ids))}
              </ul>
              {refused && <div className="chat-drop-note" aria-hidden="true">Tabs stay in their space</div>}
            </li>
          );
        })}
      </ul>
      {ctx.menu}
      <span id="chat-items-move-hint" className="chat-sr">Alt+Up or Alt+Down moves it within its space. Shift+F10 opens its menu.</span>
      <span className="chat-sr" aria-live="polite">{announce}</span>
    </>
  );
}
