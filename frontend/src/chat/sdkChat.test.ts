import { describe, expect, it } from 'vitest';
import { addPending, applyEvent, applyFrame, chatStatus, emptyChat, frameDisposition, fromHistory, liveFrameAction, mergeHistory, resultText, sdkReadiness, shortPath, toolSummary, type ChatState } from './sdkChat';

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
    expect(s.costUsd).toBeCloseTo(0.01);
    expect(chatStatus(s)).toEqual({ tone: 'idle', text: 'Done · your turn' });
  });

  it('matches the pending bubble to its turn instead of adding a second one', () => {
    const pending = addPending(emptyChat, 'what is in here?');
    expect(pending.items[0]).toMatchObject({ kind: 'user', pending: true });
    const s = applyEvent(pending, turn[0]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: 'user', text: 'what is in here?', pending: false });
  });

  it('closes a tool cut off by an interrupted turn and shows why the turn failed', () => {
    const s = run([
      ...turn.slice(0, 13),
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Interrupted' },
      { type: 'turn-end', exitCode: 130 },
    ]);
    expect(s.items.find(i => i.kind === 'tool')).toMatchObject({ done: true, result: null });
    expect(s.items[s.items.length - 1]).toMatchObject({ kind: 'error', text: 'Interrupted' });
    expect(chatStatus(s)).toEqual({ tone: 'error', text: 'Stopped · your turn' });
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
