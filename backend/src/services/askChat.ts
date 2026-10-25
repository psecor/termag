/**
 * An ask thread's chat on its target project. A thread run on a box with ask-chat-v1 gets a workstream
 * of its own, `ask-<thread>`, with a claude-chat agent workflow: the simple
 * UI lists it beside the project's other chats and opens it like one. It
 * has no git worktree; its turns run in the thread's clone on the box
 * (agent/ask-chat.js), so the paths that manage worktrees and panes skip it
 * (isAskChatWorkstream).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { askChatWorkstreamName } from './agentMessages';
import { chatKeyFor } from './chatRunner';

export const ASK_CHAT_PROVIDER = 'claude-chat';
/** The clone's branch (deploy/termag-subagent-run); never a branch of the project's checkout. */
const ASK_CHAT_BRANCH = 'ask';

export interface AskChat { chatKey: string; projectId: string; workstream: string; workstreamId: string }

/** The thread's chat, made on its first run there. Safe against two first runs at once. */
export async function ensureAskChat(thread: { id: string; projectId: string; chatWorkstreamId: string | null }): Promise<AskChat> {
  const name = askChatWorkstreamName(thread.id);
  let ws = thread.chatWorkstreamId
    ? await prisma.workstream.findUnique({ where: { id: thread.chatWorkstreamId }, select: { id: true, name: true } })
    : null;
  if (!ws) {
    try {
      ws = await prisma.workstream.create({
        data: {
          projectId: thread.projectId, name, branch: ASK_CHAT_BRANCH,
          workflows: { create: { type: 'agent', provider: ASK_CHAT_PROVIDER, projectId: thread.projectId } },
        },
        select: { id: true, name: true },
      });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      ws = await prisma.workstream.findUniqueOrThrow({ where: { projectId_name: { projectId: thread.projectId, name } }, select: { id: true, name: true } });
    }
    await prisma.agentThread.update({ where: { id: thread.id }, data: { chatWorkstreamId: ws.id } });
  }
  return { chatKey: chatKeyFor(thread.projectId, ws.id), projectId: thread.projectId, workstream: ws.name, workstreamId: ws.id };
}

/** Workstreams that are ask chats, among these ids: they have no worktree and no pane. */
export async function askChatWorkstreamIds(workstreamIds: readonly string[]): Promise<Set<string>> {
  if (!workstreamIds.length) return new Set();
  const rows = await prisma.agentThread.findMany({
    where: { chatWorkstreamId: { in: [...workstreamIds] } },
    select: { chatWorkstreamId: true },
  });
  return new Set(rows.map(r => r.chatWorkstreamId!).filter(Boolean));
}

export async function isAskChatWorkstream(workstreamId: string): Promise<boolean> {
  return (await askChatWorkstreamIds([workstreamId])).has(workstreamId);
}
