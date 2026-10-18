import { randomBytes } from 'node:crypto';
import type { Api } from './api.js';
import type { CommandSpec, ParsedArgs } from './args.js';
import { authedApi, session } from './commands.js';
import type { Ctx } from './context.js';
import { CliError, EXIT, usage, type ExitCode } from './errors.js';
import { json, table } from './output.js';
import { ownBox, startAndWait, START_WAIT_S } from './lifecycle.js';

/**
 * `termag ask`: agent-to-agent asks. The
 * orchestrator runs the prompt on the target project's box in a sandboxed
 * clone of its committed code and hands the reply to the poll waiting for it,
 * plus a draft PR for any commits. Nothing stores the reply: if no poll is
 * waiting when it arrives it is dropped, and the message only says it
 * finished. The thread id continues the conversation.
 */

/** One GET waits this long server-side (MAX_WAIT_SEC); the request timeout sits above it. */
const WAIT_S = 50;
const REQUEST_TIMEOUT_MS = 70_000;
const REF_RE = /^[A-Za-z0-9_-]+\/[^/@\s]+(@[^/@\s]+)?$/;
const ID_RE = /^[a-z0-9]{8,40}$/;

export const ASK_COMMANDS: Record<string, CommandSpec> = {
  ask: {
    summary: "Ask another project's agent; prints its answer and a draft PR for any commits",
    usage: 'termag ask <box>/<project>[@<workstream>] <prompt|-> [--thread <id>] [--no-wait] [--timeout <seconds>]\n'
      + '       termag ask --reply <message> [--no-wait] [--timeout <seconds>]\n'
      + '       termag ask --cancel <message>\n'
      + '       termag ask --inbox\n'
      + '       termag ask --targets',
    options: {
      thread: { type: 'string' },
      'no-wait': { type: 'boolean' },
      reply: { type: 'string' },
      cancel: { type: 'string' },
      inbox: { type: 'boolean' },
      targets: { type: 'boolean' },
      timeout: { type: 'string' },
    },
    maxArgs: 2,
  },
};

export interface AskMessage {
  message: string;
  thread: string;
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
  publish: { status: string; detail: string | null } | null;
  pr: { url: string; number: number; branch: string | null } | null;
}

interface AskStarted {
  thread: string;
  message: string;
  status: string;
  hop: number;
  hops: number;
  target: string;
  branch: string;
  /** Waiting on the orchestrator for its parked box to come up. */
  queued?: boolean;
}

/** The message states are A2A's TaskState names. */
const finished = (m: Pick<AskMessage, 'status'>) => m.status === 'completed' || m.status === 'failed' || m.status === 'canceled';

