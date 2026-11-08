// Subagents in an SDK chat: what Claude Code says about an Agent call's
// subagent, read from each place it says it. Live, `task_started` (its id,
// type, prompt, and whether it runs in the background), `task_progress` (the
// step it is on, its tokens and tool calls so far), `task_updated` and
// `task_notification` (how it ended, and for a background one its report),
// and the call's result with its `tool_use_result`; in a transcript, only the
// call's result text and, for a background one, its `<task-notification>`.
// The subagent's own messages carry the call's id as `parent_tool_use_id`:
// they are its transcript, never the chat's (sdkChat.ts folds them apart).
// Pure, for the tests.
import type { ChatItem, ChatState } from './sdkChat';

/** Where a subagent is. `stopped`: its turn or process ended with it still going. */
export type SubagentStatus = 'running' | 'done' | 'failed' | 'stopped';

/** What the events say about one subagent, beyond its call (the tool item has the description, the prompt and the times). */
export interface SubagentInfo {
  /** Claude Code's id for it (task_id, agentId): its transcript is `subagents/agent-<id>.jsonl` beside the session's. */
  agentId?: string;
  agentType?: string;
  prompt?: string;
  /** Runs in the background (run_in_background): its call's result only says it started. */
  background?: boolean;
  status?: SubagentStatus;
  /** The step it is on, as Claude Code says it ("Running List directory contents"). */
  step?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  model?: string;
  /** Its final report, the words Claude got back. */
  report?: string;
}

/** Claude Code's subagent tool: `Agent`, called `Task` before 2.1. */
export function isAgentTool(name: string): boolean {
  return name === 'Agent' || name === 'Task';
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const id = (v: unknown): string | undefined => (typeof v === 'string' && AGENT_ID.test(v) ? v : undefined);

/** Drop the keys with no value, so a patch never clears what an earlier event said. */
function defined(info: SubagentInfo): SubagentInfo {
  return Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined)) as SubagentInfo;
}

/** How a task's status reads: Claude Code's `completed`, `failed`, `killed`/`stopped`. */
export function taskStatus(status: unknown): SubagentStatus | undefined {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'killed' || status === 'stopped' || status === 'cancelled') return 'stopped';
  if (status === 'running' || status === 'pending') return 'running';
  return undefined;
}

/** A usage block's numbers: the notification's (`total_tokens`) or the tag's (`subagent_tokens`). */
function usageOf(u: Record<string, unknown> | null | undefined): Pick<SubagentInfo, 'tokens' | 'toolUses' | 'durationMs'> {
  if (!u) return {};
  return { tokens: num(u.total_tokens) ?? num(u.subagent_tokens), toolUses: num(u.tool_uses), durationMs: num(u.duration_ms) };
}

/**
 * A `system` event about a subagent task, as the call's id it names and what
 * it says, or null for any other event. `task_updated` names only its task:
 * its `taskId` is how it is matched to a call.
 */
export function taskEvent(e: Record<string, unknown>): { toolUseId: string | null; taskId: string | null; info: SubagentInfo } | null {
  if (e.type !== 'system') return null;
  const toolUseId = typeof e.tool_use_id === 'string' ? e.tool_use_id : null;
  const taskId = id(e.task_id) ?? null;
  switch (e.subtype) {
    case 'task_started':
      if (e.task_type !== 'local_agent') return null;
      return {
        toolUseId, taskId,
        info: defined({ agentId: taskId ?? undefined, agentType: text(e.subagent_type), prompt: text(e.prompt), background: e.is_backgrounded === true, status: 'running' }),
      };
    case 'task_progress':
      return { toolUseId, taskId, info: defined({ step: text(e.description), ...usageOf(e.usage as Record<string, unknown> | undefined) }) };
    case 'task_updated': {
      const patch = (e.patch ?? {}) as Record<string, unknown>;
      return { toolUseId, taskId, info: defined({ status: taskStatus(patch.status) }) };
    }
    case 'task_notification':
      return {
        toolUseId, taskId,
        info: defined({ status: taskStatus(e.status) ?? 'stopped', ...usageOf(e.usage as Record<string, unknown> | undefined), report: text(e.summary) }),
      };
    default:
      return null;
  }
}

// The call's result as Claude Code writes it: a foreground subagent's report
// in a frame ("[Subagent hand-back] … The report follows:" then the report,
// each line indented two spaces), and either kind's id on a line of its own.
const REPORT_START = /The report follows:\n/;
const AGENT_ID_LINE = /^agentId: ([A-Za-z0-9_-]{1,64})\b/m;
const ASYNC_LAUNCHED = /^Async agent launched successfully\b/;
const USAGE_TAG = /<usage>([\s\S]*?)<\/usage>/;

function usageText(body: string | undefined): Pick<SubagentInfo, 'tokens' | 'toolUses' | 'durationMs'> {
  if (!body) return {};
  const field = (name: string) => {
    const m = new RegExp(`${name}(?::\\s*|>)(\\d+)`).exec(body);
    return m ? Number(m[1]) : undefined;
  };
  return { tokens: field('subagent_tokens') ?? field('total_tokens'), toolUses: field('tool_uses'), durationMs: field('duration_ms') };
}

