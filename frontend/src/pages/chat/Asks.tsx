// Asks in the SDK chat (behind
// chat-subagents-enabled): a Bash call that runs `termag ask` is a row for the
// ask it sent, like a subagent's, saying where it is and whether the chat's
// agent (by its provider's name, chat/asks.ts askAgentName) is waiting for its reply. A run's asks fold into one quiet line while the run
// is shut ("Asked 3 agents · on termag-4 · 2 working"), which opens to their
// rows. The chat view provides what they read (chat/asks.ts askViews). Each
// is a LaunchPad Button laid out as a row, as a subagent's is. With
// chat-nested-agents-enabled, a kept ask's row has what its own session runs
// under it: its subagents and its asks (SessionAgentsRows).
import React, { createContext, useState } from 'react';
import { Button } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { useNavigate } from 'react-router-dom';
import { askAgentName, askDuration, askElapsed, askLine, askRowSub, askTold, askWaitingText, capitalized, asksSummary, isAskActive, targetBox, UNKNOWN_AGENT, type AskCall, type AskState, type AskView } from '../../chat/asks';
import type { SubagentStatus } from '../../chat/subagents';
import type { ToolItem } from '../../chat/toolRuns';
import { NESTED_DEPTH, NestedRows, SubagentMark, SubagentRow, useTicking } from './Subagents';
import { useSessionAgents } from '../../chat/useSessionAgents';
import { chatHref } from '../../chat/simpleChat';
import { FLAGS, useFlag } from '../../flags';

export interface AsksUi {
  /** The chat's `termag ask` calls, by tool call id. */
  calls: ReadonlyMap<string, AskCall>;
  /** The threads each call is about (chat/asks.ts callThreads). */
  byCall: ReadonlyMap<string, string[]>;
  /** Each thread's view. */
  views: ReadonlyMap<string, AskView>;
  /** Shows an ask: its tab in the side panel (AskTab.tsx). */
  open: (view: AskView) => void;
  /** The thread whose ask is on screen, if any. */
  shownThread: string | null;
  /** What the words call the chat's agent: "Codex", or "the agent" (chat/asks.ts askAgentName). */
  agent: string;
}

/** The chat's asks for its `termag ask` calls; null where they are off: the call is a Bash card. */
export const AsksContext = createContext<AsksUi | null>(null);

const MARK: Record<AskState, SubagentStatus> = { queued: 'running', starting: 'running', working: 'running', done: 'done', failed: 'failed', canceled: 'stopped' };
export const ASK_STATE_WORD: Record<AskState, string> = { queued: 'Queued', starting: 'Starting', working: 'Working', done: 'Done', failed: 'Failed', canceled: 'Canceled' };

export function AskMark({ state }: { state: AskState }) {
  return <SubagentMark status={MARK[state]} />;
}

/** The asks a call is about, as views; none while the call names no thread the chat knows. */
export function askViewsOf(ui: AsksUi, item: ToolItem): AskView[] {
  return (ui.byCall.get(item.id) ?? []).flatMap(th => {
    const v = ui.views.get(th);
    return v ? [v] : [];
  });
}

/** Whether a tool call shows as an ask's row here. */
export function isAskRow(ui: AsksUi | null, item: ToolItem): boolean {
  return ui != null && ui.calls.has(item.id) && askViewsOf(ui, item).length > 0;
}

/**
 * Whether the chat's agent (`agent`) is waiting for the ask's reply, as a
 * tag: an ask sent with `--no-wait` says so on its row, so nobody waits on it
 * for an answer that isn't coming back.
 */
