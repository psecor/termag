/**
 * Continue a stored chat on a new box after its box was terminated.
 *
 *   - Offer: a chat whose box is terminated (or that has no box) and whose
 *     stored session is whole offers "Continue on a new box" to its owner. A
 *     stopped or hibernated box offers "Start the box" instead: a chat is
 *     never forked while its box exists.
 *   - Continue: a fresh box for the owner, made as New project's "a new box…"
 *     makes one (createBox: the warm pool when the owner's spec matches, else a
 *     cold launch). The project moves onto it and clones its repo again, its
 *     space listings become grants of the new box (the spaces the old box
 *     reached it through, nothing more), and one chat_resumes row per chat
 *     names the session to restore.
 *   - Restore: once the new box's agent is up, the session's raw JSONL goes
 *     from the store to the box in pieces (chat-session-restore,
 *     agent/chat-runner.js restoreSession), into Claude Code's session
 *     location there, so the next turn runs `claude --resume <id>`.
 *   - Notice: the first turn there carries NEW_BOX_NOTICE and the old box's
 *     last git state (chatGitState.ts) in its message, once.
 *
 * A session whose stored raw copy is not whole (past CHAT_TRANSCRIPT_RAW_CAP,
 * or with a line the box would not read) is refused: a resume from part of
 * it would fork the stored copy and lose its tail.
 */

import { prisma } from '../db';
import { isChatRunnerProvider } from '../providers/registry';
import { instanceAgentTransport, onBoxAgentHello, sendToInstanceAgent } from './agentRegistry';
import { CHAT_BOX_NOTICE_CAPABILITY, chatKeyFor, onChatEvent } from './chatRunner';
import { describeGitState, parseGitState } from './chatGitState';
import { getTranscriptStoreConfig, storedRawChunks, storedRawOf, type TranscriptStoreConfig } from './chatTranscriptStore';
import { projectDirFor } from './tmux';
import { isValidBoxName } from './boxNames';
import { acquireContinueLock, continueUnderWay, releaseContinueLock } from './chatContinueLock';
import { claimUpdateRunning, claimUpdateSettled } from './claimUpdateGate';
import { traceSweep } from './tracing/spans';

export { CHAT_BOX_NOTICE_CAPABILITY };
export { continueUnderWay };
export const CHAT_RESTORE_CAPABILITY = 'chat-restore-v1';
export const NEW_BOX_NOTICE = 'This conversation continues on a new box; the previous box was terminated. Its disk is gone: uncommitted changes, unpushed branches, files outside the repo, and anything installed. Check `git status` and GitHub before assuming earlier work exists.';
/** Raw bytes per chat-session-restore request (base64 makes it a third larger on the socket). */
const RESTORE_PIECE_BYTES = 2 * 1024 * 1024;
const RESTORE_TIMEOUT_MS = 60_000;

export type NewBoxOffer =
  | { offer: 'new-box' }
  | { offer: 'start-box'; boxId: string }
  /** A Continue is under way (chatContinueLock.ts): the chat shows it in progress. */
  | { offer: 'continuing' }
  | { offer: null; code: 'owner-only' | 'incomplete' | 'self-managed'; reason: string };

/**
 * What a stored chat offers, or null when it offers nothing (an ask's chat,
 * a box that is up or on its way). Pure: routes/chat.ts reads
 * the facts.
 */
export function newBoxOffer(f: {
  isOwner: boolean;
  ask: boolean;
  box: { id: string; status: string; kind: string } | null;
  /** The stored session's raw copy is whole (storedRawOf). */
  complete: boolean;
  /** Another Continue holds the chat's lock. */
  continuing?: boolean;
  /** The box is one a continue made for this chat: if it failed to launch, it is as gone as a terminated one. */
  resumedOnto?: boolean;
}): NewBoxOffer | null {
  if (f.ask) return null;
  const raw = f.box?.status ?? 'terminated';
  const status = raw === 'failed' && f.resumedOnto ? 'terminated' : raw;
  if (status === 'stopped' || status === 'hibernated') {
    if (!f.box) return null;
    // Starting a box is its owner's (POST /api/instances/:id/start): anyone else is told why, with no button.
    return f.isOwner ? { offer: 'start-box', boxId: f.box.id } : { offer: null, code: 'owner-only', reason: "This chat's box is stopped. Only its owner can start it." };
  }
  if (status !== 'terminated') return null;
  if (!f.isOwner) return { offer: null, code: 'owner-only', reason: "Only the chat's owner can continue it on a new box." };
  if (f.continuing) return { offer: 'continuing' };
  if (f.box?.kind === 'external') return { offer: null, code: 'self-managed', reason: 'This chat ran on a self-managed host. Connect that host again to continue it.' };
  if (!f.complete) {
    return { offer: null, code: 'incomplete', reason: 'The saved copy of this conversation is incomplete (it grew past what is kept), so it cannot continue on a new box. It stays readable here.' };
  }
  return { offer: 'new-box' };
}

/** A workstream of the project that stays behind (v1 brings only main): its name and last git state. */
export interface LostWorkstream { name: string; gitState: unknown }

