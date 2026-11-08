// The explorer of agents in no space (chat/noSpaceAgents.ts): what a space's explorer (FileExplorer.tsx) is for a
// space, with only agents, since no space means no files. For a person with
// no spaces, it lists every agent; for someone with
// spaces, the agents under No space. An agent another agent started is under
// it, and the search matches agent names at every depth.
//
// It is the side panel's Agents tab (SidePanel.tsx) beside an agent with no
// space, that agent highlighted and its starters open, and a new tab
// (/chat/agents, No space's ⋮ → New tab) lists the
// recent agents in the main pane, with Agents beside it. Picking an agent
// goes to its tab, else opens one (openItems.pickItem), as in a space.
// With simple-ui-automations-enabled the automations in no space are here
// too, as a space's are in its explorer (chat/automationPlaces.ts).
import React, { startTransition, useMemo, useReducer, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useProjects } from '../../contexts/ProjectContext';
import { itemHref, type OpenItemRef } from '../../chat/openItems';
import { agentLabel, searchAgents } from '../../chat/explorerAgents';
import { boxesKnown, noSpaceAgents, noSpaceRecents } from '../../chat/noSpaceAgents';
import { chatLiveKey } from '../../chat/chatLiveStatus';
import { sidebarLine } from '../../chat/simpleChat';
import type { InboxRow } from '../../mobile/inbox';
import { ChatHistoryButton, ChatMoreButton, SidePanelButton, useChatChrome } from './chatChrome';
import { CloseAndBackButton } from './TabClose';
import { AgentIcon, plainClick } from './OpenItems';
import { useSimpleData, WithSimpleData } from './simpleData';
import { SearchIcon, sessionKey, useAgentTree, type AgentKey } from './ExplorerTree';
import { useAutomations } from '../../chat/useAutomations';
import { automationsIn, searchAutomations } from '../../chat/automationPlaces';

/** Agents whose started agents are folded away, for the page's life (FileExplorer keeps a space's the same way). */
const shut = new Set<string>();

/** What the explorer is called: "Agents" with no spaces, else the No space it lists. */
export function agentsExplorerName(hasSpaces: boolean): string {
  return hasSpaces ? 'No space' : 'Agents';
}

type PanelProps = { activeAgent?: AgentKey; onPicked?: () => void };

/** The side panel's Agents: the agents in no space, `activeAgent` (if any) highlighted and revealed. */
export function AgentsPanel(props: PanelProps) {
  return <WithSimpleData><Panel {...props} /></WithSimpleData>;
}

const agentRef = (r: InboxRow): OpenItemRef => ({ kind: 'chat', projectId: r.projectId, workstream: r.workstream });

function Panel({ activeAgent, onPicked }: PanelProps) {
  const { items, rows, spaces, links, activeTab } = useSimpleData();
  const navigate = useNavigate();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [query, setQuery] = useState('');
  const known = useMemo(() => new Set(spaces.spaces.map(s => s.name)), [spaces.spaces]);
  const agents = useMemo(
    () => noSpaceAgents(rows, spaces.spaces, spaces.index, links, boxesKnown(rows.map(r => r.instanceId), spaces.index, spaces.current, known.size > 0)),
    [rows, known, spaces.spaces, spaces.index, links, spaces.current],
  );
  const name = agentsExplorerName(spaces.spaces.length > 0);
  const { enabled: automationsOn, list: automationList } = useAutomations();
  const placed = useMemo(() => (automationsOn ? automationsIn(automationList, null, spaces.spaces) : []), [automationsOn, automationList, spaces.spaces]);

  const activeKey = activeAgent ? sessionKey(activeAgent) : null;
  const show = (ref: OpenItemRef, newTab: boolean) => {
    startTransition(() => {
      // Opened from No space: it stays there (OpenItem.openedIn null), whatever spaces its box reaches.
      const tab = newTab ? items.openNew(ref, null) : items.pick(ref, activeTab, undefined, null);
      navigate(itemHref(ref, tab));
    });
    onPicked?.();
  };
  const openPage = (href: string) => { startTransition(() => navigate(href)); onPicked?.(); };
  const { ctx, agentNodes, agentHit, automationHit } = useAgentTree({ shut, rerender, activeKey, show, agentRef, agents, placed, openPage });

  const searching = query.trim() !== '';
  const hits = searching ? searchAgents(agents, query) : [];
  const automationHits = searching ? searchAutomations(placed, query) : [];
  return (
    <aside className="fx-panel" aria-label={`Explorer for ${name}`}>
      <div className="fx-panel-head"><span className="fx-panel-title">{name}</span></div>
      <label className="fx-search">
        <SearchIcon />
        <input type="search" placeholder="Search agents" aria-label={`Search agents in ${name}`}
          value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setQuery(''); }} />
      </label>
      <div className="fx-panel-body">
        {searching ? (
          <ul className="fx-tree" aria-label="Search results">
            {automationHits.map(a => automationHit(a, query))}
            {hits.map(r => agentHit(r, query))}
            {hits.length === 0 && automationHits.length === 0 && <li className="fx-note">Nothing matches.</li>}
          </ul>
        ) : (
          <ul className="fx-tree" aria-label={name}>
            {agentNodes(agents, true)}
            {agents.length === 0 && placed.length === 0 && <li className="fx-note">No agents yet.</li>}
          </ul>
        )}
      </div>
      {ctx.menu}
    </aside>
  );
}

