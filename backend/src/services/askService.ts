/**
 * Agent-to-agent asks: the Prisma and RPC side of routes/cliAsk.ts.
 *
 * Access is owner-only, and that is not a flag: the asker must own both the
 * target project and the box it is on (ownerOnlyRefusal, after the session
 * rule's assertSessionAccess has found the workstream), because the run
 * executes as the box user with the owner's credentials. A share of either is
 * refused with 403 `not_owner`. Only a thread's starter may add a turn to it.
 * A person may have at most MAX_ACTIVE_ASKS asks active at once (capRefusal);
 * there is no run time, turn, hop or nesting cap.
 *
 * The log holds metadata only: prompts and replies are never stored. A reply
 * lives in this process's memory from the box's result to the publish, then
 * goes out as NOTIFYs to every orchestrator process (services/askReplyBus.ts),
 * each of which hands it to a poll for HANDOFF_TTL_MS and forgets it; nobody
 * polling in that window means the reply is dropped, and the message row still
 * says the run finished. A bundle is kept until published (or BUNDLE_TTL_MS).
 * Each ask and each end logs one `[ASK]` line naming sender, target, thread,
 * message and hop.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { WORK_PROJECT_KINDS } from './projectKind';
import type { CliUser } from './cliStore';
import type { RouteResult } from '../routes/routeResult';
import type { CliAsk } from '../routes/cliAsk';
import { assertSessionAccess, SessionAccessError } from './sessionAccess';
import { instanceAgentSettled, instanceAgentTransport, onBoxAgentHello, sendToInstanceAgent } from './agentRegistry';
import { projectDirFor } from './tmux';
import { registerBoxBusyCheck } from './boxLifecycle';
import { PowerRequestConflict, requestPower } from './boxPower';
import { powerRequestError } from './boxPowerPolicy';
import { isBoxProvisioningConfigured } from './boxProvisioner';
import { githubTokenSource } from './credentialStore';
import { publishBundle, publishConfigFromEnv, publishSummary, type PublishOutcome } from './askPublish';
import { REPLY_CHANNEL, ReplyHandoff, chunkReply } from './askReplyBus';
import { startReplyListener, stopReplyListener } from './askReplyListener';
import { ensureAskChat, type AskChat } from './askChat';
import {
  ACTIVE_STATES,
  ASK_AGENT_CAPABILITY,
  ASK_CANCEL_CAPABILITY,
  ASK_CHAT_CAPABILITY,
  BUNDLE_TTL_MS,
  INBOX_WINDOW_MS,
  LOST_RUN_GRACE_MS,
  askBranch,
  askPrBranch,
  askTarget,
  capRefusal,
  ownerOnlyRefusal,
  cancelDecision,
  cancelShouldStop,
  isTerminal,
  lostRunReason,
  START_RPC_MS,
  startFailureAction,
  stillStarting,
  messageView,
  parseStatusDescription,
  pickTarget,
  prBody,
  rejection,
  replayDecision,
  runSystemPrompt,
  setupRefusal,
  askRoute,
  shouldQueue,
  wakeAction,
  deadlineAfterStart,
  isParking,
  isProjectSettingUp,
  queuedDeadline,
  queueExpiryReason,
  targetCard,
  type AskRequest,
  type MessageStatus,
  type RunResult,
} from './agentMessages';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fail = (status: number, error: string, code: string): RouteResult => ({ status, body: { error, code } });

// --- waiting for a message to finish ---------------------------------------

const waiters = new Map<string, Set<() => void>>();

function wake(messageId: string): void {
  const set = waiters.get(messageId);
  if (!set) return;
  waiters.delete(messageId);
  for (const fn of set) fn();
}

/**
 * Resolves when this process finishes the message or after `ms`. The timeout
 * also covers a result that landed on the other process of an overlapping
 * deploy: the caller re-reads the row either way.
 */
function waitFor(messageId: string, ms: number): Promise<void> {
  return new Promise(resolve => {
    let set = waiters.get(messageId);
    if (!set) { set = new Set(); waiters.set(messageId, set); }
    const done = () => { clearTimeout(timer); set!.delete(done); if (!set!.size && waiters.get(messageId) === set) waiters.delete(messageId); resolve(); };
    const timer = setTimeout(done, ms);
    set.add(done);
  });
}

// --- reads -------------------------------------------------------------------

const messageInclude = {
  thread: { select: { id: true, hopCount: true, branch: true, prNumber: true, prUrl: true, prs: { select: { key: true, branch: true, prNumber: true, prUrl: true }, orderBy: { createdAt: 'asc' as const } }, project: { select: { name: true, userId: true, instance: { select: { name: true } } } } } },
} as const;

type MessageWithThread = NonNullable<Awaited<ReturnType<typeof loadMessage>>>;

function loadMessage(id: string) {
  return prisma.agentMessage.findUnique({ where: { id }, include: messageInclude });
}

function targetOf(m: MessageWithThread): string {
  return askTarget(m.thread.project.instance?.name ?? m.instanceId, m.thread.project.name, m.workstream);
}

// --- the reply hand-off ------------------------------------------------------

const handoff = new ReplyHandoff();

/** A finished reply reached this process (its own commit or a NOTIFY). */
function holdReply(messageId: string, text: string): void {
  handoff.put(messageId, text);
  wake(messageId);
}

/**
 * How long a poll on a finished message waits for its reply's NOTIFY before
 * saying it was not delivered. The NOTIFY is sent at the commit that set
 * completedAt, so this only covers the trip from Postgres.
 */
const SETTLE_MS = 5000;

export function startAskReplies(): void {
  startReplyListener(holdReply);
}

export function stopAskReplies(): void {
  stopReplyListener();
}

// --- the run on the box ----------------------------------------------------

/**
 * Is a message's run still going on its box? Asks the agent (ask-run-status,
 * agent/ask-run.js); `unknown` when it can't say (box offline, old agent, RPC
 * error).
 */
