/**
 * On every agent hello, ask which chats it would take up and tell it to drop
 * the ones whose project is archived or whose workstream is gone. The agent
 * holds sends and polling until this answers, including across a reconnect:
 * an offline box is not covered by parking a queue at process start.
 *
 * A warm box's hello has no user, so it does not sweep. Claiming one rebinds
 * the socket in place and re-fires these listeners (notifyInstanceClaimed);
 * that is the hello the gate was waiting for. A sweep that cannot classify
 * the keys does not send chat-recover, so the gate stays shut. Recovering
 * every key would resume an archived chat.
 */
import { prisma } from '../db';
import { onAgentHello, sendToAgent, sendToInstanceAgent } from './agentRegistry';
import { ChatKeyRow, deadChatKeys } from './chatRevoke';

const DURABLE = 'chat-durable-v1';
const SWEEP_TIMEOUT_MS = 15_000;

function parseKeys(raw: unknown): ChatKeyRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatKeyRow[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.chatKey !== 'string' || typeof r.projectId !== 'string' || typeof r.workstreamId !== 'string') continue;
    out.push({ chatKey: r.chatKey, projectId: r.projectId, workstreamId: r.workstreamId });
  }
  return out;
}

export async function sweepChatsOnHello(ev: {
  userId: string | null;
  instanceId: string | null;
  capabilities: readonly string[];
}): Promise<void> {
  if (!ev.userId || !ev.capabilities.includes(DURABLE)) return;
  const send = (type: string, payload: Record<string, unknown>) => ev.instanceId
    ? sendToInstanceAgent(ev.instanceId, type, payload, SWEEP_TIMEOUT_MS)
    : sendToAgent(ev.userId!, type, payload, SWEEP_TIMEOUT_MS);
  const swept = await send('chat-sweep', {}) as { keys?: unknown };
  const keys = parseKeys(swept?.keys);
  const projectIds = [...new Set(keys.map(k => k.projectId).filter(Boolean))];
  const projects = projectIds.length
    ? await prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, archived: true, workstreams: { select: { id: true, archived: true } } },
    })
    : [];
  await send('chat-recover', { deadKeys: deadChatKeys(projects, keys) });
}

/** Every process: a box's hello, including the one a claim re-fires, arrives on whichever process holds its socket. */
export function startChatGate(): () => void {
  return onAgentHello(ev => {
    sweepChatsOnHello(ev).catch(err => {
      console.error(`[CHAT] recover sweep for ${ev.instanceId ?? ev.userId} failed:`, (err as Error).message);
    });
  });
}
