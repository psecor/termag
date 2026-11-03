/**
 * The simple UI's chat on a chat-runner project (services/chatRunner.ts):
 *
 *   GET  /api/projects/:id/chat?workstream=      session id, running, history; from the
 *        stored transcript (`stored: true`) when the box is offline
 *       
 *   POST /api/projects/:id/chat/messages         { workstream, text, images?, model?, backend?, effort? }  (images: services/chatImages.ts)
 *        model: opus|sonnet|haiku, or with backend fireworks one of the
 *        sender's Fireworks models; this turn on (services/claudeChatModel.ts
 *        chatTurnChoice), kept on the workstream's agent row. effort: this
 *        turn's --effort, not kept (services/chatEffort.ts)
 *   POST /api/projects/:id/chat/interrupt        { workstream, scope?: 'turn' | 'all' }
 *   POST /api/projects/:id/chat/terminal         { workstream }  Open in full UI:
 *        resume the session in the agent pane, same-origin JSON only, with
 *        the permission surface the chat's turns use
 *   POST /api/projects/:id/chat/reclaim          { workstream, text?, images?, model?, backend?, effort? }
 *        simple UI: the pane's Claude has the session. Exit it when it is
 *        really there, or clear a stale hold, then send. Same-origin JSON.
 *   POST /api/projects/:id/chat/trust            the owner trusts the repository
 *                                                (same-origin JSON { trust: true } only)
 *   A message to a chat whose box was terminated continues it on a new box,
 *   and one to a chat whose box is stopped starts it; the message is held
 *   until the chat can take it (services/chatNewBox.ts, chatHeld.ts).
 *   The history says where that stands (`continuation`).
 *   POST /api/projects/:id/chat/context          { workstream, action: clear|compact|resume }
 *        The context popover. clear: the next
 *        turn starts a new Claude session, the old one stays in the history
 *        above a divider. resume: undo the last clear until a turn has started
 *        a new session. compact: a /compact turn on the session. Same-origin
 *        JSON, on a runner with chat-context-v1; refused while a turn runs or messages wait
 *
 * While a Claude holds the session in the agent pane, the chat refuses new
 * messages (409 terminal-holds): two processes on one session would fork it.
 *
 * Every turn runs in the permission mode this module decides from the
 * project's trust (services/chatTrust.ts): bypassPermissions when trusted,
 * dontAsk otherwise. bypassPermissions is sent only to an agent that
 * advertises chat-trust-v1; a chat-runner-v1 box still gets dontAsk, so
 * its send is accepted. The browser has no say in it.
 *
 * Owner-or-share, like capture and send-keys. Live events arrive on the
 * status WebSocket as `{type: 'chat'}`.
 */
import { Router, type Request } from 'express';
import { prisma } from '../db';
import { anyClaimUpdateRunning, claimUpdateSettled } from '../services/claimUpdateGate';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { chatEngineOf, isChatRunnerProvider } from '../providers/registry';
import { instanceAgentTransport, isProjectAgentConnected, sendForProject } from '../services/agentRegistry';
import { chatTurnChoice, resolvedChatTier, storedChatChoice, type ChatChoice } from '../services/claudeChatModel';
import { chatLaunchFor, type ChatLaunchResult } from '../services/chatLaunch';
import { fireworksOfferedTo } from '../services/fireworksFlag';
import { paneLockKey, withPaneLock } from '../services/agentRuntime';
import { isChatSessionId, isT3ThreadId, saveChatHolder, saveChatSession } from '../services/chatHolder';
import { CLAUDE_EXIT_KEYS, interruptAnswer, reclaimAnswer, reclaimChatFromPane, resumeChatInPane, sendUnlessTerminalHolds, TERMINAL_HOLDS_ANSWER, terminalAnswer } from '../services/chatResume';
import { CHAT_AUTO_CAPABILITY, CHAT_SUBAGENTS_CAPABILITY, CHAT_SUBAGENTS_FLAG, subagentIdOf, chatContextAction, chatContextActions, chatContextRefusals, chatInterruptRpcPayload, chatKeyFor, chatRequireCheckout, chatResumeClaimPayload, chatRpcFailure, chatSendRpcPayload, chatSendsLive, chatStopScope, chatStopsTurn, chatTargetError, chatTextError, historyTerminalHolds, probeFromForeground, reconcileChatStatus, CHAT_LIVE_INPUT_FLAG, SESSION_TITLES_FLAG, type PaneForeground, type PaneProbe, chatHistoryFromStore, CHAT_PLAN_SPEND_FLAG, CHAT_T3_HOLD_CAPABILITY } from '../services/chatRunner';
import { turnMemorySpace } from '../services/chatSpace';
import { chatTrust, followUpMode, TRUSTED_MODE, type ChatTrust } from '../services/chatTrust';
import { ASK_PUSH_CAPABILITY, askBranch, askChatSendRefusal, askCwd } from '../services/agentMessages';
import { chatContextPostRefusal, chatReclaimPostRefusal, chatTerminalPostRefusal, chatTrustPostRefusal, runAfterPostRefusal } from '../services/chatTrustPost';
import { CHAT_IMAGE_INPUT_FLAG, CHAT_IMAGE_SEND_TIMEOUT_MS, chatImageInput, chatImagesRefusal, chatPdfInput, checkChatImages, pdfCount } from '../services/chatImages';
import { CHAT_EFFORT_FLAG, chatEffortForSend, chatEffortInput, type ChatEffortContext } from '../services/chatEffort';
import { CHAT_GENUI_FLAG, CHAT_GENUI_HINT_FLAG, chatGenUiForSend } from '../services/chatGenUi';
import { boolVariation } from '../services/featureFlags';
import type { FlagUser } from '../services/featureFlags';
import { projectSessionAccess, SessionAccessError } from '../services/sessionAccess';
import * as tmux from '../services/tmux';
import { RUN_CHAT_REFUSAL_TEXT, runChatRefusalFor } from '../services/automations/chatGate';
import { getTranscriptStoreConfig, readStoredView } from '../services/chatTranscriptStore';
import { CREDENTIALS_STALE_MS, continuationFacts, continuationPhase, continuationRefusal, continueOnNewBoxFor, ensureRestored, newBoxNotice, pendingResumeFor, resumeFlagOnForOwner, sendPlanFor, type ContinuationFacts } from '../services/chatNewBox';
import { hasHeld, heldFor, holdMessage, kickHeldDelivery, type DeliverOutcome, type HeldMessage } from '../services/chatHeld';
import type { ChatNoticeSender } from '../services/askNoticeSweep';
import { CHAT_TRANSCRIPTS_FLAG } from '../services/chatTranscriptSync';
import { askTelemetryFor, type AskTelemetryThread } from '../services/askTelemetry';

type Result = { status: number; body: unknown };

interface ChatTarget {
  host: { userId: string; instanceId: string | null };
  projectId: string;
  /** The project's name: termag.project on the box's telemetry for the chat (services/chatRunner.ts telemetryNames). */
  project: string;
  workstream: string;
  workstreamId: string;
  chatKey: string;
  cwd: string;
  /** The agent session the chat's status rides on (services/chatRunner.ts). */
  sessionName: string;
  instanceId: string | null;
  /** A repo chat: its first turn waits for the checkout (agent/chat-runner.js checkoutReady). */
  requireCheckout: boolean;
  /** The agent pane's tmux session. */
  paneSession: string;
  trust: ChatTrust;
  permissionMode: string;
  /** What the connected agent advertised. Empty when there is no box. */
  agentCapabilities: readonly string[];
  isOwner: boolean;
  /** An ask thread's chat (services/askChat.ts): its turns run in the thread's clone on the box. */
  ask: { threadId: string; baseSha: string | null; gitName: string; gitEmail: string; pushBranch?: string; sendRefusal: Result | null; thread: AskTelemetryThread } | null;
  /** The workstream's agent row, which holds what the chat runs on. */
  workflowId: string;
  /** What the chat runs on: the row's backend and model. */
  choice: ChatChoice;
  /** The owner, whose flags and box a Fireworks turn runs under. */
  ownerId: string;
  /** Started with "Act as an orchestrator" (never an ask's chat). */
  orchestrator: boolean;
  /** The headless agent the runner drives for this chat (registry chatEngine). */
  engine: 'claude' | 'pi' | null;
}