const A2A_STATE: Record<string, string> = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  canceled: 'TASK_STATE_CANCELED',
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
  if (m.pr) {
    artifacts.push({ artifactId: `${m.message}-pr`, name: 'pull-request', parts: [{ url: m.pr.url }], metadata: { number: m.pr.number, branch: m.pr.branch } });
  }
  const status: Record<string, unknown> = {
    state: A2A_STATE[m.status] ?? 'TASK_STATE_UNSPECIFIED',
    timestamp: m.completedAt ?? m.startedAt ?? m.createdAt,
  };
  if (m.error) {
    status.message = { messageId: `${m.message}-status`, contextId: m.thread, taskId: m.message, role: 'ROLE_AGENT', parts: [{ text: m.error }] };
  }
  return {
    id: m.message,
    contextId: m.thread,
    status,
    artifacts,
    metadata: {
      termag: {
        target: m.target, status: m.status, hop: m.hop, hops: m.hops, error: m.error,
        replyBytes: m.replyBytes, replyDelivered: m.replyDelivered, publish: m.publish, pr: m.pr,
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
    metadata: { termag: { target: s.target, status: s.status, hop: s.hop, hops: s.hops, branch: s.branch } },
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
async function waitForMessage(ctx: Ctx, api: Api, id: string, args: ParsedArgs, announced = false): Promise<AskMessage> {
  const noWait = args.options['no-wait'] === true;
  const limit = timeoutSeconds(args);
  const deadline = limit === null ? Infinity : Date.now() + limit * 1000;
  const retryFor = ctx.askRetryForMs ?? RETRY_FOR_MS;
  const baseDelay = ctx.pollIntervalMs ?? RETRY_DELAY_MS;
  const later = `\`termag ask --reply ${id}\` waits again while it runs (the reply goes only to a waiting poll)`;
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
      if (now - failingSince >= retryFor) throw new CliError(err.code, `${err.message}; gave up retrying, ${later}`, err.status);
      if (now >= deadline) throw new CliError('timeout', `Still running after ${limit}s; ${later}`);
      await sleep(Math.min(delay, deadline - now));
      delay = Math.min(delay * 2, RETRY_DELAY_MAX_MS);
      continue;
    }
    failingSince = null;
    delay = baseDelay;
    if (finished(m) || noWait) return m;
    if (Date.now() >= deadline) throw new CliError('timeout', `Still running after ${limit}s; ${later}`);
    if (!notified && !args.json) {
      ctx.err(`termag: waiting for ${m.target} (message ${id}, thread ${m.thread})…`);
      notified = true;
    }
  }
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

function printMessage(ctx: Ctx, m: AskMessage): void {
  if (m.reply !== null) ctx.out(replyEnvelope(m, m.reply));
  else if (!finished(m)) ctx.out(`Still running on ${m.target}; \`termag ask --reply ${m.message}\` waits for it (only a waiting poll gets the reply).`);
  else if (m.status === 'canceled') ctx.out(`The ask ${m.message} was canceled${m.error ? ` (${m.error})` : ''}; nothing came back.`);
  else if (m.replyBytes === null) ctx.out(`No reply came back for ${m.message}.`);
  else if (m.replyDelivered) ctx.out(`The reply to ${m.message} went to an earlier poll; replies are not kept.`);
  else ctx.out(`The reply to ${m.message} was not delivered: nothing was waiting when it arrived, and replies are not stored. Ask again (\`--thread ${m.thread}\` keeps the context).`);
  if (m.status === 'failed' && m.error) ctx.err(`termag: the run failed: ${m.error}`);
  if (m.pr) ctx.out(`pr: ${m.pr.url}${m.pr.branch ? ` (${m.pr.branch})` : ''}`);
  if (m.publish && m.publish.status !== 'published' && m.publish.status !== 'none' && m.publish.detail) {
    ctx.err(`termag: commits not published: ${m.publish.detail}`);
  }
  ctx.out(`thread: ${m.thread}`);
}

const exitFor = (m: AskMessage): ExitCode => (m.status === 'failed' || m.status === 'canceled' || replyLost(m) ? EXIT.FAILED : EXIT.OK);

function replyState(m: AskMessage): string {
  if (!finished(m) || m.status === 'canceled') return '-';
  if (m.replyBytes === null) return 'none';
  return m.replyDelivered ? 'delivered' : 'dropped';
}

async function cmdInbox(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const api = await authedApi(ctx, session(ctx, args));
  const { messages } = await api.request<{ messages: AskMessage[] }>('GET', '/ask/inbox');
  if (args.json) { ctx.out(json({ tasks: messages.map(a2aTask) })); return EXIT.OK; }
  if (messages.length === 0) { ctx.out('Nothing submitted, working or finished in the last day.'); return EXIT.OK; }
  ctx.out(table(
    ['MESSAGE', 'THREAD', 'TARGET', 'STATUS', 'REPLY', 'PR'],
    messages.map(m => [m.message, m.thread, m.target, m.status, replyState(m), m.pr?.url ?? '-']),
  ));
  return EXIT.OK;
}

interface TargetCard {
  name: string;
  description: string;
  provider: { organization: string };
  capabilities: { extensions: Array<{ uri: string; params: { askable: boolean; reason: string | null; shared: boolean } }> };
}

const ASK_EXTENSION_URI = 'urn:termag:ask:v1';

async function cmdTargets(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const api = await authedApi(ctx, session(ctx, args));
  const { agents } = await api.request<{ agents: TargetCard[] }>('GET', '/ask/targets');
  if (args.json) { ctx.out(json({ agents })); return EXIT.OK; }
  if (agents.length === 0) { ctx.out('No projects on a box to ask: create one, or have one shared with you.'); return EXIT.OK; }
  ctx.out(table(
    ['TARGET', 'OWNER', 'ASKABLE', 'DESCRIPTION'],
    agents.map(a => {
      const p = a.capabilities.extensions.find(e => e.uri === ASK_EXTENSION_URI)?.params;
      const owner = `${a.provider.organization}${p?.shared ? ' (shared)' : ''}`;
      return [a.name, owner, !p ? '?' : p.askable ? 'yes' : `no: ${p.reason ?? 'unknown'}`, a.description || '-'];
    }),
  ));
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

export async function cmdAsk(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const reply = args.options.reply;
  const cancel = args.options.cancel;
  if (args.options.inbox === true) {
    if (args.args.length || reply !== undefined || cancel !== undefined || args.options.targets === true) throw usage('--inbox takes no other arguments');
    return cmdInbox(ctx, args);
  }
  if (args.options.targets === true) {
    if (args.args.length || reply !== undefined || cancel !== undefined) throw usage('--targets takes no other arguments');
    return cmdTargets(ctx, args);
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
    if (args.json) ctx.out(json(a2aTask(m)));
    else printMessage(ctx, m);
    return exitFor(m);
  }

  const [target, rawPrompt] = args.args;
  if (!target || rawPrompt === undefined) throw usage(`Usage: ${ASK_COMMANDS.ask.usage.split('\n')[0]}`);
  if (!REF_RE.test(target)) throw usage(`"${target}" is not <box>/<project> or <box>/<project>@<workstream>`);
  const thread = args.options.thread;
  if (thread !== undefined && (typeof thread !== 'string' || !ID_RE.test(thread))) throw usage('--thread takes a thread id');
  const prompt = await readPrompt(ctx, rawPrompt);
  if (!prompt.trim()) throw usage('The prompt is empty');

  const api = await authedApi(ctx, s, { timeoutMs: REQUEST_TIMEOUT_MS });
  const id = (ctx.newMessageId ?? newMessageId)();
  const body = { target, prompt, messageId: id, ...(thread ? { threadId: thread } : {}) };
  let started: AskStarted;
  try {
    try {
      started = await postAsk(ctx, api, body, args);
    } catch (err) {
      const offline = isRejection(err) && err.body?.code === 'box_offline';
      if (!offline || args.options['no-wait'] === true || !(await wakeBox(ctx, api, target, args))) throw err;
      started = await postAsk(ctx, api, body, args);
    }
  } catch (err) {
    if (!isRejection(err)) throw err;
    if (args.json) ctx.out(json(rejectedTask(id, thread ?? null, err.message)));
    else ctx.err(`termag: rejected: ${err.message}`);
    return EXIT.FAILED;
  }
  if (started.queued && !args.json) {
    ctx.err(`termag: ${target.split('/')[0]} is starting; the ask runs once it is up (the orchestrator holds it, so it runs even if this command stops)`);
  }
  if (args.options['no-wait'] === true) {
    if (args.json) ctx.out(json(startedTask(started)));
    else {
      ctx.out(`Asked ${started.target} (hop ${started.hop}). Nothing keeps the reply: only a \`termag ask --reply ${started.message}\` waiting when it finishes gets it.`);
      ctx.out(`thread: ${started.thread}`);
    }
    return EXIT.OK;
  }
  // Said before the first poll, so whoever reads stderr has the ids even if this process dies.
  if (!args.json) ctx.err(`termag: waiting for ${started.target} (message ${started.message}, thread ${started.thread})…`);
  const m = await waitForMessage(ctx, api, started.message, args, !args.json);
  if (args.json) ctx.out(json(a2aTask(m)));
  else printMessage(ctx, m);
  return exitFor(m);
}

export const ASK_HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  ask: cmdAsk,
};
