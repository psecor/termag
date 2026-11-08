// The side panel's agent tab (behind
// chat-subagents-enabled): one subagent's whole transcript. Where it is and
// what it cost, the brief Claude gave it, its own messages and calls, then
// the report it returned. Its live state is the open chat's
// (chat/subagentStore.ts). Its messages are the box's file
// (GET …/chat/subagents/:agentId), read again every few seconds while it
// runs, or what streamed when the file can't be read: a reloaded chat has
// none streamed, and a foreground subagent may stream none of its steps.
import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { chatApi } from '../../services/api';
import type { Project } from '../../types';
import type { AgentTabRef } from '../../chat/panelTabs';
import { fromHistory, type ChatItem, type ChatState } from '../../chat/sdkChat';
import { subagentElapsed, agentDuration, subagentsOf, type SubagentStatus, type SubagentView } from '../../chat/subagents';
import { subagentStore, useChatSubagents } from '../../chat/subagentStore';
import { findSubagent, nestedSubagents } from '../../chat/sessionAgents';
import { isPaneSessionTab } from '../../chat/paneSubagents';
import { groupToolRuns } from '../../chat/toolRuns';
import { formatTokens } from '../../chat/contextUsage';
import { Markdown } from '../../chat/Markdown';
import { ItemView } from './SdkChatView';
import { ToolRun } from './ToolCards';
import { STATUS_WORD, SubagentMark, SubagentsContext, useTabSubagentsUi, useTicking } from './Subagents';

/** How often a running subagent's file is read again. */
export const AGENT_TAB_POLL_MS = 4000;

const READ_FAILED: Record<string, string> = {
  'runner-update': "This box's agent needs an update before it can show a subagent's steps.",
  'box-away': "The box isn't connected, so its steps can't be read.",
  'subagent-missing': 'The box has no record of its steps.',
  // A session running alongside (GET …/chat/pane-sessions/:sessionId) that has written nothing yet, or just ended.
  'session-missing': 'This session has nothing written down yet.',
};

/**
 * Its messages from the box's file while `agentId` is known: again every few
 * seconds while it runs, once more when it ends. A pane chat's (`pane`) is
 * read from beside its Claude's session (GET …/chat/pane-subagents/:agentId).
 */
function useAgentFile(projectId: string, workstream: string, agentId: string | null, running: boolean, pane = false, session: string | null = null) {
  const [got, setGot] = useState<{ agentId: string; state: ChatState } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const fileId = session ?? agentId;
    if (!fileId) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      // A session running alongside a pane chat's Claude reads its own transcript (chat/paneSubagents.ts).
      (session ? chatApi.paneSession : pane ? chatApi.paneSubagent : chatApi.subagent)(projectId, workstream, fileId)
        .then(r => { if (alive) { setGot({ agentId: fileId, state: fromHistory(r.entries) }); setFailed(null); } })
        .catch((err: { response?: { data?: { code?: string } } }) => {
          if (alive) setFailed(READ_FAILED[err?.response?.data?.code ?? ''] ?? "Couldn't read its steps from the box.");
        })
        .finally(() => { if (alive && running) timer = setTimeout(read, AGENT_TAB_POLL_MS); });
    };
    read();
    return () => { alive = false; clearTimeout(timer); };
  }, [projectId, workstream, agentId, running, pane, session]);
  const state = got && got.agentId === (session ?? agentId) ? got.state : null;
  return { items: state?.items ?? null, state, failed };
}

/**
 * Its messages to show: the file's once read (unless what streamed is further
 * along), else what streamed. Its brief and its report are shown around them,
 * so its first prompt goes, and so does a last message that is its report.
 */
