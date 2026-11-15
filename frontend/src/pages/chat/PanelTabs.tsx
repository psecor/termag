// The side panel's tabs under the chrome refresh (chat/panelTabs.ts): tabs added with + and closed with ×, each a tool or a
// launcher ("Open a tool", by click or by its number). The strip is hand-rolled
// around LaunchPad's IconButtons because LaunchPad's Tabs have no close button
// on a tab and no way to add one; the tabs that don't fit are in a LaunchPad
// Menu, and the launcher's tiles are LaunchPad Buttons. Under project-files-enabled the files open in
// the panel are tabs too (file tabs, chat/openItems.ts openInPanel): after the tools, each named by
// its file and marked with where it lives, its × floating over its right end on hover.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, IconButton, Menu, MenuItem, MenuTrigger, Popover, Text, Tooltip, TooltipTrigger } from '@launchpad-ui/components';
import { Icon, type IconName } from '@launchpad-ui/icons';
import { FLAGS, useFlag } from '../../flags';
import { isMenuKey } from './ContextMenu';
import { LP_THEME } from '../../launchpad/theme';
import type { SidePanelTab } from '../../chat/sidePanel';
import {
  addLauncher, agentTabOf, agentTabsOnScreen, closePanelTab, fitPanelTabs, initialPanelTabs, openAgentTab, openTool, orderPanelTabs, parseAgentTabs, parsePanelTabs, placeTabs,
  PANEL_AGENT_TAB_KEY, PANEL_TABS_KEY,
  type AgentTabRef, type PanelTab, type PanelTabs,
} from '../../chat/panelTabs';

export const TOOL_LABEL: Record<SidePanelTab, string> = { files: 'Files', terminal: 'Terminal', browser: 'Browser', share: 'Share', pr: 'Pull request', review: 'Review' };
const TOOL_ICON: Record<SidePanelTab, IconName> = { files: 'folders', terminal: 'terminal', browser: 'globe', share: 'share', pr: 'arrow-merge', review: 'preview' };
const TOOL_DESC: Record<SidePanelTab, string> = {
  files: "The space's agents and files",
  terminal: "A shell on the session's box",
  browser: 'What the session serves, in a browser',
  share: 'A link a reviewer can open',
  pr: 'Its checks, gates, review and merge',
  review: 'A reviewer reading a PR: Devin, Claude or Cursor',
};

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path;
const label = (t: PanelTab) => (t.kind === 'launcher' ? 'New tab' : t.kind === 'agent' ? t.agent?.title ?? 'Subagent'
  : t.kind === 'file' ? fileName(t.file?.path ?? '') : TOOL_LABEL[t.kind]);
// An ask's tab (chat/askStore.ts askTabId) is an agent tab with its own mark. A new
// tab's is a window, not +, which as an icon beside the + button would read as a second one.
const icon = (t: PanelTab): IconName => (t.kind === 'launcher' ? 'application-plus-outline' : t.kind === 'agent' ? (t.agent?.id.startsWith('ask:') ? 'chat-bubble' : 'robot')
  : t.kind === 'file' ? 'file' : TOOL_ICON[t.kind]);

function readKept(): PanelTab[] | null {
  try { return parsePanelTabs(typeof localStorage === 'undefined' ? null : localStorage.getItem(PANEL_TABS_KEY)); } catch { return null; }
}
/** Keeps the tabs, and for `chat` the subagent tab on screen beside it, if `active` is one (agentTabsOnScreen). */
function keep(tabs: PanelTab[], active: string | undefined, chat: string | null): void {
  try {
    localStorage.setItem(PANEL_TABS_KEY, JSON.stringify(tabs));
    localStorage.setItem(PANEL_AGENT_TAB_KEY, JSON.stringify(agentTabsOnScreen(keptAgentTabs(), tabs, active, chat)));
  } catch { /* private mode, full storage */ }
}
function keptAgentTabs(): string[] {
  try { return parseAgentTabs(typeof localStorage === 'undefined' ? null : localStorage.getItem(PANEL_AGENT_TAB_KEY)); } catch { return []; }
}

export interface ToolAsk { tab: SidePanelTab; n: number }

