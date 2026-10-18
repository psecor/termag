// One conversation in the simple UI: the workstream's agent pane captured and
// parsed into turns (chat/paneChat.ts, as the phone does), one status line,
// answer keys only while the agent waits, and a composer that types into the
// pane. No terminal is shown here: Open in full UI is the way to one. While
// the chat comes up (box, clone, Claude) it narrates the steps, and a message
// typed before Claude is there waits and is sent once it is.
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
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
import { flattenForSend, MAX_KEYS, sendErrorText } from '../../chat/compose';
import { useFollowBottom } from '../../chat/useFollowBottom';
import { quickKeys, QuickKey } from '../../chat/quickKeys';
import { useCapture } from '../../chat/useCapture';
import { conversationBlocks, fullUiHref, repoSlug, showAnswerKeys, statusLine } from '../../chat/simpleChat';
import { agentUp, bootEstimateMinutes, preLaunchTail, setupSteps, showSetup } from '../../chat/newChat';
import { SetupSteps } from '../../chat/SetupSteps';
import { useQueuedMessage } from '../../chat/useQueuedMessage';
import { useComposerText } from '../../chat/useHandedDraft';
import { REPLAY_BLOCK_CLASS } from '../../observability';
import { providerFor, STATUS_GLYPH } from '../../mobile/inbox';

// Remembered across conversations in this tab so visits carry a previous id.
let lastVisitedProjectId: string | null = null;

