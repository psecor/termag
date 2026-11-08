import type { ServerResponse } from 'node:http';

/** The orchestrator's /ask routes (backend routes/cliAsk.ts), with a run that finishes after `pollsUntilDone` reads. */
export interface FakeAskState {
  pollsUntilDone: number;
  outcome: 'completed' | 'failed';
  reply: string;
  pr: { url: string; number: number; branch: string | null } | null;
  /** The thread's PRs as an orchestrator with several per thread lists them; unset, the view has no `prs`. */
  prs?: Array<{ key: string; url: string; number: number; branch: string | null }>;
  /** What the finished message says about publishing, when not the plain published/none. */
  publish?: { status: string; detail: string | null };
  messages: Map<string, FakeAskMessage>;
  asks: Array<Record<string, unknown>>;
  waits: number[];
  /** Answer the next reads of a message as a deploy's overlap would: the ALB's HTML 502, or a draining 503. */
  failPolls: Array<502 | 503>;
  /**
   * Answer this many POSTs /ask with the ALB's HTML 502, as an edge in the
   * middle of a deploy would. `acceptThenFail` takes the ask first (the
   * response was lost on the way back).
   */
  failAsk: number;
  acceptThenFail: boolean;
  /** Refuse asks as an orchestrator does when the target can't take a run; a function decides per ask. */
  reject: string | null | (() => string | null);
  /** Take asks as an orchestrator does for a parked box it is starting (true, as older ones say it), or for a clone. */
  queued: boolean | 'box' | 'setup';
  targets: unknown[];
  /** The caller's ask threads with a chat, as GET /ask/targets lists them; unset, an older orchestrator that lists none. */
  threads?: unknown[];
  /** Reads of a finished message that still get the reply (the hand-off window); later ones get none. */
  handoffReads: number;
  /**
   * An orchestrator that stores replies (askReplyStore.ts): every read of a
   * finished message gets the reply, views say `replyStored`, and POST says
   * `replyKept`. `expired` is one whose stored reply the 14-day sweep deleted.
   * `no-key` is a current orchestrator with no key to store with: it sends
   * `replyStored: false` and `replyKept: false`.
   */
  stored?: boolean | 'expired' | 'no-key';
  /** When finished messages finished; a fixed day in October 2026 by default. */
  completedAt?: string;
  /**
   * A follow-up on a thread whose message still works: `true` goes into its
   * turn and supersedes it, `'behind'` runs after it (the box's turn could
   * not take it, with this reason). Unset, it is a turn of its own.
   */
  steer?: true | { behind: string };
  /** What a wait on a superseded message gets (the orchestrator's ASK_SUPERSEDED_REPLY): `together` by default. */
  superseded?: 'together' | 'follow';
  /** A target that is a multi-repo project: a bare ask to it is refused repo_required, listing these. */
  multiRepo?: Record<string, string[]>;
  /** The orchestrator will tell the sending session when the ask finishes (unless the ask says notify: false). */
  notify?: 'chat' | 'pane';
  /**
   * `--model` (backend askService.ts): unset, a current orchestrator that takes
   * it, echoes it and keeps it on the thread; `'unknown'`, one from before it,
   * which drops it; `{ ignored }`, one whose box can't honour it, saying why.
   */
  model?: 'unknown' | { ignored: string; later?: true };
}

interface FakeAskMessage {
  message: string;
  thread: string;
  target: string;
  status: string;
  hop: number;
  hops: number;
  polls: number;
  handedOut: number;
  delivered: boolean;
  supersededBy?: string;
  /** The tier its turn runs on: its --model, else its thread's (a follow-up keeps it); absent for the box's default. */
  model?: string;
}

