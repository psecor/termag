// Asks in an SDK chat: another agent,
// like a subagent, but Claude sends it from Bash with `termag ask`, so a call
// is a Bash tool item whose command runs it. What the call printed names the
// ask's thread and message; how the ask is doing comes from
// GET …/chat/asks (ChatAskThread). Pure, for the tests.
import type { ChatItem } from './sdkChat';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/** A message's reply, as the orchestrator says what became of it (backend services/chatAsks.ts). */
// `stored`: nobody has read it yet, and `termag ask --reply` can for 14 days.
export type ChatAskReply = 'pending' | 'delivered' | 'stored' | 'dropped' | 'none' | 'follow-up';

export interface ChatAskMessage {
  id: string;
  hop: number;
  status: string;
  queued: boolean;
  error: string | null;
  reply: ChatAskReply;
  supersededBy: string | null;
  publish: { status: string; detail: string | null } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ChatAskThread {
  id: string;
  title: string | null;
  target: string;
  chat: { projectId: string; workstream: string } | null;
  prs: Array<{ key: string; url: string; number: number; branch: string | null }>;
  createdAt: string;
  messages: ChatAskMessage[];
}

/** What a `termag ask` call does: send an ask (or a follow-up), wait again for one (`--reply`), or cancel one. */
export type AskCallKind = 'send' | 'reply' | 'cancel';

/** One ask the call's output names: its message and thread, as far as it printed them. */
export interface AskSend { message: string | null; thread: string }

export interface AskCall {
  kind: AskCallKind;
  /** `--no-wait`: the call returns at once and nothing in the session waits for the reply. */
  noWait: boolean;
  /** `--thread <id>`: a follow-up on that thread. */
  followUp: string | null;
  /** `--title`, when the command spells it out. */
  title: string | null;
  /** The address asked (`box/project[@workstream][:repo]`), when the command spells it out. */
  target: string | null;
  /** `--reply` / `--cancel`: the message it names. */
  names: string | null;
  /** The asks the output names, in order: a loop can send several. */
  sends: AskSend[];
  /** The orchestrator refused it (`termag: rejected: <reason>`): nothing was stored. */
  rejected: string | null;
}

const ID = '[a-z0-9]{8,40}';
// `termag ask` where a command starts: the line's start, after a separator, `$(`, a backtick, or `do` / `then` /
// `else`, with any `VAR=value` before it. Matched on the command with its quoted text blanked (sameLength), so
// `echo "termag ask later"` is no ask.
const TERMAG_ASK = /(?:^|[;&|(`\n]|\bdo\b|\bthen\b|\belse\b)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*termag\s+ask(?=\s|$)/;

/** The command with each quoted string's contents blanked, the same length, so indexes still match. */
function sameLength(command: string): string {
  return command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, q => q[0] + ' '.repeat(q.length - 2) + q[q.length - 1]);
}
// The forms that look things up rather than ask: they stay tool cards.
const LOOKUP = /\s--(?:targets|find|inbox)(?=[\s=]|$)/;
const TARGET = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?(?::[A-Za-z0-9._-]+)?$/;
const FLAGS_WITH_VALUES = new Set(['--title', '--thread', '--timeout', '--update-pr', '--reply', '--cancel', '--message-id']);

const inputOf = (t: ToolItem) => (t.input && typeof t.input === 'object' ? t.input : {}) as Record<string, unknown>;

/** The command from `termag ask` on, up to the first `;`, `&&`, `||` or `|` (the ask's own arguments). */
function askArgs(command: string): string {
  const bare = sameLength(command);
  const m = TERMAG_ASK.exec(bare);
  if (!m) return '';
  const from = m.index + m[0].length;
  const end = bare.slice(from).search(/;|&&|\|\||\||\n/);
  return end < 0 ? command.slice(from) : command.slice(from, from + end);
}

/** The words of a command line, unquoting '…' and "…"; a quoted word with `$` in it is not literal, so it reads as null. */
function words(line: string): Array<string | null> {
  const out: Array<string | null> = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m[1] !== undefined) out.push(m[1].includes('$') ? null : m[1].replace(/\\(.)/g, '$1'));
    else if (m[2] !== undefined) out.push(m[2]);
    else out.push(m[3].includes('$') ? null : m[3]);
  }
  return out;
}

function flagValue(ws: Array<string | null>, flag: string): string | null {
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (w === flag) return ws[i + 1] ?? null;
    if (w?.startsWith(`${flag}=`)) return w.slice(flag.length + 1) || null;
  }
  return null;
}

/** The first argument that isn't a flag (or a flag's value) and reads as an address. */
function targetOf(ws: Array<string | null>): string | null {
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (w === null) continue;
    if (FLAGS_WITH_VALUES.has(w)) { i++; continue; }
    if (w.startsWith('-')) continue;
    return TARGET.test(w) ? w : null;
  }
  return null;
}

/**
 * The asks a call's output names. A waiting ask says `message <m>, thread <t>`
 * on stderr before it polls, a `--no-wait` one says `termag ask --reply <m>`
 * and then `thread: <t>`, and every message view ends with `thread: <t>`.
 * `--json` prints A2A Tasks, `"id"` then `"contextId"`.
 */
export function sendsOf(output: string): AskSend[] {
  const out: AskSend[] = [];
  const add = (thread: string, message: string | null) => {
    const have = out.find(s => s.thread === thread && (s.message === message || s.message === null || message === null));
    if (have) { if (!have.message) have.message = message; return; }
    out.push({ thread, message });
  };
  for (const m of output.matchAll(new RegExp(`message (${ID}), thread (${ID})`, 'g'))) add(m[2], m[1]);
  // A --no-wait ask's two lines, in order: the reply hint names its message, then its thread.
  let pending: string | null = null;
  for (const m of output.matchAll(new RegExp(`termag ask --reply (${ID})|^thread: (${ID})\\s*$`, 'gm'))) {
    if (m[1]) pending = m[1];
    else { add(m[2], pending); pending = null; }
  }
  for (const m of output.matchAll(new RegExp(`"id"\\s*:\\s*"(${ID})"[^{}]*?"contextId"\\s*:\\s*"(${ID})"`, 'g'))) add(m[2], m[1]);
  return out;
}

/** A Bash call that runs `termag ask` to send, wait for or cancel an ask; null for anything else, the lookups included. */
export function askCallOf(item: ToolItem): AskCall | null {
  if (item.name !== 'Bash') return null;
  const command = inputOf(item).command;
  if (typeof command !== 'string' || !TERMAG_ASK.test(sameLength(command))) return null;
  const args = askArgs(command);
  if (LOOKUP.test(` ${args}`)) return null;
  const ws = words(args);
  const names = flagValue(ws, '--reply') ?? flagValue(ws, '--cancel');
  const kind: AskCallKind = flagValue(ws, '--cancel') ? 'cancel' : flagValue(ws, '--reply') ? 'reply' : 'send';
  const output = item.result ?? '';
  const rejected = /termag: rejected: (.+)/.exec(output)?.[1]?.trim() ?? null;
  const followUp = flagValue(ws, '--thread');
  return {
    kind,
    noWait: ws.includes('--no-wait'),
    followUp: followUp && new RegExp(`^${ID}$`).test(followUp) ? followUp : null,
    title: flagValue(ws, '--title'),
    target: kind === 'send' ? targetOf(ws) : null,
    names: names && new RegExp(`^${ID}$`).test(names) ? names : null,
    sends: sendsOf(output),
    rejected,
  };
}

/** Every ask call in the chat, by its tool call's id. */
export function askCallsOf(items: readonly ChatItem[]): Map<string, AskCall> {
  const out = new Map<string, AskCall>();
  for (const it of items) {
    if (it.kind !== 'tool') continue;
    const c = askCallOf(it);
    if (c) out.set(it.id, c);
  }
  return out;
}

/** The threads the calls name: what they sent, and what they followed up on. */
export function askThreadIds(calls: Iterable<AskCall>): string[] {
  const ids = new Set<string>();
  for (const c of calls) {
    for (const s of c.sends) ids.add(s.thread);
    if (c.followUp) ids.add(c.followUp);
  }
  return [...ids];
}

/** How far before a call its thread may say it was made: the box's clock and the orchestrator's differ a little. */
const CLOCK_SLACK_MS = 30_000;

/**
 * The thread(s) each call is about. What it printed says so, or its
 * `--thread`. A waiting ask run in the background (the agent-ask skill's way)
 * prints nothing the result keeps ("Command running in background"), so it
 * is matched to one of this chat's threads the orchestrator answered: the one
 * with its `--title`, else the first made since the call, that no other call
 * has. A `--reply` or `--cancel` names a message, and so its thread.
 */
export function callThreads(calls: ReadonlyMap<string, AskCall>, tools: ReadonlyMap<string, ToolItem>, threads: ReadonlyMap<string, ChatAskThread>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const claimed = new Set<string>();
  for (const c of calls.values()) for (const s of c.sends) claimed.add(s.thread);
  const byAge = [...threads.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const [id, c] of calls) {
    if (c.sends.length) { out.set(id, [...new Set(c.sends.map(s => s.thread))]); continue; }
    if (c.followUp) { out.set(id, [c.followUp]); continue; }
    if (c.names) {
      const t = byAge.find(x => x.messages.some(m => m.id === c.names));
      out.set(id, t ? [t.id] : []);
      continue;
    }
    if (c.kind !== 'send' || c.rejected) { out.set(id, []); continue; }
    const at = Date.parse(tools.get(id)?.startedAt ?? '');
    const free = byAge.filter(t => !claimed.has(t.id) && (!Number.isFinite(at) || Date.parse(t.createdAt) >= at - CLOCK_SLACK_MS));
    const t = (c.title ? free.find(x => x.title?.trim() === c.title) : undefined) ?? (c.title ? undefined : free[0]);
    if (t) claimed.add(t.id);
    out.set(id, t ? [t.id] : []);
  }
  return out;
}

/** Where an ask is: held at the orchestrator, sent but not started, running, or how it ended. */
export type AskState = 'queued' | 'starting' | 'working' | 'done' | 'failed' | 'canceled';

export const isAskActive = (s: AskState) => s === 'queued' || s === 'starting' || s === 'working';

/**
 * Who is waiting for an ask's reply. `claude`: a call in the session still
 * waits for it (a plain `termag ask`, in the foreground or the background, or a
 * `--reply`). `nobody`: it was sent with `--no-wait` and nothing waits again,
 * so its reply goes to nobody; the answer is in its own session.
 */
export type AskWaiting = 'claude' | 'nobody';

export interface AskView {
  thread: string;
  title: string;
  target: string | null;
  chat: { projectId: string; workstream: string } | null;
  state: AskState;
  /** Its turns so far: one per message, a follow-up that joined a running turn included. */
  turns: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  waiting: AskWaiting;
  /** Its newest turn was sent with `--no-wait`: nobody was ever going to get the reply. */
  noWait: boolean;
  /** What became of its newest turn's reply. */
  reply: ChatAskReply;
  prs: ChatAskThread['prs'];
  /** The orchestrator has answered for it: until then it is only what the call printed. */
  known: boolean;
}

/** The turn a thread's state is: its newest message that a follow-up didn't join. */
function newest(t: ChatAskThread): ChatAskMessage | null {
  const live = t.messages.filter(m => m.status !== 'superseded');
  return live[live.length - 1] ?? t.messages[t.messages.length - 1] ?? null;
}

function stateOf(m: ChatAskMessage): AskState {
  switch (m.status) {
    case 'submitted': return m.queued ? 'queued' : 'starting';
    case 'working': return 'working';
    case 'completed': return 'done';
    case 'canceled': return 'canceled';
    default: return 'failed';
  }
}

const running = (t: ToolItem) => !t.done || t.background === 'running';

/**
 * One view per thread the calls are about (callThreads), in the order the
 * chat first named them. `tools` are the chat's tool items by id, to tell a
 * call still waiting from one that has returned.
 */
export function askViews(calls: ReadonlyMap<string, AskCall>, byCall: ReadonlyMap<string, string[]>, tools: ReadonlyMap<string, ToolItem>, threads: ReadonlyMap<string, ChatAskThread>): Map<string, AskView> {
  const out = new Map<string, AskView>();
  const waits = new Set<string>(); // threads and messages a call still running waits for
  const noWaits = new Map<string, boolean>(); // by thread: whether its newest send was --no-wait
  const titles = new Map<string, string>();
  const targets = new Map<string, string>();
  for (const [id, c] of calls) {
    const item = tools.get(id);
    const live = item ? running(item) : false;
    const about = byCall.get(id) ?? [];
    const waitsHere = live && (c.kind === 'reply' || (c.kind === 'send' && !c.noWait));
    if (waitsHere) for (const th of about) waits.add(th);
    if (waitsHere && c.names) waits.add(c.names);
    for (const th of about) {
      if (c.kind === 'send') noWaits.set(th, c.noWait);
      if (c.title && !titles.has(th)) titles.set(th, c.title);
      if (c.target && !targets.has(th)) targets.set(th, c.target);
      if (out.has(th)) continue;
      out.set(th, {
        thread: th, title: '', target: null, chat: null, state: c.rejected ? 'failed' : 'starting', turns: 1, error: c.rejected,
        startedAt: null, completedAt: null, waiting: 'nobody', noWait: false, reply: 'pending', prs: [], known: false,
      });
    }
  }
  for (const [th, v] of out) {
    const t = threads.get(th);
    const m = t ? newest(t) : null;
    v.title = t?.title?.trim() || titles.get(th) || `ask-${th}`;
    v.target = t?.target ?? targets.get(th) ?? null;
    v.chat = t?.chat ?? null;
    v.prs = t?.prs ?? [];
    v.known = Boolean(t);
    if (t && m) {
      v.state = stateOf(m);
      v.turns = Math.max(1, t.messages.length);
      v.error = m.error;
      v.startedAt = m.startedAt ?? m.createdAt;
      v.completedAt = m.completedAt;
      v.reply = m.reply;
    }
    // A call still running waits for the reply, even once the ask has ended: until it returns, the reply
    // may only be on its way (the route says `dropped` until a poll reads it), so nothing says it went to nobody.
    v.waiting = waits.has(th) ? 'claude' : 'nobody';
    v.noWait = noWaits.get(th) ?? false;
  }
  return out;
}

/** "<1s", "12s", "3m 5s", "1h 2m". */
export function askDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** Where an ask is, in a few words: "queued", "starting", "working · 1m 4s", "finished in 2m 30s · 2 turns", "failed: …". */
export function askLine(v: Pick<AskView, 'state' | 'startedAt' | 'completedAt' | 'turns' | 'error'>, now: number): string {
  const start = v.startedAt ? Date.parse(v.startedAt) : NaN;
  const end = v.completedAt ? Date.parse(v.completedAt) : NaN;
  const took = Number.isFinite(start) && Number.isFinite(end) ? askDuration(Math.max(0, end - start)) : null;
  const turns = v.turns > 1 ? ` · ${v.turns} turns` : '';
  switch (v.state) {
    case 'queued': return 'queued';
    case 'starting': return 'starting';
    case 'working': return `working${Number.isFinite(start) ? ` · ${askDuration(Math.max(0, now - start))}` : ''}${turns}`;
    case 'done': return `${took ? `finished in ${took}` : 'finished'}${turns}`;
    case 'canceled': return 'canceled';
    case 'failed': return v.error ? `failed: ${v.error}` : 'failed';
  }
}

/**
 * Whether Claude is waiting for the reply, said plainly: an ask sent with
 * `--no-wait` must read as one nobody is waiting on, so it is never mistaken
 * for a subagent whose report comes back to the chat.
 */
export function askWaitingText(v: Pick<AskView, 'state' | 'waiting' | 'reply'>): string | null {
  if (isAskActive(v.state)) return v.waiting === 'claude' ? 'Claude is waiting' : 'Claude isn’t waiting for a reply';
  if (v.reply === 'delivered') return 'Returned to Claude';
  if (v.waiting === 'claude') return null;
  if (v.reply === 'dropped' || v.state === 'done') return 'Not sent back to Claude';
  return null;
}

/** How a list of asks stands: "2 working · 1 done", "3 done", "2 done · 1 failed". */
export function asksSummary(list: readonly Pick<AskView, 'state'>[]): string {
  const n = (f: (s: AskState) => boolean) => list.filter(v => f(v.state)).length;
  return [
    n(s => s === 'queued' || s === 'starting') ? `${n(s => s === 'queued' || s === 'starting')} starting` : null,
    n(s => s === 'working') ? `${n(s => s === 'working')} working` : null,
    n(s => s === 'done') ? `${n(s => s === 'done')} done` : null,
    n(s => s === 'failed') ? `${n(s => s === 'failed')} failed` : null,
    n(s => s === 'canceled') ? `${n(s => s === 'canceled')} canceled` : null,
  ].filter(Boolean).join(' · ');
}

/** The box part of a target, `termag-4` of `termag-4/termag-4@main`, for "on termag-4". */
export function targetBox(target: string | null): string | null {
  return target ? target.split('/')[0] || null : null;
}

/**
 * The asks to keep in view (the context card's Asks, the drawer above the
 * composer): any still going, and those the chat's calls named since the
 * last message sent. An ask outlives the turn that sent it, so a --no-wait
 * fan-out stays in view after Claude's turn ends, until it finishes.
 */
export function recentAsks(items: readonly ChatItem[], byCall: ReadonlyMap<string, string[]>, views: ReadonlyMap<string, AskView>): AskView[] {
  let last = -1;
  items.forEach((it, i) => { if (it.kind === 'user' && !it.pending && !it.midTurn) last = i; });
  const since = new Set(items.slice(last + 1).flatMap(it => (it.kind === 'tool' ? byCall.get(it.id) ?? [] : [])));
  return [...views.values()].filter(v => isAskActive(v.state) || since.has(v.thread));
}

/** What a kept-in-view row says under its name: where the ask is, and whether Claude is waiting ("Working · Claude isn't waiting"). */
export function askRowSub(v: Pick<AskView, 'state' | 'waiting' | 'reply' | 'turns' | 'error' | 'target'>): string {
  const box = targetBox(v.target);
  const where = v.state === 'queued' ? 'Queued'
    : v.state === 'starting' ? (box ? `Starting on ${box}` : 'Starting')
    : v.state === 'working' ? 'Working'
    : v.state === 'done' ? 'Finished'
    : v.state === 'canceled' ? 'Canceled'
    : v.error ? `Failed: ${v.error}` : 'Failed';
  // Mid-line, "Not sent back to Claude" reads as "not sent back to Claude"; Claude keeps its capital.
  const waiting = askWaitingText(v);
  const said = waiting && !waiting.startsWith('Claude') ? waiting.charAt(0).toLowerCase() + waiting.slice(1) : waiting;
  return [where, v.turns > 1 ? `${v.turns} turns` : null, said].filter(Boolean).join(' · ');
}

/** How long it has run, in ms: to `now` while it works, else its start to its end; null with nothing to go on. */
export function askElapsed(v: Pick<AskView, 'state' | 'startedAt' | 'completedAt'>, now: number): number | null {
  const start = v.startedAt ? Date.parse(v.startedAt) : NaN;
  if (!Number.isFinite(start)) return null;
  if (v.state === 'working') return Math.max(0, now - start);
  const end = v.completedAt ? Date.parse(v.completedAt) : NaN;
  return Number.isFinite(end) ? Math.max(0, end - start) : null;
}