export function ChatView() {
  const { projectId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();
  const { projects, statusMap, settleProjectClone } = useProjects();

  const ws = params.get('ws') || 'main';
  const project = projects.find(p => p.id === projectId);
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

  // Starts with a first message New chat handed over, if any (chat/useHandedDraft.ts).
  const [text, setText] = useComposerText(`${projectId}|${ws}`);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => { setSendError(null); }, [projectId, ws]);

  // The message waiting for Claude: New chat's first message, or anything
  // typed here before Claude was up (chat/useQueuedMessage.ts).
  const sendQueued = useCallback(async (pid: string, workstreamName: string, keys: string) => {
    await sessionsApi.sendKeys(pid, 'agent', { workstream: workstreamName, keys, enter: true, literal: true });
    const sentFor = projects.find(p => p.id === pid);
    if (sentFor) activityApi.heartbeat(sentFor.name, sentFor.instanceId ?? null).catch(() => {});
    setTimeout(capture.refresh, 500);
  }, [projects, capture.refresh]);
  const { queued, echo, error: queueError, enqueue, retry: retryQueued } = useQueuedMessage({
    projectId: project?.id ?? null, workstream: ws, up, offline, send: sendQueued,
  });

  const send = useCallback(async (body: { keys: string; enter: boolean; literal: boolean }, clear: boolean) => {
    if (!project || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await sessionsApi.sendKeys(project.id, 'agent', { workstream: ws, ...body });
      if (clear) setText('');
      activityApi.heartbeat(project.name, project.instanceId ?? null).catch(() => {});
      setTimeout(capture.refresh, 500);
    } catch (err) {
      setSendError(sendErrorText(err));
    } finally {
      setSending(false);
    }
  }, [project, ws, sending, capture.refresh]);

  const onSend = () => {
    const keys = flattenForSend(text);
    if (!keys || !project) return;
    if (!up) {
      if (enqueue(keys)) setText('');
      else setSendError(`This browser would not hold the message until ${agentLabel} is up. Send it again once it is.`);
      return;
    }
    void send({ keys, enter: true, literal: true }, true);
  };
  const onQuick = (k: QuickKey) => { void send({ keys: k.keys, enter: k.enter, literal: k.literal }, false); };

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

  const liveWorkstreams = project?.workstreams.filter(w => !w.archived) ?? [];
  const setWs = (name: string) => {
    const next = new URLSearchParams(params);
    if (name === 'main') next.delete('ws'); else next.set('ws', name);
    setParams(next, { replace: true });
  };

  if (projects.length > 0 && !project) {
    return <div className="chat-home"><p>This conversation is not in your project list.</p><Link to="/chat">Back</Link></div>;
  }

  const setupFailed = steps.some(s => s.state === 'failed');
  // Before Claude is up a message is queued, so the composer is open then too
  // (on the main workstream, where the queue lives).
  const canSend = Boolean(project) && hasAgent && !offline && !setupFailed && (up || ws === 'main');
  // While Claude is not up, the box's last words: a credential prompt or a
  // failed checkout in the pane would otherwise go unseen.
  const boxSays = showSteps && !held && !up && parsed ? preLaunchTail(parsed.blocks) : [];

  return (
    <div className="chat-view">
      <section className="chat-conv">
        <header className="chat-header">
          <div className="chat-title">
            <span className="chat-glyph" data-status={status?.status ?? 'not_running'} aria-hidden="true">
              {STATUS_GLYPH[status?.status ?? 'not_running']}
            </span>
            <span className="chat-title-name">{project?.name ?? '…'}</span>
            {liveWorkstreams.length > 1 ? (
              <select className="chat-ws-select" value={ws} onChange={e => setWs(e.target.value)} aria-label="Workstream">
                {liveWorkstreams.map(w => <option key={w.id} value={w.name}>{w.name}</option>)}
              </select>
            ) : ws !== 'main' ? <span className="chat-title-ws">· {ws}</span> : null}
            {repo && <span className="chat-title-repo" title={project?.repoUrl ?? undefined}>{repo}</span>}
          </div>
          <div className="chat-header-actions">
            <Link className="btn-ghost" to={fullUiHref(project?.id, ws)}>Open in full UI</Link>
          </div>
        </header>

        <div className="chat-transcript" ref={scroller} onScroll={onScroll}>
          <div className="chat-transcript-inner">
            {showSteps && project && (
              <div className="chat-setup">
                <SetupSteps steps={steps} />
                {boxSays.length > 0 && (
                  <div className="chat-box-says">
                    <div className="chat-box-says-label">Latest from the box</div>
                    <pre className={REPLAY_BLOCK_CLASS}>{boxSays.join('\n')}</pre>
                    <div className="chat-box-says-hint">Stuck on a question? <Link to={fullUiHref(project.id, ws)}>Answer it in the full UI</Link>.</div>
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
            {!held && project && !hasAgent && <div className="chat-empty">This project has no agent. Open it in the full UI to add one.</div>}
            {!held && hasAgent && parsed == null && !capture.error && !echo && queued == null && <div className="chat-empty">Loading…</div>}
            {capture.error === 'denied' && <div className="chat-notice">This session is not reachable.</div>}
            {capture.error === 'failed' && <div className="chat-notice">Capture failed · retrying</div>}
            {blocks?.map((b, i) => (
              <BlockView key={i} block={b} agentLabel={agentLabel}
                dialogHint={b.options ? 'question · answer with the keys below' : `${agentLabel} is asking · use the keys below`} />
            ))}
            {blocks && blocks.length === 0 && !capture.error && !queued && <div className="chat-empty">Nothing yet. Say hello.</div>}
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
        {unseen && <button type="button" className="chat-jump" onClick={jumpToBottom}>↓ new output</button>}

        <div className="chat-bottom">
          <div className="chat-status" data-tone={line.tone} role="status" aria-live="polite">{line.text}</div>
          {answerKeys.length > 0 && (
            <div className="chat-keys" role="toolbar" aria-label="Answer keys">
              {answerKeys.map(k => (
                <button key={k.label} type="button" className="btn-tiny" onClick={() => onQuick(k)} disabled={sending || !canSend} title={k.title}>{k.label}</button>
              ))}
            </div>
          )}
          <form className="chat-composer" onSubmit={e => { e.preventDefault(); onSend(); }}>
            <textarea
              className="chat-input"
              value={text}
              onChange={e => setText(e.target.value.slice(0, MAX_KEYS))}
              onKeyDown={e => {
                // Enter sends; newlines cannot be sent into a pane (chat/compose.ts).
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); onSend(); }
              }}
              placeholder={!canSend ? (setupFailed ? 'Setup failed' : 'Not available') : !up ? `Message ${agentLabel}… (sent when it is up)` : status?.status === 'working' ? `Message ${agentLabel}… (queues while it works)` : `Message ${agentLabel}…`}
              rows={2}
              disabled={!canSend}
            />
            <button type="submit" className="btn-primary chat-send" disabled={sending || !canSend || !text.trim()}>Send</button>
          </form>
          {(sendError || text.length > MAX_KEYS - 500) && (
            <div className="chat-composer-note" data-error={sendError ? '' : undefined}>{sendError ?? `${text.length} / ${MAX_KEYS}`}</div>
          )}
        </div>
      </section>
    </div>
  );
}
