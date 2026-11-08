// One conversation in the simple UI: the workstream's agent pane captured and
// parsed into turns (chat/paneChat.ts, as the phone does), one status line,
// answer keys only while the agent waits, the asks it sent and its Claude's
// subagents in a drawer on the composer, and a composer that types into the pane. No terminal is shown here: Open in Lab is the way to one. While
// the chat comes up (box, clone, Claude) it narrates the steps, and a message
// typed before Claude is there waits and is sent once it is.
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useProjects } from '../../contexts/ProjectContext';
import { activityApi, sessionsApi, visitsApi } from '../../services/api';
import { PROVIDERS } from '../../providers/registry';
import { boxFeed } from '../../services/boxFeed';
import { useSetupContext } from '../../hooks/useSetupContext';
import { cloneTile } from '../../utils/cloneTile';
import { sessionName } from '../../utils/sessionName';
import { statusKey } from '../../utils/statusKey';
import { parsePane } from '../../chat/paneChat';
import { BlockView, DraftView } from '../../chat/Blocks';
import { chatNoticePlacement } from '../../chat/chatNotices';
import { useChatNotices } from '../../chat/useChatNotices';
import { RestartNotice } from '../../chat/RestartNotice';
import { draftAfterSend, flattenForSend, MAX_KEYS, sendErrorText } from '../../chat/compose';
import { useFollowBottom } from '../../chat/useFollowBottom';
import { useAutoGrow } from '../../chat/useAutoGrow';
import { useTranscriptFocus } from '../../chat/transcriptFocus';
import { quickKeys, QuickKey } from '../../chat/quickKeys';
import { useCapture } from '../../chat/useCapture';
import { conversationBlocks, fullUiHref, repoSlug, showAnswerKeys, statusLine } from '../../chat/simpleChat';
import { desktopSessionHref, openDesktopLink } from '../../chat/desktopLinks';
import { agentUp, bootEstimateMinutes, preLaunchTail, setupSteps, showSetup } from '../../chat/newChat';
import { SetupSteps } from '../../chat/SetupSteps';
import { useQueuedMessage } from '../../chat/useQueuedMessage';
import { useComposerText } from '../../chat/useHandedDraft';
import { ClaudeLoginCard } from '../../chat/ClaudeLoginCard';
import { claudeSignInApplies } from '../../chat/claudeLogin';
import { REPLAY_BLOCK_CLASS } from '../../observability';
import { providerFor, STATUS_GLYPH } from '../../mobile/inbox';
import { FLAGS, useFlag } from '../../flags';
import { ChatHistoryButton, ChatMoreButton, SidePanelButton, useChatChrome } from './chatChrome';
import { SessionRepoPill } from './SessionRepoPill';
import { AgentIcon } from './OpenItems';
import { ChatSpaceChip } from './SpaceSwatch';
import { useDictation } from '../../chat/useDictation';
import { DictationButton, DictationNote } from '../../chat/DictationButton';
import { SendIcon } from '../../chat/ComposerIcons';
import { ChatBoxTag } from './ChatBoxTag';
import { useSimpleDataIfAny } from './simpleData';
import { recordTypedChatCommand } from '../../usageEvents';
import { AsksDrawer } from './Asks';
import { usePaneAsksUi } from '../../chat/useChatAsks';
import { askStore, askTabId, askThreadOf } from '../../chat/askStore';
import { useShownSubagent } from '../../chat/subagentStore';
import { askAgentName, type AskView } from '../../chat/asks';
import { AgentsDrawer, type SubagentsUi } from './Subagents';
import { subagentStore } from '../../chat/subagentStore';
import { usePaneKeptSubagents, usePaneSubagents } from '../../chat/usePaneSubagents';
import type { SubagentView } from '../../chat/subagents';

// Remembered across conversations in this tab so visits carry a previous id.
let lastVisitedProjectId: string | null = null;

