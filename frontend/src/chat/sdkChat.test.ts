import { describe, expect, it } from 'vitest';
import {
  addPending, alignTurnCosts, applyEvent, applyFrame, chatCostTotal, chatStatus, commandLine, emptyChat, errorHint, formatCost, formatDuration, frameDisposition, fromHistory, groupTurns,
  lastAssistantText, liveFrameAction, localCommand, mergeHistory, resultText, retryText, sdkReadiness, seedLiveTurn, sendGoesLive, shortPath, stopControl, stopTitle, toolSummary, turnMeta, type ChatState,
} from './sdkChat';

const run = (events: unknown[], from: ChatState = emptyChat) => events.reduce<ChatState>(applyEvent, from);
const se = (event: object) => ({ type: 'stream_event', event });

// One real-shaped turn: Claude Code's stream-json with --include-partial-messages.
const turn = [
  { type: 'turn-start', text: 'what is in here?' },
  { type: 'system', subtype: 'init', session_id: 'sess-1' },
  se({ type: 'message_start', message: { id: 'm1' } }),
  se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } }),
  se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'look.' } }),
  se({ type: 'content_block_stop', index: 0 }),
  { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Let me look.' }] } },
  se({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } }),
  se({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } }),
  se({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ls -la"}' } }),
  se({ type: 'content_block_stop', index: 1 }),
  { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }] } },
  se({ type: 'message_stop' }),
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'README.md\nsrc', is_error: false }] } },
  se({ type: 'message_start', message: { id: 'm2' } }),
  se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '## Layout\n' } }),
];

describe('applyEvent: a live turn', () => {
  it('shows the prompt, streams text, fills the tool card from its input deltas and its result', () => {
    const s = run(turn);
    expect(s.sessionId).toBe('sess-1');
    expect(s.running).toBe(true);
    expect(s.items.map(i => i.kind)).toEqual(['user', 'text', 'tool', 'text']);
    expect(s.items[1]).toMatchObject({ kind: 'text', text: 'Let me look.', streaming: false });
    expect(s.items[2]).toMatchObject({ kind: 'tool', name: 'Bash', input: { command: 'ls -la' }, result: 'README.md\nsrc', done: true });
    expect(s.items[3]).toMatchObject({ kind: 'text', text: '## Layout\n', streaming: true });
    expect(chatStatus(s)).toEqual({ tone: 'working', text: 'Writing…' });
  });

  it('says which tool runs while it runs', () => {
    const s = run(turn.slice(0, 13));
    expect(chatStatus(s)).toEqual({ tone: 'working', text: 'Running Bash · ls -la' });
  });

  it('replaces the streamed text with the final block and rests at the turn end', () => {
    const s = run([
      ...turn,
      se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '- src' } }),
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: '## Layout\n- src/' }] } },
      { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01 },
      { type: 'turn-end', exitCode: 0 },
    ]);
    expect(s.items.filter(i => i.kind === 'text').map(i => i.kind === 'text' && i.text)).toEqual(['Let me look.', '## Layout\n- src/']);
    expect(s.running).toBe(false);
    expect(chatCostTotal(s)).toBeCloseTo(0.01);
    expect(chatStatus(s)).toEqual({ tone: 'idle', text: 'Done · your turn' });
  });

  it('matches the pending bubble to its turn instead of adding a second one', () => {
    const pending = addPending(emptyChat, 'what is in here?');
    expect(pending.items[0]).toMatchObject({ kind: 'user', pending: true });
    const s = applyEvent(pending, turn[0]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: 'user', text: 'what is in here?', pending: false });
  });

  it('closes a tool cut off by a stopped turn and says so neutrally, not as an error', () => {
    const s = run([
      ...turn.slice(0, 13),
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Interrupted' },
      { type: 'turn-end', exitCode: 130 },
    ]);
    expect(s.items.find(i => i.kind === 'tool')).toMatchObject({ done: true, result: null });
    expect(s.items.some(i => i.kind === 'error')).toBe(false);
    expect(s.items[s.items.length - 1]).toMatchObject({ kind: 'note', text: 'Stopped by you' });
    expect(chatStatus(s)).toEqual({ tone: 'idle', text: 'Stopped · your turn' });
  });

  it('a Stop pressed here keeps whatever error text Claude ends with out of the chat', () => {
    let s = run(turn.slice(0, 13));
    s = applyEvent(s, { type: 'user-stop' });
    expect(s.stopRequested).toBe(true);
    s = run([
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Request was aborted' },
      { type: 'turn-end', exitCode: 1, signal: null },
    ], s);
    expect(s.items.map(i => i.kind).slice(-1)).toEqual(['note']);
    expect(s.stopRequested).toBe(false);
    expect(applyEvent(emptyChat, { type: 'user-stop' })).toBe(emptyChat);
  });

  it('a turn that really failed still shows its error', () => {
    const s = run([
      { type: 'turn-start', text: 'go' },
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 overloaded' },
      { type: 'turn-end', exitCode: 1 },
    ]);
    expect(s.items[s.items.length - 1]).toMatchObject({ kind: 'error', text: 'API Error: 529 overloaded' });
    expect(chatStatus(s).tone).toBe('error');
  });

  it('takes down the bubbles of messages Stop dropped from the queue, and only those', () => {
    let s = run([{ type: 'turn-start', text: 'first' }]);
    s = addPending(addPending(addPending(s, 'second'), 'third'), 'second');
    s = applyEvent(s, { type: 'queue-dropped', texts: ['second', 'third'] });
    expect(s.items.map(i => i.kind === 'user' && `${i.text}${i.pending ? '*' : ''}`)).toEqual(['first', 'second*']);
    expect(applyEvent(s, { type: 'queue-dropped', texts: 'nope' })).toBe(s);
  });

  it('shows a runner failure, settles running (a failed spawn may send no turn-end), and ignores unknown events', () => {
    const s = run([{ type: 'turn-start', text: 'x' }, { type: 'mystery' }, null, { type: 'runner-error', message: 'Claude exited 1: not logged in' }]);
    expect(s.items.map(i => i.kind)).toEqual(['user', 'error']);
    expect(s.running).toBe(false);
    expect(s.phase).toBe('idle');
  });
});

