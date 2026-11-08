// The simple UI's side panel (chat/sidePanel.ts): the open conversation's
// ctrl terminal and browser pane, the workspace's own components, in a
// column beside the chat. Only the shown tab is mounted, so the terminal
// socket opens when Terminal is showing and closes when the panel shuts or
// switches to Browser (tmux keeps the shell); the browser parks on the box
// the same way the workspace dock's does, and Share is the dock's "Share…",
// for the session's owner (ShareTab.tsx). Where the user has spaces, Files
// is the space's explorer (FileExplorer.tsx): the agent's space beside an
// agent (none for an agent with no space), the file's beside a file, the
// new tab's on a new tab. Picking in it shows the pick in the main pane.
// Beside an agent with no space, and on a new tab on the agents in no space,
// the tab is Agents instead: the explorer of agents only (AgentsExplorer.tsx).
// As a phone's overlay, the panel follows the visual viewport (the keyboard,
// hooks/useVisualViewport.ts) and its Terminal has a key bar (TerminalKeyBar.tsx).
import React, { useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useSetupContext } from '../../hooks/useSetupContext';
import { Terminal } from '../../components/Terminal';
import { useVisualViewport } from '../../hooks/useVisualViewport';
import { PhoneTerminal } from './TerminalKeyBar';
import { BrowserPane } from '../../components/BrowserPane';
import { useRememberedBrowserUrl } from '../../components/BrowserDock';
import type { BrowserShareHandoff } from '../../utils/browserPaneConnection';
import { cloneTile } from '../../utils/cloneTile';
import { sessionName } from '../../utils/sessionName';
import { FLAGS, useFlag } from '../../flags';
import type { Project } from '../../types';
import { chatHomeSpace } from '../../chat/chatSpaces';
import { NO_SPACE_EXPLORER } from '../../chat/openItems';
import { boxesKnown } from '../../chat/noSpaceAgents';
import {
  clampSidePanelWidth,
  dockedSidePanelWidth,
  shownSidePanelTab,
  sidePanelTabs,
  sidePanelBody,
  type SidePanelState,
  type SidePanelTab,
} from '../../chat/sidePanel';
import { ExplorerPanel } from './FileExplorer';
import { AgentsPanel } from './AgentsExplorer';
import { useSimpleDataIfAny } from './simpleData';
import { ShareTab } from './ShareTab';
import { useChatChrome } from './chatChrome';
import { IconButton, Tooltip, TooltipTrigger } from '@launchpad-ui/components';
import { LP_THEME } from '../../launchpad/theme';
import { PanelTabStrip, ToolLauncher, usePanelTabs, type AgentAsk } from './PanelTabs';
import { PrTab } from './PrTab';
import { ReviewPaneTab } from './ReviewPaneTab';
import { useReviewsData } from './reviewsData';
import { AgentTab } from './AgentTab';
import { useAutomations } from '../../chat/useAutomations';
import { automationSpace } from '../../chat/automationPlaces';
import { matchesAutomation } from '../../chat/automationsView';
import { AskTab } from './AskTab';
import { askThreadOf } from '../../chat/askStore';

const TAB_LABEL: Record<SidePanelTab, string> = { files: 'Files', terminal: 'Terminal', browser: 'Browser', share: 'Share', pr: 'Pull request', review: 'Review' };

/** What Files explores: an agent's space, a space (with the file or folder shown, if any), or an automation's (its page, by id). */
export type SidePanelFiles = { agent: Project } | { space: string; path?: string; dir?: string } | { automation: string };

interface Props {
  /** The conversation's project, for Terminal and Browser; absent beside a file or on a new tab. */
  project?: Project;
  workstream: string;
  /** What Files explores (a space, or the agents in no space, NO_SPACE_EXPLORER); null for no Files tab. */
  files?: SidePanelFiles | null;
  /** Something was picked in Files. */
  onPicked?: () => void;
  /** A folder of Files' space to open and focus (the file view's breadcrumb); `n` changes on each ask. */
  reveal?: { dir: string; n: number } | null;
  state: SidePanelState;
  /** A tool asked for from outside the panel (ChatApp): shown, its tab opened if it has none, even on a panel that would open on a launcher. */
  ask?: { tab: SidePanelTab; n: number } | null;
  /** The ask has been shown; ChatApp forgets it. */
  onAskUsed?: () => void;
  /** A subagent's agent tab asked for from the chat: opened and shown. */
  agentAsk?: AgentAsk | null;
  onAgentAskUsed?: () => void;
  onChange: (next: SidePanelState) => void;
  onClose: () => void;
  /** Phone width: an overlay over the chat, not resizable. */
  overlay: boolean;
  /** A share link its owner opened (useBrowserShareHandoff): Browser's first dial opens that share's app at its page. */
  openShare?: BrowserShareHandoff | null;
  /** That dial is ready: the handoff is spent. */
  onOpenShareUsed?: () => void;
}

