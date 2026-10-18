// One SDK chat in the simple UI: a workstream whose Claude runs in the box's
// chat runner (agent/chat-runner.js). History comes from Claude's session
// file on the box (GET …/chat), live events from the status socket
// (chat/chatEvents.ts); both go through one reducer (chat/sdkChat.ts) into
// markdown bubbles, tool cards and one status line. While the chat comes up
// it narrates the box, the clone and Claude (chat/newChat.ts setupSteps), and
// a first message waits in the same storage-backed queue the pane chat uses
// (chat/useQueuedMessage.ts) until the runner can take it.
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { useProjects } from '../../contexts/ProjectContext';
import { activityApi, chatApi, visitsApi } from '../../services/api';
import { boxFeed } from '../../services/boxFeed';
import { useSetupContext } from '../../hooks/useSetupContext';
import { cloneTile } from '../../utils/cloneTile';
import { REPLAY_BLOCK_CLASS } from '../../observability';
import { chatEvents } from '../../chat/chatEvents';
import { MAX_KEYS } from '../../chat/compose';
import { Markdown } from '../../chat/Markdown';
import { bootEstimateMinutes, preLaunchTail, setupSteps } from '../../chat/newChat';
import { parsePane } from '../../chat/paneChat';
import {
  addPending, applyEvent, applyFrame, chatStatus, emptyChat, fromHistory, liveFrameAction, mergeHistory, sdkReadiness, toolSummary,
  type ChatItem, type ChatState, type FrameCursor, type HistoryLoad,
} from '../../chat/sdkChat';
import { SetupSteps } from '../../chat/SetupSteps';
import { fullUiHref, repoSlug } from '../../chat/simpleChat';
import { useCapture } from '../../chat/useCapture';
import { useFollowBottom } from '../../chat/useFollowBottom';
import { useComposerText } from '../../chat/useHandedDraft';
import { useQueuedMessage } from '../../chat/useQueuedMessage';
import type { Project } from '../../types';

let lastVisitedProjectId: string | null = null;

const HISTORY_POLL_MS = 2000;
// A running chat with no frame for this long has lost its turn-end (the box's
// agent socket dropped); refetch to settle it. Longer than any gap a healthy
// streaming turn produces, so a live turn never triggers it.
const RUNNING_STALE_MS = 15000;
const MAX_TEXT = MAX_KEYS * 25;

function errorOf(err: unknown, fallback: string): { code: string | null; text: string } {
  const data = (err as { response?: { data?: { error?: string; code?: string } } })?.response?.data;
  return { code: data?.code ?? null, text: data?.error ?? fallback };
}

function ToolCard({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const { title, detail } = toolSummary(item.name, item.input);
  const state = !item.done ? 'running' : item.isError ? 'error' : 'done';
  const command = item.name === 'Bash' && detail ? `$ ${detail}` : null;
  return (
    <div className="sdk-tool" data-state={state}>
      <button type="button" className="sdk-tool-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="sdk-tool-mark" aria-hidden="true">{state === 'running' ? '◌' : state === 'error' ? '✗' : '✓'}</span>
        <span className="sdk-tool-title">{title}</span>
        {detail && <span className="sdk-tool-detail">{detail}</span>}
        <span className="sdk-tool-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="sdk-tool-body">
          {command ? <pre className="sdk-tool-input">{command}</pre>
            : <pre className="sdk-tool-input">{JSON.stringify(item.input, null, 2)}</pre>}
          {item.result != null && <pre className="sdk-tool-result">{item.result || '(no output)'}</pre>}
          {item.result == null && item.done && <div className="sdk-tool-note">No result (the turn was stopped)</div>}
        </div>
      )}
    </div>
  );
}

function ItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="sdk-user" data-pending={item.pending || undefined}>
          <div className="sdk-user-bubble">{item.text}</div>
          {item.pending && <div className="sdk-user-note">queued</div>}
        </div>
      );
    case 'text':
      return (
        <div className="sdk-text" data-streaming={item.streaming || undefined}>
          <Markdown text={item.text} />
          {item.streaming && <span className="sdk-caret" aria-hidden="true" />}
        </div>
      );
    case 'tool':
      return <ToolCard item={item} />;
    case 'error':
      return <div className="sdk-error">{item.text}</div>;
  }
}