async function chatTarget(userId: string, projectId: string, workstreamRaw: unknown): Promise<ChatTarget | Result> {
  const workstream = typeof workstreamRaw === 'string' && workstreamRaw ? workstreamRaw : 'main';
  let access;
  try {
    access = (await projectSessionAccess(userId, projectId))('agent', workstream);
  } catch (err) {
    if (err instanceof SessionAccessError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      name: true, userId: true, setupStatus: true, repoUrl: true, chatTrustedAt: true, chatOrchestrator: true,
      instance: { select: { hostHome: true, userId: true } },
      workflows: {
        where: { type: 'agent' },
        select: {
          id: true, provider: true, backend: true, model: true,
          workstream: {
            select: {
              id: true, name: true,
              askThread: {
                select: {
                  id: true, workstream: true, repoName: true, baseSha: true, targetPr: true, targetBranch: true, originUser: { select: { displayName: true, unixUsername: true, googleEmail: true } },
                  parentProjectId: true, parentWorkstream: true, parentClaudeSession: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!project) return { status: 404, body: { error: 'Project not found' } };
  const workflow = project.workflows.find(w => w.workstream.name === workstream) ?? project.workflows.find(w => w.workstream.name === 'main');
  const caps = access.host.instanceId ? instanceAgentTransport(access.host.instanceId)?.capabilities ?? [] : [];
  const targetError = chatTargetError({
    isChatProvider: isChatRunnerProvider(workflow?.provider),
    instanceId: access.host.instanceId,
    setupStatus: project.setupStatus,
    connected: isProjectAgentConnected(access.host),
    capabilities: caps,
  });
  if (targetError) return targetError;
  // The matched workflow's own workstream: its name drives the cwd and the
  // status session (which a rename moves), its id keys the chat (which a
  // rename must not move).
  const wsName = workflow!.workstream.name;
  const wsId = workflow!.workstream.id;
  const askThread = workflow!.workstream.askThread;
  // An ask's conversation is the asker's, and the asker owns the project and its box.
  const askRefusal = askThread
    ? askChatSendRefusal({ userId, projectOwnerId: project.userId, boxOwnerId: project.instance?.userId ?? null, capabilities: caps })
    : null;
  const dir = tmux.projectDirFor(
    { name: project.name, user: { unixUsername: access.project.ownerUsername }, instance: { hostHome: project.instance?.hostHome ?? null } },
    // An ask chat has no worktree: its clone is made from the checkout the thread asks.
    askThread ? askThread.workstream : wsName,
  );
  const cwd = askThread ? askCwd(dir, askThread.repoName) : dir;
  // An ask's turns always run trusted (agent/ask-chat.js), so its chat never offers the trust tick.
  const trust: ChatTrust = askThread ? { trusted: true, reason: 'trusted', mode: TRUSTED_MODE } : chatTrust(project);
  // An ask's chat runs on the default backend (agent/ask-chat.js).
  const choice = askThread ? storedChatChoice(null, null) : storedChatChoice(workflow!.backend, workflow!.model);
  return {
    host: access.host, projectId, project: project.name, workstream: wsName, workstreamId: wsId,
    chatKey: chatKeyFor(projectId, wsId), cwd,
    sessionName: tmux.sessionName(access.project.ownerUsername, project.name, 'agent', wsName),
    instanceId: access.host.instanceId,
    requireCheckout: askThread ? false : chatRequireCheckout(project),
    paneSession: access.session,
    trust,
    // The ask's own mode (agent/ask-chat.js), whatever the project's trust: the clone is the committed code, run as the box user.
    permissionMode: askThread ? TRUSTED_MODE : followUpMode(trust.mode, wsName, caps.includes(CHAT_AUTO_CAPABILITY)),
    agentCapabilities: caps, isOwner: access.isOwner,
    ask: askThread ? {
      threadId: askThread.id, baseSha: askThread.baseSha,
      gitName: askThread.originUser.displayName || askThread.originUser.unixUsername, gitEmail: askThread.originUser.googleEmail,
      // A clone the box makes again for this message pushes as the thread's asks do (ask-push-v1).
      ...(caps.includes(ASK_PUSH_CAPABILITY) ? {
        pushBranch: askThread.targetPr != null && askThread.targetBranch ? askThread.targetBranch : askBranch(askThread.originUser.unixUsername, askThread.id),
      } : {}),
      sendRefusal: askRefusal,
      thread: { id: askThread.id, parentProjectId: askThread.parentProjectId, parentWorkstream: askThread.parentWorkstream, parentClaudeSession: askThread.parentClaudeSession },
    } : null,
    workflowId: workflow!.id, choice, ownerId: project.userId,
    orchestrator: !askThread && project.chatOrchestrator === true,
    engine: chatEngineOf(workflow!.provider) ?? null,
  };
}

/** A target with what its turn, or its resume, starts on (services/chatLaunch.ts). */
type LaunchTarget = ChatTarget & Extract<ChatLaunchResult, { ok: true }>['launch'];

/** The launch for a choice on the chat's box; read only where a turn or a resume starts. */
function launchFor(target: ChatTarget, choice: ChatChoice): Promise<ChatLaunchResult> {
  return chatLaunchFor(choice, { ownerId: target.ownerId, instanceId: target.instanceId, capabilities: target.agentCapabilities });
}

/**
 * The target with the backend and model a message picked, and the write that
 * makes them the workstream's from this turn on. Run `save` only once the send
 * went in: a refused send leaves the chat on what it had. A chat whose choice
 * cannot start on this box (a backend turned off, an older runner) is refused
 * until a message switches it.
 */
async function turnTarget(
  target: ChatTarget, sent: { model?: unknown; backend?: unknown }, ldUser?: FlagUser,
): Promise<{ target: LaunchTarget; save: () => Promise<void> } | Result> {
  const fireworks = sent.backend === 'fireworks' && ldUser ? await fireworksOfferedTo(ldUser) : null;
  const turn = chatTurnChoice(target.choice, sent, fireworks);
  if (!turn.ok) return { status: 400, body: { error: turn.error } };
  if (turn.choice.backend && target.ask) return { status: 409, body: { error: "An ask's chat runs on Claude's own models", code: 'ask-chat' } };
  const launch = await launchFor(target, turn.choice);
  if (!launch.ok) return { status: launch.status, body: launch.body };
  return {
    target: { ...target, choice: turn.choice, ...launch.launch },
    save: async () => {
      if (turn.changed) await prisma.workflow.update({ where: { id: target.workflowId }, data: { backend: turn.choice.backend, model: turn.choice.model } });
    },
  };
}

/**
 * The model a history reports: the stored tier, or Sonnet. A Fireworks chat with
 * none runs on the flag's default, so it reports that; null when its launch
 * cannot be read (the picker shows it as Fireworks).
 */
async function reportedModel(target: ChatTarget): Promise<string | null> {
  if (target.choice.backend !== 'fireworks') return resolvedChatTier(target.choice.model);
  if (target.choice.model) return target.choice.model;
  const launch = await launchFor(target, target.choice);
  return launch.ok ? launch.launch.model : null;
}

/** What decides whether this chat takes an effort from this viewer (services/chatEffort.ts). */
async function effortContext(target: ChatTarget, ldUser?: FlagUser): Promise<ChatEffortContext> {
  return {
    flagOn: ldUser ? await boolVariation(CHAT_EFFORT_FLAG, ldUser, false) : false,
    capabilities: target.agentCapabilities,
    ask: target.ask != null,
    backend: target.choice.backend ?? null,
  };
}

/** The space a chat's turn loads: the chat's own, never the tab it is open in (services/chatSpace.ts turnMemorySpace). */
function chatMemorySpaceOf(target: ChatTarget): Promise<string | null | undefined> {
  return turnMemorySpace(target.workstreamId);
}

/** Whether this send's turn is told about generative UI (services/chatGenUi.ts): the sender's flag, this chat and its box. */
async function genUiFor(target: ChatTarget, ldUser?: FlagUser): Promise<boolean> {
  return chatGenUiForSend({
    flagOn: ldUser ? await boolVariation(CHAT_GENUI_FLAG, ldUser, false) : false,
    capabilities: target.agentCapabilities,
    ask: target.ask != null,
    backend: target.choice.backend ?? null,
  });
}

/** Whether a turn that gets generative UI carries only its hint, the prompt filed on the box (chat-generative-ui-hint-enabled). */
async function genUiHintFor(genUi: boolean, ldUser?: FlagUser): Promise<boolean> {
  return genUi && ldUser ? boolVariation(CHAT_GENUI_HINT_FLAG, ldUser, false) : false;
}

function isResult<T extends object>(x: T | Result): x is Result {
  return 'status' in x && 'body' in x;
}

function rpcError(err: unknown): Result {
  return chatRpcFailure(err instanceof Error ? err.message : String(err));
}

/**
 * The chat's history from the orchestrator's stored transcript,
 * for a chat whose box can't answer, or null to
 * keep the box's answer: nothing stored, the store off, the flag off for the
 * owner, an ask's chat, or a chunk that would not open (logged).
 */
async function storedHistoryFor(userId: string, projectId: string, workstreamRaw: unknown): Promise<Result | null> {
  const cfg = getTranscriptStoreConfig();
  if (!cfg) return null;
  const workstream = typeof workstreamRaw === 'string' && workstreamRaw ? workstreamRaw : 'main';
  let isOwner: boolean;
  try {
    isOwner = (await projectSessionAccess(userId, projectId))('agent', workstream).isOwner;
  } catch {
    return null;
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      repoUrl: true, chatTrustedAt: true,
      instance: { select: { id: true, status: true, kind: true } },
      user: { select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true } },
      workflows: {
        where: { type: 'agent' },
        select: { provider: true, backend: true, model: true, workstream: { select: { id: true, name: true, askThread: { select: { id: true } } } } },
      },
    },
  });
  if (!project) return null;
  const workflow = project.workflows.find(w => w.workstream.name === workstream) ?? project.workflows.find(w => w.workstream.name === 'main');
  if (!workflow || !isChatRunnerProvider(workflow.provider)) return null;
  // An ask's thread (agent/ask-chat.js) reads like any chat; its turns always run trusted, and it never continues on a new box.
  const ask = workflow.workstream.askThread != null;
  if (!await boolVariation(CHAT_TRANSCRIPTS_FLAG, project.user, false)) return null;
  let view;
  try {
    view = await readStoredView(cfg, projectId, workflow.workstream.id);
  } catch (err) {
    console.error('[TRANSCRIPT] %s: the stored view would not open: %s', projectId, err instanceof Error ? err.message : String(err));
    return null;
  }
  if (!view) return null;
  // An ask's chat runs on the default backend and model, whatever its workstream saved (chatTarget, agent/ask-chat.js).
  const choice = ask ? storedChatChoice(null, null) : storedChatChoice(workflow.backend, workflow.model);
  // A send continues it on a new box, or starts its stopped box (services/chatNewBox.ts).
  const continuation = await continuationBody(await continuationFacts(projectId, workflow.workstream.id, workflow.workstream.name, isOwner, ask), workflow.workstream.id);
  return {
    status: 200,
    body: {
      chatKey: chatKeyFor(projectId, workflow.workstream.id), workstream: workflow.workstream.name,
      sessionId: view.sessionId, entries: view.entries, running: false, liveInput: false, queued: 0, parked: false, turn: null, turns: [],
      checkoutReady: true, sendsLive: false, imageInput: false, pdfInput: false, stopsTurn: false,
      // Trust is the project's (chatTrustFor), so the box need not answer.
      trust: ask ? { trusted: true, reason: 'trusted', mode: TRUSTED_MODE } : chatTrust(project), canTrust: isOwner && !ask,
      model: choice.backend === 'fireworks' ? choice.model : resolvedChatTier(choice.model),
      ...(choice.backend ? { backend: choice.backend } : {}),
      // Read from the store: the box did not answer. Sending still needs it.
      stored: true,
      ...(continuation ? { continuation } : {}),
    },
  };
}

export async function chatHistoryFor(userId: string, projectId: string, query: Request['query'], ldUser?: FlagUser): Promise<Result> {
  const target = await chatTarget(userId, projectId, query.workstream);
  if (isResult(target)) {
    // A chat coming up on a new box (or its started one) reads from the store meanwhile.
    const c = await continuationTarget(userId, projectId, query.workstream);
    if (!chatHistoryFromStore(target) && !(c && continuationPhase(c.facts))) return target;
    return await storedHistoryFor(userId, projectId, query.workstream) ?? target;
  }
  // A chat coming back on this box (restoring, or its Claude credentials still
  // on their way) reads from the store until it can take a turn: no empty
  // chat, and no sign-in card for a box that is about to be signed in.
  if (!target.ask) {
    const c = await continuationTarget(userId, projectId, query.workstream);
    if (c && continuationPhase(c.facts)) {
      const stored = await storedHistoryFor(userId, projectId, query.workstream);
      if (stored) return stored;
    }
  }
  try {
    // paneProbe tells the runner what the agent pane is actually doing.
    // resumeQueue is the same bit an older agent reads (it has no paneProbe):
    // a live chat may continue a queue parked across an agent restart, and a
    // Claude in the pane may not. A miss is not "Claude left" — the runner
    // keeps a claim from Open in full UI until a probe has seen Claude and
    // then a shell (agent/chat-runner.js nextPaneClaim).
    const fg = target.ask ? null : await readPane(target);
    const probe = fg ? probeFromForeground(fg) : null;
    // A chat continued on this box shows its restored history, not an empty
    // new one. Until the restore has gone through, it shows the stored copy.
    try {
      await restorePending(target);
    } catch {
      const stored = await storedHistoryFor(userId, projectId, query.workstream);
      if (stored) return stored;
    }
    // Only a live Claude or a shell/dead pane: a miss is omitted, not false.
    const terminalHolds = fg ? historyTerminalHolds(fg) : undefined;
    const historyAskedAt = new Date();
    const data = await sendForProject(target.host, 'chat-history', {
      chatKey: target.chatKey, cwd: target.cwd, requireCheckout: target.requireCheckout,
      resumeQueue: probe !== 'claude', ...(probe ? { paneProbe: probe } : {}),
    }, 15_000) as { running?: boolean; sessionId?: unknown; t3?: unknown };
    // No turn runs on the box, so a status still stuck `working` (a reconnect
    // around turn-end, an agent that died mid-turn) is stale: settle it.
    if (data.running === false) reconcileChatStatus(target.sessionName, target.instanceId);
    // A chat the desktop's thread holds may have just taken its session from the thread (services/chatHolder.ts).
    if (data.t3 && isChatSessionId(data.sessionId)) {
      void saveChatSession(projectId, target.workstreamId, data.sessionId, historyAskedAt).catch(err => {
        console.error('[CHAT] session id not saved:', err instanceof Error ? err.message : String(err));
      });
    }
    // The running turn's liveInput says it reads messages; sendsLive, whether this viewer's would go in.
    const sendsLive = !target.ask && chatSendsLive(target.agentCapabilities, ldUser ? await boolVariation(CHAT_LIVE_INPUT_FLAG, ldUser, false) : false);
    // Whether this viewer's composer offers images: the flag travels here, not through the browser's bootstrap.
    const imageInput = chatImageInput(ldUser ? await boolVariation(CHAT_IMAGE_INPUT_FLAG, ldUser, false) : false, target.agentCapabilities);
    const pdfInput = chatPdfInput(imageInput, target.agentCapabilities, target.choice.backend ?? null);
    // Whether this viewer's model menu offers an effort for this chat, the same way.
    const effortInput = chatEffortInput(await effortContext(target, ldUser));
    // Whether the context popover offers Clear, Compact and Resume, whether this box can do them yet, and what this chat can never do.
    const contextActions = chatContextActions(target.agentCapabilities, target.ask != null);
    const contextRefusals = contextActions ? chatContextRefusals(target.engine, target.choice.backend) : {};
    // An agent from before the check reports nothing: its checkout counts as there.
    return {
      status: 200,
      body: {
        chatKey: target.chatKey, workstream: target.workstream, checkoutReady: true, ...data, sendsLive, imageInput, pdfInput, effortInput,
        ...(await liveContinuation(target)),
        stopsTurn: chatStopsTurn(target.agentCapabilities), ...(contextActions ? { contextActions, ...(Object.keys(contextRefusals).length ? { contextRefusals } : {}) } : {}), trust: target.trust, canTrust: target.isOwner && !target.ask,
        model: await reportedModel(target),
        ...(target.choice.backend ? { backend: target.choice.backend } : {}),
        ...(terminalHolds !== undefined ? { terminalHolds } : {}),
      },
    };
  } catch (err) {
    // The box went away during the request.
    if (/not connected/i.test(err instanceof Error ? err.message : String(err))) {
      const stored = await storedHistoryFor(userId, projectId, query.workstream);
      if (stored) return stored;
    }
    return rpcError(err);
  }
}

const CLAIM_REFUSALS: Record<string, string> = {
  'chat-running': 'termag web is running a turn in this chat; send again when it ends',
  'terminal-holds': "Claude is open in this chat's terminal in termag web; return it to the chat first",
  't3-busy': "The desktop app's server is busy with this thread; try again in a moment",
  't3-unknown': "The box's desktop server doesn't know this thread",
  forked: 'This thread is a copy of the chat, so it continues on its own session',
  't3-unsupported': 'This box needs a newer desktop server',
  't3-offline': "The box's desktop server isn't running",
};

/**
 * The desktop app's thread takes a chat's Claude session:
 * POST /api/cli/v1/projects/:id/chat/claim. Only its
 * owner continues a chat, and never an ask's, whose session lives in the
 * thread's clone. The box decides on the runner's send chain (agent/chat-runner.js
 * claimT3), under the pane's lock so it can't race Open in full UI; a claim it
 * takes is recorded as of when it was asked (services/chatHolder.ts).
 */
export async function claimChatFor(userId: string, projectId: string, body: unknown): Promise<Result> {
  const { workstream, threadId } = (body && typeof body === 'object' ? body : {}) as { workstream?: unknown; threadId?: unknown };
  if (!isT3ThreadId(threadId)) return { status: 400, body: { error: 'threadId is required', code: 'invalid_request' } };
  const target = await chatTarget(userId, projectId, workstream);
  if (isResult(target)) return target;
  if (!target.isOwner) return { status: 403, body: { error: "Only the project's owner can continue this chat", code: 'not-owner' } };
  if (target.ask) return { status: 409, body: { error: "An ask's chat runs in its thread's clone, so the desktop app can't take it over", code: 'ask-chat' } };
  if (!target.agentCapabilities.includes(CHAT_T3_HOLD_CAPABILITY)) return { status: 409, body: { error: CLAIM_REFUSALS['t3-unsupported'], code: 't3-unsupported' } };
  // When the box is asked, inside the lock: a notice recorded while this waited for it is older than the box's answer.
  let askedAt = new Date();
  let answer: { claimed?: unknown; sessionId?: unknown; reason?: unknown };
  try {
    answer = await withPaneLock(paneLockKey(target.instanceId, target.paneSession), () => {
      askedAt = new Date();
      return sendForProject(target.host, 'chat-t3-claim', { chatKey: target.chatKey, threadId, workstream: target.workstream }, 40_000);
    }) as typeof answer;
  } catch (err) {
    return rpcError(err);
  }
  if (answer?.claimed !== true) {
    const code = typeof answer?.reason === 'string' && CLAIM_REFUSALS[answer.reason] ? answer.reason : 't3-offline';
    return { status: 409, body: { error: CLAIM_REFUSALS[code], code } };
  }
  const sessionId = isChatSessionId(answer.sessionId) ? answer.sessionId : null;
  await saveChatHolder(projectId, target.workstreamId, { holder: 't3', threadId, sessionId }, askedAt);
  return { status: 200, body: { holder: 't3', threadId, sessionId } };
}

/** The chat's continuation facts for this viewer, or null for a chat it doesn't apply to. */
async function continuationTarget(userId: string, projectId: string, workstreamRaw: unknown): Promise<{ facts: ContinuationFacts; workstreamId: string; workstream: string } | null> {
  const workstream = typeof workstreamRaw === 'string' && workstreamRaw ? workstreamRaw : 'main';
  let isOwner: boolean;
  try {
    isOwner = (await projectSessionAccess(userId, projectId))('agent', workstream).isOwner;
  } catch {
    return null;
  }
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true, workflows: { where: { type: 'agent' }, select: { provider: true, workstream: { select: { id: true, name: true, askThread: { select: { id: true } } } } } } },
    });
    if (!project?.userId || !Array.isArray(project.workflows)) return null;
    // Flag off (for the owner): nothing more is read, and the chat is as before.
    if (!await resumeFlagOnForOwner(project.userId)) return null;
    const workflow = project.workflows.find(w => w.workstream.name === workstream) ?? project.workflows.find(w => w.workstream.name === 'main');
    if (!workflow || !isChatRunnerProvider(workflow.provider)) return null;
    const ws = workflow.workstream;
    return { facts: await continuationFacts(projectId, ws.id, ws.name, isOwner, ws.askThread != null), workstreamId: ws.id, workstream: ws.name };
  } catch (err) {
    console.error('[RESUME] %s: continuation not read: %s', projectId, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** What the view shows about a continue or a box start: the phase, the held messages, why this viewer can't send. Null when none of it applies. */
async function continuationBody(facts: ContinuationFacts, workstreamId: string): Promise<Record<string, unknown> | null> {
  if (!facts.flagOn || facts.excluded) return null;
  const phase = continuationPhase(facts);
  const held = facts.hasHeld ? await heldFor(workstreamId) : [];
  const sendRefusal = continuationRefusal(facts);
  // `takesSends`: a send here is taken (held, and the box started or continued) though the box is not
  // there, so the view sends what it queued before this history came rather than waiting for the box to
  // answer. Only when holdIfContinuing would take it: a ready box whose agent is just offline sends the
  // usual way, which fails until it is back, so the queue waits for the box there.
  const plan = sendPlanFor(facts).kind;
  const takesSends = plan === 'continue' || plan === 'start-box' || plan === 'hold';
  return { ...(phase ? { phase } : {}), ...(held.length ? { held } : {}), ...(sendRefusal ? { sendRefusal } : {}), ...(takesSends ? { takesSends } : {}) };
}

/** A live chat whose held messages are still going in shows them. */
async function liveContinuation(target: ChatTarget): Promise<Record<string, unknown>> {
  if (target.ask || !await resumeFlagOnForOwner(target.ownerId)) return {};
  const held = await heldFor(target.workstreamId).catch(() => []);
  return held.length ? { continuation: { held } } : {};
}

/**
 * A send to a chat whose box was terminated (continue on a new box) or is
 * stopped (start it), or that is still coming up or holds earlier messages:
 * the message is held and goes in once the chat can take it. Null for a send
 * that goes the usual way. Owner only, where a box would start.
 */
async function holdIfContinuing(userId: string, projectId: string, body: Record<string, unknown>, imageCount: number): Promise<Result | null> {
  const c = await continuationTarget(userId, projectId, body.workstream);
  if (!c) return null;
  const plan = sendPlanFor(c.facts);
  if (plan.kind === 'normal') return null;
  if (plan.kind === 'refuse') return { status: plan.status, body: { error: plan.reason, code: plan.code } };
  if (imageCount > 0) {
    return { status: 409, body: { error: 'Images can go in once the chat is back up: send the text now, and the images then.', code: 'held-images' } };
  }
  if (plan.kind === 'continue' || plan.kind === 'start-box') {
    const owner = await prisma.user.findUnique({ where: { id: userId } }) as Express.User | null;
    if (!owner) return { status: 404, body: { error: 'Chat not found' } };
    if (plan.kind === 'continue') {
      const r = await continueOnNewBoxFor(owner, projectId, c.workstream);
      // Another send (a second tab, a double Enter) is already continuing it: this one joins.
      if (r.status !== 202 && (r.body as { code?: unknown } | null)?.code !== 'continuing') return r;
    } else {
      const { powerOwnedBox } = await import('./instances');
      const r = await powerOwnedBox(owner, plan.boxId, 'start');
      // 409: already starting.
      if (r.status >= 400 && r.status !== 409) return r;
    }
  }
  const held = await holdMessage({ projectId, workstreamId: c.workstreamId, senderId: userId }, {
    text: body.text as string,
    model: typeof body.model === 'string' ? body.model : null,
    backend: typeof body.backend === 'string' ? body.backend : null,
    effort: typeof body.effort === 'string' ? body.effort : null,
  });
  if (!held) return { status: 429, body: { error: 'Too many messages are waiting for this chat to come back up', code: 'held-full' } };
  kickHeldDelivery(c.workstreamId);
  const phase = plan.kind === 'continue' ? 'starting-box' : plan.kind === 'start-box' ? 'starting' : continuationPhase(c.facts);
  return { status: 202, body: { queued: true, held: true, position: held.position, ...(phase ? { phase } : {}) } };
}

// A send that finds the chat still coming up: given back, tried again.
// checkout-pending: a continue moves the project with setup pending, and the
// pane clone can run after setup reports ready, so a new box's first send can
// find no checkout yet. queue-full and chat-busy pass too.
const NOT_READY_CODES = new Set(['setup', 'offline', 'restore-pending', 'no-box', 'terminal-holds', 'busy', 'checkout-pending', 'queue-full', 'chat-busy', 't3-busy']);

/** Send a held message as its sender (chatHeld.ts delivery). */
export async function deliverHeldMessage(m: HeldMessage): Promise<DeliverOutcome> {
  const [sender, ws] = await Promise.all([
    prisma.user.findUnique({ where: { id: m.senderId }, select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true } }),
    prisma.workstream.findUnique({ where: { id: m.workstreamId }, select: { name: true } }),
  ]);
  if (!sender || !ws) return { kind: 'refused', error: 'The chat or its sender is gone' };
  const project = await prisma.project.findUnique({ where: { id: m.projectId }, select: { instanceId: true } });
  // Its first turn would run before the box can reach Claude. The mark is in
  // the database (chatNewBox.ts markCredentialsReady): the delivery may be
  // running in another orchestrator process.
  if (project?.instanceId) {
    const waiting = await prisma.chatResume.findFirst({
      // A recent one only: past the stale window its continuer died, and it holds the chat no longer.
      where: { workstreamId: m.workstreamId, toInstanceId: project.instanceId, noticeSentAt: null, credentialsReadyAt: null, createdAt: { gte: new Date(Date.now() - CREDENTIALS_STALE_MS) } },
      select: { id: true },
    });
    if (waiting) return { kind: 'not-ready' };
  }
  const r = await chatSendFor(m.senderId, m.projectId, {
    workstream: ws.name, text: m.text,
    ...(m.model ? { model: m.model } : {}), ...(m.backend ? { backend: m.backend } : {}), ...(m.effort ? { effort: m.effort } : {}),
  }, sender, { delivering: true });
  if (r.status === 202) return { kind: 'sent' };
  const b = r.body as { code?: unknown; error?: unknown } | null;
  if (r.status === 503 || (typeof b?.code === 'string' && NOT_READY_CODES.has(b.code))) return { kind: 'not-ready' };
  return { kind: 'refused', error: typeof b?.error === 'string' ? b.error : `refused (${r.status})` };
}

/**
 * An ask's finish notice as a turn of the chat that sent the ask
 * (services/askNoticeSweep.ts): sent as the chat's owner, never live, so a
 * turn running takes it after it ends, and never starting a box or holding
 * it for one (the sweep only calls this for a connected box). A chat not
 * ready for it yet (a pane holding the session, the box between states) is
 * tried again on a later tick.
 */
export const sendAskNotice: ChatNoticeSender = async ({ userId, projectId, workstream, text }) => {
  const owner = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true } });
  if (!owner) return { kind: 'refused', error: 'the asker is gone' };
  // Held messages were sent first: the notice waits until they have gone in, so it never lands ahead of them.
  const ws = await prisma.workstream.findFirst({ where: { projectId, name: workstream }, select: { id: true } });
  if (ws && await hasHeld(ws.id)) return { kind: 'not-ready' };
  return askNoticeSendResult(await chatSendFor(userId, projectId, { workstream, text }, owner, { delivering: true, noLive: true }));
};