describe('fromHistory: the transcript', () => {
  it('rebuilds prompts, text and tool cards from transcript entries', () => {
    const s = fromHistory([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'what is in here?' } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Let me look.' }] } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/README.md' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '# Demo' }] }] } },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'It is a demo.' }] } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'text', text: 'thanks' }] } },
    ], 'sess-1');
    expect(s.sessionId).toBe('sess-1');
    expect(s.running).toBe(false);
    expect(s.items.map(i => i.kind)).toEqual(['user', 'text', 'tool', 'text', 'user']);
    expect(s.items[2]).toMatchObject({ kind: 'tool', name: 'Read', result: '# Demo', done: true });
    expect(s.items[4]).toMatchObject({ kind: 'user', text: 'thanks' });
  });

  it('then takes the live turn on top without duplicating its prompt', () => {
    const history = fromHistory([{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }]);
    const s = run([{ type: 'turn-start', text: 'next' }, { type: 'user', message: { content: 'next' } }], history);
    expect(s.items.map(i => i.kind === 'user' && i.text)).toEqual(['hi', 'next']);
  });
});

describe('toolSummary and resultText', () => {
  it('names each tool by its main argument', () => {
    expect(toolSummary('Bash', { command: 'npm test' })).toEqual({ title: 'Bash', detail: 'npm test' });
    expect(toolSummary('Edit', { file_path: '/w/a.ts', old_string: 'x' })).toEqual({ title: 'Edit', detail: '/w/a.ts' });
    expect(toolSummary('TodoWrite', { todos: [{}, {}] })).toEqual({ title: 'Todos', detail: '2 items' });
    expect(toolSummary('mcp__metaterm__list_sessions', { roles: 'agent' })).toEqual({ title: 'mcp__metaterm__list_sessions', detail: 'agent' });
    expect(toolSummary('Glob', null)).toEqual({ title: 'Glob', detail: null });
    expect(toolSummary('Read', { file_path: '/home/u/termag/projects/web/src/app.ts' })).toEqual({ title: 'Read', detail: 'src/app.ts' });
  });

  it('shows paths inside a checkout relative to it', () => {
    expect(shortPath('/home/u/termag/projects/web/README.md')).toBe('README.md');
    expect(shortPath('/home/u/termag/projects/web/.worktrees/tui/src/a.ts')).toBe('src/a.ts');
    expect(shortPath('/etc/hosts')).toBe('/etc/hosts');
  });

  it('reads tool output as text and caps it', () => {
    expect(resultText('ok')).toBe('ok');
    expect(resultText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('a\n[image]\nb');
    expect(resultText(undefined)).toBe('');
    expect(resultText('x'.repeat(20_010))).toMatch(/… \(10 more characters\)$/);
  });
});

describe('sdkReadiness', () => {
  const at = (o: Partial<Parameters<typeof sdkReadiness>[0]>) => sdkReadiness({ held: false, history: 'ok', checkoutReady: true, queued: false, ...o });

  it('is ready once set up, answered and checked out', () => {
    expect(at({})).toEqual({ runnerReady: true, pollHistory: false, showSteps: false });
  });

  it('waits for a pane clone: not ready, asks again, keeps the steps up', () => {
    expect(at({ checkoutReady: false })).toEqual({ runnerReady: false, pollHistory: true, showSteps: true });
  });

  it('waits for setup without asking the box while the project is held', () => {
    expect(at({ held: true, history: 'loading' })).toEqual({ runnerReady: false, pollHistory: false, showSteps: true });
    expect(at({ history: 'setup' })).toMatchObject({ runnerReady: false, pollHistory: true });
  });

  it('keeps the steps while a first message waits, and drops them on an error the steps cannot explain', () => {
    expect(at({ queued: true }).showSteps).toBe(true);
    expect(at({ history: 'error' })).toEqual({ runnerReady: false, pollHistory: false, showSteps: false });
  });
});

describe('mergeHistory', () => {
  const entries = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'what is in here?' } },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Let me look.' }] } },
  ];

  it('lets a turn end that arrived while history loaded win over the stale running', () => {
    const s = mergeHistory({ entries, sessionId: 's', running: true }, [
      { type: 'result', subtype: 'success', is_error: false },
      { type: 'turn-end', exitCode: 0 },
    ]);
    expect(s.running).toBe(false);
    expect(chatStatus(s).text).toBe('Done · your turn');
  });

  it('keeps live stream events instead of wiping them, without duplicating what the snapshot has', () => {
    const s = mergeHistory({ entries, sessionId: 's', running: true }, [
      { type: 'turn-start', text: 'what is in here?' },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Let me look.' }] } },
      se({ type: 'message_start', message: { id: 'm2' } }),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Found it' } }),
    ]);
    expect(s.items.map(i => i.kind)).toEqual(['user', 'text', 'text']);
    expect(s.items[2]).toMatchObject({ text: 'Found it', streaming: true });
    expect(s.running).toBe(true);
  });

  it('does not repeat the streamed text of a message the snapshot already holds', () => {
    const s = mergeHistory({ entries, sessionId: 's', running: true }, [
      se({ type: 'message_start', message: { id: 'm1' } }),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me look.' } }),
      se({ type: 'content_block_stop', index: 0 }),
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Let me look.' }] } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    ]);
    expect(s.items.map(i => (i.kind === 'text' ? i.text : i.kind))).toEqual(['user', 'Let me look.', 'tool']);
  });

  it('is the snapshot when nothing arrived meanwhile', () => {
    expect(mergeHistory({ entries, sessionId: 's', running: false }, [])).toEqual(fromHistory(entries, 's'));
  });

  it('keeps the runner\'s turn costs on the snapshot', () => {
    const s = mergeHistory({
      entries, sessionId: 's', running: false,
      turns: [{ turnId: 'a', userUuid: 'u1', prompt: 'what is in here?', costUsd: 0.04, durationMs: 12000 }],
    }, []);
    expect(s.costs['user:u1']).toEqual({ costUsd: 0.04, durationMs: 12000 });
    expect(chatCostTotal(s)).toBeCloseTo(0.04);
  });

  it('does not let a later identical prompt take the earlier reply\'s cost', () => {
    const s = mergeHistory({
      entries, sessionId: 's', running: false,
      turns: [{ turnId: 'a', userUuid: 'u1', prompt: 'what is in here?', costUsd: 0.04, durationMs: 12000 }],
    }, [
      { type: 'turn-start', text: 'what is in here?', live: true },
      { type: 'user', isReplay: true, uuid: 'u2', message: { role: 'user', content: 'what is in here?' } },
      { type: 'turn-end', exitCode: 0, costUsd: 0.02, durationMs: 3000 },
    ]);
    const users = s.items.filter(i => i.kind === 'user');
    expect(users.map(i => i.text)).toEqual(['what is in here?', 'what is in here?']);
    expect(s.costs['user:u1']).toEqual({ costUsd: 0.04, durationMs: 12000 });
    expect(s.costs['user:u2']).toEqual({ costUsd: 0.02, durationMs: 3000 });
    expect(chatCostTotal(s)).toBeCloseTo(0.06);
  });

  it('does not replace an answered prompt\'s cost when a turn-end arrives with no key', () => {
    const s = mergeHistory({
      entries, sessionId: 's', running: true,
      turns: [{ turnId: 'a', userUuid: 'u1', prompt: 'what is in here?', costUsd: 0.04, durationMs: 12000 }],
    }, [
      { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 1000 },
      { type: 'turn-end', exitCode: 0, costUsd: null, durationMs: 1000 },
    ]);
    expect(s.running).toBe(false);
    expect(s.costs['user:u1']).toEqual({ costUsd: 0.04, durationMs: 12000 });
    expect(chatCostTotal(s)).toBeCloseTo(0.04);
  });
});

