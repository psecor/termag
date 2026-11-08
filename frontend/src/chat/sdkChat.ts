// The simple UI's SDK chat, as data: one reducer over Claude Code's
// stream-json events (live, through the chat runner) and its transcript
// entries (history, same shapes), producing the items the chat renders —
// user bubbles, assistant text (streamed), tool cards with their results —
// and the one status line. Unknown events are ignored, never fatal.
import { isClaudeAuthError } from './claudeLogin';
import { emptyUsage, withMessageUsage, withPlanSpend, withRateLimit, withResultUsage, withSpendReset, type ChatUsage } from './contextUsage';
import { agentResult, isAgentTool, mergeInfo, notificationInfo, taskEvent, taskStatus, type SubagentInfo, type SubagentRecord } from './subagents';

/**
 * An image in a user message: `src` while it is only in this browser (a data
 * URL), `path` once the box keeps it (read through GET /api/projects/:id/image).
 */
export interface ChatImage { mediaType: string; src?: string; path?: string; /** A PDF's file name. */ name?: string }

export type ChatItem =
  | {
    kind: 'user'; key: string; text: string; pending?: boolean; uuid?: string; turnId?: string; images?: ChatImage[];
    /** Taken in while a turn ran (a live replay, or the agent's entry from a queued_command): never what started a turn. */
    midTurn?: boolean;
  }
  | { kind: 'text'; key: string; text: string; streaming: boolean }
  | {
    kind: 'tool'; key: string; id: string; name: string; input: unknown;
    inputJson: string; result: string | null; isError: boolean; done: boolean;
    /** A Skill call's instructions (its SKILL.md), which Claude Code adds as a synthetic user message. */
    skill?: string;
    /**
     * A call Claude sent to the background (Bash's `run_in_background`): its
     * result only says it started, so the card follows the task itself, from
     * `running` to how its notification says it ended.
     */
    background?: BackgroundState;
    /** That background call's task id (its result's "ID: …"), which the box's task list names. */
    taskId?: string;
    /**
     * When the call was made and when its result came (ISO, the box's
     * clock): the stream's and the transcript's own `timestamp`. Without one,
     * the nearest earlier event's time (`ChatState.clock`), marked `startGuessed` / `endGuessed`.
     */
    startedAt?: string | null;
    endedAt?: string | null;
    startGuessed?: true;
    endGuessed?: true;
  }
  /** A skill's instructions loaded without a Skill call (a typed slash command). */
  | { kind: 'skill'; key: string; name: string; text: string }
  | { kind: 'error'; key: string; text: string }
  /** Something the user did, said in neutral words: "Stopped by you". */
  /** `info`: a note about the turn, not a stop; isStopNote tells them apart. */
  | { kind: 'note'; key: string; text: string; info?: true }
  /** The box ran the turn read-only though the chat asked for full tools (agent settleTurnMode): why, and what undoes it. */
  | { kind: 'readonly'; key: string; reason: string; fix?: string }
  /**
   * A slash command Claude Code ran itself (a mod's `/reload-plugins`), never
   * the model's: one line, "Ran /reload-plugins: not available over a remote connection".
   */
  | { kind: 'command'; key: string; name: string; args: string; output: string | null; folded: string[] }
  /**
   * Where the chat's context was cleared or compacted (agent chat-context-v1).
   * Above a clear is not in Claude's context; above a compact is, as Claude's
   * summary. `undone`: Resume put the cleared session back.
   */
  | {
    kind: 'divider'; key: string; at: string | null; variant: 'cleared' | 'compacted'; undone?: boolean; preTokens?: number | null;
    /** A compacted divider's summary, the transcript entry its turn record names (agent historyEntries): its cost is pinned here. */
    promptUuid?: string;
  }
  /**
   * Background tasks that ended, as one muted line (a run of them folded
   * together): Claude Code tells the model with a user-role
   * `<task-notification>`, which the person never typed.
   */
  | { kind: 'tasks'; key: string; ended: TaskEnd[] };

/** One background task's end, from its notification. `agent`: a background subagent's, labelled by its call's description. */
export interface TaskEnd { taskId: string; status: BackgroundState; label: string; exitCode: number | null; agent?: true }

/** `waiting`: Claude answered, and its turn stays open on a background task; a message sent now goes into it only on a live turn. */
export type ChatPhase = 'idle' | 'thinking' | 'writing' | 'tool' | 'waiting' | 'compacting';

/** What one turn cost and how long it took (the runner's turn record, agent/chat-runner.js). */
export interface TurnCost {
  costUsd: number | null; durationMs: number | null;
  /** When the turn ended (ISO): the record's `at`, the turn-end's, or the turn's last event's time. */
  endedAt?: string | null;
}

/**
 * A turn record as chat-history returns it. `userUuid` is the transcript entry this turn wrote.
 * An agent that sends `sessionCostUsd` (the session's total after this turn) has made `costUsd`
 * the turn's own; an older one sends the session's total as `costUsd` (turnCosts).
 */
export interface TurnRecord extends TurnCost {
  turnId: string; prompt: string; at?: string | null; isError?: boolean; userUuid?: string | null;
  sessionId?: string | null; sessionCostUsd?: number | null;
}

export interface ChatState {
  items: ChatItem[];
  sessionId: string | null;
  running: boolean;
  phase: ChatPhase;
  /** The tool call running now, for the status line. */
  activeTool: { name: string; input: unknown } | null;
  /** Each finished turn's cost, by the key of the prompt that started it. */
  costs: Record<string, TurnCost>;
  /** Cost of turns whose transcript entry is not in this view (the history tail, or a prompt Claude never wrote). */
  extraCostUsd: number;
  /** Those turns' records, with when each ended, so the since-cleared cost can count the ones after a clear. */
  unplacedCosts?: UnplacedCost[];
  /** The prompt of the turn running now, and the cost its result reported (an agent without turn-end costs). */
  turnUserKey: string | null;
  lastResult: TurnCost | null;
  /**
   * What the session has cost so far, as its last turn said (Claude's total_cost_usd, which a
   * resume carries on): the next turn costs what it grows by (turnCost). Null in a new session.
   */
  sessionCostUsd?: number | null;
  /** That total when the context was last cleared, for a Resume to put back. */
  clearedSessionCostUsd?: number | null;
  /** The assistant message being streamed: its id and which item each content index fills. */
  stream: { messageId: string | null; byIndex: Record<number, string>; textStarted: number };
  /** Per assistant message, how many final text blocks have arrived (their keys). */
  textFinal: Record<string, number>;
  seq: number;
  /** The last turn event folded in, by its turn and line: replays and resent frames are skipped. */
  cursor: FrameCursor;
  /** This view asked the running turn to stop (`user-stop`): its end is the user's, not a failure. */
  stopRequested?: boolean;
  /** The turn's own prompt (its messageKey), which a live turn replays once more when Claude takes it in: turn-start already showed it. */
  replaySkip?: string | null;
  /** The running turn reads messages while it runs (its turn-start's `live`, agent chat-live-v1). */
  liveTurn?: boolean;
  /** The box asks Haiku for this turn's tool-group headings (its turn-start's `headings`): only then may a run wait for one. */
  turnHeadings?: boolean;
  /** This view, or another, stopped only the running turn's current work (`user-stop` scope `turn`): its result says so. */
  stopTurnOnly?: boolean;
  /** The running turn's background tasks (Claude's `background_tasks_changed`). Stop everything ends them; a turn-only stop ends only the subagents. */
  background?: BackgroundTask[];
  /**
   * Each Agent call's subagent, by the call's id (chat/subagents.ts): what Claude Code said about it, and its own
   * messages (they name the call as `parent_tool_use_id`), folded by this reducer apart from the chat's.
   */
  subagents?: Record<string, SubagentRecord>;
  /** The context ring's numbers (chat/contextUsage.ts). History carries each call's prompt size only, so a reload keeps the rest (withKeptUsage). */
  usage?: ChatUsage;
  /** The running turn is the runner's /compact (its turn-start's `compact`): its events are Claude Code's compaction, not a reply. */
  compacting?: boolean;
  /** The ring's numbers when the context was last cleared, for a Resume to put back. */
  clearedUsage?: ChatUsage | null;
  /** The context size the last compaction started from (its boundary's pre_tokens), until a reply says the new one. */
  compactedFrom?: number | null;
  /**
   * Claude answered, then a background task's end set it going again in the
   * same process, with no message from anyone: the status says so. Cleared
   * by its next answer, a message and the turn's end.
   */
  woken?: boolean;
  /** The seq of the last turn that failed on Claude's sign-in, until Claude answers again (the sign-in card reads it). */
  authFailure?: number | null;
  /**
   * The newest time an event carried (ISO: an entry's `timestamp`, a box
   * line's `at`): the time of an event that has none of its own, such as a
   * streamed tool call or a turn-end from an older agent.
   */
  clock?: string | null;
}

export interface BackgroundTask { description: string; subagent: boolean; id?: string }

/** Where a background call is: still running, or how it ended (`stopped` also when its turn ended with it unreported). */
export type BackgroundState = 'running' | 'done' | 'failed' | 'stopped';

export interface FrameCursor { turnId: string | null; seq: number }

export const emptyChat: ChatState = {
  items: [], sessionId: null, running: false, phase: 'idle', activeTool: null,
  costs: {}, extraCostUsd: 0, turnUserKey: null, lastResult: null,
  stream: { messageId: null, byIndex: {}, textStarted: 0 }, textFinal: {}, seq: 0,
  cursor: { turnId: null, seq: 0 },
};

type AnyEvent = Record<string, any>;
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const MAX_RESULT = 20_000;

