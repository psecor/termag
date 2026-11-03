'use strict';
// pi's `--mode json` stream (one JSON event per line) as the Claude
// stream-json subset the backend and the simple UI already read, so a chat
// turn on the pi engine (chat-runner.js engineOf) looks like a Claude turn
// from the box on: system/init, stream_event (live typing), assistant,
// user/tool_result and result. Pure: chat-turn.js feeds it pi's stdout line
// by line and writes what comes back to events.jsonl.
//
// What pi 1.0.2 does that this relies on (the pi spike's fixtures,
// agent/test-fixtures/pi/):
// - the first line is the `session` header with the session id;
// - the system prompt arrives as a message with role "system": dropped;
// - a run is over at `agent_settled`, not `agent_end` (retries and
//   compaction may follow agent_end);
// - JSON mode exits 0 on a model or HTTP error: the only sign is the last
//   assistant message's stopReason "error" (and its errorMessage);
// - tool_execution_end has the result but no args (toolcall_end has them).
// A stopped pi (SIGTERM) ends mid-stream with neither agent_end nor
// agent_settled; `end()` says what the turn's log still needs then.

/** Text of a pi content array (or string): its text parts, joined. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
}

/** pi's assistant content as Claude's blocks: text, tool_use, thinking. Anything else is dropped. */
function claudeBlocks(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && typeof p.text === 'string') out.push({ type: 'text', text: p.text });
    else if (p.type === 'toolCall' && typeof p.id === 'string') {
      out.push({ type: 'tool_use', id: p.id, name: typeof p.name === 'string' ? p.name : 'tool', input: p.arguments && typeof p.arguments === 'object' ? p.arguments : {} });
    } else if (p.type === 'thinking' && typeof p.thinking === 'string') out.push({ type: 'thinking', thinking: p.thinking });
  }
  return out;
}

/** pi's per-message usage as Claude's field names; null when it has none. */
function claudeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const n = v => (Number.isFinite(v) ? v : 0);
  return {
    input_tokens: n(usage.input),
    output_tokens: n(usage.output),
    cache_read_input_tokens: n(usage.cacheRead),
    cache_creation_input_tokens: n(usage.cacheWrite),
  };
}

/** A stopReason that means the model call failed. "aborted" is pi's own stop. */
const FAILED_STOPS = new Set(['error', 'aborted']);

/**
 * A stateful reducer: `push(line)` returns the Claude-shaped events for one
 * line of pi's stdout (none for most), `end({ code, interrupted })` the ones
 * the turn still needs when pi exits.
 */
