/**
 * The ask finish notice:
 * leader work, every 5 s. For each finished message whose sender session was
 * recorded (AgentMessage.notifyVia) and that nobody has told yet, decide with
 * noticeDecision (askNotice.ts) and either put one fixed notice into that
 * session or settle it as kept in the inbox only. A chat gets the notice as a
 * new turn through the chat send path (routes/chat.ts sendAskNotice, which
 * index.ts hands in); a pane gets it typed, like the spawn nudge
 * (agentSpawnSweep.ts). Claimed with updateMany on notifiedAt first, so two
 * processes never deliver one twice.
 */
import { prisma } from '../db';
import { ASK_NOTICE_FLAG, NOTICE_GIVE_UP_MS, NOTICE_GRACE_MS, askNoticeText, noticeDecision, type NoticeItem, type NoticeOutcome, type NoticeVia } from './askNotice';
import { isProjectAgentConnected, sendForProject } from './agentRegistry';
import { threadPrs } from './agentMessages';
import { NUDGE_HUMAN_QUIET_MS } from './agentSpawn';
import { lastHumanHeartbeat } from './humanActivity';
import { classifyForeground } from './foregroundProbe';
import { boolVariation } from './featureFlags';
import type { FlagUser } from './featureFlags';
import { getStatus } from './status';
import * as tmux from './tmux';

const SWEEP_INTERVAL_MS = 5_000;
const PAGE = 200;
/** Steps followed from a superseded message to the follow-up whose turn finished it (the ask poll's walk, askService.ts). */
const MAX_CHAIN = 50;

/** Sends a notice as a turn of a chat, as its owner, never into a running turn. */
export type ChatNoticeSender = (n: { userId: string; projectId: string; workstream: string; text: string }) =>
  Promise<{ kind: 'sent' } | { kind: 'not-ready' } | { kind: 'refused'; error: string }>;

let chatSender: ChatNoticeSender | null = null;

/** routes/chat.ts's sender, handed in by index.ts (a service can't import a route). */
export function setAskNoticeChatSender(fn: ChatNoticeSender | null): void {
  chatSender = fn;
}

const FINISHED = ['completed', 'failed', 'canceled', 'superseded'];

const rowSelect = {
  id: true, status: true, error: true, publish: true, replyBytes: true, completedAt: true, supersededById: true,
  senderUserId: true, notifyProjectId: true, notifyWorkstream: true, notifyVia: true,
  thread: {
    select: {
      id: true, title: true, hopCount: true, branch: true, prNumber: true, prUrl: true,
      prs: { select: { key: true, branch: true, prNumber: true, prUrl: true }, orderBy: { createdAt: 'asc' as const } },
    },
  },
} as const;

type Row = NonNullable<Awaited<ReturnType<typeof loadRow>>>;

function loadRow(id: string) {
  return prisma.agentMessage.findUnique({ where: { id }, select: rowSelect });
}

const sameRecipient = (a: Row, b: Row) => a.notifyVia === b.notifyVia
  && a.notifyProjectId === b.notifyProjectId && a.notifyWorkstream === b.notifyWorkstream;

/**
 * The follow-up a superseded message was answered with: `end` once its turn
 * has finished, `running` while it runs, `lost` when the chain can't be
 * followed to one (a follow-up gone, or past MAX_CHAIN).
 */
async function chainEnd(row: Row): Promise<{ kind: 'end'; row: Row } | { kind: 'running' } | { kind: 'lost' }> {
  let m: Row = row;
  for (let i = 0; m.status === 'superseded'; i++) {
    if (!m.supersededById || i >= MAX_CHAIN) return { kind: 'lost' };
    const next = await loadRow(m.supersededById);
    if (!next) return { kind: 'lost' };
    m = next;
  }
  return m.completedAt && FINISHED.includes(m.status) ? { kind: 'end', row: m } : { kind: 'running' };
}

function itemOf(row: Row, end: Row | null): NoticeItem {
  const at = end ?? row;
  // The thread's own PR first, as the ask poll shows them (agentMessages.ts threadPrs).
  const prs = threadPrs(row.thread).map(p => p.url);
  return {
    status: at.status, title: row.thread.title, thread: row.thread.id, message: row.id, error: at.error,
    publish: at.publish, prUrl: prs[0] ?? null, morePrs: Math.max(0, prs.length - 1), replyBytes: at.replyBytes,
    answeredWith: end ? end.id : null,
  };
}

