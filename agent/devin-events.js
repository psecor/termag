'use strict';
// A Devin chat turn's stream (devin-acp.js's stdout: its own `termag` lines and Devin's ACP session/update
// notifications) as the Claude stream-json subset the backend and the simple UI already read, so a turn on the
// devin engine (chat-engines.js, chat-devin-v1) looks like a Claude turn from the box on: system/init, assistant
// (text, thinking, tool_use), user/tool_result and result. Pure: chat-turn.js feeds it the turn's stdout line by
// line and writes what comes back to events.jsonl (and, since Devin's own session store is SQLite, to the
// runner-kept transcript the chat's history reads).
//
// ACP (v1) session updates, and what each becomes:
// - agent_thought_chunk, agent_message_chunk: text pieces, gathered into one thinking or text block per run and
//   sent when something else comes (a tool, a plan, the end), as Claude sends a whole message;
// - tool_call, tool_call_update: one tool by its toolCallId. Its tool_use goes once it is under way (in progress,
//   done, or asked about), with the input the updates had by then, its name Claude's for the ACP kind (read →
//   Read, execute → Bash, …; Devin's own name, `_meta["cognition.ai/inferenceToolName"]`, for any other); its
//   tool_result once it is completed or failed (failed is an error);
// - plan: a TodoWrite, Claude's own plan tool, with the plan's entries as its todos;
// - modes, commands, config, session info and usage: nothing.
// An update a Devin subagent sent (`_meta["cognition.ai/subagent_context"].parentAgentId` not "root", the way
// termag-desktop reads Devin) is left out: the chat shows delegated work as its one tool line.
// A refused permission is that tool's failed result. The turn ends on devin-acp's result line.

const { randomUUID } = require('crypto');

/** The most of a tool's output kept as its result's text, as the chat shows a long one cut. */
const RESULT_MAX = 16 * 1024;

/** Claude's tool names for ACP's tool kinds, so the chat draws them as it draws Claude's. */
const TOOL_NAMES = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Grep',
  execute: 'Bash',
  think: 'Think',
  fetch: 'WebFetch',
  switch_mode: 'SwitchMode',
};

function str(v) { return typeof v === 'string' ? v : undefined; }
function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

