import { randomBytes } from 'node:crypto';
import type { Api } from './api.js';
import type { CommandSpec, ParsedArgs } from './args.js';
import { authedApi, session } from './commands.js';
import type { Ctx } from './context.js';
import { CliError, EXIT, usage, type ExitCode } from './errors.js';
import { json, table } from './output.js';
import { CREATE_WAIT_S, claudeModelOption, diskOption, environmentOption, ownBox, projectOnNewBox, startAndWait, START_WAIT_S } from './lifecycle.js';

/**
 * `termag ask`: agent-to-agent asks. The
 * orchestrator runs the prompt on the target project's box, as its owner, in a
 * clone of its committed code and hands the reply to the poll waiting for it,
 * plus a draft PR for any commits. The orchestrator also stores the reply for
 * 14 days, so `--reply` reads it after the fact (an orchestrator with no key for
 * it stores nothing, and then a reply nobody waited for is dropped). The
 * thread id continues the conversation. A follow-up on a
 * thread whose turn is still working goes into that turn, where the box can
 * take it: the message it
 * joins is `superseded`, and a wait on that one follows on to the follow-up's
 * reply.
 */

/** One GET waits this long server-side (MAX_WAIT_SEC); the request timeout sits above it. */
const WAIT_S = 50;
const REQUEST_TIMEOUT_MS = 70_000;
// `:<repo>` names one repository of a multi-repo project.
const REF_RE = /^[A-Za-z0-9_-]+\/[^/@:\s]+(@[^/@:\s]+)?(:[A-Za-z0-9][A-Za-z0-9_-]*)?$/;
const ID_RE = /^[a-z0-9]{8,40}$/;
const PR_RE = /^(?:(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#?\d{1,9}|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d{1,9}\/?)$/;
/** The longest --title, in characters; the orchestrator refuses a longer one too (MAX_ASK_TITLE_CHARS). */
export const MAX_TITLE_CHARS = 60;
const TITLE_EXAMPLE = '--title "Members-only file composer (#765)"';

export const ASK_COMMANDS: Record<string, CommandSpec> = {
  ask: {
    summary: "Ask another project's agent; prints its answer and a draft PR for any commits (a --thread follow-up while it works joins the running turn)",
    // A --thread follow-up while the thread's turn works goes into that turn where the box can take it ("Steering a working ask").
    usage: 'termag ask <box>/<project>[@<workstream>][:<repo>] <prompt|-> [--title <text>] [--model opus|sonnet|haiku] [--thread <id>] [--update-pr <n>] [--no-wait] [--no-notify] [--timeout <seconds>]\n'
      + '       termag ask --new-box [--size small|medium|large] [--disk <GB>] [--from <box/project|template|github-url>... | --environment <name>] <box>/<project>[:<repo>] <prompt|-> [--title <text>] [--model opus|sonnet|haiku] [--no-wait] [--no-notify]\n'
      + '       termag ask --reply <message> [--no-wait] [--timeout <seconds>]\n'
      + '       termag ask --cancel <message>\n'
      + '       termag ask --inbox\n'
      + '       termag ask --targets\n'
      + '       termag ask --find <title>\n'
      + '\n'
      + 'A multi-repo project is asked one repository at a time, <box>/<project>[@<workstream>]:<repo>: the run\n'
      + "starts in that repository's checkout, or the workstream's worktree of it. --targets lists each one.",
    options: {
      title: { type: 'string' },
      model: { type: 'string' },
      thread: { type: 'string' },
      'update-pr': { type: 'string' },
      'no-wait': { type: 'boolean' },
      'no-notify': { type: 'boolean' },
      reply: { type: 'string' },
      cancel: { type: 'string' },
      inbox: { type: 'boolean' },
      targets: { type: 'boolean' },
      find: { type: 'string' },
      timeout: { type: 'string' },
      'new-box': { type: 'boolean' },
      size: { type: 'string' },
      disk: { type: 'string' },
      from: { type: 'string', multiple: true },
      environment: { type: 'string' },
    },
    maxArgs: 2,
    details: `--title <text>   Names the thread: what it is about, plus the PR number if any, at most ${MAX_TITLE_CHARS} characters,\n`
      + `                 e.g. ${TITLE_EXAMPLE}. termag shows the thread by this name (sidebar, tabs,\n`
      + '                 Files, chat header); an untitled thread shows as ask-<thread id>. Nothing is taken from the prompt.\n'
      + '                 With --thread it names or renames that thread, and the sidebar shows the new name at once.\n'
      + '--model <tier>   The Claude model the turn runs on: opus, sonnet or haiku (the gateway\'s pinned Opus, Sonnet or\n'
      + '                 Haiku). The thread keeps it: follow-ups without --model run on it too, and one with --model\n'
      + '                 switches it from that turn on. Without it, the thread\'s model, else the box\'s default. With\n'
      + '                 --new-box the new project starts on it too. An orchestrator or box agent too old for it runs\n'
      + '                 the ask anyway, on its default, and says --model was ignored.\n'
      + '--update-pr <n>  The pull request to publish to: <n>, <owner>/<name>#<n> or its github.com URL. Without it, a run\n'
      + '                 whose branch builds on exactly one open pull request you opened publishes there anyway; name one\n'
      + "                 when it builds on a stack of yours, or to override. It must be open, in the project's repository\n"
      + '                 (not a fork), not a base branch, and opened by you (or a termag-<you>/… branch). A push that is not a\n'
      + '                 fast-forward of it is refused. The thread keeps it: follow-ups publish there too.\n'
      + '--new-box        Ask on a box of its own: makes <box> and <project> for this ask when they are not there yet\n'
      + '                 (an existing one is used as it is), waits for the box, then asks. The box is sized like any\n'
      + "                 (--size, else the repositories' .termag/environment.json, the largest of them, else your default)\n"
      + "                 with a disk of --disk GB (50 to 300, else the repositories' diskGiB, else 120), is\n"
      + '                 always with termag setup on (a repository\'s "setupEnabled": false is overridden, and said: the run needs it),\n'
      + '                 stopped when idle and never hibernated, and is recorded as made for the thread; the simple UI\n'
      + '                 shows only its asks. --timeout covers the wait for a new box too.\n'
      + '--from <src>     What the project starts from: another project (<box>/<project>), a template or a GitHub URL.\n'
      + '                 Give it once per repository the task needs: twice or more makes a multi-repo project of exactly\n'
      + '                 those, and the ask runs in one of them, :<repo> on the target, else the first --from\'s. None is\n'
      + '                 an empty project. Each extra repository costs clone time and can raise the box size. A multi-repo\n'
      + '                 project that is already there is asked as it is, no --from needed: :<repo>, else its first.\n'
      + '--environment <name>  Instead of --from: the project holds that environment\'s repositories,\n'
      + '                 and the new box is sized by its definition (--size still wins). The ask runs in its first\n'
      + '                 repository, or :<repo>.\n'
      + '--no-notify      Don\'t tell this session when the ask finishes. By default termag does, once, when nothing is\n'
      + '                 waiting on it (with --no-wait, say): a chat gets a [termag] notice as its next turn, an agent pane\n'
      + '                 has it typed in once it is idle. The notice has the state, ids, PR and publish outcome, never the reply.\n'
      + '--find <title>   The sessions and ask threads of yours that termag shows by that title (the sidebar\'s name for\n'
      + '                 them: Claude\'s title for a session, an ask thread\'s --title), each with the target to ask and,\n'
      + '                 for a thread, the --thread that talks to that same session. Every word must match; case is ignored.',
  },
};

export interface AskMessage {
  message: string;
  thread: string;
  /** What the thread is called; absent from orchestrators before thread titles. */
  title?: string | null;
  target: string;
  status: string;
  hop: number;
  hops: number;
  createdAt: string;
  startedAt?: string | null;
  completedAt: string | null;
  error: string | null;
  reply: string | null;
  replyBytes: number | null;
  replyDelivered: boolean;
  /** The reply is stored, so `--reply` reads it; absent from orchestrators before stored replies. */
  replyStored?: boolean;
  /** This orchestrator stores replies (it has the key to seal them with); absent or false, a reply nobody waits for is dropped. */
  replyKept?: boolean;
  publish: { status: string; detail: string | null } | null;
  /** The thread's own PR, else its first. */
  pr: { url: string; number: number; branch: string | null } | null;
  /** Every PR the thread opened, its own (key '') first; orchestrators from before them leave it out. */
  prs?: AskPr[];
  /** Superseded: the follow-up that went into its turn, whose reply answers it too. */
  supersededBy?: string | null;
  /**
   * A wait on a superseded message, answered together (the orchestrator's
   * default): the last follow-up of its turn, whose state and reply this view
   * carries under this message's id.
   */
  answeredWith?: string;
  /** What became of the finish notice to the session that sent it (chat, pane, waiter, gone, …); absent from older orchestrators. */
  notice?: string | null;
  /** The Claude tier it asked for until it starts, then the one its turn ran on; null for the box's default, absent from older orchestrators. */
  model?: string | null;
  /** Why the tier it asked for did not reach its turn (it ran on the box's default); absent when it did, or none was asked. */
  modelIgnored?: string | null;
}

interface AskPr { key: string; url: string; number: number; branch: string | null }

const prsOf = (m: AskMessage): AskPr[] => m.prs ?? (m.pr ? [{ key: '', ...m.pr }] : []);

interface AskStarted {
  thread: string;
  message: string;
  status: string;
  hop: number;
  hops: number;
  target: string;
  branch: string;
  /** The existing PR the thread publishes to (`--update-pr`); `branch` is then its head branch. */
  targetPr?: number;
  /** Waiting on the orchestrator for its parked box to come up, or its project's clone to finish. */
  queued?: boolean;
  /** What it waits for; orchestrators that only held asks for a box leave it out. */
  queuedFor?: 'box' | 'setup' | 'turn';
  /** A follow-up while the thread's turn ran: true when it went into that turn, which supersedes `supersedes`. */
  steered?: boolean;
  supersedes?: string;
  /** Not steered: it runs after this message, and `steerRefused` says why the turn could not take it. */
  queuedBehind?: string;
  steerRefused?: string;
  /** The orchestrator will store the reply; absent from orchestrators before stored replies. */
  replyKept?: boolean;
  /** How termag will tell this session when the ask finishes; absent when it won't (an older orchestrator, the flag off, --no-notify). */
  notify?: 'chat' | 'pane';
  /** The --model the orchestrator took (a replay: what the message asked for or ran on, null for none); absent from orchestrators before --model. */
  model?: string | null;
  /** Why the turn won't run on that --model (a headless run, an older box agent). */
  modelIgnored?: string;
}

/** The message states are A2A's TaskState names. */
const finished = (m: Pick<AskMessage, 'status'>) => m.status === 'completed' || m.status === 'failed' || m.status === 'canceled' || m.status === 'superseded';

const A2A_STATE: Record<string, string> = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  canceled: 'TASK_STATE_CANCELED',
  // Its work went on in the same turn as the follow-up's: done, with the answer on that Task.
  superseded: 'TASK_STATE_COMPLETED',
  rejected: 'TASK_STATE_REJECTED',
};

/**
 * A message as an A2A v1.0 Task in its JSON binding: id = message,
 * contextId = thread, the reply and the PR as artifacts. The reply artifact is
 * there only for the poll that got the text; termag's own fields go under
 * metadata.termag.
 */
export function a2aTask(m: AskMessage) {
  const artifacts: Array<Record<string, unknown>> = [];
  if (m.reply !== null) {
    artifacts.push({ artifactId: `${m.message}-reply`, name: 'reply', parts: [{ text: m.reply, mediaType: 'text/plain' }] });
  }
  for (const p of prsOf(m)) {
    artifacts.push({
      artifactId: p.key ? `${m.message}-pr-${p.key}` : `${m.message}-pr`, name: 'pull-request', parts: [{ url: p.url }],
      metadata: { number: p.number, branch: p.branch, ...(p.key ? { key: p.key } : {}) },
    });
  }
  const status: Record<string, unknown> = {
    state: A2A_STATE[m.status] ?? 'TASK_STATE_UNSPECIFIED',
    timestamp: m.completedAt ?? m.startedAt ?? m.createdAt,
  };
  const note = m.answeredWith && finished(m) && !m.error ? `answered together with follow-up ${m.answeredWith}` : m.status === 'superseded' && m.supersededBy ? `superseded by message ${m.supersededBy}, whose reply answers this one too` : m.error;
  if (note) {
    status.message = { messageId: `${m.message}-status`, contextId: m.thread, taskId: m.message, role: 'ROLE_AGENT', parts: [{ text: note }] };
  }
  return {
    id: m.message,
    contextId: m.thread,
    status,
    artifacts,
    metadata: {
      termag: {
        target: m.target, status: m.status, hop: m.hop, hops: m.hops, error: m.error,
        replyBytes: m.replyBytes, replyDelivered: m.replyDelivered, replyStored: m.replyStored ?? false, publish: m.publish, pr: m.pr, prs: prsOf(m),
        ...(m.supersededBy ? { supersededBy: m.supersededBy } : {}),
        ...(m.answeredWith ? { answeredWith: m.answeredWith } : {}),
        ...(m.notice ? { notice: m.notice } : {}),
        ...(m.model ? { model: m.model } : {}),
        ...(m.modelIgnored ? { modelIgnored: m.modelIgnored } : {}),
      },
    },
  };
}

/** The Task a just-started ask is, before its first poll. */
function startedTask(s: AskStarted) {
  return {
    id: s.message,
    contextId: s.thread,
    status: { state: A2A_STATE[s.status] ?? 'TASK_STATE_UNSPECIFIED', timestamp: new Date().toISOString() },
    artifacts: [],
    metadata: {
      termag: {
        target: s.target, status: s.status, hop: s.hop, hops: s.hops, branch: s.branch, ...(s.notify ? { notify: s.notify } : {}),
        // As a2aTask's: the tier the turn runs on, and why an asked-for one was ignored.
        ...(s.model && !s.modelIgnored ? { model: s.model } : {}),
        ...(s.modelIgnored ? { modelIgnored: s.modelIgnored } : {}),
      },
    },
  };
}

/** An ask the target refused at once (A2A `rejected`): nothing was stored, the reason is the status message. */
function rejectedTask(id: string, thread: string | null, reason: string) {
  return {
    id,
    ...(thread ? { contextId: thread } : {}),
    status: {
      state: 'TASK_STATE_REJECTED',
      message: { messageId: `${id}-status`, ...(thread ? { contextId: thread } : {}), taskId: id, role: 'ROLE_AGENT', parts: [{ text: reason }] },
      timestamp: new Date().toISOString(),
    },
    artifacts: [],
    metadata: { termag: { status: 'rejected', error: reason } },
  };
}

const isRejection = (err: unknown): err is CliError => err instanceof CliError && err.body?.status === 'rejected';

const WAKEABLE = new Set(['stopping', 'stopped', 'hibernating', 'hibernated', 'starting']);

/**
 * An orchestrator that refuses an ask because the box is down (one from
 * before it queued such asks, or a box it won't start for us) gets the box
 * started here when it is the caller's own: let a parking box park, start it,
 * wait for its agent. False when there is nothing this can do.
 */
async function wakeBox(ctx: Ctx, api: Api, target: string, args: ParsedArgs): Promise<boolean> {
  const box = await ownBox(api, target.split('/')[0]).catch(() => null);
  if (!box || !WAKEABLE.has(box.state)) return false;
  if (!args.json) ctx.err(`termag: ${box.name} is ${box.state}; starting it, then asking`);
  await startAndWait(ctx, api, box, timeoutSeconds(args) ?? START_WAIT_S, args.json);
  return true;
}

/** A new message's id, chosen here so a retried POST names the same ask (the server's id shape: 8-40 of [a-z0-9]). */
const newMessageId = () => `a${randomBytes(12).toString('hex')}`;

/** The reply fenced as untrusted data; a closing tag inside is defused. */
export function replyEnvelope(m: Pick<AskMessage, 'target' | 'thread' | 'message'>, text: string): string {
  const body = text.replace(/<\/untrusted-reply/gi, '<\\/untrusted-reply');
  return `<untrusted-reply from="${m.target}" thread="${m.thread}" message="${m.message}">\n${body}\n</untrusted-reply>`;
}

function timeoutSeconds(args: ParsedArgs): number | null {
  const raw = args.options.timeout;
  if (raw === undefined) return null;
  const n = Number(raw);
  if (typeof raw !== 'string' || !Number.isFinite(n) || n <= 0) throw usage('--timeout takes a number of seconds');
  return n;
}

async function readPrompt(ctx: Ctx, raw: string): Promise<string> {
  if (raw !== '-') return raw;
  if (!ctx.readStdin) throw usage('reading the prompt from stdin is not available here');
  return ctx.readStdin();
}

/**
 * A deploy's overlap answers with the ALB's 502/504 or a draining process's
 * 503, and a dropped connection or a stalled request look the same from here:
 * all of them are retried, the rest are real answers.
 */
const RETRY_STATUSES = new Set([502, 503, 504]);
const RETRY_FOR_MS = 10 * 60_000;
const RETRY_DELAY_MS = 1_000;
/** Well inside the orchestrator's 60 s hand-off window (HANDOFF_TTL_MS). */
const RETRY_DELAY_MAX_MS = 5_000;

export function isTransient(err: unknown): err is CliError {
  return err instanceof CliError
    && (err.code === 'unreachable' || err.code === 'timeout' || (err.status !== undefined && RETRY_STATUSES.has(err.status)));
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Long-poll until the message finishes (one 50 s request at a time, never one
 * open-ended wait), once with --no-wait, or until --timeout. An orchestrator
 * that stops answering is retried with backoff for RETRY_FOR_MS, a step at
 * most RETRY_DELAY_MAX_MS, so a reply that finished during the outage is
 * still being held when the retry lands.
 */
async function waitForMessage(ctx: Ctx, api: Api, firstId: string, args: ParsedArgs, announced = false): Promise<AskMessage> {
  let id = firstId;
  const noWait = args.options['no-wait'] === true;
  const limit = timeoutSeconds(args);
  const deadline = limit === null ? Infinity : Date.now() + limit * 1000;
  const retryFor = ctx.askRetryForMs ?? RETRY_FOR_MS;
  const baseDelay = ctx.pollIntervalMs ?? RETRY_DELAY_MS;
  // Whether the orchestrator stores replies, as its last answer said; unknown until the first one.
  let kept = false;
  const later = () => kept
    ? `\`termag ask --reply ${id}\` waits again while it runs, and prints the reply once it has finished`
    : `\`termag ask --reply ${id}\` waits again while it runs (the reply goes only to a waiting poll)`;
  let notified = announced;
  let failingSince: number | null = null;
  let delay = baseDelay;
  for (;;) {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const wait = noWait ? 0 : Math.min(WAIT_S, left);
    let m: AskMessage;
    try {
      m = await api.request<AskMessage>('GET', `/ask/messages/${id}?wait=${wait}`);
    } catch (err) {
      if (noWait || !isTransient(err)) throw err;
      const now = Date.now();
      if (failingSince === null) {
        failingSince = now;
        if (!args.json) ctx.err(`termag: ${err.message}; retrying (message ${id})…`);
      }
      if (now - failingSince >= retryFor) throw new CliError(err.code, `${err.message}; gave up retrying, ${later()}`, err.status);
      if (now >= deadline) throw new CliError('timeout', `Still running after ${limit}s; ${later()}`);
      await sleep(Math.min(delay, deadline - now));
      delay = Math.min(delay * 2, RETRY_DELAY_MAX_MS);
      continue;
    }
    failingSince = null;
    delay = baseDelay;
    kept = m.replyKept === true;
    // An orchestrator with ASK_SUPERSEDED_REPLY=follow answers the superseded state at once: wait for the follow-up instead.
    if (m.status === 'superseded' && m.supersededBy && !noWait) {
      if (!args.json) ctx.err(`termag: ${id} was superseded by message ${m.supersededBy}; waiting for that reply…`);
      id = m.supersededBy;
      continue;
    }
    if (finished(m) && m.answeredWith && !args.json) ctx.err(`termag: answered together with follow-up ${m.answeredWith}`);
    if (finished(m) || noWait) return m;
    if (Date.now() >= deadline) throw new CliError('timeout', `Still running after ${limit}s; ${later()}`);
    if (!notified && !args.json) {
      ctx.err(`termag: waiting for ${m.target} (message ${id}, thread ${m.thread})…`);
      notified = true;
    }
  }
}

/**
 * The session this ask comes from, so the simple UI nests the thread under it:
 * a chat turn's project and
 * workstream (the agent sets TERMAG_PROJECT_ID and TERMAG_WORKSTREAM, since a
 * turn has no pane), else the tmux pane's session. Null outside both; the
 * orchestrator checks whatever is sent. Either way, from inside Claude Code,
 * the asking conversation's session id (CLAUDE_CODE_SESSION_ID) as
 * `claudeSession`, which the thread's telemetry names as its parent
 * (termag.ask.parent.session; docs/agents/gotchas.md, the agent telemetry
 * resource); an older orchestrator ignores it.
 */
export async function askSender(ctx: Ctx): Promise<{ projectId?: string; workstream?: string; session?: string; claudeSession?: string } | null> {
  const claude = ctx.env.CLAUDE_CODE_SESSION_ID?.trim();
  const claudeSession = claude && /^[A-Za-z0-9-]{8,64}$/.test(claude) ? { claudeSession: claude } : {};
  const projectId = ctx.env.TERMAG_PROJECT_ID?.trim();
  const workstream = ctx.env.TERMAG_WORKSTREAM?.trim();
  if (projectId && workstream) return { projectId, workstream, ...claudeSession };
  const r = ctx.env.TMUX && ctx.exec ? await ctx.exec('tmux', ['display-message', '-p', '#S'], { timeoutMs: 2000 }).catch(() => null) : null;
  const session = r && r.code === 0 ? r.stdout.trim() : '';
  if (session) return { session, ...claudeSession };
  return claudeSession.claudeSession ? claudeSession : null;
}

/**
 * POST /ask, retried like a poll through a deploy: the message id is ours,
 * so the orchestrator answers a repeat with the ask it already started.
 */
async function postAsk(ctx: Ctx, api: Api, body: Record<string, unknown>, args: ParsedArgs): Promise<AskStarted> {
  const retryFor = ctx.askRetryForMs ?? RETRY_FOR_MS;
  let delay = ctx.pollIntervalMs ?? RETRY_DELAY_MS;
  let failingSince: number | null = null;
  for (;;) {
    try {
      return await api.request<AskStarted>('POST', '/ask', body);
    } catch (err) {
      if (!isTransient(err)) throw err;
      const now = Date.now();
      if (failingSince === null) {
        failingSince = now;
        if (!args.json) ctx.err(`termag: ${err.message}; retrying the ask (message ${body.messageId})…`);
      }
      if (now - failingSince >= retryFor) {
        throw new CliError(err.code, `${err.message}; gave up retrying. The ask may have started: \`termag ask --reply ${body.messageId}\` waits for it, or check \`termag ask --inbox\``, err.status);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, RETRY_DELAY_MAX_MS);
    }
  }
}

/** A finished message whose reply this process did not get. */
const replyLost = (m: AskMessage) => finished(m) && m.reply === null && m.replyBytes !== null;

/** Stored replies are deleted this long after their message finished (the orchestrator's ASK_REPLY_TTL_MS). */
const REPLY_KEPT_MS = 14 * 24 * 60 * 60 * 1000;

function replyGone(m: AskMessage): string {
  const old = m.completedAt !== null && Date.now() - Date.parse(m.completedAt) > REPLY_KEPT_MS;
  if (m.replyKept && old) return `The reply to ${m.message} was kept for 14 days and has been deleted. Ask again (\`--thread ${m.thread}\` keeps the context).`;
  if (m.replyDelivered) return `The reply to ${m.message} went to an earlier poll and was not stored.`;
  return `The reply to ${m.message} was not delivered: nothing was waiting when it arrived, and it was not stored. Ask again (\`--thread ${m.thread}\` keeps the context).`;
}

function printMessage(ctx: Ctx, m: AskMessage): void {
  if (m.reply !== null) ctx.out(replyEnvelope(m, m.reply));
  else if (m.status === 'superseded') ctx.out(`The ask ${m.message} was superseded by ${m.supersededBy ?? 'a follow-up'}, which went into its turn and whose reply answers it: \`termag ask --reply ${m.supersededBy ?? '<message>'}\` waits for that.`);
  else if (!finished(m) && m.supersededBy) ctx.out(`Still running on ${m.target}: follow-up ${m.supersededBy} joined its turn, and the reply at the turn's end answers both; \`termag ask --reply ${m.message}\` waits for it.`);
  else if (!finished(m)) ctx.out(`Still running on ${m.target}; \`termag ask --reply ${m.message}\` waits for it${m.replyKept ? ', or prints the reply once it has finished' : ' (only a waiting poll gets the reply)'}.`);
  else if (m.status === 'canceled') ctx.out(`The ask ${m.message} was canceled${m.error ? ` (${m.error})` : ''}; nothing came back.`);
  else if (m.replyBytes === null) ctx.out(`No reply came back for ${m.message}.`);
  else ctx.out(replyGone(m));
  if (m.status === 'failed' && m.error) ctx.err(`termag: the run failed: ${m.error}`);
  // What became of its commits, beside the reply: a reply can claim a push that never happened.
  if (commitsState(m) !== '-') ctx.out(`commits: ${commitsState(m)}`);
  for (const p of prsOf(m)) ctx.out(`pr: ${p.url}${p.branch ? ` (${p.branch})` : ''}`);
  if (m.publish && m.publish.status !== 'published' && m.publish.status !== 'none' && m.publish.detail) {
    ctx.err(`termag: ${m.publish.status === 'partial' ? 'some branches not published' : 'commits not published'}: ${m.publish.detail}`);
  }
  ctx.out(`thread: ${m.thread}`);
}

const exitFor = (m: AskMessage): ExitCode => (m.status === 'failed' || m.status === 'canceled' || replyLost(m) ? EXIT.FAILED : EXIT.OK);

/**
 * The inbox's REPLY column: `NEW` for a stored reply nothing has read yet
 * (`--reply` prints it), `read` for a stored one that was, and for replies the
 * orchestrator did not store, `delivered` (a poll got it) or `dropped`.
 */
function replyState(m: AskMessage): string {
  if (m.status === 'superseded') return m.supersededBy ? `-> ${m.supersededBy}` : '-';
  if (!finished(m) || m.status === 'canceled') return '-';
  if (m.replyBytes === null) return 'none';
  if (m.replyStored) return m.replyDelivered ? 'read' : 'NEW';
  return m.replyDelivered ? 'delivered' : 'dropped';
}

/**
 * What became of a finished turn's commits: `pushed`, `none` (it answered and
 * committed nothing), `unpushed` (it committed and pushed nothing), `partial`,
 * `refused` or `failed`. The PR column is the thread's PR,
 * so without this a follow-up that pushed nothing looks the same as one that did.
 */
function commitsState(m: AskMessage): string {
  if (!finished(m) || m.status === 'canceled' || m.status === 'superseded' || !m.publish) return '-';
  return m.publish.status === 'published' ? 'pushed' : m.publish.status;
}

function prColumn(m: AskMessage): string {
  const prs = prsOf(m);
  if (!prs.length) return '-';
  return prs.length > 1 ? `${prs[0].url} (+${prs.length - 1})` : prs[0].url;
}

async function cmdInbox(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const api = await authedApi(ctx, session(ctx, args));
  const { messages } = await api.request<{ messages: AskMessage[] }>('GET', '/ask/inbox');
  if (args.json) { ctx.out(json({ tasks: messages.map(a2aTask) })); return EXIT.OK; }
  if (messages.length === 0) { ctx.out('Nothing submitted, working or finished in the last day.'); return EXIT.OK; }
  ctx.out(table(
    ['MESSAGE', 'THREAD', 'TARGET', 'STATUS', 'REPLY', 'COMMITS', 'PR', 'NOTICE', 'MODEL', 'TITLE'],
    messages.map(m => [m.message, m.thread, m.target, m.status, replyState(m), commitsState(m), prColumn(m), m.notice ?? '-', m.model ?? '-', m.title ?? '']),
  ));
  return EXIT.OK;
}

export interface TargetCard {
  name: string;
  description: string;
  provider: { organization: string };
  capabilities: {
    extensions: Array<{
      uri: string;
      /** sessionTitle: Claude's title for the session; orchestrators from before it leave it out. */
      params: { askable: boolean; reason: string | null; shared: boolean; sessionTitle?: string | null };
    }>;
  };
}

/** One of your ask threads that has a chat (GET /ask/targets `threads`; orchestrators from before it list none). */
export interface ThreadTarget {
  thread: string;
  /** Its --title; null when it has none. */
  title: string | null;
  /** Claude's title for the thread's chat. */
  sessionTitle: string | null;
  /** What a follow-up names, with --thread. */
  target: string;
  updatedAt: string;
}

const ASK_EXTENSION_URI = 'urn:termag:ask:v1';

const askParams = (a: TargetCard) => a.capabilities.extensions.find(e => e.uri === ASK_EXTENSION_URI)?.params;

const askableText = (a: TargetCard | undefined) => {
  const p = a && askParams(a);
  return !p ? '?' : p.askable ? 'yes' : `no: ${p.reason ?? 'unknown'}`;
};

async function cmdTargets(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const api = await authedApi(ctx, session(ctx, args));
  const { agents } = await api.request<{ agents: TargetCard[] }>('GET', '/ask/targets');
  if (args.json) { ctx.out(json({ agents })); return EXIT.OK; }
  if (agents.length === 0) { ctx.out('No projects of yours on a box of yours to ask: create one.'); return EXIT.OK; }
  ctx.out(table(
    ['TARGET', 'OWNER', 'ASKABLE', 'TITLE', 'DESCRIPTION'],
    agents.map(a => {
      const p = askParams(a);
      const owner = `${a.provider.organization}${p?.shared ? ' (shared)' : ''}`;
      return [a.name, owner, askableText(a), p?.sessionTitle || '-', a.description || '-'];
    }),
  ));
  return EXIT.OK;
}

/** A session `--find` matched: a workstream's (card) or an ask thread's (thread). */
export type FoundSession = { title: string; exact: boolean } & ({ card: TargetCard; thread?: undefined } | { thread: ThreadTarget; card?: undefined });

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The sessions called like `query`: every word of it in the session's title or
 * its address (an ask thread's title, Claude's title for its chat, or its id),
 * ignoring case. Those whose title is exactly the query come first, the rest
 * in the orchestrator's order.
 */
export function findSessions(query: string, agents: readonly TargetCard[], threads: readonly ThreadTarget[]): FoundSession[] {
  const q = norm(query);
  const words = q.split(' ').filter(Boolean);
  const matches = (texts: ReadonlyArray<string | null | undefined>) => {
    const hay = norm(texts.filter(Boolean).join(' '));
    return words.length > 0 && words.every(w => hay.includes(w));
  };
  const exact = (texts: ReadonlyArray<string | null | undefined>) => texts.some(t => t != null && norm(t) === q);
  const found: FoundSession[] = [
    ...agents.flatMap(card => {
      const title = askParams(card)?.sessionTitle ?? null;
      return matches([title, card.name]) ? [{ card, title: title || '-', exact: exact([title]) }] : [];
    }),
    ...threads.flatMap(thread => (matches([thread.title, thread.sessionTitle, thread.thread, `ask-${thread.thread}`])
      ? [{ thread, title: thread.title || thread.sessionTitle || `ask-${thread.thread}`, exact: exact([thread.title, thread.sessionTitle]) }]
      : [])),
  ];
  return [...found.filter(f => f.exact), ...found.filter(f => !f.exact)];
}

async function cmdFind(ctx: Ctx, args: ParsedArgs, query: string): Promise<ExitCode> {
  const api = await authedApi(ctx, session(ctx, args));
  const { agents, threads = [] } = await api.request<{ agents: TargetCard[]; threads?: ThreadTarget[] }>('GET', '/ask/targets');
  const found = findSessions(query, agents, threads);
  if (args.json) {
    ctx.out(json({ agents: found.flatMap(f => (f.card ? [f.card] : [])), threads: found.flatMap(f => (f.thread ? [f.thread] : [])) }));
    return found.length ? EXIT.OK : EXIT.NOT_FOUND;
  }
  if (!found.length) {
    ctx.out(`No session or ask thread of yours is titled like "${query}". \`termag ask --targets\` lists every target with its title.`);
    return EXIT.NOT_FOUND;
  }
  const byName = new Map(agents.map(a => [a.name, a]));
  ctx.out(table(
    ['TARGET', 'THREAD', 'ASKABLE', 'TITLE'],
    found.map(f => (f.card
      ? [f.card.name, '-', askableText(f.card), f.title]
      : [f.thread.target, f.thread.thread, askableText(byName.get(f.thread.target)), f.title])),
  ));
  ctx.out('');
  ctx.out(found.some(f => f.thread)
    ? 'Ask one: termag ask <TARGET> - < <prompt file>; for a THREAD, add --thread <THREAD> to talk to that same session.'
    : 'Ask one: termag ask <TARGET> - < <prompt file>');
  return EXIT.OK;
}

async function cmdCancel(ctx: Ctx, args: ParsedArgs, id: string): Promise<ExitCode> {
  const api = await authedApi(ctx, session(ctx, args));
  const m = await api.request<AskMessage & { stop: { stopped: boolean; detail: string } | null }>('POST', `/ask/messages/${id}/cancel`);
  if (args.json) { ctx.out(json(a2aTask(m))); return EXIT.OK; }
  ctx.out(m.stop ? `Canceled ${m.message} on ${m.target}: ${m.stop.detail}.` : `${m.message} on ${m.target} was already canceled.`);
  ctx.out(`thread: ${m.thread}`);
  return EXIT.OK;
}

const SIZES = ['small', 'medium', 'large'];
const NAME_RE = /^[A-Za-z0-9_-]+$/;

interface NewBoxLaunch {
  box: string; project: string;
  /** `:<repo>` on the target: which repository of a multi-repo project the ask runs in. */
  repo?: string;
  size?: string;
  diskGiB?: number;
  /** Each --from in order: none is an empty project, two or more a multi-repo project of exactly those. */
  froms: string[];
  /** --environment: the project holds that environment's repositories instead. */
  environment?: string;
}

/** --new-box and what goes with it, checked before anything is asked of the orchestrator; null without --new-box. */
function newBoxOptions(args: ParsedArgs, target: string): NewBoxLaunch | null {
  const rawSize = args.options.size;
  const rawFroms = args.lists.from ?? (args.options.from !== undefined ? [args.options.from] : []);
  if (args.options['new-box'] !== true) {
    if (rawSize !== undefined || args.options.disk !== undefined || rawFroms.length || args.options.environment !== undefined) {
      throw usage('--size, --disk, --from and --environment go with --new-box, which makes the box and the project');
    }
    return null;
  }
  if (args.options.thread !== undefined) throw usage('--new-box starts a thread; a --thread follow-up goes to the box its thread is on');
  if (target.includes('@')) throw usage('--new-box makes a project, <box>/<project>[:<repo>], and asks its main; leave out @<workstream>');
  const [ref, repo] = target.split(':');
  const [box, project] = ref.split('/');
  for (const [name, kind] of [[box, 'box'], [project, 'project']] as const) {
    if (!NAME_RE.test(name)) throw usage(`"${name}" is not a valid ${kind} name (letters, digits, - and _ only)`);
  }
  let size: string | undefined;
  if (rawSize !== undefined) {
    size = typeof rawSize === 'string' ? rawSize.trim().toLowerCase() : '';
    if (!SIZES.includes(size)) throw usage(`--size takes ${SIZES.join(', ')}`);
  }
  const diskGiB = diskOption(args);
  const froms = rawFroms.map(f => (typeof f === 'string' ? f.trim() : ''));
  if (froms.some(f => !f)) throw usage('--from takes another project (<box>/<project>), a template name or a GitHub repository URL');
  const environment = environmentOption(args);
  if (environment && froms.length) throw usage('--environment names the repositories itself; leave out --from');
  return { box, project, ...(repo ? { repo } : {}), size, diskGiB, froms, ...(environment ? { environment } : {}) };
}

/**
 * `--new-box`: the box and the project made for this ask, with if-not-exists
 * semantics, before the ask is sent: a project of the one --from, a
 * multi-repo project of every --from, or an
 * empty one with none. The orchestrator gives a box made with `createdFor:
 * 'ask'` the ask-box policy (its lifecycle, services/boxLifecycle.applyAskBoxPolicy).
 * `madeBox` is true when this call made the box, so the thread records it as
 * its own; `repos` a new multi-repo project's checkouts, in --from order.
 */
async function makeAskBox(ctx: Ctx, api: Api, target: string, launch: NewBoxLaunch, args: ParsedArgs, model: string | null): Promise<{ madeBox: boolean; repos: string[] }> {
  const from = launch.froms.length > 1 ? launch.froms : launch.froms[0];
  // An ask runs its checkouts without asking: a new project from an environment is pinned to them (ensureProject).
  // Always with termag setup on: a box with it off answers an ask 409 setup_disabled,
  // since the run needs the Claude credentials setup delivers, so a repository's "setupEnabled": false
  // is overridden here, and said so.
  const made = await projectOnNewBox(ctx, api, launch, { name: launch.project, agent: 'claude', from, environment: launch.environment, forAsk: true, ...(model ? { model } : {}) }, {
    size: launch.size, diskGiB: launch.diskGiB, setupEnabled: true, setupOverride: `an ask needs termag setup, so ${launch.box} has it on`, ifNotExists: true, timeoutS: timeoutSeconds(args) ?? CREATE_WAIT_S, quiet: args.json, startParked: true,
    retry: `termag ask --new-box${launch.froms.map(f => ` --from ${f}`).join('')}${launch.environment ? ` --environment ${launch.environment}` : ''} ${target} -`,
  });
  return { madeBox: made.boxCreated, repos: (made.result.repos ?? []).map(r => r.name) };
}

/**
 * A multi-repo project's ask names one repository (`:<repo>`; publish takes
 * one repository a run). Without one, --new-box asks the first --from's: the
 * new project's first checkout, else (a project that was already there,
 * with or without --from) the first the orchestrator lists when it refuses a
 * bare ask. `:<repo>` is taken with any --from count: on an existing
 * multi-repo project it needs none, and on one that isn't the orchestrator
 * says so.
 */
function withRepo(target: string, repo: string): string {
  return `${target.split(':')[0]}:${repo}`;
}

export async function cmdAsk(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const reply = args.options.reply;
  const cancel = args.options.cancel;
  const find = args.options.find;
  if (args.options.model !== undefined && (args.options.inbox === true || args.options.targets === true || find !== undefined || cancel !== undefined || reply !== undefined)) {
    throw usage('--model goes with an ask: termag ask <box>/<project> <prompt|-> --model opus|sonnet|haiku');
  }
  if (args.options.inbox === true) {
    if (args.args.length || reply !== undefined || cancel !== undefined || args.options.targets === true || find !== undefined) throw usage('--inbox takes no other arguments');
    return cmdInbox(ctx, args);
  }
  if (args.options.targets === true) {
    if (args.args.length || reply !== undefined || cancel !== undefined || find !== undefined) throw usage('--targets takes no other arguments');
    return cmdTargets(ctx, args);
  }
  if (find !== undefined) {
    if (args.args.length || reply !== undefined || cancel !== undefined) throw usage('--find takes no other arguments');
    if (typeof find !== 'string' || !find.trim()) throw usage('Usage: termag ask --find <title>');
    return cmdFind(ctx, args, find);
  }
  if (cancel !== undefined) {
    if (args.args.length || reply !== undefined || typeof cancel !== 'string' || !ID_RE.test(cancel)) throw usage('Usage: termag ask --cancel <message>');
    return cmdCancel(ctx, args, cancel);
  }
  const s = session(ctx, args);
  if (reply !== undefined) {
    if (args.args.length || typeof reply !== 'string' || !ID_RE.test(reply)) throw usage('Usage: termag ask --reply <message>');
    const api = await authedApi(ctx, s, { timeoutMs: REQUEST_TIMEOUT_MS });
    const m = await waitForMessage(ctx, api, reply, args);
    // The message's own --model, answered together or not (the orchestrator's answeredTogether keeps it).
    if (m.modelIgnored) ctx.err(`termag: warning: its --model was ignored: ${m.modelIgnored}`);
    if (args.json) ctx.out(json(a2aTask(m)));
    else printMessage(ctx, m);
    return exitFor(m);
  }

  const [target, rawPrompt] = args.args;
  const newBox = args.options['new-box'] === true;
  if (!target || rawPrompt === undefined) throw usage(`Usage: ${ASK_COMMANDS.ask.usage.split('\n')[newBox ? 1 : 0].trim()}`);
  if (!REF_RE.test(target)) throw usage(`"${target}" is not <box>/<project>[@<workstream>][:<repo>]`);
  const thread = args.options.thread;
  if (thread !== undefined && (typeof thread !== 'string' || !ID_RE.test(thread))) throw usage('--thread takes a thread id');
  const launch = newBoxOptions(args, target);
  // What the thread is called in the simple UI. Callers name their threads: an untitled one shows its id.
  const rawTitle = args.options.title;
  const title = typeof rawTitle === 'string' ? rawTitle.replace(/\s+/g, ' ').trim() : undefined;
  if (rawTitle !== undefined && !title) throw usage(`--title is empty; give the thread a short, specific name, e.g. ${TITLE_EXAMPLE}`);
  if (title && [...title].length > MAX_TITLE_CHARS) throw usage(`--title is ${[...title].length} characters; use at most ${MAX_TITLE_CHARS} characters`);
  // The orchestrator checks the PR itself; this only catches a typo early.
  const rawPr = args.options['update-pr'];
  const pr = typeof rawPr === 'string' ? rawPr.trim() : undefined;
  if (rawPr !== undefined && !(pr && PR_RE.test(pr))) throw usage('--update-pr takes a pull request: <n>, <owner>/<name>#<n> or its github.com URL');
  const model = claudeModelOption(args);
  const prompt = await readPrompt(ctx, rawPrompt);
  if (!prompt.trim()) throw usage('The prompt is empty');

  const api = await authedApi(ctx, s, { timeoutMs: REQUEST_TIMEOUT_MS });
  const made = launch ? await makeAskBox(ctx, api, target, launch, args, model) : { madeBox: false, repos: [] };
  const madeBox = made.madeBox;
  let askAt = target;
  const pickRepo = !!launch && !launch.repo;
  const firstRepo = (repo: string) => {
    askAt = withRepo(target, repo);
    const which = launch?.environment ? "the environment's first repository"
      : launch && launch.froms.length > 1 ? "the first --from's checkout" : "the project's first repository";
    if (!args.json) ctx.err(`termag: asking ${askAt}, ${which}; name another as ${target.split(':')[0]}:<repo>`);
  };
  if (pickRepo && made.repos[0]) firstRepo(made.repos[0]);
  const id = (ctx.newMessageId ?? newMessageId)();
  const sender = await askSender(ctx);
  const body = {
    target: askAt, prompt, messageId: id, ...(thread ? { threadId: thread } : {}), ...(title ? { title } : {}), ...(sender ? { sender } : {}),
    ...(pr ? { pr } : {}), ...(madeBox ? { newBox: true } : {}), ...(model ? { model } : {}),
    ...(args.options['no-notify'] === true ? { notify: false } : {}),
  };

  let started: AskStarted;
  try {
    try {
      try {
        started = await postAsk(ctx, api, body, args);
      } catch (err) {
        const repos = isRejection(err) && err.body?.code === 'repo_required' && Array.isArray(err.body.repos) ? err.body.repos as unknown[] : [];
        if (!pickRepo || askAt !== target || typeof repos[0] !== 'string') throw err;
        firstRepo(repos[0]);
        body.target = askAt;
        started = await postAsk(ctx, api, body, args);
      }
    } catch (err) {
      const offline = isRejection(err) && err.body?.code === 'box_offline';
      if (!offline || args.options['no-wait'] === true || !(await wakeBox(ctx, api, askAt, args))) throw err;
      started = await postAsk(ctx, api, body, args);
    }
  } catch (err) {
    if (!isRejection(err)) throw err;
    if (args.json) ctx.out(json(rejectedTask(id, thread ?? null, err.message)));
    else ctx.err(`termag: rejected: ${err.message}`);
    return EXIT.FAILED;
  }
  if (!args.json && started.steered) {
    ctx.err(`termag: ${started.supersedes} was still working; this follow-up went into its turn, so that message is superseded and the reply to both comes here`);
  } else if (!args.json && started.queuedBehind) {
    ctx.err(`termag: ${started.queuedBehind} is still working and its turn can't take this follow-up${started.steerRefused ? ` (${started.steerRefused})` : ''}; it is queued as the next turn on the thread, with a reply of its own`);
  }
  // An older orchestrator drops --model, and an older box agent can't take it: the ask still runs, on the default.
  if (model && started.model === undefined) ctx.err(`termag: warning: --model ${model} was ignored: the orchestrator predates it; the ask runs on the thread's model, else the box's default`);
  else if (model && started.modelIgnored) ctx.err(`termag: warning: --model ${model} was ignored: ${started.modelIgnored}`);
  if (!args.json && started.targetPr) ctx.err(`termag: the thread publishes to PR #${started.targetPr} (${started.branch})${pr ? '' : ', as it remembers'}`);
  // A new thread with no name shows as its id: say once how to name it. Only a tip, never an error.
  if (!thread && !title && !args.json) ctx.err(`termag: tip: name this thread with --title "<short, specific name>", e.g. ${TITLE_EXAMPLE}; untitled, it shows as ask-<thread id>`);
  if (started.queued && started.queuedFor !== 'turn' && !args.json) {
    const waitFor = started.queuedFor === 'setup'
      ? `${started.target} is still being set up; the ask runs once its clone is done`
      : `${target.split('/')[0]} is starting; the ask runs once it is up`;
    ctx.err(`termag: ${waitFor} (the orchestrator holds it, so it runs even if this command stops)`);
  }
  if (args.options['no-wait'] === true) {
    if (args.json) ctx.out(json(startedTask(started)));
    else {
      // The orchestrator will tell this session.
      const told = started.notify ? ` termag tells this ${started.notify === 'chat' ? 'chat' : 'pane'} when it finishes, with a [termag] notice: no need to poll.` : '';
      ctx.out(started.replyKept
        ? `Asked ${started.target} (hop ${started.hop}).${told} The reply is kept for 14 days: \`termag ask --reply ${started.message}\` prints it once the run finishes, and waits while it runs.`
        : started.notify
        ? `Asked ${started.target} (hop ${started.hop}).${told} The notice has no reply, and nothing keeps it: only a \`termag ask --reply ${started.message}\` waiting when it finishes gets it.`
        : `Asked ${started.target} (hop ${started.hop}). Nothing keeps the reply: only a \`termag ask --reply ${started.message}\` waiting when it finishes gets it.`);
      ctx.out(`thread: ${started.thread}`);
    }
    return EXIT.OK;
  }
  // Said before the first poll, so whoever reads stderr has the ids even if this process dies.
  if (!args.json) ctx.err(`termag: waiting for ${started.target} (message ${started.message}, thread ${started.thread})…`);
  const m = await waitForMessage(ctx, api, started.message, args, !args.json);
  // A queued ask (a parked box, a clone, a turn before it) learns only when it starts that its --model was ignored.
  if (model && !started.modelIgnored && m.modelIgnored) ctx.err(`termag: warning: --model ${model} was ignored: ${m.modelIgnored}`);
  if (args.json) ctx.out(json(a2aTask(m)));
  else printMessage(ctx, m);
  return exitFor(m);
}

export const ASK_HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  ask: cmdAsk,
};
