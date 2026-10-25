/**
 * Agent-to-agent asks: the side-effect-free part.
 *
 * A project's agent (or a person at `termag ask`) asks another of the same
 * person's projects a question. The orchestrator checks that the asker owns
 * both the project and its box (ownerOnlyRefusal: never a share), records the
 * message, and has the target box's agent start a headless Claude Code run as
 * the box user in a clone of the target's committed code
 * (deploy/termag-subagent-run). The box posts the
 * reply, and the commits as a git bundle, back to /api/cli/v1/ask/runs/:id;
 * the orchestrator publishes the commits as a draft PR on
 * `termag-<asker>/<thread>` (services/askPublish.ts) and hands the reply to
 * whoever waits for it.
 *
 * This module holds body validation, the branch name, the reply envelope and
 * the run's system prompt. services/askService.ts owns Prisma and the RPCs.
 */

/** What a box's agent must announce before an ask is sent there (agent/ask-run.js). */
export const ASK_AGENT_CAPABILITY = 'ask-v1';
/** A box's agent that can stop a run it started (`ask-run-cancel`). */
export const ASK_CANCEL_CAPABILITY = 'ask-cancel-v1';
/**
 * A box's agent that runs an ask as a turn of the thread's chat on the target
 * project (agent/ask-chat.js): `ask-run` names the chat, and the owner sees
 * and answers the ask in the simple UI. Without it the run is headless.
 */
export const ASK_CHAT_CAPABILITY = 'ask-chat-v1';

/** The workstream an ask thread's chat lives in: one per thread, no worktree of its own. */
export function askChatWorkstreamName(threadId: string): string {
  return `ask-${threadId}`;
}

/**
 * Why a person may not send into an ask's chat, or null. Watching it is the
 * project's (owner or share); writing to it is the ask's: a turn there runs
 * with the box owner's full access, the same rule as ownerOnlyRefusal.
 */
export function askChatSendRefusal(f: {
  userId: string; projectOwnerId: string; boxOwnerId: string | null; capabilities: readonly string[];
}): { status: number; body: { error: string; code: string } } | null {
  if (f.userId !== f.projectOwnerId || (f.boxOwnerId != null && f.userId !== f.boxOwnerId)) {
    return { status: 403, body: { error: 'Only the owner of the project and its box can write in an ask\'s conversation', code: 'not_owner' } };
  }
  if (!f.capabilities.includes(ASK_CHAT_CAPABILITY)) {
    return { status: 409, body: { error: 'This box\'s agent cannot continue an ask in its chat; it needs an update and a restart', code: 'runner-missing' } };
  }
  return null;
}

/**
 * A project cloned from a repository is `pending` then `cloning` until the box
 * reports it `ready` (services/projectSetup.ts); a run before that would find
 * no checkout, so an ask to it waits in the queue until the clone is done.
 */
export const isProjectSettingUp = (setupStatus: string): boolean =>
  setupStatus === 'pending' || setupStatus === 'cloning';

/** Why a project's setup means an ask to it can never run, or null. */
export function setupRefusal(p: { name: string; setupStatus: string; setupError: string | null }):
  { error: string; code: 'project_failed' } | null {
  if (p.setupStatus === 'failed') {
    return { error: `${p.name} failed to set up${p.setupError ? `: ${p.setupError}` : ''}`, code: 'project_failed' };
  }
  return null;
}

/**
 * Why an ask may not go to this target, or null: asks go only to the asker's
 * own project on the asker's own box. A run executes as the box user with the
 * box owner's credentials, network and tools, so neither a share of the
 * project nor a project on somebody else's box may take one, whatever any
 * flag says. A project with no box is left to the `no_box` refusal.
 */
export function ownerOnlyRefusal(
  t: { project: string; projectOwnerId: string; box: string | null; boxOwnerId: string | null },
  askerId: string,
): { status: 403; error: string; code: 'not_owner' } | null {
  if (t.projectOwnerId !== askerId) {
    return { status: 403, error: `${t.project} is not your project; asks go only to your own projects on your own boxes`, code: 'not_owner' };
  }
  if (t.box !== null && t.boxOwnerId !== askerId) {
    return { status: 403, error: `${t.box} is not your box; asks run only on your own boxes`, code: 'not_owner' };
  }
  return null;
}

/**
 * The one bound on runaway asks: at most MAX_ACTIVE_ASKS of a person's asks
 * submitted or working at once. Each run is a whole Claude Code session with
 * the owner's access, so a loop of agents asking agents must hit a wall.
 */
export const MAX_ACTIVE_ASKS = 10;