/** A new tab on the agents in no space (/chat/agents): the recent ones, with Agents beside them in the side panel. */
export function AgentsTab() {
  return <WithSimpleData><NewTab /></WithSimpleData>;
}

function NewTab() {
  const { items, rows, live, setupOf, spaces, activeTab } = useSimpleData();
  const { projects } = useProjects();
  const { mode, sidePanel } = useChatChrome();
  const navigate = useNavigate();
  const name = agentsExplorerName(spaces.spaces.length > 0);
  const recents = useMemo(() => {
    const lastActive = new Map(projects.map(p => [p.id, p.lastActiveAt ? Date.parse(p.lastActiveAt) : null]));
    const agents = rows.map(r => ({
      projectId: r.projectId, workstream: r.workstream, instanceId: r.instanceId, spaceId: r.spaceId, spaceFixed: r.spaceFixed,
      lastActiveAt: lastActive.get(r.projectId) ?? null,
    }));
    const boxKnown = boxesKnown(rows.map(r => r.instanceId), spaces.index, spaces.current, spaces.spaces.length > 0);
    return noSpaceRecents(items.state.items, agents, spaces.spaces, spaces.index, undefined, boxKnown);
  }, [projects, rows, items.state.items, spaces.spaces, spaces.index, spaces.current]);
  const rowOf = useMemo(() => new Map(rows.map(r => [sessionKey(r), r])), [rows]);
  const show = (ref: OpenItemRef) => startTransition(() => navigate(itemHref(ref, items.pick(ref, activeTab, undefined, null))));

  return (
    <div className="chat-view">
      <section className="chat-conv">
        <header className="chat-header">
          <CloseAndBackButton />
          <ChatHistoryButton />
          <div className="chat-title"><span className="chat-title-name">New tab</span><span className="chat-title-repo">{name}</span></div>
          <div className="chat-header-actions">
            {mode === 'drawer'
              ? sidePanel && <ChatMoreButton label="New tab: actions" actions={[{ label: sidePanel.open ? 'Hide tools' : 'Show tools', onSelect: sidePanel.toggle }]} />
              : <SidePanelButton />}
          </div>
        </header>
        <div className="chat-transcript">
          <div className="chat-transcript-inner nt">
            <h2 className="nt-head">Recent agents</h2>
            {recents.length === 0 ? (
              <p className="nt-none">No agents yet.</p>
            ) : (
              <ul className="nt-list" aria-label="Recent agents">
                {recents.map(r => {
                  const row = rowOf.get(sessionKey(r));
                  if (!row) return null;
                  const href = itemHref(r);
                  const line = sidebarLine(row, live.get(chatLiveKey(row.projectId, row.workstream)), setupOf.get(row.projectId));
                  return (
                    <li key={href}>
                      <Link to={href} className="nt-row" data-tip={agentLabel(row)}
                        onClick={e => { if (!plainClick(e)) return; e.preventDefault(); show(r); }}>
                        <span className="nt-icon" aria-hidden="true"><AgentIcon status={line.glyph} /></span>
                        <span className="nt-text"><span className="nt-name">{agentLabel(row)}</span><span className="nt-where">{line.state}</span></span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
