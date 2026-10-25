// The simple UI's SDK chat, as data: one reducer over Claude Code's
// stream-json events (live, through the chat runner) and its transcript
// entries (history, same shapes), producing the items the chat renders —
// user bubbles, assistant text (streamed), tool cards with their results —
// and the one status line. Unknown events are ignored, never fatal.

/**
 * An image in a user message: `src` while it is only in this browser (a data
 * URL), `path` once the box keeps it (read through GET /api/projects/:id/image).
 */
export interface ChatImage { mediaType: string; src?: string; path?: string }

export type ChatItem =
  | { kind: 'user'; key: string; text: string; pending?: boolean; uuid?: string; turnId?: string; images?: ChatImage[] }
  | { kind: 'text'; key: string; text: string; streaming: boolean }
  | {
    kind: 'tool'; key: string; id: string; name: string; input: unknown;
    inputJson: string; result: string | null; isError: boolean; done: boolean;
    /** A Skill call's instructions (its SKILL.md), which Claude Code adds as a synthetic user message. */
    skill?: string;
  }
  /** A skill's instructions loaded without a Skill call (a typed slash command). */
  | { kind: 'skill'; key: string; name: string; text: string }
  | { kind: 'error'; key: string; text: string }
  /** Something the user did, said in neutral words: "Stopped by you". */
  | { kind: 'note'; key: string; text: string }
  /**
   * A slash command Claude Code ran itself (a mod's `/reload-plugins`), never
   * the model's: one line, "Ran /reload-plugins: not available over a remote connection".
   */
  | { kind: 'command'; key: string; name: string; args: string; output: string | null; folded: string[] };

/** `waiting`: Claude answered, and its turn stays open on a background task; a message sent now goes into it only on a live turn. */
export type ChatPhase = 'idle' | 'thinking' | 'writing' | 'tool' | 'waiting';

/** What one turn cost and how long it took (the runner's turn record, agent/chat-runner.js). */
export interface TurnCost { costUsd: number | null; durationMs: number | null }

/** A turn record as chat-history returns it. `userUuid` is the transcript entry this turn wrote. */
export interface TurnRecord extends TurnCost {
  turnId: string; prompt: string; at?: string | null; isError?: boolean; userUuid?: string | null;
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
  /** The prompt of the turn running now, and the cost its result reported (an agent without turn-end costs). */
  turnUserKey: string | null;
  lastResult: TurnCost | null;
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
  /** This view, or another, stopped only the running turn's current work (`user-stop` scope `turn`): its result says so. */
  stopTurnOnly?: boolean;
  /** The running turn's background tasks (Claude's `background_tasks_changed`). Stop everything ends them; a turn-only stop ends only the subagents. */
  background?: BackgroundTask[];
}

export interface BackgroundTask { description: string; subagent: boolean }

export interface FrameCursor { turnId: string | null; seq: number }

export const emptyChat: ChatState = {
  items: [], sessionId: null, running: false, phase: 'idle', activeTool: null,
  costs: {}, extraCostUsd: 0, turnUserKey: null, lastResult: null,
  stream: { messageId: null, byIndex: {}, textStarted: 0 }, textFinal: {}, seq: 0,
  cursor: { turnId: null, seq: 0 },
};

type AnyEvent = Record<string, any>;
const MAX_RESULT = 20_000;