export function AskWaiting({ view, agent }: { view: AskView; agent: string }) {
  const text = askWaitingText(view, agent);
  if (!text) return null;
  const tip = view.waiting === 'agent'
    ? `A command in this chat is waiting for its reply, and ${agent} will read it.`
    : askTold(view)
      ? `termag tells this chat when the ask finishes, and ${agent} reads its reply then. Open the ask to read its answer.`
      : view.noWait
        ? `${capitalized(agent)} sent this with --no-wait and carries on without the reply, and nothing tells this chat when it finishes. The reply is kept for termag ask --reply. Open the ask to read its answer.`
        : 'Nothing in this chat is waiting for its reply. Open the ask to read its answer.';
  return <span className="ask-waiting" data-waiting={view.waiting} title={tip}>{text}</span>;
}

/** One ask a call sent or followed up on: "Ask · <title> · on termag-4 · working · 1m 4s · Codex isn't waiting for a reply · View". */
export function AskRow({ view, call, ui, anchor }: { view: AskView; call: AskCall | null; ui: AsksUi; anchor?: string }) {
  const now = useTicking(view.state === 'working');
  const shown = ui.shownThread === view.thread;
  const box = targetBox(view.target);
  const followUp = call?.followUp === view.thread;
  return (
    <div className="sdk-tool agent-call ask-call" id={anchor} data-thread={view.thread} data-status={view.state} data-shown={shown || undefined}>
      {/* Always opens: its tab says when the ask is still being looked up, or ran with no session of its own. */}
      <Button variant="minimal" className="agent-call-head" onPress={() => ui.open(view)}
        aria-label={`${view.title}: ${ASK_STATE_WORD[view.state].toLowerCase()}. ${askWaitingText(view, ui.agent) ?? ''} Open the ask`}>
        <AskMark state={view.state} />
        <span className="sdk-tool-title">{followUp ? 'Follow-up' : 'Ask'}</span>
        <span className="sdk-tool-intent">{view.title}</span>
        {box && <span className="agent-type" title={view.target ?? undefined}>{box}</span>}
        <span className="agent-call-line">{askLine(view, now)}</span>
        <AskWaiting view={view} agent={ui.agent} />
        <span className="agent-call-open" aria-hidden="true">
          <Icon name="sidebar-right-expand" size="small" />{shown ? 'Open' : 'View'}
        </span>
      </Button>
    </div>
  );
}

/** A `termag ask` call: a row per ask it is about (a loop can send several). */
export function AskCallRow({ item, ui }: { item: ToolItem; ui: AsksUi }) {
  const call = ui.calls.get(item.id) ?? null;
  return (
    <>
      {askViewsOf(ui, item).map(v => <AskRow key={v.thread} view={v} call={call} ui={ui} anchor={`ask-call-${item.id}-${v.thread}`} />)}
    </>
  );
}

/**
 * A shut run's asks as one quiet line: their marks, "Asked 3 agents", where,
 * how they stand and whether the chat's agent is waiting. Opened, a row each.
 */
export function AsksLine({ items, ui }: { items: readonly ToolItem[]; ui: AsksUi }) {
  const [open, setOpen] = useState(false);
  const pairs = items.flatMap(item => askViewsOf(ui, item).map(view => ({ item, view })));
  const views = [...new Map(pairs.map(p => [p.view.thread, p.view])).values()];
  if (!views.length) return null;
  const sends = items.filter(it => !ui.calls.get(it.id)?.followUp).length;
  const lead = sends === 0
    ? `Followed up on ${views.length === 1 ? views[0].title : `${views.length} agents`}`
    : `Asked ${views.length} ${views.length === 1 ? 'agent' : 'agents'}`;
  const boxes = [...new Set(views.map(v => targetBox(v.target)).filter(Boolean))];
  const active = views.some(v => isAskActive(v.state));
  const nobody = views.every(v => v.waiting === 'nobody' && v.noWait && !askTold(v));
  const Agent = capitalized(ui.agent);
  const waiting = nobody ? (active ? `${Agent} isn’t waiting for replies` : `Not sent back to ${ui.agent}`)
    : views.every(v => v.waiting === 'agent') ? `${Agent} is waiting` : null;
  const detail = [boxes.length === 1 ? `on ${boxes[0]}` : null, asksSummary(views)].filter(Boolean).join(' · ');
  return (
    <div className="ask-line" data-open={open || undefined} data-active={active || undefined} data-threads={views.map(v => v.thread).join(' ')}>
      <Button variant="minimal" className="ask-line-head" onPress={() => setOpen(o => !o)} aria-expanded={open}
        id={`ask-line-${items[0].id}`}>
        <span className="agent-drawer-marks" aria-hidden="true">{views.slice(0, 5).map(v => <AskMark key={v.thread} state={v.state} />)}</span>
        <span className="ask-line-lead">{lead}</span>
        <span className="ask-line-detail">· {detail}</span>
        {waiting && <span className="ask-waiting" data-waiting={nobody ? 'nobody' : 'agent'}>{waiting}</span>}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size="small" className="ask-line-chevron" />
      </Button>
      {open && (
        <div className="ask-line-rows">
          {pairs.map(p => <AskRow key={`${p.item.id}:${p.view.thread}`} view={p.view} call={ui.calls.get(p.item.id) ?? null} ui={ui} anchor={`ask-call-${p.item.id}-${p.view.thread}`} />)}
        </div>
      )}
    </div>
  );
}