/** The refusal for a new ask when the asker already has `active` asks running, or null. */
export function capRefusal(active: number): { error: string; code: 'too_many_asks' } | null {
  if (active < MAX_ACTIVE_ASKS) return null;
  return {
    error: `You have ${active} asks running (at most ${MAX_ACTIVE_ASKS}); wait for one or cancel one (termag ask --inbox, termag ask --cancel <message>)`,
    code: 'too_many_asks',
  };
}

/** A prompt has to fit the CLI API's JSON body (express.json's 100 KB) with room to spare. */
export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
/** The inbox lists finished messages this recent, delivered or not. */
export const INBOX_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A bundle that was never published (the result never came) is deleted after this. */
export const BUNDLE_TTL_MS = 60 * 60 * 1000;
/** The longest one GET waits for a reply: under the ALB's 60 s idle timeout. */
export const MAX_WAIT_SEC = 50;

/**
 * A message's state, named after A2A's TaskState: `submitted` until the box takes the run, `working` while it
 * runs and publishes, then `completed`, `failed` or `canceled`.
 */
export type MessageStatus = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled';
export const ACTIVE_STATES: MessageStatus[] = ['submitted', 'working'];
export const isTerminal = (s: string): boolean => s === 'completed' || s === 'failed' || s === 'canceled';

/**
 * A refusal of an ask the target can't take (A2A's `rejected`): answered at
 * once, never stored, so nothing waits on a turn that can only fail.
 */
export function rejection(status: 409, error: string, code: string, req: Pick<AskRequest, 'messageId' | 'threadId'>) {
  return { status, body: { error, code, status: 'rejected' as const, message: req.messageId, thread: req.threadId } };
}

/**
 * A retried POST /ask: the id already names a message. It is the same ask
 * only for the same asker, project, workstream, thread (when one was named)
 * and prompt size; anything else reused the id.
 */
export function replayDecision(
  existing: { senderUserId: string; projectId: string; workstream: string; threadId: string; promptBytes: number },
  req: { userId: string; projectId: string; workstream: string; threadId: string | null; promptBytes: number },
): 'same' | 'taken' | 'different' {
  if (existing.senderUserId !== req.userId) return 'taken';
  if (existing.projectId !== req.projectId || existing.workstream !== req.workstream) return 'different';
  if (req.threadId && req.threadId !== existing.threadId) return 'different';
  return existing.promptBytes === req.promptBytes ? 'same' : 'different';
}

export type CancelDecision =
  | { kind: 'not_found' }
  | { kind: 'cancel' }
  /** Already canceled: answered as a success, so a retried cancel is harmless. */
  | { kind: 'already' }
  | { kind: 'finished'; why: string };

/**
 * Who may cancel what: the asker, or the owner of the target project (whose
 * box runs it). Anyone else gets the same 404 as for a message they can't see.
 * A turn whose result is in is past cancelling: it is publishing.
 */
export function cancelDecision(
  m: { status: string; resultAt: Date | null; senderUserId: string; projectOwnerId: string },
  userId: string,
): CancelDecision {
  if (m.senderUserId !== userId && m.projectOwnerId !== userId) return { kind: 'not_found' };
  if (m.status === 'canceled') return { kind: 'already' };
  if (isTerminal(m.status)) return { kind: 'finished', why: `the message is already ${m.status}` };
  if (m.resultAt) return { kind: 'finished', why: 'the run already finished and its result is being published' };
  return { kind: 'cancel' };
}

/**
 * A canceled turn's run is asked to stop when the turn was working, or when
 * it has a `startedAt`: a start that marked it working after the cancel read
 * it has already passed its own "canceled meanwhile" check.
 */
export const cancelShouldStop = (m: { status: string; startedAt: Date | null }): boolean =>
  m.status === 'working' || m.startedAt !== null;

/**
 * What to do with a turn whose `ask-run` RPC failed, by what the box says of
 * the run: a timeout or a dropped response can follow a start that took, and
 * that run reports to a working turn, so it is adopted. One the box can't
 * vouch for is stopped (best effort) and failed.
 */
export function startFailureAction(state: 'running' | 'gone' | 'unknown'): 'adopt' | 'fail' | 'stop-and-fail' {
  if (state === 'running') return 'adopt';
  return state === 'gone' ? 'fail' : 'stop-and-fail';
}

/** How long `ask-run` may take to start a run; a turn `submitted` past it lost the process starting it. */
export const START_RPC_MS = 15_000;
const START_SLACK_MS = 5_000;