async function runState(instanceId: string, runId: string): Promise<'running' | 'gone' | 'unknown'> {
  try {
    const r = await sendToInstanceAgent(instanceId, 'ask-run-status', { runId }, 10_000);
    if (r?.running === true) return 'running';
    return r?.running === false ? 'gone' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Unknown counts as running, so a thread is never handed a second concurrent turn by mistake. */
async function runIsLive(instanceId: string, runId: string): Promise<boolean> {
  return (await runState(instanceId, runId)) !== 'gone';
}

/**
 * Ask the box to stop a run (agent/ask-run.js cancelAskRun). Best effort: a
 * box that is offline or too old keeps running it, and its result is ignored
 * because the message is no longer working.
 */
async function stopRun(instanceId: string, runId: string): Promise<{ stopped: boolean; detail: string }> {
  const transport = instanceAgentTransport(instanceId);
  if (!transport) return { stopped: false, detail: 'the box is not connected; its run, if any, ends on its own and is ignored' };
  if (!transport.capabilities.includes(ASK_CANCEL_CAPABILITY)) {
    return { stopped: false, detail: "the box's agent can't stop runs yet; the run ends on its own and is ignored" };
  }
  try {
    const r = await sendToInstanceAgent(instanceId, 'ask-run-cancel', { runId }, 10_000);
    return r?.stopped ? { stopped: true, detail: 'the run was stopped' } : { stopped: false, detail: 'the run was not running on the box' };
  } catch (e) {
    return { stopped: false, detail: `the box did not answer: ${errMsg(e)}` };
  }
}

/** Fails the turn only if it is still in the state it was judged lost in. */
async function finishLost(messageId: string, why: string, seen: MessageStatus): Promise<void> {
  await prisma.agentMessage.updateMany({
    where: { id: messageId, status: seen },
    data: { status: 'failed', error: why, completedAt: new Date() },
  });
  wake(messageId);
}

// --- publishing ------------------------------------------------------------

async function publishFor(messageId: string, r: RunResult): Promise<{ publish: string; detail: string | null; outcome: PublishOutcome | null }> {
  if (!r.bundle) return { publish: 'none', detail: null, outcome: null };
  const m = await prisma.agentMessage.findUnique({
    where: { id: messageId },
    include: {
      thread: {
        include: {
          originUser: { select: { id: true, unixUsername: true, googleEmail: true } },
          project: { select: { name: true, userId: true, instance: { select: { name: true } } } },
        },
      },
    },
  });
  if (!m) return { publish: 'failed', detail: 'the message disappeared before publishing', outcome: null };
  const t = m.thread;
  const bundle = await prisma.agentBundle.findUnique({ where: { messageId } });
  if (!bundle) return { publish: 'failed', detail: 'the box reported commits but no bundle arrived', outcome: null };
  if (!t.repo || !t.baseSha) {
    return { publish: 'failed', detail: "the target checkout has no GitHub origin, so the commits stay in the run's clone on the box", outcome: null };
  }
  const token = await githubTokenSource(t.originUserId).catch(() => null);
  if (!token) {
    return { publish: 'failed', detail: `${t.originUser.unixUsername} has no GitHub token stored in termag; connect GitHub in Settings to get a PR`, outcome: null };
  }
  const target = askTarget(t.project.instance?.name ?? t.instanceId, t.project.name, t.workstream);
  const user = t.originUser.unixUsername;
  const runBox = await prisma.instance.findUnique({ where: { id: m.instanceId }, select: { ec2InstanceId: true } });
  const rows = await prisma.agentThreadPr.findMany({ where: { threadId: t.id }, select: { key: true, prNumber: true } });
  const prNumbers: Record<string, number> = Object.fromEntries(rows.map(p => [p.key, p.prNumber]));
  if (prNumbers[''] == null && t.prNumber != null) prNumbers[''] = t.prNumber;
  const prDescriptions: Record<string, string> = { ...r.prDescriptions };
  if (r.prDescription) prDescriptions[''] = r.prDescription;
  const outcome = await publishBundle(publishConfigFromEnv(), {
    bundle: Buffer.from(bundle.data),
    baseSha: t.baseSha,
    repo: t.repo,
    token,
    askerEmail: t.originUser.googleEmail,
    branchFor: key => askPrBranch(user, t.id, key),
    prBody: (description, key) => prBody({
      senderUsername: user, target, threadId: t.id,
      box: runBox?.ec2InstanceId ?? m.instanceId, project: t.project.name, description,
      prKey: key || undefined,
    }),
    prDescriptions,
    prNumbers,
  });
  if (outcome.kind === 'done') {
    for (const p of outcome.prs) {
      if (p.kind !== 'published') continue;
      await prisma.agentThreadPr.upsert({
        where: { threadId_key: { threadId: t.id, key: p.key } },
        create: { threadId: t.id, key: p.key, branch: p.branch, prNumber: p.prNumber, prUrl: p.prUrl, headSha: p.headSha },
        update: { branch: p.branch, prNumber: p.prNumber, prUrl: p.prUrl, headSha: p.headSha },
      });
      if (p.key === '') {
        await prisma.agentThread.update({
          where: { id: t.id },
          data: { branch: p.branch, prNumber: p.prNumber, prUrl: p.prUrl },
        });
      }
    }
  }
  return { ...publishSummary(outcome), outcome };
}

async function finishRun(messageId: string, r: RunResult): Promise<void> {
  let pub: Awaited<ReturnType<typeof publishFor>>;
  try {
    pub = await publishFor(messageId, r);
  } catch (e) {
    pub = { publish: 'failed', detail: errMsg(e), outcome: null };
  }
  // The NOTIFYs go out at the commit that marks the message finished, so a poll
  // that sees it finished on any process finds the reply there or about to be.
  const [m] = await prisma.$transaction([
    prisma.agentMessage.update({
      where: { id: messageId },
      data: {
        status: r.isError ? 'failed' : 'completed',
        completedAt: new Date(),
        publish: pub.publish,
        publishDetail: pub.detail?.slice(0, 1000) ?? null,
      },
      include: messageInclude,
    }),
    ...chunkReply(messageId, r.result).map(p => prisma.$executeRaw`SELECT pg_notify(${REPLY_CHANNEL}, ${p})`),
  ]);
  holdReply(messageId, r.result);
  await prisma.agentBundle.deleteMany({ where: { messageId } });
  const secs = m.startedAt ? Math.round((m.completedAt!.getTime() - m.startedAt.getTime()) / 1000) : null;
  console.log(
    `[ASK] message ${m.id} on thread ${m.threadId} (${targetOf(m)}) ${m.status} after ${secs ?? '?'}s, `
    + `${m.numTurns ?? '?'} turn(s), reply ${m.replyBytes ?? 0}B, publish ${pub.publish}`
    + (pub.publish === 'published' || pub.publish === 'none' ? '' : `: ${pub.detail}`),
  );
}

// --- target descriptions ----------------------------------------------------

const DESCRIPTION_TTL_MS = 10 * 60 * 1000;
const descriptions = new Map<string, { at: number; value: string | null }>();

/** A project's AGENTS.md `status_description`, read from its box and cached; null when unreadable. */
async function agentsMdDescription(instanceId: string, projectDir: string): Promise<string | null> {
  const key = `${instanceId}:${projectDir}`;
  const hit = descriptions.get(key);
  if (hit && Date.now() - hit.at < DESCRIPTION_TTL_MS) return hit.value;
  let value: string | null = null;
  try {
    const r = await sendToInstanceAgent(instanceId, 'read-file', { path: `${projectDir.replace(/\/+$/, '')}/AGENTS.md` }, 3000);
    value = typeof r?.content === 'string' ? parseStatusDescription(r.content) : null;
  } catch {
    return hit?.value ?? null;
  }
  descriptions.set(key, { at: Date.now(), value });
  return value;
}

// --- the service -------------------------------------------------------------

/** Shared projects still resolve, so asking one is answered 403 `not_owner` rather than "no such project". */
async function resolveProjectId(user: CliUser, req: AskRequest): Promise<{ projectId: string } | RouteResult> {
  if (req.projectId) return { projectId: req.projectId };
  const ref = req.ref!;
  const rows = await prisma.project.findMany({
    where: {
      archived: false,
      name: ref.project,
      instance: { name: ref.box },
      OR: [{ userId: user.id }, { shares: { some: { userId: user.id } } }],
    },
    select: { id: true, name: true, userId: true, instance: { select: { name: true } }, user: { select: { unixUsername: true } } },
  });
  const picked = pickTarget(rows.map(p => ({
    projectId: p.id, projectName: p.name, boxName: p.instance?.name ?? null,
    ownerUsername: p.user.unixUsername, isOwner: p.userId === user.id,
  })), ref);
  if ('error' in picked) return fail(picked.status, picked.error, picked.status === 404 ? 'not_found' : 'ambiguous');
  return picked;
}

/**
 * The 202 of an ask whose id already names a message: the same body the first
 * POST answered. A row still `submitted` long past the start RPC's timeout
 * lost the process that was starting it, so the box decides what it is; a box
 * that can't say leaves it `submitted` for the sweep.
 */
async function replayAsk(m: MessageWithThread, branchOwner: string): Promise<RouteResult> {
  let status = m.status;
  if (status === 'submitted' && !stillStarting(m, Date.now())) {
    const state = await runState(m.instanceId, m.id);
    const live = state === 'running';
    const r = state === 'unknown' ? { count: 0 } : live
      ? await prisma.agentMessage.updateMany({ where: { id: m.id, status: 'submitted' }, data: { status: 'working', startedAt: new Date() } })
      : await prisma.agentMessage.updateMany({
        where: { id: m.id, status: 'submitted' },
        data: { status: 'failed', error: 'lost: the orchestrator restarted while starting the run', completedAt: new Date() },
      });
    if (r.count) { status = live ? 'working' : 'failed'; wake(m.id); }
    else status = (await prisma.agentMessage.findUnique({ where: { id: m.id }, select: { status: true } }))?.status ?? status;
  }
  return {
    status: 202,
    body: {
      thread: m.threadId, message: m.id, status, hop: m.hop, hops: m.thread.hopCount,
      target: targetOf(m), branch: askBranch(branchOwner, m.threadId), replayed: true,
      ...(m.queuedPrompt !== null ? { queued: true } : {}),
    },
  };
}


const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

const runProjectSelect = {
  name: true, userId: true, setupStatus: true, setupError: true, user: { select: { unixUsername: true } },
  instance: { select: { id: true, name: true, hostHome: true, status: true, userId: true, kind: true } },
} as const;

type RunProject = Prisma.ProjectGetPayload<{ select: typeof runProjectSelect }>;

const ownerFacts = (p: RunProject) => ({
  project: p.name, projectOwnerId: p.userId, box: p.instance?.name ?? null, boxOwnerId: p.instance?.userId ?? null,
});

interface RunStart {
  sender: CliUser;
  senderInstanceId: string | null;
  project: RunProject & { instance: NonNullable<RunProject['instance']> };
  instanceId: string;
  thread: { id: string; projectId: string; chatWorkstreamId: string | null; hopCount: number; claudeSessionId: string | null; baseSha: string | null };
  message: { id: string; hop: number; promptBytes: number };
  workstream: string;
  prompt: string;
}

/**
 * Send a submitted turn to its box (`ask-run`) and mark it working. Resolves
 * to the status it ended in, or the error that failed it.
 */
async function startRun(r: RunStart): Promise<{ status: string } | { error: string }> {
  const { sender, project, thread, message, instanceId } = r;
  const target = askTarget(project.instance.name, project.name, r.workstream);
  const branch = askBranch(sender.unixUsername, thread.id);
  console.log(
    `[ASK] ${sender.unixUsername} (${r.senderInstanceId ? `box ${r.senderInstanceId}` : 'signed-in CLI'}) asked ${target}: thread ${thread.id}`
    + ` message ${message.id} hop ${message.hop}, prompt ${message.promptBytes}B`,
  );
  // On a box that can, the run is a turn of the thread's chat on the target
  // project (services/askChat.ts); otherwise, or if the chat cannot be made,
  // the headless run as before.
  let chat: AskChat | null = null;
  if (instanceAgentTransport(instanceId)?.capabilities.includes(ASK_CHAT_CAPABILITY)) {
    try {
      chat = await ensureAskChat(thread);
    } catch (e) {
      console.warn(`[ASK] thread ${thread.id}: no chat for the run (${errMsg(e)}); running it headless`);
    }
  }
  try {
    await sendToInstanceAgent(instanceId, 'ask-run', {
      runId: message.id,
      threadId: thread.id,
      cwd: projectDirFor({ name: project.name, user: project.user, instance: project.instance }, r.workstream),
      prompt: r.prompt,
      resumeSessionId: thread.claudeSessionId,
      baseSha: thread.baseSha,
      systemPrompt: runSystemPrompt({
        senderUsername: sender.unixUsername,
        senderDisplayName: sender.displayName,
        target,
        branch,
      }),
      gitName: sender.displayName || sender.unixUsername,
      gitEmail: sender.googleEmail,
      ...(chat ? { chat } : {}),
    }, START_RPC_MS);
  } catch (e) {
    const action = startFailureAction(await runState(instanceId, message.id));
    if (action !== 'adopt') {
      const error = `${project.instance.name} did not start the run: ${errMsg(e)}`;
      const failed = await prisma.agentMessage.updateMany({
        where: { id: message.id, status: 'submitted' },
        data: { status: 'failed', error: error.slice(0, 1000), completedAt: new Date(), queuedUntil: null },
      });
      if (failed.count) {
        if (action === 'stop-and-fail') void stopRun(instanceId, message.id);
        wake(message.id);
        console.warn(`[ASK] message ${message.id}: ${error}`);
        return { error };
      }
    } else {
      console.warn(`[ASK] message ${message.id}: the start RPC failed (${errMsg(e)}), but the run is live on ${project.instance.name}`);
    }
  }
  const started = await prisma.agentMessage.updateMany({
    where: { id: message.id, status: 'submitted' },
    data: { status: 'working', startedAt: new Date(), queuedUntil: null },
  });
  wake(message.id);
  if (started.count) return { status: 'working' };
  // Someone else moved the turn on while this start ran: a cancel (whose
  // stop found nothing to stop yet), or a retry's replay that settled it.
  const now = (await prisma.agentMessage.findUnique({ where: { id: message.id }, select: { status: true } }))?.status ?? 'canceled';
  if (now === 'canceled') void stopRun(instanceId, message.id);
  return { status: now };
}

// --- asks waiting for a parked box or a clone --------------------------------

/**
 * An ask to the asker's own parked box, or to a project whose clone is still
 * running, is stored with its prompt and `queuedUntil` (queuedDeadline)
 * instead of being refused. Every orchestrator process ticks the queue,
 * because the box's agent connects to one of them: the one holding its socket
 * sends the run once the project is set up, any of them starts a box that is
 * down (requestPower's status guard makes a race harmless), a turn whose
 * project's setup failed fails at once, and one whose box never came or whose
 * clone never finished fails at its expiry. The prompt is cleared the moment
 * the turn is claimed for sending, or when it ends any other way.
 */
const QUEUE_TICK_MS = 5_000;
/** A box start that did not take (EC2 refused, a conflict) is asked again this often. */
const RESTART_EVERY_MS = 60_000;
const startRequestedAt = new Map<string, number>();

/**
 * The box's agent is connected here and has its credentials
 * (`instanceAgentSettled`: the hello's delivery, or a warm claim's). A box that
 * wakes for a queued ask gets it the moment it connects, while the
 * orchestrator is still delivering its Claude gateway settings; a run sent
 * before that lands would find them missing or stale.
 */
function readyTransport(instanceId: string) {
  const t = instanceAgentTransport(instanceId);
  return t && instanceAgentSettled(instanceId) ? t : null;
}

async function failQueued(id: string, why: string, where: Prisma.AgentMessageWhereInput = {}): Promise<boolean> {
  const r = await prisma.agentMessage.updateMany({
    where: { id, status: 'submitted', queuedPrompt: { not: null }, ...where },
    data: { status: 'failed', error: why, completedAt: new Date(), queuedPrompt: null, queuedUntil: null },
  });
  if (r.count) wake(id);
  return r.count > 0;
}

/** Claim a queued turn whose box is connected here and send it. */
async function sendQueued(id: string): Promise<void> {
  const m = await prisma.agentMessage.findUnique({
    where: { id },
    include: {
      thread: { select: { id: true, projectId: true, chatWorkstreamId: true, hopCount: true, claudeSessionId: true, baseSha: true } },
      sender: { select: { id: true, googleEmail: true, unixUsername: true, displayName: true } },
    },
  });
  if (!m || m.status !== 'submitted' || m.queuedPrompt === null) return;
  const transport = readyTransport(m.instanceId);
  if (!transport) return;
  const box = await prisma.instance.findUnique({ where: { id: m.instanceId }, select: { status: true } });
  if (!box || isParking(box.status)) return;
  const setup = await prisma.project.findUnique({ where: { id: m.projectId }, select: { setupStatus: true } });
  if (setup && isProjectSettingUp(setup.setupStatus)) return;
  const prompt = m.queuedPrompt;
  const claimed = await prisma.agentMessage.updateMany({
    where: { id, status: 'submitted', queuedPrompt: { not: null } },
    data: { queuedPrompt: null, queuedUntil: new Date() },
  });
  if (claimed.count === 0) return;
  const failClaimed = async (why: string) => {
    await prisma.agentMessage.updateMany({
      where: { id, status: 'submitted' },
      data: { status: 'failed', error: why.slice(0, 1000), completedAt: new Date(), queuedUntil: null },
    });
    wake(id);
    console.warn(`[ASK] queued message ${id}: ${why}`);
  };
  try {
    await assertSessionAccess(m.senderUserId, m.projectId, 'agent', m.workstream);
  } catch (e) {
    if (e instanceof SessionAccessError) return failClaimed(`the asker lost access while the box was starting: ${e.message}`);
    throw e;
  }
  const project = await prisma.project.findUnique({ where: { id: m.projectId }, select: runProjectSelect });
  if (!project?.instance || project.instance.id !== m.instanceId) return failClaimed('the project moved off the box while it was starting');
  const notOwner = ownerOnlyRefusal(ownerFacts(project), m.senderUserId);
  if (notOwner) return failClaimed(`the asker no longer owns the target: ${notOwner.error}`);
  if (!transport.capabilities.includes(ASK_AGENT_CAPABILITY)) {
    return failClaimed(`${project.instance.name}'s agent can't run asks yet; it needs a newer termag agent`);
  }
  const unready = setupRefusal(project);
  if (unready) return failClaimed(`${unready.error}, so the ask never ran`);
  await startRun({
    sender: m.sender, senderInstanceId: m.senderInstanceId,
    project: { ...project, instance: project.instance }, instanceId: m.instanceId, thread: m.thread,
    message: m, workstream: m.workstream, prompt,
  });
}

/** Start the box a queued turn waits for, if it is down and nobody asked lately. */
async function wakeBox(instanceId: string, askerId: string, ids: string[], now: number): Promise<void> {
  const box = await prisma.instance.findUnique({ where: { id: instanceId } });
  const action = wakeAction(box?.status ?? null);
  if (action === 'gone') {
    for (const id of ids) await failQueued(id, `the box is ${box?.status ?? 'gone'}, so the ask never ran`);
    return;
  }
  if (action !== 'start' || now - (startRequestedAt.get(instanceId) ?? 0) < RESTART_EVERY_MS) return;
  startRequestedAt.set(instanceId, now);
  const refused = powerRequestError(box, askerId, 'start', isBoxProvisioningConfigured());
  if (refused) {
    for (const id of ids) await failQueued(id, `termag could not start ${box!.name}: ${refused.error}`);
    return;
  }
  try {
    await requestPower(box!, 'start', { markInUse: true });
    console.log(`[ASK] started ${box!.name} for ${ids.length} queued ask(s)`);
  } catch (e) {
    if (!(e instanceof PowerRequestConflict)) console.warn(`[ASK] starting ${box!.name} for a queued ask failed; trying again: ${errMsg(e)}`);
    return;
  }
  const rows = await prisma.agentMessage.findMany({
    where: { id: { in: ids }, status: 'submitted', queuedPrompt: { not: null } },
    select: { id: true, createdAt: true, queuedUntil: true },
  });
  for (const r of rows) {
    if (!r.queuedUntil) continue;
    await prisma.agentMessage.updateMany({
      where: { id: r.id, status: 'submitted', queuedPrompt: { not: null } },
      data: { queuedUntil: deadlineAfterStart({ createdAt: r.createdAt, queuedUntil: r.queuedUntil }, now) },
    });
  }
}

export async function tickQueue(now = Date.now()): Promise<void> {
  const rows = await prisma.agentMessage.findMany({
    where: { queuedUntil: { not: null }, queuedPrompt: { not: null }, status: 'submitted' },
    select: { id: true, instanceId: true, senderUserId: true, queuedUntil: true, projectId: true },
  });
  const statuses = new Map((await prisma.instance.findMany({
    where: { id: { in: [...new Set(rows.map(r => r.instanceId))] } },
    select: { id: true, status: true },
  })).map(b => [b.id, b.status]));
  const projects = new Map((await prisma.project.findMany({
    where: { id: { in: [...new Set(rows.map(r => r.projectId))] } },
    select: { id: true, name: true, setupStatus: true, setupError: true },
  })).map(p => [p.id, p]));
  const waiting = new Map<string, { askerId: string; ids: string[] }>();
  for (const r of rows) {
    const parking = isParking(statuses.get(r.instanceId) ?? '');
    const project = projects.get(r.projectId) ?? null;
    const setupFailed = project && setupRefusal(project);
    if (setupFailed) {
      if (await failQueued(r.id, `${setupFailed.error}, so the ask never ran`)) {
        console.log(`[ASK] queued message ${r.id} failed: ${project.name}'s setup failed`);
      }
    } else if (r.queuedUntil!.getTime() < now) {
      const why = queueExpiryReason(project);
      if (await failQueued(r.id, why, { queuedUntil: { lt: new Date(now) } })) {
        console.log(`[ASK] queued message ${r.id} expired: ${why}`);
      }
    } else if (!parking && instanceAgentTransport(r.instanceId) && project && isProjectSettingUp(project.setupStatus)) {
      // Connected and cloning: the box reports the clone's end, and a later tick sends the run.
    } else if (!parking && readyTransport(r.instanceId)) {
      await sendQueued(r.id).catch(e => console.error(`[ASK] sending queued message ${r.id} failed:`, errMsg(e)));
    } else if (parking || !instanceAgentTransport(r.instanceId)) {
      const w = waiting.get(r.instanceId) ?? { askerId: r.senderUserId, ids: [] };
      w.ids.push(r.id);
      waiting.set(r.instanceId, w);
    }
  }
  for (const [instanceId, w] of waiting) await wakeBox(instanceId, w.askerId, w.ids, now);
}

let queueTimer: NodeJS.Timeout | null = null;
let ticking = false;
let offHello: (() => void) | null = null;

export function startAskQueue(everyMs = QUEUE_TICK_MS): void {
  if (queueTimer) return;
  offHello = onBoxAgentHello(ev => {
    void ev.settled.then(() => tickQueue()).catch(e => console.error('[ASK] queue tick after a connect failed:', errMsg(e)));
  });
  queueTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    tickQueue().catch(e => console.error('[ASK] queue tick failed:', errMsg(e))).finally(() => { ticking = false; });
  }, everyMs);
  queueTimer.unref?.();
}

