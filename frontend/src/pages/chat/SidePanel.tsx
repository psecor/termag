// The simple UI's side panel (chat/sidePanel.ts): the open conversation's
// ctrl terminal and browser pane, the workspace's own components, in a
// column beside the chat. Only the shown tab is mounted, so the terminal
// socket opens when Terminal is showing and closes when the panel shuts or
// switches to Browser (tmux keeps the shell); the browser parks on the box
// the same way the workspace dock's does. Where the user has spaces, Files
// is the space's explorer (FileExplorer.tsx): the agent's space beside an
// agent (none for an agent with no space), the file's beside a file, the
// new tab's on a new tab. Picking in it shows the pick in the main pane.
import React, { useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useSetupContext } from '../../hooks/useSetupContext';
import { Terminal } from '../../components/Terminal';
import { BrowserPane } from '../../components/BrowserPane';
import { useRememberedBrowserUrl } from '../../components/BrowserDock';
import { cloneTile } from '../../utils/cloneTile';
import { sessionName } from '../../utils/sessionName';
import { FLAGS, useFlag } from '../../flags';
import type { Project } from '../../types';
import { chatSpace } from '../../chat/openItems';
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
import { useSimpleDataIfAny } from './simpleData';

const TAB_LABEL: Record<SidePanelTab, string> = { files: 'Files', terminal: 'Terminal', browser: 'Browser' };

/** What Files explores: an agent's space, or a space (with the file shown, if any). */
export type SidePanelFiles = { agent: Project } | { space: string; path?: string };

interface Props {
  /** The conversation's project, for Terminal and Browser; absent beside a file or on a new tab. */
  project?: Project;
  workstream: string;
  /** Files' space, where the user has spaces; else null. */
  files?: SidePanelFiles | null;
  /** Something was picked in Files. */
  onPicked?: () => void;
  state: SidePanelState;
  onChange: (next: SidePanelState) => void;
  onClose: () => void;
  /** Phone width: an overlay over the chat, not resizable. */
  overlay: boolean;
}

type FilesTarget = { space: string; activePath?: string; activeAgent?: { projectId: string; workstream: string } };

/**
 * Files' space and what it highlights. An agent's is the space its tab was
 * opened in while its box reaches it, else its box's first, as the sidebar
 * groups it; an agent with no space has none, and so no Files.
 */
function useFilesTarget(files: SidePanelFiles | null | undefined, workstream: string): FilesTarget | null {
  const data = useSimpleDataIfAny();
  if (!files) return null;
  if (!('agent' in files)) return files.space ? { space: files.space, activePath: files.path } : null;
  const project = files.agent;
  if (!data?.spaces.loaded) return null;
  const tab = data.items.state.items.find(i => i.id === data.activeTab);
  const pinned = tab?.kind === 'chat' && tab.projectId === project.id && tab.workstream === workstream ? tab.space : undefined;
  const known = new Set(data.spaces.spaces.map(s => s.name));
  const space = chatSpace({ kind: 'chat', projectId: project.id, workstream, space: pinned }, project.instanceId ?? null, known, data.spaces.index, data.spaces.current);
  return space ? { space, activeAgent: { projectId: project.id, workstream } } : null;
}

export function SidePanel({ project, workstream, files, onPicked, state, onChange, onClose, overlay }: Props) {
  const browserOn = useFlag(FLAGS.browserPane, false);
  const keptProfilesOn = useFlag(FLAGS.persistentProfiles, false);
  const target = useFilesTarget(files, workstream);
  const offer = { files: target != null, session: project != null };
  const tab = shownSidePanelTab(state.tab, browserOn, offer);

  const panelRef = useRef<HTMLElement>(null);
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
        <div className="chat-side-tabs" role="tablist">
          {sidePanelTabs(browserOn, offer).map(t => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`chat-side-tab ${tab === t ? 'active' : ''}`}
              onClick={() => onChange({ ...state, tab: t })}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
        <button type="button" className="btn-ghost chat-side-close" onClick={onClose} title="Close the panel (Ctrl+Alt+B)" aria-label="Close the panel">
          ✕
        </button>
      </div>
      <div className="chat-side-body" role="tabpanel">
        {tab === 'files' && target && (
          <ExplorerPanel key={target.space} space={target.space} activePath={target.activePath} activeAgent={target.activeAgent} onPicked={onPicked} />
        )}
        {tab !== 'files' && project && (
          <SessionTools project={project} workstream={workstream} tab={tab} showReset={keptProfilesOn} />
        )}
      </div>
    </aside>
  );
}

/** Terminal or Browser for `project`'s session. */
function SessionTools({ project, workstream, tab, showReset }: { project: Project; workstream: string; tab: 'terminal' | 'browser'; showReset: boolean }) {
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
          ? `The ${TAB_LABEL[tab].toLowerCase()} opens once the session is set up.`
          : 'This session has no terminal or browser.'}
      </div>
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
    <SidePanelBrowser project={project} workstream={workstream} showReset={showReset} />
  );
}

function SidePanelBrowser({ project, workstream, showReset }: { project: Project; workstream: string; showReset: boolean }) {
  const [url, onUrlChange] = useRememberedBrowserUrl(project.id, workstream);
  return (
    <BrowserPane
      projectId={project.id}
      workstream={workstream}
      url={url || 'about:blank'}
      onUrlChange={onUrlChange}
      showReset={showReset}
      key={`${project.id}-${workstream}`}
    />
  );
}