type FilesTarget = { space: string; activePath?: string; activeDir?: string; activeAgent?: { projectId: string; workstream: string } };

/**
 * Files' space and what it highlights. An agent's is its own space
 * (chat/chatSpaces.ts chatHomeSpace), as the sidebar groups it, or with none
 * of its own the space its tab was opened from (OpenItem.openedIn); an agent
 * with neither has the agents in no space (NO_SPACE_EXPLORER), its tab
 * named Agents. A chat not fixed yet on a new box, while the index reloads
 * for it, isn't known to be in no space: no Files yet
 * (noSpaceAgents.boxesKnown).
 */
function useFilesTarget(files: SidePanelFiles | null | undefined, workstream: string): FilesTarget | null {
  const data = useSimpleDataIfAny();
  const { list: automations } = useAutomations();
  if (!files) return null;
  // An automation's page: its own space's explorer, where it is listed (chat/automationPlaces.ts), once both are known.
  if ('automation' in files) {
    const a = automations?.find(x => matchesAutomation(x, files.automation));
    if (!a || !data?.spaces.loaded) return null;
    return { space: automationSpace(a, data.spaces.spaces) ?? NO_SPACE_EXPLORER };
  }
  if (!('agent' in files)) return files.space ? { space: files.space, activePath: files.path, activeDir: files.dir } : null;
  const project = files.agent;
  if (!data?.spaces.loaded) return null;
  const ws = project.workstreams.find(w => w.name === workstream);
  const place = { instanceId: project.instanceId ?? null, spaceId: ws?.spaceId, spaceFixed: ws?.spaceFixedAt != null };
  const tab = data.items.state.items.find(i => i.id === data.activeTab);
  const openedIn = tab?.kind === 'chat' && tab.projectId === project.id && tab.workstream === workstream ? tab.openedIn : null;
  const space = chatHomeSpace(place, data.spaces.spaces, data.spaces.index)
    ?? (openedIn && data.spaces.spaces.some(s => s.name === openedIn) ? openedIn : null);
  // Always, not only for an agent in no space: it remembers the boxes while the index is current.
  const boxKnown = boxesKnown([...(data.rows ?? []).map(r => r.instanceId), project.instanceId], data.spaces.index, data.spaces.current, data.spaces.spaces.length > 0);
  if (!space && !place.spaceFixed && !boxKnown(project.instanceId ?? null)) return null;
  return { space: space ?? NO_SPACE_EXPLORER, activeAgent: { projectId: project.id, workstream } };
}

