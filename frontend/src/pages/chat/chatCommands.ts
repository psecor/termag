// ⌘K's commands in the simple UI under the chrome refresh:
// New session, the open chat's own
// (Open in Lab, Archive session; chat/screenCommands.ts), Open Lab, Review a
// pull request…, the side panel and its tools, How it works, Settings, and the
// sidebar's view options.
// Typing finds them (utils/searchPalette.ts matchActions); the suggested few
// are also listed while nothing is typed, after the recents.
import { useNavigate } from 'react-router-dom';
import { chatHomeSpace } from '../../chat/chatSpaces';
import { CHAT_NARROW_QUERY } from '../../chat/chatLayout';
import { useScreenCommands } from '../../chat/screenCommands';
import { setSidebarView, useSidebarView, type SidebarGroupBy, type SidebarView } from '../../chat/sidebarView';
import type { SidePanelTab } from '../../chat/sidePanel';
import { FLAGS, useFlag } from '../../flags';
import { DOCS_SITE_URL } from '../settings/settingsDocs';
import type { PaletteAction } from '../../utils/searchPalette';
import { useChatChrome } from './chatChrome';
import { TOOL_LABEL } from './PanelTabs';
import { useSimpleDataIfAny } from './simpleData';

/** The side panel's shortcut, as its own button's tooltip names it (chatChrome.tsx). */
const PANEL_KEYS = '⌃⌥B';
const SETTINGS_HREF = '/settings?from=chat';

const TOOL_ICON: Record<SidePanelTab, string> = { files: 'folders', terminal: 'terminal', browser: 'globe', share: 'globe', pr: 'arrow-merge', review: 'preview' };
const TOOL_WORDS: Record<SidePanelTab, string[]> = {
  files: ['explorer', 'space'], terminal: ['shell', 'ctrl', 'console'], browser: ['preview', 'web'], share: ['share'], pr: ['pull request', 'checks', 'review'], review: ['review', 'devin', 'reviewer'],
};

export interface ChatCommandInput {
  navigate: (to: string) => void;
  /** Lab, as the account menu opens it (ChatSidebar's openFullUi). */
  openLab: () => void;
  newSessionKeys: string;
  /** The side panel, where it is on. */
  panel: { open: boolean; toggle: () => void; show?: (tab: SidePanelTab) => void } | null;
  /** The tools it offers beside the open session; none with no session open. */
  tools: readonly SidePanelTab[];
  /** The tabs sidebar's view options, where it has them. */
  view: SidebarView | null;
  setView: (patch: Partial<SidebarView>) => void;
  /** The open screen's own (chat/screenCommands.ts). */
  screen: readonly PaletteAction[];
  /** PR reviews are on (simple-ui-reviews-enabled): Review a pull request… opens the Reviews page. */
  reviews?: boolean;
}


const GROUP_BY_COMMANDS: ReadonlyArray<{ groupBy: SidebarGroupBy; label: string }> = [
  { groupBy: 'space', label: 'Group by space' },
  { groupBy: 'project', label: 'Group by project' },
  { groupBy: 'status', label: 'Group by status' },
];