function createPiNormalizer({ now = Date.now } = {}) {
  const startedAt = now();
  let sessionId = null;
  let settled = false;
  let error = null;
  let lastText = '';
  let lastModel = null;
  let assistants = 0;
  let cost = null;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  // The assistant message being streamed: the id its stream_events and its
  // final `assistant` event share, so the UI's live text becomes the final one.
  let messageId = null;
  let messages = 0;
  const idFor = (msg) => {
    messages += 1;
    const at = msg && Number.isFinite(msg.timestamp) ? msg.timestamp : now();
    return `pi-${at}-${messages}`;
  };

  function result() {
    const failed = error != null;
    return {
      type: 'result',
      subtype: failed ? 'error' : 'success',
      is_error: failed,
      result: failed ? error : lastText,
      session_id: sessionId,
      ...(lastModel ? { model: lastModel } : {}),
      usage: { ...usage },
      total_cost_usd: cost,
      num_turns: assistants,
      duration_ms: Math.max(0, now() - startedAt),
      engine: 'pi',
    };
  }

  function onUpdate(ev) {
    const u = ev.assistantMessageEvent;
    if (!u || typeof u !== 'object') return [];
    const index = u.contentIndex;
    const stream = event => [{ type: 'stream_event', event }];
    switch (u.type) {
      case 'text_start':
        return stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      case 'text_delta':
        return typeof u.delta === 'string' ? stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: u.delta } }) : [];
      case 'toolcall_start':
        return typeof u.id === 'string'
          ? stream({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: u.id, name: typeof u.toolName === 'string' ? u.toolName : 'tool', input: {} } })
          : [];
      case 'toolcall_delta':
        return typeof u.delta === 'string' ? stream({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: u.delta } }) : [];
      case 'text_end':
      case 'toolcall_end':
        return stream({ type: 'content_block_stop', index });
      default:
        // Thinking streams too, but the chat shows thinking only in the final message.
        return [];
    }
  }

  function onAssistantEnd(msg) {
    const id = messageId || idFor(msg);
    messageId = null;
    assistants += 1;
    if (typeof msg.model === 'string') lastModel = msg.model;
    const u = claudeUsage(msg.usage);
    if (u) for (const k of Object.keys(usage)) usage[k] += u[k];
    if (msg.usage && msg.usage.cost && Number.isFinite(msg.usage.cost.total)) cost = (cost || 0) + msg.usage.cost.total;
    // The last assistant message decides: a retry that succeeds clears an earlier failure.
    if (FAILED_STOPS.has(msg.stopReason)) {
      error = typeof msg.errorMessage === 'string' && msg.errorMessage ? msg.errorMessage : `pi stopped (${msg.stopReason})`;
    } else {
      error = null;
      const text = contentText(msg.content);
      if (text) lastText = text;
    }
    const content = claudeBlocks(msg.content);
    if (!content.length) return [];
    return [{
      type: 'assistant',
      message: { id, role: 'assistant', ...(typeof msg.model === 'string' ? { model: msg.model } : {}), content, ...(u ? { usage: u } : {}) },
    }];
  }

  return {
    get sessionId() { return sessionId; },
    get settled() { return settled; },

    push(line) {
      if (typeof line !== 'string' || !line.trim()) return [];
      let ev;
      try { ev = JSON.parse(line); } catch { return []; }
      if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return [];
      switch (ev.type) {
        case 'session':
          if (typeof ev.id !== 'string') return [];
          sessionId = ev.id;
          return [{ type: 'system', subtype: 'init', session_id: ev.id, ...(typeof ev.cwd === 'string' ? { cwd: ev.cwd } : {}), engine: 'pi' }];
        case 'message_start': {
          const msg = ev.message;
          if (!msg || msg.role !== 'assistant') return [];
          messageId = idFor(msg);
          return [{ type: 'stream_event', event: { type: 'message_start', message: { id: messageId, role: 'assistant', ...(typeof msg.model === 'string' ? { model: msg.model } : {}) } } }];
        }
        case 'message_update':
          return messageId ? onUpdate(ev) : [];
        case 'message_end': {
          // system: pi's own prompt. user: the turn-start line already shows it.
          // toolResult: tool_execution_end below said it first.
          const msg = ev.message;
          return msg && msg.role === 'assistant' ? onAssistantEnd(msg) : [];
        }
        case 'tool_execution_end': {
          if (typeof ev.toolCallId !== 'string') return [];
          return [{
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: ev.toolCallId, content: contentText(ev.result && ev.result.content), is_error: ev.isError === true }] },
          }];
        }
        case 'auto_retry_end':
          if (ev.success === false) error = typeof ev.finalError === 'string' && ev.finalError ? ev.finalError : (typeof ev.errorMessage === 'string' && ev.errorMessage ? ev.errorMessage : 'pi gave up retrying the model');
          return [];
        case 'agent_settled':
          if (settled) return [];
          settled = true;
          return [result()];
        default:
          return [];
      }
    },

    /**
     * What the log needs once pi has exited. A settled run has its result.
     * A stop (`interrupted`) is not a failure, so nothing. A non-zero exit
     * gets chat-turn's runner-error with pi's stderr. Only a pi that exited
     * 0 without settling still owes a result, and that one failed.
     */
    end({ code = null, interrupted = false } = {}) {
      if (settled || interrupted || code !== 0) return [];
      settled = true;
      if (error == null) error = 'pi exited before it finished the turn';
      return [result()];
    },
  };
}

module.exports = { claudeBlocks, claudeUsage, contentText, createPiNormalizer };