/** Tool output as text: a string, or the text parts of a content array. */
export function resultText(content: unknown): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.map(part => (part && typeof part === 'object' && typeof part.text === 'string'
      ? part.text
      : part?.type === 'image' ? '[image]' : part?.type === 'document' ? '[PDF]' : '')).filter(Boolean).join('\n');
  }
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n… (${text.length - MAX_RESULT} more characters)` : text;
}

/** A user message's prompt text ('' for images alone), or null when it carries only tool results. */
function promptText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text as string);
  if (texts.length) return texts.join('\n');
  return content.some(p => p?.type === 'image' || p?.type === 'document') ? '' : null;
}

/** A user message's own images (not a tool result's): the box's stored copies, or inline data. */
export function promptImages(content: unknown): ChatImage[] {
  if (!Array.isArray(content)) return [];
  const out: ChatImage[] = [];
  for (const p of content) {
    const doc = p?.type === 'document';
    const src = p?.type === 'image' || doc ? p.source : null;
    if (!src || typeof src !== 'object') continue;
    const mediaType = typeof src.media_type === 'string' ? src.media_type : doc ? 'application/pdf' : 'image/png';
    const named = doc && typeof p.title === 'string' && p.title ? { name: p.title as string } : {};
    if (src.type === 'termag' && typeof src.path === 'string') out.push({ mediaType, path: src.path, ...named });
    else if (src.type === 'base64' && typeof src.data === 'string') out.push({ mediaType, src: `data:${mediaType};base64,${src.data}`, ...named });
    else out.push({ mediaType, ...named });
  }
  return out;
}

/** turn-start's `images` (agent chat-images-v1): the references the box kept. */
function refImages(raw: unknown): ChatImage[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(r => r && typeof r.path === 'string')
    .map(r => ({ mediaType: typeof r.mediaType === 'string' ? r.mediaType : 'image/png', path: r.path as string, ...(typeof r.name === 'string' && r.name ? { name: r.name as string } : {}) }));
}

const withImages = (images: ChatImage[]) => (images.length ? { images } : {});

/**
 * A sent message's identity: its text and the box's references to its
 * images. A message may be images alone, so two image-only messages differ
 * only by their images. Text alone keeps its plain text as the key.
 */
function messageKey(text: string, images: readonly ChatImage[] = []): string {
  return images.length ? `${text}\u0000${images.map(i => i.path ?? '').join('\u0000')}` : text;
}

/** The same message: its text, and as many images. */
function sameMessage(it: ChatItem, text: string, count: number): boolean {
  return it.kind === 'user' && it.text === text && (it.images?.length ?? 0) === count;
}

function upsert(items: ChatItem[], key: string, make: () => ChatItem, change: (item: ChatItem) => ChatItem): ChatItem[] {
  const i = items.findIndex(it => it.key === key);
  if (i === -1) return [...items, make()];
  const next = items.slice();
  next[i] = change(items[i]);
  return next;
}

function setTool(items: ChatItem[], id: string, change: (tool: Extract<ChatItem, { kind: 'tool' }>) => ChatItem): ChatItem[] {
  const i = items.findIndex(it => it.kind === 'tool' && it.id === id);
  if (i === -1) return items;
  const next = items.slice();
  next[i] = change(items[i] as Extract<ChatItem, { kind: 'tool' }>);
  return next;
}

function newTool(id: string, name: string, input: unknown, when: Stamp = { at: null, guessed: false }): ChatItem {
  return {
    kind: 'tool', key: `tool:${id}`, id, name, input, inputJson: '', result: null, isError: false, done: false,
    ...(when.at && { startedAt: when.at }), ...(when.at && when.guessed && { startGuessed: true as const }),
  };
}

/** An event's time: its own (`guessed: false`), else the chat's clock, the nearest earlier one. */
interface Stamp { at: string | null; guessed: boolean }

/** The time an event carries: a transcript or stream entry's `timestamp`, a box line's `at`. */
function eventTime(e: AnyEvent): string | null {
  const at = typeof e.timestamp === 'string' ? e.timestamp : typeof e.at === 'string' ? e.at : null;
  return at && Number.isFinite(Date.parse(at)) ? at : null;
}

function stampOf(state: ChatState, e: AnyEvent): Stamp {
  const own = eventTime(e);
  return own ? { at: own, guessed: false } : { at: state.clock ?? null, guessed: true };
}

/** A call that has just ended: when, unless it already knows. */
function ended(t: Extract<ChatItem, { kind: 'tool' }>, when: Stamp): Extract<ChatItem, { kind: 'tool' }> {
  if (t.endedAt || !when.at) return t;
  return { ...t, endedAt: when.at, ...(when.guessed && { endGuessed: true as const }) };
}

/** Show a message the user just sent, before its turn starts. */
export function addPending(state: ChatState, text: string, images: ChatImage[] = [], key?: string): ChatState {
  const seq = state.seq + 1;
  return { ...state, seq, items: [...state.items, { kind: 'user', key: key ?? `pending:${seq}`, text, pending: true, ...withImages(images) }] };
}

/**
 * The messages the box holds behind the running turn (history's `waiting`),
 * as queued bubbles: a reload or a switch back starts from an empty chat, so
 * without them a queued message is gone from the view until its turn starts.
 */
export function withWaiting(state: ChatState, waiting: unknown): ChatState {
  if (!Array.isArray(waiting)) return state;
  return waiting.reduce<ChatState>((s, w) => (w && typeof w.text === 'string' ? addPending(s, w.text, refImages(w.images)) : s), state);
}

function streamEvent(state: ChatState, ev: AnyEvent): ChatState {
  const e = ev.event ?? {};
  switch (e.type) {
    case 'message_start':
      return { ...state, stream: { messageId: e.message?.id ?? null, byIndex: {}, textStarted: 0 } };
    case 'content_block_start': {
      const block = e.content_block ?? {};
      const mid = state.stream.messageId ?? `m${state.seq}`;
      if (block.type === 'text') {
        const key = `${mid}:t${state.stream.textStarted}`;
        return {
          ...state,
          phase: 'writing',
          activeTool: null,
          items: upsert(state.items, key, () => ({ kind: 'text', key, text: block.text ?? '', streaming: true }), it => it),
          stream: { ...state.stream, byIndex: { ...state.stream.byIndex, [e.index]: key }, textStarted: state.stream.textStarted + 1 },
        };
      }
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        const key = `tool:${block.id}`;
        return {
          ...state,
          phase: 'tool',
          activeTool: { name: block.name, input: block.input ?? {} },
          items: upsert(state.items, key, () => newTool(block.id, block.name ?? 'tool', block.input ?? {}, stampOf(state, ev)), it => it),
          stream: { ...state.stream, byIndex: { ...state.stream.byIndex, [e.index]: key } },
        };
      }
      return state;
    }
    case 'content_block_delta': {
      const key = state.stream.byIndex[e.index];
      if (!key) return state;
      const d = e.delta ?? {};
      if (d.type === 'text_delta' && typeof d.text === 'string') {
        return { ...state, items: upsert(state.items, key, () => ({ kind: 'text', key, text: d.text, streaming: true }), it => (it.kind === 'text' ? { ...it, text: it.text + d.text } : it)) };
      }
      if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        const items = upsert(state.items, key, () => newTool(key.slice(5), 'tool', {}, stampOf(state, ev)), it => {
          if (it.kind !== 'tool') return it;
          const inputJson = it.inputJson + d.partial_json;
          let input = it.input;
          try { input = JSON.parse(inputJson); } catch { /* not whole yet */ }
          return { ...it, inputJson, input };
        });
        const tool = items.find(it => it.key === key);
        return { ...state, items, activeTool: tool?.kind === 'tool' ? { name: tool.name, input: tool.input } : state.activeTool };
      }
      return state;
    }
    case 'content_block_stop': {
      const key = state.stream.byIndex[e.index];
      if (!key) return state;
      return { ...state, items: upsert(state.items, key, () => ({ kind: 'text', key, text: '', streaming: false }), it => (it.kind === 'text' ? { ...it, streaming: false } : it)) };
    }
    default:
      return state;
  }
}

function assistantEvent(state: ChatState, ev: AnyEvent): ChatState {
  const message = ev.message ?? {};
  const mid: string = message.id ?? `m${state.seq}`;
  const blocks: AnyEvent[] = Array.isArray(message.content) ? message.content : [];
  let { items, phase, activeTool } = state;
  let n = state.textFinal[mid] ?? 0;
  for (const block of blocks) {
    const refused = message.model === '<synthetic>' && block?.type === 'text' && typeof block.text === 'string'
      ? REMOTE_REFUSAL.exec(block.text.trim()) : null;
    if (refused) {
      // A command Claude Code refused (a mod's, in a session with no person at the prompt): its row, not Claude's words.
      items = commandItems(items, { name: refused[1], args: '', output: commandOutput(block.text) }, `${mid}:c${n++}`);
    } else if (block?.type === 'text' && typeof block.text === 'string') {
      const key = `${mid}:t${n++}`;
      items = upsert(items, key, () => ({ kind: 'text', key, text: block.text, streaming: false }), it => ({ ...it, kind: 'text', text: block.text, streaming: false } as ChatItem));
      if (state.running) { phase = 'writing'; activeTool = null; }
    } else if (block?.type === 'tool_use' && typeof block.id === 'string') {
      const key = `tool:${block.id}`;
      // A call first seen streaming has only a guessed start; its message's own time replaces it.
      const when = stampOf(state, ev);
      items = upsert(items, key, () => newTool(block.id, block.name ?? 'tool', block.input ?? {}, when),
        it => (it.kind === 'tool' ? {
          ...it, name: block.name ?? it.name, input: block.input ?? it.input,
          ...(!when.guessed && (it.startGuessed || !it.startedAt) && { startedAt: when.at, startGuessed: undefined }),
        } : it));
      if (state.running) { phase = 'tool'; activeTool = { name: block.name ?? 'tool', input: block.input ?? {} }; }
    }
  }
  return { ...state, items, phase, activeTool, textFinal: { ...state.textFinal, [mid]: n } };
}

const SKILL_BASE = /^\s*Base directory for this skill: (.+)/;

/**
 * Where a synthetic message's text goes: the Skill call it belongs to (by the
 * transcript's `sourceToolUseID`, else the newest Skill call still without
 * instructions in the trailing run of calls), a skill row of its own when it
 * is a skill's instructions with no call, or nowhere. Never a user bubble.
 */
function syntheticText(items: ChatItem[], ev: AnyEvent, text: string): ChatItem[] {
  const isSkillTool = (it: ChatItem): it is Extract<ChatItem, { kind: 'tool' }> => it.kind === 'tool' && it.name === 'Skill';
  let target = -1;
  if (typeof ev.sourceToolUseID === 'string') {
    target = items.findIndex(it => it.kind === 'tool' && it.id === ev.sourceToolUseID);
  } else {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'text' && !it.text.trim()) continue;
      if (it.kind !== 'tool') break;
      if (isSkillTool(it) && it.skill == null) { target = i; break; }
    }
  }
  if (target >= 0 && isSkillTool(items[target])) {
    const next = items.slice();
    const tool = items[target] as Extract<ChatItem, { kind: 'tool' }>;
    next[target] = { ...tool, skill: tool.skill ? `${tool.skill}\n\n${text}` : text };
    return next;
  }
  const base = SKILL_BASE.exec(text);
  if (!base) return items;
  // A live replay over a snapshot that already holds it.
  if (items.some(it => (it.kind === 'tool' && it.skill === text) || (it.kind === 'skill' && it.text === text))) return items;
  const name = base[1].trim().replace(/\/+$/, '').split('/').pop() || 'skill';
  const key = typeof ev.uuid === 'string' ? `skill:${ev.uuid}` : `skill:${items.length}`;
  return [...items, { kind: 'skill', key, name, text }];
}

const INTERRUPT_MARK = /^\[Request interrupted by user\b/;

// What a background call's tool_result says (Claude Code's Bash with run_in_background).
const BACKGROUND_STARTED = /^Command running in background with ID: ([A-Za-z0-9_-]+)/;
const TASK_NOTIFICATION = /^\s*<task-notification>/;
// A user-role message that is only a reminder Claude Code adds for the model.
const SYSTEM_REMINDER_ONLY = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/;

interface TaskNote { taskId: string | null; toolUseId: string | null; status: string | null; summary: string | null }

/**
 * A background task's notification as a user-role message holds it (the
 * transcript's entry, its queued_command, or a live turn's replay of it,
 * each marked `origin.kind: task-notification`): the task, its call, how it
 * ended and Claude Code's summary. Null for anything else.
 */
function taskNotification(text: string, origin?: unknown): TaskNote | null {
  const marked = (origin as { kind?: unknown } | null)?.kind === 'task-notification';
  if (!TASK_NOTIFICATION.test(text) && !marked) return null;
  const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(text)?.[1]?.trim() || null;
  return { taskId: tag('task-id'), toolUseId: tag('tool-use-id'), status: tag('status'), summary: tag('summary') };
}

/** What a task's line says: its description (the summary's quoted name), and its exit code when the summary has one. */
function taskEnd(note: TaskNote, status: BackgroundState): TaskEnd {
  const summary = (note.summary ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const quoted = /"([^"]+)"/.exec(summary)?.[1] ?? null;
  const code = /exit code (-?\d+)/i.exec(summary);
  return { taskId: note.taskId ?? '', status, label: quoted ?? (summary || 'a background task'), exitCode: code ? Number(code[1]) : null };
}

/** "✓ Background command finished: npm test (exit 0)" for one end; a run of them is counted. */
export function tasksLine(item: Extract<ChatItem, { kind: 'tasks' }>): { mark: string; text: string; warn: boolean } {
  const warn = item.ended.some(t => t.status !== 'done');
  const one = (t: TaskEnd) => {
    const verb = t.status === 'done' ? 'finished' : t.status === 'failed' ? 'failed' : 'stopped';
    return `Background ${t.agent ? 'agent' : 'command'} ${verb}: ${t.label}${t.exitCode != null ? ` (exit ${t.exitCode})` : ''}`;
  };
  if (item.ended.length === 1) return { mark: warn ? '✗' : '✓', text: one(item.ended[0]), warn };
  const bad = item.ended.filter(t => t.status !== 'done').length;
  const noun = item.ended.every(t => t.agent) ? 'agents' : item.ended.some(t => t.agent) ? 'tasks' : 'commands';
  const counted = `${item.ended.length} background ${noun} ended${bad ? `, ${bad} without finishing` : ''}`;
  return { mark: warn ? '✗' : '✓', text: `${counted}: ${item.ended.map(t => t.label).join(' · ')}`, warn };
}

function backgroundState(status: unknown): BackgroundState {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  return 'stopped';
}

/**
 * A background task ended: its card says how, a line says so where the
 * notification fell (one line per task, a run of them folded into one), and
 * a turn that only waited on it is working again, since Claude Code takes
 * the notification as its next step (a task that ends while Claude works
 * waits for that work). `background` is false for a live notification of a
 * foreground call (Claude Code reports those too): it changes nothing.
 */
function backgroundEnded(state: ChatState, note: TaskNote, background: boolean): ChatState {
  const call = note.toolUseId ? state.items.find(it => it.kind === 'tool' && it.id === note.toolUseId) : undefined;
  // A task a subagent started (its own subagent, its own background command): the subagent's, not the chat's.
  if (note.toolUseId && !call && Object.values(state.subagents ?? {}).some(r => knowsCall(r.chat, note.toolUseId!))) return state;
  // A subagent reports its end with an output file in the foreground too: its call's result says how it went.
  const agent = call?.kind === 'tool' && isAgentTool(call.name) ? call : null;
  if (agent && !agentInBackground(state, agent)) return state;
  if (!background && !(call?.kind === 'tool' && call.background)) return state;
  const status = backgroundState(note.status);
  let items = note.toolUseId
    ? setTool(state.items, note.toolUseId, t => ({ ...t, background: status }))
    : state.items;
  const seen = note.taskId != null && items.some(it => it.kind === 'tasks' && it.ended.some(t => t.taskId === note.taskId));
  if (!seen) {
    const description = agent ? str((agent.input as AnyEvent | null)?.description) : null;
    const end: TaskEnd = agent ? { ...taskEnd(note, status), ...(description && { label: description }), agent: true } : taskEnd(note, status);
    const last = items[items.length - 1];
    items = last?.kind === 'tasks'
      ? [...items.slice(0, -1), { ...last, ended: [...last.ended, end] }]
      : [...items, { kind: 'tasks', key: `tasks:${note.taskId ?? state.seq + 1}`, ended: [end] }];
  }
  return { ...wake(state), items };
}

/** Claude, which had answered, is going again on its own: a background task set it off. */
function wake(state: ChatState): ChatState {
  return state.running && state.phase === 'waiting' ? { ...state, phase: 'thinking', activeTool: null, woken: true } : state;
}

/**
 * Calls still running in the background when nothing will report them
 * again (the process they ran in is gone): all of them, or with `running`
 * (the box's task ids now), those it no longer lists. A call with no task
 * id stays as it is then: nothing says it ended.
 */
export function settleBackground(items: ChatItem[], running?: ReadonlySet<string>): ChatItem[] {
  const ended = (it: ChatItem) => it.kind === 'tool' && it.background === 'running'
    && (!running || (it.taskId != null && !running.has(it.taskId)));
  return items.some(ended)
    ? items.map(it => (ended(it) ? { ...(it as Extract<ChatItem, { kind: 'tool' }>), background: 'stopped' as const } : it))
    : items;
}

// A local command's echo in the transcript: `<command-name>/x</command-name>`
// with its message and args, its output in `<local-command-stdout>`, and the
// caveat Claude Code records before it. Markup for Claude Code, not words.
const LOCAL_COMMAND_TAGS = ['command-name', 'command-message', 'command-args', 'local-command-stdout', 'local-command-stderr', 'local-command-caveat'];
const LOCAL_COMMAND_PART = new RegExp(`<(${LOCAL_COMMAND_TAGS.join('|')})>([\\s\\S]*?)</\\1>`, 'g');
// What a session with no person at the prompt (`claude -p`, the chat runner)
// answers a command it refuses, as a synthetic assistant message.
const REMOTE_REFUSAL = /^\/(\S+) isn't available over a remote connection\b/;
const MAX_COMMAND_OUTPUT = 160;

interface LocalCommand { name: string | null; args: string; output: string | null }

/** The command a user message is only the echo of (its name, its output), or null when it holds words of its own. */
export function localCommand(text: string): LocalCommand | null {
  let name: string | null = null;
  let args = '';
  let output: string | null = null;
  let any = false;
  const rest = text.replace(LOCAL_COMMAND_PART, (_, tag: string, body: string) => {
    any = true;
    if (tag === 'command-name') name = body.trim().replace(/^\//, '') || null;
    else if (tag === 'command-args') args = commandArgs(body);
    else if (tag === 'local-command-stdout' || tag === 'local-command-stderr') output = commandOutput(body) ?? output;
    return '';
  });
  return any && !rest.trim() ? { name, args, output } : null;
}

function commandArgs(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, MAX_COMMAND_OUTPUT);
}

/** The command a bubble the person sent is, spelled as its echo spells it, or null when it is no slash command. */
function typedCommand(item: ChatItem | undefined): { name: string; args: string } | null {
  if (item?.kind !== 'user') return null;
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(item.text.trim());
  return m ? { name: m[1], args: commandArgs(m[2] ?? '') } : null;
}

/** A command's output as a short line: its first, with the remote refusal said plainly. */
function commandOutput(text: string): string | null {
  // eslint-disable-next-line no-control-regex
  const line = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').split('\n').map(l => l.trim()).find(Boolean);
  if (!line) return null;
  if (REMOTE_REFUSAL.test(line)) return 'not available over a remote connection';
  return line.length > MAX_COMMAND_OUTPUT ? `${line.slice(0, MAX_COMMAND_OUTPUT - 1)}…` : line;
}

/**
 * A local command into the session: its own row, the output joined to the row of
 * the echo just before it, and a repeat of that row (the same command, the
 * same answer, as a mod's retries leave them) folded into it. An output with
 * no command to name is dropped. A command typed in this session keeps its
 * bubble: its echo adds nothing, its answer adds a row under it. A row keeps
 * the keys of the events folded into it, so a live frame over a snapshot that
 * already holds one adds nothing.
 */
function commandItems(items: ChatItem[], cmd: LocalCommand, key: string): ChatItem[] {
  if (items.some(it => it.key === key || (it.kind === 'command' && it.folded.includes(key)))) return items;
  const last = items[items.length - 1];
  const typed = typedCommand(last);
  if (typed && (cmd.name == null || (cmd.name === typed.name && cmd.args === typed.args))) {
    return cmd.output == null ? items : [...items, { kind: 'command', key, name: typed.name, args: typed.args, output: cmd.output, folded: [] }];
  }
  if (last?.kind === 'command' && (cmd.name == null || (cmd.name === last.name && cmd.args === last.args))) {
    const folded = [...last.folded, key];
    if (last.output == null && cmd.output != null) return [...items.slice(0, -1), { ...last, output: cmd.output, folded }];
    if (cmd.output == null || cmd.output === last.output) return [...items.slice(0, -1), { ...last, folded }];
  }
  if (cmd.name == null) return items;
  return [...items, { kind: 'command', key, name: cmd.name, args: cmd.args, output: cmd.output, folded: [] }];
}

/** The line a command row shows. */
export function commandLine(item: Extract<ChatItem, { kind: 'command' }>): string {
  const ran = `Ran /${item.name}${item.args ? ` ${item.args}` : ''}`;
  return item.output ? `${ran}: ${item.output}` : ran;
}

function userEvent(state: ChatState, ev: AnyEvent): ChatState {
  const content = ev.message?.content;
  const when = stampOf(state, ev);
  let items = state.items;
  let phase = state.phase;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type !== 'tool_result' || typeof part.tool_use_id !== 'string') continue;
      items = setTool(items, part.tool_use_id, t => {
        const result = resultText(part.content);
        const isError = part.is_error === true;
        const started = !isError ? BACKGROUND_STARTED.exec(result) : null;
        const background = started ? 'running' as const : t.background;
        return ended({ ...t, result, isError, done: true, ...(background && { background }), ...(started?.[1] && { taskId: started[1] }) }, when);
      });
      if (state.running) phase = 'thinking';
    }
  }
  const prompt = promptText(content);
  const note = prompt != null ? taskNotification(prompt, ev.origin) : null;
  if (note) {
    // A background task's end as a user-role message (the transcript's, or
    // a live turn's replay when it fell mid-work): Claude Code's words to the
    // model, never a bubble. An idle wake-up comes live as task_notification.
    // A subagent's also carries its report and usage.
    const told = note.toolUseId ? withSubagentInfo({ ...state, items }, note.toolUseId, null, { status: taskStatus(note.status) ?? 'stopped', ...notificationInfo(prompt!) }) : { ...state, items };
    return { ...backgroundEnded(told, note, true), seq: state.seq + 1 };
  }
  if (prompt != null && SYSTEM_REMINDER_ONLY.test(prompt)) return { ...state, items, phase, seq: state.seq + 1 };
  if (prompt != null && INTERRUPT_MARK.test(prompt)) {
    // Claude took a turn-only stop: the result after it is the stop's, also
    // in a view that did not send it and in a reloaded history. A stop of
    // everything stays one: the turn ends with the process.
    const turnOnly = state.running && !(state.stopRequested && !state.stopTurnOnly);
    return { ...state, items, phase, stopTurnOnly: turnOnly || state.stopTurnOnly, seq: state.seq + 1 };
  }
  const images = promptImages(content);
  const command = prompt != null && !images.length ? localCommand(prompt) : null;
  // /compact's echo: the compacted divider says it.
  if (command?.name === 'compact' || (command && command.name == null && command.output === 'Compacted')) return { ...state, items, phase, seq: state.seq + 1 };
  if (command) {
    const key = typeof ev.uuid === 'string' ? `command:${ev.uuid}` : `command:${state.seq + 1}`;
    return { ...state, items: commandItems(items, command, key), phase, seq: state.seq + 1 };
  }
  // Text Claude Code adds itself (a skill's SKILL.md, a caveat): `isSynthetic` live, `isMeta` in the transcript.
  if (prompt != null && (ev.isSynthetic === true || ev.isMeta === true)) {
    items = syntheticText(items, ev, prompt);
  } else if (prompt != null && ev.isReplay === true) {
    // A live turn took a message in: the turn's own prompt (already shown),
    // or one sent while it ran, whose queued bubble moves here, where Claude read it.
    if (state.replaySkip === messageKey(prompt, images)) {
      return { ...state, items, phase: state.running ? 'thinking' : phase, activeTool: null, replaySkip: null, woken: false, seq: state.seq + 1 };
    }
    const key = typeof ev.uuid === 'string' ? `user:${ev.uuid}` : `user:${state.seq + 1}`;
    // The same message the history already holds (a transcript line keeps the message's uuid).
    if (typeof ev.uuid === 'string' && items.some(it => it.kind === 'user' && it.key === key)) {
      return { ...state, items, phase: state.running ? 'thinking' : phase, activeTool: null, woken: false, seq: state.seq + 1 };
    }
    const i = items.findIndex(it => it.kind === 'user' && it.pending && sameMessage(it, prompt, images.length));
    items = [...(i >= 0 ? [...items.slice(0, i), ...items.slice(i + 1)] : items), { kind: 'user', key, text: prompt, midTurn: true, ...withImages(images) }];
    return { ...state, items, phase: state.running ? 'thinking' : phase, activeTool: null, woken: false, seq: state.seq + 1 };
  } else if (prompt != null) {
    const last = items[items.length - 1];
    // The live turn already showed it (turn-start); a transcript replays it.
    // A mid-turn message is in the view already under its live uuid.
    const shown = typeof ev.uuid === 'string' && items.some(it => it.kind === 'user' && it.key === `user:${ev.uuid}`);
    if (!shown && !(last && sameMessage(last, prompt, images.length))) {
      const uuid = typeof ev.uuid === 'string' ? ev.uuid : undefined;
      const key = uuid ? `user:${uuid}` : `user:${state.seq + 1}`;
      items = [...items, { kind: 'user', key, text: prompt, uuid, ...(ev.queued === true && { midTurn: true }), ...withImages(images) }];
    }
  }
  return { ...state, items, phase, activeTool: phase === 'thinking' ? null : state.activeTool, seq: state.seq + 1 };
}

/** The context ring's numbers, from the events that carry them: a call's usage, a result's windows, the plan's limits. */
function withUsage(state: ChatState, e: AnyEvent): ChatState {
  const before = state.usage ?? emptyUsage;
  let usage = before;
  if (e.type === 'assistant') usage = withMessageUsage(before, e.message, e.parent_tool_use_id);
  else if (e.type === 'stream_event' && e.event?.type === 'message_start') usage = withMessageUsage(before, e.event.message, e.parent_tool_use_id);
  else if (e.type === 'result') usage = withResultUsage(before, e.modelUsage);
  else if (e.type === 'rate_limit_event') usage = withRateLimit(before, e.rate_limit_info);
  // The box's notice after an answer (agent/claude-plan-usage.js): a seat's monthly spend.
  else if (e.type === 'plan-usage') usage = withPlanSpend(before, e.spend);
  if (usage === before) return state;
  // A reply says the context's size again: what it was compacted from is history.
  return usage.contextTokens != null && usage.contextTokens !== before.contextTokens ? { ...state, usage, compactedFrom: null } : { ...state, usage };
}

/**
 * Where a compaction happened: one divider per boundary (by its uuid, so a
 * live frame over a history that holds it adds none), and the ring's context
 * empties until the next reply says how big the summary left it.
 */
function compactedDivider(state: ChatState, uuid: string | null, at: string | null, preTokens: number | null, promptUuid: string | null = null): ChatState {
  const key = `compacted:${uuid ?? at ?? state.seq + 1}`;
  // The compact turn has no bubble: its cost is the divider's, so it counts since a clear and in the total.
  const turnUserKey = state.compacting && state.running && !state.turnUserKey ? key : state.turnUserKey;
  // Already folded (a live frame over a history that holds it): a reply since may have filled the
  // ring again, so leave the rest, but the running compact turn still files its cost here.
  if (state.items.some(it => it.key === key)) return turnUserKey === state.turnUserKey ? state : { ...state, turnUserKey };
  const items = [...state.items, { kind: 'divider' as const, key, at, variant: 'compacted' as const, preTokens, ...(promptUuid ? { promptUuid } : {}) }];
  const usage = state.usage ? { ...state.usage, contextTokens: null } : state.usage;
  return { ...state, items, usage, compactedFrom: preTokens, turnUserKey, seq: state.seq + 1 };
}

/**
 * A turn that failed on Claude's sign-in marks the chat until Claude answers
 * again: Claude Code's `authentication_failed` assistant message (its text in
 * a transcript), or a failed result saying so.
 */
function withAuthFailure(state: ChatState, e: AnyEvent): ChatState {
  const texts = (blocks: unknown) => (Array.isArray(blocks) ? blocks : [])
    .map((b: AnyEvent) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join(' ');
  if (e.type === 'assistant') {
    const message = e.message ?? {};
    const synthetic = message.model === '<synthetic>' || e.isApiErrorMessage === true;
    if (e.error === 'authentication_failed' || (synthetic && isClaudeAuthError(texts(message.content)))) {
      return { ...state, authFailure: state.seq + 1 };
    }
    return !synthetic && state.authFailure != null ? { ...state, authFailure: null } : state;
  }
  if (e.type === 'result' && e.is_error === true && typeof e.result === 'string' && isClaudeAuthError(e.result)) {
    return { ...state, authFailure: state.seq + 1 };
  }
  return state;
}

/** Fold one event (live or from the transcript) into the chat. */
export function applyEvent(state: ChatState, ev: unknown): ChatState {
  if (!ev || typeof ev !== 'object') return state;
  const e = ev as AnyEvent;
  state = withAuthFailure(withUsage(state, e), e);
  // A subagent's own message is its transcript, never the chat's.
  if (typeof e.parent_tool_use_id === 'string' && e.parent_tool_use_id && (e.type === 'assistant' || e.type === 'user' || e.type === 'stream_event')) {
    return withClock(subagentMessage(state, e.parent_tool_use_id, e), e);
  }
  const task = taskEvent(e);
  if (task) state = withSubagentInfo(state, task.toolUseId, task.taskId, task.info, e.subtype === 'task_started');
  return withClock(withAgentResults(foldEvent(state, e), e), e);
}

// ── Subagents (chat/subagents.ts) ──

/** The chat a subagent's own messages fold into: one whose turn runs, so its calls and words stream as the chat's do. */
const subagentChat: ChatState = { ...emptyChat, running: true, phase: 'thinking' };

/** Whether `chat` (or a subagent under it) made the call `id`. */
function knowsCall(chat: ChatState, id: string): boolean {
  if (chat.subagents?.[id] || chat.items.some(it => it.kind === 'tool' && it.id === id)) return true;
  return Object.values(chat.subagents ?? {}).some(r => knowsCall(r.chat, id));
}

/** The chat's own subagent (its call's id) whose tree holds the call `id`: the call itself, or the subagent that made it. */
function ownerOf(state: ChatState, id: string): string | null {
  if (state.subagents?.[id] || state.items.some(it => it.kind === 'tool' && it.id === id)) return id;
  for (const [key, rec] of Object.entries(state.subagents ?? {})) if (knowsCall(rec.chat, id)) return key;
  return null;
}

function withRecord(state: ChatState, key: string, change: (rec: SubagentRecord) => SubagentRecord): ChatState {
  const rec = state.subagents?.[key] ?? { info: {}, chat: subagentChat };
  return { ...state, subagents: { ...state.subagents, [key]: change(rec) } };
}

/**
 * A message of a subagent's own: into its chat, the call it names (one a
 * subagent made, for a subagent of a subagent, goes down to that one's).
 */
function subagentMessage(state: ChatState, parent: string, e: AnyEvent): ChatState {
  const key = ownerOf(state, parent) ?? parent;
  const inner = key === parent ? { ...e, parent_tool_use_id: null } : e;
  return withRecord(state, key, rec => ({ ...rec, chat: applyEvent(rec.chat, inner) }));
}

/**
 * What an event says about a subagent, kept on its call's record: by the call
 * it names, else (task_updated names only its task) by the subagent's id.
 */
function withSubagentInfo(state: ChatState, toolUseId: string | null, taskId: string | null, info: SubagentInfo, starts = false): ChatState {
  const key = toolUseId ? ownerOf(state, toolUseId) ?? toolUseId
    : taskId ? Object.keys(state.subagents ?? {}).find(k => state.subagents![k].info.agentId === taskId || hasAgent(state.subagents![k].chat, taskId)) ?? null
    : null;
  if (!key) return state;
  if (toolUseId && key !== toolUseId) return withRecord(state, key, rec => ({ ...rec, chat: withSubagentInfo(rec.chat, toolUseId, taskId, info, starts) }));
  if (!toolUseId && state.subagents?.[key]?.info.agentId !== taskId) return withRecord(state, key, rec => ({ ...rec, chat: withSubagentInfo(rec.chat, null, taskId, info) }));
  // A background command's task events name its Bash call: no subagent there.
  const call = state.items.find(it => it.kind === 'tool' && it.id === key);
  if (call?.kind === 'tool' && !isAgentTool(call.name)) return state;
  // Only an Agent call, or a subagent's own start (its call cut from the history), makes a record.
  if (!call && !state.subagents?.[key] && !starts) return state;
  return withRecord(state, key, rec => ({ ...rec, info: mergeInfo(rec.info, info) }));
}

function hasAgent(chat: ChatState, taskId: string): boolean {
  return Object.values(chat.subagents ?? {}).some(r => r.info.agentId === taskId || hasAgent(r.chat, taskId));
}

/** A background subagent: its call asked for one, or its events or its result said so. */
function agentInBackground(state: ChatState, call: Extract<ChatItem, { kind: 'tool' }>): boolean {
  return (call.input as AnyEvent | null)?.run_in_background === true || call.background != null || state.subagents?.[call.id]?.info.background === true;
}

/**
 * An Agent call's result: its subagent's id and, run in the foreground, its
 * report. One sent to the background is running there: its call follows the
 * task until its notification says how it ended, as a background command's does.
 */
function withAgentResults(state: ChatState, e: AnyEvent): ChatState {
  if (e.type !== 'user' || !Array.isArray(e.message?.content)) return state;
  let next = state;
  for (const part of e.message.content as AnyEvent[]) {
    if (part?.type !== 'tool_result' || typeof part.tool_use_id !== 'string') continue;
    const call = next.items.find(it => it.kind === 'tool' && it.id === part.tool_use_id);
    if (call?.kind !== 'tool' || !isAgentTool(call.name) || call.result == null) continue;
    const info = agentResult(call.result, call.isError, e.tool_use_result);
    next = withSubagentInfo(next, call.id, null, info);
    if (info.background && !call.isError && !call.background) {
      next = { ...next, items: setTool(next.items, call.id, t => ({ ...t, background: 'running' as const, ...(info.agentId && { taskId: info.agentId }) })) };
    }
  }
  return next;
}

/** The chat's clock moves on to an event's own time; a replayed older event leaves it. */
function withClock(state: ChatState, e: AnyEvent): ChatState {
  const at = eventTime(e);
  return at && (!state.clock || at > state.clock) ? { ...state, clock: at } : state;
}

function foldEvent(state: ChatState, e: AnyEvent): ChatState {
  switch (e.type) {
    case 'turn-start': {
      // A compact turn (agent chat-context-v1) is no message: its divider comes with the compaction.
      if (e.compact === true) {
        return { ...state, running: true, phase: 'compacting', activeTool: null, turnUserKey: null, lastResult: null, stopRequested: false, stopTurnOnly: false, replaySkip: null, liveTurn: false, turnHeadings: false, background: [], compacting: true, seq: state.seq + 1 };
      }
      const text = typeof e.text === 'string' ? e.text : '';
      const images = refImages(e.images);
      const i = state.items.findIndex(it => it.kind === 'user' && it.pending && sameMessage(it, text, images.length));
      let items: ChatItem[];
      let turnUserKey: string;
      if (i >= 0) {
        // The pending bubble keeps its local copies: the same pixels, already loaded.
        items = state.items.slice();
        items[i] = { ...(items[i] as Extract<ChatItem, { kind: 'user' }>), pending: false };
        turnUserKey = items[i].key;
      } else {
        turnUserKey = `turn:${state.seq + 1}`;
        items = [...state.items, { kind: 'user', key: turnUserKey, text, ...withImages(images) }];
      }
      // The box refused the turn's trusted mode (agent chat-runner.js settleTurnMode), so it can only read: say so, and why.
      if (typeof e.readOnly === 'string' && e.readOnly) {
        items = [...items, { kind: 'readonly', key: `readonly:${state.seq + 1}`, reason: e.readOnly, ...(typeof e.readOnlyFix === 'string' && e.readOnlyFix ? { fix: e.readOnlyFix } : {}) }];
      }
      // compacting: false, as a compact turn that never settled (its turn-end lost) must not hide this turn's events.
      return { ...state, items, running: true, phase: 'thinking', activeTool: null, turnUserKey, lastResult: null, stopRequested: false, stopTurnOnly: false, replaySkip: messageKey(text, images), liveTurn: e.live === true, turnHeadings: e.headings === true, background: [], compacting: false, woken: false, seq: state.seq + 1 };
    }
    case 'system':
      if (e.subtype === 'background_tasks_changed' && Array.isArray(e.tasks)) {
        const background: BackgroundTask[] = e.tasks.map((t: AnyEvent) => ({
          description: typeof t?.description === 'string' && t.description.trim() ? t.description.trim() : 'a background task',
          subagent: t?.task_type === 'local_agent',
          ...(typeof t?.task_id === 'string' && { id: t.task_id }),
        }));
        return { ...state, background };
      }
      if (e.subtype === 'compact_boundary') {
        const pre = typeof e.compact_metadata?.pre_tokens === 'number' ? e.compact_metadata.pre_tokens : null;
        return compactedDivider(state, typeof e.uuid === 'string' ? e.uuid : null, typeof e.timestamp === 'string' ? e.timestamp : null, pre);
      }
      if (e.subtype === 'task_notification') {
        // A background task has an output file; a foreground call's notification has none.
        const note: TaskNote = { taskId: str(e.task_id), toolUseId: str(e.tool_use_id), status: str(e.status), summary: str(e.summary) };
        return backgroundEnded(state, note, typeof e.output_file === 'string' && e.output_file !== '');
      }
      // Claude Code starts each query with an init, a wake-up's too.
      if (e.subtype === 'init') return wake(typeof e.session_id === 'string' ? { ...state, sessionId: e.session_id } : state);
      return state;
    case 'stream_event':
      return streamEvent(wake(state), e);
    case 'assistant':
      return assistantEvent(wake(state), e);
    case 'user':
      // What a compaction says as a user (its summary, its "Compacted" echo) is Claude Code's, not the person's.
      if (state.compacting && state.running) return { ...state, seq: state.seq + 1 };
      return userEvent(state, e);
    case 'user-stop':
      return state.running ? { ...state, stopRequested: true, stopTurnOnly: e.scope === 'turn' } : state;
    case 'result': {
      const lastResult: TurnCost = {
        costUsd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : null,
        durationMs: typeof e.duration_ms === 'number' ? e.duration_ms : null,
      };
      // A stop ends in Claude's "Interrupted" error; the turn-end says it neutrally instead.
      const stopped = state.stopRequested || (typeof e.result === 'string' && /^interrupted\b/i.test(e.result.trim()));
      const failed = e.is_error === true && e.subtype !== 'success' && !stopped;
      const items = failed
        ? [...state.items, { kind: 'error' as const, key: `error:${state.seq + 1}`, text: typeof e.result === 'string' && e.result ? e.result : `Claude stopped (${e.subtype ?? 'error'})` }]
        : state.items;
      // A turn-only stop ends with this result while background commands go
      // on: what was open is cut off, and the stop is said here, not at turn-end.
      if (state.stopTurnOnly && state.running) {
        const when = stampOf(state, e);
        const settled: ChatItem[] = state.items.map(it => (it.kind === 'text' && it.streaming ? { ...it, streaming: false }
          : it.kind === 'tool' && !it.done ? ended({ ...it, done: true }, when) : it));
        if (!isStopNote(settled[settled.length - 1])) settled.push({ kind: 'note', key: `note:${state.seq + 1}`, text: 'Stopped by you' });
        return {
          ...state, items: settled, lastResult, phase: 'waiting', activeTool: null, stopRequested: false, stopTurnOnly: false,
          stream: { messageId: null, byIndex: {}, textStarted: 0 }, seq: state.seq + 1,
        };
      }
      // A live turn stays open after its answer while a background task runs.
      return { ...state, items, lastResult, phase: state.running ? 'waiting' : state.phase, activeTool: state.running ? null : state.activeTool, woken: false, seq: state.seq + 1 };
    }
    case 'queue-dropped': {
      // Stop dropped messages queued behind the turn: their bubbles come down.
      const texts: string[] = Array.isArray(e.texts) ? e.texts.filter((t: unknown): t is string => typeof t === 'string') : [];
      if (!texts.length) return state;
      const left = [...texts];
      const items = state.items.filter(it => {
        if (it.kind !== 'user' || !it.pending) return true;
        const i = left.indexOf(it.text);
        if (i === -1) return true;
        left.splice(i, 1);
        return false;
      });
      return { ...state, items };
    }
    case 'context-cleared': {
      // The box's word (live, and in the history) that the next turn starts a
      // new session. The ring empties; plan windows are the account's, so they
      // stay. The requesting view folds the answer in, then its own frame: one
      // divider. A history line with `resumedAt` is a clear Resume undid: its
      // divider says so, and the context carried on.
      const at = typeof e.at === 'string' ? e.at : null;
      const key = `cleared:${at ?? state.seq + 1}`;
      if (typeof e.resumedAt === 'string') {
        const items = state.items.some(it => it.key === key) ? state.items : [...state.items, { kind: 'divider' as const, key, at, variant: 'cleared' as const, undone: true }];
        return { ...state, items, seq: state.seq + 1 };
      }
      // Already folded (the answer, then the frame): the stash must keep what the ring had before.
      if (state.items.some(it => it.key === key)) return state;
      const items = [...state.items, { kind: 'divider' as const, key, at, variant: 'cleared' as const }];
      return {
        ...state, items, sessionId: null, clearedUsage: state.usage ?? null, compactedFrom: null,
        usage: { ...emptyUsage, limits: state.usage?.limits ?? {} }, seq: state.seq + 1,
        sessionCostUsd: null, clearedSessionCostUsd: state.sessionCostUsd ?? null,
      };
    }
    case 'context-resumed': {
      // Resume put the cleared session back: its divider is marked undone, and the ring shows what it had.
      const key = `cleared:${typeof e.at === 'string' ? e.at : ''}`;
      const items = state.items.map(it => (it.kind === 'divider' && it.key === key ? { ...it, undone: true } : it));
      const usage = state.clearedUsage ? { ...state.clearedUsage, limits: { ...state.clearedUsage.limits, ...(state.usage?.limits ?? {}) } } : state.usage;
      return {
        ...state, items, sessionId: typeof e.sessionId === 'string' ? e.sessionId : state.sessionId, usage, clearedUsage: null, seq: state.seq + 1,
        sessionCostUsd: state.clearedSessionCostUsd ?? null, clearedSessionCostUsd: null,
      };
    }
    case 'context-compacted': {
      // The history's compact boundary (agent chat-runner.js historyEntries).
      return compactedDivider(state, typeof e.uuid === 'string' ? e.uuid : null, typeof e.at === 'string' ? e.at : null, typeof e.preTokens === 'number' ? e.preTokens : null,
        typeof e.summaryUuid === 'string' ? e.summaryUuid : null);
    }
    case 'runner-error':
      // The turn is over (a failed spawn may never send turn-end), so settle
      // like one: stop the spinner and let the composer send again.
      return {
        ...state,
        items: settleBackground([...state.items, { kind: 'error', key: `error:${state.seq + 1}`, text: String(e.message ?? 'The chat runner failed') }]),
        running: false, phase: 'idle', activeTool: null, liveTurn: false, background: [], compacting: false, woken: false, seq: state.seq + 1,
      };
    case 'turn-end': {
      // Nothing streams once the turn is over; a tool still open was cut off.
      const when = stampOf(state, e);
      const items: ChatItem[] = settleBackground(state.items.map(it => (it.kind === 'text' && it.streaming ? { ...it, streaming: false }
        : it.kind === 'tool' && !it.done ? ended({ ...it, done: true }, when) : it)));
      // Stopped here, or in another view (Claude exits on the SIGINT: signal or 130).
      const stopped = state.stopRequested || e.signal === 'SIGINT' || e.exitCode === 130;
      if (stopped && state.running && !isStopNote(items[items.length - 1])) {
        items.push({ kind: 'note', key: `note:${state.seq + 1}`, text: 'Stopped by you' });
      }
      // The runner's record of the turn; an agent without one leaves the result's numbers. Both
      // are the session's total, unless the record says that beside its cost (sessionCostUsd): then
      // the cost is the turn's own. Otherwise the turn's own is what the total grew by.
      const priced = 'sessionCostUsd' in e;
      const total: number | null = priced ? (typeof e.sessionCostUsd === 'number' ? e.sessionCostUsd : null)
        : typeof e.costUsd === 'number' ? e.costUsd : e.costUsd === null ? null : state.lastResult?.costUsd ?? null;
      const cost: TurnCost = {
        costUsd: priced ? (typeof e.costUsd === 'number' ? e.costUsd : null) : turnCost(total, state.sessionCostUsd ?? null),
        durationMs: typeof e.durationMs === 'number' ? e.durationMs : state.lastResult?.durationMs ?? null,
        // The agent's record says when (`at`); an older agent's turn-end has no time, so its last event's.
        ...(when.at && { endedAt: when.at }),
      };
      const costs = state.turnUserKey ? { ...state.costs, [state.turnUserKey]: cost } : state.costs;
      const extraCostUsd = state.turnUserKey ? state.extraCostUsd : state.extraCostUsd + (cost.costUsd ?? 0);
      return {
        ...state, items, costs, extraCostUsd, running: false, phase: 'idle', activeTool: null,
        sessionCostUsd: total ?? state.sessionCostUsd ?? null,
        turnUserKey: null, lastResult: null, stopRequested: false, stopTurnOnly: false, liveTurn: false, background: [], compacting: false, woken: false,
        seq: stopped ? state.seq + 1 : state.seq, stream: { messageId: null, byIndex: {}, textStarted: 0 },
      };
    }
    default:
      return state;
  }
}

/**
 * Pin each turn record to the bubble it belongs to. A record matches the
 * replayed turn by `turnId`, or the transcript entry Claude wrote for it by
 * `userUuid`. Prompt text is not a key: history is only a tail, so the same
 * words can be an older turn or a terminal turn, and those must not take
 * this turn's cost. A record nothing in view matches still counts in the total.
 */
export function alignTurnCosts(
  users: ReadonlyArray<{ key: string; uuid?: string; turnId?: string }>,
  records: ReadonlyArray<TurnRecord>,
): { costs: Record<string, TurnCost>; extraCostUsd: number; unplaced: UnplacedCost[] } {
  const costs: Record<string, TurnCost> = {};
  const used = new Set<number>();
  let extraCostUsd = 0;
  const unplaced: UnplacedCost[] = [];
  for (const r of records) {
    let j = r.turnId ? users.findIndex((u, i) => !used.has(i) && u.turnId === r.turnId) : -1;
    if (j < 0 && r.userUuid) j = users.findIndex((u, i) => !used.has(i) && u.uuid === r.userUuid);
    if (j >= 0) {
      costs[users[j].key] = { costUsd: r.costUsd, durationMs: r.durationMs, ...(r.at && { endedAt: r.at }) };
      used.add(j);
    } else {
      extraCostUsd += r.costUsd ?? 0;
      if (r.costUsd != null) unplaced.push({ at: r.at ?? null, costUsd: r.costUsd });
    }
  }
  return { costs, extraCostUsd, unplaced };
}


/**
 * A turn's own cost from its session's total and the total after the session's turn before it.
 * `claude -p --resume` carries the session's cost on, so total_cost_usd is all the session has
 * cost so far. A total lower than the one before is a counter that started again (a resume that
 * did not restore it, another config dir or box): all of it is this turn's.
 */
export function turnCost(total: number | null, previous: number | null): number | null {
  if (total == null) return null;
  // Rounded past Claude's own precision, so a difference of totals is no float noise.
  return previous == null || total < previous ? total : Math.round((total - previous) * 1e10) / 1e10;
}

/**
 * The turn records with each turn's own cost, the current session's total after its last turn
 * (which the next turn counts from), and the total when the context was last cleared (which a
 * Resume puts back). An agent that sends `sessionCostUsd` took the costs itself, per session.
 * An older one sends each session's total as the cost and no session, so the totals are taken
 * in order as one session, which a clear (`clears`: when each was, a divider's ISO time) starts
 * again. A just-cleared chat has no session yet (resetContext): its turns are those after the clear.
 */
export function turnCosts(
  records: ReadonlyArray<TurnRecord>, clears: ReadonlyArray<string> = [], sessionId: string | null = null,
): { records: TurnRecord[]; sessionCostUsd: number | null; clearedSessionCostUsd: number | null } {
  const lastClear = clears.reduce<string | null>((a, c) => (a == null || c > a ? c : a), null);
  if (records.some(r => r.sessionCostUsd !== undefined)) {
    const last = (rs: TurnRecord[]) => (rs.length ? rs[rs.length - 1].sessionCostUsd ?? null : null);
    const totals = records.filter(r => r.sessionCostUsd != null);
    const current = totals.filter(r => (sessionId
      ? !r.sessionId || r.sessionId === sessionId
      : lastClear == null || (r.at != null && r.at > lastClear)));
    // The session the last clear left: its turns are the ones before it, after any clear before that.
    const earlier = lastClear == null ? null : clears.filter(c => c < lastClear).reduce<string | null>((a, c) => (a == null || c > a ? c : a), null);
    const cleared = lastClear == null ? [] : totals.filter(r => r.at != null && r.at < lastClear && (earlier == null || r.at > earlier));
    return { records: [...records], sessionCostUsd: last(current), clearedSessionCostUsd: last(cleared) };
  }
  let previous: number | null = null;
  let previousAt: string | null = null;
  let clearedSessionCostUsd: number | null = null;
  let clearedAt: string | null = null;
  const clearedSince = (at: string | null | undefined) => previousAt != null && clears.some(c => c > previousAt! && (at == null || c < at));
  const out = records.map(r => {
    if (clearedSince(r.at)) previous = null;
    const own = turnCost(r.costUsd, previous);
    if (r.costUsd != null) { previous = r.costUsd; previousAt = r.at ?? previousAt; }
    // The running total as the last clear found it.
    if (lastClear != null && r.at != null && r.at < lastClear) { clearedSessionCostUsd = previous; clearedAt = previousAt; }
    return { ...r, costUsd: own };
  });
  // A clear between that turn and the last one left an empty session there.
  if (clearedAt != null && clears.some(c => c > clearedAt! && c < lastClear!)) clearedSessionCostUsd = null;
  return { records: out, sessionCostUsd: clearedSince(null) ? null : previous, clearedSessionCostUsd };
}

/** A turn record no bubble in view took (the history tail cut it): when it ended, and what it cost. */
export interface UnplacedCost { at: string | null; costUsd: number }

/** What the whole chat has cost so far, or null before any turn reported a cost. */
export function chatCostTotal(state: Pick<ChatState, 'costs' | 'extraCostUsd'>): number | null {
  const known = Object.values(state.costs).map(c => c.costUsd).filter((c): c is number => c != null);
  if (known.length === 0 && state.extraCostUsd === 0) return null;
  return known.reduce((a, b) => a + b, 0) + state.extraCostUsd;
}

/**
 * What the chat has cost since its context was last cleared: the replies after
 * the last divider. Null when it was never cleared (the total says it all).
 */
export function costSinceCleared(state: Pick<ChatState, 'items' | 'costs' | 'unplacedCosts'>): number | null {
  let last = -1;
  state.items.forEach((it, i) => { if (it.kind === 'divider' && it.variant === 'cleared' && !it.undone) last = i; });
  if (last < 0) return null;
  // A prompt's turn, or a compact turn's (its divider holds the cost).
  const inView = state.items.slice(last + 1).reduce((sum, it) => sum + (it.kind === 'user' || (it.kind === 'divider' && it.variant === 'compacted') ? state.costs[it.key]?.costUsd ?? 0 : 0), 0);
  // And the turns after the clear whose bubbles the history cap cut: by when they ended (both ISO times).
  const clearedAt = (state.items[last] as Extract<ChatItem, { kind: 'divider' }>).at;
  const cut = clearedAt ? (state.unplacedCosts ?? []).filter(u => u.at != null && u.at > clearedAt).reduce((sum, u) => sum + u.costUsd, 0) : 0;
  return inView + cut;
}

/** "$0.04", "<$0.01", "$12.30". */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.005) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** "<1s", "12s", "3m 5s", "1h 2m". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** A reply's muted footnote: "$0.04 · 12s", or null with nothing known. */
export function turnMeta(cost: TurnCost | undefined): string | null {
  if (!cost) return null;
  const parts = [cost.costUsd != null ? formatCost(cost.costUsd) : null, cost.durationMs != null ? formatDuration(cost.durationMs) : null]
    .filter((p): p is string => p != null);
  return parts.length ? parts.join(' · ') : null;
}

export type ChatGroup =
  | { kind: 'user'; item: Extract<ChatItem, { kind: 'user' }> }
  | { kind: 'divider'; item: Extract<ChatItem, { kind: 'divider' }> }
  | { kind: 'reply'; key: string; userKey: string | null; items: ChatItem[] };

/**
 * How many of a chat's newest groups (prompts and replies, `groupTurns`) a
 * view renders at first. A long session's history is hundreds of markdown
 * and tool blocks; drawing only the newest keeps a switch to it quick, and
 * the earlier ones come in as the reader scrolls up to them
 * (`windowStart`, `transcriptWindow`, `loadsEarlier`).
 */
export const TRANSCRIPT_WINDOW = 40;

/** How close to the top of the transcript a scroll up brings in the next earlier groups. */
export const EARLIER_EDGE_PX = 400;

/**
 * Whether a scroll event brings in earlier groups: the reader moved up (so
 * the first event, the scroll to the bottom when a chat opens, and the
 * anchoring jump after earlier groups came in never count), to within
 * EARLIER_EDGE_PX of the top, with groups left out and none on their way.
 */
export function loadsEarlier(i: { scrollTop: number; prevScrollTop: number | null; hidden: number; pending: boolean }): boolean {
  if (i.hidden <= 0 || i.pending || i.prevScrollTop == null) return false;
  return i.scrollTop < i.prevScrollTop && i.scrollTop <= EARLIER_EDGE_PX;
}

/** A group's key: its prompt's, or its reply's. */
export function chatGroupKey(g: ChatGroup): string {
  return g.kind === 'reply' ? g.key : g.item.key;
}

type Earlier = { before: string; entries: unknown[] };
const uuidOf = (e: unknown): string | null => {
  const uuid = (e as { uuid?: unknown } | null)?.uuid;
  return typeof uuid === 'string' && uuid ? uuid : null;
};
const isMarker = (e: unknown): boolean => {
  const type = (e as { type?: unknown } | null)?.type;
  return type === 'context-cleared' || type === 'context-compacted';
};
/** A clear or compact divider's identity, to tell one a page brings from one the history kept. */
const markerKey = (e: unknown): string => {
  const m = e as { type?: unknown; uuid?: unknown; at?: unknown };
  return `${String(m.type)}:${typeof m.uuid === 'string' ? m.uuid : ''}:${String(m.at ?? '')}`;
};

/**
 * The uuid of the oldest entry that has one, dividers aside: where the page
 * before a history starts from. A divider the history's cap kept (capHistory)
 * sits ahead of entries it is not next to, so paging from it would skip them.
 */
export function firstUuid(entries: readonly unknown[]): string | null {
  for (const e of entries) {
    if (isMarker(e)) continue;
    const uuid = uuidOf(e);
    if (uuid) return uuid;
  }
  return null;
}

/**
 * A history with the earlier pages paged in before it (chatApi.earlier):
 * `earlier.entries` are the ones before the entry `earlier.before`, so they
 * go on from where it is in this snapshot. The dividers the snapshot kept
 * ahead of that entry stay, above the pages, until a page brings them in
 * itself. Null when the entry is not there any more: the pages no longer join up.
 */
export function withEarlier(entries: unknown[], earlier: Earlier | null): unknown[] | null {
  if (!earlier) return entries;
  const at = entries.findIndex(e => uuidOf(e) === earlier.before);
  if (at < 0) return null;
  const paged = new Set(earlier.entries.filter(isMarker).map(markerKey));
  const kept = entries.slice(0, at).filter(e => isMarker(e) && !paged.has(markerKey(e)));
  return [...kept, ...earlier.entries, ...entries.slice(at)];
}

/**
 * The earlier pages carried onto a history that moved on past the entry they
 * joined (a long chat's cap dropped it as the chat grew): the entries the last
 * history had from that entry up to this history's own first entry go onto
 * the pages, so they join this one. Null when the two histories do not overlap.
 */
export function carryEarlier(prev: readonly unknown[], entries: readonly unknown[], earlier: Earlier): Earlier | null {
  const before = firstUuid(entries);
  if (!before) return null;
  const from = prev.findIndex(e => uuidOf(e) === earlier.before);
  const to = prev.findIndex(e => uuidOf(e) === before);
  if (from < 0 || to < from) return null;
  return { before, entries: [...earlier.entries, ...prev.slice(from, to)] };
}

/**
 * Where a chat's window starts: at the group it was fixed to (`from`, a
 * group key), so new prompts and replies append below without pushing the
 * oldest drawn one out. Before it is fixed, or once that group is gone (a
 * history reload that dropped it), the window is the newest TRANSCRIPT_WINDOW
 * groups, which is the whole chat when it is no longer than that.
 */
export function windowStart(keys: readonly string[], from: string | null): number {
  const at = from == null ? -1 : keys.indexOf(from);
  return at >= 0 ? at : Math.max(0, keys.length - TRANSCRIPT_WINDOW);
}

/**
 * Where the window was once a page of older history came in above it: at the
 * group it was fixed to, or, when that group's key changed (a page that ends
 * mid-turn joins onto it), `tail` groups from the end.
 */
export function windowStartAfterPage(keys: readonly string[], from: string | null, tail: number): number {
  const at = from == null ? -1 : keys.indexOf(from);
  return at >= 0 ? at : Math.max(0, keys.length - tail);
}

/** Where the window starts once the next earlier groups come in. */
export function earlierStart(start: number): number {
  return Math.max(0, start - TRANSCRIPT_WINDOW);
}

/** The groups from `start` on, and how many earlier ones are left out. */
export function transcriptWindow<T>(groups: readonly T[], start: number): { groups: readonly T[]; hidden: number } {
  const hidden = Math.min(Math.max(0, start), groups.length);
  return { groups: hidden ? groups.slice(hidden) : groups, hidden };
}

/** The chat as prompts and the replies after them: what a reply's cost footnote hangs on. A divider stands alone. */
export function groupTurns(items: readonly ChatItem[]): ChatGroup[] {
  const groups: ChatGroup[] = [];
  let userKey: string | null = null;
  for (const item of items) {
    if (item.kind === 'user') {
      groups.push({ kind: 'user', item });
      userKey = item.key;
      continue;
    }
    if (item.kind === 'divider') {
      groups.push({ kind: 'divider', item });
      userKey = null;
      continue;
    }
    const last = groups[groups.length - 1];
    if (last?.kind === 'reply') last.items.push(item);
    else groups.push({ kind: 'reply', key: `reply:${item.key}`, userKey, items: [item] });
  }
  return groups;
}

/**
 * What a live frame does while a view is open. During a history load the
 * cursor is still empty, so a line past seq 1 looks like a gap and would
 * start another load before this one finishes. Buffer those frames and judge
 * them once the snapshot is in.
 */
export function liveFrameAction(
  loading: boolean,
  cursor: FrameCursor,
  frame: { turnId?: string | null; seq?: number | null; event: unknown },
): 'buffer' | 'parked' | 'skip' | 'gap' | 'apply' {
  if (loading) return 'buffer';
  if ((frame.event as { type?: unknown } | null)?.type === 'queue-parked') return 'parked';
  return frameDisposition(cursor, frame.turnId ?? null, frame.seq);
}

/**
 * What to do with a numbered turn event: fold it in, skip it (already
 * folded: a replay, or an agent resending after a restart), or note a gap
 * (frames went missing, so the view loads the history again). An event with
 * no number (an agent before durable turns) is always folded in.
 */
export function frameDisposition(cursor: FrameCursor, turnId: string | null, seq: number | null | undefined): 'apply' | 'skip' | 'gap' {
  if (seq == null || turnId == null) return 'apply';
  if (turnId !== cursor.turnId) return seq === 1 ? 'apply' : 'gap';
  if (seq <= cursor.seq) return 'skip';
  return seq === cursor.seq + 1 ? 'apply' : 'gap';
}

/** Fold in one turn event from the socket or a replay; `gap` says frames before it are missing. */
export function applyFrame(state: ChatState, frame: { turnId?: string | null; seq?: number | null; event: unknown }): { state: ChatState; gap: boolean } {
  const turnId = frame.turnId ?? null;
  const how = frameDisposition(state.cursor, turnId, frame.seq);
  if (how === 'skip') return { state, gap: false };
  if (how === 'gap') return { state, gap: true };
  let next = applyEvent(state, frame.event);
  // The replayed bubble is this turn's, even when its text matches an older one.
  const ev = frame.event as { type?: unknown } | null;
  if (turnId && ev?.type === 'turn-start' && next.turnUserKey) {
    const key = next.turnUserKey;
    next = { ...next, items: next.items.map(it => it.kind === 'user' && it.key === key ? { ...it, turnId } : it) };
  }
  return { state: frame.seq != null && turnId != null ? { ...next, cursor: { turnId, seq: frame.seq } } : next, gap: false };
}

/**
 * The chat from its transcript entries, then the turn still running (or lost)
 * replayed from its log, then the runner's turn records. Records are aligned
 * after the replay, so a lost turn's prompt is in the list and is not also
 * counted as extra. A cost the replay already pinned, and no record claimed,
 * stays: the record may not be written until the next poll.
 *
 * `box` is what the history says beside the replay: whether a turn runs, and
 * whether it is live. A long turn's replay is only its newest lines, with no
 * turn-start to say it runs; the box's `head` (agent chat-runner.js
 * eventsFromLog: the turn-start and the background tasks as of the cut) goes
 * first, and without one (an older agent) `running` alone marks the turn
 * open, or the chat said "Done" over a turn still at work.
 */
export function fromHistory(
  entries: unknown[],
  sessionId: string | null = null,
  turn: { turnId: string; events: Array<{ seq: number; event: unknown }>; head?: unknown[] } | null = null,
  records: ReadonlyArray<TurnRecord> = [],
  box: { running?: boolean; liveInput?: boolean } = {},
): ChatState {
  // The snapshot's session is the current one: a divider among the entries is an earlier clear.
  let state: ChatState = { ...entries.reduce<ChatState>(applyEvent, emptyChat), sessionId };
  // Each record's own cost, and the session's total the replayed turn counts from (not its own record's).
  const clears = state.items.flatMap(it => (it.kind === 'divider' && it.variant === 'cleared' && !it.undone && it.at ? [it.at] : []));
  const priced = turnCosts(records, clears, sessionId);
  const before = turn ? turnCosts(records.filter(r => r.turnId !== turn.turnId), clears, sessionId) : priced;
  state = { ...state, sessionCostUsd: before.sessionCostUsd, clearedSessionCostUsd: before.clearedSessionCostUsd };
  // With a replay, the entries are the turns before it, which have ended:
  // no background call of theirs is still running, whatever their last
  // word was (a Stop, a notification the history cut).
  if (turn) state = { ...state, items: settleBackground(state.items) };
  // A replay capped to its newest lines starts mid-turn: take it from there.
  if (turn && turn.events.length) {
    if (turn.events[0].seq > 1) {
      for (const ev of turn.head ?? []) state = applyEvent(state, ev);
      // The prompt's replay is before the cut: nothing left to skip.
      state = { ...state, replaySkip: null };
      if (box.running && !state.running) {
        state = { ...state, running: true, phase: 'thinking', activeTool: null, lastResult: null, liveTurn: box.liveInput === true, background: [] };
      }
    }
    state = { ...state, cursor: { turnId: turn.turnId, seq: turn.events[0].seq - 1 } };
  }
  for (const e of turn?.events ?? []) state = applyFrame(state, { turnId: turn!.turnId, seq: e.seq, event: e.event }).state;
  // Nothing runs on the box, so nothing will say a background call ended.
  if (box.running === false && !state.running) state = { ...state, items: settleBackground(state.items) };
  // The running turn's own calls: those the box's latest task list (in the
  // replay, or the cut's head) no longer names have ended.
  else if (state.running && turn) {
    const lists = [...(turn.head ?? []), ...turn.events.map(e => e.event)]
      .filter((ev): ev is AnyEvent => (ev as AnyEvent)?.type === 'system' && (ev as AnyEvent).subtype === 'background_tasks_changed' && Array.isArray((ev as AnyEvent).tasks));
    const latest = lists[lists.length - 1];
    if (latest) state = { ...state, items: settleBackground(state.items, new Set(latest.tasks.map((t: AnyEvent) => t?.task_id).filter((id: unknown): id is string => typeof id === 'string'))) };
  }
  if (!records.length) return state;
  // A compact turn's record names its summary, which a compacted divider carries.
  const users = state.items.flatMap<{ key: string; uuid?: string; turnId?: string }>(it => (it.kind === 'user' ? [it]
    : it.kind === 'divider' && it.variant === 'compacted' && it.promptUuid ? [{ key: it.key, uuid: it.promptUuid }] : []));
  const aligned = alignTurnCosts(users, priced.records);
  const costs = { ...aligned.costs };
  for (const [key, value] of Object.entries(state.costs)) {
    if (!(key in costs)) costs[key] = value;
  }
  return { ...state, costs, extraCostUsd: aligned.extraCostUsd, unplacedCosts: aligned.unplaced };
}

/**
 * A history load keeps the context ring's numbers. A box's history carries
 * each call's prompt size (agent/chat-runner.js promptUsage), so a reopened
 * chat fills the ring again, but not the context window a result reported
 * or the plan's windows; an older box's history carries none of it, and no
 * replay carries a seat's monthly spend. So the
 * snapshot keeps what this chat had: in this view (`prev`, a reload of the
 * same chat) or when it was last open in this tab (`remembered`). Plan
 * windows merge by type, as live events do (withRateLimit): a replay that
 * carries one window does not drop the others.
 */
export function withKeptUsage(prev: ChatState, next: ChatState, remembered: ChatUsage | null = null): ChatState {
  const kept = prev.usage ?? remembered;
  if (!kept) return next;
  const got = next.usage;
  if (!got) return { ...next, usage: kept };
  return {
    ...next,
    usage: {
      ...got,
      contextWindow: got.contextWindow ?? (got.model === kept.model ? kept.contextWindow : null),
      // Merged by type; the live-only spend's reset follows the merged overage window (withSpendReset).
      limits: withSpendReset({ ...kept.limits, ...got.limits }),
    },
  };
}

// The ring's numbers for each chat opened in this tab, so going back to one
// shows them at once instead of waiting for its next reply.
const usageByChat = new Map<string, ChatUsage>();
export function rememberUsage(chatId: string, usage: ChatUsage | undefined): void {
  if (usage) usageByChat.set(chatId, usage);
}
export function rememberedUsage(chatId: string): ChatUsage | null {
  return usageByChat.get(chatId) ?? null;
}

/**
 * A path inside a chat's checkout, relative to it: termag keeps projects at
 * …/termag/projects/<name>/ and workstreams under its .worktrees/<name>/.
 */
export function shortPath(p: string): string {
  const m = /\/termag\/projects\/[^/]+\/(?:\.worktrees\/[^/]+\/)?(.+)$/.exec(p);
  return m ? m[1] : p;
}

/** "Bash" + "npm test": a tool call's name and its main argument, for a card or the status line. */
export function toolSummary(name: string, input: unknown): { title: string; detail: string | null } {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const file = (v: unknown) => { const p = str(v); return p ? shortPath(p) : null; };
  switch (name) {
    case 'Bash': return { title: 'Bash', detail: str(i.command) };
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return { title: name, detail: file(i.file_path) ?? file(i.notebook_path) };
    case 'Grep': case 'Glob': return { title: name, detail: str(i.pattern) };
    case 'WebFetch': return { title: name, detail: str(i.url) };
    case 'WebSearch': return { title: name, detail: str(i.query) };
    case 'Task': case 'Agent': return { title: name, detail: str(i.description) };
    case 'TodoWrite': return { title: 'Todos', detail: Array.isArray(i.todos) ? `${i.todos.length} items` : null };
    case 'Skill': return { title: 'Skill', detail: str(i.skill)?.replace(/^\//, '') ?? null };
    default: {
      const first = Object.values(i).map(str).find(Boolean) ?? null;
      return { title: name, detail: first };
    }
  }
}

export interface ChatStatusLine { tone: 'idle' | 'working' | 'error'; text: string }

/**
 * Whether a message sent now goes into the running turn: a live turn, and a
 * viewer whose sends are live (`sendsLive` from the history: their flag, the
 * box's agent). Otherwise it waits for the turn to end.
 */
export function sendGoesLive(state: ChatState, sendsLive: boolean): boolean {
  return state.running && state.liveTurn === true && sendsLive;
}

/**
 * Which Stop the composer offers. `plain`: one Stop that ends the turn and
 * its background tasks (a turn that is not live, or an agent without
 * chat-interrupt-v1). `split`: Stop ends only Claude's current work, and
 * Stop everything is in its menu. `background`: Claude has answered and the
 * turn only waits on background work, which a turn-only stop would not end.
 */
export type StopControl = 'plain' | 'split' | 'background';

export function stopControl(state: ChatState, stopsTurn: boolean): StopControl {
  if (!stopsTurn || state.liveTurn !== true) return 'plain';
  return state.phase === 'waiting' ? 'background' : 'split';
}

const tasksPhrase = (n: number, noun: string) => (n === 1 ? `the background ${noun}` : `the ${n} background ${noun}s`);

/** The Stop button's tooltip: what a stop ends. */
export function stopTitle(background: number | readonly BackgroundTask[], control: StopControl = 'plain'): string {
  const tasks = typeof background === 'number' ? background : background.length;
  const subagents = typeof background === 'number' ? 0 : background.filter(t => t.subagent).length;
  if (control === 'split') {
    return subagents
      ? `Stop what Claude is doing now. Background commands keep running; ${tasksPhrase(subagents, 'subagent')} ${subagents === 1 ? 'ends' : 'end'} (Esc)`
      : 'Stop what Claude is doing now. Background commands keep running (Esc)';
  }
  if (control === 'background') return tasks ? `Stop ${tasksPhrase(tasks, 'task')} and end the turn (Esc)` : 'End the turn (Esc)';
  if (!tasks) return 'Stop Claude (Esc)';
  return `Stop Claude and ${tasksPhrase(tasks, 'task')} it started (Esc)`;
}

/** One way to stop, as the chrome refresh's Stop menu offers it. */
export interface StopChoice { scope: 'turn' | 'all'; label: string; hint: string }

/** What a stop also ends, by Claude's own descriptions of the tasks where it gave them: "Also ends: Run the tests, Build". */
const ending = (lead: string, tasks: readonly BackgroundTask[]) => {
  const names = tasks.map(t => t.description.trim());
  if (!names.length || names.some(n => !n)) return `${lead} ${tasksPhrase(tasks.length, 'task')}`;
  return `${lead}: ${names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`}`;
};

