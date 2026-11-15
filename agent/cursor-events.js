'use strict';
// cursor-agent's `-p --output-format stream-json` (one JSON event per line)
// as the Claude stream-json subset the backend and the simple UI already
// read, so a chat turn on the cursor engine (chat-engines.js, chat-cursor-v1)
// looks like a Claude turn from the box on: system/init, assistant (text,
// thinking, tool_use), user/tool_result and result. Pure: chat-turn.js feeds
// it cursor-agent's stdout line by line and writes what comes back to
// events.jsonl (and, since Cursor's own session store is SQLite, to the
// runner-kept transcript the chat's history reads).
//
// What cursor-agent 2026.10.22 does that this relies on (agent/fixtures/cursor/2026.10.22/,
// recorded on macOS with plan, plan + auto-review, and a resume):
// - the first line is `system/init` with the session id (a uuid), which a
//   later `--resume <id>` keeps;
// - the prompt is echoed as a `user` line: dropped, Claude's stream has none;
// - thinking comes as `thinking/delta` lines, ended by `thinking/completed`;
// - each tool is a `tool_call` `started` then `completed` line with the same
//   `call_id`, its kind the one key of `tool_call` (`readToolCall`,
//   `shellToolCall`, `grepToolCall`, `globToolCall`, …), with `args`, and on
//   completion a `result` of `success`, `rejected` (plan mode refusing a
//   shell command), `permissionDenied` (a deny rule refusing one, 2026.11.11:
//   agent/fixtures/cursor/2026.11.11/) or `error`;
// - each assistant message is one whole `assistant` line (no
//   --stream-partial-output), and the run ends on one `result` line, with
//   usage in camelCase and no cost.
// A stopped cursor-agent (SIGTERM) ends with no result; chat-turn.js says so.

const { randomUUID } = require('crypto');

/** The most of a tool's output kept as its result's text, as the chat shows a long one cut. */
const RESULT_MAX = 16 * 1024;

/** Claude's tool names for Cursor's tool kinds, so the chat draws them as it draws Claude's. */
const TOOL_NAMES = {
  readToolCall: 'Read',
  shellToolCall: 'Bash',
  grepToolCall: 'Grep',
  globToolCall: 'Glob',
  editToolCall: 'Edit',
  writeToolCall: 'Write',
  deleteToolCall: 'Delete',
  lsToolCall: 'LS',
  updateTodosToolCall: 'TodoWrite',
  todoToolCall: 'TodoWrite',
  webSearchToolCall: 'WebSearch',
  webFetchToolCall: 'WebFetch',
  askQuestionToolCall: 'AskQuestion',
};

function str(v) { return typeof v === 'string' ? v : undefined; }

/** A tool's kind (the one key of `tool_call`) and its body. */
function toolOf(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return null;
  const kind = Object.keys(toolCall).find(k => /ToolCall$/.test(k) && toolCall[k] && typeof toolCall[k] === 'object');
  return kind ? { kind, body: toolCall[kind] } : null;
}

/** `fooBarToolCall` as a tool name, for a kind this doesn't know. */
function nameOf(kind) {
  if (TOOL_NAMES[kind]) return TOOL_NAMES[kind];
  const base = kind.replace(/ToolCall$/, '');
  return base ? base[0].toUpperCase() + base.slice(1) : 'Tool';
}

