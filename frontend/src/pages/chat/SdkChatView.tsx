// One SDK chat in the simple UI: a workstream whose Claude runs in the box's
// chat runner (agent/chat-runner.js). History comes from Claude's session
// file on the box (GET …/chat), live events from the status socket
// (chat/chatEvents.ts); both go through one reducer (chat/sdkChat.ts) into
// markdown bubbles, tool cards and one status line. While the chat comes up
// it narrates the box, the clone and Claude (chat/newChat.ts setupSteps), and
// a first message waits in the same storage-backed queue the pane chat uses
// (chat/useQueuedMessage.ts) until the runner can take it.
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Dialog } from '../../components/Dialog';
import { announceChatsChanged, archiveBoxNotice, clearRunningBox, dismissRunningBoxNotice, dropLastActiveProject, historyComingUp, historyFailureIsSetup, isPowerRestart, parkedPowerError, readRunningBox, runningBoxFromNotice, saveRunningBox, stillRunningWorkspaceHref, subscribeRunningBoxes, type ReopenNavigationState } from '../../chat/archive';
import { LAST_ACTIVE_PROJECT_KEY, useProjects } from '../../contexts/ProjectContext';
import { activityApi, chatApi, chatsApi, instancesApi, visitsApi, type ChatTrust } from '../../services/api';
import { boxFeed } from '../../services/boxFeed';
import { useSetupContext } from '../../hooks/useSetupContext';
import { cloneTile } from '../../utils/cloneTile';
import { REPLAY_BLOCK_CLASS } from '../../observability';
import { chatEvents } from '../../chat/chatEvents';
import { isSendKey, MAX_KEYS } from '../../chat/compose';
import { TerminalHoldNotice } from '../../chat/TerminalHoldNotice';
import { reduceHold, refusalFromSend, statusBesideHold, type HoldState } from '../../chat/terminalHold';
import { chatLiveKey, publishChatStatus } from '../../chat/chatLiveStatus';
import { Markdown } from '../../chat/Markdown';
import { bootEstimateMinutes, preLaunchTail, setupSteps } from '../../chat/newChat';
import { parsePane } from '../../chat/paneChat';
import {
  addPending, applyEvent, applyFrame, chatCostTotal, chatStatus, commandLine, emptyChat, formatCost, fromHistory, groupTurns, lastAssistantText, liveFrameAction, mergeHistory, retryMessage, sdkReadiness, seedLiveTurn, sendGoesLive, stopControl, stopTitle, turnMeta,
  type ChatItem, type ChatState, type FrameCursor, type HistoryLoad,
} from '../../chat/sdkChat';
import { SetupSteps } from '../../chat/SetupSteps';
import { groupToolRuns } from '../../chat/toolRuns';
import { SkillCard, ToolCard, ToolRun } from './ToolCards';
import { ChatError, UnsentMessages } from './TranscriptNotices';
import { fullUiHref, repoSlug } from '../../chat/simpleChat';
import { useCapture } from '../../chat/useCapture';
import { useFollowBottom } from '../../chat/useFollowBottom';
import { useAutoGrow } from '../../chat/useAutoGrow';
import { useTranscriptFocus } from '../../chat/transcriptFocus';
import { useComposerText } from '../../chat/useHandedDraft';
import { useDictation } from '../../chat/useDictation';
import { DictationButton, DictationNote } from '../../chat/DictationButton';
import { useQueuedMessage } from '../../chat/useQueuedMessage';
import { readModelPick, useChatModel } from '../../chat/useChatModel';
import { ModelPicker } from '../../chat/ModelPicker';
import { useChatModelOptions } from '../../chat/useChatModelOptions';
import { admitImages, CHAT_IMAGE_ACCEPT, MAX_CHAT_IMAGES, dragHasFiles, imageFilesOf, prepareImage, type PreparedImage } from '../../chat/chatImageData';
import { ComposerImages, MessageImages } from '../../chat/ChatImages';
import { PlusIcon, SendIcon, StopIcon } from '../../chat/ComposerIcons';
import { ClaudeLoginCard } from '../../chat/ClaudeLoginCard';
import type { Project } from '../../types';
import { FLAGS, useFlag } from '../../flags';
import { ChatHistoryButton, ChatMoreButton, SidePanelButton, useChatChrome } from './chatChrome';
import type { MenuAction } from './ContextMenu';
import { AgentIcon } from './OpenItems';
import { ChatSpaceChip } from './SpaceSwatch';
import { ChatBoxTag } from './ChatBoxTag';

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

function ItemView({ item, onRetry, projectId, workstream }: { item: ChatItem; onRetry?: () => void; projectId: string; workstream: string }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="sdk-user" data-pending={item.pending || undefined}>
          {item.images?.length ? <MessageImages images={item.images} projectId={projectId} workstream={workstream} /> : null}
          {item.text && <div className="sdk-user-bubble">{item.text}</div>}
          {item.pending && <div className="sdk-user-note">queued</div>}
        </div>
      );
    case 'text':
      return (
        <div className="sdk-text" data-streaming={item.streaming || undefined}>
          <Markdown text={item.text} streaming={item.streaming} />
          {item.streaming && <span className="sdk-caret" aria-hidden="true" />}
        </div>
      );
    case 'tool':
      return <ToolCard item={item} />;
    case 'skill':
      return <SkillCard name={item.name} text={item.text} />;
    case 'error':
      return <ChatError text={item.text} onRetry={onRetry} />;
    case 'note':
      return <div className="sdk-note">{item.text}</div>;
    case 'command':
      return <div className="sdk-note" data-command={item.name}>{commandLine(item)}</div>;
  }
}

