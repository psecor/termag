'use strict';
// pi-events.js and pi-session.js over the pi spike's recordings
// (fixtures/pi/, pi 1.0.2 on a model broker, see fixtures/pi/README.md): what a
// pi turn's events.jsonl holds, and what chat-history shows of its session file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPiNormalizer } = require('./pi-events');
const { findPiSession, piHistoryEntries, piSessionSlug, piUserEntryId, rehomePiSession } = require('./pi-session');
const { createPiPipe } = require('./chat-turn');

const FIXTURES = path.join(__dirname, 'fixtures/pi');
const raw = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const piLines = name => raw(name).split('\n').filter(l => l.trim());

/** A recording through the normaliser, as chat-turn.js feeds it: the events, and the normaliser for end(). */
function normalise(name) {
  const n = createPiNormalizer({ now: () => 1000 });
  const events = piLines(name).flatMap(line => n.push(line));
  return { n, events };
}
const ofType = (events, type) => events.filter(e => e.type === type);
const resultOf = events => events.find(e => e.type === 'result');
const toolUses = events => ofType(events, 'assistant').flatMap(e => e.message.content.filter(b => b.type === 'tool_use'));
const toolResults = events => ofType(events, 'user').flatMap(e => e.message.content.filter(b => b.type === 'tool_result'));
/** The usage pi reported, summed over the run's assistant messages, by pi's names. */
function piUsage(name) {
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const line of piLines(name)) {
    const e = JSON.parse(line);
    if (e.type === 'message_end' && e.message?.role === 'assistant') for (const k of Object.keys(sum)) sum[k] += e.message.usage[k];
  }
  return sum;
}

const SESSION = 'd19250bb-94ce-4b99-b55a-de9911e8d39f';
const FINISHED = ['success.jsonl', 'tool-use-space-put.jsonl', 'resumed-session-id.jsonl', 'resumed-continue.jsonl', 'resumed-after-sigint.jsonl', 'readonly-write-refused.jsonl', 'thinking-off.jsonl', 'concurrent-1.jsonl'];
const STOPPED = ['interrupted-sigint-tool.jsonl', 'interrupted-sigterm-tool.jsonl', 'interrupted-sigint-generation.jsonl'];

test('pi events: every recording normalises to Claude-shaped events, with no system prompt and one init first', () => {
  for (const name of fs.readdirSync(FIXTURES).filter(f => f.endsWith('.jsonl') && f !== 'session-file-v3-tool-use.jsonl')) {
    const { events } = normalise(name);
    for (const e of events) {
      assert.ok(['system', 'stream_event', 'assistant', 'user', 'result'].includes(e.type), `${name}: ${e.type}`);
      assert.ok(e.type !== 'system' || e.subtype === 'init', `${name}: only init is a system event`);
      assert.ok(!JSON.stringify(e).includes('<preamble elided>'), `${name}: pi's system prompt leaked`);
    }
    if (events.length) {
      assert.equal(events[0].type, 'system', name);
      assert.equal(ofType(events, 'system').length, 1, name);
      assert.equal(events[0].engine, 'pi');
    }
  }
});

test('pi events: a plain answer is init, live text, the assistant message and a success result', () => {
  const { n, events } = normalise('success.jsonl');
  const header = JSON.parse(piLines('success.jsonl')[0]);
  assert.deepEqual(events[0], { type: 'system', subtype: 'init', session_id: header.id, cwd: header.cwd, engine: 'pi' });
  const [assistant] = ofType(events, 'assistant');
  assert.equal(assistant.message.model, 'fireworks/glm-5.3-flash');
  const text = assistant.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  assert.match(text, /STATUS: done/);
  const result = resultOf(events);
  assert.equal(result.subtype, 'success');
  assert.equal(result.is_error, false);
  assert.equal(result.result, text);
  assert.equal(result.session_id, header.id);
  assert.equal(result.num_turns, 1);
  // The broker reports a cost, and it is zero.
  assert.equal(result.total_cost_usd, 0);
  assert.equal(n.settled, true);
  assert.deepEqual(n.end({ code: 0 }), [], 'a settled run owes nothing at exit');
});