/**
 * ChatApp's asks for a panel tool (a share link's Browser, a breadcrumb's Files, the
 * context card's Pull request), each with a number that never repeats, so an ask
 * after one that was forgotten is never mistaken for it.
 */
export function useToolAsk(): { ask: ToolAsk | null; askTool: (tab: SidePanelTab) => void; forget: () => void } {
  const [ask, setAsk] = useState<ToolAsk | null>(null);
  const counter = useRef(0);
  const askTool = useCallback((tab: SidePanelTab) => { counter.current += 1; setAsk({ tab, n: counter.current }); }, []);
  const forget = useCallback(() => setAsk(null), []);
  return { ask, askTool, forget };
}

export interface AgentAsk { agent: AgentTabRef; n: number }

/** ChatApp's asks for a subagent's agent tab (a row in the chat), numbered as tool asks are. */
export function useAgentAsk(): { ask: AgentAsk | null; askAgent: (agent: AgentTabRef) => void; forget: () => void } {
  const [ask, setAsk] = useState<AgentAsk | null>(null);
  const counter = useRef(0);
  const askAgent = useCallback((agent: AgentTabRef) => { counter.current += 1; setAsk({ agent, n: counter.current }); }, []);
  const forget = useCallback(() => setAsk(null), []);
  return { ask, askAgent, forget };
}

export interface PanelTabsUi {
  /** The tabs this context offers (a tool it can't show, such as Files with no space, is hidden, not closed). */
  shown: PanelTab[];
  active: PanelTab;
  show: (id: string) => void;
  pick: (tool: SidePanelTab) => void;
  add: () => void;
  close: (id: string) => void;
  /** Opens and shows a subagent's tab (openAgentTab). */
  openAgent: (agent: AgentTabRef) => void;
  /** A file tab's mark (where its file lives), tooltip and menu actions (Open in main panel), from SidePanel. */
  fileTab?: PanelFiles['decor'];
  /** Puts the tabs shown in `order` (their ids, rearranged); absent where the tabs don't move. */
  move?: (order: readonly string[]) => void;
}

/**
 * The file tabs (project-files-enabled), from SidePanel: this place's files open in the panel, in order; the one on
 * screen over the tool, if one; showing one (or none: the tool again); closing one; and how each one's tab looks.
 */
export interface PanelFiles {
  tabs: readonly PanelTab[];
  shown: string | null;
  onShow: (id: string | null) => void;
  close: (id: string) => void;
  decor?: (t: PanelTab) => { icon: React.ReactNode; tip: string; actions?: Array<{ id: string; label: string; onAction: () => void }> };
  /** Every file tab open in any place (their order is kept only while they are). */
  known?: ReadonlySet<string>;
  /** This place's file tabs in the strip's new order, for the Open list to follow. */
  arrange?: (order: readonly string[]) => void;
}

/**
 * A new tab's launcher, shown but never kept, when none of the tabs is one this
 * context offers (Files beside a session with no space, a session tool beside a
 * file, Files while the spaces load): the panel never picks a tool for you.
 */
const STAND_IN = '\u0000stand-in';

/**
 * The tabs, given the tools offered here and the tool the panel's state names
 * (SidePanelState.tab, as kept). `onTool` keeps that state on the tool shown, so
 * the rest of the app (a share link opening Browser, a pick opening Files) still
 * speaks in tools, and asking for one from outside shows or opens its tab.
 */