/**
 * The chrome refresh's Stop menu (pages/chat/ComposerStop.tsx). Empty when a
 * click should just stop: nothing runs in the background that a stop would
 * either keep or end (a subagent ends with any stop). Otherwise each stop the
 * turn allows: Claude alone, where it can stop on its own (`split`), and
 * Claude with its background commands.
 */
export function stopChoices(background: readonly BackgroundTask[], control: StopControl): StopChoice[] {
  const commands = background.filter(t => !t.subagent);
  if (!commands.length) return [];
  const subagents = background.length - commands.length;
  const all: StopChoice = control === 'background'
    ? { scope: 'all', label: 'Stop background tasks', hint: ending('Claude has answered. Ends', background) }
    : { scope: 'all', label: 'Stop Claude and background tasks', hint: ending('Also ends', background) };
  if (control !== 'split') return [all];
  const keeps = commands.length === 1 ? 'Its background task keeps running' : `Its ${commands.length} background tasks keep running`;
  const ends = subagents ? `; ${tasksPhrase(subagents, 'subagent')} ${subagents === 1 ? 'ends' : 'end'}` : '';
  return [{ scope: 'turn', label: 'Stop Claude', hint: `${keeps}${ends}` }, all];
}

/** The history's word that the running turn is live, for a log whose turn-start does not say. */
export function seedLiveTurn(state: ChatState, liveInput: boolean | undefined): ChatState {
  return state.running && liveInput === true && !state.liveTurn ? { ...state, liveTurn: true } : state;
}