/** The drawers on the composer: one alone, or several in one frame with a line between them (chrome.css), as in the SDK chat. */
function PaneDrawers({ drawers }: { drawers: React.ReactNode[] }) {
  const shown = drawers.filter(Boolean);
  if (shown.length === 0) return null;
  return shown.length === 1 ? <>{shown[0]}</> : <div className="agent-drawer-stack">{shown}</div>;
}

export function ChatView() {
  const { projectId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { mode: chromeMode, sidePanel, refresh } = useChatChrome();
  const phone = chromeMode === 'drawer';
  const { user } = useAuth();
  const { projects, statusMap, settleProjectClone } = useProjects();

  const ws = params.get('ws') || 'main';
  const project = projects.find(p => p.id === projectId);
  const desktopHref = project ? desktopSessionHref({ projectId: project.id, workstream: ws, shared: project.role === 'collaborator' }) : null;
  const owner = project?.ownerUsername ?? user?.unixUsername ?? '';
  const workstream = project?.workstreams.find(w => w.name === ws);
  const agentSession = project ? sessionName(owner, project.name, 'agent', ws) : '';
  const status = project ? statusMap[statusKey(project.instanceId, agentSession)] : undefined;
  const provider = project ? providerFor(project, workstream?.id, status?.source) : null;
  const agentLabel = provider ? PROVIDERS[provider]?.displayName ?? provider : 'agent';
  const hasAgent = Boolean(project?.workflows.some(w => w.type === 'agent'));

  // A project still waiting for its box or its clone has no session yet.
  const setupCtx = useSetupContext(project);
  const setup = cloneTile(project?.setupStatus, setupCtx);
  const held = Boolean(project) && setup.holdTerminal;

  const capture = useCapture({
    projectId: project?.id ?? null,
    role: 'agent',
    workstream: ws,
    status: status?.status,
    statusUpdatedAt: status?.updatedAt,
    enabled: Boolean(project && hasAgent && !held),
  });
  const parsed = useMemo(
    () => (capture.content != null ? parsePane(capture.content, { provider, role: 'agent' }) : null),
    [capture.content, provider],
  );
  const blocks = useMemo(() => (parsed ? conversationBlocks(parsed.blocks) : null), [parsed]);
  // Why the session restarted, when a tool update restarted it: above the pane's
  // blocks, which are that session's; another pane's restart after them (chat/chatNotices.ts).
  const notices = useChatNotices(project && hasAgent ? project.id : null, ws, status?.status);
  const restart = useMemo(() => chatNoticePlacement(notices), [notices]);
  const offline = capture.error === 'offline';

  // The setup narration: the box from the box feed, the clone from the
  // project row, Claude from its status or its input box on screen.
  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const box = project?.instanceId ? boxes.find(b => b.id === project.instanceId) ?? null : null;
  const eta = useMemo(() => bootEstimateMinutes(boxes), [boxes]);
  const up = Boolean(project) && !held && agentUp(status?.status, parsed?.draft);
  const repo = repoSlug(project?.repoUrl);
  const steps = useMemo(() => (project ? setupSteps({
    box, setupStatus: project.setupStatus, setupError: project.setupError, repo, agentUp: up, etaMinutes: eta,
  }) : []), [project, box, repo, up, eta]);

  useEffect(() => {
    if (!project) return;
    visitsApi.record({ projectId: project.id, previousProjectId: lastVisitedProjectId, workstream: ws });
    lastVisitedProjectId = project.id;
  }, [project?.id, ws]); // eslint-disable-line react-hooks/exhaustive-deps

  const { scroller, onScroll, unseen, jumpToBottom } = useFollowBottom(blocks, `${projectId}|${ws}`);

  // Asks: the ones this pane's agent sent with `termag ask`, which the
  // orchestrator records by the pane's session, in the drawer on the composer; a row opens its ask tab in the
  // panel, which reads the views from here (chat/askStore.ts). As in the SDK chat: only with the panel's tabs.
  const chatId = `${projectId}|${ws}`;
  const subagentsOn = useFlag(FLAGS.chatSubagents, false);
  const showAgent = refresh && !phone ? sidePanel?.showAgent : undefined;
  const shownAgent = useShownSubagent(chatId);
  const openAsk = useCallback((v: AskView) => { showAgent?.({ chat: chatId, id: askTabId(v.thread), title: v.title }); }, [showAgent, chatId]);
  const asks = usePaneAsksUi({
    on: subagentsOn && showAgent != null && hasAgent, owner: project?.role !== 'collaborator', projectId: project?.id ?? '', workstream: ws,
    working: status?.status === 'working', open: openAsk, shownThread: sidePanel?.open ? askThreadOf(shownAgent) : null,
    agent: askAgentName(provider),
  });
  // None until the first answer (the ask tab says it is loading); then the views, none at all included.
  useEffect(() => { askStore.publish(chatId, asks.published); }, [chatId, asks.published]);
  useEffect(() => () => askStore.publish(chatId, null), [chatId]);
  // Subagents: the Agent-tool subagents of the pane's
  // Claude, read from beside its session by the box, in the drawer too; a row opens its agent tab, which reads
  // them from here (chat/subagentStore.ts). Behind chat-pane-subagents-enabled as well; for the session's sharees
  // too, who can open its pane anyway.
  const paneSubagentsOn = useFlag(FLAGS.chatPaneSubagents, false) && subagentsOn && showAgent != null && hasAgent && Boolean(project);
  const subagents = usePaneSubagents(project?.id ?? '', ws, status?.status === 'working', paneSubagentsOn);
  // Its subagents and the sessions running alongside it, for their tabs.
  const published = useMemo(() => (subagents.views ? [...subagents.views, ...subagents.alongside] : null), [subagents.views, subagents.alongside]);
  useEffect(() => {
    if (!paneSubagentsOn) return undefined;
    // None until the box's first answer: the agent tab says it is loading, not that its subagent is gone.
    subagentStore.publish(chatId, published);
    return undefined;
  }, [paneSubagentsOn, chatId, published]);
  useEffect(() => () => subagentStore.publish(chatId, null), [chatId]);
  const keptAgents = usePaneKeptSubagents(paneSubagentsOn ? subagents.views : null);
  const agentsUi = useMemo<SubagentsUi | null>(() => (paneSubagentsOn && showAgent ? {
    byId: new Map((published ?? []).map(v => [v.id, v])),
    open: (v: SubagentView) => showAgent({ chat: chatId, id: v.id, title: v.description }),
    shownId: sidePanel?.open ? shownAgent : null,
  } : null), [paneSubagentsOn, showAgent, published, chatId, shownAgent, sidePanel?.open]);
  const alongside = paneSubagentsOn ? subagents.alongside : [];

  // Starts with a first message New chat handed over, if any (chat/useHandedDraft.ts).
  const [text, setText] = useComposerText(`${projectId}|${ws}`);
  // The draft as of the last render, for a send that finishes after more typing.
  const latestText = useRef(text);
  latestText.current = text;
  const composer = useAutoGrow<HTMLTextAreaElement>(text);
  const dictation = useDictation({ text, setText, max: MAX_KEYS, chatKey: `${projectId}|${ws}` });
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => { setSendError(null); }, [projectId, ws]);

  // A message the person typed (not an answer key) puts the session's tabs on top of their space.
  const noteSent = useSimpleDataIfAny()?.items.noteSent;
  // The message waiting for Claude: New chat's first message, or anything
  // typed here before Claude was up (chat/useQueuedMessage.ts).
  const sendQueued = useCallback(async (pid: string, workstreamName: string, keys: string) => {
    await sessionsApi.sendKeys(pid, 'agent', { workstream: workstreamName, keys, enter: true, literal: true });
    noteSent?.({ projectId: pid, workstream: workstreamName });
    const sentFor = projects.find(p => p.id === pid);
    if (sentFor) activityApi.heartbeat(sentFor.name, sentFor.instanceId ?? null).catch(() => {});
    setTimeout(capture.refresh, 500);
  }, [projects, capture.refresh, noteSent]);
  const { queued, echo, error: queueError, enqueue, retry: retryQueued } = useQueuedMessage({
    projectId: project?.id ?? null, workstream: ws, up, offline, send: sendQueued,
  });

  const send = useCallback(async (body: { keys: string; enter: boolean; literal: boolean }, sent: string | null) => {
    if (!project || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await sessionsApi.sendKeys(project.id, 'agent', { workstream: ws, ...body });
      if (sent !== null) {
        setText(draftAfterSend(latestText.current, sent));
        noteSent?.({ projectId: project.id, workstream: ws });
      }
      activityApi.heartbeat(project.name, project.instanceId ?? null).catch(() => {});
      setTimeout(capture.refresh, 500);
    } catch (err) {
      setSendError(sendErrorText(err));
    } finally {
      setSending(false);
    }
  }, [project, ws, sending, capture.refresh, noteSent]);

  const onSend = () => {
    dictation.detach();
    const keys = flattenForSend(text);
    if (!keys || !project) return;
    recordTypedChatCommand(keys, 'pane');
    if (!up) {
      if (enqueue(keys)) setText('');
      else setSendError(`This browser would not hold the message until ${agentLabel} is up. Send it again once it is.`);
      return;
    }
    void send({ keys, enter: true, literal: true }, text);
  };
  const onQuick = (k: QuickKey) => { void send({ keys: k.keys, enter: k.enter, literal: k.literal }, null); };

  // Only the last block can be a live question; an answered one stays in scrollback.
  const lastBlock = blocks?.[blocks.length - 1];
  const dialogOptions = lastBlock?.kind === 'dialog' ? lastBlock.options ?? 0 : 0;
  const answerKeys = showAnswerKeys(status?.status, dialogOptions)
    ? quickKeys(provider, status?.status, status?.waitingReason, dialogOptions)
    : [];

  const showSteps = showSetup({ held, queued: queued != null, up, captured: parsed != null, turns: blocks?.length ?? 0 });
  // While the chat is still coming up, the status line says which step it is on.
  const activeStep = steps.find(s => s.state === 'active' || s.state === 'failed');
  const settingUpLabel = !up && showSteps ? (activeStep?.text.toLowerCase() ?? 'starting claude') : null;
  const line = statusLine({
    status: status?.status,
    waitingReason: status?.waitingReason,
    message: status?.message,
    spinner: parsed?.spinner,
    setupLabel: held ? setup.label ?? 'waiting' : settingUpLabel,
    offline,
  });

  // Opening the chat (and Claude coming up) puts the cursor in the composer.
  useEffect(() => { composer.current?.focus(); }, [projectId, ws, project?.id, up, composer]);

  const liveWorkstreams = project?.workstreams.filter(w => !w.archived) ?? [];
  const setWs = (name: string) => {
    const next = new URLSearchParams(params);
    if (name === 'main') next.delete('ws'); else next.set('ws', name);
    setParams(next, { replace: true });
  };

  const setupFailed = steps.some(s => s.state === 'failed');
  // Before Claude is up a message is queued, so the composer is open then too
  // (on the main workstream, where the queue lives).
  const canSend = Boolean(project) && hasAgent && !offline && !setupFailed && (up || ws === 'main');
  // A click in the transcript puts the cursor in the composer (chat/transcriptFocus.ts).
  // Above the not-found return below, like every hook here.
  const transcriptFocus = useTranscriptFocus(composer, canSend);

  if (projects.length > 0 && !project) {
    return <div className="chat-home"><p>This session is not in your project list.</p><Link to="/chat">Back</Link></div>;
  }
  // While Claude is not up, the box's last words: a credential prompt or a
  // failed checkout in the pane would otherwise go unseen.
  const boxSays = showSteps && !held && !up && parsed ? preLaunchTail(parsed.blocks) : [];

  return (
    <div className="chat-view">
      <section className="chat-conv">
        <header className={phone ? 'chat-header chat-header-agent' : 'chat-header'}>
          <ChatHistoryButton />
          <div className="chat-title">
            {phone ? <AgentIcon status={status?.status ?? 'not_running'} /> : (
              <span className="chat-glyph" data-status={status?.status ?? 'not_running'} aria-hidden="true">
                {STATUS_GLYPH[status?.status ?? 'not_running']}
              </span>
            )}
            <span className="chat-title-name">{project?.name ?? '…'}</span>
            {liveWorkstreams.length > 1 ? (
              <select className="chat-ws-select" value={ws} onChange={e => setWs(e.target.value)} aria-label="Workstream">
                {liveWorkstreams.map(w => <option key={w.id} value={w.name}>{w.name}</option>)}
              </select>
            ) : ws !== 'main' ? <span className="chat-title-ws">· {ws}</span> : null}
            <ChatSpaceChip place={{ instanceId: project?.instanceId ?? null, spaceId: workstream?.spaceId, spaceFixed: workstream?.spaceFixedAt != null }} />
            {repo && <span className="chat-title-repo" title={project?.repoUrl ?? undefined}>{repo}</span>}
            {project && <ChatBoxTag project={project} box={box} />}
          </div>
          <div className="chat-header-actions">
            {phone ? (
              <ChatMoreButton label={`${project?.name ?? 'Session'}: actions`} actions={[
                { label: 'Open in Lab', onSelect: () => navigate(fullUiHref(project?.id, ws)) },
                ...(desktopHref ? [{ label: 'Open in termag desktop', onSelect: () => openDesktopLink(desktopHref) }] : []),
                ...(sidePanel ? [{ label: sidePanel.open ? 'Hide tools' : 'Show tools', onSelect: sidePanel.toggle }] : []),
              ]} />
            ) : <>
              <Link className="btn-ghost chat-full-ui" to={fullUiHref(project?.id, ws)}>
                <span className="chat-full-ui-long">Open in Lab</span>
                <span className="chat-full-ui-short">Lab</span>
              </Link>
              {desktopHref && (
                <a className="btn-ghost" href={desktopHref} title="A new thread in this project in termag desktop, with its chats to import">Desktop</a>
              )}
              <SidePanelButton />
            </>}
          </div>
        </header>

        <div className="chat-transcript" ref={scroller} onScroll={onScroll} {...transcriptFocus}>
          <div className="chat-transcript-inner">
            {showSteps && project && (
              <div className="chat-setup">
                <SetupSteps steps={steps} />
                {boxSays.length > 0 && (
                  <div className="chat-box-says">
                    <div className="chat-box-says-label">Latest from the box</div>
                    <pre className={REPLAY_BLOCK_CLASS}>{boxSays.join('\n')}</pre>
                    <div className="chat-box-says-hint">Stuck on a question? <Link to={fullUiHref(project.id, ws)}>Answer it in Lab</Link>.</div>
                  </div>
                )}
                {project.role !== 'collaborator' && (setup.retry || setup.startEmpty) && (
                  <div className="chat-setup-actions">
                    {setup.retry && (
                      <button type="button" className="btn-tiny" disabled={retrying}
                        onClick={() => { setRetrying(true); void settleProjectClone(project.id, 'retry').finally(() => setRetrying(false)); }}>Retry</button>
                    )}
                    {setup.startEmpty && (
                      <button type="button" className="btn-tiny" disabled={retrying}
                        onClick={() => { setRetrying(true); void settleProjectClone(project.id, 'start-empty').finally(() => setRetrying(false)); }}>Start without the repository</button>
                    )}
                  </div>
                )}
              </div>
            )}
            {!held && project && !hasAgent && <div className="chat-empty">This project has no agent. Open it in Lab to add one.</div>}
            {!held && hasAgent && parsed == null && !capture.error && !echo && queued == null && <div className="chat-empty">Loading…</div>}
            {capture.error === 'denied' && <div className="chat-notice">This session is not reachable.</div>}
            {capture.error === 'failed' && <div className="chat-notice">Capture failed · retrying</div>}
            {blocks && restart.session && <RestartNotice notice={restart.session} />}
            {blocks?.map((b, i) => (
              <BlockView key={i} block={b} agentLabel={agentLabel}
                dialogHint={b.options ? 'question · answer with the keys below' : `${agentLabel} is asking · use the keys below`} />
            ))}
            {blocks && blocks.length === 0 && !capture.error && !queued && <div className="chat-empty">Nothing yet. Say hello.</div>}
            {blocks && restart.side && <RestartNotice notice={restart.side} side />}
            {parsed?.draft ? <DraftView draft={parsed.draft} /> : null}
            {echo && !queued && !blocks?.some(b => b.kind === 'you') && (
              <div className="m-block m-block-you">
                <div className="m-block-who">you</div>
                <div className="m-block-text">{echo}</div>
              </div>
            )}
            {queued && (
              <div className="m-block m-block-you" data-queued="">
                <div className="m-block-who">{queueError ? `you · not sent: ${queueError}` : `you · sent as soon as ${agentLabel} is up`}</div>
                <div className="m-block-text">{queued}</div>
                {queueError && <button type="button" className="btn-tiny chat-queued-retry" onClick={retryQueued}>Retry</button>}
              </div>
            )}
          </div>
        </div>
        <div className="chat-bottom">
          {unseen && <button type="button" className="chat-jump" onClick={jumpToBottom}>↓ new output</button>}
          {project && claudeSignInApplies(provider) && (
            <ClaudeLoginCard projectId={project.id} owner={project.role !== 'collaborator'} enabled box={box?.status}
              hostShowsBox={line.tone === 'offline' || line.tone === 'setup'} />
          )}
          {project && <SessionRepoPill project={project} />}
          <div className="chat-status" data-tone={line.tone} role="status" aria-live="polite" title={line.text}>{line.text}</div>
          {answerKeys.length > 0 && (
            <div className="chat-keys" role="toolbar" aria-label="Answer keys">
              {answerKeys.map(k => (
                <button key={k.label} type="button" className="btn-tiny" onClick={() => onQuick(k)} disabled={sending || !canSend} title={k.title}>{k.label}</button>
              ))}
            </div>
          )}
          <PaneDrawers drawers={[
            agentsUi && keptAgents.length > 0 ? <AgentsDrawer key="agents" list={keptAgents} ui={agentsUi} /> : null,
            agentsUi && alongside.length > 0 ? <AgentsDrawer key="alongside" list={alongside} ui={agentsUi} alongside /> : null,
            asks.ui && asks.kept.length > 0 ? <AsksDrawer key="asks" list={asks.kept} ui={asks.ui} /> : null,
          ]} />
          <form className="chat-composer" onSubmit={e => { e.preventDefault(); onSend(); }}>
            <textarea
              ref={composer}
              className="chat-input"
              value={text}
              onChange={e => { dictation.onEdit(); setText(e.target.value.slice(0, MAX_KEYS)); }}
              onKeyDown={e => {
                if (dictation.onKeyDown(e)) return;
                // Enter sends; newlines cannot be sent into a pane (chat/compose.ts).
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); onSend(); }
              }}
              placeholder={!canSend ? (setupFailed ? 'Setup failed' : 'Not available') : !up ? `Message ${agentLabel}… (sent when it is up)` : status?.status === 'working' ? `Message ${agentLabel}… (queues while it works)` : `Message ${agentLabel}…`}
              rows={1}
              disabled={!canSend}
            />
            <div className="chat-composer-bar">
              <div className="chat-compose-actions">
                <DictationButton dictation={dictation} disabled={!canSend} />
                {text.trim() && (
                  <button type="submit" className="chat-send-btn" aria-label="Send" title="Send (Enter)" disabled={sending || !canSend}>
                    <SendIcon />
                  </button>
                )}
              </div>
            </div>
          </form>
          {/* A line kept under the composer for its notes, so one appearing doesn't push it up. */}
          <div className="chat-composer-notes">
            <DictationNote dictation={dictation} />
            {(sendError || text.length > MAX_KEYS - 500) && (
              <div className="chat-composer-note" data-error={sendError ? '' : undefined}>{sendError ?? `${text.length} / ${MAX_KEYS}`}</div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
