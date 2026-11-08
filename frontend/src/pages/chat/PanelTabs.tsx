// The side panel's tabs under the chrome refresh (chat/panelTabs.ts): tabs added with + and closed with ×, each a tool or a
// launcher ("Open a tool", by click or by its number). The strip is hand-rolled
// around LaunchPad's IconButtons because LaunchPad's Tabs have no close button
// on a tab and no way to add one; the tabs that don't fit are in a LaunchPad
// Menu, and the launcher's tiles are LaunchPad Buttons.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, IconButton, Menu, MenuItem, MenuTrigger, Popover, Text, Tooltip, TooltipTrigger } from '@launchpad-ui/components';
import { Icon, type IconName } from '@launchpad-ui/icons';
import { LP_THEME } from '../../launchpad/theme';
import type { SidePanelTab } from '../../chat/sidePanel';
import {
  addLauncher, closePanelTab, fitPanelTabs, initialPanelTabs, openAgentTab, openTool, parsePanelTabs, PANEL_AGENT_TAB_KEY, PANEL_TABS_KEY,
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

const label = (t: PanelTab) => (t.kind === 'launcher' ? 'New tab' : t.kind === 'agent' ? t.agent?.title ?? 'Subagent' : TOOL_LABEL[t.kind]);
// An ask's tab (chat/askStore.ts askTabId) is an agent tab with its own mark. A new
// tab's is a window, not +, which as an icon beside the + button would read as a second one.
const icon = (t: PanelTab): IconName => (t.kind === 'launcher' ? 'application-plus-outline' : t.kind === 'agent' ? (t.agent?.id.startsWith('ask:') ? 'chat-bubble' : 'robot') : TOOL_ICON[t.kind]);

function readKept(): PanelTab[] | null {
  try { return parsePanelTabs(typeof localStorage === 'undefined' ? null : localStorage.getItem(PANEL_TABS_KEY)); } catch { return null; }
}
function keep(tabs: PanelTab[], active?: string): void {
  try {
    localStorage.setItem(PANEL_TABS_KEY, JSON.stringify(tabs));
    if (active && tabs.some(t => t.id === active && t.kind === 'agent')) localStorage.setItem(PANEL_AGENT_TAB_KEY, active);
    else localStorage.removeItem(PANEL_AGENT_TAB_KEY);
  } catch { /* private mode, full storage */ }
}
function keptAgentTab(): string | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(PANEL_AGENT_TAB_KEY); } catch { return null; }
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
): PanelTabsUi {
  // A tab the panel opened with (an agent ask) is kept like one opened later, once it has mounted.
  const keepOnMount = useRef(false);
  const [state, setState] = useState<PanelTabs>(() => {
    const opened = initialPanelTabs(readKept(), tool, enabled ? keptAgentTab() : null, agentChat);
    if (enabled && agentAsk) { keepOnMount.current = true; return openAgentTab(opened, agentAsk.agent); }
    if (!enabled || !ask) return opened;
    const launcherShown = opened.tabs.find(t => t.id === opened.active)?.kind === 'launcher';
    return openTool(opened, ask.tab, launcherShown ? opened.active : undefined);
  });
  const set = (next: PanelTabs) => {
    setState(next);
    keep(next.tabs, next.active);
    const kind = next.tabs.find(t => t.id === next.active)?.kind;
    if (kind && kind !== 'launcher' && kind !== 'agent' && kind !== tool) onTool(kind);
  };
  // Asked for a tool from outside the strip: show its tab, opening one if it has none.
  const asked = useRef(tool);
  useEffect(() => {
    if (!enabled || asked.current === tool) return;
    asked.current = tool;
    if (state.tabs.find(t => t.id === state.active)?.kind === tool) return;
    set(openTool(state, tool));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tool]);
  // An ask that comes while the panel is already open, or while the tabs were off (the
  // phone's overlay) and they have just come on. Answered only once the tabs have shown it.
  const answered = useRef(enabled && ask ? ask.n : 0);
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
    if (keepOnMount.current) { keepOnMount.current = false; keep(state.tabs, state.active); }
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
  const offeredTabs = state.tabs.filter(t => t.kind === 'launcher'
    || (t.kind === 'agent' ? agentChat != null && t.agent?.chat === agentChat : offered.includes(t.kind)));
  const standIn: PanelTab = { id: STAND_IN, kind: 'launcher' };
  const shown = offeredTabs.length > 0 ? offeredTabs : [standIn];
  // The tab on screen, else (another chat's agent tab, hidden here) the tool the panel last showed.
  const active = shown.find(t => t.id === state.active) ?? shown.find(t => t.kind === tool) ?? shown[0];
  return {
    shown,
    active,
    show: id => { if (id !== STAND_IN) set({ ...state, active: id }); },
    pick: kind => set(openTool(state, kind, active.kind === 'launcher' && active.id !== STAND_IN ? active.id : undefined)),
    add: () => set(addLauncher(state)),
    close: id => { if (id !== STAND_IN) set(closePanelTab(state, id, shown.map(t => t.id))); },
    openAgent: agent => set(openAgentTab(state, agent)),
  };
}

/**
 * The strip fits its tabs to the panel's width (fitPanelTabs): labeled while
 * they have room, then every tab but the one on screen as its icon (named by
 * its tooltip, closed by a middle click or once shown), then the ones that
 * still don't fit in an "N more" menu. The tab on screen keeps its label and
 * ×, capped so a subagent's long title can't take the strip.
 */
export function PanelTabStrip({ ui }: { ui: PanelTabsUi }) {
  const strip = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, active: 0 });
  const activeLabel = label(ui.active);
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
  return (
    <div className="chat-side-tabs" role="tablist" aria-label="Tools" ref={strip} data-fit="">
      {ui.shown.filter(t => !fit.hidden.includes(t.id)).map(t => {
        const selected = ui.active?.id === t.id;
        const iconOnly = fit.compact && !selected;
        return (
          <div key={t.id} className="chat-side-tab" data-selected={selected || undefined} data-compact={iconOnly || undefined}>
            <button type="button" role="tab" aria-selected={selected} className="chat-side-tab-main" onClick={() => ui.show(t.id)}
              data-tip={iconOnly || t.kind === 'agent' ? label(t) : undefined}
              onMouseDown={e => { if (e.button === 1) e.preventDefault(); }}
              onAuxClick={e => { if (e.button === 1) ui.close(t.id); }}>
              <Icon name={icon(t)} size="medium" aria-hidden="true" />
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
                  <Icon name={icon(t)} size="medium" aria-hidden="true" />
                  <Text slot="label">{label(t)}</Text>
                </MenuItem>
              ))}
            </Menu>
          </Popover>
        </MenuTrigger>
      )}
      <TooltipTrigger delay={300}>
        <IconButton icon="add" size="small" variant="minimal" className="chat-side-add" aria-label="New tab" onPress={ui.add} />
        <Tooltip placement="bottom" className={LP_THEME}>New tab</Tooltip>
      </TooltipTrigger>
    </div>
  );
}

/** A new tab: pick the tool it becomes, by click or by its number. */
export function ToolLauncher({ tools, context, onPick }: { tools: readonly SidePanelTab[]; context: string; onPick: (tool: SidePanelTab) => void }) {
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
              <span className="chat-launcher-desc">{TOOL_DESC[tool]}</span>
            </span>
            {i < 9 && <kbd className="chat-launcher-key" aria-hidden="true">{i + 1}</kbd>}
          </Button>
        ))}
      </div>
    </div>
  );
}