/**
 * A `submitted` turn still inside its start RPC, or still queued for its box:
 * the box has no runner for it yet, so its status means nothing. A queued
 * turn's `queuedUntil` is its expiry while it waits and the moment it was sent
 * after, so the start window counts from whichever is later.
 */
export const stillStarting = (m: { status: string; createdAt: Date; queuedUntil?: Date | null }, now: number): boolean =>
  m.status === 'submitted'
  && now - Math.max(m.createdAt.getTime(), m.queuedUntil?.getTime() ?? 0) <= START_RPC_MS + START_SLACK_MS;

/**
 * How long an ask to a parked box waits for the box's agent. A resume from
 * hibernation takes a few minutes and a cold start up to about ten; past this
 * the box is not coming and the asker hears so.
 */
export const QUEUE_TTL_MS = 15 * 60 * 1000;

/**
 * How long an ask to a project that is still being set up waits for its
 * clone. A large repository's first clone on a fresh box takes several
 * minutes; past this the clone is stuck and the asker hears so.
 */
export const SETUP_QUEUE_TTL_MS = 30 * 60 * 1000;

/** When a newly queued ask gives up: the longer of the waits it is queued for. */
export function queuedDeadline(waits: { box: boolean; setup: boolean }, now: number): Date {
  return new Date(now + Math.max(waits.box ? QUEUE_TTL_MS : 0, waits.setup ? SETUP_QUEUE_TTL_MS : 0));
}

/** Why a queued ask that reached its deadline never ran. */
export function queueExpiryReason(project: { name: string; setupStatus: string } | null): string {
  if (project && isProjectSettingUp(project.setupStatus)) {
    return `${project.name} was still being set up ${SETUP_QUEUE_TTL_MS / 60_000} minutes after the ask, so the ask never ran; check its clone and ask again`;
  }
  return `the box did not come up within ${QUEUE_TTL_MS / 60_000} minutes of being started, so the ask never ran; start it and ask again`;
}

/**
 * A waiting ask's deadline once termag has started its box: QUEUE_TTL_MS from
 * the start, so a box that was still parking when the ask came in gets the
 * whole window to come up, but never past twice that from the ask.
 */
export function deadlineAfterStart(m: { createdAt: Date; queuedUntil: Date }, startedAt: number): Date {
  const cap = m.createdAt.getTime() + 2 * QUEUE_TTL_MS;
  return new Date(Math.max(m.queuedUntil.getTime(), Math.min(startedAt + QUEUE_TTL_MS, cap)));
}

/**
 * A box going down or down: an agent socket it still holds is about to drop,
 * so an ask must not start a run on it but wait for the park and a start.
 */
export const isParking = (status: string): boolean =>
  status === 'stopping' || status === 'hibernating' || status === 'stopped' || status === 'hibernated';

/** Box statuses an ask waits through: powered down, or on the way up or down. */
const WAKEABLE = new Set(['stopping', 'stopped', 'hibernating', 'hibernated', 'starting']);

/**
 * Whether an ask to a box with no connected agent waits for it rather than
 * being refused. Only the box's owner can start it, and only an EC2 box can be
 * started from here; a box that is `ready` but disconnected, or someone
 * else's, is refused as before.
 */
export function shouldQueue(
  box: { kind: string; userId: string | null; status: string },
  askerId: string,
  provisioningConfigured: boolean,
): boolean {
  return box.kind === 'ec2' && box.userId === askerId && provisioningConfigured && WAKEABLE.has(box.status);
}

/**
 * How a new ask reaches its box. A box whose agent has connected but not yet
 * said hello and taken its credentials is still coming up: its owner's ask
 * waits in the queue, which sends it once the connection has settled, and
 * anyone else's is refused until the hello, since before it the agent has no
 * capabilities to check.
 */
export function askRoute(
  box: { kind: string; userId: string | null; status: string },
  askerId: string,
  provisioningConfigured: boolean,
  conn: { connected: boolean; helloReceived: boolean; settled: boolean },
): 'direct' | 'queue' | 'offline' | 'connecting' {
  if (isParking(box.status) || !conn.connected) return shouldQueue(box, askerId, provisioningConfigured) ? 'queue' : 'offline';
  if (conn.settled) return 'direct';
  if (box.kind === 'ec2' && box.userId === askerId && provisioningConfigured && wakeAction(box.status) !== 'gone') return 'queue';
  return conn.helloReceived ? 'direct' : 'connecting';
}

/** What the queue does for a waiting ask's box this tick: start it, give up, or wait for it. */
export function wakeAction(boxStatus: string | null): 'start' | 'gone' | 'wait' {
  if (boxStatus === null || boxStatus === 'terminated' || boxStatus === 'failed') return 'gone';
  return boxStatus === 'stopped' || boxStatus === 'hibernated' ? 'start' : 'wait';
}