describe('turn costs', () => {
  it('pins a live turn\'s cost to its prompt from the runner\'s turn-end', () => {
    const s = run([
      { type: 'turn-start', text: 'one' },
      { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.03, duration_ms: 9000 },
      { type: 'turn-end', exitCode: 0, costUsd: 0.04, durationMs: 12000 },
      { type: 'turn-start', text: 'two' },
      { type: 'turn-end', exitCode: 1, costUsd: null, durationMs: 800 },
    ]);
    const [u1, u2] = s.items.filter(i => i.kind === 'user').map(i => i.key);
    expect(s.costs[u1]).toEqual({ costUsd: 0.04, durationMs: 12000 });
    expect(s.costs[u2]).toEqual({ costUsd: null, durationMs: 800 });
    expect(chatCostTotal(s)).toBeCloseTo(0.04);
  });

  it('falls back to the result\'s numbers from an agent without turn-end costs', () => {
    const s = run([
      { type: 'turn-start', text: 'one' },
      { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.02, duration_ms: 3000 },
      { type: 'turn-end', exitCode: 0 },
    ]);
    expect(Object.values(s.costs)).toEqual([{ costUsd: 0.02, durationMs: 3000 }]);
  });

  it('rebuilds the costs from the records after a reload, and counts unmatched ones in the total', () => {
    const entries = [
      { type: 'user', uuid: 'u1', message: { content: 'how do I run the tests?' } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'npm test' }] } },
      { type: 'user', uuid: 'u2', message: { content: 'and CI?' } },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Add a workflow' }] } },
    ];
    const s = fromHistory(entries, 'sess-1', null, [
      { turnId: 'a', userUuid: 'u1', prompt: 'how do I run the tests?', costUsd: 0.04, durationMs: 12000 },
      { turnId: 'x', prompt: 'a turn whose prompt never reached the transcript', costUsd: 0.01, durationMs: 400 },
      { turnId: 'b', userUuid: 'u2', prompt: 'and CI?', costUsd: 0.02, durationMs: 5000 },
    ]);
    expect(s.costs['user:u1']).toEqual({ costUsd: 0.04, durationMs: 12000 });
    expect(s.costs['user:u2']).toEqual({ costUsd: 0.02, durationMs: 5000 });
    expect(s.extraCostUsd).toBeCloseTo(0.01);
    expect(chatCostTotal(s)).toBeCloseTo(0.07);
  });

  it('does not charge a terminal turn that repeats a later runner prompt', () => {
    const s = fromHistory([
      { type: 'user', uuid: 'term', message: { content: 'go' } },
      { type: 'assistant', message: { id: 'm0', content: [{ type: 'text', text: 'done' }] } },
      { type: 'user', uuid: 'chat', message: { content: 'go' } },
    ], 'sess-1', null, [
      { turnId: 'a', userUuid: 'chat', prompt: 'go', costUsd: 0.04, durationMs: 1000 },
    ]);
    expect(s.costs['user:term']).toBeUndefined();
    expect(s.costs['user:chat']).toEqual({ costUsd: 0.04, durationMs: 1000 });
    expect(chatCostTotal(s)).toBeCloseTo(0.04);
  });

  it('does not pin an older cost onto a later visible repeat of the same prompt', () => {
    const s = fromHistory([
      { type: 'user', uuid: 'late', message: { content: 'go' } },
      { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'ok' }] } },
    ], 'sess-1', null, [
      { turnId: 'old', userUuid: 'early', prompt: 'go', costUsd: 0.01, durationMs: 1000 },
      { turnId: 'new', userUuid: 'late', prompt: 'go', costUsd: 0.02, durationMs: 2000 },
    ]);
    expect(s.costs['user:late']).toEqual({ costUsd: 0.02, durationMs: 2000 });
    expect(s.extraCostUsd).toBeCloseTo(0.01);
    expect(chatCostTotal(s)).toBeCloseTo(0.03);
    const both = alignTurnCosts(
      [{ key: 'a', uuid: 'early' }, { key: 'b', uuid: 'late' }],
      [
        { turnId: 'old', userUuid: 'early', prompt: 'go', costUsd: 0.01, durationMs: 1 },
        { turnId: 'new', userUuid: 'late', prompt: 'go', costUsd: 0.02, durationMs: 2 },
      ],
    );
    expect(both.costs).toEqual({ a: { costUsd: 0.01, durationMs: 1 }, b: { costUsd: 0.02, durationMs: 2 } });
    expect(both.extraCostUsd).toBe(0);
  });

  it('keeps a replayed turn\'s cost once, beside earlier records', () => {
    const recorded = fromHistory(
      [{ type: 'user', uuid: 'u0', message: { content: 'earlier' } }],
      'sess-1',
      { turnId: 't9', events: [
        { seq: 1, event: { type: 'turn-start', text: 'hello' } },
        { seq: 2, event: { type: 'result', is_error: false, total_cost_usd: 0.04, duration_ms: 1000 } },
        { seq: 3, event: { type: 'turn-end', exitCode: null, lost: true, costUsd: 0.04, durationMs: 1000 } },
      ] },
      [
        { turnId: 'a', userUuid: 'u0', prompt: 'earlier', costUsd: 0.05, durationMs: 1000 },
        { turnId: 't9', userUuid: 'hello-id', prompt: 'hello', costUsd: 0.04, durationMs: 1000 },
      ],
    );
    expect(chatCostTotal(recorded)).toBeCloseTo(0.09);
    expect(recorded.extraCostUsd).toBe(0);
    const pending = fromHistory(
      [{ type: 'user', uuid: 'u0', message: { content: 'earlier' } }],
      'sess-1',
      { turnId: 't9', events: [
        { seq: 1, event: { type: 'turn-start', text: 'hello' } },
        { seq: 2, event: { type: 'result', is_error: false, total_cost_usd: 0.02, duration_ms: 500 } },
        { seq: 3, event: { type: 'turn-end', exitCode: null, lost: true } },
      ] },
      [{ turnId: 'a', userUuid: 'u0', prompt: 'earlier', costUsd: 0.05, durationMs: 1000 }],
    );
    expect(chatCostTotal(pending)).toBeCloseTo(0.07);
  });

  it('has no total before any turn reported a cost', () => {
    expect(chatCostTotal(emptyChat)).toBeNull();
  });
});

