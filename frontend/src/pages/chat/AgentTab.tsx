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
import { fromHistory, type ChatItem } from '../../chat/sdkChat';
import { subagentElapsed, agentDuration, type SubagentView } from '../../chat/subagents';
import { subagentStore, useChatSubagents } from '../../chat/subagentStore';
import { groupToolRuns } from '../../chat/toolRuns';
import { formatTokens } from '../../chat/contextUsage';
import { Markdown } from '../../chat/Markdown';
import { ItemView } from './SdkChatView';
import { ToolRun } from './ToolCards';
import { STATUS_WORD, SubagentMark, useTicking } from './Subagents';

/** How often a running subagent's file is read again. */
export const AGENT_TAB_POLL_MS = 4000;

const READ_FAILED: Record<string, string> = {
  'runner-update': "This box's agent needs an update before it can show a subagent's steps.",
  'box-away': "The box isn't connected, so its steps can't be read.",
  'subagent-missing': 'The box has no record of its steps.',
};

/** Its messages from the box's file while `agentId` is known: again every few seconds while it runs, once more when it ends. */
function useAgentFile(projectId: string, workstream: string, agentId: string | null, running: boolean) {
  const [got, setGot] = useState<{ agentId: string; items: ChatItem[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!agentId) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      chatApi.subagent(projectId, workstream, agentId)
        .then(r => { if (alive) { setGot({ agentId, items: fromHistory(r.entries).items }); setFailed(null); } })
        .catch((err: { response?: { data?: { code?: string } } }) => {
          if (alive) setFailed(READ_FAILED[err?.response?.data?.code ?? ''] ?? "Couldn't read its steps from the box.");
        })
        .finally(() => { if (alive && running) timer = setTimeout(read, AGENT_TAB_POLL_MS); });
    };
    read();
    return () => { alive = false; clearTimeout(timer); };
  }, [projectId, workstream, agentId, running]);
  return { items: got && got.agentId === agentId ? got.items : null, failed };
}

/**
 * Its messages to show: the file's once read (unless what streamed is further
 * along), else what streamed. Its brief and its report are shown around them,
 * so its first prompt goes, and so does a last message that is its report.
 */
export function agentTranscript(view: Pick<SubagentView, 'items' | 'prompt' | 'report' | 'status'>, file: ChatItem[] | null): ChatItem[] {
  // Each without its brief before they are weighed: the file has it, and a background subagent's stream often hasn't.
  const unbriefed = (list: ChatItem[]) => {
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

export function AgentTab({ project, workstream, agent }: { project: Project; workstream: string; agent: AgentTabRef }) {
  const chat = `${project.id}|${workstream}`;
  const list = useChatSubagents(agent.chat === chat ? chat : null);
  const view = list?.find(v => v.id === agent.id) ?? null;
  const running = view?.status === 'running';
  const now = useTicking(running);
  const file = useAgentFile(project.id, workstream, view?.agentId ?? null, running);
  const [briefOpen, setBriefOpen] = useState(false);
  const [missed, setMissed] = useState(false);
  // The chat's row for this subagent says its tab is on screen.
  useEffect(() => {
    subagentStore.setShown(chat, agent.id);
    return () => { if (subagentStore.shown(chat) === agent.id) subagentStore.setShown(chat, null); };
  }, [chat, agent.id]);
  const items = useMemo(() => (view ? agentTranscript(view, file.items) : []), [view, file.items]);
  const entries = useMemo(() => groupToolRuns(items), [items]);

  if (!view) {
    return (
      <div className="agent-panel agent-panel-empty">
        <span className="agent-panel-title">{agent.title}</span>
        <span className="agent-panel-meta">{list ? 'This subagent is no longer in the session.' : 'Its session is loading…'}</span>
      </div>
    );
  }
  return (
    <div className="agent-panel" aria-label={`Subagent: ${view.description}`}>
      <div className="agent-panel-head">
        <div className="agent-panel-row">
          <span className="agent-pill" data-status={view.status}><SubagentMark status={view.status} />{STATUS_WORD[view.status]}</span>
          <Button variant="minimal" size="small" className="agent-panel-jump" onPress={() => setMissed(!showInChat(view.id))}>
            <Icon name="arrow-up-thin" size="small" />Show in chat
          </Button>
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
          {entries.map((e, i) => (e.kind === 'tools'
            ? <ToolRun key={e.key} runKey={e.key} tools={e.tools} leadIn={e.leadIn} settled={!running || i < entries.length - 1} />
            : <ItemView key={e.item.key} item={e.item} projectId={project.id} workstream={workstream} />))}
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
