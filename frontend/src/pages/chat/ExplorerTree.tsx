// The agents in an explorer (simple-ui-side-panel-enabled): a space's,
// above its files (FileExplorer.tsx), and the one of agents in no space
// (AgentsExplorer.tsx). An agent another agent started (or an ask it sent)
// is under it, shown until its starter is folded (each explorer keeps which
// are folded, for the page's life), and the one shown is revealed; a search hit says which agent it is
// under. A row opens its agent in its tab or a new one, and its ⋮ (a right
// click, the context menu key or Shift+F10) has Open, Open in new tab and
// Open in new browser tab; files' rows are the same (itemRow). An
// automation's runs are one folded row (agentNodes, utils/automationRuns.ts):
// its latest run's status, its schedule and how many runs it has. With
// simple-ui-automations-enabled that row is the automation itself, like an
// agent's: it opens the automation's page (/chat/automations/:id), its ⋮ has
// Open and Open in new browser tab, its runs are under its caret, and an
// explorer lists the automations of its place (chat/automationPlaces.ts)
// even before their first run.
import React, { useEffect, useMemo } from 'react';
import { Link, useMatch, useNavigate } from 'react-router-dom';
import { itemHref, type OpenItemRef } from '../../chat/openItems';
import { matchParts } from '../../chat/fileExplorer';
import { agentLabel, workstreamTip, type AgentNode } from '../../chat/explorerAgents';
import { chatLiveKey } from '../../chat/chatLiveStatus';
import { useBoxOf } from '../../chat/useBoxOf';
import { sidebarLine } from '../../chat/simpleChat';
import type { InboxRow } from '../../mobile/inbox';
import { AgentIcon, openInBrowserTab, plainClick } from './OpenItems';
import { isMenuKey, MenuButton, useContextMenu, type MenuAction, type MenuTrigger } from './ContextMenu';
import { useSimpleData } from './simpleData';
import { setRunsUnfolded, useAutomationIndex, useUnfoldedRuns } from '../../chat/automationRunGroups';
import { automationHref, groupRuns, runLabel, runsStatus, runsSubtitle, runsUnfolded, shownRuns, type RunGroup } from '../../utils/automationRuns';
import { automationHref as automationPageHref, isLiveRun } from '../../chat/automationsView';
import { isAutomationShown } from '../../chat/automationPlaces';
import { useAutomations } from '../../chat/useAutomations';
import type { AutomationView } from '../../services/api';

export function Caret({ open }: { open: boolean }) {
  return (
    <svg className={`fx-caret${open ? ' open' : ''}`} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" d="M6 4l4 4-4 4" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg className="fx-search-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M10.5 10.5L14 14" />
    </svg>
  );
}

export const sessionKey = (r: { projectId: string; workstream: string }) => `${r.projectId}|${r.workstream}`;

export function Highlight({ text, query }: { text: string; query: string }) {
  return <>{matchParts(text, query).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <React.Fragment key={i}>{p.text}</React.Fragment>))}</>;
}

export type AgentKey = { projectId: string; workstream: string };

export interface AgentTreeOptions {
  /** Agents whose started agents are folded away, by session key; every other one shows them. The explorer keeps it. */
  shut: Set<string>;
  rerender: () => void;
  /** The agent shown, highlighted, with the agents that started it open. */
  activeKey: string | null;
  /** `ref` in its tab or a new one, or always a new one; `chatSpace` is an agent's own space (openItems.ts pickItem). */
  show: (ref: OpenItemRef, newTab: boolean, chatSpace?: string | null) => void;
  /** What an agent's row opens. */
  agentRef: (r: InboxRow) => OpenItemRef;
  /** An agent's own space (chat/chatSpaces.ts chatHomeSpace), which may be another than the explorer's; unset says nothing. */
  chatSpaceOf?: (r: InboxRow) => string | null;
  agents: ReadonlyArray<AgentNode<InboxRow>>;
  /** The automations in this explorer's space (chat/automationPlaces.ts automationsIn), listed even with no run here. */
  placed?: readonly AutomationView[];
  /** Goes to an automation's page; by default, navigates there. */
  openPage?: (href: string) => void;
}

