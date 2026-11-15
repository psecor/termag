'use strict';
// devin-events.js against a Devin turn's stream as devin-acp.js writes it. The turns in agent/fixtures/devin/spec/
// are built from the ACP v1 spec (fixtures/devin/README.md): a read-only review that reads, searches, has a
// command refused and plans; a full-access one that edits and runs a command.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDevinNormalizer, RESULT_MAX } = require('./devin-events');

const SPEC = path.join(__dirname, 'fixtures/devin/spec');
const NOW = Date.parse('2026-11-14T15:00:00Z');

function normalise(lines, opts = {}) {
  const n = createDevinNormalizer({ now: () => NOW, turnTag: 't1', ...opts });
  const out = [];
  for (const line of lines) if (line.trim()) out.push(...n.push(line));
  out.push(...n.end());
  return out;
}
const fromFile = name => normalise(fs.readFileSync(path.join(SPEC, name), 'utf8').split('\n'));
const toolUses = evs => evs.flatMap(e => (e.type === 'assistant' ? e.message.content.filter(c => c.type === 'tool_use') : []));
const toolResults = evs => evs.flatMap(e => (e.type === 'user' ? e.message.content.filter(c => c.type === 'tool_result') : []));
const blocks = (evs, type) => evs.flatMap(e => (e.type === 'assistant' ? e.message.content.filter(c => c.type === type) : []));
const up = u => JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: u } });
const READY = JSON.stringify({ termag: 'ready', sessionId: 'devin-1f3a9c0e-somber-minnow', cwd: '/w', mode: 'ask', loaded: false });

test("a read-only review's stream is Claude's: init first, thinking, the tools with Claude's names, the answer, one result", () => {
  const evs = fromFile('review-read.jsonl');
  assert.deepEqual(evs[0], { type: 'system', subtype: 'init', session_id: 'devin-1f3a9c0e-somber-minnow', cwd: '/home/termag/.termag/chats/devin/p1--review-12/workspace', model: 'swe-1-6-fast', engine: 'devin' });
  assert.equal(evs.filter(e => e.type === 'result').length, 1);
  assert.equal(evs.at(-1).type, 'result');
  assert.deepEqual(blocks(evs, 'thinking').map(b => b.thinking), ['The diff changes the retry loop; read the file.']);
  assert.deepEqual(blocks(evs, 'text').map(b => b.text), ['The loop runs `max + 1` times: use `<`.']);
  assert.deepEqual(toolUses(evs).map(u => [u.id, u.name, u.input]), [
    ['call_1', 'Read', { file_path: '/w/p1/src/retry.js' }],
    ['call_2', 'Grep', { pattern: 'attempt', path: '/w/p1/src' }],
    ['call_3', 'Bash', { command: 'npm test' }],
    ['devin-plan-t1-1', 'TodoWrite', { todos: [
      { content: 'Check the loop bound', status: 'completed', activeForm: 'Check the loop bound' },
      { content: 'Write the review', status: 'in_progress', activeForm: 'Write the review' },
    ] }],
  ]);
  const results = toolResults(evs);
  assert.deepEqual(results.map(r => [r.tool_use_id, Boolean(r.is_error)]), [['call_1', false], ['call_2', false], ['call_3', true], ['devin-plan-t1-1', false]]);
  assert.match(results[0].content, /await attempt/);
  assert.match(results[1].content, /retry\.js:2/);
  // The refused command is one failed result, the refusal's: Devin's own failed update after it adds none.
  assert.match(results[2].content, /^Denied: termag runs this turn read-only/);
  // Thinking before the tools, the answer after them.
  const kinds = evs.filter(e => e.type === 'assistant').map(e => e.message.content[0].type);
  assert.equal(kinds[0], 'thinking');
  assert.equal(kinds.at(-1), 'text');
  // The subagent's words aren't the turn's.
  assert.ok(!JSON.stringify(evs).includes("a subagent's words"));
  const result = evs.at(-1);
  assert.deepEqual(result, { type: 'result', subtype: 'success', is_error: false, result: 'The loop runs `max + 1` times: use `<`.', session_id: 'devin-1f3a9c0e-somber-minnow' });
  // Every assistant and user line carries a time and the session, and each message its own id.
  for (const e of evs.filter(x => x.type === 'assistant' || x.type === 'user')) {
    assert.equal(e.timestamp, new Date(NOW).toISOString());
    assert.equal(e.session_id, 'devin-1f3a9c0e-somber-minnow');
  }
  const ids = evs.filter(e => e.type === 'assistant').map(e => e.message.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => id.startsWith('devin-t1-')));
});

test("a full-access turn: an edit's diff as Edit's input, a command's output and exit, Devin's own tool name for any other, usage as Claude's", () => {
  const evs = fromFile('edit-full.jsonl');
  assert.deepEqual(toolUses(evs).map(u => [u.name, u.input]), [
    ['Edit', { file_path: '/w/p1/src/retry.js', old_string: 'i <= max', new_string: 'i < max' }],
    ['Bash', { command: 'npm test' }],
    ['codemap', { query: 'x' }],
  ]);
  const results = toolResults(evs);
  assert.deepEqual(results.map(r => r.content), ['Edited /w/p1/src/retry.js', '1 failing\nexit 1', 'ok']);
  assert.equal(results.filter(r => r.is_error).length, 0, "a command's failing exit is its output, as Claude's is");
  assert.deepEqual(evs.at(-1).usage, { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 });
});

