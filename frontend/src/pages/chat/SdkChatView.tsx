// One SDK chat in the simple UI: a workstream whose Claude runs in the box's
// chat runner (agent/chat-runner.js). History comes from Claude's session
// file on the box (GET …/chat), live events from the status socket
// (chat/chatEvents.ts); both go through one reducer (chat/sdkChat.ts) into
// markdown bubbles, tool cards and one status line. While the chat comes up
// it narrates the box, the clone and Claude (chat/newChat.ts setupSteps), and
// a first message waits in the same storage-backed queue the pane chat uses
// (chat/useQueuedMessage.ts) until the runner can take it. The chat's state
// is useSdkChat's and its composer SdkComposer, shared with the file view.
import { HeadingStoreContext } from '../../chat/toolGroupHeadings';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Link } from 'react-router-dom';
import { Button } from '@launchpad-ui/components';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Dialog } from '../../components/Dialog';
import { announceChatsChanged, archiveBoxNotice, clearRunningBox, dismissRunningBoxNotice, dropLastActiveProject, parkedPowerError, runningBoxFromNotice, saveRunningBox, stillRunningWorkspaceHref } from '../../chat/archive';
import { LAST_ACTIVE_PROJECT_KEY, useProjects } from '../../contexts/ProjectContext';
import { chatsApi, heldImageUrl, instancesApi, visitsApi } from '../../services/api';
import { boxFeed } from '../../services/boxFeed';
import { REPLAY_BLOCK_CLASS } from '../../observability';
import { Markdown } from '../../chat/Markdown';
import { CodeFenceContext } from '../../chat/codeFence';
import { GenUiChatContext, GenUiItemContext, renderGenUiFence, type GenUiChat } from '../../chat/genui/SpecFence';
import { ActionBubble } from '../../chat/genui/ActionBubble';
import { parseActionMessage, sentSurfaces } from '../../chat/genui/action';
import { preLaunchTail } from '../../chat/newChat';
import { parsePane } from '../../chat/paneChat';
import { commandLine, formatCost, groupTurns, loadsEarlier, chatGroupKey, earlierStart, TRANSCRIPT_WINDOW, transcriptWindow, windowStart, windowStartAfterPage, type ChatGroup, type ChatItem, type ChatState, tasksLine } from '../../chat/sdkChat';
import { SetupSteps } from '../../chat/SetupSteps';
import { groupToolRuns } from '../../chat/toolRuns';
import { SkillCard, ToolCard, ToolRun } from './ToolCards';
import { ReplyMeta } from './ChatTimes';
import { ChatError, UnsentMessages } from './TranscriptNotices';
import { ReadOnlyTurnNotice } from './ReadOnlyTurnNotice';
import { chatHref, chatProvider, fullUiHref, repoSlug } from '../../chat/simpleChat';
import { desktopSessionHref, openDesktopLink } from '../../chat/desktopLinks';
import { useCapture } from '../../chat/useCapture';
import { useFollowBottom } from '../../chat/useFollowBottom';
import { useTranscriptFocus } from '../../chat/transcriptFocus';
import { MessageImages, MessageTextFiles } from '../../chat/ChatImages';
import { splitTextFiles } from '../../chat/chatTextFiles';
import type { Project } from '../../types';
import { FLAGS, useFlag } from '../../flags';
import { ChatHistoryButton, ChatMoreButton, SidePanelButton, useChatChrome } from './chatChrome';
import { useProvideScreenCommands } from '../../chat/screenCommands';
import { SessionHeader } from './SessionHeader';
import { BoxResizeLaunchPad } from './BoxResizeLaunchPad';
import { currentSizeLabel, offersResize, resizeBadge } from '../../utils/boxResize';
import { useResizeSizes } from '../../hooks/useBoxResize';
import { useReviewOf, useReviewsData } from './reviewsData';
import { renderReviewFence, ReviewCardContext, type ReviewCardSession } from './ReviewCard';
import { PostControl } from './PostReviewDialog';
import { FollowUpCard } from './FollowUpCard';
import { FollowUpStrip } from './FollowUpStrip';
import { REVIEW_FORMAT_MARK, TERMAG_NOTE } from '../../chat/reviewCard';
import { approvedSince, type PostedRound } from '../../chat/reviews';
import type { CodeFence } from '../../chat/codeFence';
import { SessionContextCard } from './SessionContextCard';
import type { MenuAction } from './ContextMenu';
import { AgentIcon } from './OpenItems';
import { workstreamLabel, workstreamTip } from '../../chat/explorerAgents';
import { ChatSpaceChip } from './SpaceSwatch';
import { ChatBoxTag } from './ChatBoxTag';
import { SdkComposer } from './SdkComposer';
import { SessionRepoPill } from './SessionRepoPill';
import { errorOf, useSdkChat } from './useSdkChat';
import { UserMessageText } from '../../chat/UserMessageText';
import { formatTokens } from '../../chat/contextUsage';
import { recentSubagents, subagentsOf, type SubagentView } from '../../chat/subagents';
import { subagentStore, useShownSubagent } from '../../chat/subagentStore';
import { AgentsCardSection, AgentsDrawer, SubagentsContext, type SubagentsUi } from './Subagents';
import { AsksCardSection, AsksContext, AsksDrawer } from './Asks';
import { useAsksUi } from '../../chat/useChatAsks';
import { askStore, askTabId, askThreadOf } from '../../chat/askStore';
import { askAgentName, recentAsks, type AskView } from '../../chat/asks';