describe('cost and duration formats', () => {
  it('formats money', () => {
    expect(formatCost(0.0412)).toBe('$0.04');
    expect(formatCost(0.001)).toBe('<$0.01');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(12.3)).toBe('$12.30');
  });
  it('formats time', () => {
    expect(formatDuration(300)).toBe('<1s');
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(185_000)).toBe('3m 5s');
    expect(formatDuration(120_000)).toBe('2m');
    expect(formatDuration(3_720_000)).toBe('1h 2m');
  });
  it('joins what is known into the reply footnote', () => {
    expect(turnMeta({ costUsd: 0.04, durationMs: 12_000 })).toBe('$0.04 · 12s');
    expect(turnMeta({ costUsd: null, durationMs: 800 })).toBe('<1s');
    expect(turnMeta({ costUsd: null, durationMs: null })).toBeNull();
    expect(turnMeta(undefined)).toBeNull();
  });
});

describe('groupTurns', () => {
  it('groups each prompt\'s reply items under it', () => {
    const groups = groupTurns([
      { kind: 'text', key: 'pre', text: 'resumed', streaming: false },
      { kind: 'user', key: 'u1', text: 'one' },
      { kind: 'text', key: 't1', text: 'a', streaming: false },
      { kind: 'error', key: 'e1', text: 'stopped' },
      { kind: 'user', key: 'u2', text: 'two' },
    ]);
    expect(groups.map(g => (g.kind === 'user' ? `user:${g.item.key}` : `reply:${g.userKey}:${g.items.length}`)))
      .toEqual(['reply:null:1', 'user:u1', 'reply:u1:2', 'user:u2']);
  });
});

