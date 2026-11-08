// The state behind one SDK chat's composer: the history from the box and
// its live frames, the composer's chrome (trust, model, effort, images), the
// queue for a runner not ready yet, sending, Stop and the full UI's hold.
// SdkChatView draws the conversation from it, and SdkComposer the composer;
// moved here from SdkChatView unchanged, so another view can show the same
// composer for a session.
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { historyComingUp, historyFailureIsSetup, isPowerRestart, readRunningBox, subscribeRunningBoxes, type ReopenNavigationState } from '../../chat/archive';
import { activityApi, chatApi, instancesApi, type ChatContinuation, type ChatTrust } from '../../services/api';
import { CONTINUATION_POLL_MS, continuationPolls, continuationStatus, heldToShow } from '../../chat/continuation';
import { useProjects } from '../../contexts/ProjectContext';
import { useAuth } from '../../contexts/AuthContext';
import { sessionName } from '../../utils/sessionName';
import { statusKey } from '../../utils/statusKey';
import { boxFeed } from '../../services/boxFeed';
import { useSetupContext } from '../../hooks/useSetupContext';
import { cloneTile } from '../../utils/cloneTile';
import { chatEvents } from '../../chat/chatEvents';
import { MAX_KEYS } from '../../chat/compose';
import { reduceHold, refusalFromSend, statusBesideHold, type HoldState } from '../../chat/terminalHold';
import { chatLiveKey, publishChatStatus } from '../../chat/chatLiveStatus';
import { bootEstimateMinutes, boxComingUp, setupSteps } from '../../chat/newChat';
import { recordChatAction, recordTypedChatCommand } from '../../usageEvents';
import { addPending, applyEvent, applyFrame, chatCostTotal, chatStatus, contextActions, desktopStepReloads, desktopTurnStatus, desktopTurnStep, emptyChat, carryEarlier, firstUuid, fromHistory, lastAssistantText, liveFrameAction, mergeHistory, rememberedUsage, rememberUsage, retryMessage, sdkReadiness, seedLiveTurn, stopChoices, stopControl, withEarlier, withKeptUsage, withWaiting, type ChatItem, type ChatState, type ContextAction, type FrameCursor, type HistoryLoad } from '../../chat/sdkChat';
import type { ContextControls } from '../../chat/ContextRing';
import { chromeFromHistory, composerChrome, rememberChrome, rememberedChrome, updateRememberedChrome, type ComposerChrome } from '../../chat/composerChrome';
import { fullUiHref, repoSlug } from '../../chat/simpleChat';
import { useAutoGrow } from '../../chat/useAutoGrow';
import { useComposerText } from '../../chat/useHandedDraft';
import { useDictation } from '../../chat/useDictation';
import { useQueuedMessage } from '../../chat/useQueuedMessage';
import { readModelPick, useChatModel } from '../../chat/useChatModel';
import { readEffortPick, useChatEffort } from '../../chat/useChatEffort';
import { queueKey, readQueued, writeLastPick } from '../../chat/newChat';
import { chatEffortWire, chatModelTakesPdfs, type ChatEffortId, type ChatEffortWire, type ChatModelId } from '../../chat/composer';
import { useChatModelOptions } from '../../chat/useChatModelOptions';
import { CHAT_PDF_TYPE, MAX_CHAT_IMAGES, type PreparedImage } from '../../chat/chatImageData';
import { useComposerAttachments } from '../../chat/useComposerAttachments';
import { attachmentsPhrase, finishFirstMessage, firstImages, firstMessageText, releaseFirstImages } from '../../chat/firstImages';
import { heldBoxFiles, heldTextFiles, messageTooLong, queueJoinRefusal, splitTextFiles, withTextFiles, type BoxFile, type TextFile } from '../../chat/chatTextFiles';
import type { BoxFileUpload } from '../../chat/useComposerAttachments';
import { FLAGS, useFlag } from '../../flags';
import type { Project } from '../../types';
import { useSimpleDataIfAny } from './simpleData';
import { useChatChrome } from './chatChrome';
import { countSent } from '../../chat/fileChat';
import { createHeadingStore, headingOfEvent } from '../../chat/toolGroupHeadings';
import { boxDownText, boxIsDown, reportStoredOpen, START_WAIT_MS, startDidNotTake, startDue, storedOpenAnswer } from '../../chat/storedOpen';

const HISTORY_POLL_MS = 2000;

// Refused held messages taken back off the orchestrator, per chat (`${projectId}|${workstream}`), for the
// page's life: a take-back that answers after its view left the chat (a switch remounts it) lands in that
// chat's composer the next time it shows, rather than being lost once the orchestrator has deleted it.
type TakenBack = { id: string; text: string; images: Array<{ mediaType: string; data: string }>; error: string };
const takenBackFor = new Map<string, TakenBack[]>();
// Held messages whose take-back is out, across this page's views, so a remount doesn't ask again.
const takingBack = new Set<string>();
const takenBackListeners = new Set<() => void>();
// How long a compact the box took may go without its turn-start frame before the view stops waiting and asks again.
const COMPACT_START_MS = 15000;

/** How many compacted dividers the chat shows: one more means a compact's turn has been folded in. */
function compactedDividers(items: readonly ChatItem[]): number {
  return items.filter(it => it.kind === 'divider' && it.variant === 'compacted').length;
}
// A running chat with no frame for this long has lost its turn-end (the box's
// agent socket dropped); refetch to settle it. Longer than any gap a healthy
// streaming turn produces, so a live turn never triggers it.
const RUNNING_STALE_MS = 15000;
// A desktop turn's steps read the history again at most this often: its tool
// posts can come many a second, and each read goes to the box.
const DESKTOP_RELOAD_MS = 2000;
export const MAX_TEXT = MAX_KEYS * 25;

export function errorOf(err: unknown, fallback: string): { code: string | null; text: string } {
  const data = (err as { response?: { data?: { error?: string; code?: string } } })?.response?.data;
  return { code: data?.code ?? null, text: data?.error ?? fallback };
}

const isPdf = (i: PreparedImage) => i.mediaType === CHAT_PDF_TYPE;
/** A composer attachment as its pending bubble shows it, and as the send carries it (a PDF with its name). */
const pendingImage = (i: PreparedImage) => ({ mediaType: i.mediaType, src: i.src, ...(isPdf(i) ? { name: i.name } : {}) });
const sentImage = (i: PreparedImage) => ({ mediaType: i.mediaType, data: i.data, ...(isPdf(i) ? { name: i.name } : {}) });

/** The send's refusals of its attachments (backend services/chatImages.ts, chatRunner.ts): a text-only Retry can go. */
const ATTACHMENT_REFUSALS = new Set(['images-unsupported', 'pdfs-unsupported', 'bad-image', 'bad-image-type', 'image-too-large', 'too-many-images']);

const browserStore = () => (typeof localStorage !== 'undefined' ? localStorage : null);

/** A queued send's failure as useQueuedMessage shows it (chat/compose.ts sendErrorText). */
function queueRefusal(text: string) {
  return { response: { data: { error: text } } };
}

/** The effort argument a send carries: the chat's choice, where the chat takes one (backend services/chatEffort.ts). */
function effortArgs(offered: boolean, id: ChatEffortId): [] | [ChatEffortWire] {
  const wire = offered ? chatEffortWire(id) : null;
  return wire ? [wire] : [];
}