/** An explorer's rows: `agentNode` for the tree, `agentHit` for a search hit, `itemRow` for any row, and `ctx` for their menu. */
export function useAgentTree({ shut, rerender, activeKey, show, agentRef, chatSpaceOf, agents, placed = [], openPage }: AgentTreeOptions) {
  const { live, setupOf, links } = useSimpleData();
  const boxOf = useBoxOf();
  const ctx = useContextMenu();
  const navigate = useNavigate();
  const unfoldedRuns = useUnfoldedRuns();
  // With the simple UI's automation pages, the shared list (AutomationsProvider) has them; else the index the full UI polls.
  const { enabled: pages, list } = useAutomations();
  const index = useAutomationIndex(!pages && agents.some(n => n.row.kind === 'automation'));
  const automations = useMemo(() => (pages ? new Map((list ?? []).map(a => [a.projectId, a])) : index), [pages, list, index]);
  const shownPage = useMatch('/chat/automations/:id')?.params.id ?? null;
  const goTo = openPage ?? ((href: string) => navigate(href));

  useEffect(() => {
    if (!activeKey) return;
    const parentOf = new Map(links.map(l => [sessionKey(l), `${l.parentProjectId}|${l.parentWorkstream}`]));
    let opened = false;
    const seen = new Set([activeKey]);
    for (let p = parentOf.get(activeKey); p && !seen.has(p); p = parentOf.get(p)) {
      seen.add(p);
      if (shut.has(p)) { shut.delete(p); opened = true; }
    }
    if (opened) rerender();
  }, [shut, activeKey, links]);

  const toggleOpen = (key: string) => {
    if (shut.has(key)) shut.delete(key);
    else shut.add(key);
    rerender();
  };

  // `tabs`: the thing opens in a tab (an agent, a file), so the menu has Open in new tab; a page (an automation's) has none.
  const menuFor = (label: string, open: (newTab: boolean) => void, href: string, tabs = true) => (e: MenuTrigger) => {
    const actions: MenuAction[] = [
      { label: 'Open', onSelect: () => open(false) },
      ...(tabs ? [{ label: 'Open in new tab', onSelect: () => open(true) }] : []),
      { label: 'Open in new browser tab', onSelect: () => openInBrowserTab(href) },
    ];
    ctx.open(e, label, actions, href);
  };

  /** A row that opens something, and its ⋮: an app link whose href has no tab, so a modifier click is the browser's. */
  const itemRow = (o: {
    href: string; open: (newTab: boolean) => void; label: string; tip: string; cls: string; active?: boolean;
    icon: React.ReactNode; children: React.ReactNode; tabs?: boolean;
  }) => {
    const menu = menuFor(o.label, o.open, o.href, o.tabs);
    return (
      <>
        <Link to={o.href} className={`fx-row ${o.cls}${o.active ? ' active' : ''}`} aria-current={o.active ? 'page' : undefined} data-tip={o.tip}
          onClick={e => { if (!plainClick(e)) return; e.preventDefault(); o.open(false); }}
          onContextMenu={menu} onKeyDown={e => { if (isMenuKey(e)) menu(e); }}>
          <span className="fx-icon" aria-hidden="true">{o.icon}</span>
          {o.children}
        </Link>
        <MenuButton label={o.label} open={menu} expanded={ctx.openKey === o.href} className="fx-menu" />
      </>
    );
  };

  const agentStatus = (r: InboxRow) => sidebarLine(r, live.get(chatLiveKey(r.projectId, r.workstream)), setupOf.get(r.projectId));

  const agentRow = (r: InboxRow, children: React.ReactNode, cls = '') => {
    const ref = agentRef(r);
    const line = agentStatus(r);
    return itemRow({
      href: itemHref(ref), open: newTab => (chatSpaceOf ? show(ref, newTab, chatSpaceOf(r)) : show(ref, newTab)), label: agentLabel(r),
      // An ask is called by its title; Claude's own title for its session, when it has another, is in the tooltip.
      tip: [agentLabel(r), r.askTitle && r.sessionTitle && r.sessionTitle !== r.askTitle ? r.sessionTitle : null, boxOf(r) && `on ${boxOf(r)}`, workstreamTip(r), line.state].filter(Boolean).join('\n'), cls: `fx-file fx-agent${cls}`, active: sessionKey(r) === activeKey,
      icon: <AgentIcon status={line.glyph} />,
      children: <>{children}<span className="chat-sr">, agent, {line.state}</span></>,
    });
  };

  /** One agent and, unless it is folded, the agents it started; `name` in place of its label (a run under its automation). */
  function agentNode(n: AgentNode<InboxRow>, name?: string): React.ReactNode {
    const k = sessionKey(n.row);
    const open = !shut.has(k);
    return (
      <li key={`a:${k}`} className="fx-item fx-agent-li">
        {n.children.length > 0 && (
          <button type="button" className="fx-twisty" aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the agents ${agentLabel(n.row)} started`} data-tip={`${n.children.length} started by this agent`}
            onClick={() => toggleOpen(k)}><Caret open={open} /></button>
        )}
        {agentRow(n.row, <span className="fx-name">{name ?? agentLabel(n.row)}</span>)}
        {open && <ul className="fx-children">{agentNodes(n.children)}</ul>}
      </li>
    );
  }

  /** An automation's row that opens its page (simple-ui-automations-enabled): `name` in place of its name (a search hit). */
  const automationRow = (a: Pick<AutomationView, 'id' | 'projectId' | 'projectName'>, status: string, tip: string, children: React.ReactNode, cls = '') => {
    const href = automationPageHref(a.projectId);
    return itemRow({
      href, open: () => goTo(href), label: a.projectName, tip, cls: `fx-file fx-agent fx-runs-head${cls}`, tabs: false,
      active: isAutomationShown(a, shownPage), icon: <AgentIcon status={status} />,
      children: <>{children}<span className="chat-sr">, automation</span></>,
    });
  };

  /**
   * An automation with its own page (simple-ui-automations-enabled): a row like an agent's, which opens the page, with
   * its runs under its caret, folded unless the person unfolded it or one of its runs is open. `g` may have no runs.
   */
  function automationNode(g: RunGroup<AgentNode<InboxRow>>): React.ReactNode {
    const auto = automations.get(g.projectId);
    const open = runsUnfolded(g.projectId, unfoldedRuns, g.runs.find(n => sessionKey(n.row) === activeKey)?.row ?? null);
    const status = runsStatus(g.runs.map(n => agentStatus(n.row).glyph));
    const subtitle = auto ? runsSubtitle(auto) : null;
    const count = g.runs.length;
    const countText = `${count} ${count === 1 ? 'run' : 'runs'}`;
    const shown = open ? shownRuns(g.runs, n => sessionKey(n.row) === activeKey) : [];
    const a = auto ?? { id: g.projectId, projectId: g.projectId, projectName: g.projectName };
    return (
      <li key={`r:${g.projectId}`} className="fx-item fx-agent-li fx-runs">
        {count > 0 && (
          <button type="button" className="fx-twisty" aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the runs of ${g.projectName}`} data-tip={countText}
            onClick={() => setRunsUnfolded(g.projectId, !open)}><Caret open={open} /></button>
        )}
        {automationRow(a, status, [g.projectName, subtitle ? `automation: ${subtitle}` : 'automation', countText].join('\n'), <>
          <span className="fx-name">{g.projectName}</span>
          {subtitle && <span className="fx-where">{subtitle}</span>}
          <span className="fx-runs-count" aria-label={countText}>{count}</span>
        </>)}
        {open && count > 0 && (
          <ul className="fx-children">
            {shown.map(n => agentNode(n, runLabel(n.row.workstream, auto?.timezone)))}
            {count > shown.length && (
              <li className="fx-note fx-runs-all"><Link to={automationPageHref(g.projectId)}>Show all {count} runs</Link></li>
            )}
          </ul>
        )}
      </li>
    );
  }

  /** An automation's runs as one row, folded unless the person unfolded it or one of its runs is open. */
  function runGroup(g: RunGroup<AgentNode<InboxRow>>): React.ReactNode {
    if (pages) return automationNode(g);
    const auto = automations.get(g.projectId);
    const open = runsUnfolded(g.projectId, unfoldedRuns, g.runs.find(n => sessionKey(n.row) === activeKey)?.row ?? null);
    const status = runsStatus(g.runs.map(n => agentStatus(n.row).glyph));
    const subtitle = auto ? runsSubtitle(auto) : null;
    const count = g.runs.length;
    const shown = open ? shownRuns(g.runs, n => sessionKey(n.row) === activeKey) : [];
    return (
      <li key={`r:${g.projectId}`} className="fx-item fx-agent-li fx-runs">
        <button type="button" className="fx-row fx-runs-head" aria-expanded={open}
          data-tip={[g.projectName, auto ? `automation: ${runsSubtitle(auto)}` : 'automation', `${count} ${count === 1 ? 'run' : 'runs'}`].join('\n')}
          onClick={() => setRunsUnfolded(g.projectId, !open)}>
          <Caret open={open} />
          <span className="fx-icon" aria-hidden="true"><AgentIcon status={status} /></span>
          <span className="fx-name">{g.projectName}</span>
          {subtitle && <span className="fx-where">{subtitle}</span>}
          <span className="fx-runs-count" aria-label={`${count} ${count === 1 ? 'run' : 'runs'}`}>{count}</span>
        </button>
        {open && (
          <ul className="fx-children">
            {shown.map(n => agentNode(n, runLabel(n.row.workstream, auto?.timezone)))}
            {count > shown.length && (
              <li className="fx-note fx-runs-all"><Link to={automationHref(g.projectId)}>Show all {count} runs</Link></li>
            )}
          </ul>
        )}
      </li>
    );
  }

  /**
   * A level of the tree: each agent, and each automation's runs as one row (runGroup). At the top (`top`), with
   * automation pages on, the automations placed here that have no run in `list` go in by name, so each is listed from the start.
   */
  function agentNodes(list: ReadonlyArray<AgentNode<InboxRow>>, top = false): React.ReactNode[] {
    const grouped = groupRuns(list, n => n.row);
    const nodes = grouped.map(x => (x.group ? runGroup(x.group) : agentNode(x.item)));
    if (!top || !pages || placed.length === 0) return nodes;
    // Each one goes in by name among the rows, which are by name already (agentForest).
    const names = grouped.map(x => (x.group ? x.group.projectName : agentLabel(x.item.row)));
    const listed = new Set(grouped.flatMap(x => (x.group ? [x.group.projectId] : [])));
    for (const a of placed) {
      if (listed.has(a.projectId)) continue;
      const at = names.findIndex(n => n.localeCompare(a.projectName) > 0);
      const i = at < 0 ? names.length : at;
      names.splice(i, 0, a.projectName);
      nodes.splice(i, 0, automationNode({ projectId: a.projectId, projectName: a.projectName, runs: [] }));
    }
    return nodes;
  }

  /** An automation the search found (automation pages on). */
  const automationHit = (a: AutomationView, query: string) => (
    <li key={`h:${a.projectId}`} className="fx-item">{automationRow(a, isLiveRun(a.lastRun) ? 'working' : 'not_running', `${a.projectName}\nautomation: ${runsSubtitle(a)}`, (
      <span className="fx-hit-text">
        <span className="fx-name"><Highlight text={a.projectName} query={query} /></span>
        <span className="fx-where">automation</span>
      </span>
    ), ' fx-hit')}</li>
  );

  const parentOf = useMemo(() => {
    const m = new Map<string, string>();
    const walk = (list: ReadonlyArray<AgentNode<InboxRow>>, parent: string | null) => {
      for (const n of list) { if (parent) m.set(sessionKey(n.row), parent); walk(n.children, agentLabel(n.row)); }
    };
    walk(agents, null);
    return m;
  }, [agents]);

  const agentHit = (r: InboxRow, query: string) => (
    <li key={`a:${r.key}`} className="fx-item">{agentRow(r, (
      <span className="fx-hit-text">
        <span className="fx-name"><Highlight text={agentLabel(r)} query={query} /></span>
        {parentOf.has(sessionKey(r)) && <span className="fx-where">under {parentOf.get(sessionKey(r))}</span>}
      </span>
    ), ' fx-hit')}</li>
  );

  return { ctx, itemRow, agentRow, agentNodes, agentHit, automationHit };
}