export function SdkChatView({ project, workstream }: { project: Project; workstream: string }) {
  const { settleProjectClone, reloadProjects } = useProjects();
  const navigate = useNavigate();
  const location = useLocation();
  const setupCtx = useSetupContext(project);
  const setup = cloneTile(project.setupStatus, setupCtx);
  const held = setup.holdTerminal;
  const chatId = `${project.id}|${workstream}`;
  const repo = repoSlug(project.repoUrl);

  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const box = project.instanceId ? boxes.find(b => b.id === project.instanceId) ?? null : null;
  // Set when archive succeeded and the box stayed up. History and send 404
  // an archived row, so this view shows Stop/Hibernate instead of loading.
  const recovery = useSyncExternalStore(subscribeRunningBoxes, () => readRunningBox(project.id));
  // A reopened chat's box is coming back from a stop: its checkout is on disk,
  // so the narration is the box and Claude, until the runner answers. The
  // latch stays after the box is ready so the clone step stays skipped.
  // History treats offline as that narration while the feed says starting,
  // or while the reopen response is ahead of a feed that still says parked.
  // A ready chat whose agent drops shows the offline error.
  const reopenNav = (location.state as Partial<ReopenNavigationState> | null)?.reopenStarting === true
    ? location.state as ReopenNavigationState
    : null;
  const comingUp = historyComingUp(box?.status, reopenNav != null);
  const [restart, setRestart] = useState(false);
  const powerRestart = isPowerRestart(box?.status) || comingUp;
  useEffect(() => { setRestart(false); }, [chatId]);
  useEffect(() => { if (powerRestart) setRestart(true); }, [powerRestart]);

  const [chat, setChat] = useState<ChatState>(emptyChat);
  const [history, setHistory] = useState<HistoryLoad>('loading');
  const [checkoutReady, setCheckoutReady] = useState(false);
  const [sendsLive, setSendsLive] = useState(false);
  const [stopsTurn, setStopsTurn] = useState(false);
  const [imageInput, setImageInput] = useState(false);
  const [loadError, setLoadError] = useState<{ code: string | null; text: string } | null>(null);
  const [poll, setPoll] = useState(0);
  // Whether Claude may run tools here, as the backend decided (services/chatTrust.ts).
  const [trust, setTrust] = useState<ChatTrust | null>(null);
  const trustNoun = project.repoUrl ? 'repository' : 'project';
  const [canTrust, setCanTrust] = useState(false);
  const [trusting, setTrusting] = useState(false);
  // The model the next message's turn runs on (chat/useChatModel.ts).
  const { model, pick: modelPick, ready: modelReady, choose: chooseModel, reported: reportModel, sent: modelSent } = useChatModel(chatId);
  const [modelOpen, setModelOpen] = useState(false);
  const modelOptions = useChatModelOptions();
  // The last turn event folded in, decided as each frame arrives (state
  // updaters run later, so a gap could not be read back from them).
  const cursor = useRef<FrameCursor>({ turnId: null, seq: 0 });

  // History from the box once the project is set up, again on every switch,
  // and again every two seconds while setup or a pane clone is still running.
  useEffect(() => {
    setChat(emptyChat); setHistory('loading'); setCheckoutReady(false); setLoadError(null); setTrust(null);
    setSendsLive(false);
    setStopsTurn(false);
    cursor.current = { turnId: null, seq: 0 };
  }, [chatId]);
  // Live events that arrive while a history request is out are kept and
  // replayed on the snapshot (mergeHistory): a hard replace would drop them,
  // and a turn that ended meanwhile would come back as running.
  const liveDuringLoad = useRef<Array<{ turnId: string | null; seq?: number | null; event: unknown }> | null>(null);
  useEffect(() => {
    if (held || recovery) return;
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
          let state = fromHistory(h.entries, h.sessionId, h.turn, h.turns ?? []);
          let again = false;
          for (const frame of live) {
            if ((frame.event as { type?: unknown } | null)?.type === 'queue-parked') again = true;
            const applied = applyFrame(state, frame);
            if (applied.gap) again = true;
            else state = applied.state;
          }
          cursor.current = state.cursor;
          setChat(seedLiveTurn(state, h.liveInput));
          if (again) setPoll(n => n + 1);
        } else {
          setChat(seedLiveTurn(mergeHistory({ entries: h.entries, sessionId: h.sessionId, running: h.running, turns: h.turns ?? [] }, live.map(f => f.event)), h.liveInput));
          cursor.current = { turnId: null, seq: 0 };
          if (live.some(f => (f.event as { type?: unknown } | null)?.type === 'queue-parked')) setPoll(n => n + 1);
        }
        setCheckoutReady(h.checkoutReady !== false);
        setSendsLive(h.sendsLive === true);
        setStopsTurn(h.stopsTurn === true);
        setImageInput(h.imageInput === true);
        setHold(prev => {
          const next = reduceHold(prev, h.terminalHolds);
          return { held: next.held, refused: next.refused };
        });
        setTrust(h.trust ?? null);
        setCanTrust(Boolean(h.canTrust));
        reportModel(h.model, h.backend);
        setHistory('ok');
        setLoadError(null);
      })
      .catch(err => {
        if (cancelled) return;
        liveDuringLoad.current = null;
        const e = errorOf(err, 'Could not load the session');
        // Still setting up, or a reopened chat's box still starting: keep
        // narrating and ask again. An established chat whose agent is offline
        // shows that error instead of a clone over the conversation.
        if (historyFailureIsSetup(e.code, comingUp)) { setHistory('setup'); setLoadError(null); }
        else { setHistory('error'); setLoadError(e); }
      });
    return () => { cancelled = true; };
  }, [project.id, workstream, held, poll, comingUp, recovery, reportModel]);

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
    if (!chat.running || recovery) return;
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
  }, [chat.running, project.id, workstream, recovery]);

  useEffect(() => {
    visitsApi.record({ projectId: project.id, previousProjectId: lastVisitedProjectId, workstream });
    lastVisitedProjectId = project.id;
  }, [project.id, workstream]);

  // The message waiting for the runner: New chat's first message, or anything
  // typed before the runner was ready. One sender across tabs, never twice,
  // and a failure waits for Retry.
  const sendQueued = useCallback(async (pid: string, ws: string, text: string) => {
    const picked = readModelPick(`${pid}|${ws}`);
    await chatApi.send(pid, ws, text, [], picked);
    if (picked && `${pid}|${ws}` === chatId) modelSent(picked);
    activityApi.heartbeat(project.name, project.instanceId ?? null).catch(() => {});
  }, [project.name, project.instanceId, chatId, modelSent]);
  const { mode: chromeMode, sidePanel } = useChatChrome();
  // The one-row phone header ships with simple-ui-side-panel-enabled; off, it is main's.
  const phoneHeader = useFlag(FLAGS.chatSidePanel, false);
  const phone = chromeMode === 'drawer' && phoneHeader;
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const { queued, echo, error: queueError, enqueue, retry: retryQueued } = useQueuedMessage({
    projectId: project.id,
    workstream,
    up: sdkReadiness({ held, history, checkoutReady, queued: false }).runnerReady && !opening,
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

  const eta = useMemo(() => bootEstimateMinutes(boxes), [boxes]);
  // A stale stopped/hibernated snapshot still narrates "Box … is starting".
  const narratedBox = comingUp
    ? { name: box?.name || reopenNav?.reopenBoxName || 'box', status: 'starting' as const, provisioningError: box?.provisioningError, claimedAt: box?.claimedAt }
    : box;
  const steps = useMemo(() => setupSteps({
    box: narratedBox, setupStatus: project.setupStatus, setupError: project.setupError, repo: (restart || comingUp) ? null : repo, agentUp: runnerReady, etaMinutes: eta,
  }), [narratedBox, project.setupStatus, project.setupError, repo, restart, comingUp, runnerReady, eta]);

  // A checkout still running in the pane (a box that clones there) may stop
  // on a credential prompt: its last lines show under the steps.
  const paneClone = !held && !restart && !runnerReady && project.setupStatus === 'none' && Boolean(repo);
  const capture = useCapture({ projectId: project.id, role: 'agent', workstream, status: 'working', statusUpdatedAt: undefined, enabled: paneClone });
  const boxSays = useMemo(() => (paneClone && capture.content != null
    ? preLaunchTail(parsePane(capture.content, { provider: 'claude', role: 'agent' }).blocks)
    : []), [paneClone, capture.content]);

  const { scroller, onScroll, unseen, jumpToBottom } = useFollowBottom(chat.items, chatId);

  // Starts with a first message New chat handed over, if any (chat/useHandedDraft.ts).
  const [text, setText] = useComposerText(chatId);
  const composer = useAutoGrow<HTMLTextAreaElement>(text);
  const dictation = useDictation({ text, setText, max: MAX_TEXT, chatKey: chatId });
  const [sendError, setSendError] = useState<string | null>(null);
  // The full UI's Claude has this session (history), or a send was refused for that (until a poll says it left).
  const [hold, setHold] = useState<HoldState>({ held: false, refused: false });
  const [reclaiming, setReclaiming] = useState(false);
  const reclaimingRef = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const sendingRef = useRef(false);
  // Messages Stop took back before they went: shown as "Not sent" until sent or discarded.
  const [unsent, setUnsent] = useState<string[]>([]);
  // Images attached in the composer (chat/chatImageData.ts), sent with the next message.
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [imageNote, setImageNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => { setSendError(null); setUnsent([]); setImages([]); setImageNote(null); setDragging(false); setHold({ held: false, refused: false }); }, [chatId]);

  // Sends one message. A failure puts it back where it came from: the
  // composer, or the "Not sent" list. Sending always follows the transcript
  // to the bottom, where the message shows. Nothing goes out while Open in
  // full UI is handing the session to the pane.
  const deliver = useCallback(async (raw: string, from: 'composer' | 'unsent' | 'retry', attached: PreparedImage[] = []) => {
    const message = raw.trim();
    if ((!message && !attached.length) || sendingRef.current || openingRef.current || reclaimingRef.current || recovery) return;
    if (!runnerReady) {
      // The pre-ready queue holds text in this browser's storage; images wait in the composer.
      if (attached.length) { setSendError('Images can be sent once Claude is ready'); return; }
      if (enqueue(message)) { if (from === 'composer') setText(''); }
      else setSendError('This browser would not hold the message until Claude is ready. Send it again once it is.');
      return;
    }
    sendingRef.current = true;
    setSendError(null);
    jumpToBottom();
    const pendingKey = `pending:${attached.length ? attached[0].id : 'text'}:${Date.now()}`;
    setChat(s => addPending(s, message, attached.map(i => ({ mediaType: i.mediaType, src: i.src })), pendingKey));
    if (from === 'composer') { setText(''); setImages([]); setImageNote(null); }
    const picked = modelPick;
    try {
      await chatApi.send(project.id, workstream, message, attached.map(i => ({ mediaType: i.mediaType, data: i.data })), picked);
      if (picked) modelSent(picked);
      activityApi.heartbeat(project.name, project.instanceId ?? null).catch(() => {});
    } catch (err) {
      setChat(s => {
        // The bubble this send added; without images, any pending one with its text, as before.
        const i = attached.length ? s.items.findIndex(it => it.key === pendingKey)
          : s.items.findIndex(it => it.kind === 'user' && it.pending && it.text === message);
        return i >= 0 ? { ...s, items: [...s.items.slice(0, i), ...s.items.slice(i + 1)] } : s;
      });
      if (from === 'composer') { setText(message); setImages(attached); }
      if (from === 'unsent') setUnsent(u => [...u, message]);
      const e = errorOf(err, 'Send failed');
      if (refusalFromSend(e.code)) setHold(h => ({ ...h, refused: true }));
      else setSendError(e.text);
    } finally {
      sendingRef.current = false;
    }
  }, [runnerReady, enqueue, setText, jumpToBottom, project.id, project.name, project.instanceId, workstream, recovery, modelPick, modelSent]);
  const send = () => { dictation.detach(); return deliver(text, 'composer', images); };

  // The full UI's Claude has the session. Exit it when it is really there, or
  // clear a stale hold, then send what is in the composer (images included).
  // Nothing is typed when the pane is already a shell.
  const returnToChat = async () => {
    if (reclaimingRef.current || openingRef.current || recovery) return;
    dictation.detach();
    const message = text.trim();
    const attached = images;
    const drafting = Boolean(message || attached.length);
    reclaimingRef.current = true;
    setReclaiming(true);
    setSendError(null);
    const pendingKey = `pending:${attached.length ? attached[0].id : 'text'}:${Date.now()}`;
    if (drafting) {
      setChat(s => addPending(s, message, attached.map(i => ({ mediaType: i.mediaType, src: i.src })), pendingKey));
      setText('');
      setImages([]);
      setImageNote(null);
      jumpToBottom();
    }
    const restore = () => {
      if (!drafting) return;
      setChat(s => {
        const i = attached.length ? s.items.findIndex(it => it.key === pendingKey)
          : s.items.findIndex(it => it.kind === 'user' && it.pending && it.text === message);
        return i >= 0 ? { ...s, items: [...s.items.slice(0, i), ...s.items.slice(i + 1)] } : s;
      });
      setText(message);
      setImages(attached);
    };
    try {
      const picked = drafting ? modelPick : null;
      const res = await chatApi.reclaim(project.id, workstream, message, attached.map(i => ({ mediaType: i.mediaType, data: i.data })), picked);
      if (!res.reclaimed) {
        restore();
        setHold({ held: true, refused: true });
        return;
      }
      setHold({ held: false, refused: false });
      if (res.sent) {
        if (picked) modelSent(picked);
        activityApi.heartbeat(project.name, project.instanceId ?? null).catch(() => {});
      } else restore();
    } catch (err) {
      restore();
      const e = errorOf(err, 'Could not return this chat');
      if (refusalFromSend(e.code)) setHold({ held: true, refused: true });
      else setSendError(e.text);
    } finally {
      reclaimingRef.current = false;
      setReclaiming(false);
    }
  };

  // Dropped, pasted or picked files: the images among them, made small enough to send.
  const attach = useCallback(async (files: File[]) => {
    if (!files.length) return;
    const { take, note } = admitImages(imagesRef.current.length, files);
    setImageNote(note);
    const ready: PreparedImage[] = [];
    for (const f of take) {
      try { ready.push(await prepareImage(f)); } catch (err) { setImageNote((err as Error).message); }
    }
    if (ready.length) setImages(held => [...held, ...ready].slice(0, MAX_CHAT_IMAGES));
  }, []);
  const sendUnsent = (i: number) => {
    const message = unsent[i];
    setUnsent(u => u.filter((_, j) => j !== i));
    if (message != null) void deliver(message, 'unsent');
  };

  const trustRepo = () => {
    setTrusting(true);
    chatApi.trust(project.id)
      .then(r => setTrust(r.trust))
      .catch(err => setSendError(errorOf(err, `Could not trust the ${trustNoun}`).text))
      .finally(() => setTrusting(false));
  };

  // Stop also drops what was queued behind the turn: those bubbles come down
  // (the box's queue-dropped event does the same for every open view) and
  // come back as "Not sent" bubbles with Send and Discard. They never go back
  // into the composer, where the next message would be glued onto them.
  const stop = useCallback((scope: 'turn' | 'all' = 'all') => {
    setChat(s => applyEvent(s, { type: 'user-stop', scope }));
    chatApi.interrupt(project.id, workstream, scope)
      .then(r => {
        const dropped = r.dropped ?? [];
        if (!dropped.length) return;
        setChat(s => applyEvent(s, { type: 'queue-dropped', texts: dropped }));
        setUnsent(u => [...u, ...dropped.filter(t => t.trim())]);
      })
      .catch(() => {});
  }, [project.id, workstream]);

  // Stopping everything ends Claude's background tasks (it kills them as it
  // exits), and a turn-only stop still ends its subagents, so either asks
  // first when it would end something running in the background.
  const background = chat.background ?? [];
  const subagents = background.filter(t => t.subagent);
  const control = stopControl(chat, stopsTurn);
  const [confirmStop, setConfirmStop] = useState<'turn' | 'all' | null>(null);
  const [stopMenu, setStopMenu] = useState(false);
  const requestStop = useCallback((scope: 'turn' | 'all') => {
    setStopMenu(false);
    if (scope === 'turn' ? subagents.length : background.length) setConfirmStop(scope);
    else stop(scope);
  }, [background.length, subagents.length, stop]);
  const mainStop = useCallback(() => requestStop(control === 'split' ? 'turn' : 'all'), [control, requestStop]);

  // Escape stops a running turn (the Stop button's own action), unless a
  // dialog is open (Escape closes that) or the stop menu is (Escape closes it).
  const running = chat.running && !recovery;
  useEffect(() => { if (!running) { setConfirmStop(null); setStopMenu(false); } }, [running]);
  useEffect(() => { if (control !== 'split') setStopMenu(false); }, [control]);
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      if (stopMenu) setStopMenu(false);
      else mainStop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, mainStop, stopMenu]);
  const stopSplit = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!stopMenu) return;
    const onDown = (e: PointerEvent) => {
      if (!stopSplit.current?.contains(e.target as Node)) setStopMenu(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [stopMenu]);

  // Open in full UI continues this session in the agent pane, then goes
  // there; a turn still running is refused, and says so here. One at a time,
  // and nothing is sent from here meanwhile: the pane is about to own the session.
  const openFull = async () => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    try {
      await chatApi.openInTerminal(project.id, workstream);
    } catch (err) {
      const e = errorOf(err, '');
      if (e.code === 'turn-running' || e.code === 'ask-chat') {
        setSendError(e.text);
        openingRef.current = false;
        setOpening(false);
        return;
      }
    }
    navigate(fullUiHref(project.id, workstream));
  };

  // Archive moves the chat off the live list and into Archived. The box
  // stops or hibernates when this chat is the only one on it. A box that
  // stays up is remembered, so this view and a later open show Stop/Hibernate
  // instead of a history 404. The row stays archived.
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [stoppingBox, setStoppingBox] = useState(false);
  const [archiveDialog, setArchiveDialog] = useState(false);
  const archiveNotice = recovery
    ? { message: recovery.message, retry: recovery.retry }
    : null;
  const leaveArchived = async (to: string) => {
    setArchiveDialog(false);
    await reloadProjects();
    navigate(to);
  };
  // The archived project is absent from the live list and session access
  // 404s it, so the full UI opens at the workspace home, where the box menu
  // can stop the box. Forget this chat as last-active or that home restores
  // `/?project=` for it. The recovery stays, so opening the chat again still
  // offers Stop/Hibernate.
  const openRunningBox = async () => {
    dropLastActiveProject(project.id, typeof localStorage === 'undefined' ? null : localStorage, LAST_ACTIVE_PROJECT_KEY);
    await leaveArchived(stillRunningWorkspaceHref());
  };
  const dismissArchiveDialog = () => {
    setArchiveDialog(false);
    if (recovery?.announced) dismissRunningBoxNotice(project.id);
  };
  const archive = async () => {
    setConfirmArchive(false);
    setArchiving(true);
    try {
      const res = await chatsApi.archive(project.id);
      announceChatsChanged();
      void boxFeed.reload();
      const notice = archiveBoxNotice(res.box);
      if (!notice.leave) {
        saveRunningBox(runningBoxFromNotice(project, notice));
        setArchiveDialog(true);
        setSendError(notice.message);
        await reloadProjects().catch(() => {});
        setArchiving(false);
        return;
      }
      clearRunningBox(project.id);
      await reloadProjects().catch(() => {});
      navigate('/chat');
    } catch (err) {
      setSendError(errorOf(err, 'Could not archive the session').text);
      setArchiving(false);
    }
  };
  const retryBoxPower = async () => {
    if (!archiveNotice?.retry || !project.instanceId) return;
    setStoppingBox(true);
    try {
      if (archiveNotice.retry === 'hibernate') await instancesApi.hibernate(project.instanceId);
      else await instancesApi.stop(project.instanceId);
      announceChatsChanged();
      void boxFeed.reload();
      await leaveArchived('/chat');
      clearRunningBox(project.id);
    } catch (err) {
      const text = errorOf(err, 'The box did not stop').text;
      if (parkedPowerError(text)) {
        await leaveArchived('/chat');
        clearRunningBox(project.id);
        return;
      }
      const notice = archiveBoxNotice({ action: archiveNotice.retry, error: text });
      if (!notice.leave) {
        saveRunningBox({ ...runningBoxFromNotice(project, notice), announced: false });
        setSendError(notice.message);
      }
    } finally {
      setStoppingBox(false);
    }
  };

  const setupFailed = steps.some(s => s.state === 'failed');
  const activeStep = steps.find(s => s.state === 'active' || s.state === 'failed');
  const showHold = (hold.held || hold.refused) && !recovery;
  const status = statusBesideHold(showHold, chat.running, recovery
    ? { tone: 'error' as const, text: recovery.message }
    : showSteps && !runnerReady && !loadError
    ? { tone: 'working' as const, text: `Setting up · ${(held ? setup.label : activeStep?.text.toLowerCase()) ?? 'starting claude'}` }
    : loadError ? { tone: 'error' as const, text: loadError.text } : chatStatus(chat, sendsLive));
  // Before the runner is ready a message is queued (main workstream only, where the queue lives).
  const canSend = !opening && !reclaiming && !recovery && !setupFailed && !loadError && (runnerReady || workstream === 'main');
  const total = chatCostTotal(chat);
  const replies = Object.keys(chat.costs).length;
  const echoShown = echo && !queued && !chat.items.some(it => it.kind === 'user' && it.text === echo);
  const settingUp = showSteps && !runnerReady && !loadError && !recovery;
  const retry = retryMessage(chat);
  const takesImages = imageInput && runnerReady && canSend;
  // Send shows only once there is something to send: text, or images where they are taken.
  const hasDraft = text.trim() !== '' || (takesImages && images.length > 0);
  const dropHandlers = takesImages ? {
    onDragEnter: (e: React.DragEvent) => { if (dragHasFiles(e.dataTransfer.types)) { e.preventDefault(); setDragging(true); } },
    onDragOver: (e: React.DragEvent) => { if (dragHasFiles(e.dataTransfer.types)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (e: React.DragEvent) => {
      if (!dragHasFiles(e.dataTransfer.types)) return;
      e.preventDefault();
      setDragging(false);
      void attach(imageFilesOf(e.dataTransfer.files));
      composer.current?.focus();
    },
  } : {};

  // The sidebar row shows exactly this status line and Claude's last words.
  const liveKey = chatLiveKey(project.id, workstream);
  const preview = useMemo(() => lastAssistantText(chat.items), [chat.items]);
  const liveTone = settingUp ? 'setup' : status.tone;
  useEffect(() => {
    publishChatStatus(liveKey, { tone: liveTone, text: status.text, preview });
  }, [liveKey, liveTone, status.text, preview]);
  useEffect(() => () => publishChatStatus(liveKey, null), [liveKey]);

  // Opening the chat (and the composer opening once setup is done) puts the cursor in it.
  useEffect(() => {
    if (canSend) composer.current?.focus();
  }, [chatId, canSend, composer]);
  // And so does a click in the transcript (chat/transcriptFocus.ts).
  const transcriptFocus = useTranscriptFocus(composer, canSend);

  const canArchive = project.role !== 'collaborator' && workstream === 'main';
  const archiveLabel = archiving ? 'Archiving…' : archiveNotice ? 'Archived' : 'Archive';
  const phoneActions: MenuAction[] = [
    ...(canArchive ? [{ label: archiveLabel, disabled: archiving || chat.running || archiveNotice != null, onSelect: () => setConfirmArchive(true) }] : []),
    archiveNotice
      ? { label: 'Open in full UI', onSelect: () => { void openRunningBox(); } }
      : { label: opening ? 'Opening…' : 'Open in full UI', disabled: opening, onSelect: () => { void openFull(); } },
    ...(sidePanel ? [{ label: sidePanel.open ? 'Hide tools' : 'Show tools', onSelect: sidePanel.toggle }] : []),
    ...(total != null ? [{ label: `${formatCost(total)} so far`, disabled: true, onSelect: () => {} }] : []),
  ];

  return (
    <div className="chat-view">
      <section className="chat-conv" {...dropHandlers}>
        {dragging && <div className="chat-drop-overlay" aria-hidden="true">Drop images to attach</div>}
        <header className={phone ? 'chat-header chat-header-agent' : 'chat-header'}>
          <ChatHistoryButton />
          <div className="chat-title">
            {phone
              ? <AgentIcon status={chat.running ? 'working' : 'idle'} />
              : <span className="chat-glyph" data-status={chat.running ? 'working' : 'idle'} aria-hidden="true">{chat.running ? '●' : '○'}</span>}
            <span className="chat-title-name">{project.name}</span>
            {workstream !== 'main' && <span className="chat-title-ws">· {workstream}</span>}
            <ChatSpaceChip instanceId={project.instanceId} />
            {repo && <span className="chat-title-repo" title={project.repoUrl ?? undefined}>{repo}</span>}
            <ChatBoxTag project={project} box={box} />
          </div>
          <div className="chat-header-actions">
            {phone ? <ChatMoreButton label={`${project.name}: actions`} actions={phoneActions} /> : <>
            <SidePanelButton />
            {total != null && (
              <span className="sdk-cost-total" title={`What this session has cost so far, over ${replies} ${replies === 1 ? 'reply' : 'replies'}. Hover a reply for its own.`}>
                {formatCost(total)} total
              </span>
            )}
            {project.role !== 'collaborator' && workstream === 'main' && (
              <button type="button" className="btn-ghost" disabled={archiving || chat.running || archiveNotice != null} onClick={() => setConfirmArchive(true)}
                title={chat.running ? 'Wait for the turn to end' : archiveNotice ? 'This session is archived. Its box is still running.' : 'Archive the session. The box stops when this session is the only one on it.'}>
                {archiving ? 'Archiving…' : archiveNotice ? 'Archived' : 'Archive'}
              </button>
            )}
            {archiveNotice
              ? (
                <button type="button" className="btn-ghost chat-full-ui" onClick={() => { void openRunningBox(); }}>
                  <span className="chat-full-ui-long">Open in full UI</span>
                  <span className="chat-full-ui-short">Full UI</span>
                </button>
              )
              : (
                <button type="button" className="btn-ghost chat-full-ui" onClick={() => { void openFull(); }} disabled={opening}
                  title={chat.sessionId ? `Continues this session in the terminal (claude --resume ${chat.sessionId})` : 'Opens this session in the classic layout'}>
                  {opening ? 'Opening…' : (
                    <>
                      <span className="chat-full-ui-long">Open in full UI</span>
                      <span className="chat-full-ui-short">Full UI</span>
                    </>
                  )}
                </button>
              )}
            </>}
          </div>
          {confirmArchive && createPortal(
            <ConfirmDialog
              tone="primary"
              message={<>Archive <strong>{project.name}</strong>? The box stops when this session is the only one on it, and then it costs only storage. If the box stays up, this session says so. Reopen it from Archived any time: the session stays on the box.</>}
              confirmLabel="Archive"
              onConfirm={() => { void archive(); }}
              onCancel={() => setConfirmArchive(false)}
            />,
            document.body,
          )}
          {archiveNotice && (archiveDialog || recovery?.announced) && createPortal(
            <Dialog ariaLabel="Box still running" onClose={dismissArchiveDialog} closeDisabled={stoppingBox}>
              <div className="confirm-message" role="alert">{archiveNotice.message}</div>
              <div className="confirm-actions">
                <button type="button" className="confirm-btn confirm-btn-cancel" disabled={stoppingBox} onClick={dismissArchiveDialog}>Keep this session open</button>
                {archiveNotice.retry
                  ? <button type="button" className="confirm-btn confirm-btn-primary" disabled={stoppingBox} onClick={() => { void retryBoxPower(); }}>{stoppingBox ? 'Stopping…' : archiveNotice.retry === 'hibernate' ? 'Hibernate box' : 'Stop box'}</button>
                  : <button type="button" className="confirm-btn confirm-btn-primary" onClick={() => { void openRunningBox(); }}>Open in full UI</button>}
              </div>
            </Dialog>,
            document.body,
          )}
        </header>

        <div className="chat-transcript" ref={scroller} onScroll={onScroll} {...transcriptFocus}>
          <div className={`chat-transcript-inner sdk-transcript ${REPLAY_BLOCK_CLASS}`}>
            {archiveNotice && (
              <div className="chat-archived-error" role="alert">
                <div>{archiveNotice.message}</div>
                <div className="chat-setup-actions">
                  {archiveNotice.retry && (
                    <button type="button" className="btn-tiny" disabled={stoppingBox} onClick={() => { void retryBoxPower(); }}>
                      {stoppingBox ? 'Stopping…' : archiveNotice.retry === 'hibernate' ? 'Hibernate box' : 'Stop box'}
                    </button>
                  )}
                  <button type="button" className="btn-tiny" disabled={stoppingBox} onClick={() => { void openRunningBox(); }}>Open in full UI</button>
                  <button type="button" className="btn-tiny" disabled={stoppingBox} onClick={() => { void leaveArchived('/chat'); }}>Back to sessions</button>
                </div>
              </div>
            )}
            {!recovery && showSteps && history !== 'error' && (
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
              <div className="chat-empty">
                Ask Claude anything about {repo ?? project.name}.{' '}
                {trust?.trusted
                  ? 'It works in its own box and can run commands and edit files there.'
                  : `It can read the code and answer, but can't run commands or edit files until the ${trustNoun} is trusted.`}
              </div>
            )}
            {groupTurns(chat.items).map((g, gi, groups) => {
              if (g.kind === 'user') return <ItemView key={g.item.key} item={g.item} projectId={project.id} workstream={workstream} />;
              const meta = g.userKey ? turnMeta(chat.costs[g.userKey]) : null;
              const grouped = groupToolRuns(g.items);
              const lastGroup = gi === groups.length - 1;
              return (
                <div key={g.key} className="sdk-reply">
                  {grouped.map((e, i) => (e.kind === 'tools'
                    ? <ToolRun key={e.key} tools={e.tools} />
                    : <ItemView key={e.item.key} item={e.item} projectId={project.id} workstream={workstream}
                        onRetry={retry != null && canSend && lastGroup && i === grouped.length - 1 ? () => { void deliver(retry.text, 'retry', retry.images.map((im, k) => ({ ...im, id: `retry${k}`, name: 'image' }))); } : undefined} />))}
                  {meta && <div className="sdk-reply-meta">{meta}</div>}
                </div>
              );
            })}
            {echoShown && <div className="sdk-user"><div className="sdk-user-bubble">{echo}</div></div>}
            {queued && (
              <div className="sdk-user" data-pending="">
                <div className="sdk-user-bubble">{queued}</div>
                <div className="sdk-user-note">{queueError ? `not sent: ${queueError}` : 'sent as soon as Claude is ready'}</div>
                {queueError && <button type="button" className="btn-tiny chat-queued-retry" onClick={retryQueued}>Retry</button>}
              </div>
            )}
            <UnsentMessages texts={unsent} disabled={!canSend} onSend={sendUnsent}
              onDiscard={i => setUnsent(u => u.filter((_, j) => j !== i))} />
          </div>
        </div>
        <div className="chat-bottom">
          {unseen && <button type="button" className="chat-jump" onClick={jumpToBottom}>↓ new output</button>}
          <ClaudeLoginCard projectId={project.id} owner={project.role !== 'collaborator'} enabled />
          {trust && !trust.trusted && (
            <div className="chat-trust" role="note">
              <span>Claude can read {repo ?? 'this project'} but can't run commands or edit files in this session until the {trustNoun} is trusted.</span>
              {canTrust
                ? <button type="button" className="btn-tiny" onClick={trustRepo} disabled={trusting}>{trusting ? 'Trusting…' : `Trust this ${trustNoun}`}</button>
                : <span className="chat-trust-note">Only the project's owner can trust it.</span>}
            </div>
          )}
          <div className="chat-status" data-tone={status.tone === 'idle' ? 'idle' : status.tone === 'error' ? 'offline' : showSteps && !runnerReady ? 'setup' : 'working'} role="status" aria-live="polite">
            {!recovery && chat.running && <span className="sdk-spinner" aria-hidden="true" />}{status.text}
          </div>
          {/* One surface: the images, the text, and a bar with the model on the left and
              attach, dictate and send (or stop) on the right. Send shows once there is
              something to send. */}
          <form className="chat-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
            {takesImages && <ComposerImages images={images} onRemove={id => setImages(held => held.filter(i => i.id !== id))} />}
            <textarea
              ref={composer}
              className="chat-input"
              value={text}
              onChange={e => { dictation.onEdit(); setText(e.target.value.slice(0, MAX_TEXT)); }}
              onPaste={takesImages ? e => {
                const files = imageFilesOf(e.clipboardData.files);
                if (!files.length) return;
                // An image copied with its caption (a web page) pastes both; a bare image pastes nothing else.
                if (!e.clipboardData.getData('text/plain')) e.preventDefault();
                void attach(files);
              } : undefined}
              onKeyDown={e => {
                if (dictation.onKeyDown(e)) return;
                // Enter sends, Shift+Enter is a newline: the runner takes the message as is.
                if (isSendKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) { e.preventDefault(); void send(); }
              }}
              placeholder={setupFailed ? 'Setup failed' : !runnerReady ? 'Message Claude… (sent when it is ready)' : chat.running ? (sendGoesLive(chat, sendsLive) ? 'Message Claude… (it reads this at its next step)' : 'Message Claude… (sent after this turn)') : 'Message Claude…'}
              rows={1}
              disabled={!canSend}
            />
            <div className="chat-composer-bar">
              <ModelPicker model={model} options={modelOptions} onChange={chooseModel} open={modelOpen} onOpenChange={setModelOpen} disabled={!modelReady} />
              {modelPick && <span className="chat-composer-note">From your next message</span>}
              <div className="chat-compose-actions">
                {takesImages && (
                  <>
                    <button type="button" className="chat-icon-btn chat-attach" aria-label="Attach images" title="Attach images (or drop or paste them)"
                      onClick={() => picker.current?.click()}>
                      <PlusIcon />
                    </button>
                    <input ref={picker} type="file" accept={CHAT_IMAGE_ACCEPT} multiple hidden
                      onChange={e => { void attach(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
                  </>
                )}
                <DictationButton dictation={dictation} disabled={!canSend} />
                {running && control === 'split' && (
                  <div className="chat-stop-split" ref={stopSplit}>
                    <button type="button" className="chat-stop-btn chat-stop-main" onClick={mainStop} aria-label="Stop" title={stopTitle(background, 'split')}>
                      <StopIcon />
                    </button>
                    <button
                      type="button"
                      className="chat-stop-caret"
                      aria-label="More ways to stop"
                      aria-haspopup="menu"
                      aria-expanded={stopMenu}
                      onClick={() => setStopMenu(m => !m)}
                    ><span className="chat-compose-caret" aria-hidden="true" /></button>
                    {stopMenu && (
                      <div className="chat-stop-menu" role="menu">
                        <button type="button" role="menuitem" onClick={() => requestStop('all')}>
                          <span className="chat-stop-menu-label">Stop everything</span>
                          <span className="chat-stop-menu-hint">{background.length ? `Also ends ${background.length === 1 ? 'the background task' : `the ${background.length} background tasks`}` : 'Ends the turn and anything it starts in the background'}</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {running && control === 'background' && (
                  <button type="button" className="chat-stop-btn chat-stop-wide" onClick={mainStop} title={stopTitle(background, control)}>
                    <StopIcon /><span>Stop background work</span>
                  </button>
                )}
                {running && control === 'plain' && (
                  <button type="button" className="chat-stop-btn" onClick={mainStop} aria-label="Stop" title={stopTitle(background, control)}>
                    <StopIcon />
                  </button>
                )}
                {hasDraft && (
                  <button type="submit" className="chat-send-btn" aria-label="Send" title="Send (Enter)" disabled={!canSend}>
                    <SendIcon />
                  </button>
                )}
              </div>
            </div>
          </form>
          {confirmStop && createPortal(
            <ConfirmDialog
              message={confirmStop === 'turn' ? <>
                Stop Claude? Background commands keep running, but {subagents.length === 1 ? 'the background subagent ends' : `the ${subagents.length} background subagents end`} with the stop:
                <ul className="chat-stop-tasks">{subagents.map((t, i) => <li key={i}>{t.description}</li>)}</ul>
              </> : <>
                Stop Claude? This ends the turn now, and with it {background.length === 1 ? 'the background task' : `the ${background.length} background tasks`} it started:
                <ul className="chat-stop-tasks">{background.map((t, i) => <li key={i}>{t.description}</li>)}</ul>
                A <code>termag ask</code> among them stops waiting, but the ask keeps running on its box (its commits still open a draft PR); its reply won't come back to this session.
              </>}
              confirmLabel={confirmStop === 'turn' ? 'Stop' : 'Stop everything'}
              onConfirm={() => { const scope = confirmStop; setConfirmStop(null); stop(scope); }}
              onCancel={() => setConfirmStop(null)}
            />,
            document.body,
          )}
          {/* A line kept under the composer for its notes, so one appearing doesn't push it up. */}
          <div className="chat-composer-notes">
            <DictationNote dictation={dictation} />
            {takesImages && imageNote && <div className="chat-composer-note" data-error="">{imageNote}</div>}
            {showHold && (
              <TerminalHoldNotice busy={reclaiming || opening} onReturn={() => { void returnToChat(); }} onFullUi={() => { void openFull(); }} />
            )}
            {sendError && <div className="chat-composer-note" data-error="">{sendError}</div>}
          </div>
        </div>
      </section>
    </div>
  );
}