export function agentTranscript(view: Pick<SubagentView, 'items' | 'prompt' | 'report' | 'status'> & Partial<Pick<SubagentView, 'paneSession'>>, file: ChatItem[] | null): ChatItem[] {
  // Each without its brief before they are weighed: the file has it, and a background subagent's stream often hasn't.
  // A session running alongside has no brief: its first message is someone's, and stays.
  const unbriefed = (list: ChatItem[]) => {
    if (view.paneSession) return list;
    const first = list[0];
    return first?.kind === 'user' && (view.prompt == null || first.text.trim() === view.prompt.trim()) ? list.slice(1) : list;
  };
  const live = unbriefed(view.items);
  const read = file ? unbriefed(file) : null;
  let items = read && read.length >= live.length ? read : live;
  const last = items[items.length - 1];
  if (view.status !== 'running' && view.report && last?.kind === 'text' && last.text.trim() === view.report.trim()) items = items.slice(0, -1);
  return items;
}

/** "Explore · claude-sonnet-5-5 · 45s · 6 tool calls · 23.9k tokens". */
function meta(view: SubagentView, now: number): string {
  const ms = subagentElapsed(view, now);
  return [
    view.agentType,
    view.model,
    ms != null ? agentDuration(ms) : null,
    view.toolUses != null ? `${view.toolUses} ${view.toolUses === 1 ? 'tool call' : 'tool calls'}` : null,
    view.tokens != null ? `${formatTokens(view.tokens)} tokens` : null,
  ].filter(Boolean).join(' · ');
}

/** Scrolls the chat to the subagent's row and marks it for a moment. False when the row isn't drawn (an earlier part of the chat not loaded yet). */
function showInChat(id: string): boolean {
  const row = document.getElementById(`agent-call-${id}`);
  if (!row) return false;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.remove('agent-call-flash');
  void row.offsetWidth;
  row.classList.add('agent-call-flash');
  return true;
}

/** How far a subagent's end is settled: a stop can still turn out done or failed. */
const SETTLED: Record<SubagentStatus, number> = { running: 0, stopped: 1, done: 2, failed: 2 };

/**
 * What a subagent started (chat-nested-agents-enabled): what streamed of its
 * own Agent calls, and those its file has that didn't stream, settled with it.
 * One the file has further along takes the file's end: its status, report and totals. Only one
 * that streamed opens a tab: a tab finds its subagent in the chat.
 */
export function tabSubagents(view: SubagentView | null, file: Pick<ChatState, 'items' | 'subagents'> | null): { list: SubagentView[]; live: ReadonlySet<string> } {
  const live = view ? nestedSubagents(view) : [];
  const ids = new Set(live.map(v => v.id));
  const read = view && file ? subagentsOf({ items: file.items, subagents: file.subagents, running: view.status === 'running' }) : [];
  const byId = new Map<string, SubagentView>(read.map(v => [v.id, v]));
  for (const v of live) {
    const filed = byId.get(v.id);
    byId.set(v.id, filed && SETTLED[filed.status] > SETTLED[v.status]
      ? {
        ...v,
        call: filed.call,
        status: filed.status,
        step: null,
        report: filed.report ?? v.report,
        durationMs: filed.durationMs ?? v.durationMs,
        tokens: filed.tokens ?? v.tokens,
        toolUses: filed.toolUses ?? v.toolUses,
      }
      : v);
  }
  return { list: [...byId.values()], live: ids };
}

