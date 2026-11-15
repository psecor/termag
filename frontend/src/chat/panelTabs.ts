// The side panel's tabs under the chrome refresh:
// tabs you add with + and close, each a tool (Files, Terminal, Browser, Share)
// or a launcher that becomes one. Each tool has at most one tab: a second
// Terminal would attach the same ctrl shell in the same tmux window
// (docs/agents/gotchas.md, the side panel's ctrl shell), and a second Browser
// the same browser. An agent tab is one subagent's transcript:
// one per subagent, shown only beside its own
// chat. Kept per browser; pure, for the tests. Under project-files-enabled the tabs can be dragged (or moved
// from a tab's menu) into any order, one order per browser that every place shows its own tabs in; a file
// tab has a place in it once it has been moved (orderPanelTabs), and is last until then.
import type { SidePanelTab } from './sidePanel';

export type PanelTabKind = SidePanelTab | 'launcher' | 'agent' | 'file';
/** The subagent an agent tab shows: its chat (`${projectId}|${workstream}`), its Agent call's id, and what the tab says. */
export interface AgentTabRef { chat: string; id: string; title: string }
/**
 * A file tab (project-files-enabled) is a file open in the panel beside the place, an OpenItem of chat/openItems.ts
 * (openInPanel) whose id it has: the Files tool's Open list is the same tabs. Only its place in the order is kept
 * here, as `{ id, kind: 'file' }`.
 */
export interface PanelTab { id: string; kind: PanelTabKind; agent?: AgentTabRef; file?: { space: string; path: string } }
export interface PanelTabs { tabs: PanelTab[]; active: string }

export const PANEL_TABS_KEY = 'termag.chat.panelTabs';
/**
 * The subagent tab each chat last had on screen, at most one per chat (agentTabsOnScreen): beside that chat the
 * panel shows it again, as it shows the tool the place last showed. A JSON list of tab ids; before chats had their
 * own it was one bare id, still read.
 */
export const PANEL_AGENT_TAB_KEY = 'termag.chat.panelTabs.agent';
const TOOLS: readonly SidePanelTab[] = ['files', 'terminal', 'browser', 'share', 'pr', 'review'];

let counter = 0;
export function panelTabId(): string {
  counter += 1;
  return `t${Date.now().toString(36)}${counter.toString(36)}`;
}

const launcher = (): PanelTab => ({ id: panelTabId(), kind: 'launcher' });
/** A file tab's id, an OpenItem's (chat/openItems.ts). */
const FILE_TAB_ID = /^[a-z0-9]{1,16}$/;

/** The kept tabs: known kinds only, one tab per tool (the first), and none at all is null. */
export function parsePanelTabs(raw: string | null): PanelTab[] | null {
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const seen = new Set<string>();
  const ids = new Set<string>();
  const tabs: PanelTab[] = [];
  for (const t of parsed) {
    if (!t || typeof t !== 'object') continue;
    const { id, kind } = t as { id?: unknown; kind?: unknown };
    if (typeof id !== 'string' || !id || ids.has(id)) continue;
    if (kind === 'file') {
      if (!FILE_TAB_ID.test(id)) continue;
      ids.add(id);
      tabs.push({ id, kind });
      continue;
    }
    if (kind === 'agent') {
      const agent = agentRef((t as { agent?: unknown }).agent);
      if (!agent || tabs.some(x => x.agent && sameAgent(x.agent, agent))) continue;
      ids.add(id);
      tabs.push({ id, kind, agent });
      continue;
    }
    if (kind !== 'launcher' && !TOOLS.includes(kind as SidePanelTab)) continue;
    if (kind !== 'launcher' && seen.has(kind as string)) continue;
    if (kind !== 'launcher') seen.add(kind as string);
    ids.add(id);
    tabs.push({ id, kind: kind as PanelTabKind });
  }
  return tabs.length > 0 ? tabs : null;
}

/** PANEL_AGENT_TAB_KEY's ids: a list of strings, or a bare id as it was kept before each chat had its own. */
export function parseAgentTabs(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return raw.length <= 200 ? [raw] : []; }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200))];
}

/**
 * The subagent tab each chat last had on screen, given `kept` and the panel now: `tabs`, with `active` on screen
 * beside `chat`. That chat's entry becomes `active` if it is one of its subagents' tabs, else goes; another chat's
 * is left alone, so picking a tool beside one chat doesn't lose the subagent another left on screen. A tab
 * closed goes, so there is at most one per chat and only for tabs kept.
 */