function cut(text) {
  return text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}\n… (cut)` : text;
}

/** Whether a Devin subagent sent this update (termag-desktop's normalizeDevinSessionUpdate reads the same key). */
function fromSubagent(update) {
  const parent = obj(obj(obj(update)._meta)['cognition.ai/subagent_context']).parentAgentId;
  return typeof parent === 'string' && parent !== 'root';
}

/** A tool's name: Claude's for its kind, else Devin's own, else its title. */
function nameOf(tool) {
  if (TOOL_NAMES[tool.kind]) return TOOL_NAMES[tool.kind];
  const devin = str(obj(tool.meta)['cognition.ai/inferenceToolName']);
  if (devin) return devin;
  return str(tool.title) && tool.title.length <= 60 ? tool.title : 'Tool';
}

/** The first file a tool names: its locations, else its input's path. */
function pathOf(tool) {
  const loc = Array.isArray(tool.locations) ? tool.locations.find(l => l && typeof l.path === 'string') : null;
  if (loc) return loc.path;
  const raw = obj(tool.rawInput);
  return str(raw.file_path) ?? str(raw.path) ?? str(raw.filePath) ?? str(raw.target_file) ?? '';
}

/** A tool call's input in the shape Claude's tool of that name takes; anything else as Devin gave it. */
function inputOf(tool) {
  const raw = obj(tool.rawInput);
  const command = Array.isArray(raw.command) ? raw.command.join(' ') : str(raw.command) ?? str(raw.cmd);
  switch (tool.kind) {
    case 'read': return { file_path: pathOf(tool) };
    case 'execute': return { command: command ?? str(tool.title) ?? '', ...(str(raw.description) && { description: raw.description }) };
    case 'search': {
      const pattern = str(raw.pattern) ?? str(raw.query) ?? str(raw.regex) ?? str(tool.title) ?? '';
      const at = str(raw.path) ?? str(raw.directory);
      return { pattern, ...(at && { path: at }) };
    }
    case 'edit': {
      const diff = (Array.isArray(tool.content) ? tool.content : []).find(c => c && c.type === 'diff');
      return {
        file_path: pathOf(tool) || (diff && str(diff.path)) || '',
        ...(diff && str(diff.oldText) !== undefined && { old_string: diff.oldText }),
        ...(diff && str(diff.newText) !== undefined && { new_string: diff.newText }),
      };
    }
    case 'delete':
    case 'move': return { path: pathOf(tool) };
    case 'fetch': return { url: str(raw.url) ?? str(tool.title) ?? '' };
    default: return Object.keys(raw).length ? { ...raw } : (str(tool.title) ? { description: tool.title } : {});
  }
}

/** What a finished tool returned, as Claude's tool_result text. */
function resultText(tool) {
  const parts = [];
  for (const c of Array.isArray(tool.content) ? tool.content : []) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'content' && c.content && c.content.type === 'text' && typeof c.content.text === 'string') parts.push(c.content.text);
    else if (c.type === 'diff' && typeof c.path === 'string') parts.push(`Edited ${c.path}`);
  }
  if (parts.length) return cut(parts.join('\n'));
  const out = tool.rawOutput;
  if (typeof out === 'string') return cut(out);
  if (out && typeof out === 'object') {
    const o = obj(out);
    const text = str(o.output) ?? str(o.stdout) ?? str(o.text) ?? str(o.content) ?? str(o.error);
    if (text !== undefined) {
      const code = Number.isInteger(o.exitCode) ? o.exitCode : Number.isInteger(o.exit_code) ? o.exit_code : 0;
      return cut(code ? `${text.replace(/\n+$/, '')}${text ? '\n' : ''}exit ${code}` : text);
    }
    return cut(JSON.stringify(out));
  }
  return '';
}

/** ACP's usage, if a result carries one, as Claude's. */
function usageOf(u) {
  if (!u || typeof u !== 'object') return undefined;
  const num = v => (Number.isFinite(v) ? v : 0);
  return {
    input_tokens: num(u.inputTokens ?? u.input_tokens),
    output_tokens: num(u.outputTokens ?? u.output_tokens),
    cache_read_input_tokens: num(u.cachedReadTokens ?? u.cacheReadTokens ?? u.cache_read_input_tokens),
    cache_creation_input_tokens: num(u.cachedWriteTokens ?? u.cacheWriteTokens ?? u.cache_creation_input_tokens),
  };
}

/** How a turn's stop reason reads as Claude's result. */
function resultOf(stopReason) {
  if (stopReason === 'end_turn' || stopReason === 'max_tokens') return { subtype: 'success', isError: false };
  if (stopReason === 'max_turn_requests') return { subtype: 'error_max_turns', isError: true };
  return { subtype: 'error_during_execution', isError: true };
}

/**
 * A normaliser for one turn: `push(line)` returns the Claude-shaped events a line of the turn's stream makes
 * (often none), `end()` what the turn still needs once it is gone (text, thinking or a tool a stop cut off).
 */
function createDevinNormalizer({ now = () => Date.now(), turnTag = randomUUID().slice(0, 8) } = {}) {
  let sessionId = null;
  let model = null;
  let text = '';
  let thinking = '';
  let lastText = '';
  let n = 0;
  let plans = 0;
  // By toolCallId: { kind, title, status, rawInput, rawOutput, content, locations, meta, used, resulted }.
  const tools = new Map();
  // Unique across the session's turns, not just this one: the chat keys an assistant message by its id, and each turn
  // is a new normaliser counting from one (as cursor-events.js does).
  const msgId = () => `devin-${turnTag}-${(++n).toString(36)}`;
  const stamp = () => new Date(now()).toISOString();
  const base = () => (sessionId ? { session_id: sessionId } : {});
  const assistant = content => ({
    type: 'assistant',
    message: { id: msgId(), role: 'assistant', ...(model ? { model } : {}), content },
    ...base(),
    timestamp: stamp(),
  });
  const toolResult = (id, content, isError) => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError && { is_error: true }) }] },
    ...base(),
    timestamp: stamp(),
  });
  /** The thinking, then the text, gathered so far. */
  const flushWords = () => {
    const out = [];
    if (thinking.trim()) out.push(assistant([{ type: 'thinking', thinking }]));
    thinking = '';
    if (text.trim()) {
      out.push(assistant([{ type: 'text', text }]));
      lastText = text;
    }
    text = '';
    return out;
  };
  const useTool = (id, tool) => {
    if (tool.used) return [];
    tool.used = true;
    return [assistant([{ type: 'tool_use', id, name: nameOf(tool), input: inputOf(tool) }])];
  };
  /** Every tool still waiting for its tool_use (one that came in pending and was never heard of again). */
  const flushTools = () => {
    const out = [];
    for (const [id, tool] of tools) if (!tool.used) out.push(...useTool(id, tool));
    return out;
  };
  const track = (u) => {
    const id = str(u.toolCallId);
    if (!id) return null;
    const tool = tools.get(id) || { used: false, resulted: false };
    for (const k of ['kind', 'title', 'status', 'rawInput', 'rawOutput', 'locations']) if (u[k] !== undefined && u[k] !== null) tool[k] = u[k];
    if (Array.isArray(u.content)) tool.content = u.content;
    if (u._meta && typeof u._meta === 'object') tool.meta = { ...obj(tool.meta), ...u._meta };
    tools.set(id, tool);
    return { id, tool };
  };
  const onTool = (u) => {
    const t = track(u);
    if (!t) return [];
    const { id, tool } = t;
    const out = [];
    if (tool.status && tool.status !== 'pending') {
      out.push(...flushWords(), ...useTool(id, tool));
    }
    if ((tool.status === 'completed' || tool.status === 'failed') && !tool.resulted) {
      tool.resulted = true;
      out.push(...useTool(id, tool), toolResult(id, resultText(tool), tool.status === 'failed'));
    }
    return out;
  };
  const onUpdate = (u) => {
    if (!u || typeof u !== 'object' || fromSubagent(u)) return [];
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const c = obj(u.content);
        if (c.type === 'text' && typeof c.text === 'string') {
          // Words after thinking start a new block: the thinking goes first.
          if (thinking && !text) {
            const out = flushWords();
            text = c.text;
            return out;
          }
          text += c.text;
        }
        return [];
      }
      case 'agent_thought_chunk': {
        const c = obj(u.content);
        if (c.type === 'text' && typeof c.text === 'string') {
          const out = text ? flushWords() : [];
          thinking += c.text;
          return out;
        }
        return [];
      }
      case 'tool_call':
      case 'tool_call_update':
        return onTool(u);
      case 'plan': {
        const entries = Array.isArray(u.entries) ? u.entries.filter(e => e && typeof e.content === 'string') : [];
        const id = `devin-plan-${turnTag}-${(++plans).toString(36)}`;
        const todos = entries.map(e => ({ content: e.content, status: ['pending', 'in_progress', 'completed'].includes(e.status) ? e.status : 'pending', activeForm: e.content }));
        return [...flushWords(), assistant([{ type: 'tool_use', id, name: 'TodoWrite', input: { todos } }]), toolResult(id, 'Plan updated', false)];
      }
      default:
        return [];
    }
  };

  return {
    push(line) {
      let e;
      try { e = JSON.parse(line); } catch { return []; }
      if (!e || typeof e !== 'object') return [];
      if (e.termag === 'ready') {
        if (typeof e.sessionId === 'string') sessionId = e.sessionId;
        model = str(e.model) || null;
        return [{ type: 'system', subtype: 'init', session_id: e.sessionId, ...(str(e.cwd) && { cwd: e.cwd }), ...(model && { model }), engine: 'devin' }];
      }
      if (e.termag === 'permission') {
        if (e.allowed) return [];
        const id = str(e.toolCallId);
        if (!id) return [];
        const t = track({ ...obj(e.toolCall), toolCallId: id });
        if (!t || t.tool.resulted) return [];
        t.tool.resulted = true;
        return [...flushWords(), ...useTool(id, t.tool), toolResult(id, 'Denied: termag runs this turn read-only (no edits, no commands)', true)];
      }
      if (e.termag === 'result') {
        const r = resultOf(e.stopReason);
        const out = [...flushWords(), ...flushTools()];
        out.push({
          type: 'result',
          subtype: r.subtype,
          is_error: r.isError,
          result: lastText,
          ...base(),
          ...(usageOf(e.usage) && { usage: usageOf(e.usage) }),
        });
        return out;
      }
      if (e.method === 'session/update' && e.params && typeof e.params === 'object') return onUpdate(e.params.update);
      return [];
    },
    end() {
      return [...flushWords(), ...flushTools()];
    },
  };
}

module.exports = { createDevinNormalizer, TOOL_NAMES, RESULT_MAX };