/** Tool output as text: a string, or the text parts of a content array. */
export function resultText(content: unknown): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.map(part => (part && typeof part === 'object' && typeof part.text === 'string'
      ? part.text
      : part?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
  }
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n… (${text.length - MAX_RESULT} more characters)` : text;
}

/** A user message's prompt text ('' for images alone), or null when it carries only tool results. */
function promptText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text as string);
  if (texts.length) return texts.join('\n');
  return content.some(p => p?.type === 'image') ? '' : null;
}

/** A user message's own images (not a tool result's): the box's stored copies, or inline data. */
export function promptImages(content: unknown): ChatImage[] {
  if (!Array.isArray(content)) return [];
  const out: ChatImage[] = [];
  for (const p of content) {
    const src = p?.type === 'image' ? p.source : null;
    if (!src || typeof src !== 'object') continue;
    const mediaType = typeof src.media_type === 'string' ? src.media_type : 'image/png';
    if (src.type === 'termag' && typeof src.path === 'string') out.push({ mediaType, path: src.path });
    else if (src.type === 'base64' && typeof src.data === 'string') out.push({ mediaType, src: `data:${mediaType};base64,${src.data}` });
    else out.push({ mediaType });
  }
  return out;
}

/** turn-start's `images` (agent chat-images-v1): the references the box kept. */
function refImages(raw: unknown): ChatImage[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(r => r && typeof r.path === 'string')
    .map(r => ({ mediaType: typeof r.mediaType === 'string' ? r.mediaType : 'image/png', path: r.path as string }));
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

function newTool(id: string, name: string, input: unknown): ChatItem {
  return { kind: 'tool', key: `tool:${id}`, id, name, input, inputJson: '', result: null, isError: false, done: false };
}

/** Show a message the user just sent, before its turn starts. */
export function addPending(state: ChatState, text: string, images: ChatImage[] = [], key?: string): ChatState {
  const seq = state.seq + 1;
  return { ...state, seq, items: [...state.items, { kind: 'user', key: key ?? `pending:${seq}`, text, pending: true, ...withImages(images) }] };
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
          items: upsert(state.items, key, () => newTool(block.id, block.name ?? 'tool', block.input ?? {}), it => it),
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
        const items = upsert(state.items, key, () => newTool(key.slice(5), 'tool', {}), it => {
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
      items = upsert(items, key, () => newTool(block.id, block.name ?? 'tool', block.input ?? {}),
        it => (it.kind === 'tool' ? { ...it, name: block.name ?? it.name, input: block.input ?? it.input } : it));
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
  let items = state.items;
  let phase = state.phase;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type !== 'tool_result' || typeof part.tool_use_id !== 'string') continue;
      items = setTool(items, part.tool_use_id, t => ({ ...t, result: resultText(part.content), isError: part.is_error === true, done: true }));
      if (state.running) phase = 'thinking';
    }
  }
  const prompt = promptText(content);
  if (prompt != null && INTERRUPT_MARK.test(prompt)) {
    // Claude took a turn-only stop: the result after it is the stop's, also
    // in a view that did not send it and in a reloaded history. A stop of
    // everything stays one: the turn ends with the process.
    const turnOnly = state.running && !(state.stopRequested && !state.stopTurnOnly);
    return { ...state, items, phase, stopTurnOnly: turnOnly || state.stopTurnOnly, seq: state.seq + 1 };
  }
  const images = promptImages(content);
  const command = prompt != null && !images.length ? localCommand(prompt) : null;
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
      return { ...state, items, phase: state.running ? 'thinking' : phase, activeTool: null, replaySkip: null, seq: state.seq + 1 };
    }
    const key = typeof ev.uuid === 'string' ? `user:${ev.uuid}` : `user:${state.seq + 1}`;
    // The same message the history already holds (a transcript line keeps the message's uuid).
    if (typeof ev.uuid === 'string' && items.some(it => it.kind === 'user' && it.key === key)) {
      return { ...state, items, phase: state.running ? 'thinking' : phase, activeTool: null, seq: state.seq + 1 };
    }
    const i = items.findIndex(it => it.kind === 'user' && it.pending && sameMessage(it, prompt, images.length));
    items = [...(i >= 0 ? [...items.slice(0, i), ...items.slice(i + 1)] : items), { kind: 'user', key, text: prompt, ...withImages(images) }];
    return { ...state, items, phase: state.running ? 'thinking' : phase, activeTool: null, seq: state.seq + 1 };
  } else if (prompt != null) {
    const last = items[items.length - 1];
    // The live turn already showed it (turn-start); a transcript replays it.
    if (!(last && sameMessage(last, prompt, images.length))) {
      const uuid = typeof ev.uuid === 'string' ? ev.uuid : undefined;
      const key = uuid ? `user:${uuid}` : `user:${state.seq + 1}`;
      items = [...items, { kind: 'user', key, text: prompt, uuid, ...withImages(images) }];
    }
  }
  return { ...state, items, phase, activeTool: phase === 'thinking' ? null : state.activeTool, seq: state.seq + 1 };
}

/** Fold one event (live or from the transcript) into the chat. */
export function applyEvent(state: ChatState, ev: unknown): ChatState {
  if (!ev || typeof ev !== 'object') return state;
  const e = ev as AnyEvent;
  switch (e.type) {
    case 'turn-start': {
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
      return { ...state, items, running: true, phase: 'thinking', activeTool: null, turnUserKey, lastResult: null, stopRequested: false, stopTurnOnly: false, replaySkip: messageKey(text, images), liveTurn: e.live === true, background: [], seq: state.seq + 1 };
    }
    case 'system':
      if (e.subtype === 'background_tasks_changed' && Array.isArray(e.tasks)) {
        const background: BackgroundTask[] = e.tasks.map((t: AnyEvent) => ({
          description: typeof t?.description === 'string' && t.description.trim() ? t.description.trim() : 'a background task',
          subagent: t?.task_type === 'local_agent',
        }));
        return { ...state, background };
      }
      return e.subtype === 'init' && typeof e.session_id === 'string' ? { ...state, sessionId: e.session_id } : state;
    case 'stream_event':
      return streamEvent(state, e);
    case 'assistant':
      return assistantEvent(state, e);
    case 'user':
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
        const settled: ChatItem[] = state.items.map(it => (it.kind === 'text' && it.streaming ? { ...it, streaming: false }
          : it.kind === 'tool' && !it.done ? { ...it, done: true } : it));
        if (settled[settled.length - 1]?.kind !== 'note') settled.push({ kind: 'note', key: `note:${state.seq + 1}`, text: 'Stopped by you' });
        return {
          ...state, items: settled, lastResult, phase: 'waiting', activeTool: null, stopRequested: false, stopTurnOnly: false,
          stream: { messageId: null, byIndex: {}, textStarted: 0 }, seq: state.seq + 1,
        };
      }
      // A live turn stays open after its answer while a background task runs.
      return { ...state, items, lastResult, phase: state.running ? 'waiting' : state.phase, activeTool: state.running ? null : state.activeTool, seq: state.seq + 1 };
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
    case 'runner-error':
      // The turn is over (a failed spawn may never send turn-end), so settle
      // like one: stop the spinner and let the composer send again.
      return {
        ...state,
        items: [...state.items, { kind: 'error', key: `error:${state.seq + 1}`, text: String(e.message ?? 'The chat runner failed') }],
        running: false, phase: 'idle', activeTool: null, liveTurn: false, background: [], seq: state.seq + 1,
      };
    case 'turn-end': {
      // Nothing streams once the turn is over; a tool still open was cut off.
      const items: ChatItem[] = state.items.map(it => (it.kind === 'text' && it.streaming ? { ...it, streaming: false }
        : it.kind === 'tool' && !it.done ? { ...it, done: true } : it));
      // Stopped here, or in another view (Claude exits on the SIGINT: signal or 130).
      const stopped = state.stopRequested || e.signal === 'SIGINT' || e.exitCode === 130;
      if (stopped && state.running && items[items.length - 1]?.kind !== 'note') {
        items.push({ kind: 'note', key: `note:${state.seq + 1}`, text: 'Stopped by you' });
      }
      // The runner's record of the turn; an agent without one leaves the result's numbers.
      const cost: TurnCost = {
        costUsd: typeof e.costUsd === 'number' ? e.costUsd : e.costUsd === null ? null : state.lastResult?.costUsd ?? null,
        durationMs: typeof e.durationMs === 'number' ? e.durationMs : state.lastResult?.durationMs ?? null,
      };
      const costs = state.turnUserKey ? { ...state.costs, [state.turnUserKey]: cost } : state.costs;
      const extraCostUsd = state.turnUserKey ? state.extraCostUsd : state.extraCostUsd + (cost.costUsd ?? 0);
      return {
        ...state, items, costs, extraCostUsd, running: false, phase: 'idle', activeTool: null,
        turnUserKey: null, lastResult: null, stopRequested: false, stopTurnOnly: false, liveTurn: false, background: [],
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
): { costs: Record<string, TurnCost>; extraCostUsd: number } {
  const costs: Record<string, TurnCost> = {};
  const used = new Set<number>();
  let extraCostUsd = 0;
  for (const r of records) {
    let j = r.turnId ? users.findIndex((u, i) => !used.has(i) && u.turnId === r.turnId) : -1;
    if (j < 0 && r.userUuid) j = users.findIndex((u, i) => !used.has(i) && u.uuid === r.userUuid);
    if (j >= 0) {
      costs[users[j].key] = { costUsd: r.costUsd, durationMs: r.durationMs };
      used.add(j);
    } else {
      extraCostUsd += r.costUsd ?? 0;
    }
  }
  return { costs, extraCostUsd };
}


/** What the whole chat has cost so far, or null before any turn reported a cost. */
export function chatCostTotal(state: Pick<ChatState, 'costs' | 'extraCostUsd'>): number | null {
  const known = Object.values(state.costs).map(c => c.costUsd).filter((c): c is number => c != null);
  if (known.length === 0 && state.extraCostUsd === 0) return null;
  return known.reduce((a, b) => a + b, 0) + state.extraCostUsd;
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
  | { kind: 'reply'; key: string; userKey: string | null; items: ChatItem[] };

/** The chat as prompts and the replies after them: what a reply's cost footnote hangs on. */
export function groupTurns(items: readonly ChatItem[]): ChatGroup[] {
  const groups: ChatGroup[] = [];
  let userKey: string | null = null;
  for (const item of items) {
    if (item.kind === 'user') {
      groups.push({ kind: 'user', item });
      userKey = item.key;
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
 */
export function fromHistory(
  entries: unknown[],
  sessionId: string | null = null,
  turn: { turnId: string; events: Array<{ seq: number; event: unknown }> } | null = null,
  records: ReadonlyArray<TurnRecord> = [],
): ChatState {
  let state = entries.reduce<ChatState>(applyEvent, { ...emptyChat, sessionId });
  // A replay capped to its newest lines starts mid-turn: take it from there.
  if (turn && turn.events.length) state = { ...state, cursor: { turnId: turn.turnId, seq: turn.events[0].seq - 1 } };
  for (const e of turn?.events ?? []) state = applyFrame(state, { turnId: turn!.turnId, seq: e.seq, event: e.event }).state;
  if (!records.length) return state;
  const users = state.items.filter((it): it is Extract<ChatItem, { kind: 'user' }> => it.kind === 'user');
  const aligned = alignTurnCosts(users, records);
  const costs = { ...aligned.costs };
  for (const [key, value] of Object.entries(state.costs)) {
    if (!(key in costs)) costs[key] = value;
  }
  return { ...state, costs, extraCostUsd: aligned.extraCostUsd };
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
    case 'Task': return { title: name, detail: str(i.description) };
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

/** The history's word that the running turn is live, for a log whose turn-start does not say. */
export function seedLiveTurn(state: ChatState, liveInput: boolean | undefined): ChatState {
  return state.running && liveInput === true && !state.liveTurn ? { ...state, liveTurn: true } : state;
}

/** The single line under the chat saying what Claude is doing now. */
export function chatStatus(state: ChatState, sendsLive = false): ChatStatusLine {
  if (!state.running) {
    const last = state.items[state.items.length - 1];
    if (last?.kind === 'error') return { tone: 'error', text: 'Failed · your turn' };
    if (last?.kind === 'note') return { tone: 'idle', text: 'Stopped · your turn' };
    return { tone: 'idle', text: state.items.length ? 'Done · your turn' : 'Say what you want to do' };
  }
  if (state.phase === 'tool' && state.activeTool) {
    const { title, detail } = toolSummary(state.activeTool.name, state.activeTool.input);
    return { tone: 'working', text: detail ? `Running ${title} · ${detail.length > 70 ? `${detail.slice(0, 69)}…` : detail}` : `Running ${title}` };
  }
  if (state.phase === 'writing') return { tone: 'working', text: 'Writing…' };
  if (state.phase === 'waiting') {
    return { tone: 'working', text: sendGoesLive(state, sendsLive) ? 'Waiting on background work · you can still send a message' : 'Waiting on background work · a message waits until it ends' };
  }
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
 */
export function sdkReadiness(i: { held: boolean; history: HistoryLoad; checkoutReady: boolean; queued: boolean }): {
  runnerReady: boolean; pollHistory: boolean; showSteps: boolean;
} {
  const runnerReady = !i.held && i.history === 'ok' && i.checkoutReady;
  const pollHistory = !i.held && (i.history === 'setup' || (i.history === 'ok' && !i.checkoutReady));
  const showSteps = i.held || (i.history !== 'error' && !runnerReady) || i.queued;
  return { runnerReady, pollHistory, showSteps };
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
export function mergeHistory(
  snapshot: { entries: unknown[]; sessionId: string | null; running: boolean; turns?: readonly TurnRecord[] },
  live: readonly unknown[],
): ChatState {
  const base = fromHistory(snapshot.entries, snapshot.sessionId, null, snapshot.turns ?? []);
  let state: ChatState = snapshot.running ? { ...base, running: true, phase: 'thinking' } : base;
  const lastUser = [...base.items].reverse().find(it => it.kind === 'user');
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
        ...state, running: true, phase: 'thinking', activeTool: null, lastResult: null, liveTurn: e?.live === true,
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
  return state;
}