export function usePanelTabs(
  enabled: boolean,
  offered: readonly SidePanelTab[],
  tool: SidePanelTab,
  onTool: (tool: SidePanelTab) => void,
  /** A tool asked for from outside (ChatApp's toolAsk): opened, even on a panel that would open on a launcher. */
  ask?: { tab: SidePanelTab; n: number } | null,
  /** The ask has been shown: the asker forgets it, so a remount doesn't show it again. */
  onAskUsed?: () => void,
  /** The chat beside the panel (`${projectId}|${workstream}`), whose agent tabs it offers; null offers none. */
  agentChat: string | null = null,
  /** A subagent's tab asked for from the chat (ChatApp's agentAsk): opened and shown. */
  agentAsk?: AgentAsk | null,
  onAgentAskUsed?: () => void,
  /** The tool was carried here by a pick in the panel's own explorer (ChatApp's carry): it stays on screen. */
  carried = false,
  /** The file tabs, after the rest; none with project-files-enabled off. */
  files?: PanelFiles,
): PanelTabsUi {
  // A tab the panel opened with (an agent ask) is kept like one opened later, once it has mounted.
  const keepOnMount = useRef(false);
  const [state, setState] = useState<PanelTabs>(() => {
    const kept = readKept();
    const opened = initialPanelTabs(kept, tool, enabled ? agentTabOf(keptAgentTabs(), kept, agentChat) : null, agentChat);
    if (enabled && agentAsk) { keepOnMount.current = true; return openAgentTab(opened, agentAsk.agent); }
    if (!enabled || !ask) return opened;
    const launcherShown = opened.tabs.find(t => t.id === opened.active)?.kind === 'launcher';
    return openTool(opened, ask.tab, launcherShown ? opened.active : undefined);
  });
  const set = (raw: PanelTabs) => {
    // A closed file's place in the order goes with it; none is dropped before the open files are read.
    const known = files?.known;
    const next = known && known.size > 0 && raw.tabs.some(t => t.kind === 'file' && !known.has(t.id))
      ? { ...raw, tabs: raw.tabs.filter(t => t.kind !== 'file' || known.has(t.id)) } : raw;
    setState(next);
    keep(next.tabs, next.active, agentChat);
    const kind = next.tabs.find(t => t.id === next.active)?.kind;
    if (kind && kind !== 'launcher' && kind !== 'agent' && kind !== 'file' && kind !== tool) onTool(kind);
  };
  // The person picked a tab that isn't a file's: it shows, and the file tab on screen, if one, gives way to it. A new
  // tool's onTool says both (SidePanel's clears the file).
  const act = (next: PanelTabs) => {
    const kind = next.tabs.find(t => t.id === next.active)?.kind;
    set(next);
    if (files?.shown && !(kind && kind !== 'launcher' && kind !== 'agent' && kind !== 'file' && kind !== tool)) files.onShow(null);
  };
  // Asked for a tool from outside the strip, or moved to a place that last showed another
  // (each place keeps its own, chat/sidePanel.ts): show its tab, opening one if it has none.
  // Moved beside a chat that had a subagent's tab on screen when the panel left it: that tab
  // again (each chat keeps its own, agentTabsOnScreen), whatever was picked beside another,
  // unless the move brought a tool with it (an explorer pick's Files, an ask not yet shown):
  // then that tool, which is this chat's tab from now on.
  const asked = useRef(tool);
  const chatSeen = useRef(agentChat);
  const answered = useRef(enabled && ask ? ask.n : 0);
  useEffect(() => {
    const moved = chatSeen.current !== agentChat;
    chatSeen.current = agentChat;
    if (!enabled) return;
    const toolChanged = asked.current !== tool;
    asked.current = tool;
    if (!moved && !toolChanged) return;
    const brought = carried || (ask != null && ask.n !== answered.current);
    const back = moved && !brought ? agentTabOf(keptAgentTabs(), state.tabs, agentChat) : null;
    if (back) {
      if (back !== state.active) set({ ...state, active: back });
      return;
    }
    if (state.tabs.find(t => t.id === state.active)?.kind === tool) {
      if (moved) keep(state.tabs, state.active, agentChat);
      return;
    }
    set(openTool(state, tool));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tool, agentChat]);
  // An ask that comes while the panel is already open, or while the tabs were off (the
  // phone's overlay) and they have just come on. Answered only once the tabs have shown it.
  useEffect(() => {
    if (!enabled || !ask || ask.n === answered.current) return;
    answered.current = ask.n;
    const shownKind = state.tabs.find(t => t.id === state.active)?.kind;
    if (shownKind === ask.tab) return;
    // A launcher on screen becomes the tool asked for, as if picked from it.
    set(openTool(state, ask.tab, shownKind === 'launcher' ? state.active : undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ask?.n]);
  useEffect(() => {
    if (enabled && ask && answered.current === ask.n) onAskUsed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ask?.n]);
  useEffect(() => {
    if (keepOnMount.current) { keepOnMount.current = false; keep(state.tabs, state.active, agentChat); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // An agent ask: its tab opened and shown, once the tabs are on.
  const agentAnswered = useRef(enabled && agentAsk ? agentAsk.n : 0);
  useEffect(() => {
    if (!enabled || !agentAsk || agentAsk.n === agentAnswered.current) return;
    agentAnswered.current = agentAsk.n;
    set(openAgentTab(state, agentAsk.agent));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, agentAsk?.n]);
  useEffect(() => {
    if (enabled && agentAsk && agentAnswered.current === agentAsk.n) onAgentAskUsed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, agentAsk?.n]);
  const offers = (t: PanelTab) => t.kind === 'launcher'
    || (t.kind === 'agent' ? agentChat != null && t.agent?.chat === agentChat : t.kind !== 'file' && offered.includes(t.kind));
  const offeredTabs = state.tabs.filter(offers);
  const standIn: PanelTab = { id: STAND_IN, kind: 'launcher' };
  const fileTabs = enabled ? files?.tabs ?? [] : [];
  const isFile = (id: string | undefined) => id != null && fileTabs.some(t => t.id === id);
  // In the kept order (orderPanelTabs), this place's file tabs among the rest, a new one last.
  const placed = placeTabs(state.tabs, offers, fileTabs);
  const shown = placed.length > 0 ? placed : [standIn];
  // The file tab on screen; else the tab on screen, else (another chat's agent tab, hidden here) the tool the panel last showed.
  const under = offeredTabs.find(t => t.id === state.active) ?? offeredTabs.find(t => t.kind === tool);
  const active = fileTabs.find(t => t.id === files?.shown) ?? under ?? shown[0];
  return {
    shown,
    active,
    show: id => {
      if (id === STAND_IN) return;
      if (isFile(id)) files?.onShow(id);
      else act({ ...state, active: id });
    },
    pick: kind => act(openTool(state, kind, active.kind === 'launcher' && active.id !== STAND_IN ? active.id : undefined)),
    add: () => act(addLauncher(state)),
    close: id => {
      if (id === STAND_IN) return;
      const ids = shown.map(t => t.id);
      const at = ids.indexOf(id);
      // Closing the tab on screen shows its right-hand neighbour, else its left, as for any tab.
      const next = active.id === id ? ids[at + 1] ?? ids[at - 1] : undefined;
      if (isFile(id)) {
        files?.close(id);
        // Its place in the order goes too.
        const left = state.tabs.some(t => t.id === id) ? { ...state, tabs: state.tabs.filter(t => t.id !== id) } : state;
        if (active.id !== id) { if (left !== state) set(left); return; }
        if (isFile(next)) { if (left !== state) set(left); files?.onShow(next!); } else if (next) act({ ...left, active: next });
        else act(addLauncher(left));
        return;
      }
      const rest = closePanelTab(state, id, ids.filter(x => !isFile(x)));
      if (isFile(next)) { set(rest); files?.onShow(next!); return; }
      // A tab closed behind the file on screen leaves the file there, even when that was the tool under it.
      if (files?.shown && active.id !== id) { set(rest); files.onShow(files.shown); } else act(rest);
    },
    openAgent: agent => act(openAgentTab(state, agent)),
    fileTab: files?.decor,
    // Dragged, or moved from a tab's menu (project-files-enabled): one order for every place, kept here; the Open
    // list's file tabs follow it.
    move: files ? order => {
      const tabs = orderPanelTabs(state.tabs, placed, order);
      if (tabs === state.tabs) return;
      set({ ...state, tabs: [...tabs] });
      files.arrange?.(placeTabs(tabs, offers, fileTabs).filter(t => t.kind === 'file').map(t => t.id));
    } : undefined,
  };
}

/**
 * The strip fits its tabs to the panel's width (fitPanelTabs): labeled while
 * they have room, then every tab but the one on screen as its icon (named by
 * its tooltip, closed by a middle click or once shown), then the ones that
 * still don't fit in an "N more" menu. The tab on screen keeps its label and
 * ×, capped so a subagent's long title can't take the strip.
 */
/** What a dragged panel tab carries (its id), so a drop takes only the strip's own tabs. */
const DRAG_TYPE = 'application/x-termag-panel-tab';
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

export function PanelTabStrip({ ui }: { ui: PanelTabsUi }) {
  const strip = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, active: 0 });
  const activeLabel = label(ui.active);
  // Reordering (project-files-enabled, ui.move). LaunchPad's Tabs (React Aria's) take no drag and drop, and React Aria's
  // useDrag would start a keyboard drag on Enter, which here shows a tab; React Aria isn't one of termag's own
  // dependencies either (it is LaunchPad's). So a pointer drags a tab with the browser's drag and drop, with a drop
  // line where it will land, and the keyboard moves it from the tab's menu (Move left, Move right: Shift+F10 or the
  // menu key), a LaunchPad Menu. A move slides the tabs to their places, unless motion is reduced.
  const tabEls = useRef(new Map<string, HTMLElement>());
  const [drag, setDrag] = useState<{ id: string; before: string | null; x: number | null } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const [said, setSaid] = useState('');
  const flip = useRef<Map<string, number> | null>(null);
  // A move is of the strip as it looks: the tabs on it in their new order, then those in "N more" as they were, so
  // the moved tab stays on the strip (fitPanelTabs keeps the first ones).
  const moveTab = (onStrip: readonly string[], moved: string) => {
    if (!ui.move) return;
    const was = new Map<string, number>();
    for (const [k, el] of tabEls.current) if (el.isConnected) was.set(k, el.getBoundingClientRect().left);
    flip.current = was;
    ui.move([...onStrip, ...hidden.map(t => t.id)]);
    const t = ui.shown.find(x => x.id === moved);
    if (t) setSaid(`Moved ${label(t)} to ${onStrip.indexOf(moved) + 1} of ${onStrip.length}`);
  };
  // After a move: each tab starts where it was and slides to its new place.
  useLayoutEffect(() => {
    const was = flip.current;
    if (!was) return;
    flip.current = null;
    if (reducedMotion()) return;
    for (const [k, el] of tabEls.current) {
      const from = was.get(k);
      const dx = from == null ? 0 : from - el.getBoundingClientRect().left;
      if (dx && typeof el.animate === 'function') el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 160, easing: 'ease-out' });
    }
  });
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const shown = el.querySelector<HTMLElement>('.chat-side-tab[data-selected]');
    const measure = () => {
      const width = el.clientWidth;
      const active = shown?.offsetWidth ?? 0;
      setSize(s => (s.width === width && s.active === active ? s : { width, active }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    // The panel's width, and the shown tab's (its label, once the UI font has loaded).
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (shown) ro.observe(shown);
    return () => ro.disconnect();
  }, [ui.active.id, activeLabel]);
  const fit = fitPanelTabs(ui.shown.map(t => t.id), ui.active.id, size.width, size.active);
  const hidden = ui.shown.filter(t => fit.hidden.includes(t.id));
  const visible = ui.shown.filter(t => !fit.hidden.includes(t.id));
  // A tab's menu wherever tabs move (its file actions need no other tab), dragging where the strip has two to order.
  const menuOn = ui.move != null && ui.shown.every(t => t.id !== STAND_IN);
  const movable = menuOn && visible.length > 1;
  // Where a drag over the strip would put the tab: before the first tab whose middle is right of the pointer, else
  // last, among the tabs on the strip; and where its line goes. None where the drop would leave it where it is.
  const dropAt = (clientX: number, id: string): { before: string | null; x: number | null } => {
    const box = strip.current?.getBoundingClientRect();
    const rects = visible.map(t => ({ id: t.id, r: tabEls.current.get(t.id)?.getBoundingClientRect() })).filter(x => x.r) as Array<{ id: string; r: DOMRect }>;
    const next = rects.find(x => x.r.left + x.r.width / 2 > clientX);
    const before = next?.id ?? null;
    const ids = visible.map(t => t.id);
    const from = ids.indexOf(id);
    const to = before == null ? ids.length : ids.indexOf(before);
    if (!box || from < 0 || to === from || to === from + 1) return { before, x: null };
    const edge = next ? next.r.left - 1 : (rects[rects.length - 1]?.r.right ?? box.left) + 1;
    // Never at or past the strip's own edges, which clip it.
    return { before, x: Math.min(box.width - 1, Math.max(1, edge - box.left)) };
  };
  const menuTab = menuFor ? visible.find(t => t.id === menuFor) : undefined;
  // Moves from the menu step among the tabs on the strip: a swap with the tab on its left or right.
  const menuAt = menuTab ? visible.indexOf(menuTab) : -1;
  const swapped = (a: number, b: number) => {
    const ids = visible.map(t => t.id);
    [ids[a], ids[b]] = [ids[b], ids[a]];
    return ids;
  };
  const openMenu = (id: string, el: HTMLElement) => { menuAnchor.current = el; setMenuFor(id); };
  return (
    <div className="chat-side-tabs" role="tablist" aria-label="Tools" ref={strip} data-fit="" data-dragging={drag ? '' : undefined}
      onDragOver={e => {
        if (!drag || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const at = dropAt(e.clientX, drag.id);
        if (at.before !== drag.before || at.x !== drag.x) setDrag({ ...drag, ...at });
      }}
      onDragLeave={e => { if (drag && !strip.current?.contains(e.relatedTarget as Node | null)) setDrag({ ...drag, x: null }); }}
      onDrop={e => {
        if (!drag || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        const at = dropAt(e.clientX, drag.id);
        setDrag(null);
        if (at.x != null) {
          const ids = visible.map(t => t.id).filter(x => x !== drag.id);
          ids.splice(at.before == null ? ids.length : ids.indexOf(at.before), 0, drag.id);
          moveTab(ids, drag.id);
        }
      }}>
      {visible.map(t => {
        const selected = ui.active?.id === t.id;
        const iconOnly = fit.compact && !selected;
        const file = t.kind === 'file' ? ui.fileTab?.(t) : undefined;
        return (
          <div key={t.id} className="chat-side-tab" data-selected={selected || undefined} data-compact={iconOnly || undefined} data-file={t.kind === 'file' || undefined}
            data-dragged={drag?.id === t.id || undefined}
            ref={el => { if (el) tabEls.current.set(t.id, el); else tabEls.current.delete(t.id); }}
            draggable={movable || undefined}
            onDragStart={movable ? e => {
              e.dataTransfer.setData(DRAG_TYPE, t.id);
              e.dataTransfer.setData('text/plain', label(t));
              e.dataTransfer.effectAllowed = 'move';
              setDrag({ id: t.id, before: null, x: null });
            } : undefined}
            onDragEnd={movable ? () => setDrag(null) : undefined}>
            <button type="button" role="tab" aria-selected={selected} className="chat-side-tab-main" onClick={() => ui.show(t.id)}
              data-tip={file ? file.tip : iconOnly || t.kind === 'agent' ? label(t) : undefined}
              aria-haspopup={menuOn ? 'menu' : undefined}
              onContextMenu={menuOn ? e => { e.preventDefault(); openMenu(t.id, e.currentTarget); } : undefined}
              onKeyDown={menuOn ? e => { if (isMenuKey(e)) { e.preventDefault(); openMenu(t.id, e.currentTarget); } } : undefined}
              onMouseDown={e => { if (e.button === 1) e.preventDefault(); }}
              onAuxClick={e => { if (e.button === 1) ui.close(t.id); }}>
              {file ? <span className="chat-side-tab-mark" aria-hidden="true">{file.icon}</span> : <Icon name={icon(t)} size="medium" aria-hidden="true" />}
              <span className="chat-side-tab-label">{label(t)}</span>
            </button>
            {!iconOnly && (
              <IconButton icon="cancel" size="small" variant="minimal" className="chat-side-tab-close" aria-label={`Close ${label(t)}`}
                onPress={() => ui.close(t.id)} />
            )}
          </div>
        );
      })}
      {hidden.length > 0 && (
        <MenuTrigger>
          <Button variant="minimal" className="chat-side-more" aria-label={`${hidden.length} more tabs`}>
            <span aria-hidden="true">{hidden.length}</span>
            <Icon name="chevron-down" size="medium" aria-hidden="true" />
          </Button>
          <Popover placement="bottom end" className={`${LP_THEME} chat-menu-popover chat-side-more-menu`}>
            <Menu aria-label="More tabs" onAction={key => ui.show(String(key))}>
              {hidden.map(t => (
                <MenuItem key={t.id} id={t.id} textValue={label(t)}>
                  {t.kind === 'file' && ui.fileTab ? <span className="chat-side-tab-mark" aria-hidden="true">{ui.fileTab(t).icon}</span> : <Icon name={icon(t)} size="medium" aria-hidden="true" />}
                  <Text slot="label">{label(t)}</Text>
                </MenuItem>
              ))}
            </Menu>
          </Popover>
        </MenuTrigger>
      )}
      {drag?.x != null && <span className="chat-side-drop" style={{ left: drag.x }} aria-hidden="true" />}
      {menuTab && (
        <Popover triggerRef={menuAnchor} isOpen onOpenChange={o => { if (!o) setMenuFor(null); }} placement="bottom start"
          className={`${LP_THEME} chat-menu-popover chat-side-tab-menu`}>
          <Menu aria-label={`${label(menuTab)}: actions`} autoFocus="first" onAction={key => {
            const id = menuTab.id;
            setMenuFor(null);
            if (key === 'left' && menuAt > 0) moveTab(swapped(menuAt - 1, menuAt), id);
            else if (key === 'right' && menuAt >= 0 && menuAt < visible.length - 1) moveTab(swapped(menuAt, menuAt + 1), id);
            else if (key === 'close') ui.close(id);
            else ui.fileTab?.(menuTab).actions?.find(a => a.id === key)?.onAction();
          }}>
            <MenuItem id="left" isDisabled={menuAt <= 0}>Move left</MenuItem>
            <MenuItem id="right" isDisabled={menuAt >= visible.length - 1}>Move right</MenuItem>
            {menuTab.kind === 'file' && ui.fileTab?.(menuTab).actions?.map(a => <MenuItem key={a.id} id={a.id}>{a.label}</MenuItem>)}
            <MenuItem id="close">Close</MenuItem>
          </Menu>
        </Popover>
      )}
      <span className="chat-sr" role="status" aria-live="polite">{said}</span>
      <TooltipTrigger delay={300}>
        <IconButton icon="add" size="small" variant="minimal" className="chat-side-add" aria-label="New tab" onPress={ui.add} />
        <Tooltip placement="bottom" className={LP_THEME}>New tab</Tooltip>
      </TooltipTrigger>
    </div>
  );
}

/** A new tab: pick the tool it becomes, by click or by its number. */
export function ToolLauncher({ tools, context, onPick }: { tools: readonly SidePanelTab[]; context: string; onPick: (tool: SidePanelTab) => void }) {
  // Under project-files-enabled Files is Project files | My files (FilesTool.tsx), and the chat never says "space".
  const projectFilesFlag = useFlag(FLAGS.projectFiles, false);
  const userProjectsFlag = useFlag(FLAGS.userProjects, false);
  const projectFiles = projectFilesFlag && userProjectsFlag;
  return (
    <div className="chat-launcher" onKeyDown={e => {
      const n = Number(e.key);
      const tool = Number.isInteger(n) && n >= 1 && n <= 9 ? tools[n - 1] : undefined;
      if (!tool || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      onPick(tool);
    }}>
      <div className="chat-launcher-head">
        <span className="chat-launcher-title">Open a tool</span>
        {context && <span className="chat-launcher-sub">{context}</span>}
      </div>
      <div className="chat-launcher-grid">
        {tools.length === 0 && <span className="chat-launcher-sub">No tools here yet.</span>}
        {tools.map((tool, i) => (
          <Button key={tool} variant="minimal" className="chat-launcher-tile" onPress={() => onPick(tool)} autoFocus={i === 0}
            aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}>
            <span className="chat-launcher-icon" data-kind={tool} aria-hidden="true"><Icon name={TOOL_ICON[tool]} size="medium" /></span>
            <span className="chat-launcher-text">
              <span className="chat-launcher-name">{TOOL_LABEL[tool]}</span>
              <span className="chat-launcher-desc">{tool === 'files' && projectFiles ? 'Project files and My files' : TOOL_DESC[tool]}</span>
            </span>
            {i < 9 && <kbd className="chat-launcher-key" aria-hidden="true">{i + 1}</kbd>}
          </Button>
        ))}
      </div>
    </div>
  );
}