/** A working turn with no result this long after its run started is checked on its box by the sweep. */
export const LOST_RUN_GRACE_MS = 2 * 60 * 1000;

/**
 * Why a turn the sweep found active with no result is lost, or null while it
 * may still be running. `running` is the box's answer, true when it could not
 * say (offline, an agent without ask-run-status): a box that is merely
 * disconnected may still finish the run and post its result.
 */
export async function lostRunReason(boxStatus: string | null, running: () => Promise<boolean>): Promise<string | null> {
  if (boxStatus === null || boxStatus === 'terminated') return 'lost: the box the run was on is gone';
  return (await running()) ? null : 'lost: the run was no longer running on the box';
}

/** cuid() ids, as Prisma makes them. */
const ID = /^[a-z0-9]{8,40}$/;
export const isMessageId = (s: unknown): s is string => typeof s === 'string' && ID.test(s);

export interface AskRef {
  box: string;
  project: string;
  workstream: string | null;
}

// Box names a CLI can address (cliViews isAddressableName); project and
// workstream names may hold anything but the separators and whitespace.
const REF = /^([A-Za-z0-9_-]+)\/([^/@\s]+)(?:@([^/@\s]+))?$/;

/** `box/project` or `box/project@workstream`. */
export function parseAskRef(text: string): AskRef | null {
  const m = REF.exec(text.trim());
  if (!m) return null;
  return { box: m[1], project: m[2], workstream: m[3] ?? null };
}

export interface AskRequest {
  /** Exactly one of ref and projectId. */
  ref: AskRef | null;
  projectId: string | null;
  workstream: string;
  prompt: string;
  threadId: string | null;
  /**
   * Chosen by the client (A2A's client-generated messageId), so a retried
   * POST names the same ask and gets it back instead of a second turn.
   */
  messageId: string | null;
}

export function parseAskBody(body: unknown): AskRequest | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (b.box !== undefined || b.instanceId !== undefined) {
    return { error: 'an ask names a project (target or projectId), which identifies its box; box and instanceId are not accepted' };
  }
  const target = typeof b.target === 'string' ? b.target.trim() : '';
  const projectId = typeof b.projectId === 'string' ? b.projectId.trim() : '';
  if (!target === !projectId) return { error: 'name the project as target ("box/project[@workstream]") or projectId, not both' };
  let ref: AskRef | null = null;
  if (target) {
    ref = parseAskRef(target);
    if (!ref) return { error: `"${target}" is not box/project or box/project@workstream` };
  }
  const bodyWs = typeof b.workstream === 'string' && b.workstream.trim() ? b.workstream.trim() : null;
  if (ref?.workstream && bodyWs && ref.workstream !== bodyWs) return { error: 'the workstream is named twice, differently' };
  const workstream = ref?.workstream ?? bodyWs ?? 'main';
  const prompt = typeof b.prompt === 'string' ? b.prompt : '';
  if (!prompt.trim()) return { error: 'prompt (non-empty string) required' };
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) return { error: `prompt too long (max ${MAX_PROMPT_BYTES / 1024} KB)` };
  let threadId: string | null = null;
  if (b.threadId !== undefined && b.threadId !== null && b.threadId !== '') {
    if (!isMessageId(b.threadId)) return { error: 'threadId is not a thread id' };
    threadId = b.threadId;
  }
  let messageId: string | null = null;
  if (b.messageId !== undefined && b.messageId !== null && b.messageId !== '') {
    if (!isMessageId(b.messageId)) return { error: 'messageId must be 8-40 lowercase letters and digits' };
    messageId = b.messageId;
  }
  return { ref, projectId: projectId || null, workstream, prompt, threadId, messageId };
}

export interface TargetCandidate {
  projectId: string;
  projectName: string;
  boxName: string | null;
  ownerUsername: string;
  isOwner: boolean;
}

/**
 * The one project a ref names among those the caller may reach. Own projects
 * win over shared ones with the same box and project name; two shared
 * projects that still collide are reported, so the caller can use the id.
 */
export function pickTarget(candidates: TargetCandidate[], ref: AskRef): { projectId: string } | { error: string; status: 404 | 409 } {
  const hits = candidates.filter(c => c.boxName === ref.box && c.projectName === ref.project);
  const own = hits.filter(c => c.isOwner);
  if (own.length === 1) return { projectId: own[0].projectId };
  if (hits.length === 1) return { projectId: hits[0].projectId };
  if (hits.length === 0) return { error: `No project ${ref.box}/${ref.project} among your own or shared projects`, status: 404 };
  const owners = hits.map(h => h.ownerUsername).join(', ');
  return { error: `${ref.box}/${ref.project} is shared with you by more than one owner (${owners}); ask by projectId`, status: 409 };
}

