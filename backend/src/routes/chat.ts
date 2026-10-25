/**
 * The simple UI's chat on a chat-runner project (services/chatRunner.ts):
 *
 *   GET  /api/projects/:id/chat?workstream=      session id, running, history
 *   POST /api/projects/:id/chat/messages         { workstream, text, images?, model?, backend? }  (images: services/chatImages.ts)
 *        model: opus|sonnet|haiku, or with backend fireworks one of the
 *        sender's Fireworks models; this turn on (services/claudeChatModel.ts
 *        chatTurnChoice), kept on the workstream's agent row
 *   POST /api/projects/:id/chat/interrupt        { workstream, scope?: 'turn' | 'all' }
 *   POST /api/projects/:id/chat/terminal         { workstream }  Open in full UI:
 *        resume the session in the agent pane, same-origin JSON only, with
 *        the permission surface the chat's turns use
 *   POST /api/projects/:id/chat/reclaim          { workstream, text?, images?, model?, backend? }
 *        simple UI: the pane's Claude has the session. Exit it when it is
 *        really there, or clear a stale hold, then send. Same-origin JSON.
 *   POST /api/projects/:id/chat/trust            the owner trusts the repository
 *                                                (same-origin JSON { trust: true } only)
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
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { isChatRunnerProvider } from '../providers/registry';
import { instanceAgentTransport, isProjectAgentConnected, sendForProject } from '../services/agentRegistry';
import { chatTurnChoice, resolvedChatTier, storedChatChoice, type ChatChoice } from '../services/claudeChatModel';
import { chatLaunchFor, type ChatLaunchResult } from '../services/chatLaunch';
import { fireworksOfferedTo } from '../services/fireworksFlag';
import { paneLockKey, withPaneLock } from '../services/agentRuntime';
import { CLAUDE_EXIT_KEYS, interruptAnswer, reclaimAnswer, reclaimChatFromPane, resumeChatInPane, sendUnlessTerminalHolds, TERMINAL_HOLDS_ANSWER, terminalAnswer } from '../services/chatResume';
import { CHAT_AUTO_CAPABILITY, chatInterruptRpcPayload, chatKeyFor, chatRequireCheckout, chatResumeClaimPayload, chatRpcFailure, chatSendRpcPayload, chatSendsLive, chatStopScope, chatStopsTurn, chatTargetError, chatTextError, historyTerminalHolds, probeFromForeground, reconcileChatStatus, CHAT_LIVE_INPUT_FLAG, SESSION_TITLES_FLAG, type PaneForeground, type PaneProbe } from '../services/chatRunner';
import { chatTrust, followUpMode, TRUSTED_MODE, type ChatTrust } from '../services/chatTrust';
import { askChatSendRefusal } from '../services/agentMessages';
import { chatReclaimPostRefusal, chatTerminalPostRefusal, chatTrustPostRefusal, runAfterPostRefusal } from '../services/chatTrustPost';
import { CHAT_IMAGE_INPUT_FLAG, CHAT_IMAGE_SEND_TIMEOUT_MS, chatImageInput, chatImagesRefusal, checkChatImages } from '../services/chatImages';
import { boolVariation } from '../services/featureFlags';
import type { FlagUser } from '../services/featureFlags';
import { projectSessionAccess, SessionAccessError } from '../services/sessionAccess';
import * as tmux from '../services/tmux';
import { RUN_CHAT_REFUSAL_TEXT, runChatRefusalFor } from '../services/automations/chatGate';

type Result = { status: number; body: unknown };

interface ChatTarget {
  host: { userId: string; instanceId: string | null };
  projectId: string;
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
  ask: { threadId: string; baseSha: string | null; gitName: string; gitEmail: string; sendRefusal: Result | null } | null;
  /** The workstream's agent row, which holds what the chat runs on. */
  workflowId: string;
  /** What the chat runs on: the row's backend and model. */
  choice: ChatChoice;
  /** The owner, whose flags and box a Fireworks turn runs under. */
  ownerId: string;
  /** Started with "Act as an orchestrator" (never an ask's chat). */
  orchestrator: boolean;
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
              askThread: { select: { id: true, workstream: true, baseSha: true, originUser: { select: { displayName: true, unixUsername: true, googleEmail: true } } } },
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
  const cwd = tmux.projectDirFor(
    { name: project.name, user: { unixUsername: access.project.ownerUsername }, instance: { hostHome: project.instance?.hostHome ?? null } },
    // An ask chat has no worktree: its clone is made from the checkout the thread asks.
    askThread ? askThread.workstream : wsName,
  );
  // An ask's turns always run trusted (agent/ask-chat.js), so its chat never offers the trust tick.
  const trust: ChatTrust = askThread ? { trusted: true, reason: 'trusted', mode: TRUSTED_MODE } : chatTrust(project);
  // An ask's chat runs on the default backend (agent/ask-chat.js).
  const choice = askThread ? storedChatChoice(null, null) : storedChatChoice(workflow!.backend, workflow!.model);
  return {
    host: access.host, projectId, workstream: wsName, workstreamId: wsId,
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
      sendRefusal: askRefusal,
    } : null,
    workflowId: workflow!.id, choice, ownerId: project.userId,
    orchestrator: !askThread && project.chatOrchestrator === true,
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