describe('numbered frames (durable turns)', () => {
  it('buffers a later frame while the first history load is still out', () => {
    const frame = { turnId: 't1', seq: 5, event: { type: 'assistant', message: { id: 'm', content: [] } } };
    expect(liveFrameAction(true, { turnId: null, seq: 0 }, frame)).toBe('buffer');
    expect(liveFrameAction(false, { turnId: null, seq: 0 }, frame)).toBe('gap');
    expect(liveFrameAction(false, { turnId: null, seq: 0 }, { turnId: 't1', seq: 1, event: { type: 'queue-parked' } })).toBe('parked');
  });

  it('folds the next line in, skips what it has, and notes a gap', () => {
    expect(frameDisposition({ turnId: null, seq: 0 }, 't1', 1)).toBe('apply');
    expect(frameDisposition({ turnId: 't1', seq: 4 }, 't1', 5)).toBe('apply');
    expect(frameDisposition({ turnId: 't1', seq: 4 }, 't1', 3)).toBe('skip');
    expect(frameDisposition({ turnId: 't1', seq: 4 }, 't1', 7)).toBe('gap');
    expect(frameDisposition({ turnId: 't1', seq: 9 }, 't2', 1)).toBe('apply');
    expect(frameDisposition({ turnId: 't1', seq: 9 }, 't2', 3)).toBe('gap');
    expect(frameDisposition({ turnId: 't1', seq: 9 }, null, null)).toBe('apply');
  });

  it('a frame resent after an agent restart changes nothing', () => {
    const a = applyFrame(emptyChat, { turnId: 't1', seq: 1, event: { type: 'turn-start', text: 'hi' } }).state;
    const again = applyFrame(a, { turnId: 't1', seq: 1, event: { type: 'turn-start', text: 'hi' } });
    expect(again.state).toBe(a);
    expect(again.gap).toBe(false);
    expect(applyFrame(a, { turnId: 't1', seq: 3, event: { type: 'turn-end' } }).gap).toBe(true);
  });

  it('history replays the running turn, and live frames continue from its last line', () => {
    const h = fromHistory(
      [{ type: 'user', message: { content: 'earlier' } }, { type: 'assistant', message: { id: 'm0', content: [{ type: 'text', text: 'done' }] } }],
      'sess-1',
      { turnId: 't2', events: [{ seq: 1, event: { type: 'turn-start', text: 'now' } }, { seq: 2, event: se({ type: 'message_start', message: { id: 'm1' } }) }] },
    );
    expect(h.running).toBe(true);
    expect(h.cursor).toEqual({ turnId: 't2', seq: 2 });
    expect(h.items.map(i => i.kind === 'user' ? i.text : i.kind)).toEqual(['earlier', 'text', 'now']);
    const live = applyFrame(h, { turnId: 't2', seq: 2, event: se({ type: 'message_start', message: { id: 'm1' } }) });
    expect(live.state).toBe(h);
    const next = applyFrame(h, { turnId: 't2', seq: 3, event: { type: 'turn-end', exitCode: 0 } });
    expect(next.state.running).toBe(false);
  });

  it('a capped replay starts where its lines start', () => {
    const h = fromHistory([], null, { turnId: 't3', events: [{ seq: 41, event: { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'late' }] } } }] });
    expect(h.cursor).toEqual({ turnId: 't3', seq: 41 });
    expect(h.items.map(i => i.kind)).toEqual(['text']);
  });
});