export function SdkChatView({ project, workstream }: { project: Project; workstream: string }) {
  const { settleProjectClone } = useProjects();
  const setupCtx = useSetupContext(project);
  const setup = cloneTile(project.setupStatus, setupCtx);
  const held = setup.holdTerminal;
  const chatId = `${project.id}|${workstream}`;
  const repo = repoSlug(project.repoUrl);

  const [chat, setChat] = useState<ChatState>(emptyChat);
  const [history, setHistory] = useState<HistoryLoad>('loading');
  const [checkoutReady, setCheckoutReady] = useState(false);
  const [loadError, setLoadError] = useState<{ code: string | null; text: string } | null>(null);
  const [poll, setPoll] = useState(0);
  // The last turn event folded in, decided as each frame arrives (state
  // updaters run later, so a gap could not be read back from them).
  const cursor = useRef<FrameCursor>({ turnId: null, seq: 0 });

  // History from the box once the project is set up, again on every switch,
  // and again every two seconds while setup or a pane clone is still running.
  useEffect(() => {
    setChat(emptyChat); setHistory('loading'); setCheckoutReady(false); setLoadError(null);
    cursor.current = { turnId: null, seq: 0 };
  }, [chatId]);
  // Live events that arrive while a history request is out are kept and
  // replayed on the snapshot (mergeHistory): a hard replace would drop them,
  // and a turn that ended meanwhile would come back as running.
  const liveDuringLoad = useRef<Array<{ turnId: string | null; seq?: number | null; event: unknown }> | null>(null);
  useEffect(() => {
    if (held) return;
    let cancelled = false;
    liveDuringLoad.current = [];
    chatApi.history(project.id, workstream)
      .then(h => {
        if (cancelled) return;
        const live = liveDuringLoad.current ?? [];
        liveDuringLoad.current = null;
        if (h.turn) {
          // A durable runner replays the running turn from its log; frames
          // that arrived during the load continue from that cursor. A frame
          // that is a real gap asks for one more load, after this one.
          let state = fromHistory(h.entries, h.sessionId, h.turn);
          let again = false;
          for (const frame of live) {
            if ((frame.event as { type?: unknown } | null)?.type === 'queue-parked') again = true;
            const applied = applyFrame(state, frame);
            if (applied.gap) again = true;
            else state = applied.state;
          }
          cursor.current = state.cursor;
          setChat(state);
          if (again) setPoll(n => n + 1);
        } else {
          setChat(mergeHistory({ entries: h.entries, sessionId: h.sessionId, running: h.running }, live.map(f => f.event)));
          cursor.current = { turnId: null, seq: 0 };
          if (live.some(f => (f.event as { type?: unknown } | null)?.type === 'queue-parked')) setPoll(n => n + 1);
        }
        setCheckoutReady(h.checkoutReady !== false);
        setHistory('ok');
        setLoadError(null);
      })
      .catch(err => {
        if (cancelled) return;
        liveDuringLoad.current = null;
        const e = errorOf(err, 'Could not load the chat');
        if (e.code === 'setup') setHistory('setup');
        else { setHistory('error'); setLoadError(e); }
      });
    return () => { cancelled = true; };
  }, [project.id, workstream, held, poll]);

  // Live events for this chat. Each turn event is numbered: one already
  // folded in (resent by an agent that restarted) is skipped, and a gap
  // (frames lost while the socket was down) loads the history again, which
  // replays the running turn exactly. An agent from before durable turns
  // sends no seq and is folded in as before.
  const lastFrameAt = useRef(Date.now());
  const turnId = useRef<string | null>(null);
  useEffect(() => chatEvents.subscribe(frame => {
    if (frame.projectId !== project.id || frame.workstream !== workstream) return;
    lastFrameAt.current = Date.now();
    turnId.current = frame.turnId;
    // While a load is out, keep the frame and do not judge its seq: the cursor
    // is still empty, so every line past the first looks like a gap and the
    // load would never finish.
    const how = liveFrameAction(liveDuringLoad.current != null, cursor.current, frame);
    if (how === 'buffer') { liveDuringLoad.current?.push(frame); return; }
    // The box parked what queued behind a turn from before its agent restarted:
    // this open chat is live, so ask again (GET …/chat resumes a parked queue).
    if (how === 'parked') { setPoll(n => n + 1); return; }
    if (how === 'skip') return;
    if (how === 'gap') { setPoll(n => n + 1); return; }
    if (frame.seq != null && frame.turnId != null) cursor.current = { turnId: frame.turnId, seq: frame.seq };
    liveDuringLoad.current?.push(frame);
    setChat(s => applyFrame(s, frame).state);
  }), [project.id, workstream]);

  // The status socket reopened: it may have missed this chat's turn-end while
  // down, leaving the view stuck on "working". Refetch history to settle it.
  useEffect(() => chatEvents.subscribeReconnect(() => setPoll(n => n + 1)), []);

  // A turn ending while the box's agent socket was down drops the turn-end
  // frame — which the browser socket's reconnect does not see. When a running
  // chat has had no frame for a while, ask the box ONLY whether the turn is
  // still running, and settle it if it is not. Claude can think well past this
  // gap before its first token, so we never rebuild the transcript here: that
  // would drop streamed text the JSONL does not have yet.
  useEffect(() => {
    if (!chat.running) return;
    lastFrameAt.current = Date.now();
    let cancelled = false;
    const id = setInterval(() => {
      if (Date.now() - lastFrameAt.current <= RUNNING_STALE_MS) return;
      // The turn the poll is about, so a late response cannot idle a newer one.
      const polledTurn = turnId.current;
      chatApi.history(project.id, workstream)
        .then(h => {
          if (cancelled || h.running !== false || turnId.current !== polledTurn) return;
          // Settle exactly as a turn-end would: stop the caret and close open
          // tool cards, not just clear `running`.
          setChat(s => (s.running ? applyEvent(s, { type: 'turn-end' }) : s));
        })
        .catch(() => { /* try again next interval */ });
    }, RUNNING_STALE_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [chat.running, project.id, workstream]);

  useEffect(() => {
    visitsApi.record({ projectId: project.id, previousProjectId: lastVisitedProjectId, workstream });
    lastVisitedProjectId = project.id;
  }, [project.id, workstream]);

  // The message waiting for the runner: New chat's first message, or anything
  // typed before the runner was ready. One sender across tabs, never twice,
  // and a failure waits for Retry.
  const sendQueued = useCallback(async (pid: string, ws: string, text: string) => {
    await chatApi.send(pid, ws, text);
    activityApi.heartbeat(project.name, project.instanceId ?? null).catch(() => {});
  }, [project.name, project.instanceId]);
  const { queued, echo, error: queueError, enqueue, retry: retryQueued } = useQueuedMessage({
    projectId: project.id,
    workstream,
    up: sdkReadiness({ held, history, checkoutReady, queued: false }).runnerReady,
    offline: loadError?.code === 'offline',
    send: sendQueued,
    raw: true,
  });
  const { runnerReady, pollHistory, showSteps } = sdkReadiness({ held, history, checkoutReady, queued: queued != null });
  useEffect(() => {
    if (!pollHistory) return;
    const t = setTimeout(() => setPoll(n => n + 1), HISTORY_POLL_MS);
    return () => clearTimeout(t);
  }, [pollHistory, poll]);

  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const box = project.instanceId ? boxes.find(b => b.id === project.instanceId) ?? null : null;
  const eta = useMemo(() => bootEstimateMinutes(boxes), [boxes]);
  const steps = useMemo(() => setupSteps({
    box, setupStatus: project.setupStatus, setupError: project.setupError, repo, agentUp: runnerReady, etaMinutes: eta,
  }), [box, project.setupStatus, project.setupError, repo, runnerReady, eta]);

  // A checkout still running in the pane (a box that clones there) may stop
  // on a credential prompt: its last lines show under the steps.
  const paneClone = !held && !runnerReady && project.setupStatus === 'none' && Boolean(repo);
  const capture = useCapture({ projectId: project.id, role: 'agent', workstream, status: 'working', statusUpdatedAt: undefined, enabled: paneClone });
  const boxSays = useMemo(() => (paneClone && capture.content != null
    ? preLaunchTail(parsePane(capture.content, { provider: 'claude', role: 'agent' }).blocks)
    : []), [paneClone, capture.content]);

  const { scroller, onScroll, unseen, jumpToBottom } = useFollowBottom(chat.items, chatId);

  // Starts with a first message New chat handed over, if any (chat/useHandedDraft.ts).
  const [text, setText] = useComposerText(chatId);
  const textRef = useRef(text);
  textRef.current = text;
  const [sendError, setSendError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const sendingRef = useRef(false);
  useEffect(() => { setSendError(null); }, [chatId]);

  const send = useCallback(async () => {
    const message = text.trim();
    if (!message || sendingRef.current) return;
    if (!runnerReady) {
      if (enqueue(message)) setText('');
      else setSendError('This browser would not hold the message until Claude is ready. Send it again once it is.');
      return;
    }
    sendingRef.current = true;
    setSendError(null);
    setChat(s => addPending(s, message));
    setText('');
    try {
      await chatApi.send(project.id, workstream, message);
      activityApi.heartbeat(project.name, project.instanceId ?? null).catch(() => {});
    } catch (err) {
      setChat(s => ({ ...s, items: s.items.filter(it => !(it.kind === 'user' && it.pending && it.text === message)) }));
      setText(message);
      setSendError(errorOf(err, 'Send failed').text);
    } finally {
      sendingRef.current = false;
    }
  }, [text, runnerReady, enqueue, setText, project.id, project.name, project.instanceId, workstream]);

  // Stop also drops what was queued behind the turn: those bubbles come down
  // (the box's queue-dropped event does the same for every open view) and the
  // text goes back into the composer, so nothing typed is lost.
  const stop = () => {
    chatApi.interrupt(project.id, workstream)
      .then(r => {
        const dropped = r.dropped ?? [];
        if (!dropped.length) return;
        setChat(s => applyEvent(s, { type: 'queue-dropped', texts: dropped }));
        setText([...dropped, textRef.current].filter(t => t.trim()).join('\n'));
      })
      .catch(() => {});
  };

  const setupFailed = steps.some(s => s.state === 'failed');
  const activeStep = steps.find(s => s.state === 'active' || s.state === 'failed');
  const status = showSteps && !runnerReady && !loadError
    ? { tone: 'working' as const, text: `Setting up · ${(held ? setup.label : activeStep?.text.toLowerCase()) ?? 'starting claude'}` }
    : loadError ? { tone: 'error' as const, text: loadError.text } : chatStatus(chat);
  // Before the runner is ready a message is queued (main workstream only, where the queue lives).
  const canSend = !setupFailed && !loadError && (runnerReady || workstream === 'main');
  const echoShown = echo && !queued && !chat.items.some(it => it.kind === 'user' && it.text === echo);

  return (
    <div className="chat-view">
      <section className="chat-conv">
        <header className="chat-header">
          <div className="chat-title">
            <span className="chat-glyph" data-status={chat.running ? 'working' : 'idle'} aria-hidden="true">{chat.running ? '●' : '○'}</span>
            <span className="chat-title-name">{project.name}</span>
            {workstream !== 'main' && <span className="chat-title-ws">· {workstream}</span>}
            {repo && <span className="chat-title-repo" title={project.repoUrl ?? undefined}>{repo}</span>}
          </div>
          <div className="chat-header-actions">
            <Link className="btn-ghost" to={fullUiHref(project.id, workstream)}>Open in full UI</Link>
          </div>
        </header>

        <div className="chat-transcript" ref={scroller} onScroll={onScroll}>
          <div className={`chat-transcript-inner sdk-transcript ${REPLAY_BLOCK_CLASS}`}>
            {showSteps && (
              <div className="chat-setup">
                <SetupSteps steps={steps} />
                {boxSays.length > 0 && (
                  <div className="chat-box-says">
                    <div className="chat-box-says-label">Latest from the box</div>
                    <pre className={REPLAY_BLOCK_CLASS}>{boxSays.join('\n')}</pre>
                    <div className="chat-box-says-hint">Stuck on a question? <Link to={fullUiHref(project.id, workstream)}>Answer it in the full UI</Link>.</div>
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
            {runnerReady && chat.items.length === 0 && !queued && !echo && (
              <div className="chat-empty">Ask Claude anything about {repo ?? project.name}. It can read the code and answer, but can't run commands or edit files yet.</div>
            )}
            {chat.items.map(item => <ItemView key={item.key} item={item} />)}
            {echoShown && <div className="sdk-user"><div className="sdk-user-bubble">{echo}</div></div>}
            {queued && (
              <div className="sdk-user" data-pending="">
                <div className="sdk-user-bubble">{queued}</div>
                <div className="sdk-user-note">{queueError ? `not sent: ${queueError}` : 'sent as soon as Claude is ready'}</div>
                {queueError && <button type="button" className="btn-tiny chat-queued-retry" onClick={retryQueued}>Retry</button>}
              </div>
            )}
          </div>
        </div>
        {unseen && <button type="button" className="chat-jump" onClick={jumpToBottom}>↓ new output</button>}

        <div className="chat-bottom">
          <div className="chat-trust" role="note">
            Claude can read {repo ?? 'the checkout'} and answer here, but it can't run commands or edit files in a chat yet.
          </div>
          <div className="chat-status" data-tone={status.tone === 'idle' ? 'idle' : status.tone === 'error' ? 'offline' : showSteps && !runnerReady ? 'setup' : 'working'} role="status" aria-live="polite">
            {chat.running && <span className="sdk-spinner" aria-hidden="true" />}{status.text}
          </div>
          <form className="chat-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
            <textarea
              className="chat-input"
              value={text}
              onChange={e => setText(e.target.value.slice(0, MAX_TEXT))}
              onKeyDown={e => {
                // Enter sends, Shift+Enter is a newline: the runner takes the message as is.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
              }}
              placeholder={setupFailed ? 'Setup failed' : !runnerReady ? 'Message Claude… (sent when it is ready)' : chat.running ? 'Message Claude… (sent after this turn)' : 'Message Claude…'}
              rows={2}
              disabled={!canSend}
            />
            {chat.running
              ? <button type="button" className="btn-ghost chat-send" onClick={stop}>Stop</button>
              : <button type="submit" className="btn-primary chat-send" disabled={!canSend || !text.trim()}>Send</button>}
          </form>
          {sendError && <div className="chat-composer-note" data-error="">{sendError}</div>}
        </div>
      </section>
    </div>
  );
}