function lostWorkstreamsOf(v: unknown): LostWorkstream[] {
  return Array.isArray(v) ? v.filter((w): w is LostWorkstream => w != null && typeof (w as LostWorkstream).name === 'string') : [];
}

/**
 * The longest notice the agent takes (agent/box-notice.js MAX_NOTICE). A
 * longer one is dropped there, so the notice is cut to fit here.
 */
export const NEW_BOX_NOTICE_MAX = 4096;

/** Text from a branch or workstream name can't close <termag-box-notice> early, or the agent drops it. */
const defuse = (t: string) => t.replace(/[<>]/g, '');

/** The first message on the new box opens with this (agent/box-notice.js puts it in <termag-box-notice>). */
export function newBoxNotice(gitState: unknown, lostWorkstreams: unknown = null): string {
  // The warning and the main checkout's state always fit: the git state is under 1 KiB.
  let out = defuse(`${NEW_BOX_NOTICE}\n${describeGitState(parseGitState(gitState))}`).slice(0, NEW_BOX_NOTICE_MAX);
  const lost = lostWorkstreamsOf(lostWorkstreams);
  if (!lost.length) return out;
  // Counted, not named: a workstream's name is free text, and the notice is hidden from the person.
  const head = `\n${plural(lost.length, 'other workstream')} did not come along: ${lost.length === 1 ? 'its worktree' : 'their worktrees'} and everything not pushed in ${lost.length === 1 ? 'it' : 'them'} are lost.`;
  // Room for the closing "and N more" line, whatever N is.
  const tail = (k: number) => `\n- and ${k} more.`;
  const room = NEW_BOX_NOTICE_MAX - tail(lost.length).length;
  if (out.length + head.length > room) return out;
  out += head;
  let shown = 0;
  for (const w of lost) {
    const s = parseGitState(w.gitState);
    const line = `\n- one: ${s ? describeGitState(s).replace(/^Last state on the old box: /, '') : 'no git state was recorded.'}`;
    if (out.length + line.length > room) break;
    out += line;
    shown += 1;
  }
  return shown < lost.length ? out + tail(lost.length - shown) : out;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Pieces of at most `max` bytes, each with its offset in the session. */
export function* restorePieces(chunks: Iterable<Buffer>, max = RESTORE_PIECE_BYTES): Generator<{ from: number; data: Buffer }> {
  let from = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += max) {
      const data = chunk.subarray(i, i + max);
      yield { from, data };
      from += data.length;
    }
  }
}

const OWNER_SELECT = { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true } as const;

type Result = { status: number; body: unknown };

/** A free box name near `base`: itself, else base-2, base-3, … */
async function freeBoxName(userId: string, base: string): Promise<string> {
  const stem = (isValidBoxName(base) ? base : 'chat').slice(0, 40);
  for (let n = 1; n < 50; n++) {
    const name = n === 1 ? stem : `${stem}-${n}`;
    const taken = await prisma.instance.findFirst({ where: { userId, name, status: { not: 'terminated' } }, select: { id: true } });
    if (!taken) return name;
  }
  return `${stem}-${Date.now().toString(36)}`;
}

/**
 * POST /api/projects/:id/chat/continue: the owner continues a chat whose box
 * was terminated on a new box. Answers 202 with the new box; the chat then
 * sets up as a new one does, and its history is restored once the box is up.
 */
export async function continueOnNewBoxFor(user: Express.User, projectId: string, workstreamRaw: unknown): Promise<Result> {
  const cfg = getTranscriptStoreConfig();
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, name: true, userId: true, archived: true, instanceId: true,
      instance: { select: { id: true, name: true, status: true, kind: true } },
      user: { select: OWNER_SELECT },
      workflows: { where: { type: 'agent' }, select: { provider: true, workstream: { select: { id: true, name: true, askThread: { select: { id: true } } } } } },
    },
  });
  // Owner only: a share or a space member may read the chat, not move it.
  if (!project || project.userId !== user.id) return { status: 404, body: { error: 'Chat not found' } };
  if (!cfg) return { status: 404, body: { error: 'Continuing a chat on a new box is not available', code: 'resume-off' } };
  if (project.archived) return { status: 409, body: { error: 'Reopen the chat first', code: 'archived' } };
  const workstream = typeof workstreamRaw === 'string' && workstreamRaw ? workstreamRaw : 'main';
  // v1 brings the project's main chat and checkout; its other workstreams are named as lost.
  if (workstream !== 'main') return { status: 409, body: { error: "Only a project's main chat continues on a new box", code: 'not-main' } };
  const workflow = project.workflows.find(w => w.workstream.name === workstream);
  if (!workflow || !isChatRunnerProvider(workflow.provider) || workflow.workstream.askThread) {
    return { status: 409, body: { error: 'Only a simple-UI chat continues on a new box', code: 'not-a-chat' } };
  }
  const raw = await storedRawOf(project.id, workflow.workstream.id);
  const resumedOnto = project.instance?.status === 'failed'
    && await prisma.chatResume.count({ where: { workstreamId: workflow.workstream.id, toInstanceId: project.instance.id } }) > 0;
  const offer = newBoxOffer({ isOwner: true, ask: false, box: project.instance, complete: raw?.complete === true, resumedOnto });
  if (!raw || !offer || offer.offer !== 'new-box') {
    if (offer?.offer === 'start-box') return { status: 409, body: { error: 'The box still exists: start it instead', code: 'box-exists' } };
    if (offer && offer.offer === null) return { status: 409, body: { error: offer.reason, code: offer.code } };
    if (!raw) return { status: 409, body: { error: 'Nothing of this chat is stored', code: 'nothing-stored' } };
    return { status: 409, body: { error: 'The box still exists', code: 'box-exists' } };
  }

  // One Continue per chat, across orchestrator processes: the second click is told it is under way.
  const token = await acquireContinueLock(project.id);
  if (!token) return { status: 409, body: { error: 'This chat is already continuing on a new box.', code: 'continuing' } };
  try {
    return await continueLocked(user, project, workflow.workstream, raw);
  } finally {
    await releaseContinueLock(project.id, token).catch(err => {
      console.error(`[RESUME] ${project.id}: continue lock not released, it goes stale: ${(err as Error).message}`);
    });
  }
}

