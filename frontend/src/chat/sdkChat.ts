// The simple UI's SDK chat, as data: one reducer over Claude Code's
// stream-json events (live, through the chat runner) and its transcript
// entries (history, same shapes), producing the items the chat renders —
// user bubbles, assistant text (streamed), tool cards with their results —
// and the one status line. Unknown events are ignored, never fatal.

export type ChatItem =
  | { kind: 'user'; key: string; text: string; pending?: boolean }
  | { kind: 'text'; key: string; text: string; streaming: boolean }
  | {
    kind: 'tool'; key: string; id: string; name: string; input: unknown;
    inputJson: string; result: string | null; isError: boolean; done: boolean;
  }
  | { kind: 'error'; key: string; text: string };

export type ChatPhase = 'idle' | 'thinking' | 'writing' | 'tool';

export interface ChatState {
  items: ChatItem[];
  sessionId: string | null;
  running: boolean;
  phase: ChatPhase;
  /** The tool call running now, for the status line. */
  activeTool: { name: string; input: unknown } | null;
  costUsd: number | null;
  /** The assistant message being streamed: its id and which item each content index fills. */
  stream: { messageId: string | null; byIndex: Record<number, string>; textStarted: number };
  /** Per assistant message, how many final text blocks have arrived (their keys). */
  textFinal: Record<string, number>;
  seq: number;
  /** The last turn event folded in, by its turn and line: replays and resent frames are skipped. */
  cursor: FrameCursor;
}

export interface FrameCursor { turnId: string | null; seq: number }

export const emptyChat: ChatState = {
  items: [], sessionId: null, running: false, phase: 'idle', activeTool: null, costUsd: null,
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

/** A user message's prompt text, or null when it carries only tool results. */
function promptText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text as string);
  return texts.length ? texts.join('\n') : null;
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
export function addPending(state: ChatState, text: string): ChatState {
  const seq = state.seq + 1;
  return { ...state, seq, items: [...state.items, { kind: 'user', key: `pending:${seq}`, text, pending: true }] };
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
    if (block?.type === 'text' && typeof block.text === 'string') {
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
  if (prompt != null) {
    const last = items[items.length - 1];
    // The live turn already showed it (turn-start); a transcript replays it.
    if (!(last?.kind === 'user' && last.text === prompt)) {
      const key = typeof ev.uuid === 'string' ? `user:${ev.uuid}` : `user:${state.seq + 1}`;
      items = [...items, { kind: 'user', key, text: prompt }];
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
      const i = state.items.findIndex(it => it.kind === 'user' && it.pending && it.text === text);
      let items: ChatItem[];
      if (i >= 0) {
        items = state.items.slice();
        items[i] = { ...(items[i] as Extract<ChatItem, { kind: 'user' }>), pending: false };
      } else {
        items = [...state.items, { kind: 'user', key: `turn:${state.seq + 1}`, text }];
      }
      return { ...state, items, running: true, phase: 'thinking', activeTool: null, seq: state.seq + 1 };
    }
    case 'system':
      return e.subtype === 'init' && typeof e.session_id === 'string' ? { ...state, sessionId: e.session_id } : state;
    case 'stream_event':
      return streamEvent(state, e);
    case 'assistant':
      return assistantEvent(state, e);
    case 'user':
      return userEvent(state, e);
    case 'result': {
      const costUsd = typeof e.total_cost_usd === 'number' ? (state.costUsd ?? 0) + e.total_cost_usd : state.costUsd;
      const failed = e.is_error === true && e.subtype !== 'success';
      const items = failed
        ? [...state.items, { kind: 'error' as const, key: `error:${state.seq + 1}`, text: typeof e.result === 'string' && e.result ? e.result : `Claude stopped (${e.subtype ?? 'error'})` }]
        : state.items;
      return { ...state, items, costUsd, seq: state.seq + 1 };
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
        running: false, phase: 'idle', activeTool: null, seq: state.seq + 1,
      };
    case 'turn-end': {
      // Nothing streams once the turn is over; a tool still open was cut off.
      const items = state.items.map(it => (it.kind === 'text' && it.streaming ? { ...it, streaming: false }
        : it.kind === 'tool' && !it.done ? { ...it, done: true } : it));
      return { ...state, items, running: false, phase: 'idle', activeTool: null, stream: { messageId: null, byIndex: {}, textStarted: 0 } };
    }
    default:
      return state;
  }
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
  const next = applyEvent(state, frame.event);
  return { state: frame.seq != null && turnId != null ? { ...next, cursor: { turnId, seq: frame.seq } } : next, gap: false };
}

/** The chat from its transcript entries, then the turn still running replayed from its log. */
export function fromHistory(
  entries: unknown[],
  sessionId: string | null = null,
  turn: { turnId: string; events: Array<{ seq: number; event: unknown }> } | null = null,
): ChatState {
  let state = entries.reduce<ChatState>(applyEvent, { ...emptyChat, sessionId });
  // A replay capped to its newest lines starts mid-turn: take it from there.
  if (turn && turn.events.length) state = { ...state, cursor: { turnId: turn.turnId, seq: turn.events[0].seq - 1 } };
  for (const e of turn?.events ?? []) state = applyFrame(state, { turnId: turn!.turnId, seq: e.seq, event: e.event }).state;
  return state;
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
    default: {
      const first = Object.values(i).map(str).find(Boolean) ?? null;
      return { title: name, detail: first };
    }
  }
}