/**
 * One ask kept in view: its mark, its title, where it is and whether the chat's agent is waiting, and its time.
 * Opens its tab, or with `onOpen` that instead (an ask another session sent, SessionAgentsRows); `agent` names
 * the agent that sent it, where that isn't the chat's (ui.agent).
 */
export function AskKeptRow({ view, ui, onOpen, agent }: { view: AskView; ui?: AsksUi | null; onOpen?: () => void; agent?: string }) {
  const now = useTicking(view.state === 'working');
  const ms = askElapsed(view, now);
  const sender = agent ?? ui?.agent ?? UNKNOWN_AGENT;
  return (
    <Button variant="minimal" className="agent-row ask-row" data-shown={ui?.shownThread === view.thread || undefined} onPress={() => (onOpen ? onOpen() : ui?.open(view))}
      aria-label={`${view.title}: ${askRowSub(view, sender)}. ${onOpen ? 'Open its session' : 'Open the ask'}`}>
      <AskMark state={view.state} />
      <span className="agent-row-text">
        <span className="agent-row-name">{view.title}</span>
        <span className="agent-row-sub">{askRowSub(view, sender)}</span>
      </span>
      {ms != null && <span className="agent-row-time">{askDuration(ms)}</span>}
    </Button>
  );
}

/** An ask's own chat runs Claude (backend services/askChat.ts ASK_CHAT_PROVIDER). */
const ASK_CHAT_PROVIDER = 'claude-chat';

/**
 * The agents a session runs, as rows nested under its row (chat-nested-agents-enabled): its Claude's subagents, then the asks it sent, each with its own under it while
 * `depth` allows (NESTED_DEPTH). Read while on screen (chat/useSessionAgents.ts). Each opens its session: it is
 * not this chat's, so it has no tab beside it.
 */
export function SessionAgentsRows({ chat, provider, working, depth, sender }: {
  chat: { projectId: string; workstream: string }; provider: string; working: boolean; depth: number;
  /** What the session's agent is called, for its asks' words. */
  sender: string;
}) {
  const agents = useSessionAgents(chat.projectId, chat.workstream, provider, working, true);
  const navigate = useNavigate();
  if (!agents || (!agents.subagents.length && !agents.asks.length)) return null;
  const go = (to: { projectId: string; workstream: string }) => navigate(chatHref(to.projectId, to.workstream));
  return (
    <NestedRows label="Agents it runs">
      {agents.subagents.map(v => <SubagentRow key={v.id} view={v} onOpen={() => go(chat)} />)}
      {agents.asks.map(v => (
        <React.Fragment key={v.thread}>
          <AskKeptRow view={v} agent={sender} onOpen={() => go(v.chat ?? chat)} />
          {v.chat && depth < NESTED_DEPTH && (
            <SessionAgentsRows chat={v.chat} provider={ASK_CHAT_PROVIDER} working={isAskActive(v.state)} depth={depth + 1} sender={askAgentName(ASK_CHAT_PROVIDER)} />
          )}
        </React.Fragment>
      ))}
    </NestedRows>
  );
}