// A notice also outlasts a stop: a chat stopped before it went in, or being stopped, takes it on a later tick.
const NOTICE_RETRY_CODES = new Set([...NOT_READY_CODES, 'chat-stopped', 'chat-clearing']);

/**
 * A notice send's answer as the sweep's outcome. A 502/503/504 (the box agent
 * not connected, a gateway error, a timeout) or a chat not ready for it is
 * tried again on a later tick; NOTICE_GIVE_UP_MS bounds the retries.
 */
export function askNoticeSendResult(r: { status: number; body: unknown }): Awaited<ReturnType<ChatNoticeSender>> {
  if (r.status === 202) return { kind: 'sent' };
  const b = r.body as { code?: unknown; error?: unknown } | null;
  if (r.status === 502 || r.status === 503 || r.status === 504 || (typeof b?.code === 'string' && NOTICE_RETRY_CODES.has(b.code))) return { kind: 'not-ready' };
  return { kind: 'refused', error: typeof b?.error === 'string' ? b.error : `refused (${r.status})` };
}

/**
 * A chat continued on this box from a terminated one (services/chatNewBox.ts):
 * its stored session is put on the box first, and the notice for its first
 * turn there. Null when the chat has no such resume waiting.
 */
async function restorePending(target: ChatTarget): Promise<{ id: string; notice: string } | null> {
  if (target.ask) return null;
  const resume = await pendingResumeFor(target.workstreamId, target.instanceId);
  if (!resume) return null;
  try {
    await ensureRestored(resume);
  } catch (err) {
    console.error('[RESUME] %s: restore failed: %s', target.chatKey, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { id: resume.id, notice: newBoxNotice(resume.gitState, resume.lostWorkstreams) };
}

/** The agent pane's foreground. `dead` is set only when the agent reports pane_dead. A miss is an empty live pane. */
async function readPane(target: ChatTarget): Promise<PaneForeground> {
  try {
    const r = await sendForProject(target.host, 'tmux-foreground-cmd', { sessionName: target.paneSession }, 5_000);
    return { cmd: typeof r?.cmd === 'string' ? r.cmd : null, dead: r?.dead === true };
  } catch { return { cmd: null, dead: false }; }
}

/**
 * Record a probe on the box. An agent from before chat-note-pane answers
 * "Unknown command"; the send that follows carries the same probe, which a
 * runner that understands it applies itself. Any other failure propagates.
 */
async function notePane(target: ChatTarget, probe: PaneProbe): Promise<{ resume?: boolean }> {
  try {
    const noted = await sendForProject(target.host, 'chat-note-pane', { chatKey: target.chatKey, paneProbe: probe }, 15_000) as { resume?: boolean };
    return noted ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/Unknown command/.test(message)) throw err;
    return {};
  }
}

/**
 * Whether a send asks the box for its owner's monthly spend
 * (chat-plan-spend-enabled): the project owner's own
 * send with the flag on for them, never a collaborator's, since the spend is
 * read with the box owner's claude.ai login.
 */
async function sendsPlanSpend(target: { isOwner: boolean }, ldUser?: FlagUser): Promise<boolean> {
  return target.isOwner && ldUser ? boolVariation(CHAT_PLAN_SPEND_FLAG, ldUser, false) : false;
}

export async function chatSendFor(userId: string, projectId: string, body: Record<string, unknown>, ldUser?: FlagUser, opts: { delivering?: boolean; noLive?: boolean } = {}): Promise<Result> {
  const images = checkChatImages(body.images);
  if (!images.ok) return { status: images.status, body: { error: images.error, code: images.code } };
  const textError = chatTextError(body.text, images.images.length > 0);
  if (textError) return { status: 400, body: { error: textError } };
  // Sending is the decision: continue on a new box, start the box, or wait behind held messages.
  // A held message's own delivery goes the usual way.
  if (!opts.delivering) {
    const held = await holdIfContinuing(userId, projectId, body, images.images.length);
    if (held) return held;
  }
  // A box just claimed from the pool runs its first turn once its update is
  // done (services/claimUpdate.ts): the simple UI holds the first message
  // while its setup steps say so, and this covers any other sender.
  if (anyClaimUpdateRunning()) {
    const box = await prisma.project.findUnique({ where: { id: projectId }, select: { instanceId: true } });
    await claimUpdateSettled(box?.instanceId);
  }
  const found = await chatTarget(userId, projectId, body.workstream);
  if (isResult(found)) return found;
  const turn = await turnTarget(found, { model: body.model, backend: body.backend }, ldUser);
  if (isResult(turn)) return turn;
  const { target } = turn;
  // This turn's --effort, on the backend the turn runs on (after a model switch, too).
  const effort = chatEffortForSend(body.effort, await effortContext(target, ldUser));
  // Whoever may send this chat a message (owner or share, chatTarget) may send it an image.
  const imageRefusal = chatImagesRefusal(
    images.images.length,
    images.images.length > 0 && ldUser ? await boolVariation(CHAT_IMAGE_INPUT_FLAG, ldUser, false) : false,
    target.agentCapabilities,
    pdfCount(images.images),
    target.choice.backend ?? null,
  );
  if (imageRefusal) return { status: imageRefusal.status, body: { error: imageRefusal.error, code: imageRefusal.code } };
  // An automation run's brief is its only turn while the run is live (services/automations/chatGate.ts).
  const runRefusal = await runChatRefusalFor(projectId, target.workstreamId, target.workstream);
  if (runRefusal) return { status: 409, body: { error: RUN_CHAT_REFUSAL_TEXT[runRefusal], code: runRefusal } };
  if (target.ask?.sendRefusal) return target.ask.sendRefusal;
  try {
    // An ask's chat has no agent pane: its session lives in the thread's clone (agent/ask-chat.js).
    if (target.ask) {
      const { sendRefusal: _refusal, thread: askThread, ...askFacts } = target.ask;
      // The chat's own space, as for a person's turn anywhere else (Bugbot, #769).
      const memorySpace = await chatMemorySpaceOf(target);
      // The thread and who asked, for the turn's telemetry resource like its asks' turns (services/askTelemetry.ts).
      const ask = { ...askFacts, telemetry: await askTelemetryFor(askThread) };
      const payload = { ...chatSendRpcPayload(target, body.text as string, target.agentCapabilities, { liveInput: false, images: images.images, memorySpace }), ask };
      const sent = await sendForProject(target.host, 'chat-send', payload, images.images.length > 0 ? CHAT_IMAGE_SEND_TIMEOUT_MS : undefined);
      await turn.save();
      return { status: 202, body: sent };
    }
    // A termag notice never goes into a running turn: it queues after it (sendAskNotice).
    const liveInput = ldUser && !opts.noLive ? await boolVariation(CHAT_LIVE_INPUT_FLAG, ldUser, false) : false;
    const titles = ldUser ? await boolVariation(SESSION_TITLES_FLAG, ldUser, false) : false;
    const memorySpace = await chatMemorySpaceOf(target);
    const genUi = await genUiFor(target, ldUser);
    const genUiHint = await genUiHintFor(genUi, ldUser);
    // chat-resume-new-box-enabled, for the owner: the turn hears of a restart, or of the new box it continues on.
    const boxNotices = await resumeFlagOnForOwner(target.ownerId);
    let resumed: { id: string; notice: string } | null = null;
    if (boxNotices) {
      try {
        resumed = await restorePending(target);
      } catch (err) {
        return { status: 503, body: { error: `This chat's history could not be put on its new box yet: ${err instanceof Error ? err.message : String(err)}`, code: 'restore-pending' } };
      }
    }
    const planSpend = await sendsPlanSpend(target, ldUser);
    // Under the pane's lock, so it waits out a resume that is still bringing
    // its Claude up instead of probing the shell it was typed into.
    const r = await withPaneLock(paneLockKey(target.instanceId, target.paneSession), () => sendUnlessTerminalHolds(
      () => readPane(target),
      probe => sendForProject(target.host, 'chat-send', {
        ...chatSendRpcPayload(target, body.text as string, target.agentCapabilities, { liveInput, images: images.images, titles, headings: true, effort, genUi, genUiHint, memorySpace, boxNotices, notice: resumed?.notice, planSpend }),
        paneProbe: probe,
      }, images.images.length > 0 ? CHAT_IMAGE_SEND_TIMEOUT_MS : undefined),
    ));
    if (r.held) return TERMINAL_HOLDS_ANSWER;
    await turn.save();
    // The notice stays owed until Claude starts the turn that carries it
    // (chatNewBox.ts noteNoticeTold, on that turn's init): a 202 is the box
    // taking or queueing the job, not the turn running.
    return { status: 202, body: r.result };
  } catch (err) { return rpcError(err); }
}

export async function chatInterruptFor(userId: string, projectId: string, body: Record<string, unknown>): Promise<Result> {
  const target = await chatTarget(userId, projectId, body.workstream);
  if (isResult(target)) return target;
  // Stopping an ask's turn ends the asker's run, so it is the owner's, like a send.
  if (target.ask?.sendRefusal?.status === 403) return target.ask.sendRefusal;
  try {
    const payload = chatInterruptRpcPayload(target.chatKey, target.agentCapabilities, chatStopScope(body.scope));
    const data = await sendForProject(target.host, 'chat-interrupt', payload) as { held?: boolean };
    return interruptAnswer(data);
  } catch (err) { return rpcError(err); }
}

/**
 * The context popover's actions. clear: the box points the chat at no
 * session, so its next turn starts a new one. resume: the session the last
 * clear left comes back, until a turn has started a new one. compact: a
 * `/compact` turn on the session, Claude Code's own compaction, with the
 * chat's model and permission surface. Each tells every open view (a
 * chat-event the browser draws as a divider, or marks undone). Whoever may
 * send the chat a message may do them. Under the agent pane's lock, refused
 * while Claude in the pane has the session.
 */
export async function chatContextFor(userId: string, projectId: string, body: Record<string, unknown>, ldUser?: FlagUser): Promise<Result> {
  const action = chatContextAction(body.action);
  if (!action) return { status: 400, body: { error: 'action must be clear, compact or resume' } };
  const found = await chatTarget(userId, projectId, body.workstream);
  if (isResult(found)) return found;
  const offered = chatContextActions(found.agentCapabilities, found.ask != null);
  if (found.ask) return { status: 409, body: { error: "An ask's chat keeps the thread's session", code: 'ask-chat' } };
  if (offered === 'update') return { status: 409, body: { error: "This box's agent needs an update before it can do this", code: 'runner-update' } };
  const refusal = chatContextRefusals(found.engine, found.choice.backend)[action];
  if (refusal) return { status: 409, body: { error: refusal, code: 'context-unsupported' } };
  let target = found;
  if (action === 'compact') {
    // A compact is a turn: the same launch, automation gate and permission surface a message gets.
    const turn = await turnTarget(found, {}, ldUser);
    if (isResult(turn)) return turn;
    target = turn.target;
    const runRefusal = await runChatRefusalFor(projectId, target.workstreamId, target.workstream);
    if (runRefusal) return { status: 409, body: { error: RUN_CHAT_REFUSAL_TEXT[runRefusal], code: runRefusal } };
  }
  const ids = { chatKey: target.chatKey, projectId: target.projectId, workstream: target.workstream, workstreamId: target.workstreamId };
  try {
    const r = await withPaneLock(paneLockKey(target.instanceId, target.paneSession), () => sendUnlessTerminalHolds(
      () => readPane(target),
      probe => (action === 'compact'
        ? sendForProject(target.host, 'chat-compact', { ...chatSendRpcPayload(target, '/compact', target.agentCapabilities, { liveInput: false }), paneProbe: probe })
        : sendForProject(target.host, action === 'clear' ? 'chat-reset' : 'chat-resume', ids, 15_000)),
    ));
    if (r.held) return TERMINAL_HOLDS_ANSWER;
    return { status: action === 'compact' ? 202 : 200, body: r.result };
  } catch (err) {
    // The runner's own word that Open in full UI still claims the session.
    if (err instanceof Error && /^terminal-holds\b/.test(err.message)) return TERMINAL_HOLDS_ANSWER;
    return rpcError(err);
  }
}

/**
 * Open in full UI: continue the chat's session in the agent pane. The box
 * returns the line to type (the turn's permission surface for this checkout);
 * a pane that is busy, or already runs a Claude, is left alone. A chat with
 * no session yet has nothing to resume. Runs under the pane's lock and holds
 * it until Claude is the pane's foreground (services/chatResume.ts).
 */
export async function chatTerminalFor(userId: string, projectId: string, body: Record<string, unknown>): Promise<Result> {
  const target = await chatTarget(userId, projectId, body.workstream);
  if (isResult(target)) return target;
  if (target.ask) return { status: 409, body: { error: "An ask's chat runs in the thread's own clone and has no terminal to continue in", code: 'ask-chat' } };
  // The pane continues on the chat's backend, never quietly on the default one.
  const launch = await launchFor(target, target.choice);
  if (!launch.ok) return { status: launch.status, body: launch.body };
  try {
    const claimPayload = chatResumeClaimPayload({ ...target, ...launch.launch }, target.agentCapabilities);
    const r = await withPaneLock(paneLockKey(target.instanceId, target.paneSession), () => resumeChatInPane({
      history: () => sendForProject(target.host, 'chat-history', { chatKey: target.chatKey }, 15_000),
      claim: () => sendForProject(target.host, 'chat-resume-claim', claimPayload, 15_000),
      release: async (park, seen) => { await sendForProject(target.host, 'chat-resume-release', { chatKey: target.chatKey, park, seen }, 15_000); },
      ensurePane: async () => { await sendForProject(target.host, 'tmux-create', { sessionName: target.paneSession, cwd: target.cwd }); },
      probe: async () => (await readPane(target)).cmd,
      type: async line => { await sendForProject(target.host, 'tmux-send-keys', { sessionName: target.paneSession, keys: line, withEnter: true }); },
    }));
    return terminalAnswer(r);
  } catch (err) { return rpcError(err); }
}

/**
 * Simple UI: take the session back from the full UI's Claude, then send.
 * Under the pane lock the whole way. A live Claude is exited (`/exit` only);
 * a stale hold (Claude already gone, including a dead pane still named
 * claude) is cleared and nothing is typed. A shell during the resume
 * start-grace is left alone, so this does not start a second writer and
 * does not type into the launcher's shell. The draft is checked before any
 * of that, so a bad image does not exit Claude.
 */
export async function chatReclaimFor(userId: string, projectId: string, body: Record<string, unknown>, ldUser?: FlagUser): Promise<Result> {
  const images = checkChatImages(body.images);
  if (!images.ok) return { status: images.status, body: { error: images.error, code: images.code } };
  const text = typeof body.text === 'string' ? body.text : '';
  const hasDraft = Boolean(text.trim() || images.images.length);
  if (hasDraft) {
    const textError = chatTextError(text, images.images.length > 0);
    if (textError) return { status: 400, body: { error: textError } };
  }
  const found = await chatTarget(userId, projectId, body.workstream);
  if (isResult(found)) return found;
  const turn = await turnTarget(found, hasDraft ? { model: body.model, backend: body.backend } : {}, ldUser);
  if (isResult(turn)) return turn;
  const { target } = turn;
  const effort = hasDraft ? chatEffortForSend(body.effort, await effortContext(target, ldUser)) : null;
  if (hasDraft) {
    const imageRefusal = chatImagesRefusal(
      images.images.length,
      images.images.length > 0 && ldUser ? await boolVariation(CHAT_IMAGE_INPUT_FLAG, ldUser, false) : false,
      target.agentCapabilities,
      pdfCount(images.images),
      target.choice.backend ?? null,
    );
    if (imageRefusal) return { status: imageRefusal.status, body: { error: imageRefusal.error, code: imageRefusal.code } };
  }
  const runRefusal = await runChatRefusalFor(projectId, target.workstreamId, target.workstream);
  if (runRefusal) return { status: 409, body: { error: RUN_CHAT_REFUSAL_TEXT[runRefusal], code: runRefusal } };
  if (target.ask?.sendRefusal) return target.ask.sendRefusal;
  if (target.ask) return { status: 409, body: { error: "An ask's chat runs in the thread's own clone and has no terminal to return from", code: 'ask-chat' } };
  try {
    const liveInput = hasDraft && ldUser ? await boolVariation(CHAT_LIVE_INPUT_FLAG, ldUser, false) : false;
    const titles = hasDraft && ldUser ? await boolVariation(SESSION_TITLES_FLAG, ldUser, false) : false;
    const memorySpace = hasDraft ? await chatMemorySpaceOf(target) : undefined;
    const genUi = hasDraft && await genUiFor(target, ldUser);
    const genUiHint = await genUiHintFor(genUi, ldUser);
    const boxNotices = hasDraft && await resumeFlagOnForOwner(target.ownerId);
    const planSpend = hasDraft ? await sendsPlanSpend(target, ldUser) : false;
    return await withPaneLock(paneLockKey(target.instanceId, target.paneSession), async () => {
      const outcome = await reclaimChatFromPane({
        probe: () => readPane(target),
        exitClaude: async () => {
          await sendForProject(target.host, 'tmux-send-keys', {
            sessionName: target.paneSession, keys: CLAUDE_EXIT_KEYS, withEnter: true, literal: true,
          });
        },
        notePane: probe => notePane(target, probe),
      });
      if (outcome.status === 'held' || !hasDraft) return reclaimAnswer(outcome);
      // The pane is free. A draft on a chat continued on this box then goes
      // the way a send does: behind held messages, and only once the stored
      // session is restored, with the notice (sent before the restore it would
      // start a fresh session). Either way the answer says the pane was
      // reclaimed, so the client keeps the draft gone and doesn't retry it.
      let resumed: { id: string; notice: string } | null = null;
      if (boxNotices) {
        const held = await holdIfContinuing(userId, projectId, body, images.images.length);
        if (held) {
          return held.status === 202
            ? reclaimAnswer(outcome, held.body as Record<string, unknown>)
            : { status: held.status, body: { ...(held.body as Record<string, unknown>), reclaimed: true, typed: outcome.typed } };
        }
        try {
          resumed = await restorePending(target);
        } catch (err) {
          return {
            status: 503,
            body: { error: `This chat's history could not be put on its new box yet: ${err instanceof Error ? err.message : String(err)}`, code: 'restore-pending', reclaimed: true, typed: outcome.typed },
          };
        }
      }
      const sent = await sendUnlessTerminalHolds(
        () => readPane(target),
        probe => sendForProject(target.host, 'chat-send', {
          ...chatSendRpcPayload(target, text, target.agentCapabilities, { liveInput, images: images.images, titles, headings: true, effort, genUi, genUiHint, memorySpace, boxNotices, notice: resumed?.notice, planSpend }),
          paneProbe: probe,
        }, images.images.length > 0 ? CHAT_IMAGE_SEND_TIMEOUT_MS : undefined),
      );
      if (sent.held) return TERMINAL_HOLDS_ANSWER;
      await turn.save();
      return reclaimAnswer(outcome, sent.result as Record<string, unknown>);
    });
  } catch (err) { return rpcError(err); }
}

/**
 * A subagent's own transcript, as its box keeps
 * it beside the chat's session: its messages as history entries, for the
 * agent tab. Anyone who may read the chat may read it. A box whose agent
 * predates chat-subagents-v1 answers 409 `runner-update`; one that is away,
 * 503 `box-away`, as the stored transcript holds none of it.
 */
export async function chatSubagentFor(userId: string, projectId: string, agentIdRaw: unknown, query: Request['query'], ldUser?: FlagUser): Promise<Result> {
  if (!ldUser || !await boolVariation(CHAT_SUBAGENTS_FLAG, ldUser, false)) return { status: 404, body: { error: 'Not found', code: 'subagents-off' } };
  const agentId = subagentIdOf(agentIdRaw);
  if (!agentId) return { status: 400, body: { error: 'agentId must be a subagent id' } };
  const target = await chatTarget(userId, projectId, query.workstream);
  if (isResult(target)) return target;
  if (!target.agentCapabilities.includes(CHAT_SUBAGENTS_CAPABILITY)) {
    return { status: 409, body: { error: "This box's agent needs an update before it can show a subagent's work", code: 'runner-update' } };
  }
  try {
    const r = await sendForProject(target.host, 'chat-subagent-read', { chatKey: target.chatKey, agentId }, 15_000) as { found?: boolean; entries?: unknown[]; meta?: unknown; sessionId?: string };
    if (!r?.found) return { status: 404, body: { error: "The box has no transcript for that subagent", code: 'subagent-missing' } };
    return { status: 200, body: { agentId, entries: Array.isArray(r.entries) ? r.entries : [], ...(r.meta && typeof r.meta === 'object' ? { meta: r.meta } : {}) } };
  } catch (err) {
    if (/not connected/i.test(err instanceof Error ? err.message : String(err))) return { status: 503, body: { error: "The session's box isn't connected", code: 'box-away' } };
    return rpcError(err);
  }
}

/** The project's owner trusts its repository (or directory): its chat's turns run tools without asking from now on. */
export async function chatTrustFor(userId: string, projectId: string): Promise<Result> {
  let access;
  try {
    access = (await projectSessionAccess(userId, projectId))('agent', 'main');
  } catch (err) {
    if (err instanceof SessionAccessError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
  if (!access.isOwner) return { status: 403, body: { error: "Only the project's owner can trust this project" } };
  const project = await prisma.project.update({
    where: { id: projectId },
    data: { chatTrustedAt: new Date() },
    select: { repoUrl: true, chatTrustedAt: true },
  });
  return { status: 200, body: { trust: chatTrust(project) } };
}

export function chatRouter(): Router {
  const router = Router();
  router.get('/:id/chat', requireAuth, asyncHandler(async (req, res) => {
    const r = await chatHistoryFor(req.user!.id, req.params.id, req.query, req.user!);
    res.status(r.status).json(r.body);
  }));
  router.get('/:id/chat/subagents/:agentId', requireAuth, asyncHandler(async (req, res) => {
    const r = await chatSubagentFor(req.user!.id, req.params.id, req.params.agentId, req.query, req.user!);
    res.status(r.status).json(r.body);
  }));
  router.post('/:id/chat/messages', requireAuth, asyncHandler(async (req, res) => {
    const r = await chatSendFor(req.user!.id, req.params.id, req.body ?? {}, req.user!);
    res.status(r.status).json(r.body);
  }));
  router.post('/:id/chat/interrupt', requireAuth, asyncHandler(async (req, res) => {
    const r = await chatInterruptFor(req.user!.id, req.params.id, req.body ?? {});
    res.status(r.status).json(r.body);
  }));
  router.post('/:id/chat/reclaim', requireAuth, asyncHandler(async (req, res) => {
    // Same gate as Open in full UI: a form POST must not exit Claude or send.
    const r = await runAfterPostRefusal(chatReclaimPostRefusal({
      secFetchSite: req.get('sec-fetch-site'),
      origin: req.get('origin'),
      contentType: req.get('content-type'),
      body: req.body,
    }), () => chatReclaimFor(req.user!.id, req.params.id, req.body ?? {}, req.user!));
    res.status(r.status).json(r.body);
  }));
  router.post('/:id/chat/terminal', requireAuth, asyncHandler(async (req, res) => {
    // Before chatTerminalFor. A cross-site or same-site form POST still
    // carries the Lax session cookie and has no JSON body; that must not
    // resume the main chat.
    const r = await runAfterPostRefusal(chatTerminalPostRefusal({
      secFetchSite: req.get('sec-fetch-site'),
      origin: req.get('origin'),
      contentType: req.get('content-type'),
      body: req.body,
    }), () => chatTerminalFor(req.user!.id, req.params.id, req.body ?? {}));
    res.status(r.status).json(r.body);
  }));
  router.post('/:id/chat/context', requireAuth, asyncHandler(async (req, res) => {
    // Same gate as Open in full UI: a form POST must not clear, compact or resume a chat.
    const r = await runAfterPostRefusal(chatContextPostRefusal({
      secFetchSite: req.get('sec-fetch-site'),
      origin: req.get('origin'),
      contentType: req.get('content-type'),
      body: req.body,
    }), () => chatContextFor(req.user!.id, req.params.id, req.body ?? {}, req.user!));
    res.status(r.status).json(r.body);
  }));
  router.post('/:id/chat/trust', requireAuth, asyncHandler(async (req, res) => {
    // Before chatTrustFor. A cross-site or same-site form POST still carries
    // the Lax session cookie and has no JSON body; that must not set
    // chatTrustedAt.
    const r = await runAfterPostRefusal(chatTrustPostRefusal({
      secFetchSite: req.get('sec-fetch-site'),
      origin: req.get('origin'),
      contentType: req.get('content-type'),
      body: req.body,
    }), () => chatTrustFor(req.user!.id, req.params.id));
    res.status(r.status).json(r.body);
  }));
  return router;
}
