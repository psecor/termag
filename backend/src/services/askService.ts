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
 * The log holds metadata only: never a prompt or a reply. A reply lives in
 * this process's memory from the box's result to the publish. The transaction
 * that marks the message finished stores it, sealed, for ASK_REPLY_TTL_MS
 * (services/askReplyStore.ts), and sends it as NOTIFYs to every orchestrator
 * process (services/askReplyBus.ts), each of which hands it to a waiting poll
 * for HANDOFF_TTL_MS. A poll after that reads the stored copy; only the
 * message's sender ever gets either. A deployment with no transcript key
 * stores nothing, and a reply nobody polled for in the window is dropped. A
 * bundle is kept until published (or BUNDLE_TTL_MS).
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
import { projectDirFor, sessionName } from './tmux';
import { ASK_NOTICE_FLAG, noticeVia, type NoticeVia } from './askNotice';
import { boolVariation } from './featureFlags';
import { isAmbiguousSession, resolveSessionProject } from './sessionResolver';
import { registerBoxBusyCheck } from './boxLifecycle';
import { boxesWithOpenEvent, openBoxEvent } from './boxEvents';
import { PowerRequestConflict, requestPower } from './boxPower';
import { powerRequestError } from './boxPowerPolicy';
import { isBoxProvisioningConfigured } from './boxProvisioner';
import { githubTokenSource } from './credentialStore';
import { publishBundle, publishConfigFromEnv, publishSummary, resolveTargetPr, type PublishOutcome } from './askPublish';
import { confirmPushes, githubConfigFromEnv, pushSummary } from './askPushes';
import { repoKey } from './projectTemplates';
import { REPLY_CHANNEL, ReplyHandoff, chunkReply } from './askReplyBus';
import { startReplyListener, stopReplyListener } from './askReplyListener';
import { readReply, sealReply, storeReply, sweepReplies, type SealedReply } from './askReplyStore';
import { getTranscriptStoreConfig } from './chatTranscriptStore';
import { ensureAskChat, type AskChat } from './askChat';
import { turnMemorySpace } from './chatSpace';
import { askTelemetryFor } from './askTelemetry';
import { SPACE_MEMORY_CAPABILITY } from './chatRunner';
import { isWorkspace } from './projectRepos';
import { multiRepoEnabled } from './multiRepoFlag';
import {
  ACTIVE_STATES,
  ASK_AGENT_CAPABILITY,
  ASK_CANCEL_CAPABILITY,
  ASK_CHAT_CAPABILITY,
  ASK_STEER_CAPABILITY,
  ASK_PUSH_CAPABILITY,
  BUNDLE_TTL_MS,
  INBOX_WINDOW_MS,
  LOST_RUN_GRACE_MS,
  askBranch,
  senderParentAllowed,
  type AskSender,
  askCwd,
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
  repoTarget,
  runSystemPrompt,
  setupRefusal,
  steerDecision,
  steerRefusalText,
  supersededReplyMode,
  answeredTogether,
  waitsForThread,
  THREAD_QUEUE_TTL_MS,
  THREAD_QUEUE_EXPIRED,
  askRoute,
  shouldQueue,
  wakeAction,
  deadlineAfterStart,
  isParking,
  isProjectSettingUp,
  queuedDeadline,
  queueExpiryReason,
  targetCard,
  threadTarget,
  MAX_LISTED_THREADS,
  type AskRequest,
  type MessageStatus,
  type RunResult,
} from './agentMessages';
import { traceSweep } from './tracing/spans';

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
  storedReply: { select: { bytes: true, truncated: true } },
  thread: { select: { id: true, title: true, hopCount: true, repoName: true, branch: true, prNumber: true, prUrl: true, prs: { select: { key: true, branch: true, prNumber: true, prUrl: true }, orderBy: { createdAt: 'asc' as const } }, project: { select: { name: true, userId: true, instance: { select: { name: true } } } } } },
} as const;

type MessageWithThread = NonNullable<Awaited<ReturnType<typeof loadMessage>>>;

function loadMessage(id: string) {
  return prisma.agentMessage.findUnique({ where: { id }, include: messageInclude });
}

function targetOf(m: MessageWithThread): string {
  return askTarget(m.thread.project.instance?.name ?? m.instanceId, m.thread.project.name, m.workstream, m.thread.repoName);
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

/**
 * A message as the CLI sees it, plus whether this orchestrator stores replies
 * at all (`replyKept`), so a CLI only promises `--reply` after the fact where
 * it is true; `replyStored` is per message and false either way until then.
 */
function askView(...a: Parameters<typeof messageView>) {
  return { ...messageView(...a), replyKept: getTranscriptStoreConfig() != null };
}

/** The message's stored reply, or null when none is stored or it can't be opened (logged, without the text). */
async function storedReplyOf(messageId: string): Promise<string | null> {
  const cfg = getTranscriptStoreConfig();
  if (!cfg) return null;
  try {
    return await readReply(cfg, messageId);
  } catch (e) {
    console.error(`[ASK] message ${messageId}: the stored reply could not be read: ${errMsg(e)}`);
    return null;
  }
}

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
 * error). A run a follow-up was steered into answers `supersededBy`
 * (agent/ask-chat.js), which is how the orchestrator learns of a steer whose
 * answer it lost.
 */
async function runStatus(instanceId: string, runId: string): Promise<{ state: 'running' | 'gone' | 'unknown'; supersededBy: string | null; live: boolean }> {
  try {
    const r = await sendToInstanceAgent(instanceId, 'ask-run-status', { runId }, 10_000);
    const supersededBy = typeof r?.supersededBy === 'string' && /^[a-z0-9]{8,40}$/.test(r.supersededBy) ? r.supersededBy : null;
    // A live chat turn (ask-steer-v1), the only kind a follow-up can join; a headless run says nothing.
    const live = r?.mode === 'chat' && r?.live === true;
    if (r?.running === true) return { state: 'running', supersededBy, live };
    return { state: r?.running === false ? 'gone' : 'unknown', supersededBy, live: false };
  } catch {
    return { state: 'unknown', supersededBy: null, live: false };
  }
}

async function runState(instanceId: string, runId: string): Promise<'running' | 'gone' | 'unknown'> {
  return (await runStatus(instanceId, runId)).state;
}

/**
 * A follow-up went into this message's running turn on the box: the
 * message ends `superseded`, pointing at it, and its waiting polls move on
 * to the follow-up (cli ask.ts). Only a working turn with no result yet; one
 * canceled or answered meanwhile keeps that end.
 */
async function supersede(messageId: string, by: string): Promise<boolean> {
  const r = await prisma.agentMessage.updateMany({
    where: { id: messageId, status: 'working', resultAt: null },
    data: { status: 'superseded', supersededById: by, completedAt: new Date(), queuedUntil: null },
  });
  if (r.count) {
    wake(messageId);
    console.log(`[ASK] message ${messageId} superseded by ${by}: the follow-up went into its running turn`);
  }
  return r.count > 0;
}