/** A tool call's input in the shape Claude's tool of that name takes; anything else as Cursor gave it. */
function inputOf(kind, args) {
  const a = args && typeof args === 'object' ? args : {};
  switch (kind) {
    case 'readToolCall': return { file_path: str(a.path) ?? '', ...(Number.isInteger(a.offset) && { offset: a.offset }), ...(Number.isInteger(a.limit) && { limit: a.limit }) };
    case 'shellToolCall': return { command: str(a.command) ?? '', ...(str(a.description) && { description: a.description }) };
    case 'grepToolCall': return { pattern: str(a.pattern) ?? '', ...(str(a.path) && { path: a.path }), ...(str(a.glob) && { glob: a.glob }), ...(a.caseInsensitive === true && { '-i': true }) };
    case 'globToolCall': return { pattern: str(a.globPattern) ?? str(a.pattern) ?? '', ...(str(a.targetDirectory) && { path: a.targetDirectory }) };
    case 'editToolCall': return { file_path: str(a.path) ?? '', ...(str(a.oldString) !== undefined && { old_string: a.oldString }), ...(str(a.newString) !== undefined && { new_string: a.newString }) };
    case 'writeToolCall': return { file_path: str(a.path) ?? '', ...(str(a.fileText) !== undefined && { content: a.fileText }) };
    case 'lsToolCall':
    case 'deleteToolCall': return { path: str(a.path) ?? '' };
    default: {
      const out = { ...a };
      delete out.toolCallId;
      return out;
    }
  }
}