export function stopAskQueue(): void {
  if (queueTimer) { clearInterval(queueTimer); queueTimer = null; }
  offHello?.();
  offHello = null;
}

export const prismaCliAsk: CliAsk = {
  async ask(user, senderInstanceId, req) {
    const resolved = await resolveProjectId(user, req);
    if ('status' in resolved) return resolved;

    let access;
    try {
      access = await assertSessionAccess(user.id, resolved.projectId, 'agent', req.workstream);
    } catch (e) {
      if (e instanceof SessionAccessError) return fail(e.status, e.message, e.status === 404 ? 'not_found' : 'invalid_request');
      throw e;
    }
    const project = await prisma.project.findUnique({ where: { id: access.project.id }, select: runProjectSelect });
    if (!project) return fail(404, 'Project not found', 'not_found');
    const notOwner = ownerOnlyRefusal(ownerFacts(project), user.id);
    if (notOwner) return fail(notOwner.status, notOwner.error, notOwner.code);
    const promptBytes = Buffer.byteLength(req.prompt, 'utf8');
    const replayOf = async (): Promise<RouteResult | null> => {
      if (!req.messageId) return null;
      const existing = await loadMessage(req.messageId);
      if (!existing) return null;
      const d = replayDecision(existing, { userId: user.id, projectId: access.project.id, workstream: req.workstream, threadId: req.threadId, promptBytes });
      if (d === 'taken') return fail(409, 'That message id is already in use; send a new one', 'id_in_use');
      if (d === 'different') return fail(409, 'That message id already names a different ask; send a new one', 'id_reused');
      return replayAsk(existing, user.unixUsername);
    };
    const replayed = await replayOf();
    if (replayed) return replayed;

    const instanceId = project.instance?.id ?? null;
    if (!instanceId || !project.instance) return rejection(409, 'That project is not on a box; asks run on boxes only', 'no_box', req);
    const target = askTarget(project.instance.name, project.name, req.workstream);

    const conn = instanceAgentTransport(instanceId);
    const route = askRoute(project.instance, user.id, isBoxProvisioningConfigured(), {
      connected: !!conn,
      helloReceived: !!conn?.helloReceived,
      settled: !!conn && (conn.conn.kind !== 'owned-box' || instanceAgentSettled(instanceId)),
    });
    if (route === 'offline') {
      return rejection(409, `${project.instance.name} is not connected (${project.instance.status}); start the box and try again`, 'box_offline', req);
    }
    if (route === 'connecting') {
      return rejection(409, `${project.instance.name}'s agent is still connecting; try again in a moment`, 'box_offline', req);
    }
    const waitsForBox = route === 'queue';
    const transport = waitsForBox ? null : conn;
    if (transport && !transport.capabilities.includes(ASK_AGENT_CAPABILITY)) {
      return rejection(409, `${project.instance.name}'s agent can't run asks yet; it needs a newer termag agent`, 'unsupported', req);
    }
    const unready = setupRefusal(project);
    if (unready) return rejection(409, unready.error, unready.code, req);
    const askChat = await prisma.workstream.findFirst({
      where: { projectId: access.project.id, name: req.workstream, askThread: { isNot: null } }, select: { id: true },
    });
    if (askChat) return rejection(409, `${req.workstream} is an ask's own conversation; ask the project's workstream instead`, 'invalid_request', req);
    const waitsForSetup = isProjectSettingUp(project.setupStatus);
    const queued = waitsForBox || waitsForSetup;

    let prior = null;
    if (req.threadId) {
      prior = await prisma.agentThread.findUnique({ where: { id: req.threadId } });
      if (!prior || prior.originUserId !== user.id) return fail(404, 'Thread not found', 'not_found');
      if (prior.projectId !== access.project.id || prior.workstream !== req.workstream) {
        return fail(409, 'That thread talks to another project or workstream', 'thread_mismatch');
      }
      const busy = await prisma.agentMessage.findFirst({
        where: { threadId: prior.id, status: { in: ACTIVE_STATES } },
        select: { id: true, instanceId: true, status: true, createdAt: true, queuedUntil: true },
      });
      if (busy) {
        // A turn still inside its start RPC, or queued for its box, has no runner on the box yet.
        if (stillStarting(busy, Date.now()) || await runIsLive(busy.instanceId, busy.id)) {
          return rejection(409, `The thread's previous turn (${busy.id}) is still running; wait for it first`, 'thread_busy', req);
        }
        await finishLost(busy.id, 'lost: the run was no longer running on the box', busy.status as MessageStatus);
      }
    }

    // The thread's hop and the message land together, so a retry racing the
    // first POST (same id) leaves no extra hop or empty thread behind. The
    // per-person lock makes the cap hold against asks sent at the same time.
    let created;
    try {
      created = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ask:${user.id}`}))`;
        const active = await tx.agentMessage.count({ where: { senderUserId: user.id, status: { in: ACTIVE_STATES } } });
        const capped = capRefusal(active);
        if (capped) return { capped };
        let thread;
        if (prior) {
          const bumped = await tx.agentThread.updateMany({
            where: { id: prior.id, hopCount: prior.hopCount },
            data: { hopCount: { increment: 1 } },
          });
          if (bumped.count === 0) return null;
          thread = { ...prior, hopCount: prior.hopCount + 1 };
        } else {
          thread = await tx.agentThread.create({
            data: { originUserId: user.id, projectId: access.project.id, workstream: req.workstream, instanceId, hopCount: 1 },
          });
        }
        const message = await tx.agentMessage.create({
          data: {
            ...(req.messageId ? { id: req.messageId } : {}),
            threadId: thread.id,
            senderUserId: user.id,
            senderInstanceId,
            projectId: access.project.id,
            workstream: req.workstream,
            instanceId,
            hop: thread.hopCount,
            promptBytes,
            ...(queued ? { queuedPrompt: req.prompt, queuedUntil: queuedDeadline({ box: waitsForBox, setup: waitsForSetup }, Date.now()) } : {}),
          },
        });
        return { thread, message };
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const again = await replayOf();
      if (again) return again;
      throw e;
    }
    if (!created) return rejection(409, 'Another turn on this thread started at the same time', 'thread_busy', req);
    if ('capped' in created && created.capped) {
      console.log(`[ASK] ${user.unixUsername} asked ${target}: refused, ${created.capped.code}`);
      return rejection(409, created.capped.error, created.capped.code, req);
    }
    const { thread, message } = created;
    const branch = askBranch(user.unixUsername, thread.id);
    const reply = (status: string) => ({
      status: 202,
      body: {
        thread: thread.id, message: message.id, status, hop: message.hop, hops: thread.hopCount, target, branch,
        ...(queued ? { queued: true, queuedFor: waitsForBox ? 'box' : 'setup' } : {}),
      },
    });
    if (queued) {
      const until = [
        ...(waitsForBox ? [`${project.instance.name} connects (${project.instance.status})`] : []),
        ...(waitsForSetup ? [`${project.name} is set up (${project.setupStatus})`] : []),
      ].join(' and ');
      console.log(
        `[ASK] ${user.unixUsername} (${senderInstanceId ? `box ${senderInstanceId}` : 'signed-in CLI'}) asked ${target}: thread ${thread.id}`
        + ` message ${message.id} hop ${message.hop}, prompt ${message.promptBytes}B, queued until ${until}`,
      );
      void tickQueue().catch(e => console.error('[ASK] queue tick failed:', errMsg(e)));
      return reply('submitted');
    }
    const started = await startRun({
      sender: user, senderInstanceId,
      project: { ...project, instance: project.instance }, instanceId, thread, message, workstream: req.workstream, prompt: req.prompt,
    });
    if ('error' in started) return fail(502, started.error, 'box_error');
    return reply(started.status);
  },

  async getMessage(user, messageId, waitSec) {
    const deadline = Date.now() + waitSec * 1000;
    for (;;) {
      const m = await loadMessage(messageId);
      if (!m || m.senderUserId !== user.id) return fail(404, 'Message not found', 'not_found');
      const left = deadline - Date.now();
      if (isTerminal(m.status)) {
        const reply = m.replyBytes === null ? null : handoff.get(m.id);
        if (reply !== null) {
          // Any poll inside the hand-off window gets the text, so a response
          // lost on the way (a deploy's 502) is answered again by the retry.
          const readAt = m.readAt ?? new Date();
          if (!m.readAt) await prisma.agentMessage.updateMany({ where: { id: m.id, readAt: null }, data: { readAt } });
          return { status: 200, body: messageView({ ...m, readAt }, m.thread, targetOf(m), reply) };
        }
        const settling = m.replyBytes !== null && m.readAt === null && m.completedAt !== null
          && Date.now() - m.completedAt.getTime() < SETTLE_MS;
        if (settling && left > 0) { await waitFor(m.id, Math.min(left, 500)); continue; }
        return { status: 200, body: messageView(m, m.thread, targetOf(m), null) };
      }
      if (left <= 0) return { status: 200, body: messageView(m, m.thread, targetOf(m), null) };
      await waitFor(m.id, Math.min(left, 2000));
    }
  },

  async inbox(user) {
    const since = new Date(Date.now() - INBOX_WINDOW_MS);
    const rows = await prisma.agentMessage.findMany({
      where: {
        senderUserId: user.id,
        OR: [
          { status: { in: ACTIVE_STATES } },
          { completedAt: { gte: since } },
        ],
      },
      include: messageInclude,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { status: 200, body: { messages: rows.map(m => messageView(m, m.thread, targetOf(m), null)) } };
  },

  async cancel(user, messageId) {
    const m = await loadMessage(messageId);
    if (!m) return fail(404, 'Message not found', 'not_found');
    const d = cancelDecision({ status: m.status, resultAt: m.resultAt, senderUserId: m.senderUserId, projectOwnerId: m.thread.project.userId }, user.id);
    if (d.kind === 'not_found') return fail(404, 'Message not found', 'not_found');
    if (d.kind === 'finished') return fail(409, `Can't cancel: ${d.why}`, 'finished');
    if (d.kind === 'already') return { status: 200, body: { ...messageView(m, m.thread, targetOf(m), null), stop: null } };
    // resultAt: null is the race with the box's result: whichever lands first wins.
    const canceled = await prisma.agentMessage.updateMany({
      where: { id: m.id, status: { in: ACTIVE_STATES }, resultAt: null },
      data: { status: 'canceled', completedAt: new Date(), error: `canceled by ${user.unixUsername}`, queuedPrompt: null, queuedUntil: null },
    });
    if (canceled.count === 0) return prismaCliAsk.cancel(user, messageId);
    wake(m.id);
    await prisma.agentBundle.deleteMany({ where: { messageId: m.id } });
    const started = await prisma.agentMessage.findUnique({ where: { id: m.id }, select: { startedAt: true } });
    const stop = cancelShouldStop({ status: m.status, startedAt: started?.startedAt ?? null })
      ? await stopRun(m.instanceId, m.id)
      : { stopped: false, detail: m.queuedPrompt !== null ? 'it was still waiting for its box to start or its project to be set up' : 'the run had not started' };
    console.log(`[ASK] message ${m.id} on thread ${m.threadId} (${targetOf(m)}) canceled by ${user.unixUsername}: ${stop.detail}`);
    const after = await loadMessage(m.id);
    return { status: 200, body: { ...messageView(after ?? m, m.thread, targetOf(m), null), stop } };
  },

  async targets(user) {
    const projects = await prisma.project.findMany({
      where: {
        archived: false,
        kind: { in: WORK_PROJECT_KINDS },
        // Owner-only: shared projects, and own projects on someone else's box, can't be asked.
        userId: user.id,
        instance: { userId: user.id },
      },
      select: {
        id: true, name: true, description: true, userId: true, setupStatus: true, setupError: true,
        user: { select: { unixUsername: true } },
        instance: { select: { id: true, name: true, status: true, hostHome: true, kind: true, userId: true } },
        // An ask's own chat is not something to ask (services/askChat.ts).
        workstreams: { where: { archived: false, askThread: null }, select: { name: true }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: [{ instance: { name: 'asc' } }, { name: 'asc' }],
    });
    const configured = isBoxProvisioningConfigured();
    const cards = await Promise.all(projects.map(async p => {
      const box = p.instance!;
      const transport = isParking(box.status) ? null : instanceAgentTransport(box.id);
      const description = p.description?.trim() || (transport
        ? await agentsMdDescription(box.id, projectDirFor({ name: p.name, user: p.user, instance: box }, 'main'))
        : null);
      const names = p.workstreams.length ? p.workstreams.map(w => w.name) : ['main'];
      return names.map(workstream => targetCard({
        projectId: p.id, box: box.name, project: p.name, workstream,
        owner: p.user.unixUsername, shared: false, description,
        boxStatus: box.status, connected: !!transport,
        capabilities: transport?.capabilities ?? [],
        wakes: !transport && shouldQueue(box, user.id, configured),
        setupStatus: p.setupStatus, setupError: p.setupError,
      }));
    }));
    return { status: 200, body: { agents: cards.flat() } };
  },

  async recordBundle(boxId, messageId, data) {
    const m = await prisma.agentMessage.findUnique({ where: { id: messageId }, select: { instanceId: true, status: true } });
    if (!m) return fail(404, 'unknown run', 'not_found');
    if (m.instanceId !== boxId) return fail(403, 'this run belongs to another box', 'forbidden');
    if (m.status !== 'working') return fail(409, `the run is ${m.status}`, 'conflict');
    await prisma.agentBundle.upsert({
      where: { messageId },
      create: { messageId, data },
      update: { data, createdAt: new Date() },
    });
    return { status: 204, body: undefined };
  },

  async recordResult(boxId, messageId, r) {
    const m = await prisma.agentMessage.findUnique({
      where: { id: messageId },
      select: { instanceId: true, status: true, threadId: true, thread: { select: { baseSha: true, repo: true } } },
    });
    if (!m) return fail(404, 'unknown run', 'not_found');
    if (m.instanceId !== boxId) return fail(403, 'this run belongs to another box', 'forbidden');
    if (m.status !== 'working') return { status: 204, body: undefined };
    // resultAt makes a repeated report a no-op; the reply itself stays in memory.
    const first = await prisma.agentMessage.updateMany({
      where: { id: messageId, status: 'working', resultAt: null },
      data: {
        resultAt: new Date(),
        replyBytes: Buffer.byteLength(r.result, 'utf8'),
        numTurns: r.numTurns,
        error: r.isError ? (r.exitReason ?? 'the run ended with an error') : null,
      },
    });
    if (first.count === 0) return { status: 204, body: undefined };
    await prisma.agentThread.update({
      where: { id: m.threadId },
      data: {
        ...(r.sessionId ? { claudeSessionId: r.sessionId } : {}),
        ...(!m.thread.baseSha && r.baseSha ? { baseSha: r.baseSha } : {}),
        ...(!m.thread.repo && r.repo ? { repo: r.repo } : {}),
      },
    });
    finishRun(messageId, r).catch(e => console.error(`[ASK] message ${messageId}: finishing failed:`, errMsg(e)));
    return { status: 202, body: { ok: true } };
  },
};

// --- retention ---------------------------------------------------------------

/**
 * A result reported this long ago whose publish never finished was interrupted
 * (a restart), and its reply went with the process that held it.
 */
const PUBLISH_STUCK_MS = 15 * 60 * 1000;

export async function sweepAsks(now = new Date()): Promise<void> {
  const bundles = await prisma.agentBundle.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - BUNDLE_TTL_MS) } } });
  const stuck = await prisma.agentMessage.findMany({
    where: { status: 'working', resultAt: { lt: new Date(now.getTime() - PUBLISH_STUCK_MS) } },
    select: { id: true, error: true },
  });
  for (const s of stuck) {
    await prisma.agentMessage.updateMany({
      where: { id: s.id, status: 'working' },
      data: {
        status: s.error ? 'failed' : 'completed', completedAt: now, publish: 'failed',
        publishDetail: 'publishing was interrupted (the orchestrator restarted) and the reply was lost with it; ask again on the thread',
      },
    });
  }
  const lost = await closeLostRuns(now);
  // An ended turn never needs its prompt; a race with a cancel or a crash can leave one.
  await prisma.agentMessage.updateMany({
    where: { status: { notIn: ACTIVE_STATES }, OR: [{ queuedPrompt: { not: null } }, { queuedUntil: { not: null } }] },
    data: { queuedPrompt: null, queuedUntil: null },
  });
  if (bundles.count || stuck.length || lost) {
    console.log(`[ASK] retention: ${bundles.count} bundle(s) removed; ${stuck.length} interrupted publish(es) closed; ${lost} lost run(s) failed`);
  }
}

