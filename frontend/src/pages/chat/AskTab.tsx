// The side panel's ask tab (behind
// chat-subagents-enabled): one ask's own session, which is a chat on its
// target project (the thread's `ask-<thread>` workstream). Where it is and
// whether the chat's agent is waiting for its reply, then each turn: the
// brief the agent sent, what the ask did, and the answer it gave. The agent is
// named by the chat's provider (chat/asks.ts askAgentName). Its state is the open
// chat's (chat/askStore.ts). Its messages are the ask chat's history
// (GET …/chat on the target project), read when the tab opens, every few
// seconds while the ask is going, and once more when it ends: nothing is
// read for an ask until someone opens it.
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { chatApi } from '../../services/api';
import type { Project } from '../../types';
import type { AgentTabRef } from '../../chat/panelTabs';
import { fromHistory, type ChatItem, type ChatState } from '../../chat/sdkChat';
import { subagentsOf, type SubagentView } from '../../chat/subagents';
import { askAgentName, askLine, askWaitingText, capitalized, isAskActive, type AskView } from '../../chat/asks';
import { askThreadOf, useChatAskViews } from '../../chat/askStore';
import { subagentStore } from '../../chat/subagentStore';
import { chatHref, chatProvider } from '../../chat/simpleChat';
import { groupToolRuns } from '../../chat/toolRuns';
import { Markdown } from '../../chat/Markdown';
import { ItemView } from './SdkChatView';
import { ToolRun } from './ToolCards';
import { ASK_STATE_WORD, AskMark } from './Asks';
import { SubagentsContext, useTabSubagentsUi, useTicking } from './Subagents';

/** How often an ask's chat is read again while it is going. */
export const ASK_TAB_POLL_MS = 4000;

/** The ask's chat, read while `chat` is known: again every few seconds while `going`, once more when it stops. */
function useAskChat(chat: AskView['chat'], going: boolean) {
  const [got, setGot] = useState<{ key: string; state: ChatState } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const key = chat ? `${chat.projectId}|${chat.workstream}` : '';
  useEffect(() => {
    if (!chat) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      chatApi.history(chat.projectId, chat.workstream)
        .then(r => { if (alive) { setGot({ key, state: fromHistory(r.entries, r.sessionId, r.turn ?? null, [], { running: r.running }) }); setFailed(null); } })
        .catch(() => { if (alive) setFailed("Couldn't read the ask's session."); })
        .finally(() => { if (alive && going) timer = setTimeout(read, ASK_TAB_POLL_MS); });
    };
    read();
    return () => { alive = false; clearTimeout(timer); };
  }, [key, going]);
  const state = got && got.key === key ? got.state : null;
  return { items: state?.items ?? null, state, failed };
}

/**
 * The ask's chat as turns: each opens with the message that started it (the
 * brief the chat's agent sent, or a follow-up), then what the ask did. A finished
 * ask's last words are its answer, shown on their own.
 */
export function askTurns(items: readonly ChatItem[], ended: boolean): { turns: Array<{ brief: string | null; items: ChatItem[] }>; answer: string | null } {
  const turns: Array<{ brief: string | null; items: ChatItem[] }> = [];
  for (const it of items) {
    if (it.kind === 'user' && !it.midTurn) { turns.push({ brief: it.text, items: [] }); continue; }
    if (!turns.length) turns.push({ brief: null, items: [] });
    turns[turns.length - 1].items.push(it);
  }
  const last = turns[turns.length - 1];
  const tail = last?.items[last.items.length - 1];
  if (!ended || tail?.kind !== 'text' || !tail.text.trim()) return { turns, answer: null };
  return { turns: [...turns.slice(0, -1), { ...last, items: last.items.slice(0, -1) }], answer: tail.text };
}

/**
 * How the chat's agent (`agent`, askAgentName) gets the reply, as the tab
 * says it: plainly, and why. A call in the chat waiting for it; else termag's
 * finish notice, which tells the chat and the agent reads the reply then;
 * else nothing, and the reply is kept for `termag ask --reply` (stored replies
 * last 14 days). Text in backticks is a command, drawn as code.
 */