export function SidePanel({ project, workstream, files, onPicked, reveal, state, onChange, onClose, overlay, openShare, onOpenShareUsed, ask, onAskUsed, agentAsk, onAgentAskUsed }: Props) {
  // The chrome refresh: the collapse button is an icon at the panel's corner, where the header's
  // toggle was before the panel opened (chatChrome.tsx SidePanelButton).
  const { refresh } = useChatChrome();
  const subagentsOn = useFlag(FLAGS.chatSubagents, false);
  const target = useFilesTarget(files, workstream);
  const agentsOnly = target?.space === NO_SPACE_EXPLORER;
  // The launcher names the space Files explores; the agents in no space are in no space, not in "(none)".
  const where = agentsOnly ? 'no space' : target?.space;
  // Share as the workspace offers it: the owner's, not a collaborator's (App.tsx's onShare).
  // The Pull request tab is the chrome refresh's (PrTab.tsx), on a desktop width.
  // The Review tab: a session's review panes, with reviews on, on a phone's overlay
  // too, where a review's link opens it.
  const reviewsOn = useReviewsData().on;
  const offer = { files: target != null, session: project != null, share: project?.role !== 'collaborator', pr: refresh === true && !overlay, review: reviewsOn };
  const tab = shownSidePanelTab(state.tab, offer);
  // The chrome refresh's tabs (PanelTabs.tsx): added with +, closed, each a tool or a launcher.
  const tabsOn = refresh === true && !overlay;
  // A subagent's agent tab shows beside its own chat only.
  const agentChat = subagentsOn && project ? `${project.id}|${workstream}` : null;
  const tabsUi = usePanelTabs(tabsOn, sidePanelTabs(offer), state.tab, t => onChange({ ...state, tab: t }), ask, onAskUsed, agentChat, agentAsk, onAgentAskUsed);
  const launcherShown = tabsOn && tabsUi.active.kind === 'launcher';
  const agentShown = tabsOn && tabsUi.active.kind === 'agent' ? tabsUi.active.agent ?? null : null;
  const shownTool: SidePanelTab = tabsOn && tabsUi.active.kind !== 'launcher' && tabsUi.active.kind !== 'agent' ? tabsUi.active.kind : tab;

  const panelRef = useRef<HTMLElement>(null);
  // An overlay is a phone's full screen: its top and height come from the visual
  // viewport (--chat-vvtop / --chat-vvh, chat.css), so with the keyboard up on iOS
  // the tabs stay on screen and the Terminal re-fits above the keyboard.
  useVisualViewport(panelRef, 'chat', overlay);
  // The main column's width, so a remembered width that no longer fits
  // (a smaller window, a resize) still leaves the chat its minimum.
  const [mainWidth, setMainWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const main = panelRef.current?.parentElement;
    if (overlay || !main) return;
    const measure = () => setMainWidth(main.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    return () => observer.disconnect();
  }, [overlay]);
  const width = dockedSidePanelWidth(state.width, mainWidth);
  const drag = useRef<{ startX: number; startWidth: number; mainWidth: number } | null>(null);
  const onDividerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    const main = panel?.parentElement;
    if (!panel || !main) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: panel.getBoundingClientRect().width, mainWidth: main.getBoundingClientRect().width };
  };
  const onDividerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // The panel's left edge follows the pointer: dragging left widens it.
    onChange({ ...state, width: clampSidePanelWidth(d.startWidth + (d.startX - e.clientX), d.mainWidth) });
  };
  const onDividerUp = () => { drag.current = null; };

  return (
    <aside
      ref={panelRef}
      className="chat-side-panel"
      data-overlay={overlay || undefined}
      style={overlay ? undefined : { width }}
      aria-label={project ? 'Session tools' : 'Tools'}
      id="chat-side-panel"
    >
      {!overlay && (
        <div
          className="chat-side-divider"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={onDividerDown}
          onPointerMove={onDividerMove}
          onPointerUp={onDividerUp}
          onPointerCancel={onDividerUp}
          title="Drag to resize"
        />
      )}
      <div className="chat-side-head">
        {tabsOn && <PanelTabStrip ui={tabsUi} />}
        {!tabsOn && <div className="chat-side-tabs" role="tablist">
          {sidePanelTabs(offer).map(t => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`chat-side-tab ${tab === t ? 'active' : ''}`}
              onClick={() => onChange({ ...state, tab: t })}
            >
              {t === 'files' && agentsOnly ? 'Agents' : TAB_LABEL[t]}
            </button>
          ))}
        </div>}
        {refresh && !overlay ? (
          <TooltipTrigger delay={300}>
            <IconButton icon="sidebar-right-collapse" variant="minimal" className="chat-side-close" aria-label="Close the panel"
              aria-keyshortcuts="Control+Alt+B" onPress={onClose} />
            <Tooltip placement="bottom" className={LP_THEME}>Hide tools ⌃⌥B</Tooltip>
          </TooltipTrigger>
        ) : <button type="button" className="btn-ghost chat-side-close" onClick={onClose} title="Close the panel (Ctrl+Alt+B)" aria-label="Close the panel">
          ✕
        </button>}
      </div>
      <div className="chat-side-body" role="tabpanel" data-tool={tabsOn ? (launcherShown ? 'launcher' : agentShown ? 'agent' : shownTool) : undefined}>
        {/* An ask's tab is an agent tab whose id names its thread (chat/askStore.ts askTabId). */}
        {agentShown && project && (askThreadOf(agentShown.id)
          ? <AskTab key={agentShown.id} project={project} workstream={workstream} agent={agentShown} />
          : <AgentTab key={agentShown.id} project={project} workstream={workstream} agent={agentShown} openAgent={tabsUi.openAgent} />)}
        {launcherShown && (
          <ToolLauncher tools={sidePanelTabs(offer)} onPick={tabsUi.pick}
            context={project ? `For ${project.name}${target ? ` in ${where}` : ''}` : target ? `In ${where}` : ''} />
        )}
        {!launcherShown && !agentShown && shownTool === 'files' && target && agentsOnly && (
          <AgentsPanel key={NO_SPACE_EXPLORER} activeAgent={target.activeAgent} onPicked={onPicked} />
        )}
        {!launcherShown && !agentShown && shownTool === 'files' && target && !agentsOnly && (
          <ExplorerPanel key={target.space} space={target.space} activePath={target.activePath} activeAgent={target.activeAgent} activeDir={target.activeDir} onPicked={onPicked} reveal={reveal ?? undefined} />
        )}
        {!launcherShown && !agentShown && shownTool === 'pr' && project && <PrTab project={project} workstream={workstream} />}
        {!launcherShown && !agentShown && shownTool === 'review' && project && <ReviewPaneTab key={`${project.id}|${workstream}`} project={project} workstream={workstream} />}
        {!launcherShown && !agentShown && shownTool !== 'files' && shownTool !== 'pr' && shownTool !== 'review' && project && (
          <SessionTools project={project} workstream={workstream} tab={shownTool} showReset openShare={openShare} onOpenShareUsed={onOpenShareUsed} overlay={overlay} />
        )}
      </div>
    </aside>
  );
}

