/**
 * The simple UI's chat lifecycle (services/chatLifecycle.ts), on the existing
 * project archive and box power paths:
 *
 *   GET    /api/chats/archived       the owner's archived chats, with their box
 *   POST   /api/chats/:id/archive    archive the chat, stop (or hibernate) its box
 *   POST   /api/chats/:id/reopen     start the box again; unarchive only once
 *                                    a connected chat-clear has dropped the
 *                                    parked turn. Until then the row stays
 *                                    archived, so hello's chat-recover drops
 *                                    it and chat-history cannot resumeQueue.
 *   DELETE /api/chats/:id            { confirmed: true }: from the archive only.
 *                                    The box is terminated, and the history on
 *                                    it goes, only when this chat is the last
 *                                    project on it. A shared box stays. The
 *                                    archived list reports `otherProjects` so
 *                                    the confirm says which of those happens.
 *
 * A chat is a project whose agent runs in the chat runner (claude-chat). The
 * archive keeps its workflow rows, so an archived chat is still one. Owner
 * only, like the project archive and the box routes.
 *
 * A running turn is stopped by the same revoke the project archive, workstream
 * delete, and box terminate use (`revokeChats` / `clearChatsOnBox`, key
 * `projectId--workstreamId`). Archive goes through `archiveOwnedProject`, which
 * revokes before the row is archived. Permanent delete revokes this chat the
 * same way, then `terminateOwnedBox`, only when this chat is the last project
 * on the box. There is no other clear. A connected box
 * that does not confirm the turn stopped fails that revoke, and the archive
 * or delete stops there.
 */
import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { isChatRunnerProvider } from '../providers/registry';
import { isProjectAgentConnected, sendForProject } from '../services/agentRegistry';
import { ensureAgentSessionsAndLaunch } from '../services/agentRuntime';
import { isBoxProvisioningConfigured } from '../services/boxProvisioner';
import { revokeChats } from '../services/chatRevoke';
import { archivePowerFor, deleteTerminatesBox, otherProjectsFromTotal, reopenPlanFor, reopenRelease } from '../services/chatLifecycle';
import { powerOwnedBox, terminateOwnedBox } from './instances';
import { relaunchChatOrRestore } from './chatReopen';
import { archiveOwnedProject, ensureDataSessions } from './projects';
import { sendResult, type RouteResult } from './routeResult';

const BOX_SELECT = { id: true, name: true, kind: true, status: true, hibernationConfigured: true } as const;

async function ownedChat(userId: string, id: string) {
  const project = await prisma.project.findFirst({
    where: { id, userId },
    include: {
      instance: { select: BOX_SELECT },
      workstreams: { select: { id: true } },
      workflows: { include: { workstream: { select: { id: true, name: true } } } },
    },
  });
  if (!project) return null;
  return project.workflows.some(w => w.type === 'agent' && isChatRunnerProvider(w.provider)) ? project : null;
}

