// Subagents in the SDK chat (behind
// chat-subagents-enabled): an Agent call is one row that says where its
// subagent is and opens its transcript in the side panel's agent tab
// (AgentTab.tsx). The ones Claude started since the last message, and any
// still running, are kept in view: in the context card's Agents while it
// shows, else in a thin drawer on the composer's top edge. The chat view
// provides what they read: its subagents (chat/subagents.ts subagentsOf) and
// how to open one's tab. Each is a LaunchPad Button laid out as a row, as the
// context card's pull request is.
import React, { createContext, useEffect, useState } from 'react';
import { Button, ProgressBar } from '@launchpad-ui/components';
import { Icon, type IconName } from '@launchpad-ui/icons';
import { agentDuration, isAgentTool, reportGist, subagentElapsed, subagentLine, subagentsSummary, type SubagentStatus, type SubagentView } from '../../chat/subagents';
import type { ToolItem } from '../../chat/toolRuns';

export interface SubagentsUi {
  /** The chat's subagents, by their Agent call's id. */
  byId: ReadonlyMap<string, SubagentView>;
  /** Shows a subagent's transcript in the side panel's agent tab. */
  open: (view: SubagentView) => void;
  /** The subagent whose tab is on screen. */
  shownId: string | null;
}

/** The chat's subagents for its Agent calls' rows; null where they are off or have no tab to open (a phone): the call is a tool card. */
export const SubagentsContext = createContext<SubagentsUi | null>(null);