export function waitingNote(v: AskView, agent: string): { lead: string; text: string; tone: 'quiet' | 'waiting' } | null {
  const lead = askWaitingText(v, agent);
  if (!lead) return null;
  const Agent = capitalized(agent);
  const active = isAskActive(v.state);
  const ended = v.state === 'done' ? 'finished' : 'ended';
  const answer = v.state === 'done' ? ' Its answer is below.' : '';
  if (v.reply === 'delivered') return { lead, text: 'A command in the chat got its reply.', tone: 'quiet' };
  if (v.waiting === 'agent') return { lead, text: `A command in the chat is waiting for its reply, and ${agent} reads it when the ask finishes.`, tone: 'waiting' };
  // A pane chat's ask (v.noRow) has no call to read: nothing says whether a command there waits for it.
  const why = v.noWait ? `${Agent} sent it with --no-wait and carried on` : v.noRow ? null : 'Nothing in the chat is waiting for it any more';
  /** `rest` after the why, or as a sentence of its own where there is none ("termag" keeps its lower case). */
  const after = (joined: string, rest: string) => (why ? `${why}${joined}${rest}` : rest.startsWith('termag') ? rest : rest.charAt(0).toUpperCase() + rest.slice(1));
  if (v.notice === 'due') {
    return active
      ? { lead, text: `${why ? `${why}. ` : ''}When the ask finishes, termag tells the chat, and ${agent} reads its reply then.`, tone: 'quiet' }
      : { lead, text: `The ask has ${ended}, and termag tells the chat in a moment. ${Agent} reads its reply then.`, tone: 'quiet' };
  }
  if (v.notice === 'sent') {
    const read = v.reply === 'stored' ? ` ${Agent} hasn’t read its reply yet, and \`termag ask --reply\` reads it for 14 days.`
      : v.reply === 'dropped' ? ' Its reply is no longer kept.' : '';
    return { lead, text: `termag told the chat the ask ${ended}.${read}${read ? answer : ''}`, tone: 'quiet' };
  }
  if (active) return { lead, text: `${after(', and ', 'nothing tells the chat when it finishes.')} Its reply is kept for 14 days: \`termag ask --reply\` reads it, and its answer shows here.`, tone: 'quiet' };
  if (v.notice === 'unsent' && v.reply === 'stored') return { lead, text: `${after(', and ', 'termag’s finish notice couldn’t reach the chat.')} Its reply is kept for 14 days, and \`termag ask --reply\` reads it.${answer}`, tone: 'quiet' };
  if (v.reply === 'stored') return { lead, text: `${after(', so ', 'nothing has read its reply.')} It is kept for 14 days, and \`termag ask --reply\` reads it.${answer}`, tone: 'quiet' };
  if (v.reply === 'dropped') return { lead, text: `${after(', so ', 'nothing got the reply, and it is no longer kept.')}${answer}`, tone: 'quiet' };
  return { lead, text: `${after(', and ', 'it left no reply.')}${answer}`, tone: 'quiet' };
}