async function settle(ids: string[], notice: NoticeOutcome, now: number): Promise<number> {
  const r = await prisma.agentMessage.updateMany({ where: { id: { in: ids }, notifiedAt: null }, data: { notifiedAt: new Date(now), notice } });
  return r.count;
}

interface Batch {
  via: NoticeVia;
  userId: string;
  projectId: string;
  workstream: string;
  host: { userId: string; instanceId: string | null };
  session: string | null;
  /** Whose typing a pane notice must not land on: re-read just before the keys go. */
  typist: { unixUsername: string; projectName: string; instanceId: string | null } | null;
  items: { id: string; item: NoticeItem }[];
}

export async function runAskNoticeTick(now: number = Date.now()): Promise<number> {
  const rows = await prisma.agentMessage.findMany({
    where: {
      notifyVia: { not: null }, notifiedAt: null, status: { in: FINISHED },
      completedAt: { not: null, lte: new Date(now - NOTICE_GRACE_MS) },
    },
    select: rowSelect,
    orderBy: { completedAt: 'asc' },
    take: PAGE,
  });
  if (!rows.length) return 0;
  const flags = new Map<string, Promise<boolean>>();
  const flagFor = (userId: string, user: FlagUser) => {
    if (!flags.has(userId)) flags.set(userId, boolVariation(ASK_NOTICE_FLAG, user, false));
    return flags.get(userId)!;
  };
  const batches = new Map<string, Batch>();
  for (const row of rows) {
    const via = row.notifyVia as NoticeVia;
    if ((via !== 'chat' && via !== 'pane') || !row.notifyProjectId || !row.notifyWorkstream) {
      await settle([row.id], 'skipped', now);
      continue;
    }
    // A superseded message is told of the turn that finished it, unless that follow-up tells the same session.
    // One whose follow-up has run a day is not told; one whose chain is lost is told of itself.
    let end: Row | null = null;
    if (row.status === 'superseded') {
      const c = await chainEnd(row);
      if (c.kind === 'running') {
        if (now - row.completedAt!.getTime() > NOTICE_GIVE_UP_MS && await settle([row.id], 'expired', now)) {
          console.log(`[ASK] notice for message ${row.id}: expired, kept in the inbox only`);
        }
        continue;
      }
      if (c.kind === 'end') {
        end = c.row;
        if (sameRecipient(row, end)) { await settle([row.id], 'together', now); continue; }
      }
    }
    const project = await prisma.project.findFirst({
      where: { id: row.notifyProjectId, userId: row.senderUserId },
      select: {
        name: true, archived: true, instanceId: true, kind: true,
        user: { select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true } },
        instance: { select: { status: true } },
        workstreams: { where: { name: row.notifyWorkstream }, select: { archived: true, askThread: { select: { id: true } } } },
      },
    });
    const ws = project?.workstreams[0] ?? null;
    const host = { userId: row.senderUserId, instanceId: project?.instanceId ?? null };
    const session = project && via === 'pane' ? tmux.sessionName(project.user.unixUsername, project.name, 'agent', row.notifyWorkstream) : null;
    const decision = noticeDecision({
      via,
      completedAt: (end ?? row).completedAt!,
      now,
      flagOn: project ? await flagFor(row.senderUserId, project.user) : true,
      project: project ? { archived: project.archived, workstreamLive: !!ws && !ws.archived, askChat: !!ws?.askThread, automation: project.kind === 'automation' } : null,
      box: project?.instance ? { status: project.instance.status, connected: isProjectAgentConnected(host) } : null,
      ...(session && project ? {
        paneStatus: getStatus(session, project.instanceId).status,
        humanLastTyped: lastHumanHeartbeat(project.user.unixUsername, project.name, project.instanceId),
      } : {}),
    });
    if (decision === 'wait') continue;
    if (decision !== 'deliver') {
      if (await settle([row.id], decision.settle, now)) {
        console.log(`[ASK] notice for message ${row.id}: ${decision.settle}, kept in the inbox only`);
      }
      continue;
    }
    const key = `${via}\u0000${row.notifyProjectId}\u0000${row.notifyWorkstream}`;
    const batch = batches.get(key) ?? {
      via, userId: row.senderUserId, projectId: row.notifyProjectId, workstream: row.notifyWorkstream, host, session,
      typist: session && project ? { unixUsername: project.user.unixUsername, projectName: project.name, instanceId: project.instanceId } : null,
      items: [],
    };
    batch.items.push({ id: row.id, item: itemOf(row, end) });
    batches.set(key, batch);
  }
  let delivered = 0;
  for (const b of batches.values()) if (await deliver(b, now)) delivered += b.items.length;
  return delivered;
}