/** How a view other than the conversation uses the chat (the file view, pages/chat/FileChat.tsx). The conversation passes none. */
export interface SdkChatOptions {
  /** The message as sent, from what was typed: the file view adds the file it shows. */
  decorate?: (typed: string) => string;
  /**
   * Each step of a send, for the file view's strip (chat/fileStrip.ts): a
   * direct send starting (`sending`, with which bubble of its text it will be,
   * counted before it goes), taken by the box (`sent`) or failed with its text
   * back in the box (`unsent`), or a message put in the pre-ready queue (`queued`).
   */
  onSend?: (e: { phase: 'sending'; message: string; occurrence: number } | { phase: 'sent' } | { phase: 'unsent'; error: string; typed: string; images: number } | { phase: 'queued'; message: string }) => void;
  /** The composer takes the cursor when the chat opens. Default true; off under a file, where it would pop a phone's keyboard over what you are reading. */
  autoFocus?: boolean;
  /** Escape stops a running turn wherever focus is. Default true; under a file only while focus is in the composer. */
  escapeAnywhere?: boolean;
  /**
   * Whether a send that fails puts its text and images back into this
   * composer (and the draft it keeps). Default yes; the file view says no
   * once this composer is gone (another target picked), so a late failure
   * can't overwrite that session's draft: its strip takes the text instead.
   */
  keepsFailed?: () => boolean;
}

