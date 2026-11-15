'use strict';
// cursor-events.js against cursor-agent 2026.10.22's own stream-json
// (agent/fixtures/cursor/2026.10.22/, recorded with plan mode, plan with
// auto-review, a resume, and plan mode's question).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCursorNormalizer, RESULT_MAX } = require('./cursor-events');

const FIXTURES = path.join(__dirname, 'fixtures/cursor/2026.10.22');
const NOW = Date.parse('2026-11-12T18:00:00Z');

function normalise(name, dir = FIXTURES) {
  const n = createCursorNormalizer({ now: () => NOW });
  const out = [];
  for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) if (line.trim()) out.push(...n.push(line));
  out.push(...n.end());
  return out;
}
const toolUses = evs => evs.flatMap(e => (e.type === 'assistant' ? e.message.content.filter(c => c.type === 'tool_use') : []));
const toolResults = evs => evs.flatMap(e => (e.type === 'user' ? e.message.content.filter(c => c.type === 'tool_result') : []));

test("a turn's stream is Claude's: init first, the prompt's echo dropped, thinking, tools, the answer, one result", () => {
  const evs = normalise('tools-auto-review.jsonl');
  assert.deepEqual(evs[0], { type: 'system', subtype: 'init', session_id: evs[0].session_id, cwd: '/private/tmp/atr172/cursor-fx', model: 'Auto Balance', engine: 'cursor' });
  assert.match(evs[0].session_id, /^[0-9a-f-]{36}$/);
  assert.ok(!evs.some(e => e.type === 'user' && e.message.content.some(c => c.type === 'text')), 'no echo of the prompt');
  assert.equal(evs.filter(e => e.type === 'result').length, 1);
  assert.equal(evs.at(-1).type, 'result');
  // Every assistant and user line carries a time and the session (the gotcha "In Claude's stream-json, only `assistant` and `user` lines carry a time").
  for (const e of evs.filter(x => x.type === 'assistant' || x.type === 'user')) {
    assert.ok(!Number.isNaN(Date.parse(e.timestamp)), JSON.stringify(e).slice(0, 80));
    assert.equal(e.session_id, evs[0].session_id);
  }
  // Each message has its own id, so the chat never merges two.
  const ids = evs.filter(e => e.type === 'assistant').map(e => e.message.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("Cursor's tools are Claude's names and inputs, and each result answers its own call", () => {
  const evs = normalise('tools-auto-review.jsonl');
  const uses = toolUses(evs);
  assert.deepEqual(uses.map(u => u.name), ['Grep', 'Glob', 'Read', 'Bash']);
  assert.deepEqual(uses[0].input, { pattern: 'hello' });
  assert.deepEqual(uses[1].input, { pattern: '*.ts' });
  assert.deepEqual(uses[2].input, { file_path: '/private/tmp/atr172/cursor-fx/a.txt' });
  assert.equal(uses[3].input.command, 'git status --short');
  const results = toolResults(evs);
  assert.deepEqual(results.map(r => r.tool_use_id), uses.map(u => u.id));
  assert.equal(results[0].content, './b.ts:1:export const x = 1; // hello\n./a.txt:1:hello world');
  assert.equal(results[1].content, './b.ts');
  assert.equal(results[2].content, 'hello world\n');
  assert.equal(results[3].content, '');
  assert.ok(results.every(r => !r.is_error));
  const result = evs.at(-1);
  assert.equal(result.is_error, false);
  assert.equal(result.subtype, 'success');
  assert.ok(result.result.length > 0);
  assert.deepEqual(Object.keys(result.usage).sort(), ['cache_creation_input_tokens', 'cache_read_input_tokens', 'input_tokens', 'output_tokens']);
  assert.ok(!('total_cost_usd' in result), 'Cursor reports no cost');
});

test('plan mode refusing a shell command is a failed tool result that says so; the turn itself succeeds', () => {
  const evs = normalise('plan-shell-rejected.jsonl');
  const results = toolResults(evs);
  const shell = toolUses(evs).find(u => u.name === 'Bash');
  const refused = results.find(r => r.tool_use_id === shell.id);
  assert.equal(refused.is_error, true);
  assert.match(refused.content, /^Rejected/);
  assert.equal(evs.at(-1).is_error, false);
});

test('a resumed turn keeps the session Cursor named, and a shell result is its output', () => {
  const evs = normalise('resumed-shell.jsonl');
  assert.equal(evs[0].session_id, 'c7f63169-1725-4620-9601-991ca50db6bc');
  assert.equal(toolResults(evs)[0].content, 'probe-ok');
});

test("a command a deny rule refuses (even under --force) is a failed tool result that says so, never a success", () => {
  // cursor-agent 2026.11.11, a --force turn whose cli-config.json denies Shell(git push), asked to push.
  const evs = normalise('force-denied-shell.jsonl', path.join(__dirname, 'fixtures/cursor/2026.11.11'));
  const shell = toolUses(evs).find(u => u.name === 'Bash');
  assert.match(shell.input.command, /git push origin main/);
  const denied = toolResults(evs).find(r => r.tool_use_id === shell.id);
  assert.equal(denied.is_error, true);
  assert.equal(denied.content, 'Denied: Command blocked by permissions configuration');
  // The turn itself goes on and ends; only the command was refused.
  assert.equal(evs.at(-1).type, 'result');
  assert.equal(evs.at(-1).is_error, false);
});

test("plan mode's question to the person is a tool of its own, not a dialog the chat would wait on", () => {
  const evs = normalise('plan-ask-question.jsonl');
  assert.ok(toolUses(evs).some(u => u.name === 'AskQuestion'));
  assert.equal(evs.at(-1).type, 'result');
});

test('thinking is one block per stretch, before what follows it; a stop that cuts it off still keeps it', () => {
  const evs = normalise('tools-auto-review.jsonl');
  const kinds = evs.filter(e => e.type === 'assistant').map(e => e.message.content[0].type);
  assert.ok(kinds.includes('thinking'));
  const n = createCursorNormalizer({ now: () => NOW });
  n.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'aaaaaaaa-1111-2222-3333-444444444444', model: 'gpt-5' }));
  n.push(JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'half a ', timestamp_ms: NOW }));
  n.push(JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'thought' }));
  const tail = n.end();
  assert.equal(tail.length, 1);
  assert.deepEqual(tail[0].message.content, [{ type: 'thinking', thinking: 'half a thought' }]);
  assert.equal(tail[0].message.model, 'gpt-5');
  assert.equal(tail[0].timestamp, new Date(NOW).toISOString());
});