/**
 * A send failure that a later tick can get past (the agent between connections,
 * a gateway error, an RPC timeout): the claim is handed back rather than settled
 * `failed`. NOTICE_GIVE_UP_MS bounds the retries.
 */
export function transientNoticeError(message: string): boolean {
  return /not connected|disconnected|offline|timed? ?out|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|\b50[234]\b/i.test(message);
}

/** Whether the pane's foreground is a live agent process (tmux-foreground-cmd), not a shell or a dead pane. */
async function agentInForeground(host: Batch['host'], session: string): Promise<boolean> {
  try {
    const r = await sendForProject(host, 'tmux-foreground-cmd', { sessionName: session }, 5000) as { cmd?: unknown; dead?: unknown } | null;
    return r?.dead !== true && typeof r?.cmd === 'string' && classifyForeground(r.cmd) === 'running';
  } catch {
    return false;
  }
}

/** Claim, deliver, and on a delivery that can go later hand the claim back. */
async function deliver(b: Batch, now: number): Promise<boolean> {
  const at = new Date(now);
  const ids = b.items.map(i => i.id);
  const claimed = await prisma.agentMessage.updateMany({ where: { id: { in: ids }, notifiedAt: null }, data: { notifiedAt: at, notice: b.via } });
  if (claimed.count === 0) return false;
  // Another process may have taken some of them: deliver only what this one claimed.
  const mine = claimed.count === ids.length ? b.items : await (async () => {
    const rows = await prisma.agentMessage.findMany({ where: { id: { in: ids }, notifiedAt: at, notice: b.via }, select: { id: true } });
    const keep = new Set(rows.map(r => r.id));
    return b.items.filter(i => keep.has(i.id));
  })();
  if (!mine.length) return false;
  const release = () => prisma.agentMessage.updateMany({ where: { id: { in: mine.map(i => i.id) }, notifiedAt: at }, data: { notifiedAt: null, notice: null } });
  const failed = (why: string) => prisma.agentMessage.updateMany({ where: { id: { in: mine.map(i => i.id) }, notifiedAt: at }, data: { notice: 'failed' } })
    .then(() => console.warn(`[ASK] notice for ${mine.map(i => i.id).join(', ')} to ${b.via} ${b.projectId}/${b.workstream} failed: ${why}`));
  const text = askNoticeText(mine.map(i => i.item), b.via);
  const where = `${b.via} ${b.session ?? `${b.projectId}/${b.workstream}`}`;
  if (b.via === 'pane') {
    // Earlier sends in this tick took time: a pane that has left idle since its decision gets it later.
    if (!b.session || getStatus(b.session, b.host.instanceId).status !== 'idle') { await release(); return false; }
    // Nor one whose person has started typing since: the notice's Enter would submit their partial line.
    const typed = b.typist ? lastHumanHeartbeat(b.typist.unixUsername, b.typist.projectName, b.typist.instanceId) : null;
    if (typed != null && now - typed < NUDGE_HUMAN_QUIET_MS) { await release(); return false; }
    // Idle outlives the agent (Stop posts idle; nothing posts not_running on exit), so idle is
    // no proof the agent is there: type only while it is the pane's live foreground, never into
    // a shell, which would run the line. A probe that fails or reads anything else waits.
    if (!await agentInForeground(b.host, b.session)) { await release(); return false; }
    try {
      await sendForProject(b.host, 'tmux-send-keys', { sessionName: b.session, keys: text, withEnter: true, literal: true }, 5000);
    } catch (err) {
      const why = (err as Error).message;
      if (transientNoticeError(why)) { await release(); return false; }
      await failed(why);
      return false;
    }
  } else {
    if (!chatSender) { await release(); return false; }
    let sent: Awaited<ReturnType<ChatNoticeSender>>;
    try {
      sent = await chatSender({ userId: b.userId, projectId: b.projectId, workstream: b.workstream, text });
    } catch (err) {
      const why = (err as Error).message;
      sent = transientNoticeError(why) ? { kind: 'not-ready' } : { kind: 'refused', error: why };
    }
    if (sent.kind === 'not-ready') { await release(); return false; }
    if (sent.kind === 'refused') { await failed(sent.error); return false; }
  }
  console.log(`[ASK] notice for ${mine.map(i => `message ${i.id} (${i.item.status})`).join(', ')} → ${where}`);
  return true;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startAskNoticeSweep(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runAskNoticeTick()
      .catch(err => console.error('[ASK] notice sweep failed:', (err as Error).message))
      .finally(() => { running = false; });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopAskNoticeSweep(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
