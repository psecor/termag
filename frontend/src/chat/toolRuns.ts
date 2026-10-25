// Consecutive tool calls in an SDK chat (chat/sdkChat.ts) fold into one row,
// "Ran 7 commands", so the assistant's prose is what the transcript shows.
import type { ChatItem } from './sdkChat';

export type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

export type TranscriptEntry =
  | { kind: 'item'; item: ChatItem }
  | { kind: 'tools'; key: string; tools: ToolItem[] };

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
    if (run.length >= MIN_RUN) out.push({ kind: 'tools', key: `run:${run[0].key}`, tools: run });
    else for (const t of run) out.push({ kind: 'item', item: t });
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
    case 'Task': return 'task';
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

export interface RunSummary {
  /** "Ran 3 commands, read 2 files". */
  text: string;
  failed: number;
  running: number;
  state: 'running' | 'error' | 'done';
}

export function runSummary(tools: readonly ToolItem[]): RunSummary {
  const counts = new Map<Verb, number>();
  for (const t of tools) {
    const v = verbOf(t.name);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const parts = [...counts].map(([v, n]) => phrase(v, n));
  const text = parts.join(', ');
  const failed = tools.filter(t => t.done && t.isError).length;
  const running = tools.filter(t => !t.done).length;
  // A failure the agent went on past (a later call succeeded) is not the run's
  // outcome: the run is as good as its last call. Calls can run in parallel,
  // so any call still in flight keeps the whole run running.
  const last = tools[tools.length - 1];
  return {
    text: text.charAt(0).toUpperCase() + text.slice(1),
    failed,
    running,
    state: running > 0 ? 'running' : last?.isError ? 'error' : 'done',
  };
}

/** The calls a collapsed run still shows: every failure, and the one running now. */
export function alwaysShown(tools: readonly ToolItem[]): ToolItem[] {
  return tools.filter(t => !t.done || t.isError);
}