test('a tool shows once it is under way, with the input its updates had by then; a pending one waits', () => {
  const evs = normalise([
    READY,
    up({ sessionUpdate: 'tool_call', toolCallId: 'a', kind: 'execute', title: 'Run', status: 'pending' }),
    up({ sessionUpdate: 'tool_call_update', toolCallId: 'a', rawInput: { command: 'ls -la' } }),
  ]);
  // Not under way yet, until the turn's end gives it its line.
  assert.deepEqual(toolUses(evs).map(u => u.input), [{ command: 'ls -la' }]);
  const live = createDevinNormalizer({ now: () => NOW, turnTag: 't' });
  live.push(READY);
  assert.deepEqual(live.push(up({ sessionUpdate: 'tool_call', toolCallId: 'b', kind: 'read', status: 'pending', locations: [{ path: '/w/a' }] })), []);
  const started = live.push(up({ sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'in_progress' }));
  assert.deepEqual(toolUses(started).map(u => [u.id, u.name, u.input]), [['b', 'Read', { file_path: '/w/a' }]]);
  assert.deepEqual(live.push(up({ sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'in_progress' })), [], 'once');
  const ended = live.push(up({ sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'failed', rawOutput: { error: 'ENOENT' } }));
  assert.deepEqual(toolResults(ended), [{ type: 'tool_result', tool_use_id: 'b', content: 'ENOENT', is_error: true }]);
  assert.deepEqual(live.push(up({ sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'completed' })), [], 'one result');
});

test('words: chunks gather into one block, a tool or thought between them starts the next; a stop keeps what came', () => {
  const evs = normalise([
    READY,
    up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one ' } }),
    up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'two' } }),
    up({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } }),
    up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'three' } }),
    up({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } }),
  ]);
  assert.deepEqual(evs.slice(1).map(e => e.message.content[0]), [
    { type: 'text', text: 'one two' }, { type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'three' },
  ]);
  assert.ok(!evs.some(e => e.type === 'result'), 'no result without the result line: chat-turn.js says the turn stopped');
});

test("a stop reason that isn't the end is an error result; modes, commands, session info and Devin's own notices are nothing", () => {
  const ends = { end_turn: [false, 'success'], max_tokens: [false, 'success'], max_turn_requests: [true, 'error_max_turns'], refusal: [true, 'error_during_execution'], cancelled: [true, 'error_during_execution'] };
  for (const [reason, [isError, subtype]] of Object.entries(ends)) {
    const r = normalise([READY, JSON.stringify({ termag: 'result', stopReason: reason })]).at(-1);
    assert.equal(r.is_error, isError, reason);
    assert.equal(r.subtype, subtype, reason);
  }
  const quiet = normalise([
    READY,
    up({ sessionUpdate: 'current_mode_update', currentModeId: 'ask' }),
    up({ sessionUpdate: 'config_option_update', configOptions: [] }),
    up({ sessionUpdate: 'session_info_update', title: 'x' }),
    up({ sessionUpdate: 'available_commands_update', availableCommands: [] }),
    up({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed' } }),
    JSON.stringify({ jsonrpc: '2.0', method: '_cognition.ai/agent_stopped', params: { cause: 'auth_required' } }),
    JSON.stringify({ termag: 'refused', method: 'terminal/create', command: 'ls' }),
    JSON.stringify({ termag: 'permission', toolCallId: 'x', kind: 'read', allowed: true }),
    'not json',
  ]);
  assert.deepEqual(quiet.map(e => e.type), ['system']);
});

test("a long tool output is cut as the chat cuts one; a denied tool Devin never announced still gets its line", () => {
  const big = 'x'.repeat(RESULT_MAX + 50);
  const evs = normalise([
    READY,
    up({ sessionUpdate: 'tool_call', toolCallId: 'r', kind: 'read', status: 'completed', rawOutput: big }),
    JSON.stringify({ termag: 'permission', toolCallId: 'e', kind: 'edit', allowed: false, toolCall: { toolCallId: 'e', kind: 'edit', title: 'Edit a', locations: [{ path: '/w/a' }] } }),
  ]);
  const [read, denied] = toolResults(evs);
  assert.ok(read.content.length < big.length && read.content.endsWith('… (cut)'));
  assert.deepEqual(toolUses(evs).map(u => [u.id, u.name, u.input]), [['r', 'Read', { file_path: '' }], ['e', 'Edit', { file_path: '/w/a' }]]);
  assert.equal(denied.tool_use_id, 'e');
  assert.equal(denied.is_error, true);
});

test("message ids differ across a session's turns", () => {
  const a = normalise([READY, up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } })], { turnTag: undefined });
  const b = normalise([READY, up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } })], { turnTag: undefined });
  assert.notEqual(a[1].message.id, b[1].message.id);
});