async function continueLocked(
  user: Express.User,
  project: { id: string; name: string; instanceId: string | null; instance: { name: string } | null },
  main: { id: string },
  raw: NonNullable<Awaited<ReturnType<typeof storedRawOf>>>,
): Promise<Result> {
  // Loaded here: the box routes pull in the provisioner and the warm pool.
  const { createBox } = await import('../routes/instances');
  const created = await createBox(user, { name: await freeBoxName(user.id, project.instance?.name ?? project.name), kind: 'ec2' });
  if (created.status !== 201) return created;
  const fresh = (created.body as { instance: { id: string; name: string } }).instance;

  // The main chat comes along. The other workstreams' worktrees don't (v1):
  // the notice names them, with what each one's last turn end recorded.
  const mainRow = await prisma.chatTranscript.findUnique({
    where: { projectId_workstreamId_sessionId: { projectId: project.id, workstreamId: main.id, sessionId: raw.sessionId } },
    select: { gitState: true },
  });
  const others = await prisma.workstream.findMany({ where: { projectId: project.id, NOT: { id: main.id } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  const lostWorkstreams: LostWorkstream[] = [];
  for (const w of others) {
    const t = await prisma.chatTranscript.findFirst({ where: { projectId: project.id, workstreamId: w.id, current: true }, select: { gitState: true } });
    lostWorkstreams.push({ name: w.name, gitState: t?.gitState ?? null });
  }
  const sessions = [{ workstreamId: main.id, sessionId: raw.sessionId, gitState: mainRow?.gitState ?? null }];
  const fromInstanceId = project.instanceId ?? '';
  const moved = await prisma.$transaction(async tx => {
    // Only from the box this request saw: a second Continue loses here.
    const m = await tx.project.updateMany({
      where: { id: project.id, instanceId: project.instanceId },
      data: { instanceId: fresh.id, setupStatus: 'pending', setupError: null, setupAttempt: { increment: 1 } },
    });
    if (m.count !== 1) return false;
    for (const s of sessions) {
      await tx.chatResume.create({
        data: {
          projectId: project.id, workstreamId: s.workstreamId, sessionId: s.sessionId, fromInstanceId, toInstanceId: fresh.id,
          gitState: s.gitState ?? undefined, ...(lostWorkstreams.length ? { lostWorkstreams: lostWorkstreams as unknown as object } : {}),
        },
      });
    }
    return true;
  });
  if (!moved) return { status: 409, body: { error: 'The chat moved meanwhile; reload it', code: 'moved' } };
  // The move is made: a grant that fails is logged, and the chat goes on without that space.
  const granted = await copySpaceListings(project.id, fromInstanceId, fresh.id, user.id).catch(err => {
    console.error(`[RESUME] ${project.id}: space grants not copied: ${(err as Error).message}`);
    return 0;
  });
  console.log(`[RESUME] ${project.id}: continues on ${fresh.name} (${fresh.id}) from ${fromInstanceId || 'no box'}; ${sessions.length} session(s) to restore, ${granted} space grant(s)`);

  // A claimed warm box said hello long ago, so nothing else drives its setup or restore.
  const { agentView, applySetupEvent } = await import('./projectClone');
  const view = agentView(fresh.id);
  if (view.kind === 'present') {
    // A claim delivers the owner's credentials (the Claude gateway settings)
    // without waiting (warmPoolClaim.ts welcomeOwner), in this process. A
    // hello's restore waits for its delivery (agentRegistry `settled`); this
    // one must too, or the first turn runs before the box can reach Claude,
    // and the chat shows a sign-in card meanwhile. The mark is in the
    // database, so another process's send or sweep waits for it as well.
    await credentialsDelivered(fresh.id);
    await markCredentialsReady(fresh.id);
    const setup = (capabilities: readonly string[]) => applySetupEvent({ projectId: project.id, instanceId: fresh.id }, { kind: 'agent-connected', capabilities })
      .catch(err => console.error(`[RESUME] ${project.id}: setup on ${fresh.id} failed:`, (err as Error).message));
    if (claimUpdateRunning(fresh.id)) {
      // The claim's update (claimUpdate.ts) may restart the agent, and setup
      // only defers while it runs: both wait for it, in the background and in
      // order, with the agent there is then. An agent gone by then gets both
      // from its hello (projectClone and startChatResumeRestores).
      void claimUpdateSettled(fresh.id).then(async () => {
        const now = agentView(fresh.id);
        if (now.kind !== 'present') return;
        await setup(now.capabilities);
        await restoreAllOn(fresh.id);
      }).catch(err => console.error(`[RESUME] ${project.id}: setup and restore after the claim update failed:`, (err as Error).message));
    } else {
      await setup(view.capabilities);
      void restoreAllOn(fresh.id);
    }
  }
  return { status: 202, body: { instanceId: fresh.id, box: fresh.name, sessions: sessions.length, lostWorkstreams: lostWorkstreams.length } };
}

/**
 * The spaces the old box reached the chat through become grants of the new
 * box: the old box's own grants (until the sweep prunes a terminated box's)
 * and the spaces the chat is listed in, where the owner may still add a box
 * (editor or more). Nothing the owner could not grant now.
 */
async function copySpaceListings(projectId: string, fromInstanceId: string, instanceId: string, ownerId: string): Promise<number> {
  const { spaceStore } = await import('./spaces/spacesRuntime');
  const { roleAtLeast } = await import('./spaces/spaceAccess');
  const listings = await prisma.projectSpace.findMany({ where: { projectId }, select: { spaceId: true } });
  const granted = fromInstanceId ? await spaceStore.spacesGrantedTo([fromInstanceId]) : [];
  const spaceIds = new Set([...listings.map(l => l.spaceId), ...granted.map(g => g.space.id)]);
  let n = 0;
  for (const spaceId of spaceIds) {
    try {
      const space = await prisma.space.findUnique({ where: { id: spaceId }, select: { deletedAt: true } });
      if (!space || space.deletedAt) continue;
      const role = (await spaceStore.memberRoles(spaceId)).get(ownerId);
      if (!role || !roleAtLeast(role, 'editor')) continue;
      await spaceStore.addGrant(spaceId, instanceId, ownerId);
      n += 1;
    } catch (err) {
      console.error(`[RESUME] ${projectId}: space ${spaceId} not granted: ${(err as Error).message}`);
    }
  }
  return n;
}

/** How long a continue waits for a claimed box's credential delivery before it restores anyway. */
const CREDENTIALS_WAIT_MS = 30_000;

/** Resolves once no credential delivery to the box is running, or after CREDENTIALS_WAIT_MS. */
async function credentialsDelivered(instanceId: string): Promise<void> {
  const { deliveryInFlight } = await import('./credentialDelivery');
  const running = deliveryInFlight(instanceId);
  if (!running) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([running, new Promise<void>(done => { timer = setTimeout(done, CREDENTIALS_WAIT_MS); })]);
  clearTimeout(timer);
}

/**
 * A resume unmarked for longer than this no longer holds its chat: the
 * process that was to mark it died mid-wait (a crash, an overlap drain), and a
 * claimed warm box says no new hello that would. Longer than the continue's
 * own wait (CREDENTIALS_WAIT_MS); the recovery sweep tries a delivery first.
 */
export const CREDENTIALS_STALE_MS = 2 * 60_000;
const CREDENTIALS_RECOVER_AFTER_MS = 45_000;

/**
 * Resumes still unmarked well after their continue began: deliver the owner's
 * credentials again to each box whose agent this process holds, then mark it.
 * A box connected elsewhere is left to that process's sweep (and, past
 * CREDENTIALS_STALE_MS, to the stale window).
 */
export async function recoverUnmarkedCredentials(now = new Date()): Promise<void> {
  const rows = await prisma.chatResume.findMany({
    where: { credentialsReadyAt: null, noticeSentAt: null, createdAt: { lt: new Date(now.getTime() - CREDENTIALS_RECOVER_AFTER_MS) } },
    distinct: ['toInstanceId'],
    select: { toInstanceId: true, project: { select: { userId: true } } },
  });
  const { deliverToInstance } = await import('./credentialDelivery');
  for (const r of rows) {
    if (!instanceAgentTransport(r.toInstanceId)?.helloReceived) continue;
    try {
      await deliverToInstance(r.toInstanceId, r.project.userId);
      await markCredentialsReady(r.toInstanceId);
    } catch (err) {
      console.error('[RESUME] credentials for %s not delivered again: %s', r.toInstanceId, err instanceof Error ? err.message : String(err));
    }
  }
}

/** The box has the owner's credentials: its resumes' first turns may go (every orchestrator process reads it). */
export async function markCredentialsReady(instanceId: string): Promise<void> {
  await prisma.chatResume.updateMany({ where: { toInstanceId: instanceId, credentialsReadyAt: null }, data: { credentialsReadyAt: new Date() } });
}

export interface PendingResume {
  id: string;
  projectId: string;
  workstreamId: string;
  sessionId: string;
  toInstanceId: string;
  gitState: unknown;
  lostWorkstreams?: unknown;
  restoredAt: Date | null;
}

/** The chat's resume on this box whose first turn has not been told yet. */
export async function pendingResumeFor(workstreamId: string, instanceId: string | null): Promise<PendingResume | null> {
  if (!instanceId) return null;
  return prisma.chatResume.findFirst({
    where: { workstreamId, toInstanceId: instanceId, noticeSentAt: null },
    select: { id: true, projectId: true, workstreamId: true, sessionId: true, toInstanceId: true, gitState: true, lostWorkstreams: true, restoredAt: true },
  });
}

/**
 * Claude started the turn on the new box whose message carried the notice
 * (noticeEvent: its turn id is on the row), so it is told, never again. Not on a send's 202, which is
 * the box taking or queueing the job, and not on another turn's start (a
 * compact, a reclaim's send), which carried none.
 */
export async function noteNoticeTold(workstreamId: string, instanceId: string, turnId: string): Promise<void> {
  await prisma.chatResume.updateMany({
    where: { workstreamId, toInstanceId: instanceId, noticeSentAt: null, restoredAt: { not: null }, noticeTurnId: turnId },
    data: { noticeSentAt: new Date() },
  });
}

/** Claude's own start-of-turn line in stream-json: the process runs with the message. */
function isClaudeInit(ev: unknown): boolean {
  const e = ev as { type?: unknown; subtype?: unknown } | null;
  return e?.type === 'system' && e.subtype === 'init';
}

export interface RestoreDeps {
  send: (instanceId: string, type: string, payload: Record<string, unknown>) => Promise<unknown>;
  chunks: (raw: NonNullable<Awaited<ReturnType<typeof storedRawOf>>>) => AsyncIterable<Buffer>;
}

/** Send the session to the box in pieces; the last one puts it in place. Throws when the box refuses. */
export async function restoreSession(
  target: { instanceId: string; chatKey: string; sessionId: string; cwd: string; rawBytes: number },
  chunks: AsyncIterable<Buffer>,
  send: RestoreDeps['send'],
): Promise<void> {
  let sent = 0;
  const ask = (from: number, data: Buffer, done: boolean) => send(target.instanceId, 'chat-session-restore', {
    chatKey: target.chatKey, sessionId: target.sessionId, cwd: target.cwd, from, data: data.toString('base64'), done,
  }) as Promise<{ restored?: boolean; size?: number; expected?: number }>;
  // A resume asked again once done answers done: a retry after a lost answer is safe.
  let pending: { from: number; data: Buffer } | null = null;
  for await (const chunk of chunks) {
    for (const piece of restorePieces([chunk])) {
      const p = { from: sent + piece.from, data: piece.data };
      if (pending) {
        const r = await ask(pending.from, pending.data, false);
        if (r?.expected != null) throw new Error(`the box has ${r.expected} bytes of the restore, not ${pending.from}`);
      }
      pending = p;
    }
    sent += chunk.length;
  }
  if (!pending || sent !== target.rawBytes) throw new Error(`the store has ${sent} of ${target.rawBytes} bytes`);
  const r = await ask(pending.from, pending.data, true);
  if (r?.restored !== true) throw new Error(r?.expected != null ? `the box has ${r.expected} bytes of the restore` : 'the box did not restore the session');
}

// One restore per resume at a time; a second caller waits for the first.
const restoring = new Map<string, Promise<void>>();

/**
 * Put the resume's session on its box, unless it is there already. Needs the
 * box's agent connected with chat-restore-v1. Throws when it cannot.
 */
export function ensureRestored(resume: PendingResume): Promise<void> {
  if (resume.restoredAt) return Promise.resolve();
  const running = restoring.get(resume.id);
  if (running) return running;
  const run = doRestore(resume).finally(() => restoring.delete(resume.id));
  restoring.set(resume.id, run);
  return run;
}

async function doRestore(resume: PendingResume, cfg: TranscriptStoreConfig | null = getTranscriptStoreConfig()): Promise<void> {
  const fresh = await prisma.chatResume.findUnique({ where: { id: resume.id }, select: { restoredAt: true } });
  if (fresh?.restoredAt) return;
  if (!cfg) throw new Error('the transcript store is not configured');
  const transport = instanceAgentTransport(resume.toInstanceId);
  if (!transport?.helloReceived) throw new Error("the new box's agent is not connected yet");
  if (!transport.capabilities.includes(CHAT_RESTORE_CAPABILITY)) throw new Error("the new box's agent predates chat-restore-v1; it needs an update");
  const ws = await prisma.workstream.findUnique({
    where: { id: resume.workstreamId },
    select: { name: true, project: { select: { name: true, instanceId: true, user: { select: { unixUsername: true } }, instance: { select: { hostHome: true } } } } },
  });
  if (!ws || ws.project.instanceId !== resume.toInstanceId) throw new Error('the chat is no longer on that box');
  const raw = await storedRawOf(resume.projectId, resume.workstreamId);
  if (!raw || raw.sessionId !== resume.sessionId || !raw.complete) throw new Error('the stored session changed or is incomplete');
  const cwd = projectDirFor({ name: ws.project.name, user: ws.project.user, instance: { hostHome: ws.project.instance?.hostHome ?? null } }, ws.name);
  await restoreSession(
    { instanceId: resume.toInstanceId, chatKey: chatKeyFor(resume.projectId, resume.workstreamId), sessionId: resume.sessionId, cwd, rawBytes: raw.rawBytes },
    storedRawChunks(cfg, resume.projectId, resume.workstreamId, raw),
    (instanceId, type, payload) => sendToInstanceAgent(instanceId, type, payload, RESTORE_TIMEOUT_MS),
  );
  await prisma.chatResume.update({ where: { id: resume.id }, data: { restoredAt: new Date() } });
  // A message held for this chat (sending started the continue) goes in now.
  (await import('./chatHeld')).kickHeldDelivery(resume.workstreamId);
  console.log(`[RESUME] ${resume.projectId}: restored session ${resume.sessionId.slice(0, 8)} (${raw.rawBytes} bytes) on ${resume.toInstanceId}`);
}

/** Every resume still waiting for this box, one at a time. Failures are logged; the chat's next open or send retries. */
export async function restoreAllOn(instanceId: string): Promise<void> {
  const rows = await prisma.chatResume.findMany({
    where: { toInstanceId: instanceId, restoredAt: null },
    select: { id: true, projectId: true, workstreamId: true, sessionId: true, toInstanceId: true, gitState: true, lostWorkstreams: true, restoredAt: true },
  });
  for (const row of rows) {
    await ensureRestored(row).catch(err => {
      console.error(`[RESUME] ${row.projectId}: restore on ${instanceId} failed, the next open or send retries: ${(err as Error).message}`);
    });
  }
}

/**
 * The notice's pairing, kept on the chat_resumes row so it holds across
 * orchestrator processes (an overlapping deploy, a restart between a turn's
 * start and its init): a turn-start that says its message carries the notice
 * (agent chat-turn.js `newBoxNotice`) records its turn id; a Claude init tells
 * the notice only when its turn is the one recorded; a recorded turn that ends
 * before Claude starts gives the claim up. A compact's or a reclaim's turn
 * carries none and records nothing. Events for one chat are written in the
 * order they came, so an init never passes its own turn-start.
 */
export async function noticeEvent(seen: { instanceId: string; workstreamId: string; turnId: string | null; event: unknown }): Promise<void> {
  const { instanceId, workstreamId, turnId } = seen;
  if (!turnId) return;
  const e = seen.event as { type?: unknown; newBoxNotice?: unknown } | null;
  const row = { workstreamId, toInstanceId: instanceId, noticeSentAt: null };
  if (e?.type === 'turn-start') {
    if (e.newBoxNotice === true) await prisma.chatResume.updateMany({ where: row, data: { noticeTurnId: turnId } });
  } else if (e?.type === 'turn-end') {
    if ((e as { lost?: unknown }).lost === true) await prisma.chatResume.updateMany({ where: { ...row, noticeTurnId: turnId }, data: { noticeTurnId: null } });
  } else if (isClaudeInit(seen.event)) {
    await noteNoticeTold(workstreamId, instanceId, turnId);
  }
}

// One chat's notice events in the order they came (in this process; a box's events reach one process at a time).
const noticeChains = new Map<string, Promise<void>>();

function queueNoticeEvent(seen: { instanceId: string; workstreamId: string; turnId: string | null; event: unknown }): void {
  const key = `${seen.instanceId}|${seen.workstreamId}`;
  const run = (noticeChains.get(key) ?? Promise.resolve()).then(() => noticeEvent(seen)).catch(err => {
    console.error('[RESUME] notice for %s not updated: %s', seen.workstreamId, err instanceof Error ? err.message : String(err));
  });
  noticeChains.set(key, run);
  void run.then(() => { if (noticeChains.get(key) === run) noticeChains.delete(key); });
}

/** Restore what waits for a box when it connects, and mark notices told as their turns start. Returns the unsubscribe. */
export function startChatResumeRestores(): () => void {
  const offEvent = onChatEvent(seen => {
    if (seen.workstreamId) queueNoticeEvent({ ...seen, workstreamId: seen.workstreamId });
  });
  const recoverCredentials = traceSweep('chat-credentials', () => recoverUnmarkedCredentials());
  const recover = setInterval(() => {
    void recoverCredentials().catch(err => {
      console.error('[RESUME] credential recovery failed: %s', err instanceof Error ? err.message : String(err));
    });
  }, 30_000);
  recover.unref?.();
  const offHello = onBoxAgentHello(ev => {
    if (!ev.capabilities.includes(CHAT_RESTORE_CAPABILITY)) return;
    void ev.settled.then(async () => {
      // `settled` includes this hello's credential delivery.
      await markCredentialsReady(ev.instance.id);
      await restoreAllOn(ev.instance.id);
      // A started box's held messages, and any whose restore was already done.
      await (await import('./chatHeld')).kickHeldDeliveryOnBox(ev.instance.id);
    }).catch(err => {
      console.error('[RESUME] restores for %s failed: %s', ev.instance.name, err instanceof Error ? err.message : String(err));
    });
  });
  return () => { clearInterval(recover); offEvent(); offHello(); };
}

// ── Sending is the decision ─────────────────────────
// A chat whose box was terminated looks like any other: its stored history
// reads, and a message the owner sends continues it on a new box. One whose
// box is stopped starts it. The message is held (chatHeld.ts) until the chat
// can take it.

/** Where a chat that is continuing, or starting its box, stands: the status line's text. */
export type ContinuationPhase = 'starting-box' | 'restoring' | 'starting';

/** What a send or a history read needs to know about the chat, read once (continuationFacts). */
export interface ContinuationFacts {
  isOwner: boolean;
  ownerName: string;
  /** An ask's chat, or not the project's main one (v1): none of this applies. */
  excluded: boolean;
  box: { id: string; status: string; kind: string } | null;
  setupReady: boolean;
  connected: boolean;
  /** The stored session's raw copy is whole (storedRawOf). */
  complete: boolean;
  lockHeld: boolean;
  /** The box's credential delivery (the Claude gateway settings) is still running: it can't reach Claude yet. */
  credentialsPending: boolean;
  /** A resume onto the project's current box whose first turn hasn't gone in. */
  pendingResume: { restored: boolean } | null;
  hasHeld: boolean;
  /**
   * The chat has a stored transcript: while its box is down a send is held here, images and all, and
   * starts the box, with chat-resume off and on any workstream.
   */
  parkHold: boolean;
  /** An ask thread's chat: writable only by the project's owner who also owns the box (askChatSendRefusal). */
  ask: boolean;
  /** The caller owns the project and its box. */
  ownsBox: boolean;
}

export type SendPlan =
  | { kind: 'normal' }
  | { kind: 'refuse'; status: number; code: 'owner-only' | 'incomplete' | 'self-managed'; reason: string }
  /** Continue on a new box, then hold the message. */
  | { kind: 'continue' }
  /** Start the stopped box, then hold the message. */
  | { kind: 'start-box'; boxId: string }
  /** The chat is coming up, or others wait: hold the message behind them. */
  | { kind: 'hold' };

const ownerOnly = (f: ContinuationFacts) => ({ kind: 'refuse' as const, status: 403, code: 'owner-only' as const, reason: `Only ${f.ownerName} can continue this chat` });

/** What a send to this chat does. Pure: routes/chat.ts reads the facts. */
export function sendPlanFor(f: ContinuationFacts): SendPlan {
  if (f.excluded) return parkHoldPlan(f);
  const status = f.box?.status ?? 'terminated';
  // A box that is gone: terminated, or one a continue made that failed to launch.
  // A resume left on it is stale: it can never be delivered, so it doesn't hold the send.
  if (boxGone(f) && !f.lockHeld) {
    if (!f.isOwner) return ownerOnly(f);
    if (f.box?.kind === 'external') return { kind: 'refuse', status: 409, code: 'self-managed', reason: 'This chat ran on a self-managed host. Connect that host again to continue it.' };
    if (!f.complete) return { kind: 'refuse', status: 409, code: 'incomplete', reason: 'The saved copy of this conversation is incomplete (it grew past what is kept), so it cannot continue on a new box. It stays readable here.' };
    return { kind: 'continue' };
  }
  if ((status === 'stopped' || status === 'hibernated') && f.box) {
    return f.isOwner ? { kind: 'start-box', boxId: f.box.id } : ownerOnly(f);
  }
  const ready = f.connected && f.setupReady && !f.credentialsPending && (!f.pendingResume || f.pendingResume.restored);
  if (f.lockHeld || !ready && (f.pendingResume || f.hasHeld)) return f.isOwner || !f.lockHeld ? { kind: 'hold' } : ownerOnly(f);
  if (f.hasHeld) return { kind: 'hold' };
  // Nothing of chat-resume's own: a stored chat's box on its way down or up still holds the send.
  return parkHoldPlan(f);
}

const PARKED = new Set(['stopped', 'hibernated']);
const ON_THE_WAY = new Set(['stopping', 'hibernating', 'starting']);
const ownerOnlyStart = (f: ContinuationFacts) => ({ kind: 'refuse' as const, status: 403, code: 'owner-only' as const, reason: `Only ${f.ownerName} can start this chat's box` });

/**
 * A stored chat's send while its box is down, where chat-resume doesn't
 * apply: a stopped or hibernated box starts and the send is held; one on its
 * way down or up holds it (held delivery starts a box once it has stopped);
 * held messages already waiting keep the order. Owner only, as a start is.
 */
function parkHoldPlan(f: ContinuationFacts): SendPlan {
  if (!f.parkHold || !f.box || f.box.kind !== 'ec2') return { kind: 'normal' };
  const plan = parkHoldFor(f, f.box);
  // An ask's chat runs its turns with the box owner's access: nobody else's send may wait in it, whatever the branch.
  if (plan.kind !== 'normal' && plan.kind !== 'refuse' && f.ask && !(f.isOwner && f.ownsBox)) {
    return { kind: 'refuse', status: 403, code: 'owner-only', reason: `Only ${f.ownerName} can send in this ask's chat` };
  }
  return plan;
}

function parkHoldFor(f: ContinuationFacts, box: { id: string; status: string }): SendPlan {
  if (PARKED.has(box.status)) return f.isOwner ? { kind: 'start-box', boxId: box.id } : ownerOnlyStart(f);
  if (ON_THE_WAY.has(box.status)) return f.isOwner ? { kind: 'hold' } : ownerOnlyStart(f);
  // Behind messages already waiting, connected or not, so it never lands ahead of them (as chat-resume's path),
  // but only on a box that can still come back: a gone one never delivers them.
  if (f.hasHeld && (box.status === 'ready' || PARKED.has(box.status) || ON_THE_WAY.has(box.status))) return { kind: 'hold' };
  return { kind: 'normal' };
}

/** The chat's box is gone for good: terminated, none, or one a continue made that failed to launch. */
function boxGone(f: ContinuationFacts): boolean {
  const status = f.box?.status ?? 'terminated';
  return status === 'terminated' || (status === 'failed' && f.pendingResume != null);
}

/** The status the chat shows while it continues or its box starts, or null when it shows its own. */
export function continuationPhase(f: ContinuationFacts): ContinuationPhase | null {
  if (f.excluded) {
    const status = f.box?.status ?? '';
    return f.parkHold && f.hasHeld && (PARKED.has(status) || ON_THE_WAY.has(status) || !f.connected) ? 'starting' : null;
  }
  if (f.lockHeld) return 'starting-box';
  // A resume onto a box that is gone is waiting for nothing: the next send continues again.
  if (boxGone(f)) return null;
  if (f.pendingResume) {
    if (!f.connected) return 'starting-box';
    if (!f.pendingResume.restored || !f.setupReady || f.credentialsPending) return 'restoring';
    return null;
  }
  const status = f.box?.status;
  if (f.hasHeld && (status === 'stopped' || status === 'hibernated' || status === 'starting' || !f.connected)) return 'starting';
  return f.parkHold && f.hasHeld && ON_THE_WAY.has(status ?? '') ? 'starting' : null;
}

/** Why this viewer can't send here (the composer says it), or null. */
export function continuationRefusal(f: ContinuationFacts): { code: string; reason: string } | null {
  const plan = sendPlanFor(f);
  return plan.kind === 'refuse' ? { code: plan.code, reason: plan.reason } : null;
}

/** Read the facts for a chat. `isOwner` is the caller's, from session access. */
export async function continuationFacts(projectId: string, workstreamId: string, workstreamName: string, isOwner: boolean, ask: boolean): Promise<ContinuationFacts> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      setupStatus: true, instanceId: true,
      instance: { select: { id: true, status: true, kind: true, userId: true } },
      user: { select: OWNER_SELECT },
    },
  });
  const base: ContinuationFacts = {
    isOwner, ownerName: 'its owner', excluded: ask || workstreamName !== 'main', box: null, setupReady: false,
    connected: false, complete: false, lockHeld: false, credentialsPending: false, pendingResume: null, hasHeld: false, parkHold: false,
    ask, ownsBox: false,
  };
  if (!project) return base;
  const { hasHeld } = await import('./chatHeld');
  const [raw, lockHeld, pending, held, parkHold] = await Promise.all([
    storedRawOf(projectId, workstreamId),
    continueUnderWay(projectId),
    project.instanceId ? prisma.chatResume.findFirst({ where: { workstreamId, toInstanceId: project.instanceId, noticeSentAt: null }, select: { restoredAt: true, credentialsReadyAt: true, createdAt: true } }) : null,
    hasHeld(workstreamId),
    storedChatHolds(workstreamId),
  ]);
  const transport = project.instanceId ? instanceAgentTransport(project.instanceId) : null;
  // From the database: the delivery may be running in another orchestrator process.
  // A resume unmarked past CREDENTIALS_STALE_MS no longer holds it: its continuer died mid-wait.
  const credentialsPending = pending != null && pending.credentialsReadyAt == null
    && !(pending.createdAt && pending.createdAt.getTime() < Date.now() - CREDENTIALS_STALE_MS);
  return {
    ...base,
    ownerName: project.user.displayName || project.user.unixUsername,
    box: project.instance,
    setupReady: project.setupStatus === 'ready' || project.setupStatus === 'none',
    connected: Boolean(transport?.helloReceived),
    complete: raw?.complete === true,
    lockHeld,
    credentialsPending,
    pendingResume: pending ? { restored: pending.restoredAt != null } : null,
    hasHeld: held,
    parkHold,
    ownsBox: isOwner && project.instance?.userId === project.user.id,
  };
}

/** Whether a send to this chat is held while its box is down (ContinuationFacts.parkHold): a stored copy to show. */
async function storedChatHolds(workstreamId: string): Promise<boolean> {
  return (await prisma.chatTranscript.count({ where: { workstreamId, current: true, chunks: { some: {} } } })) > 0;
}