function isResult<T extends object>(x: T | Result): x is Result {
  return 'status' in x && 'body' in x;
}

function rpcError(err: unknown): Result {
  return chatRpcFailure(err instanceof Error ? err.message : String(err));
}

export async function chatHistoryFor(userId: string, projectId: string, query: Request['query'], ldUser?: FlagUser): Promise<Result> {
  const target = await chatTarget(userId, projectId, query.workstream);
  if (isResult(target)) return target;
  try {
    // paneProbe tells the runner what the agent pane is actually doing.
    // resumeQueue is the same bit an older agent reads (it has no paneProbe):
    // a live chat may continue a queue parked across an agent restart, and a
    // Claude in the pane may not. A miss is not "Claude left" — the runner
    // keeps a claim from Open in full UI until a probe has seen Claude and
    // then a shell (agent/chat-runner.js nextPaneClaim).
    const fg = target.ask ? null : await readPane(target);
    const probe = fg ? probeFromForeground(fg) : null;
    // Only a live Claude or a shell/dead pane: a miss is omitted, not false.
    const terminalHolds = fg ? historyTerminalHolds(fg) : undefined;
    const data = await sendForProject(target.host, 'chat-history', {
      chatKey: target.chatKey, cwd: target.cwd, requireCheckout: target.requireCheckout,
      resumeQueue: probe !== 'claude', ...(probe ? { paneProbe: probe } : {}),
    }, 15_000) as { running?: boolean };
    // No turn runs on the box, so a status still stuck `working` (a reconnect
    // around turn-end, an agent that died mid-turn) is stale: settle it.
    if (data.running === false) reconcileChatStatus(target.sessionName, target.instanceId);
    // The running turn's liveInput says it reads messages; sendsLive, whether this viewer's would go in.
    const sendsLive = !target.ask && chatSendsLive(target.agentCapabilities, ldUser ? await boolVariation(CHAT_LIVE_INPUT_FLAG, ldUser, false) : false);
    // Whether this viewer's composer offers images: the flag travels here, not through the browser's bootstrap.
    const imageInput = chatImageInput(ldUser ? await boolVariation(CHAT_IMAGE_INPUT_FLAG, ldUser, false) : false, target.agentCapabilities);
    // An agent from before the check reports nothing: its checkout counts as there.
    return {
      status: 200,
      body: {
        chatKey: target.chatKey, workstream: target.workstream, checkoutReady: true, ...data, sendsLive, imageInput,
        stopsTurn: chatStopsTurn(target.agentCapabilities), trust: target.trust, canTrust: target.isOwner && !target.ask,
        model: await reportedModel(target),
        ...(target.choice.backend ? { backend: target.choice.backend } : {}),
        ...(terminalHolds !== undefined ? { terminalHolds } : {}),
      },
    };
  } catch (err) { return rpcError(err); }
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

export async function chatSendFor(userId: string, projectId: string, body: Record<string, unknown>, ldUser?: FlagUser): Promise<Result> {
  const images = checkChatImages(body.images);
  if (!images.ok) return { status: images.status, body: { error: images.error, code: images.code } };
  const textError = chatTextError(body.text, images.images.length > 0);
  if (textError) return { status: 400, body: { error: textError } };
  const found = await chatTarget(userId, projectId, body.workstream);
  if (isResult(found)) return found;
  const turn = await turnTarget(found, { model: body.model, backend: body.backend }, ldUser);
  if (isResult(turn)) return turn;
  const { target } = turn;
  // Whoever may send this chat a message (owner or share, chatTarget) may send it an image.
  const imageRefusal = chatImagesRefusal(
    images.images.length,
    images.images.length > 0 && ldUser ? await boolVariation(CHAT_IMAGE_INPUT_FLAG, ldUser, false) : false,
    target.agentCapabilities,
  );
  if (imageRefusal) return { status: imageRefusal.status, body: { error: imageRefusal.error, code: imageRefusal.code } };
  // An automation run's brief is its only turn while the run is live (services/automations/chatGate.ts).
  const runRefusal = await runChatRefusalFor(projectId, target.workstreamId, target.workstream);
  if (runRefusal) return { status: 409, body: { error: RUN_CHAT_REFUSAL_TEXT[runRefusal], code: runRefusal } };
  if (target.ask?.sendRefusal) return target.ask.sendRefusal;
  try {
    // An ask's chat has no agent pane: its session lives in the thread's clone (agent/ask-chat.js).
    if (target.ask) {
      const { sendRefusal: _refusal, ...ask } = target.ask;
      const payload = { ...chatSendRpcPayload(target, body.text as string, target.agentCapabilities, { liveInput: false, images: images.images }), ask };
      const sent = await sendForProject(target.host, 'chat-send', payload, images.images.length > 0 ? CHAT_IMAGE_SEND_TIMEOUT_MS : undefined);
      await turn.save();
      return { status: 202, body: sent };
    }
    const liveInput = ldUser ? await boolVariation(CHAT_LIVE_INPUT_FLAG, ldUser, false) : false;
    const titles = ldUser ? await boolVariation(SESSION_TITLES_FLAG, ldUser, false) : false;
    // Under the pane's lock, so it waits out a resume that is still bringing
    // its Claude up instead of probing the shell it was typed into.
    const r = await withPaneLock(paneLockKey(target.instanceId, target.paneSession), () => sendUnlessTerminalHolds(
      () => readPane(target),
      probe => sendForProject(target.host, 'chat-send', {
        ...chatSendRpcPayload(target, body.text as string, target.agentCapabilities, { liveInput, images: images.images, titles }),
        paneProbe: probe,
      }, images.images.length > 0 ? CHAT_IMAGE_SEND_TIMEOUT_MS : undefined),
    ));
    if (r.held) return TERMINAL_HOLDS_ANSWER;
    await turn.save();
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
  if (hasDraft) {
    const imageRefusal = chatImagesRefusal(
      images.images.length,
      images.images.length > 0 && ldUser ? await boolVariation(CHAT_IMAGE_INPUT_FLAG, ldUser, false) : false,
      target.agentCapabilities,
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
      const sent = await sendUnlessTerminalHolds(
        () => readPane(target),
        probe => sendForProject(target.host, 'chat-send', {
          ...chatSendRpcPayload(target, text, target.agentCapabilities, { liveInput, images: images.images, titles }),
          paneProbe: probe,
        }, images.images.length > 0 ? CHAT_IMAGE_SEND_TIMEOUT_MS : undefined),
      );
      if (sent.held) return TERMINAL_HOLDS_ANSWER;
      await turn.save();
      return reclaimAnswer(outcome, sent.result as Record<string, unknown>);
    });
  } catch (err) { return rpcError(err); }
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