export function useSdkChat(project: Project, workstream: string, follow: React.MutableRefObject<() => void>, opts: SdkChatOptions = {}) {
  const extra = useRef(opts);
  extra.current = opts;
  const navigate = useNavigate();
  const location = useLocation();
  const setupCtx = useSetupContext(project);
  const setup = cloneTile(project.setupStatus, setupCtx);
  const held = setup.holdTerminal;
  const chatId = `${project.id}|${workstream}`;
  const repo = repoSlug(project.repoUrl);
  // The view's own scroller follows a send to the bottom (SdkChatView's useFollowBottom).
  const jumpToBottom = useCallback(() => follow.current(), [follow]);

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
  // The chat's tool-group headings: its history's, then each frame's (chat/toolGroupHeadings.ts).
  const headingStore = useMemo(() => createHeadingStore(), [chatId]);
  const chatNow = useRef(chat);
  chatNow.current = chat;
  const decorated = (typed: string, withImages: boolean) => (extra.current.decorate && (typed || withImages) ? extra.current.decorate(typed) : typed);
  // The ring's numbers outlive this view in the tab (ChatRoute keys it by chat), for the next time it opens.
  useEffect(() => { rememberUsage(chatId, chat.usage); }, [chatId, chat.usage]);
  const [history, setHistory] = useState<HistoryLoad>('loading');
  const [checkoutReady, setCheckoutReady] = useState(false);
  const [sendsLive, setSendsLive] = useState(false);
  const [stopsTurn, setStopsTurn] = useState(false);
  // Whether the context popover offers Clear, Compact and Resume (the history's contextActions), and what this chat can never do.
  const [contextOffer, setContextOffer] = useState<'ready' | 'update' | null>(null);
  const [contextRefusals, setContextRefusals] = useState<Partial<Record<ContextAction, string>>>({});
  // Whether the composer sends other files to the box (GET …/chat fileInput), or why it can't (fileRefusal).
  const [fileOffer, setFileOffer] = useState<{ fileInput: boolean; fileRefusal?: string }>({ fileInput: false });
  // The history's trust, effort, image input and model for the composer, null
  // until it answers; until then what this page kept for the chat stands in
  // (chat/composerChrome.ts). `effortInput`: whether the model menu offers an effort.
  const [liveChrome, setLiveChrome] = useState<ComposerChrome | null>(null);
  const remembered = rememberedChrome(chatId);
  const { chrome } = composerChrome({ live: liveChrome, remembered, loading: false });
  const { trust, canTrust, imageInput, pdfInput: historyPdfs, effortInput } = chrome;
  const setTrust = (t: ChatTrust) => {
    setLiveChrome(c => (c ? { ...c, trust: t } : c));
    updateRememberedChrome(chatId, { trust: t });
  };
  const effortInputRef = useRef(false);
  effortInputRef.current = effortInput;
  const [loadError, setLoadError] = useState<{ code: string | null; text: string } | null>(null);
  const [poll, setPoll] = useState(0);
  // Whether Claude may run tools here, as the backend decided (services/chatTrust.ts): chrome.trust.
  const trustNoun = project.repoUrl ? 'repository' : 'project';
  const [stored, setStored] = useState(false);
  // A chat coming back on its box: the owner's send started a new box or the stopped one.
  const [continuation, setContinuation] = useState<ChatContinuation | null>(null);
  // A send asked for a stored chat's parked box: started once it can be.
  const [startAsked, setStartAsked] = useState(false);
  const [startingBox, setStartingBox] = useState(false);
  const startSent = useRef(false);
  // The start the route took has landed: its 202, and the box list reloaded after it.
  const [startLanded, setStartLanded] = useState(false);
  const { reloadProjects, statusMap } = useProjects();
  const viewer = useAuth()?.user;
  const [trusting, setTrusting] = useState(false);
  // The model the next message's turn runs on (chat/useChatModel.ts).
  const { model, pick: modelPick, ready: modelReady, choose: chooseSessionModel, reported: reportModel, sent: modelSent } = useChatModel(chatId);
  const [modelOpen, setModelOpen] = useState(false);
  const modelOptions = useChatModelOptions();
  // A pick of another backend's model takes no PDFs, as the send would be refused.
  const pdfInput = historyPdfs && chatModelTakesPdfs(model);
  // The effort every message goes at (chat/useChatEffort.ts).
  const { effort, choose: chooseSessionEffort, sent: effortSent, pending: effortPending } = useChatEffort(chatId);
  // A pick here is also what the next New session opens on (chat/newChat.ts readLastPick).
  const chooseModel = useCallback((id: ChatModelId) => {
    chooseSessionModel(id);
    if (modelReady) writeLastPick(typeof localStorage !== 'undefined' ? localStorage : null, { model: id });
  }, [chooseSessionModel, modelReady]);
  const chooseEffort = useCallback((id: ChatEffortId) => {
    chooseSessionEffort(id);
    writeLastPick(typeof localStorage !== 'undefined' ? localStorage : null, { effort: id });
  }, [chooseSessionEffort]);
  // The last turn event folded in, decided as each frame arrives (state
  // updaters run later, so a gap could not be read back from them).
  const cursor = useRef<FrameCursor>({ turnId: null, seq: 0 });

  // Another chat's pages, and its asks still on their way, are not this one's.
  const earlierFor = useRef(chatId);
  useEffect(() => {
    earlierFor.current = chatId;
    older.current = null;
    snapshotEntries.current = [];
    landing.current = false;
    earlierBusy.current = false;
    setEarlier({ more: false, loading: false, loaded: 0, settled: 0, error: null, stopped: false });
  }, [chatId]);

  // History from the box once the project is set up, again on every switch,
  // and again every two seconds while setup or a pane clone is still running.
  useEffect(() => {
    setChat(emptyChat); setHistory('loading'); setCheckoutReady(false); setLoadError(null); setLiveChrome(null);
    setSendsLive(false);
    setStopsTurn(false);
    setContextOffer(null);
    setContextRefusals({});
    setStored(false);
    setContinuation(null);
    setStartAsked(false);
    setStartingBox(false);
    setStartLanded(false);
    startSent.current = false;
    cursor.current = { turnId: null, seq: 0 };
    // Whether this open shows a stored transcript, for the start on open (chat/storedOpen.ts): unknown until the history answers.
    reportStoredOpen(chatId, null);
    return () => reportStoredOpen(chatId, null);
  }, [chatId]);
  // Live events that arrive while a history request is out are kept and
  // replayed on the snapshot (mergeHistory): a hard replace would drop them,
  // and a turn that ended meanwhile would come back as running.
  const liveDuringLoad = useRef<Array<{ turnId: string | null; seq?: number | null; event: unknown }> | null>(null);
  // Older history paged in from the box (chatApi.earlier), joined onto each
  // snapshot before its entry `before`; `cursor` is the box's for the oldest page.
  // `loaded` counts the loads that drew a new page, `settled` the asks that
  // ended without one; `error` is the last ask's refusal, and `stopped` says
  // it was one asking again cannot fix (an agent too old, a bad request).
  const older = useRef<{ before: string; entries: unknown[]; done: boolean; cursor?: string } | null>(null);
  const snapshotEntries = useRef<unknown[]>([]);
  const landing = useRef(false);
  const earlierBusy = useRef(false);
  const [earlier, setEarlier] = useState<{ more: boolean; loading: boolean; loaded: number; settled: number; error: string | null; stopped: boolean }>(
    { more: false, loading: false, loaded: 0, settled: 0, error: null, stopped: false });
  useEffect(() => {
    // A project still setting up loads no history: nothing stored to show instead of its box.
    if (held) reportStoredOpen(chatId, 'none');
    if (held || recovery) return;
    let cancelled = false;
    liveDuringLoad.current = [];
    chatApi.history(project.id, workstream)
      .then(h => {
        if (cancelled) return;
        // Before the transcript renders, so a reload shows each heading at once rather than swapping it in.
        headingStore.load(h.headings);
        const live = liveDuringLoad.current ?? [];
        liveDuringLoad.current = null;
        const prevEntries = snapshotEntries.current;
        snapshotEntries.current = h.entries;
        let joined = withEarlier(h.entries, older.current);
        if (!joined && older.current) {
          const carried = carryEarlier(prevEntries, h.entries, older.current);
          if (carried) {
            older.current = { ...older.current, ...carried };
            joined = withEarlier(h.entries, older.current);
          }
        }
        if (!joined) older.current = null;
        const entries = joined ?? h.entries;
        const landed = landing.current;
        landing.current = false;
        const more = older.current ? !older.current.done : h.more === true;
        setEarlier(e => ({
          ...e, more: !e.stopped && more,
          ...(landed ? { loading: false, loaded: e.loaded + 1, error: null } : {}),
        }));
        if (h.turn) {
          // A durable runner replays the running turn from its log; frames
          // that arrived during the load continue from that cursor. A frame
          // that is a real gap asks for one more load, after this one.
          let state = withWaiting(fromHistory(entries, h.sessionId, h.turn, h.turns ?? [], { running: h.running, liveInput: h.liveInput }), h.waiting);
          let again = false;
          for (const frame of live) {
            if ((frame.event as { type?: unknown } | null)?.type === 'queue-parked') again = true;
            const applied = applyFrame(state, frame);
            if (applied.gap) again = true;
            else state = applied.state;
          }
          cursor.current = state.cursor;
          const next = seedLiveTurn(state, h.liveInput);
          setChat(prev => withKeptUsage(prev, next, rememberedUsage(chatId)));
          if (again) setPoll(n => n + 1);
        } else {
          const next = seedLiveTurn(mergeHistory({ entries, sessionId: h.sessionId, running: h.running, turns: h.turns ?? [], waiting: h.waiting }, live.map(f => f.event)), h.liveInput);
          setChat(prev => withKeptUsage(prev, next, rememberedUsage(chatId)));
          cursor.current = { turnId: null, seq: 0 };
          if (live.some(f => (f.event as { type?: unknown } | null)?.type === 'queue-parked')) setPoll(n => n + 1);
        }
        setCheckoutReady(h.checkoutReady !== false);
        setSendsLive(h.sendsLive === true);
        setStopsTurn(h.stopsTurn === true);
        setContextOffer(h.contextActions ?? null);
        setContextRefusals(h.contextRefusals ?? {});
        setFileOffer({ fileInput: h.fileInput === true, ...(h.fileRefusal ? { fileRefusal: h.fileRefusal } : {}) });
        setHold(prev => {
          const next = reduceHold(prev, h.terminalHolds);
          return { held: next.held, refused: next.refused };
        });
        const answered = chromeFromHistory(h);
        rememberChrome(chatId, answered);
        setLiveChrome(answered);
        setStored(h.stored === true);
        reportStoredOpen(chatId, storedOpenAnswer(h));
        // The box answered: an ask for it is done.
        if (h.stored !== true) { setStartAsked(false); setStartLanded(false); startSent.current = false; }
        setContinuation(h.continuation ?? null);
        reportModel(h.model, h.backend);
        setHistory('ok');
        setLoadError(null);
      })
      .catch(err => {
        if (cancelled) return;
        liveDuringLoad.current = null;
        landing.current = false;
        setEarlier(e => (e.loading ? { ...e, loading: false, settled: e.settled + 1 } : e));
        reportStoredOpen(chatId, 'none');
        const e = errorOf(err, 'Could not load the session');
        // Still setting up, or a reopened chat's box still starting: keep
        // narrating and ask again. An established chat whose agent is offline
        // shows that error instead of a clone over the conversation.
        if (historyFailureIsSetup(e.code, comingUp)) { setHistory('setup'); setLoadError(null); }
        else { setHistory('error'); setLoadError(e); }
      });
    return () => { cancelled = true; };
  }, [project.id, workstream, held, poll, comingUp, recovery, reportModel, headingStore]);

  // Live events for this chat. Each turn event is numbered: one already
  // folded in (resent by an agent that restarted) is skipped, and a gap
  // (frames lost while the socket was down) loads the history again, which
  // replays the running turn exactly. An agent from before durable turns
  // sends no seq and is folded in as before.
  const lastFrameAt = useRef(Date.now());
  const turnId = useRef<string | null>(null);
  useEffect(() => chatEvents.subscribe(frame => {
    if (frame.projectId !== project.id || frame.workstream !== workstream) return;
    // The box's answer for a run's heading: not a line of the turn, so it never moves the cursor.
    const heading = headingOfEvent(frame.event);
    if (heading) { headingStore.add(heading.runKey, heading.answer); return; }
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
  }), [project.id, workstream, headingStore]);

  // The status socket reopened: it may have missed this chat's turn-end while
  // down, leaving the view stuck on "working". Refetch history to settle it.
  useEffect(() => chatEvents.subscribeReconnect(() => setPoll(n => n + 1)), []);

  // A turn ending while the box's agent socket was down drops the turn-end
  // frame — which the browser socket's reconnect does not see. When a running
  // chat has had no frame for a while, ask the box ONLY whether the turn is
  // still running, and settle it if it is not. Claude can think well past this
  // gap before its first token, so we never rebuild the transcript here: that
  // would drop streamed text the JSONL does not have yet.
  const loadEarlier = useCallback(() => {
    const oldest = () => firstUuid(older.current?.entries ?? snapshotEntries.current);
    const before = oldest();
    if (earlierBusy.current || !before) return false;
    earlierBusy.current = true;
    const askedFor = earlierFor.current;
    const current = () => earlierFor.current === askedFor;
    setEarlier(e => ({ ...e, loading: true, error: null }));
    const settle = (patch: Partial<typeof earlier> = {}) => setEarlier(e => ({ ...e, ...patch, loading: false, settled: e.settled + 1 }));
    chatApi.earlier(project.id, workstream, before, older.current?.cursor)
      .then(page => {
        if (!current()) return;
        // A history load meanwhile moved the oldest entry: this page no longer joins on.
        if (oldest() !== before) { settle(); return; }
        const prev = older.current;
        if (!page.entries.length) {
          // Not done: the box gave up looking for where this page starts, and may find it next time.
          if (!page.done) { settle({ error: 'Could not load earlier messages' }); return; }
          if (prev) older.current = { ...prev, done: true };
          settle({ more: false });
          return;
        }
        older.current = { before: prev?.before ?? before, entries: [...page.entries, ...(prev?.entries ?? [])], done: page.done, cursor: page.cursor };
        landing.current = true;
        setPoll(n => n + 1);
      })
      .catch(err => {
        if (!current()) return;
        // An away box, a timeout or a server error may answer next time; an
        // agent too old or a refused request will not, so paging stops.
        const e = errorOf(err, 'Could not load earlier messages');
        const status = (err as { response?: { status?: number } } | null)?.response?.status;
        const retry = e.code === 'box-away' || status == null || status >= 500;
        settle(retry ? { error: e.text } : { error: e.text, more: false, stopped: true });
      })
      .finally(() => { if (current()) earlierBusy.current = false; });
    return true;
  }, [project.id, workstream]);

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

  // A message the person sent puts the session's tabs on top of their space.
  const noteSent = useSimpleDataIfAny()?.items.noteSent;
  // The message waiting for the runner: New chat's first message, or anything
  // typed before the runner was ready. One sender across tabs, never twice,
  // and a failure waits for Retry.
  // The last queued message sent, as queued and as it went (chat/firstImages.ts firstMessageText), for its echo.
  const sentFirst = useRef<{ queued: string; shown: string } | null>(null);
  const sendQueued = useCallback(async (pid: string, ws: string, text: string, sendId?: string) => {
    const picked = readModelPick(`${pid}|${ws}`);
    // New session's effort, or one chosen while the message waited.
    const offered = effortInputRef.current;
    const at = readEffortPick(`${pid}|${ws}`);
    // New session's images go with its first message (chat/firstImages.ts).
    const key = queueKey(pid, ws);
    const first = firstImages(browserStore(), key);
    // A first message of attachments alone is queued as ATTACHMENTS_ONLY and goes with no text.
    const typed = firstMessageText(browserStore(), key, text);
    // What Retry does once the attachments are let go: send the text, or, with none, drop the message.
    const retryWithout = typed ? 'Retry sends the text alone' : 'and the message has no text: Retry drops it';
    if (first.lost) {
      releaseFirstImages(browserStore(), key);
      throw queueRefusal(`this page no longer has ${attachmentsPhrase(first.lost)} (it was reloaded, or another tab took the message)${typed ? '. ' : ', '}${retryWithout}; attach them again in the composer.`);
    }
    // Nothing left to send: the message was attachments alone, and they were let go above on an earlier try.
    if (!typed && !first.images.length) {
      // Dropped, not sent: its echo shows nothing.
      sentFirst.current = { queued: text.trim(), shown: '' };
      finishFirstMessage(browserStore(), key);
      return;
    }
    let answer: Awaited<ReturnType<typeof chatApi.send>>;
    try {
      answer = await chatApi.send(pid, ws, typed, first.images.map(sentImage), picked, effortArgs(offered, at)[0] ?? null, sendId);
    } catch (err) {
      // Attachments refused (the box or the viewer takes none, or one the box can't read): the text stays queued, and Retry sends it without them.
      const e = errorOf(err, 'Send failed');
      if (first.images.length && e.code && ATTACHMENT_REFUSALS.has(e.code)) {
        releaseFirstImages(browserStore(), key);
        throw queueRefusal(typed
          ? `${e.text.replace(/\.$/, '')}. Retry sends the text without ${attachmentsPhrase(first.images)}.`
          : `${e.text.replace(/\.$/, '')}, and the message has no text: Retry drops it.`);
      }
      throw err;
    }
    releaseFirstImages(browserStore(), key);
    // The queue echoes what it sent (the stand-in included); the echo shows what went.
    sentFirst.current = { queued: text.trim(), shown: typed };
    finishFirstMessage(browserStore(), key);
    noteSent?.({ projectId: pid, workstream: ws });
    // Held while the chat's box comes back: look again for the phase, as a send from the composer does.
    if (answer.held && `${pid}|${ws}` === chatId) { void reloadProjects().catch(() => {}); void boxFeed.reload(); setPoll(n => n + 1); }
    if (picked && `${pid}|${ws}` === chatId) modelSent(picked);
    if (offered && `${pid}|${ws}` === chatId) effortSent(at);
    activityApi.heartbeat(project.name, project.instanceId ?? null).catch(() => {});
  }, [project.name, project.instanceId, chatId, modelSent, effortSent, noteSent, reloadProjects]);

  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const { queued, echo, error: queueError, enqueue, retry: retryQueued } = useQueuedMessage({
    projectId: project.id,
    workstream,
    // A stored transcript reads without the box, which is not there to take
    // the message: it stays queued until the box answers the history itself,
    // unless the history says a send is taken anyway (the owner's, which
    // brings the box back and is held until it is).
    up: sdkReadiness({ held, history, checkoutReady, queued: false }).runnerReady && (!stored || continuation?.takesSends === true) && !opening,
    offline: loadError?.code === 'offline',
    send: sendQueued,
    raw: true,
  });
  // A switch to an existing chat loads its history, which is not setup: the
  // steps show only while the box or the project really is coming up. Once
  // they have shown here they stay until the runner answers, so a chat that
  // is set up in front of you never drops to the placeholder in between.
  // (ChatRoute keys this view by chat, so the latch is per chat.)
  const narrated = useRef(false);
  const { runnerReady, pollHistory, showSteps, loading } = sdkReadiness({
    held, history, checkoutReady, queued: queued != null, comingUp: comingUp || boxComingUp(box?.status) || narrated.current,
  });
  if (showSteps) narrated.current = true;
  // A first open's load holds the space of what the answer may add above and in the composer.
  const { reserve } = composerChrome({ live: liveChrome, remembered, loading });
  useEffect(() => {
    if (!pollHistory) return;
    const t = setTimeout(() => setPoll(n => n + 1), HISTORY_POLL_MS);
    return () => clearTimeout(t);
  }, [pollHistory, poll]);
  // A chat coming back on its box looks again until it has, and its held messages have gone in.
  const continuing = continuationPolls(continuation);
  useEffect(() => {
    if (!continuing) return;
    const t = setTimeout(() => setPoll(n => n + 1), CONTINUATION_POLL_MS);
    return () => clearTimeout(t);
  }, [continuing, poll]);

  // A stored chat's box that is down (chat/storedOpen.ts): opening it left the box alone, and
  // a send brings it back. Only the owner's box is in the list, so only they start it.
  const boxDown = stored && !recovery && boxIsDown(box);
  // The start goes once per ask, when the box can take it; the ask stands until the box answers the history.
  const dueBox = stored && !startSent.current && startDue(startAsked, box) ? box?.id ?? null : null;
  const chatNowId = useRef(chatId);
  chatNowId.current = chatId;
  useEffect(() => {
    if (!dueBox) return;
    const askedFor = chatId;
    startSent.current = true;
    setStartingBox(true);
    setStartLanded(false);
    // The API client has no timeout: a start that never answers must not hold the ask for the life of the view.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`The box did not answer the start (no answer in ${START_WAIT_MS / 1000} s). Send again to try once more.`)), START_WAIT_MS);
    });
    Promise.race([instancesApi.start(dueBox), late])
      .then(async () => {
        // A reload that fails leaves the list as it was; the next poll catches up.
        try { await boxFeed.reload(); } catch { /* the feed's own poll */ }
        if (chatNowId.current === askedFor) setStartLanded(true);
      }, err => {
        if (chatNowId.current !== askedFor) return;
        startSent.current = false;
        setStartAsked(false);
        // The route's own words when it answered; else the no-answer timeout's, or the network's.
        const answered = (err as { response?: unknown } | null)?.response != null;
        setSendError(answered || !(err instanceof Error) ? errorOf(err, 'Could not start the box').text : err.message);
      })
      .finally(() => { clearTimeout(timer); if (chatNowId.current === askedFor) setStartingBox(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dueBox]);
  // A start that landed on a box that is down again (still stopped, failed, gone): let go and say so; the next send starts it again.
  const didNotTake = stored && startAsked ? startDidNotTake(startLanded, box) : null;
  useEffect(() => {
    if (!didNotTake) return;
    startSent.current = false;
    setStartAsked(false);
    setStartLanded(false);
    setSendError(didNotTake);
  }, [didNotTake]);
  // Until the box answers the history itself, look again: a box that is up
  // again shows its live chat, and a message queued for it goes in.
  const awaitingBox = stored && (startAsked || startingBox || boxComingUp(box?.status));
  useEffect(() => {
    if (!awaitingBox) return;
    const t = setTimeout(() => setPoll(n => n + 1), HISTORY_POLL_MS);
    return () => clearTimeout(t);
  }, [awaitingBox, poll]);

  const eta = useMemo(() => bootEstimateMinutes(boxes), [boxes]);
  // A stale stopped/hibernated snapshot still narrates "Box … is starting".
  const narratedBox = comingUp
    ? { name: box?.name || reopenNav?.reopenBoxName || 'box', status: 'starting' as const, provisioningError: box?.provisioningError, claimedAt: box?.claimedAt }
    : box;
  const steps = useMemo(() => setupSteps({
    box: narratedBox, setupStatus: project.setupStatus, setupError: project.setupError, repo: (restart || comingUp) ? null : repo, agentUp: runnerReady, etaMinutes: eta,
  }), [narratedBox, project.setupStatus, project.setupError, repo, restart, comingUp, runnerReady, eta]);

  // Starts with a first message New chat handed over, if any (chat/useHandedDraft.ts).
  const [text, setText] = useComposerText(chatId);
  const composer = useAutoGrow<HTMLTextAreaElement>(text);
  const dictation = useDictation({ text, setText, max: MAX_TEXT, chatKey: chatId });
  const [sendError, setSendError] = useState<string | null>(null);
  // Sending is the only way this view wakes the box (the person's call on #900): no Start box.
  const askStart = useCallback(() => { setSendError(null); setStartAsked(true); }, []);
  // The full UI's Claude has this session (history), or a send was refused for that (until a poll says it left).
  const [hold, setHold] = useState<HoldState>({ held: false, refused: false });
  const [reclaiming, setReclaiming] = useState(false);
  const reclaimingRef = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const sendingRef = useRef(false);
  // The context action on its way to the box (Clear, Compact, Resume).
  const [contextBusy, setContextBusy] = useState<ContextAction | null>(null);
  const contextBusyRef = useRef(false);
  // The context action while it is out, settled once its answer is folded in: a send waits for it (deliver).
  const contextPendingRef = useRef<Promise<void> | null>(null);
  // A compact the box took, until its turn shows (how many compacted dividers there were then).
  const [compactStarting, setCompactStarting] = useState<{ dividers: number } | null>(null);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  useEffect(() => { setCompactStarting(null); contextBusyRef.current = false; setContextBusy(null); }, [chatId]);
  // Messages Stop took back before they went: shown as "Not sent" until sent or discarded.
  const [unsent, setUnsent] = useState<string[]>([]);
  // Images attached in the composer (chat/chatImageData.ts), sent with the next message.
  // Images of take-backs still on their way (below), whose room the composer keeps for them.
  const imagesComing = useRef(0);
  // Other files go to the chat's box as they are attached (backend services/chatFiles.ts). One for a box that
  // is asleep wakes it, its chip saying so, and goes once the box is up (the rule: the wait shows where it is).
  const filesOn = useFlag(FLAGS.chatFileAttachments, false);
  const upload = useCallback<BoxFileUpload>(async (file, waiting) => {
    for (let tries = 0; ; tries++) {
      try {
        return await chatApi.putFile(project.id, workstream, file);
      } catch (err) {
        const e = errorOf(err, 'the upload failed');
        if (e.code !== 'offline' || tries >= 100) throw new Error(e.text);
        waiting();
        askStart();
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }, [project.id, workstream, askStart]);
  const attachments = useComposerAttachments({
    pdfs: pdfInput, coming: imagesComing,
    upload: filesOn && fileOffer.fileInput ? upload : undefined,
    uploadRefusal: filesOn ? fileOffer.fileRefusal : undefined,
  });
  const { images, setImages, files, setFiles, boxFiles, setBoxFiles, uploading, note: imageNote, setNote: setImageNote, dragging, setDragging, imagesRef, attach } = attachments;
  useEffect(() => {
    setSendError(null); setUnsent([]); setImageNote(null); setDragging(false); setHold({ held: false, refused: false });
    // New session's images whose text this browser would not queue come with its draft, into the composer (chat/firstImages.ts).
    const key = queueKey(project.id, workstream);
    const handed = readQueued(browserStore(), key) == null ? firstImages(browserStore(), key).images : [];
    if (handed.length) releaseFirstImages(browserStore(), key);
    setImages(handed);
    // A draft handed over the same way (New session's, which this browser would not queue) carries its text
    // files folded into it (chat/chatTextFiles.ts): they go back into the composer as files.
    const draft = splitTextFiles(text);
    setFiles(draft.files.length ? heldTextFiles(draft.files, `draft-${chatId}`) : []);
    setBoxFiles(draft.boxFiles ? heldBoxFiles(draft.boxFiles, `draft-${chatId}`) : []);
    if (draft.files.length || draft.boxFiles) setText(draft.text);
  }, [chatId]);

  // Sends one message. A failure puts it back where it came from: the
  // composer, or the "Not sent" list. Sending always follows the transcript
  // to the bottom, where the message shows. Nothing goes out while Open in
  // full UI is handing the session to the pane. True once it went (or is
  // queued for when Claude is ready), for a generative-UI answer to lock on.
  // Text files (chat/chatTextFiles.ts) go in the message's text, after what was typed.
  // Other files, kept on the box, go as the path each was kept at; a message waits for one still on its way.
  const deliver = useCallback(async (raw: string, from: 'composer' | 'unsent' | 'retry', attached: PreparedImage[] = [], textFiles: TextFile[] = [], onBox: BoxFile[] = []): Promise<boolean> => {
    const typed = raw.trim();
    const pendingFile = onBox.find(f => !f.path);
    if (pendingFile) { setSendError(`${pendingFile.name} is still on its way to the box: send once its chip says it is there`); return false; }
    const kept = onBox.map(f => ({ path: f.path!, size: f.size }));
    const message = withTextFiles(decorated(typed, attached.length > 0 || textFiles.length > 0 || kept.length > 0), textFiles, kept);
    if ((!message && !attached.length) || sendingRef.current || openingRef.current || reclaimingRef.current || recovery) return false;
    const tooLong = messageTooLong(message);
    if (tooLong) { setSendError(tooLong); return false; }
    if (from === 'composer') recordTypedChatCommand(typed, 'sdk');
    // A stored chat whose box is down: the send starts the box, and the message
    // waits for it in the queue as it would for a runner not ready yet. Unless
    // the backend holds the send itself and brings the box back.
    const forBox = boxDown && continuation?.takesSends !== true;
    if (forBox) askStart();
    if (!runnerReady || forBox) {
      // The pre-ready queue holds text in this browser's storage; images wait in the composer.
      if (attached.length) { setSendError('Images can be sent once Claude is ready'); return false; }
      // Only the main workstream has a queue: the text stays in the composer for when the box is up.
      if (forBox && workstream !== 'main') { setSendError('Starting the box. Send this again once Claude is ready.'); return false; }
      // It joins the message already waiting, and the two go as one: never with files, and within one message's length.
      const joinRefusal = queued ? queueJoinRefusal(queued, message) : null;
      if (joinRefusal) { setSendError(joinRefusal); return false; }
      if (enqueue(message)) { if (from === 'composer') { setText(''); setFiles([]); setBoxFiles([]); } extra.current.onSend?.({ phase: 'queued', message }); return true; }
      setSendError('This browser would not hold the message until Claude is ready. Send it again once it is.');
      return false;
    }
    sendingRef.current = true;
    setSendError(null);
    // A Clear, Compact or Resume still on its way decides which session this
    // message goes into: a send that beat a Resume would start a new session,
    // and the box would then refuse the Resume (resume-gone). Wait for it
    // before the bubble goes in, so it lands after the divider the action
    // draws (and a message after a clear takes Resume off the table). The
    // composer empties at once, so the message is seen to go.
    const pendingContext = contextPendingRef.current;
    if (pendingContext) {
      if (from === 'composer') { setText(''); setImages([]); setFiles([]); setBoxFiles([]); setImageNote(null); }
      await pendingContext;
    }
    jumpToBottom();
    const pendingKey = `pending:${attached.length ? attached[0].id : 'text'}:${Date.now()}`;
    // Counted before it goes: a turn-start can arrive before the send's answer does.
    const occurrence = countSent(chatNow.current, message) + 1;
    extra.current.onSend?.({ phase: 'sending', message, occurrence });
    setChat(s => addPending(s, message, attached.map(pendingImage), pendingKey));
    if (from === 'composer') { setText(''); setImages([]); setFiles([]); setBoxFiles([]); setImageNote(null); }
    const picked = modelPick;
    const at = effort;
    try {
      const sentAnswer = await chatApi.send(project.id, workstream, message, attached.map(sentImage), picked, ...effortArgs(effortInput, at));
      // Held: this send is starting the box, or a new one. The project may have moved.
      if (sentAnswer.held) { void reloadProjects().catch(() => {}); void boxFeed.reload(); setPoll(n => n + 1); }
      noteSent?.({ projectId: project.id, workstream });
      if (picked) modelSent(picked);
      if (effortInput) effortSent(at);
      activityApi.heartbeat(project.name, project.instanceId ?? null).catch(() => {});
      extra.current.onSend?.({ phase: 'sent' });
      return true;
    } catch (err) {
      // What was typed, so a view whose composer is gone by now can put it back (the file view, chat/fileStrip.ts).
      extra.current.onSend?.({ phase: 'unsent', error: errorOf(err, 'Send failed').text, typed: from === 'composer' ? typed : '', images: from === 'composer' ? attached.length : 0 });
      setChat(s => {
        // The bubble this send added; without images, any pending one with its text, as before.
        const i = attached.length ? s.items.findIndex(it => it.key === pendingKey)
          : s.items.findIndex(it => it.kind === 'user' && it.pending && it.text === message);
        return i >= 0 ? { ...s, items: [...s.items.slice(0, i), ...s.items.slice(i + 1)] } : s;
      });
      if (from === 'composer' && extra.current.keepsFailed?.() !== false) { setText(typed); setImages(attached); setFiles(textFiles); setBoxFiles(onBox); }
      if (from === 'unsent') setUnsent(u => [...u, message]);
      const e = errorOf(err, 'Send failed');
      if (refusalFromSend(e.code)) setHold(h => ({ ...h, refused: true }));
      else setSendError(e.text);
      return false;
    } finally {
      sendingRef.current = false;
    }
  }, [runnerReady, history, enqueue, queued, setText, jumpToBottom, project.id, project.name, project.instanceId, workstream, recovery, modelPick, modelSent, effort, effortInput, effortSent, noteSent, boxDown, continuation, askStart]);
  const send = () => { dictation.detach(); return deliver(text, 'composer', images, files, boxFiles); };
  // A held message the box refused comes back to its sender's composer, text and images, with why (#971).
  // The first of their tabs to ask takes it off the orchestrator, once; the others see it gone.
  const takenBack = useRef(new Set<string>());
  const textNow = useRef(text);
  textNow.current = text;
  // A take-back whose images won't fit the composer (MAX_CHAT_IMAGES, counting imagesComing) waits
  // on the orchestrator, shown with why, until there is room, rather than coming back without them.
  useEffect(() => {
    for (const m of continuation?.held ?? []) {
      if (!m.error || !m.mine || takenBack.current.has(m.id) || takingBack.has(m.id)) continue;
      const count = m.images?.length ?? 0;
      if (count > 0 && imagesRef.current.length + imagesComing.current + count > MAX_CHAT_IMAGES) continue;
      takenBack.current.add(m.id);
      takingBack.add(m.id);
      imagesComing.current += count;
      const forChat = chatId;
      chatApi.takeHeld(project.id, workstream, m.id).finally(() => { imagesComing.current -= count; takingBack.delete(m.id); }).then(back => {
        // Into the page's store, not this view: whichever view shows the chat next applies it (below).
        takenBackFor.set(forChat, [...(takenBackFor.get(forChat) ?? []), { id: m.id, ...back }]);
        takenBackListeners.forEach(l => l());
      }, err => {
        // 404: another tab took it back. Anything else (the network, a 5xx): ask again on the next look.
        if ((err as { response?: { status?: number } } | null)?.response?.status === 404) return;
        takenBack.current.delete(m.id);
        setTimeout(() => setPoll(n => n + 1), CONTINUATION_POLL_MS);
      });
    }
  }, [continuation, project.id, workstream, chatId, images.length]);
  // What was taken back for this chat goes into its composer: now, or when the chat shows again.
  const [takeBackTick, setTakeBackTick] = useState(0);
  useEffect(() => {
    const l = () => setTakeBackTick(n => n + 1);
    takenBackListeners.add(l);
    return () => { takenBackListeners.delete(l); };
  }, []);
  useEffect(() => {
    const list = takenBackFor.get(chatId);
    if (!list?.length) return;
    takenBackFor.delete(chatId);
    for (const back of list) {
      // Several can come back at once: each joins what the ones before it left, not the last render's text.
      // Its text files go back into the composer as files (chat/chatTextFiles.ts).
      const split = splitTextFiles(back.text);
      const joined = [textNow.current.trim(), split.text.trim()].filter(Boolean).join('\n\n');
      textNow.current = joined;
      setText(joined);
      if (split.files.length) setFiles(prev => [...prev, ...heldTextFiles(split.files, `held-${back.id}`)]);
      if (split.boxFiles) setBoxFiles(prev => [...prev, ...heldBoxFiles(split.boxFiles!, `held-${back.id}`)]);
      setImages(prev => [...prev, ...back.images.map((i, n) => ({
        id: `held-${back.id}-${n}`, mediaType: i.mediaType, data: i.data, src: `data:${i.mediaType};base64,${i.data}`, name: 'image',
      }))]);
      setSendError(`Not sent: ${back.error}`);
    }
    setPoll(n => n + 1);
  }, [takeBackTick, chatId, setText]);

  // The context popover's actions (POST …/chat/context), with no confirm.
  // Clear and Resume answer with what changed, and this view folds it in at
  // once; the box's own frame does the same in every other open view, and is
  // the same divider here. Compact is a turn: its events arrive as any turn's do.
  const runContextAction = useCallback(async (action: ContextAction) => {
    if (contextBusyRef.current || sendingRef.current || recovery) return;
    recordChatAction(action);
    contextBusyRef.current = true;
    setContextBusy(action);
    setSendError(null);
    // A compact is a turn: its answer comes before its turn-start frame, and
    // until that frame the chat looks idle. Stay busy until the turn is seen.
    let compacting = false;
    // What a send waits on (deliver): settled only once this action's answer is
    // folded in (the divider drawn), so the send's bubble goes in after it.
    let settle = () => {};
    const applied = new Promise<void>(resolve => { settle = resolve; });
    contextPendingRef.current = applied;
    try {
      const r = await chatApi.context(project.id, workstream, action);
      compacting = action === 'compact' && r.compacting === true;
      if (action === 'clear' && r.reset && r.at) setChat(s => applyEvent(s, { type: 'context-cleared', at: r.at }));
      if (action === 'resume' && r.resumed) setChat(s => applyEvent(s, { type: 'context-resumed', at: r.at, resumedAt: r.resumedAt, sessionId: r.sessionId }));
      jumpToBottom();
    } catch (err) {
      const e = errorOf(err, action === 'compact' ? 'Could not compact the context' : action === 'resume' ? 'Could not resume the previous context' : 'Could not clear the context');
      if (refusalFromSend(e.code)) setHold(h => ({ ...h, refused: true }));
      else setSendError(e.text);
    } finally {
      if (contextPendingRef.current === applied) contextPendingRef.current = null;
      settle();
      if (compacting) setCompactStarting({ dividers: compactedDividers(chatRef.current.items) });
      else {
        contextBusyRef.current = false;
        setContextBusy(null);
      }
    }
  }, [project.id, workstream, recovery, jumpToBottom]);

  // The compact's turn has been seen (it runs, or it already left its divider):
  // let go of the busy state; Claude running keeps the buttons disabled from here.
  // If no frame comes (a dropped socket), let go after a while and ask the box.
  useEffect(() => {
    if (!compactStarting) return;
    if (chat.running || compactedDividers(chat.items) > compactStarting.dividers) {
      setCompactStarting(null);
      contextBusyRef.current = false;
      setContextBusy(null);
      return;
    }
    const t = setTimeout(() => {
      setCompactStarting(null);
      contextBusyRef.current = false;
      setContextBusy(null);
      setPoll(n => n + 1);
    }, COMPACT_START_MS);
    return () => clearTimeout(t);
  }, [compactStarting, chat.running, chat.items]);

  // The full UI's Claude has the session. Exit it when it is really there, or
  // clear a stale hold, then send what is in the composer (images included).
  // Nothing is typed when the pane is already a shell.
  const returnToChat = async () => {
    if (reclaimingRef.current || openingRef.current || recovery) return;
    dictation.detach();
    const typed = text.trim();
    const attached = images;
    const textFiles = files;
    const onBox = boxFiles;
    const pendingFile = onBox.find(f => !f.path);
    if (pendingFile) { setSendError(`${pendingFile.name} is still on its way to the box: send once its chip says it is there`); return; }
    const message = withTextFiles(decorated(typed, attached.length > 0 || textFiles.length > 0 || onBox.length > 0), textFiles, onBox.map(f => ({ path: f.path!, size: f.size })));
    const drafting = Boolean(message || attached.length);
    const tooLong = drafting ? messageTooLong(message) : null;
    if (tooLong) { setSendError(tooLong); return; }
    reclaimingRef.current = true;
    setReclaiming(true);
    setSendError(null);
    const pendingKey = `pending:${attached.length ? attached[0].id : 'text'}:${Date.now()}`;
    const occurrence = countSent(chatNow.current, message) + 1;
    if (drafting) {
      extra.current.onSend?.({ phase: 'sending', message, occurrence });
      setChat(s => addPending(s, message, attached.map(pendingImage), pendingKey));
      setText('');
      setImages([]);
      setFiles([]);
      setBoxFiles([]);
      setImageNote(null);
      jumpToBottom();
    }
    const restore = (why = 'Lab still has this session') => {
      if (!drafting) return;
      extra.current.onSend?.({ phase: 'unsent', error: why, typed, images: attached.length });
      setChat(s => {
        const i = attached.length ? s.items.findIndex(it => it.key === pendingKey)
          : s.items.findIndex(it => it.kind === 'user' && it.pending && it.text === message);
        return i >= 0 ? { ...s, items: [...s.items.slice(0, i), ...s.items.slice(i + 1)] } : s;
      });
      if (extra.current.keepsFailed?.() !== false) {
        setText(typed);
        setImages(attached);
        setFiles(textFiles);
        setBoxFiles(onBox);
      }
    };
    try {
      const picked = drafting ? modelPick : null;
      const res = await chatApi.reclaim(project.id, workstream, message, attached.map(sentImage), picked, ...effortArgs(drafting && effortInput, effort));
      if (!res.reclaimed) {
        restore();
        setHold({ held: true, refused: true });
        return;
      }
      setHold({ held: false, refused: false });
      if (res.sent) {
        noteSent?.({ projectId: project.id, workstream });
        if (picked) modelSent(picked);
        if (effortInput) effortSent(effort);
        activityApi.heartbeat(project.name, project.instanceId ?? null).catch(() => {});
        if (drafting) extra.current.onSend?.({ phase: 'sent' });
      } else restore();
    } catch (err) {
      const e = errorOf(err, 'Could not return this chat');
      restore(e.text);
      if (refusalFromSend(e.code)) setHold({ held: true, refused: true });
      else setSendError(e.text);
    } finally {
      reclaimingRef.current = false;
      setReclaiming(false);
    }
  };

  const sendUnsent = (i: number) => {
    const message = unsent[i];
    setUnsent(u => u.filter((_, j) => j !== i));
    if (message != null) void deliver(message, 'unsent');
  };

  // Trust waits for the history's answer, as the model picker does: on a switch
  // back the note is the kept one, and an answer still out would overwrite a
  // trust given meanwhile with the untrusted state it read before.
  const trustRepo = () => {
    if (liveChrome == null) return;
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
  // The chrome refresh's Stop (ComposerStop.tsx) is one button: it stops at
  // once, as far as the turn allows, or opens its menu when background
  // commands would be kept or ended. The menu's choice is the confirmation.
  const { refresh } = useChatChrome();
  const choices = refresh ? stopChoices(background, control) : [];
  const asks = refresh ? choices.length > 0 : control === 'split';
  const pressStop = useCallback(() => {
    if (!refresh) mainStop();
    else if (asks) setStopMenu(true);
    else stop(control === 'split' ? 'turn' : 'all');
  }, [refresh, asks, control, mainStop, stop]);

  // Escape stops a running turn (the Stop button's own action), unless a
  // dialog is open (Escape closes that) or the stop menu is (Escape closes it).
  const running = chat.running && !recovery;
  useEffect(() => { if (!running) { setConfirmStop(null); setStopMenu(false); } }, [running]);
  useEffect(() => { if (!asks) setStopMenu(false); }, [asks]);
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (extra.current.escapeAnywhere === false && !composer.current?.closest('.chat-bottom')?.contains(document.activeElement)) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      if (stopMenu) setStopMenu(false);
      else pressStop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, pressStop, stopMenu]);
  const stopSplit = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The refresh's menu is LaunchPad's, which closes itself on a click outside it.
    if (!stopMenu || refresh) return;
    const onDown = (e: PointerEvent) => {
      if (!stopSplit.current?.contains(e.target as Node)) setStopMenu(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [stopMenu, refresh]);

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

  const setupFailed = steps.some(s => s.state === 'failed');
  // The status line says why the composer sends when ready: a stored chat's box that is down, until a send asks for it.
  const boxDownNote = boxDown && !startAsked;
  const activeStep = steps.find(s => s.state === 'active' || s.state === 'failed');
  const showHold = (hold.held || hold.refused) && !recovery;
  // The desktop app's thread on this session's turn, while this chat's own runner rests.
  const desktopSession = statusMap?.[statusKey(project.instanceId, sessionName(project.ownerUsername ?? viewer?.unixUsername ?? '', project.name, 'agent', workstream))];
  const desktopTurn = chat.running ? null : desktopTurnStatus(desktopSession);
  // That turn writes the session file, not this chat's runner, so no chat frame
  // shows it here: each of its steps reads the history again, at most every
  // DESKTOP_RELOAD_MS, and its last (the stop) brings the reply.
  const desktopStep = chat.running ? null : desktopTurnStep(desktopSession);
  const shownDesktopStep = useRef<{ chatId: string; step: string | null } | null>(null);
  const lastDesktopReload = useRef(0);
  useEffect(() => {
    const due = desktopStepReloads(shownDesktopStep.current, chatId, desktopStep);
    if (!due) {
      if (shownDesktopStep.current?.chatId !== chatId) shownDesktopStep.current = { chatId, step: desktopStep };
      return;
    }
    const wait = Math.max(0, lastDesktopReload.current + DESKTOP_RELOAD_MS - Date.now());
    const id = setTimeout(() => {
      shownDesktopStep.current = { chatId, step: desktopStep };
      lastDesktopReload.current = Date.now();
      setPoll(n => n + 1);
    }, wait);
    return () => clearTimeout(id);
  }, [chatId, desktopStep]);
  const status = statusBesideHold(showHold, chat.running, recovery
    ? { tone: 'error' as const, text: recovery.message }
    : loading ? { tone: 'idle' as const, text: 'Loading the conversation…' }
    // Its owner's send is bringing it back: a new box, or the stopped one.
    : continuationStatus(continuation) ?? (boxDownNote && box ? { tone: 'idle' as const, text: `${boxDownText(box.status)} · sending a message starts it` }
    // Asked for: a box still stopping is started once it has stopped.
    : stored && startAsked && !startSent.current && box && (box.status === 'stopping' || box.status === 'hibernating') ? { tone: 'working' as const, text: `${boxDownText(box.status)} · it starts once it has stopped` }
    : awaitingBox ? { tone: 'working' as const, text: 'Starting the box…' }
    : showSteps && !runnerReady && !loadError
    ? { tone: 'working' as const, text: `Setting up · ${(held ? setup.label : activeStep?.text.toLowerCase()) ?? 'starting claude'}` }
    : loadError ? { tone: 'error' as const, text: loadError.text }
    // The desktop app's thread holds the session and is on a turn: this chat's own runner is idle.
    : desktopTurn ?? chatStatus(chat, sendsLive)));
  // A turn that only waits on its background tasks is open, but Claude is idle: the header's dot says so, as the status line does.
  const claudeWorking = (chat.running && chat.phase !== 'waiting') || (desktopTurn !== null && desktopSession?.status === 'working');
  // Before the runner is ready a message is queued (main workstream only, where the queue lives).
  // Only the owner continues a chat whose box is gone or down: anyone else reads it.
  const sendRefusal = continuation?.sendRefusal ?? null;
  const canSend = !opening && !reclaiming && !recovery && !setupFailed && !loadError && !sendRefusal && (runnerReady || workstream === 'main');
  // Held messages not already on screen (the send's pending bubble, or delivered as the newest message).
  const lastUser = [...chat.items].reverse().find(it => it.kind === 'user' && !it.pending);
  const heldShown = heldToShow(continuation, [
    ...chat.items.flatMap(it => (it.kind === 'user' && it.pending ? [it.text] : [])),
    ...(continuation?.held?.length && lastUser?.kind === 'user' ? [lastUser.text] : []),
  // This viewer's refused ones on their way back to the composer; one waiting for room stays shown.
  ]).filter(m => !(m.error && m.mine && takenBack.current.has(m.id)));
  const total = chatCostTotal(chat);
  const actionState = recovery ? null : contextActions({
    offered: contextOffer, refusals: contextRefusals, runnerReady, running: chat.running, held: showHold,
    sessionId: chat.sessionId, items: chat.items,
  });
  const ringActions: ContextControls | null = actionState ? { ...actionState, busy: contextBusy, onAction: a => { void runContextAction(a); } } : null;
  // Resume on the divider too: the newest one, while it is on offer.
  const resumeKey = actionState?.resume ? [...chat.items].reverse().find(it => it.kind === 'divider')?.key ?? null : null;
  const replies = Object.keys(chat.costs).length;
  // A first message of attachments alone has no text to echo: its turn shows its images.
  const echoText = echo == null ? null : echo === sentFirst.current?.queued ? sentFirst.current.shown : echo;
  const echoShown = Boolean(echoText) && !queued && !chat.items.some(it => it.kind === 'user' && it.text === echoText);
  const settingUp = showSteps && !runnerReady && !loadError && !recovery;
  const retry = retryMessage(chat);
  const takesImages = imageInput && runnerReady && canSend;
  const onResumeCleared = () => { void runContextAction('resume'); };
  const onRetryLast = () => { if (retry) void deliver(retry.text, 'retry', retry.images.map((im, k) => ({ ...im, id: `retry${k}`, name: 'image' }))); };
  // Send shows only once there is something to send: text, or images where they are taken.
  const hasDraft = text.trim() !== '' || (takesImages && (images.length > 0 || files.length > 0 || boxFiles.length > 0));
  const dropHandlers = takesImages ? attachments.dropHandlers(() => composer.current?.focus()) : {};

  // The sidebar row shows exactly this status line and Claude's last words.
  const liveKey = chatLiveKey(project.id, workstream);
  const preview = useMemo(() => lastAssistantText(chat.items), [chat.items]);
  const liveTone = settingUp ? 'setup' : status.tone;
  // While the history loads, the row keeps its own line rather than a placeholder's.
  useEffect(() => {
    publishChatStatus(liveKey, loading ? null : { tone: liveTone, text: status.text, preview });
  }, [liveKey, loading, liveTone, status.text, preview]);
  useEffect(() => () => publishChatStatus(liveKey, null), [liveKey]);

  // Opening the chat (and the composer opening once setup is done) puts the cursor in it.
  useEffect(() => {
    if (canSend && extra.current.autoFocus !== false) composer.current?.focus();
  }, [chatId, canSend, composer]);

  return {
    contextBusy,
    onResumeCleared,
    resumeKey,
    ringActions,
    claudeWorking,
    navigate,
    location,
    setupCtx,
    setup,
    held,
    boxes,
    box,
    recovery,
    reopenNav,
    comingUp,
    restart,
    setRestart,
    powerRestart,
    chat,
    setChat,
    headingStore,
    history,
    setHistory,
    checkoutReady,
    setCheckoutReady,
    sendsLive,
    setSendsLive,
    stopsTurn,
    setStopsTurn,
    liveChrome,
    setLiveChrome,
    remembered,
    chrome,
    trust,
    canTrust,
    imageInput,
    pdfInput,
    effortInput,
    setTrust,
    effortInputRef,
    loadError,
    setLoadError,
    poll,
    setPoll,
    trustNoun,
    stored,
    setStored,
    boxDown,
    trusting,
    setTrusting,
    model,
    modelPick,
    modelReady,
    chooseSessionModel,
    reportModel,
    modelSent,
    modelOpen,
    setModelOpen,
    modelOptions,
    effort,
    chooseSessionEffort,
    effortSent,
    effortPending,
    chooseModel,
    chooseEffort,
    cursor,
    liveDuringLoad,
    lastFrameAt,
    turnId,
    noteSent,
    sendQueued,
    opening,
    setOpening,
    openingRef,
    queued,
    // New session's images waiting with the queued first message (chat/firstImages.ts).
    // The queued message's text as it is shown, without New session's attachments-only stand-in.
    queuedText: queued == null ? null : firstMessageText(browserStore(), queueKey(project.id, workstream), queued),
    queuedImages: queued ? firstImages(browserStore(), queueKey(project.id, workstream)).images : [],
    echo: echoText,
    queueError,
    enqueue,
    retryQueued,
    narrated,
    runnerReady,
    pollHistory,
    showSteps,
    loading,
    reserve,
    eta,
    narratedBox,
    steps,
    text,
    setText,
    composer,
    dictation,
    sendError,
    setSendError,
    hold,
    setHold,
    reclaiming,
    setReclaiming,
    reclaimingRef,
    retrying,
    setRetrying,
    sendingRef,
    unsent,
    setUnsent,
    images,
    setImages,
    files,
    boxFiles,
    uploading,
    removeAttachment: attachments.remove,
    imageNote,
    setImageNote,
    dragging,
    setDragging,
    onPasteImages: attachments.onPaste,
    imagesRef,
    deliver,
    send,
    returnToChat,
    attach,
    sendUnsent,
    trustRepo,
    stop,
    background,
    subagents,
    control,
    confirmStop,
    setConfirmStop,
    stopMenu,
    setStopMenu,
    requestStop,
    mainStop,
    pressStop,
    stopChoices: choices,
    running,
    stopSplit,
    openFull,
    setupFailed,
    activeStep,
    showHold,
    status,
    canSend,
    sendRefusal,
    heldShown,
    total,
    replies,
    echoShown,
    settingUp,
    retry,
    takesImages,
    onRetryLast,
    hasDraft,
    dropHandlers,
    liveKey,
    preview,
    liveTone,
    chatId,
    repo,
    jumpToBottom,
    earlier,
    loadEarlier,
  };
}

export type SdkChat = ReturnType<typeof useSdkChat>;