export function agentTabsOnScreen(kept: readonly string[], tabs: readonly PanelTab[], active: string | undefined, chat: string | null): string[] {
  const chatOf = (id: string) => tabs.find(t => t.id === id && t.kind === 'agent')?.agent?.chat ?? null;
  const seen = new Set<string>();
  const rest = kept.filter(id => {
    const c = chatOf(id);
    if (c == null || c === chat || seen.has(c)) return false;
    seen.add(c);
    return true;
  });
  return active && chat != null && chatOf(active) === chat ? [active, ...rest] : rest;
}

/** The subagent tab `chat` last had on screen, if it is still among `tabs`. */
export function agentTabOf(kept: readonly string[], tabs: readonly PanelTab[] | null, chat: string | null): string | null {
  if (!chat || !tabs) return null;
  return kept.find(id => tabs.some(t => t.id === id && t.kind === 'agent' && t.agent?.chat === chat)) ?? null;
}

const short = (v: unknown, max: number) => (typeof v === 'string' && v && v.length <= max ? v : null);

/** A kept agent tab's subagent, or null for anything that is not one. */
function agentRef(raw: unknown): AgentTabRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const chat = short(r.chat, 200), id = short(r.id, 120), title = short(r.title, 300);
  return chat && id && title ? { chat, id, title } : null;
}

const sameAgent = (a: AgentTabRef, b: AgentTabRef) => a.chat === b.chat && a.id === b.id;

/**
 * Shows a subagent's transcript: its own tab if it has one, else the launcher
 * on screen becomes it, else a new tab after the one shown.
 */
export function openAgentTab(state: PanelTabs, agent: AgentTabRef): PanelTabs {
  const have = state.tabs.find(t => t.kind === 'agent' && t.agent && sameAgent(t.agent, agent));
  if (have) return { tabs: state.tabs.map(t => (t.id === have.id ? { ...t, agent } : t)), active: have.id };
  const at = state.tabs.findIndex(x => x.id === state.active);
  if (state.tabs[at]?.kind === 'launcher') {
    return { tabs: state.tabs.map((x, i) => (i === at ? { id: x.id, kind: 'agent', agent } : x)), active: state.active };
  }
  const t: PanelTab = { id: panelTabId(), kind: 'agent', agent };
  const tabs = at < 0 ? [...state.tabs, t] : [...state.tabs.slice(0, at + 1), t, ...state.tabs.slice(at + 1)];
  return { tabs, active: t.id };
}

/**
 * Where the panel opens: with nothing kept, on a new tab's launcher (never a tool
 * picked for you); else the kept tabs, on the agent tab it last showed
 * (`agentTab`, a kept tab's id) when that is `agentChat`'s, or on the tool it last
 * showed (given a tab if it has none).
 */
export function initialPanelTabs(kept: PanelTab[] | null, tool: SidePanelTab, agentTab: string | null = null, agentChat: string | null = null): PanelTabs {
  if (!kept || kept.length === 0) {
    const t = launcher();
    return { tabs: [t], active: t.id };
  }
  const tabs = kept;
  if (agentTab && agentChat && tabs.some(t => t.id === agentTab && t.kind === 'agent' && t.agent?.chat === agentChat)) return { tabs, active: agentTab };
  const have = tabs.find(t => t.kind === tool);
  if (have) return { tabs, active: have.id };
  const t = { id: panelTabId(), kind: tool };
  return { tabs: [...tabs, t], active: t.id };
}

/**
 * Shows `tool`: its own tab if it has one (a launcher it was picked from
 * goes), else the launcher it was picked from becomes it, else a new tab.
 */
export function openTool(state: PanelTabs, tool: SidePanelTab, from?: string): PanelTabs {
  const have = state.tabs.find(t => t.kind === tool);
  const fromLauncher = from ? state.tabs.find(t => t.id === from && t.kind === 'launcher') : undefined;
  if (have) {
    return { tabs: fromLauncher ? state.tabs.filter(t => t.id !== fromLauncher.id) : state.tabs, active: have.id };
  }
  if (fromLauncher) {
    return { tabs: state.tabs.map(t => (t.id === fromLauncher.id ? { ...t, kind: tool } : t)), active: fromLauncher.id };
  }
  const t = { id: panelTabId(), kind: tool };
  return { tabs: [...state.tabs, t], active: t.id };
}