test('pi events: the live text of each message adds up to its final text, under the same message id', () => {
  for (const name of FINISHED) {
    const { events } = normalise(name);
    let id = null;
    let byIndex = {};
    for (const e of events) {
      if (e.type === 'stream_event' && e.event.type === 'message_start') { id = e.event.message.id; byIndex = {}; }
      if (e.type === 'stream_event' && e.event.type === 'content_block_start' && e.event.content_block.type === 'text') byIndex[e.event.index] = '';
      if (e.type === 'stream_event' && e.event.type === 'content_block_delta' && e.event.delta.type === 'text_delta') byIndex[e.event.index] += e.event.delta.text;
      if (e.type === 'assistant') {
        assert.equal(e.message.id, id, `${name}: the final message keeps the streamed id`);
        const texts = e.message.content.filter(b => b.type === 'text').map(b => b.text);
        assert.deepEqual(Object.values(byIndex), texts, name);
      }
    }
  }
  const ids = ofType(normalise('tool-use-space-put.jsonl').events, 'assistant').map(e => e.message.id);
  assert.equal(new Set(ids).size, ids.length, 'each message its own id');
});

test('pi events: tool calls are tool_use with their arguments, and each result answers its call', () => {
  const { events } = normalise('tool-use-space-put.jsonl');
  const uses = toolUses(events);
  assert.deepEqual(uses.map(u => u.name), ['write', 'bash', 'bash']);
  assert.deepEqual(uses[0].input, { path: 'pi-wrote-this.txt', content: 'written by pi on fireworks (spike-pi)' });
  assert.match(uses[2].input.command, /^termag space put /);
  const results = toolResults(events);
  assert.deepEqual(results.map(r => r.tool_use_id), uses.map(u => u.id));
  assert.ok(results.every(r => r.is_error === false));
  assert.match(results[2].content, /\(48 B\)/);
  // Live: the tool card opens with its id and name, and its input streams in.
  const starts = ofType(events, 'stream_event').filter(e => e.event.type === 'content_block_start' && e.event.content_block.type === 'tool_use');
  assert.deepEqual(starts.map(e => e.event.content_block.id), uses.map(u => u.id));
  // Each tool result comes after its call and before the next message.
  const order = events.filter(e => e.type === 'assistant' || e.type === 'user').map(e => e.type);
  assert.deepEqual(order, ['assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  const result = resultOf(events);
  assert.match(result.result, /^The upload printed/);
  assert.match(result.result, /STATUS: done /);
  assert.equal(result.num_turns, 4);
  const sum = piUsage('tool-use-space-put.jsonl');
  assert.deepEqual(result.usage, { input_tokens: sum.input, output_tokens: sum.output, cache_read_input_tokens: sum.cacheRead, cache_creation_input_tokens: sum.cacheWrite });
  assert.ok(result.usage.input_tokens > 0);
  // Per message too, for the context ring.
  const first = ofType(events, 'assistant')[0];
  assert.deepEqual(first.message.usage, { input_tokens: 2736, output_tokens: 45, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
});

test('pi events: a resume by --session-id or --continue is the same session, and only this run\'s messages', () => {
  for (const name of ['resumed-session-id.jsonl', 'resumed-continue.jsonl']) {
    const { events } = normalise(name);
    assert.equal(events[0].session_id, SESSION, name);
    assert.equal(resultOf(events).session_id, SESSION, name);
    assert.equal(resultOf(events).is_error, false, name);
    assert.equal(ofType(events, 'assistant').length, 1, `${name}: no history replayed`);
  }
  assert.equal(normalise('tool-use-space-put.jsonl').events[0].session_id, SESSION);
});

test('pi events: a model error exits 0 and is a failed result carrying pi\'s message', () => {
  const { n, events } = normalise('error-bad-model.jsonl');
  assert.equal(ofType(events, 'assistant').length, 0, 'the failed message has no content to show');
  const result = resultOf(events);
  assert.equal(result.type, 'result');
  assert.equal(result.subtype, 'error');
  assert.equal(result.is_error, true);
  assert.match(result.result, /^403: .*not in the trusted launch catalog/);
  assert.deepEqual(n.end({ code: 0 }), []);
});

test('pi events: a launcher that fails before pi starts writes nothing, and the exit says why', () => {
  const { n, events } = normalise('error-sso-missing.jsonl');
  assert.deepEqual(events, []);
  // chat-turn.js writes the runner-error, from stderr, for a non-zero exit.
  assert.deepEqual(n.end({ code: 1 }), []);
  assert.deepEqual(createPiNormalizer().end({ code: 75 }), []);
});

test('pi events: a stopped run has no result; a stop is no failure, and pi exiting 0 unsettled is one', () => {
  for (const name of STOPPED) {
    const { events } = normalise(name);
    assert.equal(resultOf(events), undefined, name);
    assert.deepEqual(normalise(name).n.end({ code: 143, interrupted: true }), [], name);
    assert.deepEqual(normalise(name).n.end({ code: null, interrupted: true }), [], name);
    const [owed] = normalise(name).n.end({ code: 0 });
    assert.equal(owed.is_error, true, name);
    assert.match(owed.result, /exited before it finished/);
  }
  // The tool call was made, its result never came.
  const tool = normalise('interrupted-sigterm-tool.jsonl').events;
  assert.equal(toolUses(tool).length, 1);
  assert.equal(toolResults(tool).length, 0);
  // A recording note (`_fixture_note`) is not a pi event.
  assert.ok(raw('interrupted-sigint-generation.jsonl').includes('_fixture_note'));
});

test('pi events: the read-only tier\'s run lists only read tools and says it is blocked', () => {
  const { events } = normalise('readonly-write-refused.jsonl');
  assert.deepEqual(toolUses(events).map(u => u.name), ['ls']);
  assert.match(resultOf(events).result, /STATUS: blocked/);
  assert.equal(resultOf(events).is_error, false);
});

test('pi events: thinking stays out of the live text and is a thinking block in the message', () => {
  const { events } = normalise('thinking-off.jsonl');
  const [assistant] = ofType(events, 'assistant');
  assert.deepEqual(assistant.message.content.map(b => b.type), ['thinking', 'text']);
  assert.ok(!ofType(events, 'stream_event').some(e => e.event.delta?.type === 'thinking_delta'));
  assert.doesNotMatch(resultOf(events).result, /^The user/);
});

test('pi events: a failed retry is the turn\'s error, a later good answer clears it, and junk lines are skipped', () => {
  const n = createPiNormalizer();
  assert.deepEqual(n.push('not json'), []);
  assert.deepEqual(n.push(''), []);
  assert.deepEqual(n.push('{"no":"type"}'), []);
  n.push(JSON.stringify({ type: 'auto_retry_end', success: false, finalError: '502: broker_error' }));
  assert.equal(n.push(JSON.stringify({ type: 'agent_settled' }))[0].result, '502: broker_error');
  assert.deepEqual(n.push(JSON.stringify({ type: 'agent_settled' })), [], 'one result per run');

  const m = createPiNormalizer();
  m.push(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'boom' } }));
  m.push(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' } }));
  const [result] = m.push(JSON.stringify({ type: 'agent_settled' }));
  assert.equal(result.is_error, false);
  assert.equal(result.result, 'ok');
  assert.equal(result.total_cost_usd, null, 'no cost reported is null, not 0');
});

test('pi events: chat-turn\'s pipe gives the same events however stdout is chunked, and keeps pi\'s own lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pipe-'));
  const text = raw('tool-use-space-put.jsonl');
  const run = (chunkSize) => {
    const events = path.join(dir, `events-${chunkSize}.jsonl`);
    const rawFile = path.join(dir, `raw-${chunkSize}.jsonl`);
    const pipe = createPiPipe(events, rawFile, createPiNormalizer({ now: () => 1000 }));
    for (let i = 0; i < text.length; i += chunkSize) pipe.write(text.slice(i, i + chunkSize));
    pipe.close();
    return { events: fs.readFileSync(events, 'utf8'), raw: fs.readFileSync(rawFile, 'utf8') };
  };
  const whole = run(text.length);
  const bits = run(7);
  assert.equal(bits.events, whole.events);
  assert.equal(whole.raw.split('\n').filter(Boolean).length, piLines('tool-use-space-put.jsonl').length);
  const expected = normalise('tool-use-space-put.jsonl').events.map(e => JSON.stringify(e)).join('\n');
  assert.equal(whole.events.trim(), expected);
});