export interface ChatStatusLine { tone: 'idle' | 'working' | 'error'; text: string }

/** The single line under the chat saying what Claude is doing now. */
export function chatStatus(state: ChatState): ChatStatusLine {
  if (!state.running) {
    const last = state.items[state.items.length - 1];
    if (last?.kind === 'error') return { tone: 'error', text: 'Stopped · your turn' };
    return { tone: 'idle', text: state.items.length ? 'Done · your turn' : 'Say what you want to do' };
  }
  if (state.phase === 'tool' && state.activeTool) {
    const { title, detail } = toolSummary(state.activeTool.name, state.activeTool.input);
    return { tone: 'working', text: detail ? `Running ${title} · ${detail.length > 70 ? `${detail.slice(0, 69)}…` : detail}` : `Running ${title}` };
  }
  if (state.phase === 'writing') return { tone: 'working', text: 'Writing…' };
  return { tone: 'working', text: 'Thinking…' };
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
  snapshot: { entries: unknown[]; sessionId: string | null; running: boolean },
  live: readonly unknown[],
): ChatState {
  const base = fromHistory(snapshot.entries, snapshot.sessionId);
  let state: ChatState = snapshot.running ? { ...base, running: true, phase: 'thinking' } : base;
  const lastUser = [...base.items].reverse().find(it => it.kind === 'user');
  // Assistant blocks the snapshot already holds, by message id and content.
  const sig = (e: AnyEvent) => `${e.message?.id ?? ''}|${JSON.stringify(e.message?.content ?? null)}`;
  const assistants = (snapshot.entries as AnyEvent[]).filter(e => e?.type === 'assistant');
  const seen = new Set(assistants.map(sig));
  // A message the snapshot has: its stream would append to text already final.
  const seenIds = new Set(assistants.map(e => e.message?.id).filter(Boolean));
  let skipStream = false;
  for (const ev of live) {
    const e = ev as AnyEvent | null;
    if (e?.type === 'stream_event' && e.event?.type === 'message_start') skipStream = seenIds.has(e.event.message?.id);
    if (e?.type === 'stream_event' && skipStream) continue;
    if (e?.type === 'assistant' && seen.has(sig(e))) continue;
    if (e?.type === 'turn-start' && lastUser?.kind === 'user' && e.text === lastUser.text) {
      state = { ...state, running: true, phase: 'thinking', activeTool: null };
      continue;
    }
    state = applyEvent(state, ev);
  }
  return state;
}