/**
 * An ask kept in view and, with chat-nested-agents-enabled, what its own session runs under it: its subagents
 * and the asks it sent (SessionAgentsRows), read while its row is on screen.
 */
export function AskBranch({ view, ui }: { view: AskView; ui: AsksUi }) {
  const nestedOn = useFlag(FLAGS.chatNestedAgents, false);
  return (
    <>
      <AskKeptRow view={view} ui={ui} />
      {nestedOn && view.chat && (
        <SessionAgentsRows chat={view.chat} provider={ASK_CHAT_PROVIDER} working={isAskActive(view.state)} depth={1} sender={askAgentName(ASK_CHAT_PROVIDER)} />
      )}
    </>
  );
}

/** The context card's Asks (SessionContextCard.tsx), after its Agents: the asks kept in view, with how they stand. */
export function AsksCardSection({ list, ui }: { list: readonly AskView[]; ui: AsksUi }) {
  if (!list.length) return null;
  return (
    <section className="ctx-section ctx-agents ctx-asks" aria-label="Asks">
      <h4 className="ctx-heading">Asks<span className="ctx-heading-aside">{asksSummary(list)}</span></h4>
      <div className="ctx-agent-rows">{list.map(v => <AskBranch key={v.thread} view={v} ui={ui} />)}</div>
    </section>
  );
}

/**
 * The drawer on the composer's top edge, for asks, while the context card
 * doesn't show them: one line, "2 asks working · Codex isn't waiting for
 * replies"; opened, their rows above it. It stays after the agent's turn ends
 * while any ask is going.
 */
export function AsksDrawer({ list, ui }: { list: readonly AskView[]; ui: AsksUi }) {
  const [open, setOpen] = useState(false);
  if (!list.length) return null;
  const active = list.filter(v => isAskActive(v.state));
  const nobody = list.every(v => v.waiting === 'nobody' && v.noWait && !askTold(v));
  const lead = active.length
    ? `${active.length} ${active.length === 1 ? 'ask' : 'asks'} working`
    : `${list.length} ${list.length === 1 ? 'ask' : 'asks'} ${list.every(v => v.state === 'done') ? 'finished' : 'ended'}`;
  // After the lead, only what it doesn't say: the ended ones while some still go, and whether the agent is waiting.
  const waiting = nobody ? (active.length ? `${capitalized(ui.agent)} isn’t waiting for replies` : `Not sent back to ${ui.agent}`)
    : list.every(v => v.waiting === 'agent') ? `${capitalized(ui.agent)} is waiting`
    : list.every(v => v.reply === 'delivered') ? `Returned to ${ui.agent}` : null;
  const rest = active.length ? asksSummary(list.filter(v => !isAskActive(v.state))) : '';
  const detail = [rest || null, waiting].filter(Boolean).join(' · ');
  return (
    <div className="agent-drawer ask-drawer" data-open={open || undefined} data-done={!active.length || undefined}>
      {open && <div className="agent-drawer-list" id="ask-drawer-list">{list.map(v => <AskBranch key={v.thread} view={v} ui={ui} />)}</div>}
      <Button variant="minimal" className="agent-drawer-head" onPress={() => setOpen(o => !o)} aria-expanded={open} aria-controls={open ? 'ask-drawer-list' : undefined}>
        <span className="agent-drawer-marks" aria-hidden="true">{list.slice(0, 5).map(v => <AskMark key={v.thread} state={v.state} />)}</span>
        <span className="agent-drawer-lead">{lead}</span>
        {detail && <span className="agent-drawer-now">· {detail}</span>}
        <Icon name={open ? 'chevron-down' : 'chevron-up'} size="small" className="agent-drawer-chevron" />
      </Button>
    </div>
  );
}
