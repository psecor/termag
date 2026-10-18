/**
 * The collaboration reply nudge: when a
 * colleague has replied to a request an agent drafted, and that agent's pane
 * is idle, type one fixed line into it saying to read slack_inbox. Leader
 * work, every 10 s, the same rules and shape as the spawn nudge
 * (agentSpawnSweep.ts). The reply text itself is never typed into a pane.
 */
import { prisma } from '../db';
import { collabNudgeDecision, collabNudgeLine } from './collab';
import { isProjectAgentConnected, sendForProject } from './agentRegistry';
import { lastHumanHeartbeat } from './humanActivity';
import { getStatus } from './status';
import * as tmux from './tmux';
import { notifyResponse } from '../slack/collab';

const SWEEP_INTERVAL_MS = 10_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

export async function runCollabNudgeTick(now: number = Date.now()): Promise<number> {
  const pending = await prisma.collabResponse.findMany({
    where: { nudgedAt: null, request: { fromSession: { not: null }, projectId: { not: null } } },
    orderBy: { createdAt: 'asc' },
    take: 500,
    include: { request: { select: { id: true, userId: true, projectId: true, workstream: true, fromRole: true } } },
  });
  // One line per request, however many replies arrived since the last one.
  const byRequest = new Map<string, typeof pending>();
  for (const r of pending) {
    const list = byRequest.get(r.requestId) ?? [];
    list.push(r);
    byRequest.set(r.requestId, list);
  }
  let nudged = 0;
  for (const [requestId, replies] of byRequest) {
    const req = replies[0].request;
    const project = await prisma.project.findFirst({
      where: { id: req.projectId!, userId: req.userId, archived: false },
      select: { name: true, instanceId: true, user: { select: { unixUsername: true } } },
    });
    // Rebuilt rather than read back, so a renamed project is still found.
    const session = project
      ? tmux.sessionName(project.user.unixUsername, project.name, (req.fromRole ?? 'agent') as Parameters<typeof tmux.sessionName>[2], req.workstream ?? 'main')
      : null;
    const host = { userId: req.userId, instanceId: project?.instanceId ?? null };
    const latest = replies[replies.length - 1];
    const decision = project && session
      ? collabNudgeDecision({
        fromRole: req.fromRole,
        fromSession: session,
        replyAt: latest.createdAt,
        sessionStatus: getStatus(session, project.instanceId).status,
        sessionConnected: isProjectAgentConnected(host),
        humanLastTyped: lastHumanHeartbeat(project.user.unixUsername, project.name, project.instanceId),
        now,
      })
      : 'skip';
    if (decision === 'wait') continue;
    // Claim first, so an overlapping process never types the line twice.
    const claimed = await prisma.collabResponse.updateMany({
      where: { id: { in: replies.map(r => r.id) }, nudgedAt: null },
      data: { nudgedAt: new Date(now) },
    });
    if (claimed.count === 0 || decision === 'skip' || !session) continue;
    try {
      await sendForProject(host, 'tmux-send-keys', { sessionName: session, keys: collabNudgeLine(requestId, claimed.count), withEnter: true, literal: true }, 5000);
      nudged++;
      console.log(`[COLLAB] nudged ${session}: ${claimed.count} repl${claimed.count === 1 ? 'y' : 'ies'} to ${requestId}`);
    } catch (err) {
      console.warn(`[COLLAB] nudge of ${session} failed (${requestId}):`, (err as Error).message);
    }
  }
  return nudged;
}

/** How long a reply DM that failed is retried. */
const NOTIFY_RETRY_MS = 30 * 60 * 1000;

/**
 * Retry the sender's DM for replies whose live notice failed (notifiedAt
 * still null). Past its first minute, so the live call is not raced.
 */
export async function runCollabNotifyRetryTick(now: number = Date.now()): Promise<number> {
  const rows = await prisma.collabResponse.findMany({
    where: { notifiedAt: null, createdAt: { gt: new Date(now - NOTIFY_RETRY_MS), lt: new Date(now - 60_000) } },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: { id: true },
  });
  let sent = 0;
  for (const r of rows) if (await notifyResponse(r.id)) sent++;
  return sent;
}

export function startCollabNudgeSweep(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runCollabNudgeTick()
      .then(() => runCollabNotifyRetryTick())
      .catch(err => console.error('[COLLAB] nudge sweep failed:', (err as Error).message))
      .finally(() => { running = false; });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopCollabNudgeSweep(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