describe('retryText, errorHint and lastAssistantText', () => {
  const failed = run([
    { type: 'turn-start', text: 'fix it' },
    { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 {"type":"overloaded_error"}' },
    { type: 'turn-end', exitCode: 1 },
  ]);

  it('Retry resends the last prompt, only when the chat ended on an error', () => {
    expect(retryText(failed)).toBe('fix it');
    expect(retryText(run(turn))).toBeNull();
    expect(retryText({ ...failed, running: true })).toBeNull();
  });

  it('says in plain words when an error passes on its own', () => {
    expect(errorHint('API Error: 529 {"type":"overloaded_error"}')).toMatch(/overloaded/);
    expect(errorHint('API Error: 429 rate_limit_error')).toMatch(/rate-limited/);
    expect(errorHint('Claude stopped (error_max_turns)')).toBeNull();
  });

  it('previews the last thing Claude wrote as one plain line', () => {
    expect(lastAssistantText(run(turn).items)).toBe('Layout');
    expect(lastAssistantText([{ kind: 'text', key: 'a', text: '\n## **Done**: all `green`\nmore', streaming: false } as never])).toBe('Done: all green');
    expect(lastAssistantText([])).toBeNull();
  });
});

describe('applyEvent: a live turn takes messages in while it runs', () => {
  const replay = (text: string, uuid: string) => ({ type: 'user', isReplay: true, uuid, message: { role: 'user', content: text } });
  const answered = [
    { type: 'turn-start', text: 'start the ask', live: true },
    replay('start the ask', 'u1'),
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Asked; it runs in the background.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Asked; it runs in the background.' },
  ];

  it('shows its own prompt once, and waits after the answer while the turn stays open', () => {
    const s = run(answered);
    expect(s.items.filter(i => i.kind === 'user').map(i => i.text)).toEqual(['start the ask']);
    expect(s.running).toBe(true);
    expect(s.phase).toBe('waiting');
    expect(chatStatus(s, true)).toEqual({ tone: 'working', text: 'Waiting on background work · you can still send a message' });
    expect(sendGoesLive(s, true)).toBe(true);
  });

  it('invites a send only when the turn is live and this viewer\'s sends are', () => {
    const live = run(answered);
    expect(chatStatus(live, false).text).toBe('Waiting on background work · a message waits until it ends');
    expect(sendGoesLive(live, false)).toBe(false);
    const plain = run([{ type: 'turn-start', text: 'start the ask' }, ...answered.slice(2)]);
    expect(plain.phase).toBe('waiting');
    expect(chatStatus(plain, true).text).toBe('Waiting on background work · a message waits until it ends');
    expect(sendGoesLive(plain, true)).toBe(false);
    const ended = run([{ type: 'turn-end', exitCode: 0 }], live);
    expect(ended.liveTurn).toBe(false);
    expect(sendGoesLive(ended, true)).toBe(false);
  });

  it('keeps a live turn-start that arrived while the history loaded', () => {
    const entries = [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } }];
    const s = mergeHistory({ entries, sessionId: 's', running: true }, [{ type: 'turn-start', text: 'go', live: true }]);
    expect(s.items.filter(i => i.kind === 'user')).toHaveLength(1);
    expect(sendGoesLive(s, true)).toBe(true);
    const replayed = applyEvent(s, { type: 'user', isReplay: true, uuid: 'r1', message: { role: 'user', content: 'go' } });
    expect(replayed.items.filter(i => i.kind === 'user')).toHaveLength(1);
  });

  it('a replay of the prompt the history already holds adds nothing, answered or not', () => {
    const entries = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Started.' }] } },
    ];
    const s = mergeHistory({ entries, sessionId: 's', running: true }, [
      { type: 'turn-start', text: 'go', live: true },
      { type: 'user', isReplay: true, uuid: 'u1', message: { role: 'user', content: 'go' } },
    ]);
    expect(s.items.filter(i => i.kind === 'user').map(i => i.text)).toEqual(['go']);
  });

  it('a repeated prompt that starts while the history loads still shows, through its replay', () => {
    const entries = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'yes' } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Done.' }] } },
    ];
    const s = mergeHistory({ entries, sessionId: 's', running: false }, [
      { type: 'turn-start', text: 'yes', live: true },
      { type: 'user', isReplay: true, uuid: 'r2', message: { role: 'user', content: 'yes' } },
    ]);
    expect(s.items.filter(i => i.kind === 'user').map(i => i.text)).toEqual(['yes', 'yes']);
  });

  it('takes the history\'s word that a running turn is live when its log does not say', () => {
    const plain = run([{ type: 'turn-start', text: 'go' }]);
    expect(sendGoesLive(seedLiveTurn(plain, true), true)).toBe(true);
    expect(sendGoesLive(seedLiveTurn(plain, false), true)).toBe(false);
    expect(seedLiveTurn(emptyChat, true).liveTurn).toBeUndefined();
  });

  it('moves a message sent meanwhile from queued to where Claude read it', () => {
    let s = addPending(run(answered.slice(0, 3)), 'are you there?');
    expect(s.items[s.items.length - 1]).toMatchObject({ kind: 'user', pending: true });
    s = run([
      { type: 'result', subtype: 'success', is_error: false, result: 'Asked.' },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'One more thing first.' }] } },
      replay('are you there?', 'u2'),
    ], s);
    expect(s.items.map(i => (i.kind === 'user' ? `${i.text}${i.pending ? ' (queued)' : ''}` : i.kind))).toEqual(['start the ask', 'text', 'text', 'are you there?']);
    expect(s.phase).toBe('thinking');
    s = run([{ type: 'result', subtype: 'success', is_error: false, result: 'Yes.' }, { type: 'turn-end', exitCode: 0 }], s);
    expect(chatStatus(s).text).toBe('Done · your turn');
  });

  it('a transcript\'s user lines are not replays: an equal prompt later in a chat still shows', () => {
    const s = run([replay('go', 'u3'), { type: 'user', message: { content: 'go' } }]);
    expect(s.items.filter(i => i.kind === 'user')).toHaveLength(1);
  });

  it('a skill loaded mid-turn folds into its Skill call and leaves a queued message queued', () => {
    const body = 'Base directory for this skill: /home/u/.claude/skills/termag-spaces\n\n# termag spaces';
    let s = addPending(run(answered.slice(0, 2)), 'and then?');
    s = run([
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'termag-spaces' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'Launching skill: termag-spaces' }] } },
      { type: 'user', uuid: 'u4', isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: body }] } },
    ], s);
    expect(s.items.find(i => i.kind === 'tool')).toMatchObject({ name: 'Skill', skill: body });
    expect(s.items.filter(i => i.kind === 'user').map(i => `${i.text}${i.pending ? ' (queued)' : ''}`)).toEqual(['start the ask', 'and then? (queued)']);
  });
});

describe('applyEvent: a skill', () => {
  const body = 'Base directory for this skill: /home/u/.claude/skills/termag-spaces\n\n# termag spaces\n\nA space is a named file store.';
  const skillCall = [
    { type: 'turn-start', text: 'share a file' },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Loading the skill.' }, { type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'termag-spaces' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'Launching skill: termag-spaces' }] } },
  ];

  it('folds the SKILL.md Claude Code sends as a synthetic user message into its Skill call, never a bubble', () => {
    const s = run([...skillCall, { type: 'user', uuid: 'u2', isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: body }] } }]);
    expect(s.items.map(i => i.kind)).toEqual(['user', 'text', 'tool']);
    expect(s.items.filter(i => i.kind === 'user')).toHaveLength(1);
    expect(s.items[2]).toMatchObject({ kind: 'tool', name: 'Skill', result: 'Launching skill: termag-spaces', skill: body });
    expect(toolSummary('Skill', { skill: '/termag-spaces' })).toEqual({ title: 'Skill', detail: 'termag-spaces' });
  });

  it('reads it back from the transcript by the call id, and a live replay over that snapshot adds nothing', () => {
    const entries = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'share a file' } },
      skillCall[1], skillCall[2],
      { type: 'user', uuid: 'u2', isMeta: true, sourceToolUseID: 's1', message: { role: 'user', content: [{ type: 'text', text: body }] } },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Done.' }] } },
    ];
    const h = fromHistory(entries);
    expect(h.items.map(i => i.kind)).toEqual(['user', 'text', 'tool', 'text']);
    expect(h.items[2]).toMatchObject({ kind: 'tool', skill: body });
    const merged = mergeHistory({ entries, sessionId: 's', running: false }, [
      { type: 'user', uuid: 'u2', isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: body }] } },
    ]);
    expect(merged.items).toEqual(h.items);
  });

  it('shows a skill loaded with no Skill call as a skill row, and drops other synthetic text', () => {
    const s = run([
      { type: 'turn-start', text: '/termag-spaces' },
      { type: 'user', isSynthetic: true, message: { role: 'user', content: 'Caveat: the messages below were generated by the user.' } },
      { type: 'user', uuid: 'u3', isSynthetic: true, message: { role: 'user', content: body } },
    ]);
    expect(s.items.map(i => i.kind)).toEqual(['user', 'skill']);
    expect(s.items[1]).toEqual({ kind: 'skill', key: 'skill:u3', name: 'termag-spaces', text: body });
  });
});