/** A note's text with its `commands` drawn as code. */
function withCode(text: string): React.ReactNode[] {
  return text.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

/** Scrolls the chat to the ask's row (or the shut line it is folded in) and marks it for a moment. False when neither is drawn. */
function showInChat(thread: string): boolean {
  const row = document.querySelector<HTMLElement>(`.ask-call[data-thread="${thread}"]`) ?? document.querySelector<HTMLElement>(`.ask-line[data-threads~="${thread}"]`);
  if (!row) return false;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.remove('agent-call-flash');
  void row.offsetWidth;
  row.classList.add('agent-call-flash');
  return true;
}

export function AskTab({ project, workstream, agent }: { project: Project; workstream: string; agent: AgentTabRef }) {
  const chat = `${project.id}|${workstream}`;
  const thread = askThreadOf(agent.id);
  const views = useChatAskViews(agent.chat === chat ? chat : null);
  const view = thread ? views?.get(thread) ?? null : null;
  // The chat that sent the ask is this tab's: its agent is the one that asked.
  const agentName = askAgentName(chatProvider(project, workstream));
  const going = view ? isAskActive(view.state) : false;
  const now = useTicking(view?.state === 'working');
  const session = useAskChat(view?.chat ?? null, going);
  const navigate = useNavigate();
  const [missed, setMissed] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  // The chat's row for this ask says its tab is on screen.
  useEffect(() => {
    subagentStore.setShown(chat, agent.id);
    return () => { if (subagentStore.shown(chat) === agent.id) subagentStore.setShown(chat, null); };
  }, [chat, agent.id]);
  // Its own session's subagents (chat-nested-agents-enabled) open in that session, where they have their tabs.
  const started = useMemo(() => (session.state ? subagentsOf(session.state) : []), [session.state]);
  const askChat = view?.chat ?? null;
  const openStarted = useMemo(() => (askChat ? (_: SubagentView) => navigate(chatHref(askChat.projectId, askChat.workstream)) : null), [askChat?.projectId, askChat?.workstream, navigate]);
  const agentsUi = useTabSubagentsUi(started, openStarted);
  const { turns, answer } = useMemo(() => askTurns(session.items ?? [], view != null && !going), [session.items, view, going]);

  if (!view) {
    return (
      <div className="agent-panel agent-panel-empty">
        <span className="agent-panel-title">{agent.title}</span>
        <span className="agent-panel-meta">{views ? 'This ask is no longer in the session.' : 'Its session is loading…'}</span>
      </div>
    );
  }
  const note = waitingNote(view, agentName);
  const target = view.target ?? 'its target';
  return (
    <div className="agent-panel ask-panel" aria-label={`Ask: ${view.title}`}>
      <div className="agent-panel-head">
        <div className="agent-panel-row">
          <span className="agent-pill" data-status={view.state === 'done' ? 'done' : view.state === 'failed' ? 'failed' : view.state === 'canceled' ? 'stopped' : 'running'}>
            <AskMark state={view.state} />{ASK_STATE_WORD[view.state]}
          </span>
          <span className="agent-panel-meta">Ask to <code>{target}</code></span>
          {/* A pane chat draws no row for an ask (chat/asks.ts paneAskViews): nothing to show. */}
          {!view.noRow && (
            <Button variant="minimal" size="small" className="agent-panel-jump" onPress={() => setMissed(!showInChat(view.thread))}>
              <Icon name="arrow-up-thin" size="small" />Show in chat
            </Button>
          )}
        </div>
        <h3 className="agent-panel-title">{view.title}</h3>
        <div className="agent-panel-meta">Asked by {agentName} · {askLine(view, now)}{missed ? ' · its row is further up the chat' : ''}</div>
        {note && (
          <p className="ask-waiting-note" data-tone={note.tone}>
            <strong>{note.lead}.</strong> {withCode(note.text)}
          </p>
        )}
        {view.chat && (
          <div className="ask-panel-actions">
            <Button variant="default" size="small" onPress={() => { if (view.chat) navigate(chatHref(view.chat.projectId, view.chat.workstream)); }}>
              <Icon name="arrow-up-right" size="small" />Open session
            </Button>
          </div>
        )}
      </div>
      <div className="agent-panel-body">
        {turns.map((t, i) => (
          <section key={i} className="ask-turn">
            {i > 0 && <div className="ask-turn-sep">Turn {i + 1}</div>}
            {t.brief != null && (
              <section className="agent-brief" data-open={open.has(i) || undefined}>
                <div className="agent-brief-head">
                  <Icon name="chat-bubble" size="small" aria-hidden="true" />
                  <span>{i === 0 ? `${capitalized(agentName)}’s brief` : 'Follow-up'}</span>
                  <Button variant="minimal" size="small" className="agent-brief-toggle" aria-expanded={open.has(i)}
                    onPress={() => setOpen(s => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })}>
                    {open.has(i) ? 'Show less' : 'Show all'}
                  </Button>
                </div>
                <div className="agent-brief-text">{t.brief}</div>
              </section>
            )}
            <div className="agent-transcript sdk-transcript">
              <SubagentsContext.Provider value={agentsUi}>
                {groupToolRuns(t.items).map((e, j, all) => (e.kind === 'tools'
                  ? <ToolRun key={e.key} runKey={e.key} tools={e.tools} leadIn={e.leadIn} settled={!going || i < turns.length - 1 || j < all.length - 1} />
                  : <ItemView key={e.item.key} item={e.item} projectId={view.chat?.projectId ?? project.id} workstream={view.chat?.workstream ?? workstream} />))}
              </SubagentsContext.Provider>
            </div>
          </section>
        ))}
        {session.items == null && (
          <p className="agent-panel-note">
            {session.failed ?? (view.chat ? 'Reading its session…'
              : view.known ? 'This ask ran without a session of its own, so there is nothing to show.'
              : 'Looking up this ask…')}
          </p>
        )}
        {session.items != null && turns.length === 0 && <p className="agent-panel-note">{going ? 'Its turn shows here as it works.' : 'Its session has nothing in it.'}</p>}
        {session.items != null && session.failed && <p className="agent-panel-note">{session.failed} This is what it last showed.</p>}
        {answer && (
          <section className="agent-result" data-status="done">
            <div className="agent-result-head"><AskMark state="done" />Its answer</div>
            <Markdown text={answer} streaming={false} />
          </section>
        )}
        {view.state === 'failed' && (
          <section className="agent-result" data-status="failed">
            <div className="agent-result-head"><AskMark state="failed" />Failed</div>
            <p className="agent-panel-note">{view.error ?? 'The ask failed.'}</p>
          </section>
        )}
      </div>
    </div>
  );
}