/** The code a refused `--update-pr` carries. */
export const TARGET_PR_REFUSED_CODE = 'target_pr_refused';

/**
 * The PR a thread publishes to (`--update-pr`), checked on GitHub with the
 * asker's token before any run (askPublish.resolveTargetPr: open, same repo,
 * not a fork, not a base branch, the asker's branch or PR), or the refusal. The repository is the one `--update-pr` named, else the checkout's:
 * the run's repository's own URL in a multi-repo project (whose `repoUrl` is
 * null), else the project's. A checkout whose URL termag doesn't know is
 * matched at publish, against the origin the box reports.
 */
async function targetForAsk(
  user: CliUser, req: AskRequest, checkoutUrl: string | null,
): Promise<{ number: number; repo: string; branch: string } | RouteResult> {
  const pr = req.targetPr!;
  const checkout = checkoutUrl ? repoKey(checkoutUrl) : null;
  const repo = pr.repo ?? checkout;
  if (!repo) return rejection(409, `Can't tell which repository PR #${pr.number} is in; name it as --update-pr <owner>/<name>#${pr.number}`, TARGET_PR_REFUSED_CODE, req);
  if (checkout && checkout !== repo.toLowerCase()) {
    return rejection(409, `PR #${pr.number} is in ${repo}, but the ask runs in a checkout of ${checkout}`, TARGET_PR_REFUSED_CODE, req);
  }
  const token = await githubTokenSource(user.id).catch(() => null);
  if (!token) return rejection(409, `${user.unixUsername} has no GitHub token stored in termag, so PR #${pr.number} can't be checked; connect GitHub in Settings`, TARGET_PR_REFUSED_CODE, req);
  const t = await resolveTargetPr(publishConfigFromEnv(), {
    repo, token, number: pr.number, askerUnix: user.unixUsername,
  });
  if ('refused' in t) return rejection(409, t.refused, TARGET_PR_REFUSED_CODE, req);
  if ('failed' in t) return fail(502, t.failed, 'github_error');
  return { number: t.number, repo, branch: t.branch };
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
  kickQueue();
}

// --- publishing ------------------------------------------------------------

async function publishFor(messageId: string, r: RunResult): Promise<{ publish: string; detail: string | null; outcome: PublishOutcome | null }> {
  if (r.pushes) return { ...await recordPushes(messageId, r.pushes), outcome: null };
  if (!r.bundle) return { publish: 'none', detail: null, outcome: null };
  const m = await prisma.agentMessage.findUnique({
    where: { id: messageId },
    include: {
      thread: {
        include: {
          originUser: { select: { id: true, unixUsername: true, googleEmail: true, displayName: true } },
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
  const target = askTarget(t.project.instance?.name ?? t.instanceId, t.project.name, t.workstream, t.repoName);
  const user = t.originUser.unixUsername;
  const runBox = await prisma.instance.findUnique({ where: { id: m.instanceId }, select: { ec2InstanceId: true } });
  const rows = await prisma.agentThreadPr.findMany({ where: { threadId: t.id }, select: { key: true, prNumber: true } });
  const prNumbers: Record<string, number> = Object.fromEntries(rows.map(p => [p.key, p.prNumber]));
  if (prNumbers[''] == null && t.prNumber != null) prNumbers[''] = t.prNumber;
  const prDescriptions: Record<string, string> = { ...r.prDescriptions };
  if (r.prDescription) prDescriptions[''] = r.prDescription;
  // A thread on another PR (--update-pr, or one an earlier turn found) publishes its own branch there, while the checkout is that PR's repository.
  if (t.targetPr != null) {
    if (!t.targetRepo || t.targetRepo.toLowerCase() !== t.repo.toLowerCase()) {
      return { publish: 'refused', detail: `PR #${t.targetPr} is in ${t.targetRepo ?? 'an unknown repository'}, but the run's checkout pushes to ${t.repo}`, outcome: null };
    }
    prNumbers[''] = t.targetPr;
  }
  const outcome = await publishBundle(publishConfigFromEnv(), {
    bundle: Buffer.from(bundle.data),
    baseSha: t.baseSha,
    repo: t.repo,
    token,
    askerEmail: t.originUser.googleEmail,
    branchFor: key => askPrBranch(user, t.id, key),
    prBody: (description, key, onTarget) => prBody({
      senderUsername: user, target, threadId: t.id,
      box: runBox?.ec2InstanceId ?? m.instanceId, project: t.project.name, description,
      prKey: key || undefined,
      targetPr: onTarget,
    }),
    prDescriptions,
    prNumbers,
    ...(t.targetPr != null ? { target: { number: t.targetPr, askerUnix: user, firstPublish: !rows.some(p => p.key === '') } } : {}),
    // With no target and no PR of its own yet, the run's branch goes to the one open PR of the asker's it builds on.
    askerUnix: user,
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
          data: {
            branch: p.branch, prNumber: p.prNumber, prUrl: p.prUrl,
            // A PR the publish found the run builds on: later turns publish there too.
            ...(p.target ? { targetPr: p.target.number, targetRepo: t.repo, targetBranch: p.target.branch } : {}),
          },
        });
      }
    }
  }
  return { ...publishSummary(outcome), outcome };
}

/**
 * A run on a box with ask-push-v1 pushed and opened its PRs itself; the
 * branches its clone pushed, confirmed on GitHub (askPushes), become the
 * thread's PRs. A branch with no PR yet, or one GitHub doesn't have, is in
 * the detail; nothing is refused.
 */
async function recordPushes(messageId: string, pushes: NonNullable<RunResult['pushes']>): Promise<{ publish: string; detail: string | null }> {
  if (!pushes.length) return { publish: 'none', detail: null };
  const m = await prisma.agentMessage.findUnique({
    where: { id: messageId },
    select: { thread: { select: { id: true, repo: true, originUserId: true, targetBranch: true, prNumber: true, originUser: { select: { unixUsername: true } } } } },
  });
  if (!m) return { publish: 'failed', detail: 'the message disappeared before its pushes were recorded' };
  const t = m.thread;
  if (!t.repo) return { publish: 'failed', detail: "the target checkout has no GitHub origin, so termag can't look up what the run pushed" };
  const token = await githubTokenSource(t.originUserId).catch(() => null);
  if (!token) {
    return { publish: 'failed', detail: `${t.originUser.unixUsername} has no GitHub token stored in termag, so the run's pushes can't be looked up; connect GitHub in Settings` };
  }
  const prefix = askBranch(t.originUser.unixUsername, t.id);
  const rows = await prisma.agentThreadPr.findMany({ where: { threadId: t.id }, select: { key: true, branch: true } });
  const outcomes = await confirmPushes(githubConfigFromEnv(), {
    repo: t.repo, token, pushes, ownBranch: t.targetBranch ?? prefix, prefix, rows,
  });
  for (const o of outcomes) {
    if (o.kind !== 'recorded') continue;
    await prisma.agentThreadPr.upsert({
      where: { threadId_key: { threadId: t.id, key: o.key } },
      create: { threadId: t.id, key: o.key, branch: o.branch, prNumber: o.prNumber, prUrl: o.prUrl, headSha: o.headSha },
      update: { branch: o.branch, prNumber: o.prNumber, prUrl: o.prUrl, headSha: o.headSha },
    });
    if (o.key === '') {
      await prisma.agentThread.update({ where: { id: t.id }, data: { branch: o.branch, prNumber: o.prNumber, prUrl: o.prUrl } });
    }
  }
  const total = await prisma.agentThreadPr.count({ where: { threadId: t.id } });
  return pushSummary(outcomes, total);
}

async function finishRun(messageId: string, r: RunResult): Promise<void> {
  let pub: Awaited<ReturnType<typeof publishFor>>;
  try {
    pub = await publishFor(messageId, r);
  } catch (e) {
    pub = { publish: 'failed', detail: errMsg(e), outcome: null };
  }
  // Sealed before the transaction, since sealing calls KMS. A reply that can't
  // be sealed is not stored, and goes only to a waiting poll.
  const cfg = getTranscriptStoreConfig();
  let stored: SealedReply | null = null;
  if (cfg) {
    try {
      stored = await sealReply(cfg, messageId, r.result);
    } catch (e) {
      console.error(`[ASK] message ${messageId}: the reply could not be sealed, so it is not stored: ${errMsg(e)}`);
    }
  }
  // The stored reply and the NOTIFYs go in with the commit that marks the message
  // finished, so a poll that sees it finished on any process finds the reply there or about to be.
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
    ...(stored ? [storeReply(stored)] : []),
    ...chunkReply(messageId, r.result).map(p => prisma.$executeRaw`SELECT pg_notify(${REPLY_CHANNEL}, ${p})`),
  ]);
  holdReply(messageId, r.result);
  // The thread is free: a follow-up held behind this run goes now.
  kickQueue();
  await prisma.agentBundle.deleteMany({ where: { messageId } });
  const secs = m.startedAt ? Math.round((m.completedAt!.getTime() - m.startedAt.getTime()) / 1000) : null;
  console.log(
    `[ASK] message ${m.id} on thread ${m.threadId} (${targetOf(m)}) ${m.status} after ${secs ?? '?'}s, `
    + `${m.numTurns ?? '?'} turn(s), reply ${m.replyBytes ?? 0}B${stored ? ' (stored)' : ''}, publish ${pub.publish}`
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
async function replayAsk(m: MessageWithThread, branchOwner: string, notify: NoticeVia | null = null): Promise<RouteResult> {
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
      target: targetOf(m), branch: askBranch(branchOwner, m.threadId), replayed: true, replyKept: getTranscriptStoreConfig() != null,
      ...(m.queuedPrompt !== null ? { queued: true } : {}),
      // The stored message still tells its session, as the first 202 said (a `--no-wait` retry after a lost one).
      ...(notify ? { notify } : {}),
    },
  };
}