/**
 * The PR branch for a thread: `termag-<asker>/<thread>`, the asker's termag
 * username with anything but letters, digits, `-` and `_` turned into `-`, so
 * a `.` in a username never makes a ref git refuses.
 */
export function askBranch(username: string, threadId: string): string {
  const safe = username.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
  return `termag-${safe}/${threadId}`;
}

/**
 * A run's extra PR branches are `pr/<key>` in its clone (deploy/termag-subagent-run
 * PR_NAME_RE); the thread's own PR has the key ''.
 */
export const ASK_PR_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The most draft PRs one thread opens, its own included. */
export const MAX_ASK_PRS = 10;

/** `askBranch` for the thread's own PR, `askBranch-<key>` for a pr/<key> branch's. */
export function askPrBranch(username: string, threadId: string, key: string): string {
  return key ? `${askBranch(username, threadId)}-${key}` : askBranch(username, threadId);
}

/**
 * The PR key a bundle head publishes as: '' for the run's own branch (`ask`, or
 * `HEAD` from a box that sends one head), the <key> of `refs/heads/pr/<key>`;
 * null for anything else.
 */
export function askPrKeyOfRef(ref: string): string | null {
  if (ref === 'HEAD' || ref === 'refs/heads/ask') return '';
  const m = /^refs\/heads\/pr\/(.+)$/.exec(ref);
  return m && ASK_PR_KEY.test(m[1]) ? m[1] : null;
}

/** How a target is written back to people: `box/project@workstream`, `@main` left out. */
export function askTarget(box: string, project: string, workstream: string): string {
  return `${box}/${project}${workstream === 'main' ? '' : `@${workstream}`}`;
}

const PR_BODY_BEGIN = '<!-- TERMAG_PR_BODY_BEGIN -->';
const PR_BODY_END = '<!-- TERMAG_PR_BODY_END -->';

/** A marker value as `deploy/termag-pr-body` writes it: nothing that can close the comment. */
function markerValue(v: string): string {
  return v.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
}

/**
 * The shape `deploy/termag-pr-body` gives a PR opened from a box, so termag's
 * PRs are found the same way whoever opened them: the body between the
 * markers, then `<!-- termag: box=… project=… ask=… -->` and the footer.
 * Every `<!--` in the body is defused, so text from a run or a commit message
 * can neither fake nor close the markers, nor hide anything in a comment.
 */
export function markPrBody(body: string, meta: { box: string; project: string; ask?: string }): string {
  const fields = [`box=${markerValue(meta.box)}`, `project=${markerValue(meta.project)}`];
  if (meta.ask) fields.push(`ask=${markerValue(meta.ask)}`);
  return `${PR_BODY_BEGIN}\n${body.replace(/<!--/g, '&lt;!--')}\n${PR_BODY_END}\n\n<!-- termag: ${fields.join(' ')} -->\n<sub>Opened from termag</sub>\n`;
}

/**
 * A PR's body with its marked part replaced by `fresh`'s, for a follow-up
 * turn: anything a person added outside the markers stays. Null when `current`
 * has no markers (someone rewrote the body), so it is left alone.
 */
export function replaceMarkedBody(current: string, fresh: string): string | null {
  const span = (s: string) => {
    const b = s.indexOf(PR_BODY_BEGIN);
    const e = s.lastIndexOf(PR_BODY_END);
    return b >= 0 && e > b ? { b, e: e + PR_BODY_END.length } : null;
  };
  const cur = span(current);
  const next = span(fresh);
  if (!cur || !next) return null;
  return current.slice(0, cur.b) + fresh.slice(next.b, next.e) + current.slice(cur.e);
}

/** The most of a PR description termag publishes; GitHub takes 65536 characters for the whole body. */
export const PR_DESCRIPTION_MAX = 16 * 1024;

/** A description cut to PR_DESCRIPTION_MAX bytes, saying so when it was. */
export function capDescription(text: string): string {
  const t = text.trim();
  if (Buffer.byteLength(t, 'utf8') <= PR_DESCRIPTION_MAX) return t;
  return `${truncateUtf8(t, PR_DESCRIPTION_MAX - 100).trimEnd()}\n\n_[termag: the description was cut to ${PR_DESCRIPTION_MAX / 1024} KB]_`;
}

