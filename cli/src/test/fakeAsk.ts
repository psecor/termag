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
  /** Reads of a finished message that still get the reply (the hand-off window); later ones get none. */
  handoffReads: number;
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
}

export function newAskState(): FakeAskState {
  return { pollsUntilDone: 1, outcome: 'completed', reply: 'The flag is read in server/flags.go.', pr: null, messages: new Map(), asks: [], waits: [], failPolls: [], failAsk: 0, acceptThenFail: false, reject: null, queued: false, targets: [], handoffReads: 1 };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function view(s: FakeAskState, m: FakeAskMessage, consume: boolean) {
  const done = m.status === 'completed' || m.status === 'failed' || m.status === 'canceled';
  const reply = done && m.status !== 'canceled' && m.handedOut < s.handoffReads ? s.reply : null;
  if (reply !== null && consume) { m.handedOut += 1; m.delivered = true; }
  return {
    message: m.message, thread: m.thread, target: m.target, status: m.status, hop: m.hop, hops: m.hops,
    createdAt: '2026-10-09T00:00:00.000Z', completedAt: done ? '2026-10-09T00:01:00.000Z' : null,
    error: m.status === 'failed' ? 'claude exited 1' : m.status === 'canceled' ? 'canceled by alice' : null,
    reply, replyBytes: done && m.status !== 'canceled' ? Buffer.byteLength(s.reply) : null, replyDelivered: m.delivered,
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
    const reject = typeof s.reject === 'function' ? s.reject() : s.reject;
    if (reject) {
      send(res, 409, { error: reject, code: 'box_offline', status: 'rejected', message: body.messageId ?? null, thread: body.threadId ?? null });
      return true;
    }
    const id = typeof body.messageId === 'string' ? body.messageId : `message000${s.messages.size + 1}`;
    let m = s.messages.get(id);
    const replayed = !!m;
    if (!m) {
      const n = s.messages.size + 1;
      const thread = typeof body.threadId === 'string' ? body.threadId : `thread0000${n}`;
      const hops = [...s.messages.values()].filter(x => x.thread === thread).length + 1;
      m = { message: id, thread, target: String(body.target), status: 'working', hop: 0, hops, polls: 0, handedOut: 0, delivered: false };
      s.messages.set(id, m);
    }
    if (s.failAsk > 0) { s.failAsk -= 1; gateway502(); return true; }
    send(res, 202, { thread: m.thread, message: m.message, status: m.status, hop: 0, hops: m.hops, target: m.target, branch: `termag-alice/${m.thread}`, ...(replayed ? { replayed } : {}), ...(s.queued ? { queued: true, status: 'submitted', ...(typeof s.queued === 'string' ? { queuedFor: s.queued } : {}) } : {}) });
    return true;
  }
  if (route === 'GET /ask/targets') {
    send(res, 200, { agents: s.targets });
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
    const m = s.messages.get(match[1]);
    if (!m) { send(res, 404, { error: 'No such message', code: 'not_found' }); return true; }
    const fail = s.failPolls.shift();
    if (fail === 502) { res.writeHead(502, { 'Content-Type': 'text/html' }).end('<html>502 Bad Gateway</html>'); return true; }
    if (fail === 503) { send(res, 503, { error: 'This orchestrator is draining' }); return true; }
    s.waits.push(Number(query.get('wait')));
    m.polls += 1;
    if (m.polls >= s.pollsUntilDone && m.status === 'working') m.status = s.outcome;
    send(res, 200, view(s, m, true));
    return true;
  }
  return false;
}