export function newAskState(): FakeAskState {
  return { pollsUntilDone: 1, outcome: 'completed', reply: 'The flag is read in server/flags.go.', pr: null, messages: new Map(), asks: [], waits: [], failPolls: [], failAsk: 0, acceptThenFail: false, reject: null, queued: false, targets: [], handoffReads: 1 };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function view(s: FakeAskState, m: FakeAskMessage, consume: boolean) {
  const done = m.status === 'completed' || m.status === 'failed' || m.status === 'canceled';
  const kept = s.stored === true && done && m.status !== 'canceled';
  const reply = done && m.status !== 'canceled' && (kept || m.handedOut < s.handoffReads) ? s.reply : null;
  if (reply !== null && consume) { m.handedOut += 1; m.delivered = true; }
  return {
    message: m.message, thread: m.thread, target: m.target, status: m.status, hop: m.hop, hops: m.hops,
    createdAt: '2026-10-09T00:00:00.000Z', completedAt: done ? s.completedAt ?? '2026-10-09T00:01:00.000Z' : null,
    error: m.status === 'failed' ? 'claude exited 1' : m.status === 'canceled' ? 'canceled by alice' : null,
    reply, replyBytes: done && m.status !== 'canceled' ? Buffer.byteLength(s.reply) : null, replyDelivered: m.delivered,
    ...(s.stored !== undefined ? { replyStored: kept, replyKept: s.stored !== 'no-key' } : {}),
    ...(m.status === 'superseded' ? { supersededBy: m.supersededBy ?? null } : {}),
    ...(s.model !== 'unknown' ? { model: s.model?.ignored ? null : m.model ?? null } : {}),
    ...(typeof s.model === 'object' && m.model ? { modelIgnored: s.model.ignored } : {}),
    publish: done ? s.publish ?? { status: s.pr ? 'published' : 'none', detail: null } : null,
    pr: done ? s.pr : null,
    ...(s.prs ? { prs: done ? s.prs : [] } : {}),
  };
}

export function handleAsk(s: FakeAskState, route: string, query: URLSearchParams, body: Record<string, unknown>, res: ServerResponse): boolean {
  if (route === 'POST /ask') {
    s.asks.push(body);
    const gateway502 = () => res.writeHead(502, { 'Content-Type': 'text/html' }).end('<html>502 Bad Gateway</html>');
    if (s.failAsk > 0 && !s.acceptThenFail) { s.failAsk -= 1; gateway502(); return true; }
    if (body.target === 'devbox/missing') { send(res, 404, { error: 'No project devbox/missing', code: 'not_found' }); return true; }
    const repos = s.multiRepo?.[String(body.target)];
    if (repos) {
      send(res, 409, { error: `${body.target} holds several repositories; name one: ${repos.join(', ')}`, code: 'repo_required', status: 'rejected', repos, message: body.messageId ?? null });
      return true;
    }
    const reject = typeof s.reject === 'function' ? s.reject() : s.reject;
    if (reject) {
      send(res, 409, { error: reject, code: 'box_offline', status: 'rejected', message: body.messageId ?? null, thread: body.threadId ?? null });
      return true;
    }
    const id = typeof body.messageId === 'string' ? body.messageId : `message000${s.messages.size + 1}`;
    let m = s.messages.get(id);
    const replayed = !!m;
    const busy = !m && typeof body.threadId === 'string' ? [...s.messages.values()].find(x => x.thread === body.threadId && x.status === 'working') : undefined;
    let steer: Record<string, unknown> = {};
    if (busy && s.steer === true) {
      busy.status = 'superseded';
      busy.supersededBy = id;
      steer = { steered: true, supersedes: busy.message };
    } else if (busy && s.steer && s.steer !== true) {
      steer = { steered: false, queuedBehind: busy.message, steerRefused: s.steer.behind };
    }
    if (!m) {
      const n = s.messages.size + 1;
      const thread = typeof body.threadId === 'string' ? body.threadId : `thread0000${n}`;
      const hops = [...s.messages.values()].filter(x => x.thread === thread).length + 1;
      m = { message: id, thread, target: String(body.target), status: 'working', hop: 0, hops, polls: 0, handedOut: 0, delivered: false };
      // The thread's stored choice: this --model, else the one its last message ran on.
      const kept = [...s.messages.values()].filter(x => x.thread === thread).at(-1)?.model;
      const model = s.model === 'unknown' ? undefined : typeof body.model === 'string' ? body.model : kept;
      if (model) m.model = model;
      s.messages.set(id, m);
    }
    if (s.failAsk > 0) { s.failAsk -= 1; gateway502(); return true; }
    // --pr: the orchestrator answers with the PR it checked and its head branch.
    const target = typeof body.pr === 'string' ? { targetPr: Number(/(\d+)\/?$/.exec(body.pr)?.[1]), branch: 'termag-alice/oldthread' } : {};
    send(res, 202, { thread: m.thread, message: m.message, status: m.status, hop: 0, hops: m.hops, target: m.target, branch: `termag-alice/${m.thread}`, ...target, ...(s.notify && body.notify !== false ? { notify: s.notify } : {}), ...(replayed ? { replayed } : {}), ...(typeof body.model === 'string' && s.model !== 'unknown' ? { model: body.model, ...(s.model?.ignored && !s.model.later ? { modelIgnored: s.model.ignored } : {}) } : {}), ...(s.stored !== undefined ? { replyKept: s.stored !== 'no-key' } : {}), ...steer, ...(s.queued ? { queued: true, status: 'submitted', ...(typeof s.queued === 'string' ? { queuedFor: s.queued } : {}) } : {}) });
    return true;
  }
  if (route === 'GET /ask/targets') {
    send(res, 200, { agents: s.targets, ...(s.threads ? { threads: s.threads } : {}) });
    return true;
  }
  if (route === 'GET /ask/inbox') {
    send(res, 200, { messages: [...s.messages.values()].map(m => view(s, m, false)) });
    return true;
  }
  const cancel = /^POST \/ask\/messages\/([^/]+)\/cancel$/.exec(route);
  if (cancel) {
    const m = s.messages.get(cancel[1]);
    if (!m) { send(res, 404, { error: 'Message not found', code: 'not_found' }); return true; }
    if (m.status === 'canceled') { send(res, 200, { ...view(s, m, false), stop: null }); return true; }
    if (m.status !== 'working') { send(res, 409, { error: `Can't cancel: the message is already ${m.status}`, code: 'finished' }); return true; }
    m.status = 'canceled';
    send(res, 200, { ...view(s, m, false), stop: { stopped: true, detail: 'the run was stopped' } });
    return true;
  }
  const match = /^GET \/ask\/messages\/([^/]+)$/.exec(route);
  if (match) {
    const asked = s.messages.get(match[1]);
    // Answered together: the wait goes on the chain's last message, under the asked id.
    let end = asked;
    while ((s.superseded ?? 'together') === 'together' && end?.status === 'superseded' && end.supersededBy) end = s.messages.get(end.supersededBy);
    const m = end;
    if (!m) { send(res, 404, { error: 'No such message', code: 'not_found' }); return true; }
    const fail = s.failPolls.shift();
    if (fail === 502) { res.writeHead(502, { 'Content-Type': 'text/html' }).end('<html>502 Bad Gateway</html>'); return true; }
    if (fail === 503) { send(res, 503, { error: 'This orchestrator is draining' }); return true; }
    s.waits.push(Number(query.get('wait')));
    m.polls += 1;
    if (m.polls >= s.pollsUntilDone && m.status === 'working') m.status = s.outcome;
    if (asked && m !== asked) {
      // The model is the asked message's own (backend agentMessages.ts answeredTogether).
      const own = view(s, asked, false);
      const { modelIgnored: _theirs, ...answer } = view(s, m, true) as Record<string, unknown>;
      send(res, 200, { ...answer, message: asked.message, supersededBy: asked.supersededBy, answeredWith: m.message, model: own.model, ...('modelIgnored' in own ? { modelIgnored: own.modelIgnored } : {}) });
      return true;
    }
    send(res, 200, view(s, m, true));
    return true;
  }
  return false;
}