/** The "Stopped by you" note, not an informational one (a read-only turn's). */
export function isStopNote(it: ChatItem | undefined): boolean {
  return it?.kind === 'note' && it.info !== true;
}

/**
 * The line under a chat whose session the desktop app's thread is working on:
 * the session's status
 * comes from that thread's hooks (source `t3:…`), not from this chat's runner,
 * so the chat itself looks done. Null otherwise.
 */
export function desktopTurnStatus(status: { status?: string; source?: string | null } | undefined): ChatStatusLine | null {
  if (!status || typeof status.source !== 'string' || !status.source.startsWith('t3:')) return null;
  if (status.status === 'working') return { tone: 'working', text: 'Working in the desktop app' };
  // Waiting on an approval or an answer there: still the desktop's turn, and a send here is refused.
  if (status.status === 'waiting') return { tone: 'working', text: 'Waiting for you in the desktop app' };
  return null;
}

/**
 * A step of a turn the desktop app's thread runs on this chat's session: that
 * thread's hook post (a prompt, a tool), keyed by when it came, and one step
 * for its rest after. The turn writes the session file, not this chat's runner,
 * so no chat frame carries it; each step is a reason to read the history
 * again. At rest it stays one step: a status push that changes only its
 * metadata reads nothing. Null for anything else.
 */