test('what it does with the unexpected: bad JSON and unknown lines are nothing, a failed shell is an error with its exit, a long result is cut', () => {
  const n = createCursorNormalizer({ now: () => NOW });
  assert.deepEqual(n.push('not json'), []);
  assert.deepEqual(n.push(JSON.stringify({ type: 'something_new' })), []);
  const failed = n.push(JSON.stringify({
    type: 'tool_call', subtype: 'completed', call_id: 'c1',
    tool_call: { shellToolCall: { args: { command: 'false' }, result: { success: { exitCode: 2, stdout: 'out\n', stderr: 'err\n' } } } },
  }));
  assert.equal(failed[0].message.content[0].is_error, true);
  assert.equal(failed[0].message.content[0].content, 'out\nerr\nexit 2');
  const long = n.push(JSON.stringify({
    type: 'tool_call', subtype: 'completed', call_id: 'c2',
    tool_call: { readToolCall: { args: { path: '/x' }, result: { success: { content: 'x'.repeat(RESULT_MAX + 10) } } } },
  }));
  assert.ok(long[0].message.content[0].content.endsWith('… (cut)'));
  const unknown = n.push(JSON.stringify({ type: 'tool_call', subtype: 'started', call_id: 'c3', tool_call: { fooBarToolCall: { args: { a: 1, toolCallId: 'c3' } } } }));
  assert.deepEqual(unknown[0].message.content[0], { type: 'tool_use', id: 'c3', name: 'FooBar', input: { a: 1 } });
  const denied = n.push(JSON.stringify({ type: 'tool_call', subtype: 'completed', call_id: 'c4', tool_call: { editToolCall: { args: { path: '/x' }, result: { permissionDenied: {} } } } }));
  assert.deepEqual([denied[0].message.content[0].is_error, denied[0].message.content[0].content], [true, 'Denied'], 'any tool, reason or none');
  const error = n.push(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'boom' }));
  assert.equal(error[0].is_error, true);
  assert.equal(error[0].subtype, 'error_during_execution');
});

test("each turn's message ids are its own, so a resumed turn never overwrites an earlier answer in the chat", () => {
  const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });
  const a = createCursorNormalizer({ now: () => NOW }).push(line)[0].message.id;
  const b = createCursorNormalizer({ now: () => NOW }).push(line)[0].message.id;
  assert.notEqual(a, b);
  assert.match(a, /^cursor-[0-9a-f]{8}-1$/);
  assert.equal(createCursorNormalizer({ now: () => NOW, turnTag: 'tag' }).push(line)[0].message.id, 'cursor-tag-1');
});
