// Consecutive tool calls in an SDK chat (chat/sdkChat.ts) fold into one row
// that says what they were for, so the assistant's prose is what the
// transcript shows. The heading is Haiku's for the run, written once as the
// run starts (chat/toolGroupHeadings.ts), else Claude's own lead-in to the calls
// (chat/leadIn.ts), else the calls' own labels; the step running now goes on
// a muted line under it.
import { leadInHeadline } from './leadIn';
import { toolSummary, type ChatItem } from './sdkChat';

export type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

export type TranscriptEntry =
  | { kind: 'item'; item: ChatItem }
  /** `leadIn`: the assistant text just before the run, which says what it is for. */
  | { kind: 'tools'; key: string; tools: ToolItem[]; leadIn: string | null };

/** Two or more tool calls in a row make a run; a lone call stays its own card. */
export const MIN_RUN = 2;

/**
 * The transcript with each run of consecutive tool calls as one entry, keyed
 * by its first call so a run keeps its open state as it grows.
 */
export function groupToolRuns(items: readonly ChatItem[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  let run: ToolItem[] = [];
  const flush = () => {
    if (run.length >= MIN_RUN) {
      const before = out[out.length - 1];
      const leadIn = before?.kind === 'item' && before.item.kind === 'text' ? before.item.text : null;
      out.push({ kind: 'tools', key: `run:${run[0].key}`, tools: run, leadIn });
    } else for (const t of run) out.push({ kind: 'item', item: t });
    run = [];
  };
  for (const item of items) {
    if (item.kind === 'tool') { run.push(item); continue; }
    // A finished text block with nothing in it shows nothing; it must not split a run.
    if (item.kind === 'text' && !item.streaming && !item.text.trim()) continue;
    flush();
    out.push({ kind: 'item', item });
  }
  flush();
  return out;
}

type Verb = 'command' | 'read' | 'edit' | 'search' | 'web' | 'task' | 'todo' | 'skill' | 'other';

function verbOf(name: string): Verb {
  switch (name) {
    case 'Bash': return 'command';
    case 'Read': return 'read';
    case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'edit';
    case 'Grep': case 'Glob': return 'search';
    case 'WebFetch': case 'WebSearch': return 'web';
    case 'Task': case 'Agent': return 'task';
    case 'TodoWrite': return 'todo';
    case 'Skill': return 'skill';
    default: return 'other';
  }
}

function phrase(verb: Verb, n: number): string {
  const s = (one: string, many: string) => (n === 1 ? one : many);
  switch (verb) {
    case 'command': return `ran ${n} ${s('command', 'commands')}`;
    case 'read': return `read ${n} ${s('file', 'files')}`;
    case 'edit': return `edited ${n} ${s('file', 'files')}`;
    case 'search': return `ran ${n} ${s('search', 'searches')}`;
    case 'web': return `looked up ${n} ${s('page', 'pages')}`;
    case 'task': return `started ${n} ${s('subagent', 'subagents')}`;
    case 'todo': return 'updated the todos';
    case 'skill': return `used ${n} ${s('skill', 'skills')}`;
    case 'other': return `used ${n} ${s('tool', 'tools')}`;
  }
}

const inputOf = (tool: ToolItem) => (tool.input && typeof tool.input === 'object' ? tool.input : {}) as Record<string, unknown>;
const oneLine = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ') : null);
const fileName = (v: unknown) => oneLine(v)?.split('/').filter(Boolean).pop() ?? null;
const host = (v: unknown) => { try { return new URL(oneLine(v) ?? '').host || null; } catch { return null; } };

/**
 * What the call says it is for, in Claude's words: the `description` Claude
 * Code asks for on Bash and on a subagent ("Append video links to each PR
 * description"). Null when the call has none (it is optional, and absent
 * until the call's input has streamed in whole).
 */
export function toolIntent(tool: ToolItem): string | null {
  switch (tool.name) {
    case 'Bash': case 'Task': case 'Agent': return oneLine(inputOf(tool).description);
    default: return null;
  }
}

/**
 * One line for the call: its intent, else what it touches ("Read README.md",
 * "Search for TODO"). Null for a call with neither, such as a Bash call
 * without a description: its command line is not a summary.
 */
export function toolLabel(tool: ToolItem): string | null {
  const intent = toolIntent(tool);
  if (intent) return intent;
  const i = inputOf(tool);
  const named = (verb: string, what: string | null) => (what ? `${verb} ${what}` : null);
  switch (tool.name) {
    case 'Read': return named('Read', fileName(i.file_path));
    case 'Write': return named('Write', fileName(i.file_path));
    case 'Edit': case 'MultiEdit': return named('Edit', fileName(i.file_path));
    case 'NotebookEdit': return named('Edit', fileName(i.notebook_path));
    case 'Grep': return named('Search for', oneLine(i.pattern));
    case 'Glob': return named('Find', oneLine(i.pattern));
    case 'WebFetch': return named('Fetch', host(i.url));
    case 'WebSearch': return named('Search the web for', oneLine(i.query));
    case 'TodoWrite': return 'Update the todos';
    default: return null;
  }
}

/** Header labels joined only while they fit on one line of a narrow chat. */
const MAX_JOINED = 3;
const MAX_JOINED_CHARS = 72;
const MAX_NAMED_FILES = 3;

/**
 * The counts, as the header said before calls carried their intent: "Ran 3
 * commands, read 2 files". A run of only reads (or only edits) names its
 * files: "Read 3 files: a.ts, b.ts, c.ts".
 */
function countsText(tools: readonly ToolItem[]): string {
  const counts = new Map<Verb, number>();
  for (const t of tools) {
    const v = verbOf(t.name);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let text = [...counts].map(([v, n]) => phrase(v, n)).join(', ');
  const [only] = counts.keys();
  if (counts.size === 1 && (only === 'read' || only === 'edit')) {
    const names = [...new Set(tools.map(t => fileName(inputOf(t).file_path ?? inputOf(t).notebook_path)).filter((n): n is string => !!n))];
    if (names.length) {
      text += `: ${names.length > MAX_NAMED_FILES ? `${names.slice(0, MAX_NAMED_FILES - 1).join(', ')}…` : names.join(', ')}`;
    }
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const plusMore = (label: string, others: number) => (others > 0 ? `${label} · +${others} more` : label);

/**
 * The calls' own words: two or three short labels joined, else the latest
 * intent and how many more calls there were, else the counts.
 */
function fromCalls(tools: readonly ToolItem[]): string {
  const described = tools.filter(t => toolIntent(t));
  if (!described.length) return countsText(tools);
  const labels = tools.map(toolLabel);
  if (tools.length <= MAX_JOINED && labels.every(Boolean)) {
    const joined = labels.join(' · ');
    if (joined.length <= MAX_JOINED_CHARS) return joined;
  }
  return plusMore(toolIntent(described[described.length - 1])!, tools.length - 1);
}

/** Where the heading's words came from; `pending` while Haiku's is on its way (no words yet). */
export type HeadlineSource = 'pending' | 'model' | 'lead-in' | 'calls';

/** What the box answered for a run (chat/toolGroupHeadings.ts): its heading, or that it failed after `calls` calls. */
export type RunAnswer = { heading: string } | { failed: true; calls: number | null };

export interface HeadingContext {
  /** The assistant text just before the run (groupToolRuns' `leadIn`). */
  leadIn?: string | null;
  /** Whether Haiku's headings are in reach (the open chat's HeadingStoreContext). */
  headingsOn?: boolean;
  /** The box's answer for the run, once there is one. */
  answer?: RunAnswer | null;
  /** The answer may still come: the run is in the turn running now, and not given up on. */
  pending?: boolean;
}

/** Claude's lead-in, else the calls' own labels. */
function fallback(tools: readonly ToolItem[], leadIn: string | null | undefined): { text: string; source: HeadlineSource } {
  const lead = leadInHeadline(leadIn);
  if (lead) return { text: lead, source: 'lead-in' };
  return { text: fromCalls(tools), source: 'calls' };
}

/**
 * The run's heading line. With Haiku's headings: its heading; when it failed,
 * the fallback made from the calls the run had then (so it is the same live
 * and on a reload); nothing while it may still come; with no answer at all
 * (a box from before them), the fallback. Without them: the fallback.
 * The fallback is Claude's lead-in, else the calls' labels. ToolRun shows the
 * first line this gives and keeps it: a heading never changes once shown.
 */
export function runHeading(tools: readonly ToolItem[], ctx: HeadingContext = {}): { text: string | null; source: HeadlineSource } {
  if (!ctx.headingsOn) return fallback(tools, ctx.leadIn);
  const answer = ctx.answer;
  if (answer && 'heading' in answer && answer.heading.trim()) return { text: answer.heading.trim(), source: 'model' };
  if (answer && 'failed' in answer) return fallback(answer.calls != null && answer.calls > 0 ? tools.slice(0, answer.calls) : tools, ctx.leadIn);
  if (ctx.pending) return { text: null, source: 'pending' };
  return fallback(tools, ctx.leadIn);
}

export interface RunSummary {
  /** The step for the line under the heading: the call running now, else the latest. */
  step: string;
  /** "Ran 3 commands, read 2 files". */
  counts: string;
  failed: number;
  running: number;
  state: 'running' | 'error' | 'done';
}

export function runSummary(tools: readonly ToolItem[]): RunSummary {
  const failed = tools.filter(t => t.done && t.isError).length;
  // A call sent to the background has its result but runs on until its notification.
  const inFlight = tools.filter(t => !t.done || t.background === 'running');
  // A failure the agent went on past (a later call succeeded) is not the run's
  // outcome: the run is as good as its last call. Calls can run in parallel,
  // so any call still in flight keeps the whole run running.
  const last = tools[tools.length - 1];
  const now = inFlight[inFlight.length - 1] ?? last;
  // A call in flight names itself, by its tool while its input is still
  // streaming in ("Read", then "Read a.ts"): the step line is the only place
  // a shut run says what is running (alwaysShown), so an earlier call's words
  // there would pass a finished step off as the one going on. With nothing in
  // flight, the latest call that has words.
  const labelled = now && toolLabel(now) ? now : inFlight.length ? null : [...tools].reverse().find(t => toolLabel(t));
  return {
    step: (labelled ? toolLabel(labelled) : now && toolSummary(now.name, now.input).title) || '',
    counts: countsText(tools),
    failed,
    running: inFlight.length,
    state: inFlight.length > 0 ? 'running' : last?.isError ? 'error' : 'done',
  };
}

/**
 * The calls a collapsed run still shows: every failure, and those still
 * running in the background. Not the call running now: the step line under
 * the heading says what it is, so the run keeps one height while its calls
 * start and end. A card that came in with each call and folded away when it
 * ended moved the text above it, the text being read, at every call.
 */
export function alwaysShown(tools: readonly ToolItem[]): ToolItem[] {
  return tools.filter(t => t.isError || t.background === 'running');
}