/**
 * A run that died without reporting (a box reboot, a kill, a runner crash)
 * would otherwise stay working until someone asked on its thread again, and
 * `termag ask` waits with no timeout. A `submitted` turn is checked too once
 * it is well past its start RPC: the process starting it died, and a replay
 * could not settle it because the box could not say.
 */
async function closeLostRuns(now: Date): Promise<number> {
  const before = new Date(now.getTime() - LOST_RUN_GRACE_MS);
  const quiet = await prisma.agentMessage.findMany({
    where: {
      resultAt: null,
      OR: [
        { status: 'working', startedAt: { lt: before } },
        // A queued turn is the queue's to settle; one claimed for sending counts from its claim.
        { status: 'submitted', createdAt: { lt: before }, queuedPrompt: null, OR: [{ queuedUntil: null }, { queuedUntil: { lt: before } }] },
      ],
    },
    select: { id: true, instanceId: true, status: true },
  });
  if (!quiet.length) return 0;
  const boxes = new Map((await prisma.instance.findMany({
    where: { id: { in: [...new Set(quiet.map(q => q.instanceId))] } },
    select: { id: true, status: true },
  })).map(b => [b.id, b.status]));
  let closed = 0;
  for (const q of quiet) {
    const why = await lostRunReason(boxes.get(q.instanceId) ?? null, () => runIsLive(q.instanceId, q.id));
    if (!why) continue;
    const r = await prisma.agentMessage.updateMany({
      where: { id: q.id, status: q.status, resultAt: null },
      data: { status: 'failed', error: why, completedAt: now, queuedUntil: null },
    });
    if (r.count) { closed++; wake(q.id); }
  }
  return closed;
}

// A box with an ask turn submitted or working on it is not idle, whatever its clock says.
registerBoxBusyCheck('ask-run', async (ids) => {
  const rows = await prisma.agentMessage.findMany({
    where: { instanceId: { in: ids }, status: { in: ACTIVE_STATES } },
    select: { instanceId: true },
    distinct: ['instanceId'],
  });
  return new Set(rows.map(r => r.instanceId));
});

let sweepTimer: NodeJS.Timeout | null = null;

export function startAskSweep(everyMs = 10 * 60 * 1000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => sweepAsks().catch(e => console.error('[ASK] sweep failed:', errMsg(e))), everyMs);
  sweepTimer.unref?.();
}

export function stopAskSweep(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