describe('applyEvent: a local command (a mod\'s /reload-plugins)', () => {
  // As Claude Code 2.1 records one in a `claude -p` session: the caveat (isMeta,
  // so the runner drops it from history), the echo, and its output, which the
  // transcript keeps as a system entry and stream-json sends as a synthetic
  // assistant message.
  const echo = (uuid: string, name = 'reload-plugins', args = '') => ({
    type: 'user', uuid,
    message: { role: 'user', content: `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>` },
  });
  const refusal = (id: string) => ({
    type: 'assistant',
    message: { id, model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "/reload-plugins isn't available over a remote connection in this session." }] },
  });
  const lines = (s: ChatState) => s.items.map(i => (i.kind === 'command' ? commandLine(i) : `${i.kind}: ${'text' in i ? i.text : ''}`));

  it('reads an echo as its command, and anything with words of its own as no echo', () => {
    expect(localCommand('<command-name>/reload-plugins</command-name>\n<command-message>reload-plugins</command-message>\n<command-args></command-args>'))
      .toEqual({ name: 'reload-plugins', args: '', output: null });
    expect(localCommand('<command-name>/review</command-name><command-args>  pr  12 </command-args>')).toEqual({ name: 'review', args: 'pr 12', output: null });
    expect(localCommand("<local-command-stdout>/reload-plugins isn't available over a remote connection in this session.</local-command-stdout>"))
      .toEqual({ name: null, args: '', output: 'not available over a remote connection' });
    expect(localCommand('<local-command-caveat>Caveat: the messages below were generated by the user.</local-command-caveat>')).toEqual({ name: null, args: '', output: null });
    expect(localCommand('why does <command-name> show up in my session?')).toBeNull();
    expect(localCommand('plain words')).toBeNull();
  });

  it('shows a transcript echo as one line, never a bubble of raw tags', () => {
    const h = fromHistory([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hello.' }] } },
      echo('u2'),
    ]);
    expect(lines(h)).toEqual(['user: hi', 'text: Hello.', 'Ran /reload-plugins']);
    expect(h.items.some(i => i.kind === 'user' && /<command-/.test(i.text))).toBe(false);
    expect(chatStatus(h).text).toBe('Done · your turn');
  });

  it('joins the output to its echo, and folds eight of the same into one line', () => {
    const events: unknown[] = [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }];
    for (let i = 0; i < 8; i++) {
      events.push(
        echo(`e${i}`),
        { type: 'user', uuid: `o${i}`, message: { role: 'user', content: "<local-command-stdout>/reload-plugins isn't available over a remote connection in this session.</local-command-stdout>" } },
      );
    }
    expect(lines(run(events))).toEqual(['user: hi', 'Ran /reload-plugins: not available over a remote connection']);
  });

  it('shows a live refusal as the same line, not as Claude\'s words, and its repeats as nothing more', () => {
    const s = run([
      { type: 'turn-start', text: 'go' },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Done.' }] } },
      { type: 'result', subtype: 'success', result: 'Done.' },
      { type: 'turn-end' },
      refusal('r1'), { type: 'result', subtype: 'success', result: "/reload-plugins isn't available over a remote connection in this session." },
      refusal('r2'),
    ]);
    expect(lines(s)).toEqual(['user: go', 'text: Done.', 'Ran /reload-plugins: not available over a remote connection']);
    expect(lastAssistantText(s.items)).toBe('Done.');
  });

  it('keeps a synthetic assistant message that is not a refusal (an API error) as text', () => {
    const s = run([{ type: 'assistant', message: { id: 'm1', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 500' }] } }]);
    expect(lines(s)).toEqual(['text: API Error: 500']);
  });

  it('a command typed in this session keeps its bubble and adds no line; a different one after it does', () => {
    const s = run([
      { type: 'turn-start', text: '/review pr 12' },
      echo('u1', 'review', 'pr 12'),
      echo('u2', 'reload-plugins'),
    ]);
    expect(lines(s)).toEqual(['user: /review pr 12', 'Ran /reload-plugins']);
  });

  it('a typed command\'s output and refusal still show, under its bubble', () => {
    const stdout = (uuid: string, text: string) => ({ type: 'user', uuid, message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` } });
    expect(lines(run([{ type: 'turn-start', text: '/cost' }, echo('u1', 'cost'), stdout('o1', 'Total cost: $1.23')])))
      .toEqual(['user: /cost', 'Ran /cost: Total cost: $1.23']);
    expect(lines(run([{ type: 'turn-start', text: '/reload-plugins' }, echo('u1'), refusal('r1'), refusal('r2')])))
      .toEqual(['user: /reload-plugins', 'Ran /reload-plugins: not available over a remote connection']);
  });

  it('matches a typed command to its echo whatever its spacing', () => {
    expect(lines(run([{ type: 'turn-start', text: '/review  pr   12' }, echo('u1', 'review', 'pr   12')]))).toEqual(['user: /review  pr   12']);
  });

  it('adds no second line when a live frame repeats an echo the history holds', () => {
    const s = mergeHistory(
      { entries: [echo('u1', 'cost'), { type: 'user', uuid: 'u2', message: { role: 'user', content: 'hi' } }], sessionId: 's', running: false },
      [echo('u1', 'cost')],
    );
    expect(lines(s)).toEqual(['Ran /cost', 'user: hi']);
  });

  it('a reload during a typed command\'s turn shows its output once', () => {
    const out = { type: 'user', uuid: 'o1', message: { role: 'user', content: '<local-command-stdout>Total cost: $1.23</local-command-stdout>' } };
    const s = mergeHistory(
      { entries: [echo('u1', 'cost'), out], sessionId: 's', running: true },
      [{ type: 'turn-start', text: '/cost' }, echo('u1', 'cost'), out],
    );
    expect(lines(s).filter(l => l.startsWith('Ran '))).toEqual(['Ran /cost: Total cost: $1.23']);
  });

  it('drops an output with no command before it, and a caveat', () => {
    const s = run([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
      { type: 'user', uuid: 'c1', message: { role: 'user', content: '<local-command-caveat>Caveat: the messages below were generated by the user.</local-command-caveat>' } },
      { type: 'user', uuid: 'o1', message: { role: 'user', content: '<local-command-stdout>Reloaded: 3 plugins</local-command-stdout>' } },
    ]);
    expect(lines(s)).toEqual(['user: hi']);
  });
});

describe('applyEvent: background tasks, which a stop ends', () => {
  const started = applyEvent(emptyChat, { type: 'turn-start', text: 'go', live: true });
  const tasks = (list: unknown[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: list });

  it('tracks the running turn\'s background tasks by description', () => {
    const s = applyEvent(started, tasks([{ task_id: 'a', task_type: 'local_bash', description: 'Run the test suite' }, { task_id: 'b' }, { task_id: 'c', task_type: 'local_agent', description: 'Explore' }]));
    expect(s.background).toEqual([
      { description: 'Run the test suite', subagent: false },
      { description: 'a background task', subagent: false },
      { description: 'Explore', subagent: true },
    ]);
    expect(applyEvent(s, tasks([])).background).toEqual([]);
  });

  it('forgets them when the turn ends, fails or a new turn starts', () => {
    const s = applyEvent(started, tasks([{ description: 'sleep' }]));
    expect(applyEvent(s, { type: 'turn-end', exitCode: 0 }).background).toEqual([]);
    expect(applyEvent(s, { type: 'runner-error', message: 'x' }).background).toEqual([]);
    expect(applyEvent(s, { type: 'turn-start', text: 'next' }).background).toEqual([]);
  });

  it('says in the Stop tooltip what a stop ends', () => {
    expect(stopTitle(0)).toBe('Stop Claude (Esc)');
    expect(stopTitle(1)).toBe('Stop Claude and the background task it started (Esc)');
    expect(stopTitle(3)).toBe('Stop Claude and the 3 background tasks it started (Esc)');
    const bash = { description: 'npm test', subagent: false };
    const agent = { description: 'Explore', subagent: true };
    expect(stopTitle([bash], 'split')).toBe('Stop what Claude is doing now. Background commands keep running (Esc)');
    expect(stopTitle([bash, agent], 'split')).toBe('Stop what Claude is doing now. Background commands keep running; the background subagent ends (Esc)');
    expect(stopTitle([bash, agent, agent], 'split')).toBe('Stop what Claude is doing now. Background commands keep running; the 2 background subagents end (Esc)');
    expect(stopTitle([bash, agent], 'background')).toBe('Stop the 2 background tasks and end the turn (Esc)');
    expect(stopTitle([], 'background')).toBe('End the turn (Esc)');
  });
});

describe('stopControl and a turn-only stop', () => {
  const live = applyEvent(emptyChat, { type: 'turn-start', text: 'go', live: true });
  const bg = applyEvent(live, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ description: 'npm test', task_type: 'local_bash' }] });

  it('offers a plain Stop without the capability or on a turn that is not live', () => {
    expect(stopControl(live, false)).toBe('plain');
    expect(stopControl(applyEvent(emptyChat, { type: 'turn-start', text: 'go' }), true)).toBe('plain');
  });

  it('splits Stop while Claude works, and stops background work once it only waits', () => {
    expect(stopControl(live, true)).toBe('split');
    const waiting = applyEvent(bg, { type: 'result', subtype: 'success', result: 'ok' });
    expect(waiting.phase).toBe('waiting');
    expect(stopControl(waiting, true)).toBe('background');
  });

  it('ends a turn-only stop at its result: open work is cut off, the turn waits on its background tasks', () => {
    const working = run([
      { type: 'turn-start', text: 'go', live: true },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{ description: 'npm test' }] },
      { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 60' } }] } },
    ]);
    const stopping = applyEvent(working, { type: 'user-stop', scope: 'turn' });
    expect(stopping.stopTurnOnly).toBe(true);
    const s = applyEvent(stopping, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Interrupted' });
    expect(s.running).toBe(true);
    expect(s.phase).toBe('waiting');
    expect(s.stopRequested).toBe(false);
    expect(s.stopTurnOnly).toBe(false);
    expect(s.background).toEqual([{ description: 'npm test', subagent: false }]);
    expect(s.items.some(i => i.kind === 'tool' && !i.done)).toBe(false);
    expect(s.items[s.items.length - 1]).toMatchObject({ kind: 'note', text: 'Stopped by you' });
    expect(stopControl(s, true)).toBe('background');
  });

  it('reads the stop from Claude\'s interrupt marker in a view that did not send it, or a reloaded history', () => {
    const s = run([
      { type: 'turn-start', text: 'go', live: true },
      { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 60' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
      { type: 'result', subtype: 'error_during_execution', is_error: true },
    ]);
    expect(s.items.map(i => i.kind)).toEqual(['user', 'tool', 'note']);
    expect(s.running).toBe(true);
    expect(s.phase).toBe('waiting');
  });

  it('keeps a stop of everything to turn-end', () => {
    const s = applyEvent(live, { type: 'user-stop', scope: 'all' });
    expect(s.stopRequested).toBe(true);
    expect(s.stopTurnOnly).toBe(false);
  });
});