/**
 * A run-written description: an optional `# Title` first line, then the body.
 * The title is one line of at most 200 characters.
 */
export function splitDescription(text: string): { title: string | null; body: string } {
  const t = text.replace(/\r\n?/g, '\n').trim();
  const m = /^# +(.+)(?:\n|$)/.exec(t);
  if (!m) return { title: null, body: t };
  return { title: m[1].trim().slice(0, 200) || null, body: t.slice(m[0].length).trim() };
}

/** Commit-message trailers termag or tools add, which say nothing about the change. */
const NOISE_TRAILER = /^(Co-Authored-By|Generated-by|Signed-off-by|Change-Id):/i;

/**
 * A description built from the commits, oldest first, when the run wrote none:
 * one commit's message body (its subject is the title), or a list of subjects
 * with each commit's body underneath.
 */
export function commitDescription(commits: Array<{ subject: string; body: string }>): string {
  const clean = (b: string) => b.split('\n').filter(l => !NOISE_TRAILER.test(l.trim())).join('\n').trim();
  const cs = commits.map(c => ({ subject: c.subject.trim(), body: clean(c.body) }));
  if (cs.length === 0) return '';
  if (cs.length === 1) return cs[0].body || cs[0].subject;
  const parts = ['## Commits', '', ...cs.map(c => `- ${c.subject}`)];
  for (const c of cs) if (c.body) parts.push('', `### ${c.subject}`, '', c.body);
  return parts.join('\n');
}

/**
 * `box` is the EC2 instance id of the box the run happened on (termag's id
 * when it has none). The description, when there is one, comes first; termag's
 * provenance follows a rule. `prKey` names the run's pr/<key> branch for
 * one of a thread's extra PRs.
 */
export function prBody(input: {
  senderUsername: string; target: string; threadId: string; box: string; project: string; description?: string; prKey?: string;
}): string {
  const description = input.description?.trim();
  return markPrBody([
    ...(description ? [description, '', '---', ''] : []),
    `Opened by \`termag ask\` for ${input.senderUsername}: an agent run on \`${input.target}\`, thread \`${input.threadId}\`.`,
    ...(input.prKey ? ['', `This is one of the thread's pull requests, from the run's branch \`pr/${input.prKey}\`; the reply to the ask lists them all.`] : []),
    '',
    'The run worked in its own clone of the committed code. termag checked its commits before pushing (descends from the base, no protected paths, authored by the asker, no secret-shaped strings); review the change as you would any other before marking it ready.',
    '',
    `Follow-ups on the thread push here: \`termag ask ${input.target} --thread ${input.threadId} "…"\`.`,
  ].join('\n'), { box: input.box, project: input.project, ask: input.threadId });
}

export interface MessageRow {
  id: string;
  threadId: string;
  status: string;
  hop: number;
  error: string | null;
  numTurns: number | null;
  replyBytes: number | null;
  publish: string | null;
  publishDetail: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  readAt: Date | null;
  queuedPrompt?: string | null;
}

export interface ThreadRow {
  id: string;
  hopCount: number;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  /** agent_thread_prs, oldest first; a thread from before them has its own PR only on the fields above. */
  prs?: Array<{ key: string; branch: string; prNumber: number; prUrl: string }>;
}

export interface PrView { key: string; url: string; number: number; branch: string | null }

/** Every PR the thread opened, its own first, then in the order they were opened. */
export function threadPrs(t: ThreadRow): PrView[] {
  const rows: PrView[] = (t.prs ?? []).map(p => ({ key: p.key, url: p.prUrl, number: p.prNumber, branch: p.branch }));
  if (!rows.some(p => p.key === '') && t.prUrl && t.prNumber) rows.unshift({ key: '', url: t.prUrl, number: t.prNumber, branch: t.branch });
  return [...rows.filter(p => p.key === ''), ...rows.filter(p => p.key !== '')];
}

/**
 * A message as the CLI sees it. `reply` is the text only while a process holds
 * it for hand-off (askReplyBus.ts); after that `replyDelivered` says whether a
 * poll got it before it was dropped. Nothing keeps the text. `pr` is the
 * thread's own PR (else its first), for CLIs from before `prs`.
 */
export function messageView(m: MessageRow, t: ThreadRow, target: string, reply: string | null) {
  const prs = threadPrs(t);
  const first = prs[0];
  return {
    message: m.id,
    thread: t.id,
    target,
    status: m.status,
    // Submitted and waiting for its parked box to come up or its project's clone to finish.
    queued: m.queuedPrompt != null,
    hop: m.hop,
    hops: t.hopCount,
    createdAt: m.createdAt.toISOString(),
    startedAt: m.startedAt?.toISOString() ?? null,
    completedAt: m.completedAt?.toISOString() ?? null,
    error: m.error,
    numTurns: m.numTurns,
    replyBytes: m.replyBytes,
    reply,
    replyDelivered: m.readAt !== null,
    publish: m.publish ? { status: m.publish, detail: m.publishDetail } : null,
    pr: first ? { url: first.url, number: first.number, branch: first.branch } : null,
    prs,
  };
}