const MARK_ICON: Record<Exclude<SubagentStatus, 'running'>, IconName> = { done: 'check-circle', failed: 'cancel-circle', stopped: 'minus-circle' };
export const STATUS_WORD: Record<SubagentStatus, string> = { running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped' };

/** A subagent's state: LaunchPad's spinner while it runs, else a check, a cross, or a dash for one its turn left. */
export function SubagentMark({ status }: { status: SubagentStatus }) {
  return (
    <span className="agent-mark" data-status={status} aria-hidden="true">
      {status === 'running'
        ? <ProgressBar variant="spinner" size="small" isIndeterminate aria-label="Running" />
        : <Icon name={MARK_ICON[status]} size="small" />}
    </span>
  );
}

/** The clock, a tick a second while `on`: a running subagent's time goes up. */
export function useTicking(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** Whether a tool call shows as a subagent row here. */
export function isAgentRow(ui: SubagentsUi | null, item: ToolItem): boolean {
  return ui != null && isAgentTool(item.name);
}

/**
 * One Agent call: "Agent · <what it is for> · <its type> · 2 tools · 45s ·
 * View". The whole row opens its transcript; the one whose tab is on screen
 * is marked. `id` is its anchor for the agent tab's Show in chat.
 */
export function AgentCallRow({ item, ui }: { item: ToolItem; ui: SubagentsUi }) {
  const view = ui.byId.get(item.id);
  const status: SubagentStatus = view?.status ?? (item.done ? 'done' : 'running');
  const now = useTicking(status === 'running');
  const input = (item.input && typeof item.input === 'object' ? item.input : {}) as Record<string, unknown>;
  const description = view?.description ?? (typeof input.description === 'string' && input.description ? input.description : 'Subagent');
  const shown = ui.shownId === item.id;
  return (
    <div className="sdk-tool agent-call" id={`agent-call-${item.id}`} data-status={status} data-shown={shown || undefined}>
      <Button variant="minimal" className="agent-call-head" isDisabled={!view} onPress={() => { if (view) ui.open(view); }}
        aria-label={`${description}: ${STATUS_WORD[status].toLowerCase()}. Show its transcript`}>
        <SubagentMark status={status} />
        <span className="sdk-tool-title">Agent</span>
        <span className="sdk-tool-intent">{description}</span>
        {view?.agentType && <span className="agent-type">{view.agentType}</span>}
        {view && <span className="agent-call-line">{subagentLine(view, now)}</span>}
        <span className="agent-call-open" aria-hidden="true">
          <Icon name="sidebar-right-expand" size="small" />{shown ? 'Open' : 'View'}
        </span>
      </Button>
    </div>
  );
}

/** What a kept-in-view row says under its name: the step it is on, or the gist of what it returned. */
function rowSub(v: SubagentView): string {
  if (v.status === 'running') return v.step ?? (v.background ? 'Working in the background' : 'Working');
  if (v.status === 'failed') return reportGist(v.report) ?? 'Failed';
  if (v.status === 'stopped') return 'Stopped before it finished';
  return reportGist(v.report) ?? 'Finished';
}

/** One subagent kept in view: its mark, what it is for, what it is doing or returned, and its time. Opens its tab. */
export function SubagentRow({ view, ui }: { view: SubagentView; ui: SubagentsUi }) {
  const now = useTicking(view.status === 'running');
  const ms = subagentElapsed(view, now);
  return (
    <Button variant="minimal" className="agent-row" data-shown={ui.shownId === view.id || undefined} onPress={() => ui.open(view)}
      aria-label={`${view.description}: ${STATUS_WORD[view.status].toLowerCase()}. Show its transcript`}>
      <SubagentMark status={view.status} />
      <span className="agent-row-text">
        <span className="agent-row-name">{view.description}</span>
        <span className="agent-row-sub">{rowSub(view)}</span>
      </span>
      {ms != null && <span className="agent-row-time">{agentDuration(ms)}</span>}
    </Button>
  );
}

/** The context card's Agents (SessionContextCard.tsx): the subagents kept in view, with how they stand. */
export function AgentsCardSection({ list, ui }: { list: readonly SubagentView[]; ui: SubagentsUi }) {
  if (!list.length) return null;
  return (
    <section className="ctx-section ctx-agents" aria-label="Agents">
      <h4 className="ctx-heading">Agents<span className="ctx-heading-aside">{subagentsSummary(list)}</span></h4>
      <div className="ctx-agent-rows">{list.map(v => <SubagentRow key={v.id} view={v} ui={ui} />)}</div>
    </section>
  );
}

/**
 * The drawer on the composer's top edge: the subagents kept in view, while
 * the context card doesn't show them (the panel is open, or the chat is too
 * narrow for the card; chrome.css hides the drawer while the card shows). One
 * line, "2 agents running · Run the tests — Running npm test"; opened, their
 * rows above it.
 */
export function AgentsDrawer({ list, ui }: { list: readonly SubagentView[]; ui: SubagentsUi }) {
  const [open, setOpen] = useState(false);
  const running = list.filter(v => v.status === 'running');
  const now = useTicking(running.length > 0);
  if (!list.length) return null;
  const lead = running[running.length - 1];
  const ended = list.filter(v => v.status !== 'running');
  const longest = Math.max(0, ...ended.map(v => subagentElapsed(v, now) ?? 0));
  const leadText = running.length
    ? `${running.length} ${running.length === 1 ? 'agent' : 'agents'} running`
    : `${list.length} ${list.length === 1 ? 'agent' : 'agents'} ${ended.every(v => v.status === 'done') ? 'finished' : 'ended'}`;
  const detail = lead ? `${lead.description}${lead.step ? ` — ${lead.step}` : ''}` : list.some(v => v.status !== 'done') ? subagentsSummary(list) : longest ? `${agentDuration(longest)} for the longest` : null;
  return (
    <div className="agent-drawer" data-open={open || undefined} data-done={!running.length || undefined}>
      {open && <div className="agent-drawer-list" id="agent-drawer-list">{list.map(v => <SubagentRow key={v.id} view={v} ui={ui} />)}</div>}
      <Button variant="minimal" className="agent-drawer-head" onPress={() => setOpen(o => !o)} aria-expanded={open} aria-controls={open ? 'agent-drawer-list' : undefined}>
        <span className="agent-drawer-marks" aria-hidden="true">{list.slice(0, 5).map(v => <SubagentMark key={v.id} status={v.status} />)}</span>
        <span className="agent-drawer-lead">{leadText}</span>
        {detail && <span className="agent-drawer-now">· {detail}</span>}
        <Icon name={open ? 'chevron-down' : 'chevron-up'} size="small" className="agent-drawer-chevron" />
      </Button>
    </div>
  );
}