/**
 * Puts `shown`, the tabs this place shows in order, in `order` (their ids, rearranged), in the places they hold in the
 * list. The tabs it hides (another chat's subagents, another place's files, a tool not offered here) keep their
 * places, so each place's tabs keep the order they had. A file tab shown that has no place in the list yet gets one,
 * kept as its id alone. Returns `tabs` itself when nothing moves.
 */
export function orderPanelTabs(tabs: readonly PanelTab[], shown: readonly PanelTab[], order: readonly string[]): readonly PanelTab[] {
  const ids = shown.map(t => t.id);
  if (order.length !== ids.length || order.some(x => !ids.includes(x)) || new Set(order).size !== order.length || order.every((x, i) => x === ids[i])) return tabs;
  const kept = (t: PanelTab): PanelTab => (t.kind === 'file' ? { id: t.id, kind: 'file' } : t);
  const have = new Set(tabs.map(t => t.id));
  const all = [...tabs, ...shown.filter(t => !have.has(t.id))].map(kept);
  const members = new Set(ids);
  const byId = new Map(all.map(t => [t.id, t]));
  let n = 0;
  return all.map(t => (members.has(t.id) ? byId.get(order[n++])! : t));
}

/**
 * The tabs in the order this place shows them: the kept ones it offers (`offered`, which says for each tool,
 * launcher or subagent tab), its file tabs (`files`, this place's, in the Open list's order) where the list has
 * them, and the rest of its file tabs last, so a new one opens at the end.
 */
export function placeTabs(tabs: readonly PanelTab[], offered: (t: PanelTab) => boolean, files: readonly PanelTab[]): PanelTab[] {
  const byId = new Map(files.map(t => [t.id, t]));
  const out: PanelTab[] = [];
  for (const t of tabs) {
    if (t.kind === 'file') { const f = byId.get(t.id); if (f) out.push(f); } else if (offered(t)) out.push(t);
  }
  const placed = new Set(out.map(t => t.id));
  return [...out, ...files.filter(t => !placed.has(t.id))];
}

/** + : a new launcher, shown. */
export function addLauncher(state: PanelTabs): PanelTabs {
  const t = launcher();
  return { tabs: [...state.tabs, t], active: t.id };
}

/**
 * The strip's sizes, in px (pages/chat/chrome.css keeps them): a tab with its
 * label at its narrowest, a tab that is only its icon, the gap between tabs,
 * and the + and "N more" buttons.
 */
export const PANEL_TAB_SIZES = { labeled: 96, icon: 32, gap: 2, add: 28, more: 44 } as const;

/** How the strip fits its tabs: `compact` shows every tab but the one on screen as its icon; `hidden` go in the "N more" menu. */
export interface PanelTabFit { compact: boolean; hidden: string[] }

/**
 * Fits `ids` (the tabs shown, in order) in a strip `width` px wide, the tab on
 * screen (`active`, `activeWidth` px: it never shrinks, chrome.css caps it)
 * always among them. Labeled while every other tab has room for its label,
 * else icons, else as many icons as fit, from the left, and the rest in the
 * menu. Unmeasured (a width of 0, as in a test) is labeled, with none hidden.
 */
export function fitPanelTabs(ids: readonly string[], active: string, width: number, activeWidth: number): PanelTabFit {
  const { labeled, icon, gap, add, more } = PANEL_TAB_SIZES;
  const others = ids.filter(id => id !== active);
  const room = width - add - gap - (ids.includes(active) ? activeWidth + gap : 0);
  if (width <= 0 || others.length * (labeled + gap) <= room) return { compact: false, hidden: [] };
  if (others.length * (icon + gap) <= room) return { compact: true, hidden: [] };
  const fits = Math.max(0, Math.floor((room - more - gap) / (icon + gap)));
  return { compact: true, hidden: others.slice(fits) };
}

/**
 * Closes a tab. The one shown goes to its right-hand neighbour among `shown`
 * (the tabs this context offers), else its left. Closing the last tab shown
 * leaves a launcher, shown, even when tabs this context hides remain.
 */
export function closePanelTab(state: PanelTabs, id: string, shown: readonly string[]): PanelTabs {
  const rest = state.tabs.filter(t => t.id !== id);
  if (!shown.some(s => s !== id && rest.some(t => t.id === s))) {
    const t = launcher();
    return { tabs: [...rest, t], active: t.id };
  }
  if (state.active !== id) return { tabs: rest, active: state.active };
  const at = shown.indexOf(id);
  const next = shown[at + 1] ?? shown[at - 1] ?? rest[0].id;
  return { tabs: rest, active: rest.some(t => t.id === next) ? next : rest[0].id };
}