function cut(text) {
  return text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}\n… (cut)` : text;
}

/** What a finished tool returned, as Claude's tool_result text, and whether it failed. */
function resultOf(kind, body) {
  const r = body && typeof body.result === 'object' && body.result ? body.result : null;
  if (!r) return { text: '', isError: false };
  if (r.rejected) {
    const why = str(r.rejected.reason) || str(r.rejected.message);
    return { text: why ? `Rejected: ${why}` : 'Rejected', isError: true };
  }
  // A command the turn's permissions refuse: a deny rule in its cli-config.json, which even --force obeys, as a
  // sharee's denials are (seen on 2026.11.11: { permissionDenied: { command, error } }). A failure, never a success.
  if (r.permissionDenied) {
    const why = str(r.permissionDenied.error) || str(r.permissionDenied.reason) || str(r.permissionDenied.message);
    return { text: why ? `Denied: ${why}` : 'Denied', isError: true };
  }
  const failed = r.error || r.failure;
  if (failed) {
    const why = typeof failed === 'string' ? failed : str(failed.message) || str(failed.error) || JSON.stringify(failed);
    return { text: cut(why || 'Failed'), isError: true };
  }
  const ok = r.success;
  if (!ok || typeof ok !== 'object') return { text: cut(JSON.stringify(r)), isError: false };
  if (kind === 'readToolCall') return { text: cut(str(ok.content) ?? ''), isError: false };
  if (kind === 'shellToolCall') {
    const out = [str(ok.stdout) ?? str(ok.interleavedOutput) ?? '', str(ok.stderr) ?? ''].map(t => t.replace(/\n+$/, '')).filter(Boolean).join('\n');
    const code = Number.isInteger(ok.exitCode) ? ok.exitCode : 0;
    return { text: cut(code ? `${out}${out ? '\n' : ''}exit ${code}` : out), isError: code !== 0 };
  }
  if (kind === 'globToolCall' && Array.isArray(ok.files)) return { text: cut(ok.files.join('\n')), isError: false };
  if (kind === 'grepToolCall' && ok.workspaceResults && typeof ok.workspaceResults === 'object') {
    const lines = [];
    for (const ws of Object.values(ok.workspaceResults)) {
      const files = ws && ws.content && Array.isArray(ws.content.matches) ? ws.content.matches : [];
      for (const f of files) {
        for (const m of Array.isArray(f.matches) ? f.matches : []) {
          if (m && !m.isContextLine) lines.push(`${f.file}:${m.lineNumber}:${m.content}`);
        }
      }
      if (ws && ws.files && Array.isArray(ws.files.files)) lines.push(...ws.files.files);
    }
    return { text: cut(lines.join('\n')), isError: false };
  }
  return { text: cut(JSON.stringify(ok)), isError: false };
}

function isoOf(ms) {
  const n = typeof ms === 'string' ? Number(ms) : ms;
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

/** Cursor's camelCase usage as Claude's. */
function usageOf(u) {
  if (!u || typeof u !== 'object') return undefined;
  const num = v => (Number.isFinite(v) ? v : 0);
  return {
    input_tokens: num(u.inputTokens),
    output_tokens: num(u.outputTokens),
    cache_read_input_tokens: num(u.cacheReadTokens),
    cache_creation_input_tokens: num(u.cacheWriteTokens),
  };
}

/**
 * A normaliser for one turn: `push(line)` returns the Claude-shaped events a
 * line of cursor-agent's stream makes (often none), `end()` what the turn
 * still needs once cursor-agent is gone (its thinking, if a stop cut it off).
 * `now` stamps the lines Cursor sends no time on.
 */
function createCursorNormalizer({ now = () => Date.now(), turnTag = randomUUID().slice(0, 8) } = {}) {
  let sessionId = null;
  let model = null;
  let thinking = '';
  let thinkingAt = null;
  let n = 0;
  // Unique across the session's turns, not just this one: the chat keys an assistant message by its id, so a resumed
  // turn's first message must never take an earlier turn's (each turn is a new normaliser, counting from one).
  const msgId = () => `cursor-${turnTag}-${(++n).toString(36)}`;
  const stamp = ms => isoOf(ms) || new Date(now()).toISOString();
  const base = () => (sessionId ? { session_id: sessionId } : {});
  const assistant = (content, at) => ({
    type: 'assistant',
    message: { id: msgId(), role: 'assistant', ...(model ? { model } : {}), content },
    ...base(),
    timestamp: at || stamp(),
  });
  const flushThinking = () => {
    if (!thinking.trim()) { thinking = ''; return []; }
    const ev = assistant([{ type: 'thinking', thinking }], thinkingAt);
    thinking = '';
    thinkingAt = null;
    return [ev];
  };

  return {
    push(line) {
      let e;
      try { e = JSON.parse(line); } catch { return []; }
      if (!e || typeof e !== 'object') return [];
      if (typeof e.session_id === 'string' && !sessionId) sessionId = e.session_id;
      if (e.type === 'system' && e.subtype === 'init') {
        model = str(e.model) || null;
        return [{ type: 'system', subtype: 'init', session_id: e.session_id, ...(str(e.cwd) && { cwd: e.cwd }), ...(model && { model }), engine: 'cursor' }];
      }
      // The prompt, echoed: Claude's stream doesn't repeat it, and the transcript has it from prompt.txt.
      if (e.type === 'user') return [];
      if (e.type === 'thinking') {
        if (e.subtype === 'delta' && typeof e.text === 'string') {
          if (!thinkingAt) thinkingAt = isoOf(e.timestamp_ms);
          thinking += e.text;
          return [];
        }
        if (e.subtype === 'completed') return flushThinking();
        return [];
      }
      if (e.type === 'tool_call') {
        const tool = toolOf(e.tool_call);
        const id = str(e.call_id);
        if (!tool || !id) return [];
        const out = flushThinking();
        if (e.subtype === 'started') {
          out.push(assistant([{ type: 'tool_use', id, name: nameOf(tool.kind), input: inputOf(tool.kind, tool.body.args) }], isoOf(e.timestamp_ms)));
        } else if (e.subtype === 'completed') {
          const { text, isError } = resultOf(tool.kind, tool.body);
          out.push({
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError && { is_error: true }) }] },
            ...base(),
            timestamp: stamp(e.timestamp_ms),
          });
        }
        return out;
      }
      if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
        const content = e.message.content.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => ({ type: 'text', text: p.text }));
        if (!content.length) return flushThinking();
        return [...flushThinking(), assistant(content)];
      }
      if (e.type === 'result') {
        const isError = e.is_error === true || (typeof e.subtype === 'string' && e.subtype !== 'success');
        return [...flushThinking(), {
          type: 'result',
          subtype: isError ? 'error_during_execution' : 'success',
          is_error: isError,
          result: str(e.result) ?? '',
          ...base(),
          ...(Number.isFinite(e.duration_ms) && { duration_ms: e.duration_ms }),
          ...(Number.isFinite(e.duration_api_ms) && { duration_api_ms: e.duration_api_ms }),
          ...(usageOf(e.usage) && { usage: usageOf(e.usage) }),
        }];
      }
      return [];
    },
    end() {
      return flushThinking();
    },
  };
}

module.exports = { createCursorNormalizer, TOOL_NAMES, RESULT_MAX };