export function AgentTab({ project, workstream, agent, openAgent }: { project: Project; workstream: string; agent: AgentTabRef; openAgent?: (agent: AgentTabRef) => void }) {
  const chat = `${project.id}|${workstream}`;
  const list = useChatSubagents(agent.chat === chat ? chat : null);
  // A nested subagent's tab (chat-nested-agents-enabled) finds it under the one that started it.
  const view = list ? findSubagent(list, agent.id) : null;
  const running = view?.status === 'running';
  const now = useTicking(running);
  const file = useAgentFile(project.id, workstream, view?.agentId ?? null, running, view?.pane === true, view?.paneSession ?? null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [missed, setMissed] = useState(false);
  // The chat's row for this subagent says its tab is on screen.
  useEffect(() => {
    subagentStore.setShown(chat, agent.id);
    return () => { if (subagentStore.shown(chat) === agent.id) subagentStore.setShown(chat, null); };
  }, [chat, agent.id]);
  const items = useMemo(() => (view ? agentTranscript(view, file.items) : []), [view, file.items]);
  const entries = useMemo(() => groupToolRuns(items), [items]);
  const started = useMemo(() => tabSubagents(view, file.state), [view, file.state]);
  const openStarted = useMemo(() => (openAgent ? (v: SubagentView) => openAgent({ chat, id: v.id, title: v.description }) : null), [openAgent, chat]);
  const opensStarted = useMemo(() => (v: SubagentView) => started.live.has(v.id), [started]);
  const agentsUi = useTabSubagentsUi(started.list, openStarted, opensStarted);

  if (!view) {
    return (
      <div className="agent-panel agent-panel-empty">
        <span className="agent-panel-title">{agent.title}</span>
        <span className="agent-panel-meta">{!list ? 'Its session is loading…' : isPaneSessionTab(agent.id) ? 'This session is no longer running alongside.' : 'This subagent is no longer in the session.'}</span>
      </div>
    );
  }
  return (
    <div className="agent-panel" aria-label={`Subagent: ${view.description}`}>
      <div className="agent-panel-head">
        <div className="agent-panel-row">
          <span className="agent-pill" data-status={view.status}><SubagentMark status={view.status} />{STATUS_WORD[view.status]}</span>
          {/* A pane chat draws no row for an Agent call (chat/paneSubagents.ts): nothing to show. */}
          {!view.pane && (
            <Button variant="minimal" size="small" className="agent-panel-jump" onPress={() => setMissed(!showInChat(view.id))}>
              <Icon name="arrow-up-thin" size="small" />Show in chat
            </Button>
          )}
        </div>
        <h3 className="agent-panel-title">{view.description}</h3>
        <div className="agent-panel-meta">{meta(view, now)}{missed ? ' · its row is further up the chat' : ''}</div>
      </div>
      <div className="agent-panel-body">
        {view.prompt && (
          <section className="agent-brief" data-open={briefOpen || undefined}>
            <div className="agent-brief-head">
              <Icon name="robot" size="small" aria-hidden="true" />
              <span>Claude&apos;s brief</span>
              <Button variant="minimal" size="small" className="agent-brief-toggle" onPress={() => setBriefOpen(o => !o)} aria-expanded={briefOpen}>
                {briefOpen ? 'Show less' : 'Show all'}
              </Button>
            </div>
            <div className="agent-brief-text">{view.prompt}</div>
          </section>
        )}
        <div className="agent-transcript sdk-transcript">
          <SubagentsContext.Provider value={agentsUi}>
            {entries.map((e, i) => (e.kind === 'tools'
              ? <ToolRun key={e.key} runKey={e.key} tools={e.tools} leadIn={e.leadIn} settled={!running || i < entries.length - 1} />
              : <ItemView key={e.item.key} item={e.item} projectId={project.id} workstream={workstream} />))}
          </SubagentsContext.Provider>
          {items.length === 0 && (
            <p className="agent-panel-note">
              {file.failed ?? (running ? 'Its steps show here as it works.' : view.agentId ? 'Reading its steps from the box…' : 'Its steps were not recorded.')}
            </p>
          )}
          {items.length > 0 && file.failed && <p className="agent-panel-note">{file.failed} This is what streamed.</p>}
        </div>
        {/* What it is doing now, while no call of its own says so. */}
        {running && view.step && !items.some(it => it.kind === 'tool' && !it.done) && (
          <div className="agent-panel-step"><SubagentMark status="running" />{view.step}</div>
        )}
        {view.status !== 'running' && view.report && (
          <section className="agent-result" data-status={view.status}>
            <div className="agent-result-head">
              <SubagentMark status={view.status} />
              {view.status === 'failed' ? 'Failed' : view.status === 'stopped' ? 'Stopped. What it returned:' : 'Returned to Claude'}
            </div>
            <Markdown text={view.report} streaming={false} />
          </section>
        )}
      </div>
    </div>
  );
}
