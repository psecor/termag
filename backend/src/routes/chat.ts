/**
 * The simple UI's chat on a chat-runner project (services/chatRunner.ts):
 *
 *   GET  /api/projects/:id/chat?workstream=      session id, running, history
 *   POST /api/projects/:id/chat/messages         { workstream, text }
 *   POST /api/projects/:id/chat/interrupt        { workstream }
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
import { chatKeyFor, chatRequireCheckout, chatRpcFailure, chatTargetError, chatTextError, reconcileChatStatus } from '../services/chatRunner';
import { projectSessionAccess, SessionAccessError } from '../services/sessionAccess';
import * as tmux from '../services/tmux';

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
      name: true, setupStatus: true, repoUrl: true,
      instance: { select: { hostHome: true } },
      workflows: { where: { type: 'agent' }, select: { provider: true, workstream: { select: { id: true, name: true } } } },
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
  const cwd = tmux.projectDirFor(
    { name: project.name, user: { unixUsername: access.project.ownerUsername }, instance: { hostHome: project.instance?.hostHome ?? null } },
    wsName,
  );
  return {
    host: access.host, projectId, workstream: wsName, workstreamId: wsId,
    chatKey: chatKeyFor(projectId, wsId), cwd,
    sessionName: tmux.sessionName(access.project.ownerUsername, project.name, 'agent', wsName),
    instanceId: access.host.instanceId,
    requireCheckout: chatRequireCheckout(project),
  };
}

function isResult(x: ChatTarget | Result): x is Result {
  return 'status' in x && 'body' in x;
}

function rpcError(err: unknown): Result {
  return chatRpcFailure(err instanceof Error ? err.message : String(err));
}

export async function chatHistoryFor(userId: string, projectId: string, query: Request['query']): Promise<Result> {
  const target = await chatTarget(userId, projectId, query.workstream);
  if (isResult(target)) return target;
  try {
    // resumeQueue: this route answers only for a live chat (not archived, set
    // up, its box connected), so a queue the box parked across an agent
    // restart may go on.
    const data = await sendForProject(target.host, 'chat-history', { chatKey: target.chatKey, cwd: target.cwd, requireCheckout: target.requireCheckout, resumeQueue: true }, 15_000) as { running?: boolean };
    // No turn runs on the box, so a status still stuck `working` (a reconnect
    // around turn-end, an agent that died mid-turn) is stale: settle it.
    if (data.running === false) reconcileChatStatus(target.sessionName, target.instanceId);
    // An agent from before the check reports nothing: its checkout counts as there.
    return { status: 200, body: { chatKey: target.chatKey, workstream: target.workstream, checkoutReady: true, ...data } };
  } catch (err) { return rpcError(err); }
}

export async function chatSendFor(userId: string, projectId: string, body: Record<string, unknown>): Promise<Result> {
  const textError = chatTextError(body.text);
  if (textError) return { status: 400, body: { error: textError } };
  const target = await chatTarget(userId, projectId, body.workstream);
  if (isResult(target)) return target;
  try {
    const data = await sendForProject(target.host, 'chat-send', {
      chatKey: target.chatKey, cwd: target.cwd, text: body.text, projectId: target.projectId,
      workstream: target.workstream, workstreamId: target.workstreamId,
      requireCheckout: target.requireCheckout,
    });
    return { status: 202, body: data };
  } catch (err) { return rpcError(err); }
}

export async function chatInterruptFor(userId: string, projectId: string, body: Record<string, unknown>): Promise<Result> {
  const target = await chatTarget(userId, projectId, body.workstream);
  if (isResult(target)) return target;
  try {
    return { status: 200, body: await sendForProject(target.host, 'chat-interrupt', { chatKey: target.chatKey }) };
  } catch (err) { return rpcError(err); }
}

export function chatRouter(): Router {
  const router = Router();
  router.get('/:id/chat', requireAuth, asyncHandler(async (req, res) => {
    const r = await chatHistoryFor(req.user!.id, req.params.id, req.query);
    res.status(r.status).json(r.body);
  }));
  router.post('/:id/chat/messages', requireAuth, asyncHandler(async (req, res) => {
    const r = await chatSendFor(req.user!.id, req.params.id, req.body ?? {});
    res.status(r.status).json(r.body);
  }));
  router.post('/:id/chat/interrupt', requireAuth, asyncHandler(async (req, res) => {
    const r = await chatInterruptFor(req.user!.id, req.params.id, req.body ?? {});
    res.status(r.status).json(r.body);
  }));
  return router;
}