/**
 * What an Agent call's result says: its subagent's id, that it went to the
 * background (the result only says it launched), or the report and usage of
 * one that ran in the foreground. `structured` is the live event's
 * `tool_use_result`, which a transcript keeps only as the text.
 */
export function agentResult(result: string, isError: boolean, structured?: unknown): SubagentInfo {
  const s = (structured && typeof structured === 'object' ? structured : {}) as Record<string, unknown>;
  const agentId = id(s.agentId) ?? AGENT_ID_LINE.exec(result)?.[1];
  const background = s.isAsync === true || ASYNC_LAUNCHED.test(result);
  const shared = defined({ agentId, agentType: text(s.agentType), model: text(s.resolvedModel), prompt: text(s.prompt) });
  if (background) return { ...shared, background: true, ...(isError ? { status: 'failed' as const } : {}) };
  const parts = Array.isArray(s.content) ? (s.content as Array<Record<string, unknown>>) : [];
  const fromParts = parts.map(p => (p?.type === 'text' && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
  const tagged = usageText(USAGE_TAG.exec(result)?.[1]);
  return defined({
    ...shared,
    status: isError ? 'failed' : (taskStatus(s.status) ?? 'done'),
    report: isError ? text(result) : text(fromParts) ?? reportFromText(result),
    tokens: num(s.totalTokens) ?? tagged.tokens,
    toolUses: num(s.totalToolUseCount) ?? tagged.toolUses,
    durationMs: num(s.totalDurationMs) ?? tagged.durationMs,
  });
}

/** The report in a foreground call's result text: past the frame, before its id, each line's two-space indent taken off. */
function reportFromText(result: string): string | undefined {
  const start = REPORT_START.exec(result);
  if (!start) return undefined;
  let body = result.slice(start.index + start[0].length);
  const end = AGENT_ID_LINE.exec(body);
  if (end) body = body.slice(0, end.index);
  return text(body.split('\n').map(l => (l.startsWith('  ') ? l.slice(2) : l)).join('\n'));
}

/** What a background subagent's `<task-notification>` adds: its report (`<result>`) and its usage. */
export function notificationInfo(body: string): Pick<SubagentInfo, 'report' | 'tokens' | 'toolUses' | 'durationMs'> {
  const result = /<result>([\s\S]*?)<\/result>/.exec(body)?.[1];
  return defined({ report: text(result ? unescapeXml(result) : undefined), ...usageText(USAGE_TAG.exec(body)?.[1]) });
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** `info` with `patch` over it: a later event's word wins, an absent one keeps the earlier. An ended subagent stays ended. */
export function mergeInfo(info: SubagentInfo | undefined, patch: SubagentInfo): SubagentInfo {
  const next = { ...(info ?? {}), ...defined(patch) };
  if (info?.status && info.status !== 'running' && patch.status === 'running') next.status = info.status;
  return next;
}

/** One Agent call's subagent in the chat's state: what the events said, and its own messages, folded into a chat of its own. */
export interface SubagentRecord { info: SubagentInfo; chat: ChatState }

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/** A subagent as the chat shows it: its call, what the events said, and its own messages so far. */
export interface SubagentView {
  /** Its Agent call's id. */
  id: string;
  call: ToolItem;
  description: string;
  agentType: string | null;
  prompt: string | null;
  background: boolean;
  status: SubagentStatus;
  step: string | null;
  tokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
  model: string | null;
  report: string | null;
  agentId: string | null;
  /** Its own messages as they streamed (none in a reloaded transcript), settled once it ended. */
  items: ChatItem[];
  /** Its own chat, for its subagents (`subagentsOf(view.nested)`): running while it runs, so one it left going stops with it. */
  nested: Pick<ChatState, 'items' | 'subagents' | 'running'>;
  /** A pane chat's (chat/paneSubagents.ts): read from beside its Claude's session, with no row in the transcript; its tab reads it through GET …/chat/pane-subagents/:agentId. */
  pane?: boolean;
  /** A session running alongside a pane chat's Claude (chat/paneSubagents.ts paneAlongsideViews): its tab reads that session's transcript, GET …/chat/pane-sessions/:sessionId. */
  paneSession?: string;
}

/**
 * Where a subagent is: how its events say it ended, else what its call says.
 * A call still open, or a background one never reported, in a chat whose
 * turn is over has stopped with it.
 */
function statusOf(call: ToolItem, info: SubagentInfo | undefined, running: boolean): SubagentStatus {
  if (info?.status && info.status !== 'running') return info.status;
  if (call.background && call.background !== 'running') return call.background;
  if (!call.done) return running ? 'running' : 'stopped';
  // Cut off: its turn ended (or was stopped) before its result came.
  if (call.result == null) return 'stopped';
  if (call.isError) return 'failed';
  if (call.background === 'running' || info?.background) return running ? 'running' : 'stopped';
  return 'done';
}

/** A subagent's messages once it has ended: nothing streams, and a call left open was cut off. */
function settled(items: ChatItem[]): ChatItem[] {
  return items.some(it => (it.kind === 'text' && it.streaming) || (it.kind === 'tool' && !it.done))
    ? items.map(it => (it.kind === 'text' && it.streaming ? { ...it, streaming: false } : it.kind === 'tool' && !it.done ? { ...it, done: true } : it))
    : items;
}

const inputOf = (call: ToolItem) => (call.input && typeof call.input === 'object' ? call.input as Record<string, unknown> : {});

/** The chat's subagents, one per Agent call, in the order Claude called them. */
export function subagentsOf(state: Pick<ChatState, 'items' | 'subagents' | 'running'>): SubagentView[] {
  const out: SubagentView[] = [];
  for (const it of state.items) {
    if (it.kind !== 'tool' || !isAgentTool(it.name)) continue;
    const rec = state.subagents?.[it.id];
    const info = rec?.info;
    const input = inputOf(it);
    const status = statusOf(it, info, state.running);
    const items = rec?.chat.items ?? [];
    out.push({
      id: it.id,
      call: it,
      description: text(input.description) ?? 'Subagent',
      agentType: info?.agentType ?? text(input.subagent_type) ?? null,
      prompt: info?.prompt ?? text(input.prompt) ?? null,
      background: info?.background ?? input.run_in_background === true,
      status,
      step: status === 'running' ? info?.step ?? null : null,
      tokens: info?.tokens ?? null,
      toolUses: info?.toolUses ?? null,
      durationMs: info?.durationMs ?? null,
      model: info?.model ?? null,
      report: info?.report ?? null,
      agentId: info?.agentId ?? null,
      items: status === 'running' ? items : settled(items),
      nested: { items, subagents: rec?.chat.subagents, running: status === 'running' },
    });
  }
  return out;
}

/**
 * How long it has run, in ms: to `now` while it runs (from its call's start),
 * else what its usage says, else its call's own span. A start only guessed
 * (the call streamed with no time of its own, sdkChat.ts) is not counted
 * from: its usage's time stands in. Null with nothing to go on.
 */
export function subagentElapsed(v: Pick<SubagentView, 'status' | 'durationMs' | 'call' | 'background'>, now: number): number | null {
  const start = v.call.startedAt && !v.call.startGuessed ? Date.parse(v.call.startedAt) : NaN;
  if (v.status === 'running') return Number.isFinite(start) ? Math.max(0, now - start) : v.durationMs;
  if (v.durationMs != null) return v.durationMs;
  const end = v.call.endedAt ? Date.parse(v.call.endedAt) : NaN;
  return Number.isFinite(start) && Number.isFinite(end) && !v.background ? Math.max(0, end - start) : null;
}

/** "<1s", "12s", "3m 5s", "1h 2m" (sdkChat formatDuration's words, kept here so this module needs nothing of it at runtime). */
export function agentDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** Where a subagent is, in a few words: "2 tools · 45s" while it runs, "finished in 1m 4s", "failed after 12s", "stopped". */
export function subagentLine(v: Pick<SubagentView, 'status' | 'durationMs' | 'call' | 'toolUses' | 'background'>, now: number): string {
  const ms = subagentElapsed(v, now);
  const took = ms != null ? agentDuration(ms) : null;
  switch (v.status) {
    case 'running': {
      const tools = v.toolUses != null ? `${v.toolUses} ${v.toolUses === 1 ? 'tool' : 'tools'}` : null;
      return [tools ?? (v.background ? 'in the background' : 'working'), took].filter(Boolean).join(' · ');
    }
    case 'done': return took ? `finished in ${took}` : 'finished';
    case 'failed': return took ? `failed after ${took}` : 'failed';
    case 'stopped': return 'stopped';
  }
}

/**
 * The subagents to keep in view (the context card's Agents, the drawer above
 * the composer): those Claude started since the last message sent, and any
 * still running. A message taken in mid-turn starts nothing new.
 */
export function recentSubagents(items: readonly ChatItem[], list: readonly SubagentView[]): SubagentView[] {
  let last = -1;
  items.forEach((it, i) => { if (it.kind === 'user' && !it.pending && !it.midTurn) last = i; });
  const since = new Set(items.slice(last + 1).flatMap(it => (it.kind === 'tool' ? [it.id] : [])));
  return list.filter(v => v.status === 'running' || since.has(v.id));
}

/** A report's first line as a few plain words, for a row: no markdown marks. */
export function reportGist(report: string | null): string | null {
  const line = report?.split('\n').map(l => l.trim()).find(l => l && !/^```/.test(l));
  if (!line) return null;
  return line.replace(/^#+\s*|^[-*>]\s+|^\d+\.\s+/, '').replace(/[*_`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim() || null;
}

/** How a list of subagents stands: "2 running · 1 done", "3 done", "2 done · 1 failed". */
export function subagentsSummary(list: readonly Pick<SubagentView, 'status'>[]): string {
  const n = (s: SubagentStatus) => list.filter(v => v.status === s).length;
  return [
    n('running') ? `${n('running')} running` : null,
    n('done') ? `${n('done')} done` : null,
    n('failed') ? `${n('failed')} failed` : null,
    n('stopped') ? `${n('stopped')} stopped` : null,
  ].filter(Boolean).join(' · ');
}
