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
import { askModelOf, type AskModel } from './askModel';
import { chatTurnChoice, defaultLaunchTier, parseClaudeChatModel, storedChatChoice, type ChatChoice, type ClaudeChatTier } from './claudeChatModel';

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
 * What an ask's turn in the thread's chat runs on
 * : `requested` (`termag ask --model`, a tier or a
 * Fireworks model already resolved to its full id), which becomes the chat's
 * stored choice from this turn on as a chat send's does (chatTurnChoice),
 * else the choice the chat has stored (an earlier --model, or a pick in the
 * simple UI), else null: no `--model`, so the turn runs on the box's default,
 * as asks always have. `stored` is what the chat had, for a caller that must
 * refuse a stored Fireworks choice it cannot run rather than drop it.
 */
export async function askTurnChoice(workstreamId: string, requested: ChatChoice | null): Promise<{ choice: ChatChoice | null; stored: ChatChoice | null; save: () => Promise<void> }> {
  const wf = await prisma.workflow.findFirst({ where: { workstreamId, type: 'agent' }, select: { id: true, backend: true, model: true } });
  const had = storedChatChoice(wf?.backend, wf?.model);
  const stored = had.backend || had.model ? had : null;
  // The requested Fireworks id was checked against the asker's and box's list already (askService resolveFireworksAskModel).
  const fireworks = requested?.backend === 'fireworks' && requested.model ? { models: [{ id: requested.model, label: requested.model, context: null }], defaultModel: requested.model, fastModel: requested.model } : null;
  const turn = chatTurnChoice(had, requested ? { model: requested.model, ...(requested.backend ? { backend: requested.backend } : {}) } : {}, fireworks);
  if (!turn.ok) return { choice: null, stored, save: async () => {} };
  const choice = turn.choice.backend || turn.choice.model ? turn.choice : null;
  return {
    choice,
    stored,
    // Run only once the box took the turn, as a chat send saves its choice only once the send went in.
    save: async () => {
      if (turn.changed && wf) await prisma.workflow.update({ where: { id: wf.id }, data: { backend: turn.choice.backend, model: turn.choice.model } });
    },
  };
}

/** The Claude tier askTurnChoice settles, for callers that only run tiers: null for none or a Fireworks choice. */
export async function askTurnTier(workstreamId: string, requested: ClaudeChatTier | null): Promise<{ tier: ClaudeChatTier | null; save: () => Promise<void> }> {
  const { choice, save } = await askTurnChoice(workstreamId, requested ? { backend: null, model: requested } : null);
  const tier = choice && !choice.backend ? parseClaudeChatModel(choice.model) : null;
  return { tier: tier?.ok ? tier.model : null, save };
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

/**
 * What the thread's chat has stored, read only, as an ask model
 * (services/askModel.ts): a tier, or `fireworks:<id>`; null for none, or no
 * chat yet.
 */
export async function askChatStoredModel(workstreamId: string | null): Promise<AskModel | null> {
  if (!workstreamId) return null;
  const wf = await prisma.workflow.findFirst({ where: { workstreamId, type: 'agent' }, select: { backend: true, model: true } });
  return askModelOf(storedChatChoice(wf?.backend, wf?.model));
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