let lastVisitedProjectId: string | null = null;

// Where an existing chat's transcript will be while its history loads: a few
// prompt and reply shapes in the transcript's own layout, so nothing moves
// when the real one arrives and nothing says the chat is being set up.
function TranscriptSkeleton() {
  return (
    <div className="chat-skeleton" aria-hidden="true">
      {[[62, 88, 74, 40], [48, 92, 66]].map((reply, i) => (
        <React.Fragment key={i}>
          <div className="sdk-user"><div className="chat-skeleton-bubble" /></div>
          <div className="chat-skeleton-reply">
            {reply.map((w, j) => <div key={j} className="chat-skeleton-line" style={{ width: `${w}%` }} />)}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

const NO_ASKS: ReadonlyMap<string, AskView> = new Map();

/** The chip a review session's first message shows for the card format it asks for (the text after the mark). */
function ReviewFormatChip({ text }: { text: string | null | undefined }) {
  if (!text?.includes(REVIEW_FORMAT_MARK)) return null;
  return <div className="rv-format-chip" title={text.split(REVIEW_FORMAT_MARK)[1]}>and the findings as a review card</div>;
}

export function ItemView({ item, onRetry, onResume, projectId, workstream }: { item: ChatItem; onRetry?: () => void; onResume?: () => void; projectId: string; workstream: string }) {
  // With subagents on, a background agent's end is its row's to say (Subagents.tsx).
  const agents = React.useContext(SubagentsContext);
  // A generative-UI answer (chat/genui/action.ts) reads as what was done, not as its payload.
  const action = React.useContext(GenUiChatContext) && item.kind === 'user' ? parseActionMessage(item.text) : null;
  switch (item.kind) {
    case 'user': {
      // termag's own note into a review session (Check the fixes) reads as an event, not as the user's words.
      if (item.text?.startsWith(TERMAG_NOTE)) return <div className="rv-event" role="note">{item.text.slice(TERMAG_NOTE.length).split(REVIEW_FORMAT_MARK)[0]}</div>;
      // Text files the message carries (chat/chatTextFiles.ts) show as chips, live and from the history alike.
      const { text, files, boxFiles } = splitTextFiles(item.text ?? '');
      return (
        <div className="sdk-user" data-pending={item.pending || undefined}>
          {item.images?.length || files.length || boxFiles ? <MessageImages images={item.images ?? []} files={files} boxFiles={boxFiles} projectId={projectId} workstream={workstream} /> : null}
          {action ? <ActionBubble payload={action} /> : text && <div className="sdk-user-bubble"><UserMessageText text={text.split(REVIEW_FORMAT_MARK)[0]} /></div>}
          <ReviewFormatChip text={text} />
          {item.pending && <div className="sdk-user-note">queued</div>}
        </div>
      );
    }
    case 'text':
      return (
        <div className="sdk-text" data-streaming={item.streaming || undefined}>
          <GenUiItemContext.Provider value={{ key: item.key, streaming: item.streaming }}>
            <Markdown text={item.text} streaming={item.streaming} />
          </GenUiItemContext.Provider>
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
    case 'readonly':
      return <ReadOnlyTurnNotice reason={item.reason} fix={item.fix} />;
    case 'command':
      return <div className="sdk-note" data-command={item.name}>{commandLine(item)}</div>;
    case 'divider': {
      // A clear, a compact, or a clear Resume took back; the newest clear offers Resume until the next message.
      const at = item.at ? new Date(item.at) : null;
      const when = at && !Number.isNaN(at.getTime()) ? at.toLocaleString() : null;
      const compacted = item.variant === 'compacted';
      const title = compacted
        ? `Compacted${item.preTokens != null ? ` from ${formatTokens(item.preTokens)} tokens` : ''}${when ? ` · ${when}` : ''}. Claude goes on from its summary of what is above.`
        : item.undone ? 'This clear was undone: the context above carried on.' : when ? `Cleared ${when}` : undefined;
      return (
        <div className="sdk-divider" data-variant={item.variant} data-undone={item.undone || undefined} title={title}>
          <span className="sdk-divider-label" role="separator" aria-label={compacted ? 'Context compacted' : item.undone ? 'Context cleared, then resumed' : 'Context cleared'}>
            {compacted ? 'Context compacted' : 'Context cleared'}
          </span>
          {item.undone && <span>· resumed</span>}
          {onResume && <button type="button" className="btn-tiny" onClick={onResume}>Resume previous context</button>}
        </div>
      );
    }
    case 'tasks': {
      const ended = agents ? item.ended.filter(t => !t.agent) : item.ended;
      if (!ended.length) return null;
      const line = tasksLine(ended === item.ended ? item : { ...item, ended });
      return <div className="sdk-note sdk-tasks" data-warn={line.warn || undefined} title={line.text}><span aria-hidden="true">{line.mark} </span>{line.text}</div>;
    }
  }
}

/**
 * One prompt, or one reply with its tool runs and cost line. Memoized: when
 * scrolling up brings in earlier groups, or a turn streams into the last
 * one, the groups already drawn are not drawn again (a long chat's markdown
 * and tool cards made each load stall the page for a frame or more).
 * `onRetry` goes to the reply's last item; only the last group gets one.
 */
const TranscriptGroup = React.memo(function TranscriptGroup({ group: g, projectId, workstream, cost, onRetry, onResume, open = false, asks = false }: {
  group: ChatGroup; projectId: string; workstream: string; cost: ChatState['costs'][string] | undefined; onRetry?: () => void; onResume?: () => void;
  /** The last group while a turn runs: its last tool run can still grow, so it isn't settled. */
  open?: boolean;
  /** The running turn's box asks Haiku for its tool-group headings (its turn-start's `headings`), so its runs may wait for one. */
  asks?: boolean;
}) {
  if (g.kind === 'user') return <ItemView item={g.item} projectId={projectId} workstream={workstream} />;
  if (g.kind === 'divider') return <ItemView item={g.item} projectId={projectId} workstream={workstream} onResume={onResume} />;
  const grouped = groupToolRuns(g.items);
  return (
    <div className="sdk-reply">
      {grouped.map((e, i) => (e.kind === 'tools'
        ? <ToolRun key={e.key} runKey={e.key} tools={e.tools} leadIn={e.leadIn}
            settled={i < grouped.length - 1 || !open} live={open} asks={asks} />
        : <ItemView key={e.item.key} item={e.item} projectId={projectId} workstream={workstream}
            onRetry={i === grouped.length - 1 ? onRetry : undefined} />))}
      <ReplyMeta cost={cost} />
    </div>
  );
});

export function SdkChatView({ project, workstream }: { project: Project; workstream: string }) {
  // The chat's own space (chat/chatSpaces.ts chatHomeSpace) is the header chip's, and the server loads its memory.
  const wsRow = project.workstreams.find(w => w.name === workstream);
  const { settleProjectClone, reloadProjects } = useProjects();
  const chatId = `${project.id}|${workstream}`;
  const repo = repoSlug(project.repoUrl);
  const follow = useRef<() => void>(() => {});
  const s = useSdkChat(project, workstream, follow);
  const {
    contextBusy,
    onResumeCleared,
    resumeKey,
    claudeWorking,
    navigate,
    setup,
    held,
    box,
    recovery,
    restart,
    chat,
    headingStore,
    history,
    trust,
    trustNoun,
    opening,
    queued,
    echo,
    queueError,
    retryQueued,
    runnerReady,
    showSteps,
    loading,
    steps,
    composer,
    setSendError,
    retrying,
    setRetrying,
    unsent,
    setUnsent,
    dragging,
    sendUnsent,
    openFull,
    canSend,
    total,
    replies,
    echoShown,
    retry,
    onRetryLast,
    dropHandlers,
    deliver,
  } = s;
  // The echo's and the queued message's text files show as chips, as a sent one's do (chat/chatTextFiles.ts).
  const echoed = splitTextFiles(echo ?? '');
  const queuedParts = splitTextFiles(s.queuedText ?? '');

  useEffect(() => {
    visitsApi.record({ projectId: project.id, previousProjectId: lastVisitedProjectId, workstream });
    lastVisitedProjectId = project.id;
  }, [project.id, workstream]);

  const { mode: chromeMode, sidePanel, refresh } = useChatChrome();
  // A reply's ```spec fence drawn as UI; off, it is a code block.
  const generativeUi = useFlag(FLAGS.chatGenerativeUi, false);
  const generativeUiOn = generativeUi;
  // A review session: its PR is the one under review, in the panel.
  const review = useReviewOf(project.id, workstream);
  const reviews = useReviewsData();
  // Its reviewer answers with a ```review fence, drawn as the review card.
  const drawFence = useMemo(() => {
    if (!reviews.on) return generativeUiOn ? renderGenUiFence : null;
    return (block: CodeFence) => renderReviewFence(block) ?? (generativeUiOn ? renderGenUiFence(block) : null);
  }, [reviews.on, generativeUiOn]);
  const reviewSession = useMemo<ReviewCardSession | null>(() => (review ? {
    projectId: project.id, workstream, repo: review.repo, number: review.number, viewer: reviews.queue.viewer,
    showLine: () => sidePanel?.show?.('pr'),
    posted: (reviews.prs && reviews.prs.connected ? (reviews.prs as { reviewRounds?: PostedRound[] }).reviewRounds ?? [] : [])
      .find(r => r.repo.toLowerCase() === review.repo.toLowerCase() && r.number === review.number) ?? null,
    postSlot: (findings, cardId) => <PostControl review={findings} cardId={cardId} repo={review.repo} number={review.number} viewer={reviews.queue.viewer} author={review.author} />,
    followUp: fence => <FollowUpCard fence={fence} projectId={project.id} workstream={workstream} repo={review.repo} number={review.number} viewer={reviews.queue.viewer}
      approvedOnServer={approvedSince((reviews.prs && reviews.prs.connected ? (reviews.prs as { reviewRounds?: PostedRound[] }).reviewRounds ?? [] : []), review.repo, review.number, fence.head)} />,
  } : null), [review, project.id, workstream, reviews.queue.viewer, reviews.prs, sidePanel]);
  const phone = chromeMode === 'drawer';
  // Subagents: an Agent call is a row that opens its transcript in the
  // panel's agent tab, which reads them from here (chat/subagentStore.ts). Only with the panel's tabs.
  const subagentsOn = useFlag(FLAGS.chatSubagents, false);
  const showAgent = refresh && !phone ? sidePanel?.showAgent : undefined;
  const subagentList = useMemo<readonly SubagentView[]>(
    () => (subagentsOn ? subagentsOf(chat) : []),
    [subagentsOn, chat.items, chat.subagents, chat.running],
  );
  useEffect(() => {
    if (!subagentsOn) return undefined;
    // None until the history is in: the agent tab says it is loading, not that its subagent is gone.
    subagentStore.publish(chatId, loading ? null : subagentList);
    return undefined;
  }, [subagentsOn, chatId, subagentList, loading]);
  useEffect(() => () => subagentStore.publish(chatId, null), [chatId]);
  const shownAgent = useShownSubagent(chatId);
  const agentsUi = useMemo<SubagentsUi | null>(() => (subagentsOn && showAgent ? {
    byId: new Map(subagentList.map(v => [v.id, v])),
    open: (v: SubagentView) => showAgent({ chat: chatId, id: v.id, title: v.description }),
    shownId: sidePanel?.open ? shownAgent : null,
  } : null), [subagentsOn, showAgent, subagentList, chatId, shownAgent, sidePanel?.open]);
  // Asks: a `termag ask` call is the row of the ask it sent, where
  // subagents have theirs, read from GET …/chat/asks. A row opens its tab, an agent tab whose id names its
  // thread, which reads the views from here (chat/askStore.ts).
  const openAsk = useCallback((v: AskView) => {
    if (showAgent) showAgent({ chat: chatId, id: askTabId(v.thread), title: v.title });
    else if (v.chat) navigate(chatHref(v.chat.projectId, v.chat.workstream));
  }, [showAgent, chatId, navigate]);
  const asksUi = useAsksUi({
    on: agentsUi != null, owner: project.role !== 'collaborator', projectId: project.id, workstream, items: chat.items, open: openAsk,
    shownThread: sidePanel?.open ? askThreadOf(shownAgent) : null,
    agent: askAgentName(chatProvider(project, workstream)),
  });
  // None while the history loads (the tab says it is loading); once it is in, the chat's asks, none at all
  // included, so a tab whose ask is gone says so rather than waiting.
  useEffect(() => { askStore.publish(chatId, loading ? null : asksUi?.views ?? NO_ASKS); }, [chatId, asksUi, loading]);
  useEffect(() => () => askStore.publish(chatId, null), [chatId]);
  // Kept in view beside the subagents: any still going, and those its calls named since the last message.
  const keptAsks = useMemo(() => (asksUi ? recentAsks(chat.items, asksUi.byCall, asksUi.views) : []), [asksUi, chat.items]);
  // Those Claude started since the last message, and any still running: in the context card while it
  // shows, else in the drawer on the composer (chrome.css hides the drawer while the card shows).
  const keptAgents = useMemo(() => (agentsUi ? recentSubagents(chat.items, subagentList) : []), [agentsUi, chat.items, subagentList]);

  // A checkout still running in the pane (a box that clones there) may stop
  // on a credential prompt: its last lines show under the steps.
  const paneClone = !held && !restart && !runnerReady && project.setupStatus === 'none' && Boolean(repo);
  const capture = useCapture({ projectId: project.id, role: 'agent', workstream, status: 'working', statusUpdatedAt: undefined, enabled: paneClone });
  const boxSays = useMemo(() => (paneClone && capture.content != null
    ? preLaunchTail(parsePane(capture.content, { provider: 'claude', role: 'agent' }).blocks)
    : []), [paneClone, capture.content]);

  const { scroller, onScroll, unseen, jumpToBottom } = useFollowBottom(chat.items, chatId);
  follow.current = jumpToBottom;

  // Only the newest groups are drawn at first (chat/sdkChat.ts windowStart);
  // scrolling up to the top brings in the next earlier ones (loadsEarlier),
  // anchored so what is on screen stays where it was. The window's start is
  // fixed to a group, so a new prompt or reply appends and never pushes the
  // oldest drawn one out. The button above them is the fallback: for the
  // keyboard, and for a transcript too short to scroll.
  const groups = useMemo(() => groupTurns(chat.items), [chat.items]);
  const groupKeys = useMemo(() => groups.map(chatGroupKey), [groups]);
  const [windowFrom, setWindowFrom] = useState<string | null>(null);
  useEffect(() => { setWindowFrom(null); }, [chatId]);
  // A page of older history the box was asked for (useSdkChat loadEarlier):
  // how many groups were from the window's start on, and the distance from
  // the bottom to keep. Once it lands, the window takes in the groups it brought;
  // an ask that ends without a page (`settled`) lets it go. Neither is a history
  // load: one that runs while the page is on its way leaves it waiting.
  const fetching = useRef<{ tail: number; loaded: number; settled: number; fromBottom: number | null } | null>(null);
  const landed = fetching.current != null && s.earlier.loaded !== fetching.current.loaded ? fetching.current : null;
  const start = landed ? earlierStart(windowStartAfterPage(groupKeys, windowFrom, landed.tail)) : windowStart(groupKeys, windowFrom);
  const windowed = transcriptWindow(groups, start);
  // Fix the start once there are groups, and again if its group went away.
  useEffect(() => {
    if (groupKeys.length && groupKeys[start] !== windowFrom) setWindowFrom(groupKeys[start]);
  }, [groupKeys, start, windowFrom]);
  // Distance from the bottom while earlier groups are on their way; null otherwise.
  const fromBottom = useRef<number | null>(null);
  // The first group drawn before the load and its offset: the fraction of a
  // pixel the whole-pixel scrollHeight leaves out is corrected from it.
  const anchor = useRef<{ el: Element; top: number } | null>(null);
  const lastScrollTop = useRef<number | null>(null);
  const showEarlier = () => {
    const el = scroller.current;
    if (fromBottom.current != null) return;
    fromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
    const first = el?.querySelector('.sdk-transcript > .sdk-user, .sdk-transcript > .sdk-reply');
    anchor.current = first ? { el: first, top: first.getBoundingClientRect().top } : null;
    // Drawn and anchored now, inside the scroll event: left to React's own
    // schedule, the next frame's scroll would land between the measure above
    // and the correction, which then took that step back (one frame stood still).
    flushSync(() => setWindowFrom(groupKeys[earlierStart(start)] ?? null));
  };
  const fetchEarlier = () => {
    if (fetching.current || s.earlier.loading || !s.earlier.more) return;
    const el = scroller.current;
    fetching.current = { tail: groups.length - start, loaded: s.earlier.loaded, settled: s.earlier.settled, fromBottom: el ? el.scrollHeight - el.scrollTop : null };
    if (!s.loadEarlier()) fetching.current = null;
  };
  const onTranscriptScroll = () => {
    onScroll();
    const el = scroller.current;
    if (!el) return;
    const prev = lastScrollTop.current;
    lastScrollTop.current = el.scrollTop;
    if (fetching.current) fetching.current.fromBottom = el.scrollHeight - el.scrollTop;
    if (loadsEarlier({ scrollTop: el.scrollTop, prevScrollTop: prev, hidden: windowed.hidden, pending: fromBottom.current != null })) showEarlier();
    else if (windowed.hidden === 0 && loadsEarlier({ scrollTop: el.scrollTop, prevScrollTop: prev, hidden: s.earlier.more ? 1 : 0, pending: fetching.current != null })) fetchEarlier();
  };
  const [canScroll, setCanScroll] = useState(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const f = fetching.current;
    if (f && (s.earlier.loaded !== f.loaded || s.earlier.settled !== f.settled)) {
      fetching.current = null;
      if (s.earlier.loaded !== f.loaded) {
        if (f.fromBottom != null) el.scrollTop = el.scrollHeight - f.fromBottom;
        setWindowFrom(groupKeys[start] ?? null);
      }
    } else if (f) {
      f.fromBottom = el.scrollHeight - el.scrollTop;
    }
    if (fromBottom.current != null) {
      el.scrollTop = el.scrollHeight - fromBottom.current;
      fromBottom.current = null;
      const a = anchor.current;
      anchor.current = null;
      if (a?.el.isConnected) {
        const off = a.el.getBoundingClientRect().top - a.top;
        if (off !== 0 && Math.abs(off) < 2) el.scrollTop += off;
      }
    }
    // The anchoring jump is not the reader scrolling: judge the next event from here.
    lastScrollTop.current = el.scrollTop;
    setCanScroll(el.scrollHeight > el.clientHeight + 1);
  }, [start, groups, groupKeys, scroller, s.earlier]);

  // Generative UI's answers go as messages (chat/genui/action.ts); a surface is sent once its message is in the transcript.
  // Never into the pre-ready queue: it is this browser's only, and the surface locks from the transcript.
  const genUiSend = useCallback((message: string) => (runnerReady ? deliver(message, 'retry') : Promise.resolve(false)), [deliver, runnerReady]);
  const genUiSent = useMemo(() => (generativeUi ? sentSurfaces(chat.items) : null), [generativeUi, chat.items]);
  const genUiChat = useMemo<GenUiChat | null>(
    () => (genUiSent ? { send: genUiSend, sent: genUiSent, ready: runnerReady } : null),
    [genUiSend, genUiSent, runnerReady],
  );

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

  // And so does a click in the transcript (chat/transcriptFocus.ts).
  const transcriptFocus = useTranscriptFocus(composer, canSend);

  const canArchive = project.role !== 'collaborator' && workstream === 'main';
  // boxFeed lists only the person's own boxes, so a box here is theirs to resize.
  const [resizing, setResizing] = useState(false);
  const resizeSizes = useResizeSizes(box && project.role !== 'collaborator' ? box.id : null);
  const resizeMenu = box && project.role !== 'collaborator' && offersResize(box) ? {
    hint: resizeBadge(box) ?? currentSizeLabel(box, resizeSizes),
    onOpen: () => setResizing(true),
  } : null;
  // An ask thread's chat is called by the thread's title; its id stays in the tooltip.
  const askThread = project.workstreams?.find(w => w.name === workstream)?.askThread;
  const askNamed = { workstream, askTitle: askThread?.title, askThreadId: askThread?.id };
  const archiveLabel = archiving ? 'Archiving…' : archiveNotice ? 'Archived' : 'Archive';
  const desktopHref = desktopSessionHref({ projectId: project.id, workstream, shared: project.role === 'collaborator' });
  const phoneActions: MenuAction[] = [
    ...(total != null ? [{ label: `${formatCost(total)} so far`, disabled: true, onSelect: () => {} }] : []),
    ...(canArchive ? [{ label: archiveLabel, disabled: archiving || chat.running || archiveNotice != null, onSelect: () => setConfirmArchive(true) }] : []),
    archiveNotice
      ? { label: 'Open in Lab', onSelect: () => { void openRunningBox(); } }
      : { label: opening ? 'Opening…' : 'Open in Lab', disabled: opening, onSelect: () => { void openFull(); } },
    ...(desktopHref ? [{ label: 'Open in termag desktop', onSelect: () => openDesktopLink(desktopHref) }] : []),
    ...(sidePanel ? [{ label: sidePanel.open ? 'Hide tools' : 'Show tools', onSelect: sidePanel.toggle }] : []),
  ];
  // This chat's ⌘K commands under the refresh, beside the sidebar's (chat/screenCommands.ts, chatCommands.ts).
  useProvideScreenCommands(refresh ? [
    {
      id: 'open-in-lab', label: !archiveNotice && opening ? 'Opening…' : 'Open in Lab', icon: 'arrow-up-right', keywords: ['full ui', 'workspace'],
      disabled: !archiveNotice && opening, suggested: true, run: () => { void (archiveNotice ? openRunningBox() : openFull()); },
    },
    ...(desktopHref ? [{
      id: 'open-in-desktop', label: 'Open in termag desktop', icon: 'device-desktop', keywords: ['desktop', 't3'],
      detail: 'A new thread in this project there, with its chats to import', run: () => openDesktopLink(desktopHref),
    }] : []),
    ...(canArchive ? [{
      id: 'archive', label: archiving ? 'Archiving…' : 'Archive session', icon: 'archive-outline', keywords: ['close'],
      detail: chat.running ? 'Wait for the turn to end' : archiveNotice ? 'Archived; its box is still running' : undefined,
      disabled: archiving || chat.running || archiveNotice != null, run: () => setConfirmArchive(true),
    }] : []),
  ] : null);

  return (
    <div className="chat-view">
      <section className="chat-conv" {...dropHandlers}>
        {dragging && <div className="chat-drop-overlay" aria-hidden="true">Drop images to attach</div>}
        <header className={phone ? 'chat-header chat-header-agent' : 'chat-header'}>
          <ChatHistoryButton />
          {/* The chrome refresh's header on a desktop width (SessionHeader.tsx); the phone keeps its one row. */}
          {refresh && !phone && (
            <SessionHeader project={project} workstream={workstream} repo={repo} box={box} working={claudeWorking}
              opening={opening} onOpenFull={() => { void (archiveNotice ? openRunningBox() : openFull()); }}
              archive={canArchive ? {
                label: archiveLabel,
                disabled: archiving || chat.running || archiveNotice != null,
                hint: chat.running ? 'Wait for the turn to end' : archiveNotice ? 'Its box is still running' : 'The box stops when this is its only session',
                onArchive: () => setConfirmArchive(true),
              } : null}
              resize={resizeMenu} />
          )}
          {resizing && box && <BoxResizeLaunchPad box={box} onClose={() => setResizing(false)} onChanged={() => { void boxFeed.reload(); }} />}
          {!(refresh && !phone) && <div className="chat-title">
            {phone
              ? <AgentIcon status={claudeWorking ? 'working' : 'idle'} />
              : <span className="chat-glyph" data-status={claudeWorking ? 'working' : 'idle'} aria-hidden="true">{claudeWorking ? '●' : '○'}</span>}
            <span className="chat-title-name">{project.name}</span>
            {workstream !== 'main' && <span className="chat-title-ws" title={workstreamTip(askNamed) ?? undefined}>· {workstreamLabel(askNamed)}</span>}
            <ChatSpaceChip place={{ instanceId: project.instanceId ?? null, spaceId: wsRow?.spaceId, spaceFixed: wsRow?.spaceFixedAt != null }} />
            {repo && <span className="chat-title-repo" title={project.repoUrl ?? undefined}>{repo}</span>}
            <ChatBoxTag project={project} box={box} />
          </div>}
          {!(refresh && !phone) && <div className="chat-header-actions">
            {phone ? <ChatMoreButton label={`${project.name}: actions`} actions={phoneActions} /> : <>
            {total != null && (
              <span className="sdk-cost-total" title={`What this chat has cost so far, across context clears, over ${replies} ${replies === 1 ? 'reply' : 'replies'}. Hover a reply for its own.`}>
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
                  <span className="chat-full-ui-long">Open in Lab</span>
                  <span className="chat-full-ui-short">Lab</span>
                </button>
              )
              : (
                <button type="button" className="btn-ghost chat-full-ui" onClick={() => { void openFull(); }} disabled={opening}
                  title={chat.sessionId ? `Continues this session in the terminal (claude --resume ${chat.sessionId})` : 'Opens this session in Lab'}>
                  {opening ? 'Opening…' : (
                    <>
                      <span className="chat-full-ui-long">Open in Lab</span>
                      <span className="chat-full-ui-short">Lab</span>
                    </>
                  )}
                </button>
              )}
            {desktopHref && (
              <a className="btn-ghost" href={desktopHref} title="A new thread in this project in termag desktop, with its chats to import">Desktop</a>
            )}
            <SidePanelButton />
            </>}
          </div>}
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
                  : <button type="button" className="confirm-btn confirm-btn-primary" onClick={() => { void openRunningBox(); }}>Open in Lab</button>}
              </div>
            </Dialog>,
            document.body,
          )}
        </header>

        {/* The chrome refresh's context card, in the gutter while the panel is shut (chrome.css hides it when narrow). */}
        {refresh && !phone && sidePanel && !sidePanel.open && !review && (
          <SessionContextCard project={project} workstream={workstream} onOpenPr={sidePanel.show ? () => sidePanel.show!('pr') : undefined}
            agents={(agentsUi && keptAgents.length) || (asksUi && keptAsks.length) ? (
              <>
                {agentsUi && keptAgents.length > 0 && <AgentsCardSection list={keptAgents} ui={agentsUi} />}
                {asksUi && keptAsks.length > 0 && <AsksCardSection list={keptAsks} ui={asksUi} />}
              </>
            ) : null} />
        )}
        <div className="chat-transcript" ref={scroller} onScroll={onTranscriptScroll} {...transcriptFocus}>
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
                  <button type="button" className="btn-tiny" disabled={stoppingBox} onClick={() => { void openRunningBox(); }}>Open in Lab</button>
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
                    <div className="chat-box-says-hint">Stuck on a question? <Link to={fullUiHref(project.id, workstream)}>Answer it in Lab</Link>.</div>
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
            {loading && !recovery && <TranscriptSkeleton />}
            {runnerReady && chat.items.length === 0 && !queued && !echo && (
              <div className="chat-empty">
                Ask Claude anything about {repo ?? project.name}.{' '}
                {trust?.trusted
                  ? 'It works in its own box and can run commands and edit files there.'
                  : `It can read the code and answer, but can't run commands or edit files until the ${trustNoun} is trusted.`}
              </div>
            )}
            {windowed.hidden > 0 && (
              <Button variant="minimal" size="small" className="chat-earlier" onPress={showEarlier} data-fallback={canScroll || undefined}>
                Show {Math.min(windowed.hidden, TRANSCRIPT_WINDOW)} earlier {Math.min(windowed.hidden, TRANSCRIPT_WINDOW) === 1 ? 'message' : 'messages'}
              </Button>
            )}
            {windowed.hidden === 0 && s.earlier.error && <p className="chat-earlier-error" role="status">{s.earlier.error}</p>}
            {windowed.hidden === 0 && s.earlier.more && (
              <Button variant="minimal" size="small" className="chat-earlier" onPress={fetchEarlier} isDisabled={s.earlier.loading}
                data-fallback={(canScroll && !s.earlier.error) || undefined}>
                {s.earlier.loading ? 'Loading earlier messages…' : s.earlier.error ? 'Try again' : 'Show earlier messages'}
              </Button>
            )}
            <SubagentsContext.Provider value={agentsUi}>
            <AsksContext.Provider value={asksUi}>
            {/* Haiku's headings for runs of tool calls, pushed by the box and kept in its history (chat/toolGroupHeadings.ts). */}
            <HeadingStoreContext.Provider value={headingStore}>
            <GenUiChatContext.Provider value={genUiChat}>
            <ReviewCardContext.Provider value={reviewSession}>
            <CodeFenceContext.Provider value={drawFence}>
            {windowed.groups.map((g, gi, groups) => (
              <TranscriptGroup key={chatGroupKey(g)} group={g} projectId={project.id} workstream={workstream}
                onResume={g.kind === 'divider' && g.item.key === resumeKey && contextBusy == null ? onResumeCleared : undefined}
                cost={g.kind === 'reply' && g.userKey ? chat.costs[g.userKey] : undefined}
                open={gi === groups.length - 1 && chat.running} asks={chat.turnHeadings === true}
                onRetry={retry != null && canSend && gi === groups.length - 1 ? onRetryLast : undefined} />
            ))}
            </CodeFenceContext.Provider>
            </ReviewCardContext.Provider>
            </GenUiChatContext.Provider>
            </HeadingStoreContext.Provider>
            </AsksContext.Provider>
            </SubagentsContext.Provider>
            {echoShown && (
              <div className="sdk-user">
                <MessageTextFiles files={echoed.files} boxFiles={echoed.boxFiles} />
                {echoed.text && <div className="sdk-user-bubble"><UserMessageText text={echoed.text.split(REVIEW_FORMAT_MARK)[0]} /></div>}
                <ReviewFormatChip text={echoed.text} />
              </div>
            )}
            {queued && (
              <div className="sdk-user" data-pending="">
                {(s.queuedImages.length > 0 || queuedParts.files.length > 0 || queuedParts.boxFiles) && <MessageImages images={s.queuedImages} files={queuedParts.files} boxFiles={queuedParts.boxFiles} projectId={project.id} workstream={workstream} />}
                {queuedParts.text && <div className="sdk-user-bubble"><UserMessageText text={queuedParts.text.split(REVIEW_FORMAT_MARK)[0]} /></div>}
                <ReviewFormatChip text={splitTextFiles(queued).text} />
                <div className="sdk-user-note">{queueError ? `not sent: ${queueError}` : 'sent as soon as Claude is ready'}</div>
                {queueError && <button type="button" className="btn-tiny chat-queued-retry" onClick={retryQueued}>Retry</button>}
              </div>
            )}
            {/* Held on the orchestrator (chat/continuation.ts): shown in every tab, with its images, until it goes in. */}
            {s.heldShown.map(m => {
              const held = splitTextFiles(m.text ?? '');
              return (
              <div key={m.id} className="sdk-user" data-pending="" data-held-id={m.id}>
                {m.images?.length || held.files.length || held.boxFiles ? <MessageImages images={(m.images ?? []).map((i, n) => ({ mediaType: i.mediaType, src: heldImageUrl(project.id, workstream, m.id, n) }))} files={held.files} boxFiles={held.boxFiles} projectId={project.id} workstream={workstream} /> : null}
                {held.text && <div className="sdk-user-bubble">{held.text}</div>}
                <div className="sdk-user-note">{m.error ? `not sent: ${m.error}` : 'sent once the chat is back'}</div>
              </div>
              );
            })}
            <UnsentMessages texts={unsent} disabled={!canSend} onSend={sendUnsent}
              onDiscard={i => setUnsent(u => u.filter((_, j) => j !== i))} />
          </div>
        </div>
        <SdkComposer s={s} project={project} workstream={workstream} unseen={unseen} onJump={jumpToBottom}
          drawer={agentsUi && keptAgents.length && asksUi && keptAsks.length ? (
            // Both: one frame on the composer holding the two, a line between them (chrome.css).
            <div className="agent-drawer-stack">
              <AgentsDrawer list={keptAgents} ui={agentsUi} />
              <AsksDrawer list={keptAsks} ui={asksUi} />
            </div>
          ) : agentsUi && keptAgents.length ? <AgentsDrawer list={keptAgents} ui={agentsUi} />
            : asksUi && keptAsks.length ? <AsksDrawer list={keptAsks} ui={asksUi} /> : null}
          placeholder={review ? 'Ask about this PR, or tell Claude what to change in the review…' : undefined}
          above={<>
            <SessionRepoPill project={project} />
            {review?.section === 'pushed' && <FollowUpStrip item={review} />}
          </>} />
      </section>
    </div>
  );
}