/** Terminal, Browser or Share for `project`'s session. */
function SessionTools({ project, workstream, tab, showReset, openShare, onOpenShareUsed, overlay }: {
  project: Project; workstream: string; tab: Exclude<SidePanelTab, 'files' | 'pr' | 'review'>; showReset: boolean;
  openShare?: BrowserShareHandoff | null; onOpenShareUsed?: () => void;
  /** A phone's overlay: the Terminal has the key bar. */
  overlay: boolean;
}) {
  const { user } = useAuth();
  const setupCtx = useSetupContext(project);
  const held = cloneTile(project.setupStatus, setupCtx).holdTerminal;
  const hasAgent = project.workflows.some(w => w.type === 'agent');
  const body = sidePanelBody({ hasAgent, held });
  const owner = project.ownerUsername ?? user?.unixUsername ?? '';
  const ctrlSession = sessionName(owner, project.name, 'ctrl', workstream);
  if (body !== 'ready') {
    return (
      <div className="chat-side-empty">
        {body === 'setup'
          ? tab === 'share' ? 'Sharing opens once the session is set up.' : `The ${TAB_LABEL[tab].toLowerCase()} opens once the session is set up.`
          : 'This session has no terminal or browser.'}
      </div>
    );
  }
  if (tab === 'share') return <ShareTab projectId={project.id} workstream={workstream} key={`${project.id}-${workstream}`} />;
  if (tab === 'terminal' && overlay) {
    return (
      <PhoneTerminal
        sessionName={ctrlSession}
        projectId={project.id}
        workstream={workstream}
        instanceId={project.instanceId}
        key={`${project.id}-${workstream}-ctrl`}
      />
    );
  }
  return tab === 'terminal' ? (
    <Terminal
      sessionName={ctrlSession}
      projectId={project.id}
      workstream={workstream}
      instanceId={project.instanceId}
      active={true}
      key={`${project.id}-${workstream}-ctrl`}
    />
  ) : (
    <SidePanelBrowser project={project} workstream={workstream} showReset={showReset} openShare={openShare} onOpenShareUsed={onOpenShareUsed} />
  );
}

function SidePanelBrowser({ project, workstream, showReset, openShare, onOpenShareUsed }: {
  project: Project; workstream: string; showReset: boolean; openShare?: BrowserShareHandoff | null; onOpenShareUsed?: () => void;
}) {
  const [url, onUrlChange] = useRememberedBrowserUrl(project.id, workstream);
  return (
    <BrowserPane
      projectId={project.id}
      workstream={workstream}
      url={url || 'about:blank'}
      onUrlChange={onUrlChange}
      openShare={openShare}
      onOpenShareUsed={onOpenShareUsed}
      showReset={showReset}
      key={`${project.id}-${workstream}`}
    />
  );
}
