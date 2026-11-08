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
import { chatTurnChoice, defaultLaunchTier, parseClaudeChatModel, storedChatChoice, type ClaudeChatTier } from './claudeChatModel';

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

/**
 * The Claude tier an ask's turn in the thread's chat runs on:
 * `requested`
 * (`termag ask --model`), which becomes the chat's stored choice from this
 * turn on as a chat send's model does (chatTurnChoice), else the tier the
 * chat has stored (an earlier --model, or a pick in the simple UI), else null:
 * no `--model`, so the turn runs on the box's default, as asks always have.
 */
export async function askTurnTier(workstreamId: string, requested: ClaudeChatTier | null): Promise<{ tier: ClaudeChatTier | null; save: () => Promise<void> }> {
  const wf = await prisma.workflow.findFirst({ where: { workstreamId, type: 'agent' }, select: { id: true, model: true } });
  const turn = chatTurnChoice(storedChatChoice(null, wf?.model), requested ? { model: requested } : {}, null);
  if (!turn.ok) return { tier: null, save: async () => {} };
  const tier = parseClaudeChatModel(turn.choice.model);
  return {
    tier: tier.ok ? tier.model : null,
    // Run only once the box took the turn, as a chat send saves its choice only once the send went in.
    save: async () => {
      if (turn.changed && wf) await prisma.workflow.update({ where: { id: wf.id }, data: { backend: null, model: turn.choice.model } });
    },
  };
}

/**
 * The model an ask's chat reports to the simple UI's picker (routes/chat.ts):
 * the tier it keeps, else the box's default (defaultLaunchTier), which its ask
 * turns, naming no `--model`, ran on. A person's message there names none
 * either (routes/chat.ts turnTarget), so it runs where they did even on a box
 * that skipped the gateway, whose default the orchestrator cannot see.
 */
export function askReportedTier(tier: string | null | undefined, ownerOnGateway: boolean, env: NodeJS.ProcessEnv = process.env): ClaudeChatTier {
  const parsed = parseClaudeChatModel(storedChatChoice(null, tier).model);
  return (parsed.ok ? parsed.model : null) ?? defaultLaunchTier(ownerOnGateway, env);
}

/** The tier the thread's chat has stored, read only: null for none, or no chat yet. */
export async function askChatStoredTier(workstreamId: string | null): Promise<ClaudeChatTier | null> {
  if (!workstreamId) return null;
  const wf = await prisma.workflow.findFirst({ where: { workstreamId, type: 'agent' }, select: { model: true } });
  const tier = parseClaudeChatModel(storedChatChoice(null, wf?.model).model);
  return tier.ok ? tier.model : null;
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