test('pi session: the session file is the chat\'s history, as Claude-shaped entries', () => {
  const entries = piHistoryEntries(raw('session-file-v3-tool-use.jsonl'));
  assert.ok(!entries.some(e => JSON.stringify(e).includes('<preamble elided>')), 'no system prompt');
  const prompts = entries.filter(e => e.type === 'user' && e.message.content[0].type === 'text');
  assert.equal(prompts.length, 3);
  assert.match(prompts[0].message.content[0].text, /^You are in a scratch directory/);
  assert.equal(prompts[0].uuid, '714d9b2f');
  const uses = entries.filter(e => e.type === 'assistant').flatMap(e => e.message.content.filter(b => b.type === 'tool_use'));
  const results = entries.filter(e => e.type === 'user').flatMap(e => e.message.content.filter(b => b.type === 'tool_result'));
  assert.deepEqual(uses.map(u => u.name), ['write', 'bash', 'bash']);
  assert.deepEqual(results.map(r => r.tool_use_id), uses.map(u => u.id));
  const last = entries.at(-1);
  assert.equal(last.type, 'assistant');
  assert.equal(last.message.id, last.uuid);
  assert.match(last.message.content.find(b => b.type === 'text').text, /STATUS: done continued/);
  assert.ok(Number.isFinite(last.message.usage.input_tokens));
  assert.equal(last.message.usage.output_tokens, undefined, 'only the prompt size, as historyEntries keeps');
  assert.equal(piHistoryEntries(raw('session-file-v3-tool-use.jsonl'), 2).length, 2);
  assert.equal(piUserEntryId(raw('session-file-v3-tool-use.jsonl')), '714d9b2f');
  assert.equal(piUserEntryId(''), null);
});

test('pi session: found by id under any cwd, and moved to a renamed checkout\'s directory', () => {
  assert.equal(piSessionSlug('/tmp/sdk/wd'), '--tmp-sdk-wd--');
  assert.equal(piSessionSlug('/home/u/a:b'), '--home-u-a-b--');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-'));
  assert.equal(findPiSession(home, SESSION), null);
  const dir = path.join(home, '.pi/agent/sessions', piSessionSlug('/w/old'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-10-26T17-43-51-235Z_${SESSION}.jsonl`);
  fs.writeFileSync(file, raw('session-file-v3-tool-use.jsonl'));
  assert.equal(findPiSession(home, SESSION), file);
  assert.equal(findPiSession(home, '../etc'), null);
  rehomePiSession(home, SESSION, '/w/new');
  const moved = findPiSession(home, SESSION);
  assert.equal(moved, path.join(home, '.pi/agent/sessions', '--w-new--', path.basename(file)));
  rehomePiSession(home, SESSION, '/w/new');
  assert.equal(findPiSession(home, SESSION), moved);
  rehomePiSession(home, 'aaaaaaaa-0000-0000-0000-000000000000', '/w/x');
});