export async function archivedChatsFor(userId: string): Promise<RouteResult> {
  const rows = await prisma.project.findMany({
    where: { userId, archived: true, workflows: { some: { type: 'agent', provider: { not: null } } } },
    include: { instance: { select: BOX_SELECT }, workflows: { select: { type: true, provider: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  const chats = rows
    .filter(p => p.workflows.some(w => w.type === 'agent' && isChatRunnerProvider(w.provider)))
    .map(p => ({ id: p.id, name: p.name, repoUrl: p.repoUrl, archivedAt: p.updatedAt, box: p.instance }));
  // Same count deleteChatFor uses: every other project on the box, archived
  // ones included. The confirm copies this, so it does not claim a shared
  // box is terminated.
  const instanceIds = [...new Set(chats.flatMap(c => (c.box ? [c.box.id] : [])))];
  const totals = instanceIds.length === 0 ? [] : await prisma.project.groupBy({
    by: ['instanceId'],
    where: { instanceId: { in: instanceIds } },
    _count: true,
  });
  const onBox = new Map(totals.flatMap(row => (row.instanceId ? [[row.instanceId, row._count] as const] : [])));
  return {
    status: 200,
    body: chats.map(c => ({
      ...c,
      otherProjects: c.box ? otherProjectsFromTotal(onBox.get(c.box.id) ?? 1) : 0,
    })),
  };
}

export async function archiveChatFor(user: Express.User, id: string): Promise<RouteResult> {
  const chat = await ownedChat(user.id, id);
  if (!chat) return { status: 404, body: { error: 'Chat not found' } };
  if (chat.archived) return { status: 409, body: { error: 'This chat is archived already' } };
  // revokeChats runs inside archiveOwnedProject, before the row is archived.
  // A connected box that leaves the turn running comes back as 409; the box
  // is not stopped.
  const archived = await archiveOwnedProject(user, id, { keepWorkflows: true });
  if (archived.status !== 200) return archived;

  const others = chat.instance
    ? await prisma.project.count({ where: { instanceId: chat.instance.id, archived: false, id: { not: id } } })
    : 0;
  const power = archivePowerFor(chat.instance, others);
  if (!power.action) return { status: 200, body: { archived: true, box: { action: null, reason: power.reason } } };
  // The chat is archived either way; a box that would not go down says why.
  const powered = await powerOwnedBox(user, chat.instance!.id, power.action);
  const box = powered.status === 202
    ? { action: power.action, status: (powered.body as { status?: string }).status ?? null }
    : { action: power.action, error: (powered.body as { error?: string }).error ?? 'The box did not stop' };
  return { status: 200, body: { archived: true, box } };
}

export async function reopenChatFor(user: Express.User, id: string): Promise<RouteResult> {
  const chat = await ownedChat(user.id, id);
  if (!chat) return { status: 404, body: { error: 'Chat not found' } };
  if (!chat.archived) return { status: 200, body: { reopened: true, box: chat.instance } };
  const plan = reopenPlanFor(chat.instance);
  if ('refused' in plan) return { status: plan.refused.status, body: { error: plan.refused.error } };
  if (plan.start) {
    // Start first: a box EC2 will not start leaves the chat in the archive.
    const started = await powerOwnedBox(user, chat.instance!.id, 'start');
    if (started.status !== 202) return started;
  }
  // The row stays archived until a connected chat-clear drops the queue and
  // any turn still alive. An offline revoke fail-opens, so unarchiving here
  // would let the next hello park that queue and chat-history resume it.
  // A stopped instance's turn is already closed as died; recover drops the
  // leftover queue because the row is still archived. No separate kill.
  const host = { userId: user.id, instanceId: chat.instanceId };
  const connected = isProjectAgentConnected(host);
  const blocked = connected
    ? await revokeChats(
      (type, payload) => sendForProject(host, type, payload),
      true,
      chat.id,
      chat.workstreams.map(w => w.id),
    )
    : null;
  const release = reopenRelease(connected, blocked);
  const boxNow = () => chat.instance
    ? prisma.instance.findUnique({ where: { id: chat.instance!.id }, select: BOX_SELECT })
    : Promise.resolve(null);
  if (!release.unarchive) {
    if ('pending' in release) return { status: 200, body: { reopened: false, pending: true, box: await boxNow() } };
    return { status: 409, body: { error: release.error } };
  }
  await prisma.project.update({ where: { id }, data: { archived: false } });
  // A box that is already up gets every leftover workflow's panes back now,
  // the same plan as a project un-archive. A box we just started gets them
  // when its agent connects (reconstructInstanceSessions). A launch that
  // throws puts the row back in the archive so it is not live with no panes.
  if (!plan.start && connected) {
    const home = chat.instanceId
      ? await prisma.instance.findUnique({ where: { id: chat.instanceId }, select: { hostHome: true } })
      : null;
    const relaunched = await relaunchChatOrRestore({
      workflows: chat.workflows.map(w => ({
        type: w.type, provider: w.provider, workstream: w.workstream.name,
      })),
      launchAgent: wf => ensureAgentSessionsAndLaunch({
        userId: user.id,
        unixUsername: user.unixUsername,
        projectName: chat.name,
        provider: wf.provider ?? 'claude-chat',
        instanceId: chat.instanceId,
        workstream: wf.workstream,
        hostHome: home?.hostHome ?? null,
      }),
      launchData: wf => ensureDataSessions(
        host, user.unixUsername, chat.name, wf.workstream, home?.hostHome ?? null,
      ),
      restore: () => prisma.project.update({ where: { id }, data: { archived: true } }),
    });
    if (!relaunched.ok) return { status: 503, body: { error: relaunched.error } };
  }
  const box = chat.instance ? await prisma.instance.findUnique({ where: { id: chat.instance.id }, select: BOX_SELECT }) : null;
  return { status: 200, body: { reopened: true, box } };
}

export async function deleteChatFor(user: Express.User, id: string, confirmed: boolean): Promise<RouteResult> {
  const chat = await ownedChat(user.id, id);
  if (!chat) return { status: 404, body: { error: 'Chat not found' } };
  if (!chat.archived) return { status: 409, body: { error: 'Archive the chat first; deleting is done from the archive' } };
  if (!confirmed) return { status: 409, body: { error: 'Deleting a chat terminates its box and its history goes too', hint: 'Re-send with { "confirmed": true }' } };
  if (chat.instance) {
    const others = await prisma.project.count({ where: { instanceId: chat.instance.id, id: { not: id } } });
    if (deleteTerminatesBox(chat.instance, others)) {
      // The chat is already archived, so terminateOwnedBox's revoke (live
      // projects only) does not see it. Same revoke, same key, before the box
      // goes: a connected box that leaves the turn running fails the delete.
      // An offline host that will not be destroyed fails too; an EC2 terminate
      // may proceed offline, because the instance is destroyed.
      const host = { userId: user.id, instanceId: chat.instanceId };
      const destroysHost = chat.instance.kind !== 'external' && isBoxProvisioningConfigured();
      const blocked = await revokeChats(
        (type, payload) => sendForProject(host, type, payload),
        isProjectAgentConnected(host),
        chat.id,
        chat.workstreams.map(w => w.id),
        { offlineBlocks: !destroysHost },
      );
      if (blocked) return { status: 409, body: { error: blocked } };
      const terminated = await terminateOwnedBox(user, chat.instance.id, true);
      if (terminated.status !== 200) return terminated;
    }
  }
  await prisma.project.delete({ where: { id } });
  return { status: 200, body: { deleted: true } };
}

export function chatsRouter(): Router {
  const router = Router();
  router.get('/archived', requireAuth, asyncHandler(async (req, res) => sendResult(res, await archivedChatsFor(req.user!.id))));
  router.post('/:id/archive', requireAuth, asyncHandler(async (req, res) => sendResult(res, await archiveChatFor(req.user!, req.params.id))));
  router.post('/:id/reopen', requireAuth, asyncHandler(async (req, res) => sendResult(res, await reopenChatFor(req.user!, req.params.id))));
  router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
    sendResult(res, await deleteChatFor(req.user!, req.params.id, (req.body as { confirmed?: unknown })?.confirmed === true));
  }));
  return router;
}