export function desktopTurnStep(status: { status?: string; source?: string | null; updatedAt?: string } | undefined): string | null {
  if (!status || typeof status.source !== 'string' || !status.source.startsWith('t3:')) return null;
  if (status.status !== 'working' && status.status !== 'waiting') return 'rest';
  return `${status.status}|${status.updatedAt ?? ''}`;
}

/**
 * Whether a desktop turn's step reads the history again: a new step for the
 * chat already on screen. The step a chat opens with is what its first load
 * already read, so a switch or an open never reads twice.
 */
export function desktopStepReloads(shown: { chatId: string; step: string | null } | null, chatId: string, step: string | null): boolean {
  if (step === null) return false;
  return shown !== null && shown.chatId === chatId && shown.step !== step;
}

/** The single line under the chat saying what Claude is doing now. */
export function chatStatus(state: ChatState, sendsLive = false): ChatStatusLine {
  if (!state.running) {
    const last = state.items[state.items.length - 1];
    if (last?.kind === 'error') return { tone: 'error', text: 'Failed · your turn' };
    if (isStopNote(last)) return { tone: 'idle', text: 'Stopped · your turn' };
    if (last?.kind === 'divider') {
      const text = last.variant === 'compacted' ? 'Context compacted · your turn' : last.undone ? 'Previous context resumed · your turn' : 'Context cleared · your turn';
      return { tone: 'idle', text };
    }
    // Sent, and its turn not started yet: not the last turn's "Done".
    if (last?.kind === 'user' && last.pending) return { tone: 'working', text: 'Sending…' };
    return { tone: 'idle', text: state.items.length ? 'Done · your turn' : 'Say what you want to do' };
  }
  if (state.phase === 'tool' && state.activeTool) {
    const { title, detail } = toolSummary(state.activeTool.name, state.activeTool.input);
    return { tone: 'working', text: detail ? `Running ${title} · ${detail.length > 70 ? `${detail.slice(0, 69)}…` : detail}` : `Running ${title}` };
  }
  if (state.phase === 'writing') return { tone: 'working', text: 'Writing…' };
  if (state.phase === 'compacting') return { tone: 'working', text: 'Compacting the conversation…' };
  if (state.phase === 'waiting') {
    // Claude has answered and only its background tasks run: idle, as the
    // session's status says (backend statusForChatEvent), with what is left.
    const n = state.background?.length ?? 0;
    // Subagents alone are agents; with a command among them, tasks.
    const agents = n > 0 && state.background!.every(t => t.subagent);
    const tasks = n === 0 ? 'background work' : agents ? (n === 1 ? '1 agent' : `${n} agents`) : n === 1 ? '1 background task' : `${n} background tasks`;
    return sendGoesLive(state, sendsLive)
      ? { tone: 'idle', text: `Your turn · ${tasks} ${n === 0 ? 'still running' : 'running'}` }
      : { tone: 'idle', text: `Waiting on ${tasks} · a message waits until ${n > 1 ? 'they end' : 'it ends'}` };
  }
  if (state.woken) return { tone: 'working', text: 'Working · background task finished' };
  return { tone: 'working', text: 'Thinking…' };
}