export function chatCommands({ navigate, openLab, newSessionKeys, panel, tools, view, setView, screen, reviews = false }: ChatCommandInput): PaletteAction[] {
  const out: PaletteAction[] = [
    { id: 'new-session', label: 'New session', icon: 'edit', keys: newSessionKeys, keywords: ['new chat', 'start', 'create'], suggested: true, run: () => navigate('/chat/new') },
    ...screen,
  ];
  // The open chat's Open in Lab takes this one's place: it knows the chat's box.
  if (!screen.some(c => c.id === 'open-in-lab')) {
    out.push({ id: 'open-lab', label: 'Open Lab', icon: 'arrow-up-right', keywords: ['full ui', 'workspace'], suggested: true, run: openLab });
  }
  if (reviews) {
    out.push({
      id: 'review-pr', label: 'Review a pull request…', icon: 'preview', keywords: ['review', 'pull request', 'code review', 'devin', 'reviewer'],
      suggested: true, run: () => navigate('/chat/reviews'),
    });
  }
  if (panel) {
    out.push({
      id: 'tools', label: panel.open ? 'Hide tools' : 'Show tools', icon: panel.open ? 'sidebar-right-collapse' : 'sidebar-right-expand',
      keys: PANEL_KEYS, keywords: ['side panel', 'panel'], suggested: true, run: panel.toggle,
    });
    const show = panel.show;
    if (show) {
      for (const tab of tools) {
        out.push({ id: `tool:${tab}`, label: TOOL_LABEL[tab], detail: 'Tools', icon: TOOL_ICON[tab], keywords: ['tools', ...TOOL_WORDS[tab]], run: () => show(tab) });
      }
    }
  }
  if (DOCS_SITE_URL) {
    out.push({
      id: 'docs', label: 'How it works', icon: 'book-external-link', keywords: ['docs', 'documentation', 'help', 'guide'], suggested: true,
      run: () => { globalThis.open(DOCS_SITE_URL, '_blank', 'noopener,noreferrer'); },
    });
  }
  out.push(
    { id: 'settings', label: 'Settings', icon: 'gear-outline', keywords: ['preferences', 'account'], suggested: true, run: () => navigate(SETTINGS_HREF) },
  );
  if (view) {
    const words = ['view', 'sidebar'];
    out.push(
      view.density === 'compact'
        ? { id: 'view:standard', label: 'Standard rows', detail: 'Sidebar', icon: 'list', keywords: [...words, 'density'], run: () => setView({ density: 'standard' }) }
        : { id: 'view:compact', label: 'Compact rows', detail: 'Sidebar', icon: 'list', keywords: [...words, 'density'], run: () => setView({ density: 'compact' }) },
      // Every grouping but the one shown, in View options' order.
      ...GROUP_BY_COMMANDS.filter(g => g.groupBy !== view.groupBy).map(g => ({
        id: `view:by-${g.groupBy}`, label: g.label, detail: 'Sidebar', icon: 'stack' as const, keywords: words, run: () => setView({ groupBy: g.groupBy }),
      })),
      { id: 'view:files', label: view.showFiles ? 'Hide files and new tabs' : 'Show files and new tabs', detail: 'Sidebar', icon: 'filter', keywords: words, run: () => setView({ showFiles: !view.showFiles }) },
      { id: 'view:idle', label: view.showIdle ? "Hide sessions that aren't running" : "Show sessions that aren't running", detail: 'Sidebar', icon: 'filter', keywords: [...words, 'idle', 'stopped'], run: () => setView({ showIdle: !view.showIdle }) },
    );
  }
  return out;
}

/**
 * The commands for the sidebar's palette, under the refresh only (none
 * otherwise). `activeKey` is the open session's row key, if one is open.
 */
export function useChatCommands({ refresh, openLab, newSessionKeys, activeKey }: {
  refresh: boolean; openLab: () => void; newSessionKeys: string; activeKey: string | null;
}): PaletteAction[] {
  const navigate = useNavigate();
  const { sidePanel } = useChatChrome();
  const data = useSimpleDataIfAny();
  const view = useSidebarView();
  const screen = useScreenCommands();
  const reviews = useFlag(FLAGS.simpleUiReviews, false);
  const activeRow = activeKey ? data?.rows.find(r => r.key === activeKey) : undefined;
  // Each tool as the panel offers it (SidePanel.tsx's offer): Files for a chat in a space,
  // Terminal and Browser beside a session, the Pull request tab on a desktop width.
  const inSpace = activeRow && data ? chatHomeSpace(activeRow, data.spaces.spaces, data.spaces.index) != null : false;
  const narrow = typeof window !== 'undefined' && window.matchMedia?.(CHAT_NARROW_QUERY).matches;
  const tools: SidePanelTab[] = activeRow
    ? [...(inSpace ? ['files' as const] : []), 'terminal', 'browser', ...(narrow ? [] : ['pr' as const])]
    : [];
  // Built on each render, so every command runs the latest render's callbacks (the panel's close over ChatApp's state).
  if (!refresh) return [];
  return chatCommands({
    navigate, openLab, newSessionKeys, panel: sidePanel ?? null, tools, view, setView: setSidebarView, screen, reviews,
  });
}