export interface RunResult {
  result: string;
  sessionId: string | null;
  isError: boolean;
  numTurns: number | null;
  exitReason: string | null;
  baseSha: string | null;
  repo: string | null;
  /** The box uploaded a bundle for this run before the result. */
  bundle: boolean;
  /**
   * The PR description the run wrote (runSystemPrompt's TERMAG_ASK_PR_BODY_FILE),
   * untrusted; askPublish checks and caps it. Null when it wrote none.
   */
  prDescription: string | null;
  /** The descriptions of the run's pr/<key> branches, by key (TERMAG_ASK_PR_DIR), untrusted like prDescription. */
  prDescriptions: Record<string, string>;
}

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SESSION = /^[A-Za-z0-9-]{1,64}$/;
export const isRepoName = (s: string): boolean => REPO.test(s) && !s.includes('..');

/** Cut a string to at most `max` UTF-8 bytes without splitting a character. */
export function truncateUtf8(s: string, max: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return s;
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

export function parseRunResult(body: unknown): RunResult | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (typeof b.result !== 'string') return { error: 'result (string) required' };
  const str = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : null);
  const numTurns = typeof b.numTurns === 'number' && Number.isInteger(b.numTurns) && b.numTurns >= 0 ? b.numTurns : null;
  const exitReason = typeof b.exitReason === 'string' && b.exitReason.trim()
    ? truncateUtf8(b.exitReason.trim().replace(/\s+/g, ' '), 300) : null;
  const repo = typeof b.repo === 'string' && isRepoName(b.repo) ? b.repo : null;
  return {
    result: b.result,
    sessionId: str(b.sessionId, SESSION),
    isError: b.isError === true,
    numTurns,
    exitReason,
    baseSha: str(b.baseSha, SHA),
    repo,
    bundle: b.bundle === true,
    prDescription: typeof b.prDescription === 'string' && b.prDescription.trim() ? b.prDescription : null,
    prDescriptions: parsePrDescriptions(b.prDescriptions),
  };
}

function parsePrDescriptions(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, d] of Object.entries(v as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_ASK_PRS) break;
    if (ASK_PR_KEY.test(k) && typeof d === 'string' && d.trim()) out[k] = d;
  }
  return out;
}

/**
 * A reply as an asking agent sees it: fenced as untrusted data, naming where
 * it came from. A closing tag inside the text is defused so the reply cannot
 * end its own fence early.
 */
export function replyEnvelope(input: { from: string; threadId: string; messageId: string; text: string }): string {
  const text = input.text.replace(/<\/untrusted-reply/gi, '<\\/untrusted-reply');
  return `<untrusted-reply from="${input.from}" thread="${input.threadId}" message="${input.messageId}">\n${text}\n</untrusted-reply>`;
}

/**
 * Appended to the run's system prompt. It names the sender (always the
 * project's owner: asks are owner-only) and states how the run works: as the
 * owner, in a clone, publishing only through termag.
 */
export function runSystemPrompt(input: {
  senderUsername: string;
  senderDisplayName: string;
  target: string;
  branch: string;
}): string {
  return [
    `You are answering a request sent to ${input.target} by ${input.senderDisplayName} (${input.senderUsername}), from another of their termag agents or their own terminal.`,
    'This run executes headless as the box owner, with their credentials, network and tools, in a fresh clone of the project\'s committed code.',
    '- Work only in this clone: never edit, commit in or reset the live checkout of the project or any other directory on the box.',
    '- Do not change credentials, permissions, CI workflows, CODEOWNERS, deploy/ or sudoers files: termag refuses to publish commits that touch them.',
    `- If the request needs code changes, commit them on the \`ask\` branch, the one checked out at the start. termag publishes your commits as a draft pull request on ${input.branch}; never push or open a pull request yourself.`,
    `- If the environment variable TERMAG_ASK_PR_DIR is set and the sender asks for separate pull requests, or the work is clearly several independent changes, termag can open more than one: put each further pull request on its own branch \`pr/<name>\` (lowercase letters, digits and hyphens, at most 40) started from the base (\`git switch -c pr/<name> termag/base\`), commit there, and write its description to \`$TERMAG_ASK_PR_DIR/<name>.md\` in the same form. Each becomes a draft pull request on ${input.branch}-<name>, at most ${MAX_ASK_PRS} per thread counting the one on \`ask\`; later turns update them by branch name. Switch back to \`ask\` for the main change. Other branch names are not published.`,
    '- If you commit and the environment variable TERMAG_ASK_PR_BODY_FILE is set, write the pull request description to that file (it is outside the git tree; never commit it): an optional first line `# <title>`, then Markdown saying what changed and why, how you tested it, and open questions for the reviewer. Rewrite it on a later turn if the change moves on. Without one, termag builds the description from your commit messages, so write those well either way.',
    'Finish with a short, self-contained answer for the sender: what you found or changed, and anything they must check.',
  ].join('\n');
}