/** The message Retry sends again: the last prompt, when the chat ended on an error. */
export function retryText(state: ChatState): string | null {
  if (state.running || state.items[state.items.length - 1]?.kind !== 'error') return null;
  for (let i = state.items.length - 1; i >= 0; i--) {
    const it = state.items[i];
    if (it.kind === 'user') return it.text;
  }
  return null;
}

/**
 * The message Retry sends again with its images: the ones this browser still
 * holds (a message sent from it in this page). Null when there is nothing to
 * send: no error to retry, or an image-only message whose images it lacks.
 */
export function retryMessage(state: ChatState): { text: string; images: Array<{ mediaType: string; data: string; src: string }> } | null {
  const text = retryText(state);
  if (text == null) return null;
  const last = [...state.items].reverse().find(it => it.kind === 'user') as Extract<ChatItem, { kind: 'user' }>;
  const images = (last.images ?? []).flatMap(i => {
    const m = i.src ? /^data:([^;,]+);base64,(.+)$/.exec(i.src) : null;
    return m ? [{ mediaType: m[1], data: m[2], src: i.src as string }] : [];
  });
  return text.trim() || images.length ? { text, images } : null;
}

/** Plain words for an API error that passes on its own, or null. */
export function errorHint(text: string): string | null {
  if (/\b529\b|overloaded/i.test(text)) return 'Claude is overloaded right now. Try again in a minute.';
  if (/\b429\b|rate.?limit/i.test(text)) return 'Claude is rate-limited right now. Try again in a minute.';
  return null;
}