/** The last message of a superseded message's chain (each points at the follow-up that joined its turn). */
async function chainEnd(m: MessageWithThread): Promise<MessageWithThread> {
  let cur = m;
  for (let i = 0; i < 50 && cur.status === 'superseded' && cur.supersededById; i++) {
    const next = await loadMessage(cur.supersededById);
    if (!next || next.senderUserId !== m.senderUserId) break;
    cur = next;
  }
  return cur;
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

const runProjectSelect = {
  name: true, userId: true, setupStatus: true, setupError: true, layout: true, repoUrl: true, user: { select: { unixUsername: true } },
  repos: { select: { name: true, url: true }, orderBy: { position: 'asc' } },
  instance: { select: { id: true, name: true, hostHome: true, status: true, userId: true, kind: true, createdFor: true } },
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
  thread: {
    id: string; projectId: string; chatWorkstreamId: string | null; hopCount: number; claudeSessionId: string | null; baseSha: string | null; repoName: string | null;
    targetPr: number | null; targetRepo: string | null; targetBranch: string | null;
    parentProjectId?: string | null; parentWorkstream?: string | null; parentClaudeSession?: string | null;
  };
  message: { id: string; hop: number; promptBytes: number };
  workstream: string;
  prompt: string;
  /** The thread's working message to steer this one into (steerDecision said so). */
  steerOf?: string | null;
}

/**
 * Send a submitted turn to its box (`ask-run`) and mark it working. Resolves
 * to the status it ended in, or the error that failed it. With `steerOf`, the
 * box puts the turn into that message's running turn if it can (`steered`),
 * and that message is superseded; otherwise it runs after it.
 */
async function startRun(r: RunStart): Promise<{ status: string; steered?: boolean; steerRefused?: string | null; heldAsNextTurn?: boolean } | { error: string }> {
  const { sender, project, thread, message, instanceId } = r;
  const target = askTarget(project.instance.name, project.name, r.workstream, thread.repoName);
  const branch = askBranch(sender.unixUsername, thread.id);
  const cwd = askCwd(projectDirFor({ name: project.name, user: project.user, instance: project.instance }, r.workstream), thread.repoName);
  console.log(
    `[ASK] ${sender.unixUsername} (${r.senderInstanceId ? `box ${r.senderInstanceId}` : 'signed-in CLI'}) asked ${target}: thread ${thread.id}`
    + ` message ${message.id} hop ${message.hop}, prompt ${message.promptBytes}B`,
  );
  // On a box that can, the run is a turn of the thread's chat on the target
  // project (services/askChat.ts); otherwise, or if the chat cannot be made,
  // the headless run as before.
  let chat: AskChat | null = null;
  const caps = instanceAgentTransport(instanceId)?.capabilities ?? [];
  if (caps.includes(ASK_CHAT_CAPABILITY)) {
    try {
      chat = await ensureAskChat(thread);
    } catch (e) {
      console.warn(`[ASK] thread ${thread.id}: no chat for the run (${errMsg(e)}); running it headless`);
    }
  }
  // A live turn reads stdin as it runs, so a follow-up can be steered into it.
  const live = !!chat && caps.includes(ASK_STEER_CAPABILITY);
  // A follow-up meant for a working turn that can't be steered now (the chat could not be set up, the
  // box's agent changed) must not run beside it: it waits as the thread's next turn.
  if (r.steerOf && !live) {
    return holdAsNextTurn(message.id, r.prompt, r.steerOf, chat ? "the box's agent can no longer add a message to a running turn" : "the thread's chat could not be set up");
  }
  const steerOf = r.steerOf ?? null;
  // The run is a turn of the thread's chat: it loads that chat's own space, as the person's turns in it do.
  const memorySpace = chat && caps.includes(SPACE_MEMORY_CAPABILITY) ? await turnMemorySpace(chat.workstreamId) : undefined;
  // Who asked, for the turn's telemetry resource (services/askTelemetry.ts); only a chat turn carries it.
  const telemetry = chat ? await askTelemetryFor(thread, message.hop) : null;
  // A runner with ask-push-v1 clones normally and the run pushes itself, on the
  // thread's branch, or on the head branch of the PR the thread updates.
  const push = caps.includes(ASK_PUSH_CAPABILITY);
  const pushBranch = thread.targetPr != null && thread.targetBranch ? thread.targetBranch : branch;
  let answer: { steered?: unknown; reason?: unknown } | null = null;
  try {
    answer = await sendToInstanceAgent(instanceId, 'ask-run', {
      runId: message.id,
      threadId: thread.id,
      cwd,
      prompt: r.prompt,
      resumeSessionId: thread.claudeSessionId,
      baseSha: thread.baseSha,
      systemPrompt: runSystemPrompt({
        senderUsername: sender.unixUsername,
        senderDisplayName: sender.displayName,
        target,
        branch,
        checkout: cwd,
        targetPr: thread.targetPr != null && thread.targetRepo && thread.targetBranch
          ? { number: thread.targetPr, repo: thread.targetRepo, branch: thread.targetBranch, checkout: cwd }
          : null,
        push,
      }),
      ...(push ? { pushBranch } : {}),
      gitName: sender.displayName || sender.unixUsername,
      gitEmail: sender.googleEmail,
      // The project's name with the chat, for its telemetry resource (agent/chat-runner.js chatTelemetryEnv).
      ...(chat ? { chat: { ...chat, project: project.name } } : {}),
      ...(telemetry ? { telemetry } : {}),
      ...(memorySpace !== undefined ? { spaceMemory: { space: memorySpace } } : {}),
      ...(live ? { live: true } : {}),
      ...(steerOf ? { steerOf } : {}),
    }, START_RPC_MS);
  } catch (e) {
    const state = await runState(instanceId, message.id);
    const action = startFailureAction(state);
    // A steer whose answer was lost: the message it joined says so while the turn runs.
    if (action === 'adopt' && steerOf && (await runStatus(instanceId, steerOf)).supersededBy === message.id) answer = { steered: true };
    // One the box doesn't have was refused (or never arrived): it waits for the turn instead of failing.
    if (steerOf && state === 'gone') return holdAsNextTurn(message.id, r.prompt, steerOf, `${project.instance.name} did not take it into the running turn`);
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
  // Refused by the box's turn: nothing started there, so it waits at the orchestrator for that turn to end.
  if (steerOf && answer?.steered !== true && answer && (answer as { started?: unknown }).started === false) {
    return holdAsNextTurn(message.id, r.prompt, steerOf, steerRefusalText(typeof answer.reason === 'string' ? answer.reason : null));
  }
  const started = await prisma.agentMessage.updateMany({
    where: { id: message.id, status: 'submitted' },
    data: { status: 'working', startedAt: new Date(), queuedUntil: null },
  });
  wake(message.id);
  const steered = !!steerOf && answer?.steered === true;
  if (steerOf) {
    if (steered) await supersede(steerOf, message.id);
    else console.log(`[ASK] message ${message.id}: not steered into ${steerOf}'s turn (${typeof answer?.reason === 'string' ? answer.reason : 'no answer'}); it runs after it`);
  }
  const steerInfo = steerOf ? { steered, steerRefused: steered ? null : steerRefusalText(typeof answer?.reason === 'string' ? answer.reason : null) } : {};
  if (started.count) return { status: 'working', ...steerInfo };
  // Someone else moved the turn on while this start ran: a cancel (whose
  // stop found nothing to stop yet), or a retry's replay that settled it.
  const now = (await prisma.agentMessage.findUnique({ where: { id: message.id }, select: { status: true } }))?.status ?? 'canceled';
  if (now === 'canceled') void stopRun(instanceId, message.id);
  return { status: now };
}

/**
 * A submitted follow-up that can't join `behind`'s running turn becomes the
 * thread's next turn: queued with its prompt, sent by tickQueue once every
 * earlier message on the thread has ended (waitsForThread). Never a second
 * run beside a working one in the thread's clone.
 */
async function holdAsNextTurn(messageId: string, prompt: string, behind: string, why: string) {
  await prisma.agentMessage.updateMany({
    where: { id: messageId, status: 'submitted' },
    data: { queuedPrompt: prompt, queuedUntil: new Date(Date.now() + THREAD_QUEUE_TTL_MS) },
  });
  console.log(`[ASK] message ${messageId}: held as the next turn behind ${behind} (${why})`);
  // Its turn may have ended already: the queue sends it as soon as the thread is free, not on the next timer.
  kickQueue();
  return { status: 'submitted', steered: false, steerRefused: why, heldAsNextTurn: true };
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
      thread: {
        select: {
          id: true, projectId: true, chatWorkstreamId: true, hopCount: true, claudeSessionId: true, baseSha: true, repoName: true, targetPr: true, targetRepo: true, targetBranch: true,
          parentProjectId: true, parentWorkstream: true, parentClaudeSession: true,
        },
      },
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
  // A resize holds the box (services/boxResize.ts): it starts a box that was
  // running and leaves a stopped one stopped. Either way the ask waits, under
  // its own deadline, and a later tick starts the box once the resize is done.
  if (await openBoxEvent(box!.id, 'resize')) return;
  startRequestedAt.set(instanceId, now);
  const refused = powerRequestError(box, askerId, 'start', isBoxProvisioningConfigured());
  if (refused) {
    for (const id of ids) await failQueued(id, `termag could not start ${box!.name}: ${refused.error}`);
    return;
  }
  try {
    await requestPower(box!, 'start', { markInUse: true, startedBy: 'ask' });
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
    select: { id: true, instanceId: true, senderUserId: true, queuedUntil: true, projectId: true, threadId: true, createdAt: true },
  });
  // A follow-up queued as its thread's next turn waits for the turns before it.
  const threadActive = new Map<string, Array<{ id: string; createdAt: Date }>>();
  for (const a of rows.length ? await prisma.agentMessage.findMany({
    where: { threadId: { in: [...new Set(rows.map(r => r.threadId))] }, status: { in: ACTIVE_STATES } },
    select: { id: true, threadId: true, createdAt: true },
  }) : []) threadActive.set(a.threadId, [...(threadActive.get(a.threadId) ?? []), a]);
  const statuses = new Map((await prisma.instance.findMany({
    where: { id: { in: [...new Set(rows.map(r => r.instanceId))] } },
    select: { id: true, status: true },
  })).map(b => [b.id, b.status]));
  const projects = new Map((await prisma.project.findMany({
    where: { id: { in: [...new Set(rows.map(r => r.projectId))] } },
    select: { id: true, name: true, setupStatus: true, setupError: true },
  })).map(p => [p.id, p]));
  // A resize holds its box (services/boxResize.ts): it resumes a hibernated
  // box to ready before stopping it plainly, so a turn sent in that window
  // would be killed by the stop. Its asks wait, under their own deadlines.
  const resizing = await boxesWithOpenEvent([...statuses.keys()], 'resize');
  const waiting = new Map<string, { askerId: string; ids: string[] }>();
  for (const r of rows) {
    const parking = isParking(statuses.get(r.instanceId) ?? '');
    const project = projects.get(r.projectId) ?? null;
    const setupFailed = project && setupRefusal(project);
    if (waitsForThread(r, threadActive.get(r.threadId) ?? [])) {
      if (r.queuedUntil!.getTime() < now && await failQueued(r.id, THREAD_QUEUE_EXPIRED, { queuedUntil: { lt: new Date(now) } })) {
        console.log(`[ASK] queued message ${r.id} expired behind its thread's previous turn`);
      }
    } else if (setupFailed) {
      if (await failQueued(r.id, `${setupFailed.error}, so the ask never ran`)) {
        console.log(`[ASK] queued message ${r.id} failed: ${project.name}'s setup failed`);
      }
    } else if (r.queuedUntil!.getTime() < now) {
      const why = queueExpiryReason(project);
      if (await failQueued(r.id, why, { queuedUntil: { lt: new Date(now) } })) {
        console.log(`[ASK] queued message ${r.id} expired: ${why}`);
      }
    } else if (resizing.has(r.instanceId)) {
      // Being resized: a later tick sends it, or wakes the box, once the resize is done.
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
let tickAgain = false;
let offHello: (() => void) | null = null;

/**
 * Run the queue now, for a turn that can start: a follow-up just held as the
 * next turn, or a thread just freed (a run finished, was canceled or lost).
 * One tick at a time; a kick during one runs another after it, so nothing
 * that changed meanwhile waits for the 5 s timer, which stays the backstop.
 */
function kickQueue(): void {
  if (ticking) { tickAgain = true; return; }
  ticking = true;
  tickQueue().catch(e => console.error('[ASK] queue tick failed:', errMsg(e))).finally(() => {
    ticking = false;
    if (tickAgain) { tickAgain = false; kickQueue(); }
  });
}

export function startAskQueue(everyMs = QUEUE_TICK_MS): void {
  if (queueTimer) return;
  offHello = onBoxAgentHello(ev => {
    void ev.settled.then(() => tickQueue()).catch(e => console.error('[ASK] queue tick after a connect failed:', errMsg(e)));
  });
  queueTimer = setInterval(() => { if (!ticking) kickQueue(); }, everyMs);
  queueTimer.unref?.();
}

export function stopAskQueue(): void {
  if (queueTimer) { clearInterval(queueTimer); queueTimer = null; }
  offHello?.();
  offHello = null;
}

/**
 * The session an ask came from, checked (senderParentAllowed), or null: a new
 * thread is then shown on its own, and nobody is told when the message
 * finishes. `via` is how that session hears of the finish (noticeVia): its
 * chat, its agent pane, or null (a ctrl shell, `--no-notify`).
 */
async function askSession(user: CliUser, senderInstanceId: string | null, sender: AskSender | null, notify: boolean): Promise<{ projectId: string; workstream: string; via: NoticeVia | null } | null> {
  if (!sender) return null;
  let claim: { projectId: string; workstream: string } | null = null;
  if ('session' in sender) {
    const resolved = await resolveSessionProject(sender.session, senderInstanceId ?? undefined);
    if (resolved && !isAmbiguousSession(resolved) && resolved.projectId && resolved.workstream) {
      claim = { projectId: resolved.projectId, workstream: resolved.workstream };
    }
  } else {
    claim = sender;
  }
  if (!claim) return null;
  const project = await prisma.project.findUnique({
    where: { id: claim.projectId },
    select: { name: true, userId: true, archived: true, instanceId: true, kind: true, workstreams: { select: { name: true, archived: true, askThread: { select: { id: true } } } } },
  });
  if (!project || !senderParentAllowed(project, claim.workstream, user.id, senderInstanceId)) return null;
  // The sessions noticeDecision settles as `skipped` (an automation's run, an ask's own chat)
  // are never told, so the ask must not promise them a notice.
  const askChat = !('session' in sender) && !!project.workstreams.find(w => w.name === claim.workstream)?.askThread;
  const told = notify && project.kind !== 'automation' && !askChat;
  const via = noticeVia('session' in sender
    ? { kind: 'pane', session: sender.session, agentPane: sessionName(user.unixUsername, project.name, 'agent', claim.workstream) }
    : { kind: 'chat' }, told);
  return { ...claim, via };
}

/**
 * A poll got a finished message: its sender is waiting on it, so the finish
 * notice is not sent (AgentMessage.notice `waiter`). A poll on a superseded
 * message answered together also covers the follow-up, when the follow-up
 * would tell the same session.
 */
async function markSeen(asked: MessageWithThread, answeredWith: MessageWithThread | null): Promise<void> {
  const ids = [asked.id];
  if (answeredWith && answeredWith.notifyVia === asked.notifyVia
    && answeredWith.notifyProjectId === asked.notifyProjectId && answeredWith.notifyWorkstream === asked.notifyWorkstream) ids.push(answeredWith.id);
  const pending = [asked, ...(answeredWith ? [answeredWith] : [])].some(m => ids.includes(m.id) && m.notifyVia && !m.notifiedAt);
  if (!pending) return;
  await prisma.agentMessage.updateMany({ where: { id: { in: ids }, notifiedAt: null }, data: { notifiedAt: new Date(), notice: 'waiter' } })
    .catch(e => console.warn(`[ASK] message ${asked.id}: could not note its waiter:`, errMsg(e)));
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
      const d = replayDecision({ ...existing, repo: existing.thread.repoName }, { userId: user.id, projectId: access.project.id, workstream: req.workstream, repo: req.repo, threadId: req.threadId, promptBytes });
      if (d === 'taken') return fail(409, 'That message id is already in use; send a new one', 'id_in_use');
      if (d === 'different') return fail(409, 'That message id already names a different ask; send a new one', 'id_reused');
      const notifyVia = (existing.notifyVia as NoticeVia | null) ?? null;
      const notify = notifyVia && existing.notice !== 'failed' && await boolVariation(ASK_NOTICE_FLAG, { ...user, defaultAgentProvider: '' }, false) ? notifyVia : null;
      return replayAsk(existing, user.unixUsername, notify);
    };
    const replayed = await replayOf();
    if (replayed) return replayed;

    const instanceId = project.instance?.id ?? null;
    if (!instanceId || !project.instance) return rejection(409, 'That project is not on a box; asks run on boxes only', 'no_box', req);
    const workspace = isWorkspace(project);
    const checkout = repoTarget(
      { workspace, repos: project.repos.map(r => r.name), target: askTarget(project.instance.name, project.name, req.workstream) },
      req.repo,
      workspace && await multiRepoEnabled({ ...user, defaultAgentProvider: '' }),
    );
    if ('error' in checkout) return rejection(409, checkout.error, checkout.code, req, checkout.repos ? { repos: checkout.repos } : {});
    const repoName = checkout.repo;
    const target = askTarget(project.instance.name, project.name, req.workstream, repoName);

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

    let prior = null;
    let steerOf: string | null = null;
    // Not steerable: held as the thread's next turn (tickQueue sends it once the turns before it end).
    let queueBehind: { id: string; reason: string } | null = null;
    if (req.threadId) {
      prior = await prisma.agentThread.findUnique({ where: { id: req.threadId } });
      if (!prior || prior.originUserId !== user.id) return fail(404, 'Thread not found', 'not_found');
      if (prior.projectId !== access.project.id || prior.workstream !== req.workstream || (prior.repoName ?? null) !== repoName) {
        return fail(409, 'That thread talks to another project, workstream or repository', 'thread_mismatch');
      }
      // The newest active one: a follow-up steers into the turn the thread's latest message is in.
      const busy = await prisma.agentMessage.findFirst({
        where: { threadId: prior.id, status: { in: ACTIVE_STATES } },
        select: { id: true, instanceId: true, status: true, createdAt: true, queuedUntil: true, queuedPrompt: true },
        orderBy: { createdAt: 'desc' },
      });
      if (busy) {
        // A turn still inside its start RPC, or queued for its box, has no runner on the box yet.
        // Unknown counts as running, so a thread is never handed a second concurrent turn by mistake.
        const busyRun = stillStarting(busy, Date.now()) ? null : await runStatus(busy.instanceId, busy.id);
        if (!busyRun || busyRun.state !== 'gone') {
          const busyBox = instanceAgentTransport(busy.instanceId);
          const steer = steerDecision(
            { id: busy.id, status: busy.status, queued: busy.queuedPrompt !== null },
            {
              box: project.instance.name,
              connected: !!busyBox && !waitsForBox,
              capable: !!busyBox && busyBox.capabilities.includes(ASK_STEER_CAPABILITY) && busyBox.capabilities.includes(ASK_CHAT_CAPABILITY),
              liveTurn: busyRun?.live === true,
            },
          );
          if (steer.kind === 'queue') queueBehind = { id: busy.id, reason: steer.reason };
          else steerOf = busy.id;
        } else {
          await finishLost(busy.id, 'lost: the run was no longer running on the box', busy.status as MessageStatus);
        }
      }
    }

    // --update-pr: checked now and remembered. A follow-up keeps the thread's, and may name one only
    // while the thread has published nothing (to pick a PR from a stack the publish refused).
    let targetPr: { number: number; repo: string; branch: string } | null = null;
    const sameTarget = !!prior && !!req.targetPr && prior.targetPr === req.targetPr.number
      && (!req.targetPr.repo || prior.targetRepo?.toLowerCase() === req.targetPr.repo.toLowerCase());
    if (prior && req.targetPr && !sameTarget && (prior.targetPr != null || prior.prNumber != null)) {
      return rejection(409, prior.targetPr != null
        ? `That thread publishes to PR #${prior.targetPr}; start a new thread to publish to another`
        : `That thread publishes to its own PR #${prior.prNumber}; start a new thread with --update-pr`, 'thread_mismatch', req);
    }
    if (req.targetPr && !sameTarget) {
      const checkoutUrl = repoName ? project.repos.find(r => r.name === repoName)?.url ?? null : project.repoUrl;
      const t = await targetForAsk(user, req, checkoutUrl);
      if ('status' in t) return t;
      targetPr = t;
    }

    // Who sent it: the thread's parent on a new thread, and on every message the session told when it finishes.
    const from = await askSession(user, senderInstanceId, req.sender, req.notify);
    const parent = prior ? null : from;
    let queued = false;
    const queueUntil = () => new Date(Math.max(
      queuedDeadline({ box: waitsForBox, setup: waitsForSetup }, Date.now()).getTime(),
      queueBehind ? Date.now() + THREAD_QUEUE_TTL_MS : 0,
    ));

    // The thread's hop and the message land together, so a retry racing the
    // first POST (same id) leaves no extra hop or empty thread behind. The
    // per-person lock makes the cap hold against asks sent at the same time.
    let created;
    try {
      created = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ask:${user.id}`}))`;
        // Only the thread's starter adds to it, so this lock orders every follow-up on it: what was
        // read before it (the hop, the busy message) may be stale, and is read again here.
        let current = prior;
        if (prior) {
          current = await tx.agentThread.findUnique({ where: { id: prior.id } }) ?? prior;
          const newest = await tx.agentMessage.findFirst({
            where: { threadId: prior.id, status: { in: ACTIVE_STATES } },
            select: { id: true },
            orderBy: { createdAt: 'desc' },
          });
          if (newest && newest.id !== (steerOf ?? queueBehind?.id)) {
            // Another follow-up landed in between: never beside it, and never into a turn it may have joined.
            steerOf = null;
            queueBehind = { id: newest.id, reason: `another follow-up on the thread (${newest.id}) was sent at the same time` };
          }
        }
        queued = waitsForBox || waitsForSetup || !!queueBehind;
        const active = await tx.agentMessage.count({ where: { senderUserId: user.id, status: { in: ACTIVE_STATES } } });
        // A follow-up that joins a running turn starts no turn of its own: the message it joins stops counting.
        const capped = capRefusal(steerOf ? active - 1 : active);
        if (capped) return { capped };
        let thread;
        if (current) {
          const bumped = await tx.agentThread.updateMany({
            where: { id: current.id, hopCount: current.hopCount },
            data: { hopCount: { increment: 1 } },
          });
          if (bumped.count === 0) return null;
          thread = { ...current, hopCount: current.hopCount + 1 };
          if (targetPr) {
            const named = { targetPr: targetPr.number, targetRepo: targetPr.repo, targetBranch: targetPr.branch };
            await tx.agentThread.update({ where: { id: current.id }, data: named });
            thread = { ...thread, ...named };
          }
          // A follow-up keeps the thread's title unless it names one (--title sets or renames it).
          if (req.title && req.title !== current.title) {
            await tx.agentThread.update({ where: { id: current.id }, data: { title: req.title } });
            thread = { ...thread, title: req.title };
          }
        } else {
          thread = await tx.agentThread.create({
            data: {
              originUserId: user.id, projectId: access.project.id, workstream: req.workstream, repoName, instanceId, hopCount: 1,
              // The caller's name for the thread, or none: nothing is taken from the prompt.
              title: req.title,
              ...(parent ? { parentProjectId: parent.projectId, parentWorkstream: parent.workstream } : {}),
              // The asking Claude Code conversation, for the thread's telemetry (services/askTelemetry.ts).
              ...(req.senderClaudeSession ? { parentClaudeSession: req.senderClaudeSession } : {}),
              ...(targetPr ? { targetPr: targetPr.number, targetRepo: targetPr.repo, targetBranch: targetPr.branch } : {}),
              // `termag ask --new-box` made its box for it: the box (and so its project) is this thread's.
              ...(req.newBox && project.instance?.createdFor === 'ask' ? { newBox: true } : {}),
            },
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
            // The checked sender always (an automation's "asks my runs sent"); `via` only when it may be told.
            ...(from ? { notifyProjectId: from.projectId, notifyWorkstream: from.workstream, ...(from.via ? { notifyVia: from.via } : {}) } : {}),
            ...(queued ? { queuedPrompt: req.prompt, queuedUntil: queueUntil() } : {}),
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
    const branch = thread.targetBranch ?? askBranch(user.unixUsername, thread.id);
    // Whether this session will hear of the finish, so the CLI can say it need not poll (askNoticeSweep.ts decides again then).
    const notify = from?.via && await boolVariation(ASK_NOTICE_FLAG, { ...user, defaultAgentProvider: '' }, false) ? from.via : null;
    const reply = (status: string, steer: { steered?: boolean; steerRefused?: string | null; heldAsNextTurn?: boolean } = {}) => ({
      status: 202,
      body: {
        thread: thread.id, title: thread.title ?? null, message: message.id, status, hop: message.hop, hops: thread.hopCount, target, branch,
        // The reply will be stored, so `termag ask --reply` reads it after the fact.
        replyKept: getTranscriptStoreConfig() != null,
        ...(thread.targetPr != null ? { targetPr: thread.targetPr } : {}),
        ...(notify ? { notify } : {}),
        ...(queued ? { queued: true, queuedFor: queueBehind ? 'turn' : waitsForBox ? 'box' : 'setup' } : {}),
        ...(steer.heldAsNextTurn ? { queued: true, queuedFor: 'turn' } : {}),
        ...(queueBehind ? { steered: false, queuedBehind: queueBehind.id, steerRefused: queueBehind.reason } : {}),
        // Steered: in the running turn of `supersedes`, which it supersedes. Else it runs after `queuedBehind`.
        ...(steerOf && steer.steered ? { steered: true, supersedes: steerOf } : {}),
        ...(steerOf && steer.steered === false ? { steered: false, queuedBehind: steerOf, ...(steer.steerRefused ? { steerRefused: steer.steerRefused } : {}) } : {}),
      },
    });
    if (queued) {
      const until = [
        ...(queueBehind ? [`the thread's previous turn (${queueBehind.id}) ends`] : []),
        ...(waitsForBox ? [`${project.instance.name} connects (${project.instance.status})`] : []),
        ...(waitsForSetup ? [`${project.name} is set up (${project.setupStatus})`] : []),
      ].join(' and ');
      console.log(
        `[ASK] ${user.unixUsername} (${senderInstanceId ? `box ${senderInstanceId}` : 'signed-in CLI'}) asked ${target}: thread ${thread.id}`
        + ` message ${message.id} hop ${message.hop}, prompt ${message.promptBytes}B, queued until ${until}`,
      );
      kickQueue();
      return reply('submitted');
    }
    const started = await startRun({
      sender: user, senderInstanceId,
      project: { ...project, instance: project.instance }, instanceId, thread, message, workstream: req.workstream, prompt: req.prompt,
      steerOf,
    });
    if ('error' in started) return fail(502, started.error, 'box_error');
    return reply(started.status, started);
  },

  async getMessage(user, messageId, waitSec) {
    const deadline = Date.now() + waitSec * 1000;
    for (;;) {
      const asked = await loadMessage(messageId);
      if (!asked || asked.senderUserId !== user.id) return fail(404, 'Message not found', 'not_found');
      // Superseded, answered together: wait on the last message of its chain, and answer with that one's reply.
      const f = asked.status === 'superseded' && supersededReplyMode() === 'together' ? await chainEnd(asked) : null;
      const m = f ?? asked;
      const view = (row: MessageWithThread, reply: string | null) => (f
        ? { ...askView(answeredTogether(asked, row), asked.thread, targetOf(asked), reply), answeredWith: row.id }
        : askView(row, row.thread, targetOf(row), reply));
      const left = deadline - Date.now();
      if (isTerminal(m.status)) {
        // This poll sees the finish, so its session needs no notice of it (askNoticeSweep.ts).
        await markSeen(asked, f);
        // Just after the finish this process may not have the NOTIFY yet: the stored copy is cut at
        // ASK_REPLY_MAX_BYTES, so a cut one (or none) waits out the settle for the full text first.
        const settling = m.replyBytes !== null && m.completedAt !== null && Date.now() - m.completedAt.getTime() < SETTLE_MS
          && (m.storedReply ? m.storedReply.truncated : m.readAt === null);
        // The held copy first (no KMS call), then the stored one.
        const held = m.replyBytes === null ? null : handoff.get(m.id);
        const reply = held ?? (m.storedReply && !(settling && left > 0) ? await storedReplyOf(m.id) : null);
        if (reply !== null) {
          // Any poll inside the hand-off window or the store's 14 days gets the text, so a
          // response lost on the way (a deploy's 502) is answered again by the retry.
          // Counted on the message whose reply it is, so a reply answered together is read once.
          const readAt = m.readAt ?? new Date();
          if (!m.readAt) await prisma.agentMessage.updateMany({ where: { id: m.id, readAt: null }, data: { readAt } });
          return { status: 200, body: view({ ...m, readAt }, reply) };
        }
        if (settling && left > 0) { await waitFor(m.id, Math.min(left, 500)); continue; }
        return { status: 200, body: view(m, null) };
      }
      if (left <= 0) return { status: 200, body: view(m, null) };
      // The asked message too: a supersede wakes its waiters, which then wait on the chain's end.
      await Promise.race([waitFor(m.id, Math.min(left, 2000)), ...(m.id !== asked.id || isTerminal(asked.status) ? [] : [waitFor(asked.id, Math.min(left, 2000))])]);
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
    return { status: 200, body: { messages: rows.map(m => askView(m, m.thread, targetOf(m), null)) } };
  },

  async cancel(user, messageId) {
    const m = await loadMessage(messageId);
    if (!m) return fail(404, 'Message not found', 'not_found');
    const d = cancelDecision({ status: m.status, resultAt: m.resultAt, senderUserId: m.senderUserId, projectOwnerId: m.thread.project.userId, supersededById: m.supersededById }, user.id);
    if (d.kind === 'not_found') return fail(404, 'Message not found', 'not_found');
    if (d.kind === 'finished') return fail(409, `Can't cancel: ${d.why}`, 'finished');
    if (d.kind === 'already') return { status: 200, body: { ...askView(m, m.thread, targetOf(m), null), stop: null } };
    // resultAt: null is the race with the box's result: whichever lands first wins.
    const canceled = await prisma.agentMessage.updateMany({
      where: { id: m.id, status: { in: ACTIVE_STATES }, resultAt: null },
      data: { status: 'canceled', completedAt: new Date(), error: `canceled by ${user.unixUsername}`, queuedPrompt: null, queuedUntil: null },
    });
    if (canceled.count === 0) return prismaCliAsk.cancel(user, messageId);
    wake(m.id);
    kickQueue();
    await prisma.agentBundle.deleteMany({ where: { messageId: m.id } });
    const started = await prisma.agentMessage.findUnique({ where: { id: m.id }, select: { startedAt: true } });
    const stop = cancelShouldStop({ status: m.status, startedAt: started?.startedAt ?? null })
      ? await stopRun(m.instanceId, m.id)
      : { stopped: false, detail: m.queuedPrompt !== null ? 'it was still waiting for its box to start or its project to be set up' : 'the run had not started' };
    console.log(`[ASK] message ${m.id} on thread ${m.threadId} (${targetOf(m)}) canceled by ${user.unixUsername}: ${stop.detail}`);
    const after = await loadMessage(m.id);
    return { status: 200, body: { ...askView(after ?? m, m.thread, targetOf(m), null), stop } };
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
        id: true, name: true, description: true, userId: true, setupStatus: true, setupError: true, layout: true,
        user: { select: { unixUsername: true } },
        repos: { select: { name: true }, orderBy: { position: 'asc' } },
        instance: { select: { id: true, name: true, status: true, hostHome: true, kind: true, userId: true } },
        // An ask's own chat is not something to ask (services/askChat.ts).
        workstreams: { where: { archived: false, askThread: null }, select: { name: true, sessionTitle: true }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: [{ instance: { name: 'asc' } }, { name: 'asc' }],
    });
    const configured = isBoxProvisioningConfigured();
    const multiRepoOn = projects.some(isWorkspace) && await multiRepoEnabled({ ...user, defaultAgentProvider: '' });
    const cards = await Promise.all(projects.map(async p => {
      const box = p.instance!;
      const transport = isParking(box.status) ? null : instanceAgentTransport(box.id);
      const description = p.description?.trim() || (transport
        ? await agentsMdDescription(box.id, projectDirFor({ name: p.name, user: p.user, instance: box }, 'main'))
        : null);
      const workstreams = p.workstreams.length ? p.workstreams : [{ name: 'main', sessionTitle: null }];
      // A multi-repo project is asked one repository at a time: a card for each.
      const repos: Array<string | null> = isWorkspace(p) && multiRepoOn ? p.repos.map(r => r.name) : [null];
      return workstreams.flatMap(({ name: workstream, sessionTitle }) => repos.map(repo => {
        const checkout = repoTarget({ workspace: isWorkspace(p), repos: p.repos.map(r => r.name), target: askTarget(box.name, p.name, workstream) }, repo, multiRepoOn);
        return targetCard({
          projectId: p.id, box: box.name, project: p.name, workstream, repo, sessionTitle,
          refused: 'error' in checkout ? checkout.error : null,
          owner: p.user.unixUsername, shared: false, description,
          boxStatus: box.status, connected: !!transport,
          capabilities: transport?.capabilities ?? [],
          wakes: !transport && shouldQueue(box, user.id, configured),
          setupStatus: p.setupStatus, setupError: p.setupError,
        });
      }));
    }));
    // The caller's ask threads that have a chat, the sessions the simple UI lists for them, so
    // `termag ask --find` finds one by its title; a follow-up on the thread talks to that session.
    const threads = await prisma.agentThread.findMany({
      where: {
        originUserId: user.id,
        chatWorkstream: { archived: false },
        project: { archived: false, userId: user.id, instance: { userId: user.id } },
      },
      select: {
        id: true, title: true, workstream: true, repoName: true, updatedAt: true,
        chatWorkstream: { select: { sessionTitle: true } },
        project: { select: { name: true, instance: { select: { name: true } } } },
      },
      orderBy: { updatedAt: 'desc' },
      take: MAX_LISTED_THREADS,
    });
    return {
      status: 200,
      body: {
        agents: cards.flat(),
        threads: threads.flatMap(t => (t.project.instance ? [threadTarget({
          id: t.id, title: t.title, sessionTitle: t.chatWorkstream?.sessionTitle ?? null, updatedAt: t.updatedAt,
          box: t.project.instance.name, project: t.project.name, workstream: t.workstream, repoName: t.repoName,
        })] : [])),
      },
    };
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
  const replies = await sweepReplies(now);
  // An ended turn never needs its prompt; a race with a cancel or a crash can leave one.
  await prisma.agentMessage.updateMany({
    where: { status: { notIn: ACTIVE_STATES }, OR: [{ queuedPrompt: { not: null } }, { queuedUntil: { not: null } }] },
    data: { queuedPrompt: null, queuedUntil: null },
  });
  if (bundles.count || stuck.length || lost || replies) {
    console.log(`[ASK] retention: ${bundles.count} bundle(s) removed; ${stuck.length} interrupted publish(es) closed; ${lost} lost run(s) failed; ${replies} stored repl(ies) past 14 days deleted`);
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
    const seen: { supersededBy: string | null } = { supersededBy: null };
    const why = await lostRunReason(boxes.get(q.instanceId) ?? null, async () => {
      const st = await runStatus(q.instanceId, q.id);
      seen.supersededBy = st.supersededBy;
      return st.state !== 'gone';
    });
    // Not lost: a follow-up went into its turn, and the steer's answer never reached us.
    if (seen.supersededBy && q.status === 'working' && await supersede(q.id, seen.supersededBy)) continue;
    if (!why) continue;
    const r = await prisma.agentMessage.updateMany({
      where: { id: q.id, status: q.status, resultAt: null },
      data: { status: 'failed', error: why, completedAt: now, queuedUntil: null },
    });
    if (r.count) { closed++; wake(q.id); }
  }
  if (closed) kickQueue();
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
  const sweep = traceSweep('ask', () => sweepAsks());
  sweepTimer = setInterval(() => sweep().catch(e => console.error('[ASK] sweep failed:', errMsg(e))), everyMs);
  sweepTimer.unref?.();
}

export function stopAskSweep(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