/** The `status_description` from an AGENTS.md's YAML frontmatter, single-line values only. */
export function parseStatusDescription(text: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const line = /^status_description:[ \t]*(.+)$/m.exec(m[1]);
  if (!line) return null;
  let v = line[1].trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
  else if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
  else if (/^[|>]/.test(v)) return null;
  v = v.trim();
  return v ? truncateUtf8(v, 500) : null;
}

/** termag's AgentExtension on a target's card: what an asker needs to know before asking. */
export const ASK_EXTENSION_URI = 'urn:termag:ask:v1';

export interface TargetInput {
  projectId: string;
  box: string;
  project: string;
  workstream: string;
  owner: string;
  shared: boolean;
  description: string | null;
  /** Instance.status: ready, stopped, hibernated, … */
  boxStatus: string;
  connected: boolean;
  capabilities: string[];
  /** Disconnected, but an ask waits for it and starts it (shouldQueue). */
  wakes?: boolean;
  /** Project.setupStatus / setupError: an ask to a project still cloning waits; one whose setup failed is refused. */
  setupStatus: string;
  setupError: string | null;
}

/**
 * Whether the target can take a run now, and if not why (the reason an ask
 * would be rejected with). A parked box of the asker's own is askable: the
 * ask starts it and runs once it connects; its reason says so.
 */
export function targetAskable(
  t: Pick<TargetInput, 'box' | 'project' | 'boxStatus' | 'connected' | 'capabilities' | 'wakes' | 'setupStatus' | 'setupError'>,
): { askable: boolean; reason: string | null } {
  const unready = setupRefusal({ name: t.project, setupStatus: t.setupStatus, setupError: t.setupError });
  if (unready) return { askable: false, reason: unready.error };
  if ((t.connected || t.wakes) && isProjectSettingUp(t.setupStatus)
    && (!t.connected || t.capabilities.includes(ASK_AGENT_CAPABILITY))) {
    return { askable: true, reason: `${t.project} is still being set up (${t.setupStatus}); an ask waits for its clone and runs once it is ready (up to ${SETUP_QUEUE_TTL_MS / 60_000} minutes)` };
  }
  if (!t.connected && t.wakes) {
    return { askable: true, reason: `${t.box} is ${t.boxStatus}; an ask starts it and runs once it is up (up to ${QUEUE_TTL_MS / 60_000} minutes)` };
  }
  if (!t.connected) return { askable: false, reason: `${t.box} is not connected (${t.boxStatus}); start the box and try again` };
  if (!t.capabilities.includes(ASK_AGENT_CAPABILITY)) return { askable: false, reason: `${t.box}'s agent can't run asks yet; it needs a newer termag agent` };
  return { askable: true, reason: null };
}

/**
 * One askable target as an A2A AgentCard (v1.0 JSON field names). It is the
 * authenticated, per-caller "extended" card: there is no A2A endpoint, so no
 * supportedInterfaces; askers use the name with `termag ask`.
 */
export function targetCard(t: TargetInput) {
  const { askable, reason } = targetAskable(t);
  return {
    name: askTarget(t.box, t.project, t.workstream),
    description: t.description ?? '',
    provider: { organization: t.owner },
    version: ASK_AGENT_CAPABILITY,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [{
        uri: ASK_EXTENSION_URI,
        description: "termag ask: a headless Claude Code turn on the target box, as its owner, in a clone of the committed code; commits come back as a draft PR",
        required: false,
        params: {
          projectId: t.projectId, box: t.box, project: t.project, workstream: t.workstream,
          owner: t.owner, shared: t.shared, boxStatus: t.boxStatus, connected: t.connected,
          askable, reason, cancel: t.capabilities.includes(ASK_CANCEL_CAPABILITY),
        },
      }],
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'text/uri-list'],
    skills: [],
  };
}