const PREVIEW_MAX = 120;

/** The last thing Claude wrote, as one plain line for the sidebar; null before it has written. */
export function lastAssistantText(items: readonly ChatItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'text') continue;
    const line = it.text.split('\n').map(l => l.replace(/^[#>*\-\s`]+/, '').replace(/[*_`]/g, '').trim()).find(Boolean);
    if (line) return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX - 1)}…` : line;
  }
  return null;
}

export type HistoryLoad = 'loading' | 'ok' | 'setup' | 'error';

/**
 * Where an SDK chat is on its way up. The runner is ready once the project
 * is set up, the box answered with the chat's history, and a repo chat's
 * checkout is there (a box that clones in the pane reports setup done before
 * its checkout finishes). Until then the history is asked again, and the
 * setup steps show; they also show while a first message waits to be sent.
 *
 * The first answer is still out on every open and every switch, which is
 * not setup by itself: the steps show then only when something says the
 * chat really is coming up (the project is held for its box or clone, a
 * message waits, or `comingUp`: its box is launching or starting). An
 * existing chat whose history is on its way is `loading`, a placeholder
 * shaped like the transcript, not "Starting Claude". Should the answer
 * turn out to be setup, the steps take over then.
 */
export function sdkReadiness(i: { held: boolean; history: HistoryLoad; checkoutReady: boolean; queued: boolean; comingUp?: boolean }): {
  runnerReady: boolean; pollHistory: boolean; showSteps: boolean; loading: boolean;
} {
  const runnerReady = !i.held && i.history === 'ok' && i.checkoutReady;
  const pollHistory = !i.held && (i.history === 'setup' || (i.history === 'ok' && !i.checkoutReady));
  const showSteps = i.held || i.queued || i.history === 'setup' || (i.history === 'ok' && !i.checkoutReady)
    || (i.history === 'loading' && i.comingUp === true);
  const loading = !showSteps && i.history === 'loading';
  return { runnerReady, pollHistory, showSteps, loading };
}

/**
 * The chat from a history snapshot plus the live events that arrived while
 * it loaded. The snapshot alone would drop those events and, if a turn ended
 * in the meantime, bring back its stale `running`. Replayed on top, they win;
 * an assistant block the snapshot already has is skipped (with the stream of
 * a message it holds, whose deltas would repeat final text), and a turn-start
 * whose prompt is the snapshot's last one marks the turn running without a
 * second bubble.
 */
/**
 * Where the running turn starts in a snapshot with no replay of it, at the
 * latest: everything before is from turns that ended. A turn's prompt is a
 * user line no other turn took in (not `midTurn`), but a message a live
 * turn took in while it only waited is a plain user line too, so the last
 * one cannot be told from a prompt. The finished turns' records can: the
 * running turn's prompt comes after the last finished turn's prompt, and the
 * first turn-starting line after that is at or before it. With no record
 * to go by, 0: leave a card running rather than end one that still runs.
 */
function runningTurnStart(items: readonly ChatItem[], records: ReadonlyArray<TurnRecord>): number {
  const finished = new Set(records.map(r => r.userUuid).filter((u): u is string => typeof u === 'string'));
  let last = -1;
  items.forEach((it, i) => { if (it.kind === 'user' && it.uuid && finished.has(it.uuid)) last = i; });
  if (last < 0) return 0;
  const next = items.findIndex((it, i) => i > last && it.kind === 'user' && !it.midTurn);
  return next < 0 ? last : next;
}

export function mergeHistory(
  snapshot: { entries: unknown[]; sessionId: string | null; running: boolean; turns?: readonly TurnRecord[]; waiting?: unknown },
  live: readonly unknown[],
): ChatState {
  const fromEntries = fromHistory(snapshot.entries, snapshot.sessionId, null, snapshot.turns ?? []);
  // The last prompt, which a turn-start may be the replay of: a message taken in mid-turn never is.
  const lastUser = [...fromEntries.items].reverse().find(it => it.kind === 'user' && !it.midTurn);
  // An older agent's snapshot holds the running turn too, from its prompt on:
  // only that turn's background calls can still run.
  const cut = snapshot.running ? runningTurnStart(fromEntries.items, snapshot.turns ?? []) : fromEntries.items.length;
  const base = cut > 0 ? { ...fromEntries, items: [...settleBackground(fromEntries.items.slice(0, cut)), ...fromEntries.items.slice(cut)] } : fromEntries;
  // Queued bubbles before the live events: a turn-start among them takes its own.
  let state: ChatState = withWaiting(snapshot.running ? { ...base, running: true, phase: 'thinking' } : base, snapshot.waiting);
  // Assistant blocks the snapshot already holds, by message id and content.
  const sig = (e: AnyEvent) => `${e.message?.id ?? ''}|${JSON.stringify(e.message?.content ?? null)}`;
  const assistants = (snapshot.entries as AnyEvent[]).filter(e => e?.type === 'assistant');
  const seen = new Set(assistants.map(sig));
  // A message the snapshot has: its stream would append to text already final.
  const seenIds = new Set(assistants.map(e => e.message?.id).filter(Boolean));
  let skipStream = false;
  // A turn-start whose text matches an already-answered prompt is a new turn.
  // Its cost must not land on that older bubble.
  let repeatTurn = false;
  for (const ev of live) {
    const e = ev as AnyEvent | null;
    if (e?.type === 'stream_event' && e.event?.type === 'message_start') skipStream = seenIds.has(e.event.message?.id);
    if (e?.type === 'stream_event' && skipStream) continue;
    if (e?.type === 'assistant' && seen.has(sig(e))) continue;
    const startKey = e?.type === 'turn-start' ? messageKey(typeof e.text === 'string' ? e.text : '', refImages(e.images)) : null;
    if (startKey != null && lastUser?.kind === 'user' && startKey === messageKey(lastUser.text, lastUser.images)) {
      // The prompt still unanswered in the snapshot is this turn's, so its replay is too; an answered one may be a repeat ("yes"), whose replay is its only bubble.
      const unanswered = base.items[base.items.length - 1] === lastUser;
      repeatTurn = !unanswered;
      state = {
        ...state, running: true, phase: 'thinking', activeTool: null, lastResult: null, liveTurn: e?.live === true, turnHeadings: e?.headings === true, compacting: false,
        // Only the unanswered prompt is this turn. Pointing a repeat at it would replace that reply's cost.
        turnUserKey: unanswered ? lastUser.key : null,
        replaySkip: unanswered ? startKey : null,
      };
      continue;
    }
    // The replay of a repeated prompt is the new turn's bubble. Pin the cost there, not on the older one.
    if (repeatTurn && e?.type === 'user' && e.isReplay === true && state.turnUserKey == null) {
      const before = state.items.filter(it => it.kind === 'user').length;
      state = applyEvent(state, ev);
      const users = state.items.filter(it => it.kind === 'user');
      if (users.length > before) state = { ...state, turnUserKey: users[users.length - 1].key };
      continue;
    }
    if (e?.type === 'turn-end' && !state.turnUserKey && lastUser?.kind === 'user' && !repeatTurn) {
      if (!(lastUser.key in state.costs)) {
        state = { ...state, turnUserKey: lastUser.key };
      } else {
        // The snapshot already priced this prompt. Settle the turn without writing over that footnote.
        state = applyEvent({ ...state, lastResult: null }, { ...e, costUsd: null, durationMs: null });
        continue;
      }
    }
    state = applyEvent(state, ev);
  }
  // Nothing runs on the box, so nothing will say a background call ended.
  return state.running ? state : { ...state, items: settleBackground(state.items) };
}

export type ContextAction = 'clear' | 'compact' | 'resume';

export interface ActionState { enabled: boolean; reason: string | null }

/**
 * What the context popover's actions say now (agent chat-context-v1): hidden
 * (null), or Clear and Compact each enabled or disabled with why (null when
 * this chat can never do it: hidden, not disabled), and whether Resume
 * previous context is on offer (it is hidden otherwise). `offered` is the history's
 * contextActions (backend services/chatRunner.ts chatContextActions):
 * `update` is a box whose runner predates chat-context-v1. `refusals` is what
 * this chat can never do (chatContextRefusals: another engine or backend).
 * Resume is there from a clear until the first message after it: once that
 * turn has started a new session, the two would have to be merged. Compact
 * has no threshold: with a session and Claude idle it is always allowed (the
 * person's call), so it is disabled only where it cannot run at all.
 */
export function contextActions(i: {
  offered: 'ready' | 'update' | null | undefined;
  refusals?: Partial<Record<ContextAction, string>>;
  runnerReady: boolean;
  running: boolean;
  held: boolean;
  sessionId: string | null;
  items: readonly ChatItem[];
}): { clear: ActionState | null; compact: ActionState | null; resume: boolean } | null {
  if (!i.offered) return null;
  const off = (reason: string): ActionState => ({ enabled: false, reason });
  if (i.offered === 'update') {
    const why = off("This box's agent needs an update before it can do this.");
    return { clear: why, compact: why, resume: false };
  }
  const busy = !i.runnerReady ? 'Claude is still starting.'
    : i.running ? 'Wait for Claude to finish, or stop it, first.'
    : i.held ? 'Claude is open in Lab. Return it to this chat first.'
    : null;
  let lastDivider = -1;
  i.items.forEach((it, k) => { if (it.kind === 'divider') lastDivider = k; });
  const divider = lastDivider >= 0 ? i.items[lastDivider] as Extract<ChatItem, { kind: 'divider' }> : null;
  const sinceDivider = i.items.slice(lastDivider + 1);
  const resume = !busy && !i.sessionId && !i.refusals?.resume && divider?.variant === 'cleared' && !divider.undone && !sinceDivider.some(it => it.kind === 'user');
  // What this chat can never do (another engine or backend) is hidden (null), not disabled.
  const clear: ActionState | null = i.refusals?.clear ? null
    : busy ? off(busy)
    : !i.sessionId ? off(divider?.variant === 'cleared' && !divider.undone ? 'Context is already clear.' : 'Nothing to clear yet.')
    : { enabled: true, reason: null };
  const compact: ActionState | null = i.refusals?.compact ? null
    : busy ? off(busy)
    : !i.sessionId ? off('Nothing to compact yet.')
    : { enabled: true, reason: null };
  return { clear, compact, resume };
}
