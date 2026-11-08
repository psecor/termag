import { describe, expect, it } from 'vitest';
import { desktopStepReloads, desktopTurnStatus, desktopTurnStep,
  addPending, alignTurnCosts, applyEvent, applyFrame, chatCostTotal, chatStatus, contextActions, costSinceCleared, commandLine, emptyChat, errorHint, formatCost, formatDuration, frameDisposition, fromHistory, groupTurns,
  lastAssistantText, liveFrameAction, localCommand, mergeHistory, resultText, retryText, sdkReadiness, seedLiveTurn, sendGoesLive, shortPath, stopChoices, stopControl, stopTitle, tasksLine, toolSummary, turnCost, turnCosts, turnMeta, type ChatItem, type ChatState, type TurnRecord, EARLIER_EDGE_PX, loadsEarlier, earlierStart, TRANSCRIPT_WINDOW, transcriptWindow, windowStart, windowStartAfterPage, firstUuid, carryEarlier, withEarlier, withWaiting,
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

  it('says when the box ran the turn read-only, and why, after its message', () => {
    const s = applyEvent(emptyChat, { type: 'turn-start', text: 'fix it', readOnly: 'branch ask tracks none of its branches' });
    expect(s.items.map(i => i.kind)).toEqual(['user', 'readonly']);
    expect(s.items[1]).toEqual({ kind: 'readonly', key: 'readonly:1', reason: 'branch ask tracks none of its branches' });
    const fixed = applyEvent(emptyChat, { type: 'turn-start', text: 'fix it', readOnly: 'branch b tracks none of its branches', readOnlyFix: 'push it with `git push -u origin b`' });
    expect(fixed.items[1]).toMatchObject({ kind: 'readonly', fix: 'push it with `git push -u origin b`' });
    expect(applyEvent(emptyChat, turn[0]).items.some(i => i.kind === 'readonly')).toBe(false);
  });

  it('a read-only note is no stop: a turn ending on it is done, and a real stop still says so (Bugbot, #940)', () => {
    const start = { type: 'turn-start', text: 'fix it', readOnly: 'HEAD is detached' };
    const done = run([start, { type: 'turn-end', exitCode: 0 }]);
    expect(chatStatus(done)).toEqual({ tone: 'idle', text: 'Done · your turn' });
    const stopped = run([start, { type: 'turn-end', exitCode: 130 }]);
    expect(stopped.items[stopped.items.length - 1]).toMatchObject({ kind: 'note', text: 'Stopped by you' });
    expect(chatStatus(stopped)).toEqual({ tone: 'idle', text: 'Stopped · your turn' });
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
    expect(resultText([{ type: 'document', source: { type: 'termag', path: 'a.pdf' } }])).toBe('[PDF]');
    expect(resultText(undefined)).toBe('');
    expect(resultText('x'.repeat(20_010))).toMatch(/… \(10 more characters\)$/);
  });
});

describe('sdkReadiness', () => {
  const at = (o: Partial<Parameters<typeof sdkReadiness>[0]>) => sdkReadiness({ held: false, history: 'ok', checkoutReady: true, queued: false, ...o });

  it('is ready once set up, answered and checked out', () => {
    expect(at({})).toEqual({ runnerReady: true, pollHistory: false, showSteps: false, loading: false });
  });

  it('waits for a pane clone: not ready, asks again, keeps the steps up', () => {
    expect(at({ checkoutReady: false })).toEqual({ runnerReady: false, pollHistory: true, showSteps: true, loading: false });
  });

  it('waits for setup without asking the box while the project is held', () => {
    expect(at({ held: true, history: 'loading' })).toEqual({ runnerReady: false, pollHistory: false, showSteps: true, loading: false });
    expect(at({ history: 'setup' })).toMatchObject({ runnerReady: false, pollHistory: true, showSteps: true, loading: false });
  });

  it('keeps the steps while a first message waits, and drops them on an error the steps cannot explain', () => {
    expect(at({ queued: true }).showSteps).toBe(true);
    expect(at({ history: 'loading', queued: true })).toMatchObject({ showSteps: true, loading: false });
    expect(at({ history: 'error' })).toEqual({ runnerReady: false, pollHistory: false, showSteps: false, loading: false });
  });

  it('loads an existing chat with a placeholder, not the setup steps, while its history is out', () => {
    expect(at({ history: 'loading', checkoutReady: false })).toEqual({ runnerReady: false, pollHistory: false, showSteps: false, loading: true });
    expect(at({ history: 'loading', comingUp: false }).loading).toBe(true);
  });

  it('narrates setup from the first render when the box is still coming up', () => {
    expect(at({ history: 'loading', checkoutReady: false, comingUp: true })).toEqual({ runnerReady: false, pollHistory: false, showSteps: true, loading: false });
  });

  it('hands the placeholder to the steps when the history answers setup', () => {
    expect(at({ history: 'loading', checkoutReady: false }).showSteps).toBe(false);
    expect(at({ history: 'setup', checkoutReady: false })).toMatchObject({ showSteps: true, loading: false });
    expect(at({ history: 'ok', checkoutReady: false })).toMatchObject({ showSteps: true, loading: false });
  });
});

describe('paging in older history', () => {
  const u = (uuid: string) => ({ type: 'user', uuid });
  it('starts the next page from the oldest entry with a uuid', () => {
    expect(firstUuid([{ type: 'context-cleared', at: 'x' }, u('a'), u('b')])).toBe('a');
    expect(firstUuid([{ type: 'context-cleared' }])).toBeNull();
  });

  it('joins the pages on where their entry is in the snapshot, or not at all once it is gone', () => {
    const snapshot = [{ type: 'context-cleared' }, u('c'), u('d')];
    expect(withEarlier(snapshot, null)).toBe(snapshot);
    // The divider the cap kept stays above the pages until a page brings it in.
    expect(withEarlier(snapshot, { before: 'c', entries: [u('a'), u('b')] })).toEqual([{ type: 'context-cleared' }, u('a'), u('b'), u('c'), u('d')]);
    expect(withEarlier(snapshot, { before: 'c', entries: [u('a'), { type: 'context-cleared' }, u('b')] })).toEqual([u('a'), { type: 'context-cleared' }, u('b'), u('c'), u('d')]);
    expect(withEarlier([u('d')], { before: 'c', entries: [u('a')] })).toBeNull();
  });

  it('pages from the oldest entry, not from a divider the cap kept ahead of it', () => {
    const compacted = { type: 'context-compacted', uuid: 'k' };
    expect(firstUuid([compacted, u('c'), u('d')])).toBe('c');
    expect(withEarlier([compacted, u('c')], { before: 'c', entries: [u('a'), compacted, u('b')] })).toEqual([u('a'), compacted, u('b'), u('c')]);
  });

  it('carries the pages onto a history that moved on past their entry', () => {
    const earlier = { before: 'c', entries: [u('a'), u('b')] };
    expect(carryEarlier([u('c'), u('d'), u('e')], [u('e'), u('f')], earlier)).toEqual({ before: 'e', entries: [u('a'), u('b'), u('c'), u('d')] });
    expect(carryEarlier([u('c'), u('d')], [u('x'), u('y')], earlier)).toBeNull();
  });

  it('keeps the window on its group, or as far from the end as it was when that group changed', () => {
    expect(windowStartAfterPage(['a', 'b', 'c', 'd'], 'c', 1)).toBe(2);
    expect(windowStartAfterPage(['a', 'b', 'c', 'd'], 'x', 1)).toBe(3);
    expect(windowStartAfterPage(['a'], 'x', 5)).toBe(0);
  });
});

describe('windowStart and transcriptWindow', () => {
  const keys = Array.from({ length: 100 }, (_, i) => `g${i}`);

  it('starts on the newest groups until the start is fixed, and counts the rest', () => {
    const start = windowStart(keys, null);
    expect(start).toBe(100 - TRANSCRIPT_WINDOW);
    const w = transcriptWindow(keys, start);
    expect(w.hidden).toBe(100 - TRANSCRIPT_WINDOW);
    expect(w.groups[0]).toBe(`g${100 - TRANSCRIPT_WINDOW}`);
    expect(w.groups[w.groups.length - 1]).toBe('g99');
  });

  it('keeps a fixed start where it is as new groups append', () => {
    const from = keys[60];
    expect(windowStart(keys, from)).toBe(60);
    expect(windowStart([...keys, 'g100', 'g101'], from)).toBe(60);
    expect(transcriptWindow([...keys, 'g100'], 60).groups[0]).toBe('g60');
  });

  it('shows a short chat whole, as the same array, and still whole after it grows past the window', () => {
    const short = keys.slice(0, TRANSCRIPT_WINDOW);
    expect(windowStart(short, null)).toBe(0);
    expect(transcriptWindow(short, 0)).toEqual({ groups: short, hidden: 0 });
    expect(transcriptWindow(short, 0).groups).toBe(short);
    expect(windowStart([...short, 'new'], short[0])).toBe(0);
  });

  it('falls back to the newest groups when the fixed group is gone, and loads earlier down to 0', () => {
    expect(windowStart(keys, 'gone')).toBe(100 - TRANSCRIPT_WINDOW);
    expect(earlierStart(60)).toBe(60 - TRANSCRIPT_WINDOW);
    expect(earlierStart(10)).toBe(0);
  });
});

describe('loadsEarlier', () => {
  const at = (o: Partial<Parameters<typeof loadsEarlier>[0]>) => loadsEarlier({ scrollTop: 100, prevScrollTop: 600, hidden: 40, pending: false, ...o });

  it('loads on a scroll up to near the top while groups are left out', () => {
    expect(at({})).toBe(true);
    expect(at({ scrollTop: 0, prevScrollTop: 30 })).toBe(true);
    expect(at({ scrollTop: EARLIER_EDGE_PX })).toBe(true);
  });

  it('never on the first event, such as the scroll to the bottom when a chat opens', () => {
    expect(at({ prevScrollTop: null })).toBe(false);
    expect(at({ scrollTop: 0, prevScrollTop: null })).toBe(false);
  });

  it('never on a scroll down, such as the anchoring jump after earlier groups came in', () => {
    expect(at({ scrollTop: 300, prevScrollTop: 0 })).toBe(false);
    expect(at({ scrollTop: 100, prevScrollTop: 100 })).toBe(false);
  });

  it('never far from the top, with nothing left out, or while a load is on its way', () => {
    expect(at({ scrollTop: EARLIER_EDGE_PX + 1, prevScrollTop: 2000 })).toBe(false);
    expect(at({ hidden: 0 })).toBe(false);
    expect(at({ pending: true })).toBe(false);
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

  it('shows what the box holds behind the turn as queued, until its turn starts', () => {
    const s = mergeHistory({ entries, sessionId: 's', running: true, waiting: [{ text: 'and the tests?' }, { text: 'then push' }] }, []);
    expect(s.items.map(i => i.kind === 'user' && `${i.text}${i.pending ? '*' : ''}`)).toEqual(['what is in here?', false, 'and the tests?*', 'then push*']);
    const started = mergeHistory({ entries, sessionId: 's', running: true, waiting: [{ text: 'and the tests?' }] }, [
      { type: 'turn-end', exitCode: 0 },
      { type: 'turn-start', text: 'and the tests?' },
    ]);
    expect(started.items.filter(i => i.kind === 'user').map(i => i.kind === 'user' && `${i.text}${i.pending ? '*' : ''}`)).toEqual(['what is in here?', 'and the tests?']);
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
      { type: 'turn-end', exitCode: 0, costUsd: 0.06, durationMs: 3000 },
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
    // An older agent's records: each holds the session's total so far.
    const s = fromHistory(entries, 'sess-1', null, [
      { turnId: 'a', userUuid: 'u1', prompt: 'how do I run the tests?', costUsd: 0.04, durationMs: 12000 },
      { turnId: 'x', prompt: 'a turn whose prompt never reached the transcript', costUsd: 0.05, durationMs: 400 },
      { turnId: 'b', userUuid: 'u2', prompt: 'and CI?', costUsd: 0.07, durationMs: 5000 },
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
      { turnId: 'new', userUuid: 'late', prompt: 'go', costUsd: 0.03, durationMs: 2000 },
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

// Claude's total_cost_usd is the session's so far (claude -p --resume restores it): a turn costs what it grew by.
describe('turn costs from session totals', () => {
  const user = (uuid: string, content: string) => ({ type: 'user', uuid, message: { role: 'user', content } });
  const answer = (id: string) => ({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text: id }] } });

  it('a cumulative sequence: an older agent\'s live turn-ends and the result fallback each count the growth', () => {
    const s = run([
      { type: 'turn-start', text: 'one' }, { type: 'result', subtype: 'success', total_cost_usd: 167.51 }, { type: 'turn-end', exitCode: 0, costUsd: 167.51 },
      { type: 'turn-start', text: 'two' }, { type: 'result', subtype: 'success', total_cost_usd: 168.08 }, { type: 'turn-end', exitCode: 0, costUsd: 168.08 },
      // An agent with no turn-end cost: the result's total.
      { type: 'turn-start', text: 'three' }, { type: 'result', subtype: 'success', total_cost_usd: 168.38, duration_ms: 10 }, { type: 'turn-end', exitCode: 0 },
    ]);
    const keys = s.items.filter(i => i.kind === 'user').map(i => i.key);
    expect(s.costs[keys[0]].costUsd).toBeCloseTo(167.51);
    expect(s.costs[keys[1]].costUsd).toBeCloseTo(0.57);
    expect(s.costs[keys[2]].costUsd).toBeCloseTo(0.30);
    expect(chatCostTotal(s)).toBeCloseTo(168.38);
    expect(s.sessionCostUsd).toBe(168.38);
  });

  it('takes an agent\'s own turn cost when it says the session\'s total beside it, and the fallback counts from that total', () => {
    const s = run([
      { type: 'turn-start', text: 'one' }, { type: 'turn-end', exitCode: 0, costUsd: 0.5, sessionCostUsd: 10.5 },
      // The agent found no record: the result's total, less the one before.
      { type: 'turn-start', text: 'two' }, { type: 'result', subtype: 'success', total_cost_usd: 11 }, { type: 'turn-end', exitCode: 0 },
      { type: 'turn-start', text: 'three' }, { type: 'turn-end', exitCode: 1, costUsd: null, sessionCostUsd: null },
    ]);
    const keys = s.items.filter(i => i.kind === 'user').map(i => i.key);
    expect(s.costs[keys[0]].costUsd).toBe(0.5);
    expect(s.costs[keys[1]].costUsd).toBeCloseTo(0.5);
    expect(s.costs[keys[2]].costUsd).toBeNull();
    expect(chatCostTotal(s)).toBeCloseTo(1);
  });

  it('a reset in the middle: a lower total, a clear, and a Resume that brings the old session\'s total back', () => {
    const s = run([
      { type: 'turn-start', text: 'one' }, { type: 'turn-end', exitCode: 0, costUsd: 1 },
      { type: 'turn-start', text: 'two' }, { type: 'turn-end', exitCode: 0, costUsd: 1.5 },
      // A resume that did not restore the cost: Claude counts from this turn.
      { type: 'turn-start', text: 'three' }, { type: 'turn-end', exitCode: 0, costUsd: 0.25 },
      // A new session after a clear, whose first turn costs more than the old total.
      { type: 'context-cleared', at: '2026-10-28T01:00:00.000Z' },
      { type: 'turn-start', text: 'four' }, { type: 'turn-end', exitCode: 0, costUsd: 0.75 },
      { type: 'context-resumed', at: '2026-10-28T01:00:00.000Z', sessionId: 'old' },
      { type: 'turn-start', text: 'five' }, { type: 'turn-end', exitCode: 0, costUsd: 0.5 },
    ]);
    const costs = s.items.filter(i => i.kind === 'user').map(i => s.costs[i.key].costUsd);
    [1, 0.5, 0.25, 0.75, 0.25].forEach((c, i) => expect(costs[i]).toBeCloseTo(c));
    expect(chatCostTotal(s)).toBeCloseTo(2.75);
  });

  it('a reload of an older agent\'s records: the 94-turn chat that showed $13,640 costs its last total', () => {
    const totals = Array.from({ length: 94 }, (_, i) => Math.round((167.51 + i * (176.34 - 167.51) / 93) * 100) / 100);
    const entries = totals.flatMap((_, i) => [user(`u${i}`, `turn ${i}`), answer(`m${i}`)]);
    const records = totals.map((c, i) => ({ turnId: `t${i}`, userUuid: `u${i}`, prompt: `turn ${i}`, costUsd: c, durationMs: 1, at: `2026-10-27T${String(i % 24).padStart(2, '0')}:00:00.000Z` }));
    const s = fromHistory(entries, 'sess-1', null, records);
    expect(totals.reduce((a, b) => a + b, 0)).toBeGreaterThan(16_000);
    expect(chatCostTotal(s)).toBeCloseTo(176.34);
    expect(s.costs['user:u1'].costUsd).toBeCloseTo(totals[1] - totals[0]);
    expect(s.sessionCostUsd).toBe(176.34);
  });

  it('a reload of an older agent\'s records across a clear: the new session counts from nothing, and so does since-cleared', () => {
    const s = fromHistory([
      user('u1', 'one'), answer('m1'), user('u2', 'two'), answer('m2'),
      { type: 'context-cleared', at: '2026-10-28T01:00:00.000Z' },
      user('u3', 'three'), answer('m3'), user('u4', 'four'), answer('m4'),
    ], 'sess-2', null, [
      { turnId: 'a', userUuid: 'u1', prompt: 'one', costUsd: 0.2, durationMs: 1, at: '2026-10-28T00:10:00.000Z' },
      { turnId: 'b', userUuid: 'u2', prompt: 'two', costUsd: 0.3, durationMs: 1, at: '2026-10-28T00:20:00.000Z' },
      { turnId: 'c', userUuid: 'u3', prompt: 'three', costUsd: 0.9, durationMs: 1, at: '2026-10-28T01:10:00.000Z' },
      { turnId: 'd', userUuid: 'u4', prompt: 'four', costUsd: 1.0, durationMs: 1, at: '2026-10-28T01:20:00.000Z' },
    ]);
    expect(s.costs['user:u3'].costUsd).toBeCloseTo(0.9);
    expect(s.costs['user:u4'].costUsd).toBeCloseTo(0.1);
    expect(costSinceCleared(s)).toBeCloseTo(1.0);
    expect(chatCostTotal(s)).toBeCloseTo(1.3);
  });

  it('a reload of an agent\'s records that say the session\'s total: their costs as they are, the replay counting from before its own', () => {
    const s = fromHistory([user('u1', 'one'), answer('m1')], 'sess-1', { turnId: 't2', events: [
      { seq: 1, event: { type: 'turn-start', text: 'two' } },
      { seq: 2, event: { type: 'result', subtype: 'success', total_cost_usd: 3.5 } },
      { seq: 3, event: { type: 'turn-end', exitCode: null, lost: true } },
    ] }, [
      { turnId: 't0', prompt: 'earlier, cut from the history', costUsd: 2, sessionCostUsd: 2, sessionId: 'sess-1', durationMs: 1 },
      { turnId: 't1', userUuid: 'u1', prompt: 'one', costUsd: 1, sessionCostUsd: 3, sessionId: 'sess-1', durationMs: 1 },
    ]);
    const two = s.items.filter(i => i.kind === 'user').find(i => i.kind === 'user' && i.text === 'two')!;
    expect(s.costs['user:u1'].costUsd).toBe(1);
    expect(s.costs[two.key].costUsd).toBeCloseTo(0.5);
    expect(chatCostTotal(s)).toBeCloseTo(3.5);
  });

  // A reload of a just-cleared chat (resetContext leaves no session), then Resume, then a turn-end with no cost of its own.
  const clearedReload = (records: TurnRecord[]) => fromHistory([
    user('u1', 'one'), answer('m1'), user('u2', 'two'), answer('m2'),
    { type: 'context-cleared', at: '2026-10-28T01:00:00.000Z' },
  ], null, null, records);
  const priced: TurnRecord[] = [
    { turnId: 'a', userUuid: 'u1', prompt: 'one', costUsd: 5, sessionCostUsd: 5, sessionId: 'old', durationMs: 1, at: '2026-10-28T00:10:00.000Z' },
    { turnId: 'b', userUuid: 'u2', prompt: 'two', costUsd: 1, sessionCostUsd: 6, sessionId: 'old', durationMs: 1, at: '2026-10-28T00:20:00.000Z' },
  ];
  const unpriced: TurnRecord[] = priced.map(({ sessionCostUsd, sessionId, ...r }) => ({ ...r, costUsd: sessionCostUsd ?? null }));
  const resumedTurn = [
    { type: 'context-resumed', at: '2026-10-28T01:00:00.000Z', sessionId: 'old' },
    { type: 'turn-start', text: 'three' }, { type: 'result', subtype: 'success', total_cost_usd: 6.25 }, { type: 'turn-end', exitCode: 0 },
  ];
  const freshTurn = [{ type: 'turn-start', text: 'three' }, { type: 'result', subtype: 'success', total_cost_usd: 8 }, { type: 'turn-end', exitCode: 0 }];
  const lastCost = (s: ChatState) => { const u = s.items.filter(i => i.kind === 'user'); return s.costs[u[u.length - 1].key].costUsd; };

  it.each([['an agent that prices', priced], ['an older agent', unpriced]])('a reload of a just-cleared chat, then Resume: the next turn counts from the old session\'s total (%s)', (_, records) => {
    const s = clearedReload(records);
    expect(s.clearedSessionCostUsd).toBe(6);
    expect(lastCost(run(resumedTurn, s))).toBeCloseTo(0.25);
  });

  it.each([['an agent that prices', priced], ['an older agent', unpriced]])('a reload of a just-cleared chat: the new session counts from nothing (%s)', (_, records) => {
    const s = clearedReload(records);
    expect(s.sessionCostUsd).toBeNull();
    expect(lastCost(run(freshTurn, s))).toBe(8);
  });

  it.each([['an agent that prices', priced], ['an older agent', unpriced]])('two clears with no turn between: Resume of the empty session puts back nothing (%s)', (_, records) => {
    expect(turnCosts(records, ['2026-10-28T01:00:00.000Z', '2026-10-28T02:00:00.000Z']).clearedSessionCostUsd).toBeNull();
    expect(turnCosts(records, ['2026-10-28T00:15:00.000Z', '2026-10-28T01:00:00.000Z']).clearedSessionCostUsd).toBe(6);
  });

  it('turnCosts: one session per id from an agent that says so, and the current session\'s total', () => {
    const records = [
      { turnId: 'a', prompt: '', costUsd: 1, sessionCostUsd: 1, sessionId: 's1', durationMs: 1 },
      { turnId: 'b', prompt: '', costUsd: 2, sessionCostUsd: 2, sessionId: 's2', durationMs: 1 },
    ];
    expect(turnCosts(records, [], 's1').sessionCostUsd).toBe(1);
    expect(turnCosts(records, [], 's2').sessionCostUsd).toBe(2);
    expect(turnCosts(records, [], 's3').sessionCostUsd).toBeNull();
    expect(turnCost(null, 1)).toBeNull();
    expect(turnCost(0.5, 1)).toBe(0.5);
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
    expect(groups.map(g => (g.kind !== 'reply' ? `${g.kind}:${g.item.key}` : `reply:${g.userKey}:${g.items.length}`)))
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
    expect(chatStatus(s, true)).toEqual({ tone: 'idle', text: 'Your turn · background work still running' });
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

  it('tracks the running turn\'s background tasks by description and id', () => {
    const s = applyEvent(started, tasks([{ task_id: 'a', task_type: 'local_bash', description: 'Run the test suite' }, { task_id: 'b' }, { task_id: 'c', task_type: 'local_agent', description: 'Explore' }, { description: 'no id' }]));
    expect(s.background).toEqual([
      { description: 'Run the test suite', subagent: false, id: 'a' },
      { description: 'a background task', subagent: false, id: 'b' },
      { description: 'Explore', subagent: true, id: 'c' },
      { description: 'no id', subagent: false },
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

describe('context-cleared', () => {
  const before = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'one' }], usage: { input_tokens: 40_000 } } },
    { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.4 } },
  ];

  it('draws a divider, forgets the session and empties the context ring, keeping the plan windows', () => {
    const s = run([...before, { type: 'context-cleared', at: '2026-10-26T12:00:00.000Z' }], { ...emptyChat, sessionId: 'sess-1' });
    expect(s.items.map(it => it.kind)).toEqual(['user', 'text', 'divider']);
    expect(s.sessionId).toBeNull();
    expect(s.usage?.contextTokens).toBeNull();
    expect(s.usage?.limits.five_hour?.utilization).toBe(0.4);
    expect(chatStatus(s).text).toBe('Context cleared · your turn');
  });

  it('is one divider when the answer and the frame both arrive', () => {
    const cleared = { type: 'context-cleared', at: '2026-10-26T12:00:00.000Z' };
    const s = run([...before, cleared, cleared]);
    expect(s.items.filter(it => it.kind === 'divider')).toHaveLength(1);
  });

  it('comes back from the history, and the next session fills the ring again', () => {
    const s = fromHistory([
      ...before,
      { type: 'context-cleared', at: '2026-10-26T12:00:00.000Z' },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
      { type: 'assistant', message: { id: 'm2', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'two' }], usage: { input_tokens: 3_000 } } },
    ], 'sess-2');
    expect(s.items.map(it => it.kind)).toEqual(['user', 'text', 'divider', 'user', 'text']);
    expect(s.usage?.contextTokens).toBe(3_000);
    expect(s.sessionId).toBe('sess-2');
  });

  it('stands alone between turns: a reply after it is not the earlier prompt\'s', () => {
    const s = run([...before, { type: 'context-cleared', at: 'x' }, { type: 'assistant', message: { id: 'm9', role: 'assistant', content: [{ type: 'text', text: 'late' }] } }]);
    const groups = groupTurns(s.items);
    expect(groups.map(g => (g.kind === 'reply' ? `reply:${g.userKey}` : g.kind))).toEqual(['user', 'reply:user:u1', 'divider', 'reply:null']);
  });
});

describe('contextActions', () => {
  const user = { kind: 'user' as const, key: 'u1', text: 'a' };
  const reply = { kind: 'text' as const, key: 't1', text: 'b', streaming: false };
  const cleared = { kind: 'divider' as const, key: 'cleared:x', at: 'x', variant: 'cleared' as const };
  const compacted = { kind: 'divider' as const, key: 'compacted:y', at: 'y', variant: 'compacted' as const };
  const base = { offered: 'ready' as const, runnerReady: true, running: false, held: false, sessionId: 'sess-1' as string | null, items: [user, reply] as ChatItem[] };

  it('is hidden when the backend does not offer it', () => {
    expect(contextActions({ ...base, offered: null })).toBeNull();
    expect(contextActions({ ...base, offered: undefined })).toBeNull();
  });

  it('lets an idle chat with a session clear and compact', () => {
    expect(contextActions(base)).toEqual({ clear: { enabled: true, reason: null }, compact: { enabled: true, reason: null }, resume: false });
  });

  it('says why both are disabled', () => {
    expect(contextActions({ ...base, offered: 'update' })?.compact?.reason).toMatch(/needs an update/);
    expect(contextActions({ ...base, running: true })?.clear?.reason).toMatch(/Wait for Claude/);
    expect(contextActions({ ...base, running: true })?.compact?.reason).toMatch(/Wait for Claude/);
    expect(contextActions({ ...base, held: true })?.clear?.reason).toBe('Claude is open in Lab. Return it to this chat first.');
    expect(contextActions({ ...base, runnerReady: false })?.compact?.reason).toMatch(/starting/);
    expect(contextActions({ ...base, sessionId: null, items: [] })?.clear?.reason).toBe('Nothing to clear yet.');
    expect(contextActions({ ...base, sessionId: null, items: [] })?.compact?.reason).toBe('Nothing to compact yet.');
  });

  it('always allows Compact with a session: no threshold, whatever the context size, even straight after a compact', () => {
    const ready = { enabled: true, reason: null };
    expect(contextActions(base)?.compact).toEqual(ready);
    expect(contextActions({ ...base, items: [user] })?.compact).toEqual(ready);
    expect(contextActions({ ...base, items: [user, reply, compacted] })?.compact).toEqual(ready);
    // Only where it truly cannot run: no session, or Claude busy.
    expect(contextActions({ ...base, sessionId: null, items: [] })?.compact?.enabled).toBe(false);
    expect(contextActions({ ...base, running: true })?.compact?.enabled).toBe(false);
  });

  it('hides what this chat can never do instead of showing it disabled', () => {
    const r = contextActions({ ...base, refusals: { compact: "Compacting runs on Claude's own models." } });
    expect(r?.compact).toBeNull();
    expect(r?.clear?.enabled).toBe(true);
    const other = contextActions({ ...base, refusals: { clear: 'no', compact: 'no', resume: 'no' } });
    expect(other).toEqual({ clear: null, compact: null, resume: false });
  });

  it('keeps an older agent\'s buttons visible and disabled, as it can do them once updated', () => {
    const r = contextActions({ ...base, offered: 'update' });
    expect(r?.clear).toEqual({ enabled: false, reason: expect.stringMatching(/needs an update/) });
    expect(r?.compact?.enabled).toBe(false);
  });

  it('offers Resume from a clear until the first message after it', () => {
    const after = { ...base, sessionId: null, items: [user, reply, cleared] as ChatItem[] };
    expect(contextActions(after)?.resume).toBe(true);
    expect(contextActions(after)?.clear?.reason).toBe('Context is already clear.');
    expect(contextActions({ ...after, items: [user, reply, cleared, { ...user, key: 'u2', text: 'next' }] })?.resume).toBe(false);
    expect(contextActions({ ...after, items: [user, reply, { ...cleared, undone: true }] })?.resume).toBe(false);
    expect(contextActions({ ...after, running: true })?.resume).toBe(false);
    expect(contextActions({ ...after, refusals: { resume: 'no' } })?.resume).toBe(false);
  });
});

describe('context-resumed', () => {
  const before = [
    { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'one' }], usage: { input_tokens: 40_000 } } },
  ];

  it('marks the divider undone, puts the session back and the ring with it', () => {
    let s = run([...before, { type: 'context-cleared', at: 'T1' }], { ...emptyChat, sessionId: 'sess-1' });
    expect(s.usage?.contextTokens).toBeNull();
    s = applyEvent(s, { type: 'context-resumed', at: 'T1', resumedAt: 'T2', sessionId: 'sess-1' });
    const divider = s.items.find(it => it.kind === 'divider');
    expect(divider?.kind === 'divider' && divider.undone).toBe(true);
    expect(s.sessionId).toBe('sess-1');
    expect(s.usage?.contextTokens).toBe(40_000);
    expect(chatStatus(s).text).toBe('Previous context resumed · your turn');
    expect(costSinceCleared(s)).toBeNull();
  });

  it('comes back from the history as an undone divider that leaves the ring alone', () => {
    const s = fromHistory([...before, { type: 'context-cleared', at: 'T1', resumedAt: 'T2' }], 'sess-1');
    const divider = s.items.find(it => it.kind === 'divider');
    expect(divider?.kind === 'divider' && divider.undone).toBe(true);
    expect(s.usage?.contextTokens).toBe(40_000);
  });
});

describe('compact', () => {
  const opening = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'one' }], usage: { input_tokens: 163_000 } } },
  ];
  // Claude Code 2.1.310's own events for `claude -p --resume <id>` with /compact as the prompt.
  const compactTurn = [
    { type: 'turn-start', text: '/compact', resumed: true, compact: true },
    { type: 'system', subtype: 'status', status: 'compacting' },
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    { type: 'system', subtype: 'compact_boundary', uuid: 'b1', compact_metadata: { trigger: 'manual', pre_tokens: 163_152, post_tokens: 1_673 } },
    { type: 'user', isSynthetic: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' } },
    { type: 'user', isReplay: true, message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' } },
    { type: 'result', subtype: 'success', is_error: false, result: '', local_command: 'compact', total_cost_usd: 0.46 },
    { type: 'turn-end', exitCode: 0 },
  ];

  it('is a divider, not a bubble or the summary, and empties the ring until the next reply', () => {
    let s = run([...opening, compactTurn[0]]);
    expect(s.running).toBe(true);
    expect(chatStatus(s).text).toBe('Compacting the conversation…');
    s = run(compactTurn.slice(1), s);
    expect(s.items.map(it => it.kind)).toEqual(['user', 'text', 'divider']);
    const divider = s.items[2];
    expect(divider.kind === 'divider' && divider.variant).toBe('compacted');
    expect(divider.kind === 'divider' && divider.preTokens).toBe(163_152);
    expect(s.usage?.contextTokens).toBeNull();
    expect(s.compactedFrom).toBe(163_152);
    expect(s.running).toBe(false);
    expect(chatStatus(s).text).toBe('Context compacted · your turn');
    expect(chatCostTotal(s)).toBe(0.46);
    s = run([
      { type: 'turn-start', text: 'and now?' },
      { type: 'assistant', message: { id: 'm2', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'two' }], usage: { input_tokens: 21_000 } } },
    ], s);
    expect(s.usage?.contextTokens).toBe(21_000);
    expect(s.compactedFrom).toBeNull();
  });

  it('is the same divider from the history, without the /compact echo', () => {
    const s = fromHistory([
      ...opening,
      { type: 'context-compacted', uuid: 'b1', at: '2026-10-26T12:00:00.000Z', preTokens: 163_152 },
      { type: 'user', uuid: 'c1', message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>' } },
    ], 'sess-1');
    expect(s.items.map(it => it.kind)).toEqual(['user', 'text', 'divider']);
    expect(s.usage?.contextTokens).toBeNull();
  });

  it('does not count as a clear for the since-cleared cost', () => {
    expect(costSinceCleared(run([...opening, ...compactTurn]))).toBeNull();
  });
});

describe('costSinceCleared', () => {
  it('is null before any clear, then the replies after the last divider', () => {
    const items = [
      { kind: 'user' as const, key: 'u1', text: 'a' },
      { kind: 'divider' as const, key: 'cleared:1', at: '1', variant: 'cleared' as const },
      { kind: 'user' as const, key: 'u2', text: 'b' },
      { kind: 'divider' as const, key: 'cleared:2', at: '2', variant: 'cleared' as const },
      { kind: 'user' as const, key: 'u3', text: 'c' },
      { kind: 'user' as const, key: 'u4', text: 'd' },
    ];
    const costs = { u1: { costUsd: 1, durationMs: 1 }, u2: { costUsd: 2, durationMs: 1 }, u3: { costUsd: 0.25, durationMs: 1 }, u4: { costUsd: null, durationMs: 1 } };
    expect(costSinceCleared({ items: items.slice(0, 1), costs })).toBeNull();
    expect(costSinceCleared({ items, costs })).toBe(0.25);
    expect(costSinceCleared({ items: items.slice(0, 4), costs })).toBe(0);
    // The total is not this: it keeps counting across clears.
    expect(chatCostTotal({ costs, extraCostUsd: 0 })).toBe(3.25);
  });
});

describe('context actions folded twice', () => {
  it('a clear seen twice (the answer, then the frame) still lets Resume bring the ring back', () => {
    const reply = { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'one' }], usage: { input_tokens: 40_000 } } };
    const cleared = { type: 'context-cleared', at: 'T1' };
    const s = run([reply, cleared, cleared, { type: 'context-resumed', at: 'T1', resumedAt: 'T2', sessionId: 'sess-1' }], { ...emptyChat, sessionId: 'sess-1' });
    expect(s.usage?.contextTokens).toBe(40_000);
  });
});

describe('a turn after a compact that never settled (Bugbot #738)', () => {
  it('starts out of compacting, so its tool results and messages show', () => {
    // The compact turn's turn-end was lost (the box's socket dropped), then the next turn starts.
    let s = run([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
      { type: 'turn-start', text: '/compact', resumed: true, compact: true },
      { type: 'system', subtype: 'compact_boundary', uuid: 'b1', compact_metadata: { pre_tokens: 60_000 } },
    ]);
    expect(s.compacting).toBe(true);
    s = run([
      { type: 'turn-start', text: 'next' },
      { type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/a' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'contents' }] } },
    ], s);
    expect(s.compacting).toBe(false);
    const tool = s.items.find(it => it.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.done).toBe(true);
    expect(tool?.kind === 'tool' && tool.result).toBe('contents');
  });
});

describe('mergeHistory after a compact that never settled (Bugbot #738)', () => {
  it('a turn-start it folds itself leaves compacting too', () => {
    const live = [
      { type: 'turn-start', text: '/compact', compact: true },
      { type: 'turn-start', text: 'next' },
      { type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    ];
    const s = mergeHistory({ entries: [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'next' } }], sessionId: 's', running: true }, live);
    expect(s.compacting).toBe(false);
    const tool = s.items.find(it => it.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.result).toBe('ok');
  });
});

// What Claude Code 2.1 prints around a background Bash (captured from a real
// `claude -p --input-format stream-json`): the call's result says it started,
// the answer's result comes while it runs, then its end wakes Claude in the
// same process: task_notification, background_tasks_changed, a new init and
// more work, with no message from anyone.
describe('applyEvent: a background task wakes Claude after its answer', () => {
  const bgCall = { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tb', name: 'Bash', input: { command: 'sleep 15; echo hi', run_in_background: true } }] } };
  const bgStarted = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tb', content: 'Command running in background with ID: b2q. Output is being written to: /tmp/b2q.output. You will be notified when it completes.' }] } };
  const tasks = (n: number) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: Array.from({ length: n }, (_, i) => ({ task_id: `b${i}`, task_type: 'local_bash', description: `task ${i}` })) });
  const notification = { type: 'system', subtype: 'task_notification', task_id: 'b2q', tool_use_id: 'tb', status: 'completed', summary: 'Background command completed' };
  const answered = [
    { type: 'turn-start', text: 'start it', live: true },
    { type: 'system', subtype: 'init', session_id: 's1' },
    bgCall, bgStarted, tasks(3),
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Started.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Started.' },
  ];
  const tool = (s: ChatState) => s.items.find(i => i.kind === 'tool' && i.id === 'tb') as Extract<ChatState['items'][number], { kind: 'tool' }>;

  it('says it is your turn, with the tasks still running, once Claude has answered', () => {
    const s = run(answered);
    expect(s.running).toBe(true);
    expect(chatStatus(s, true)).toEqual({ tone: 'idle', text: 'Your turn · 3 background tasks running' });
    expect(chatStatus(s, false)).toEqual({ tone: 'idle', text: 'Waiting on 3 background tasks · a message waits until they end' });
    expect(chatStatus(run([tasks(1)], s), false).text).toBe('Waiting on 1 background task · a message waits until it ends');
  });

  it('shows the background call as running in the background, not as a finished or pending call', () => {
    expect(tool(run(answered))).toMatchObject({ done: true, background: 'running' });
    expect(tool(run([notification], run(answered))).background).toBe('done');
    expect(tool(run([{ ...notification, status: 'failed' }], run(answered))).background).toBe('failed');
    expect(tool(run([{ ...notification, status: 'killed' }], run(answered))).background).toBe('stopped');
  });

  it('works again when the task ends, says why, and is Done only at the turn end', () => {
    const woken = run([notification, tasks(2), { type: 'system', subtype: 'init', session_id: 's1' }], run(answered));
    expect(woken.phase).toBe('thinking');
    expect(chatStatus(woken, true)).toEqual({ tone: 'working', text: 'Working · background task finished' });
    const reading = run([{ type: 'assistant', message: { id: 'm3', content: [{ type: 'tool_use', id: 'tr', name: 'Read', input: { file_path: '/tmp/b2q.output' } }] } }], woken);
    expect(chatStatus(reading, true).text).toBe('Running Read · /tmp/b2q.output');
    const thinking = run([{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tr', content: 'hi' }] } }], reading);
    expect(chatStatus(thinking, true).text).toBe('Working · background task finished');
    const again = run([
      { type: 'assistant', message: { id: 'm4', content: [{ type: 'text', text: 'It printed hi.' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'It printed hi.' },
    ], thinking);
    expect(chatStatus(again, true)).toEqual({ tone: 'idle', text: 'Your turn · 2 background tasks running' });
    expect(again.woken).toBe(false);
    const ended = run([tasks(0), { type: 'turn-end', exitCode: 0 }], again);
    expect(chatStatus(ended, true)).toEqual({ tone: 'idle', text: 'Done · your turn' });
  });

  it('wakes on the first streamed or final assistant event too, for a log without the notification', () => {
    expect(run([{ type: 'stream_event', event: { type: 'message_start', message: { id: 'm9' } } }], run(answered)).woken).toBe(true);
    expect(run([{ type: 'assistant', message: { id: 'm9', content: [{ type: 'text', text: 'Back.' }] } }], run(answered)).phase).toBe('writing');
  });

  it('a message, not a task, is what a replayed user line is', () => {
    const s = run([notification, { type: 'user', isReplay: true, uuid: 'u2', message: { role: 'user', content: 'and now?' } }], run(answered));
    expect(s.woken).toBe(false);
    expect(chatStatus(s, true).text).toBe('Thinking…');
  });

  it('a background call nothing reports again ends with its turn', () => {
    expect(tool(run([{ type: 'turn-end', exitCode: null, signal: 'SIGINT' }], run(answered))).background).toBe('stopped');
  });

  it('reads the notification from a transcript as the card\'s end, never as a bubble', () => {
    const transcript = [
      { type: 'user', message: { role: 'user', content: 'start it' } },
      bgCall, bgStarted,
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Started.' }] } },
      { type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>b2q</task-id>\n<tool-use-id>tb</tool-use-id>\n<status>completed</status>\n<summary>Background command completed</summary>\n</task-notification>' } },
      { type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: 'It printed hi.' }] } },
    ];
    const s = fromHistory(transcript, 's1');
    expect(s.items.filter(i => i.kind === 'user').map(i => i.text)).toEqual(['start it']);
    expect(tool(s).background).toBe('done');
    // Cut off before its notification, with nothing running on the box: it ended with the turn.
    expect(tool(fromHistory(transcript.slice(0, 4), 's1', null, [], { running: false })).background).toBe('stopped');
    expect(tool(mergeHistory({ entries: transcript.slice(0, 4), sessionId: 's1', running: false }, [])).background).toBe('stopped');
  });
});

// A long live turn's replay is only its newest lines (agent chat-runner.js
// TURN_EVENTS_MAX), so it has no turn-start: the chat must not take the turn
// for over, which said "Done · your turn" over a Bash card still running.
describe('fromHistory: a running turn replayed from its newest lines only', () => {
  const tail = [
    { seq: 6001, event: { type: 'assistant', message: { id: 'm7', content: [{ type: 'tool_use', id: 'tx', name: 'Bash', input: { command: 'termag ask x' } }] } } },
  ];
  const answeredTail = [
    { seq: 6001, event: { type: 'assistant', message: { id: 'm7', content: [{ type: 'text', text: 'Asked both.' }] } } },
    { seq: 6002, event: { type: 'result', subtype: 'success', is_error: false, result: 'Asked both.' } },
  ];

  it('is running when the box says a turn runs, and the open call is what it does', () => {
    const s = fromHistory([], 's1', { turnId: 't1', events: tail }, [], { running: true, liveInput: true });
    expect(s.running).toBe(true);
    expect(s.liveTurn).toBe(true);
    expect(chatStatus(s, true).text).toBe('Running Bash · termag ask x');
    // Without the box's word (an older frontend's call) it was Done.
    expect(chatStatus(fromHistory([], 's1', { turnId: 't1', events: tail }), true).text).toBe('Done · your turn');
  });

  it('takes the prompt and the background tasks from the head the box sends with the cut', () => {
    const head = [
      { type: 'turn-start', text: 'orchestrate', live: true },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{ description: 'ask a' }, { description: 'ask b' }] },
    ];
    const s = fromHistory([], 's1', { turnId: 't1', events: answeredTail, head }, [], { running: true, liveInput: true });
    expect(s.items[0]).toMatchObject({ kind: 'user', text: 'orchestrate' });
    expect(chatStatus(s, true)).toEqual({ tone: 'idle', text: 'Your turn · 2 background tasks running' });
    expect(s.cursor).toEqual({ turnId: 't1', seq: 6002 });
    // The next live frame goes on from the tail.
    expect(applyFrame(s, { turnId: 't1', seq: 6003, event: { type: 'system', subtype: 'init', session_id: 's1' } }).state.woken).toBe(true);
  });

  it('leaves a whole replay to its own turn-start', () => {
    const s = fromHistory([], 's1', { turnId: 't1', events: [{ seq: 1, event: { type: 'turn-start', text: 'hi' } }] }, [], { running: true });
    expect(s.items.filter(i => i.kind === 'user')).toHaveLength(1);
  });
});

// Claude Code tells the model a background task ended with a user-role
// <task-notification> (shapes from a real 2.1.310 run): in the transcript a
// user line with origin task-notification (or, taken in mid-work, a
// queued_command the agent turns into one), live a system task_notification
// and, mid-work, also a replayed user line. None of them is the person's.
describe('background task notifications: a muted line, never a bubble', () => {
  const note = (id: string, call: string, status: string, summary: string) =>
    `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>${call}</tool-use-id>\n<output-file>/tmp/claude-1001/x/tasks/${id}.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
  const bg = (id: string, command: string) => [
    { type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command, run_in_background: true } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: b-${id}.` }] } },
  ];
  const userNote = (uuid: string, text: string, extra = {}) => ({ type: 'user', uuid, origin: { kind: 'task-notification' }, message: { role: 'user', content: text }, ...extra });
  const tasks = (s: ChatState) => s.items.filter(i => i.kind === 'tasks') as Array<Extract<ChatState['items'][number], { kind: 'tasks' }>>;
  const bubbles = (s: ChatState) => s.items.filter(i => i.kind === 'user').map(i => i.text);

  it('history: a notification is a line saying what ended, a run of them one line, and failures warn', () => {
    const s = fromHistory([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'start the asks' } },
      ...bg('t1', 'termag ask a'), ...bg('t2', 'termag ask b'),
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Both asked.' }] } },
      userNote('n1', note('b1', 't1', 'completed', 'Background command &quot;Follow-up ask: signin video&quot; completed (exit code 0)')),
      { type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: 'The first is back.' }] } },
      userNote('n2', note('b2', 't2', 'failed', 'Background command "Ask b" failed with exit code 1')),
      userNote('n3', note('b3', 'tz', 'killed', 'Background command "Ask c" was stopped')),
    ], 's1');
    expect(bubbles(s)).toEqual(['start the asks']);
    expect(s.items.some(i => i.kind === 'user' && /task-notification/.test(i.text))).toBe(false);
    const [first, run] = tasks(s);
    expect(tasksLine(first)).toEqual({ mark: '✓', text: 'Background command finished: Follow-up ask: signin video (exit 0)', warn: false });
    expect(run.ended.map(t => t.status)).toEqual(['failed', 'stopped']);
    expect(tasksLine(run)).toEqual({ mark: '✗', text: '2 background commands ended, 2 without finishing: Ask b · Ask c', warn: true });
    expect(tasksLine({ ...run, ended: [run.ended[0]] }).text).toBe('Background command failed: Ask b (exit 1)');
  });

  it('history: a mid-turn message stays a bubble, also next to a notification taken in with it', () => {
    const s = fromHistory([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } },
      ...bg('t1', 'sleep 3'),
      { type: 'user', uuid: 'live-1', message: { role: 'user', content: 'and what is 2+2?' } },
      { type: 'user', uuid: 'live-2', origin: { kind: 'task-notification' }, message: { role: 'user', content: note('b1', 't1', 'completed', 'Background command "sleep" completed (exit code 0)') } },
      { type: 'user', uuid: 'r1', message: { role: 'user', content: '<system-reminder>\nA reminder for the model.\n</system-reminder>' } },
    ], 's1');
    expect(bubbles(s)).toEqual(['go', 'and what is 2+2?']);
    expect(tasks(s)).toHaveLength(1);
  });

  it('live: an idle wake-up\'s system task_notification is the line, and the status goes to working at it', () => {
    const answered = run([
      { type: 'turn-start', text: 'go', live: true }, ...bg('t1', 'npm test'),
      { type: 'result', subtype: 'success', is_error: false, result: 'Started.' },
    ]);
    const s = run([{ type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 't1', status: 'completed', output_file: '/tmp/b1.output', summary: 'Background command "Run the test suite" completed (exit code 0)' }], answered);
    expect(tasksLine(tasks(s)[0]).text).toBe('Background command finished: Run the test suite (exit 0)');
    expect(chatStatus(s, true)).toEqual({ tone: 'working', text: 'Working · background task finished' });
  });

  it('live: mid-work, the replayed user line of a notification already shown adds nothing; the person\'s replay is a bubble', () => {
    let s = run([{ type: 'turn-start', text: 'go', live: true }, { type: 'user', isReplay: true, uuid: 'p0', message: { role: 'user', content: 'go' } }, ...bg('t1', 'sleep 3')]);
    s = run([
      { type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 't1', status: 'completed', output_file: '/tmp/b1.output', summary: 'Background command "sleep" completed (exit code 0)' },
      { type: 'user', isReplay: true, uuid: 'p1', message: { role: 'user', content: 'also 2+2?' } },
      userNote('p2', note('b1', 't1', 'completed', 'Background command "sleep" completed (exit code 0)'), { isReplay: true }),
    ], s);
    expect(bubbles(s)).toEqual(['go', 'also 2+2?']);
    expect(tasks(s)).toHaveLength(1);
    expect(tasks(s)[0].ended).toHaveLength(1);
  });

  it('live: a foreground call\'s notification (no output file) changes nothing', () => {
    const s = run([{ type: 'turn-start', text: 'go' }, { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'f1', name: 'Bash', input: { command: 'sleep 10' } }] } }]);
    const after = run([{ type: 'system', subtype: 'task_notification', task_id: 'b9', tool_use_id: 'f1', status: 'completed', output_file: '', summary: 'Foreground task: sleep' }], s);
    expect(after.items).toEqual(s.items);
  });
});

describe('chatStatus: a message on its way', () => {
  it('says Sending… between the send and its turn-start, not the last turn\'s Done', () => {
    const done = run([{ type: 'turn-start', text: 'hi' }, { type: 'result', subtype: 'success' }, { type: 'turn-end', exitCode: 0 }]);
    expect(chatStatus(done).text).toBe('Done · your turn');
    expect(chatStatus(addPending(done, 'next'))).toEqual({ tone: 'working', text: 'Sending…' });
    expect(chatStatus(addPending(emptyChat, 'first'))).toEqual({ tone: 'working', text: 'Sending…' });
    expect(chatStatus(run([{ type: 'turn-start', text: 'next' }], addPending(done, 'next'))).text).toBe('Thinking…');
  });
});


describe('authFailure: a turn that failed on Claude sign-in', () => {
  const expired = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}';
  const authMessage = { type: 'assistant', error: 'authentication_failed', message: { id: 'e1', model: '<synthetic>', content: [{ type: 'text', text: expired }] } };

  it("marks the chat from Claude Code's authentication_failed message and its result", () => {
    const s = run([{ type: 'turn-start', text: 'hi' }, authMessage, { type: 'result', subtype: 'success', is_error: true, result: expired }, { type: 'turn-end', exitCode: 1 }]);
    expect(s.authFailure).toEqual(expect.any(Number));
    expect(run([{ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' }]).authFailure).toEqual(expect.any(Number));
  });

  it('marks it from the same message read back from the transcript', () => {
    const s = fromHistory([{ type: 'assistant', isApiErrorMessage: true, message: { id: 'e1', model: '<synthetic>', content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] } }]);
    expect(s.authFailure).toEqual(expect.any(Number));
  });

  it('a new failure changes it, and Claude answering again clears it', () => {
    const first = run([authMessage]);
    const second = run([{ type: 'turn-start', text: 'again' }, authMessage], first);
    expect(second.authFailure).not.toBe(first.authFailure);
    const answered = run([{ type: 'assistant', message: { id: 'm9', model: 'claude-opus', content: [{ type: 'text', text: 'Hello.' }] } }], second);
    expect(answered.authFailure).toBeNull();
  });

  it('leaves other failures alone', () => {
    const s = run([{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }]);
    expect(s.authFailure ?? null).toBeNull();
    expect(run(turn).authFailure ?? null).toBeNull();
  });
});

describe('since-cleared cost counts a compact turn (Bugbot #738)', () => {
  const reply = (id: string, tokens: number) => ({ type: 'assistant', message: { id, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: id }], usage: { input_tokens: tokens } } });

  it('live: the compact turn\'s cost lands on its divider, and since-cleared counts it', () => {
    const s = run([
      { type: 'context-cleared', at: 'T1' },
      { type: 'turn-start', text: 'hi' }, reply('m1', 30_000), { type: 'result', subtype: 'success', total_cost_usd: 0.1 }, { type: 'turn-end', exitCode: 0, costUsd: 0.1 },
      { type: 'turn-start', text: '/compact', compact: true },
      { type: 'system', subtype: 'compact_boundary', uuid: 'b1', compact_metadata: { pre_tokens: 30_000 } },
      { type: 'result', subtype: 'success', result: '', local_command: 'compact', total_cost_usd: 0.56 },
      { type: 'turn-end', exitCode: 0, costUsd: 0.56 },
    ]);
    expect(costSinceCleared(s)).toBeCloseTo(0.56);
    expect(chatCostTotal(s)).toBeCloseTo(0.56);
    expect(s.extraCostUsd).toBe(0);
  });

  it('reload: the compact turn\'s record pins to its divider by the summary it left', () => {
    const s = fromHistory([
      { type: 'context-cleared', at: 'T1' },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'hi' } },
      reply('m1', 30_000),
      { type: 'context-compacted', uuid: 'b1', at: 'T2', preTokens: 30_000, summaryUuid: 's1' },
    ], 'sess-1', null, [
      { turnId: 't1', prompt: 'hi', userUuid: 'u2', costUsd: 0.1, durationMs: 1 },
      { turnId: 't2', prompt: '/compact', userUuid: 's1', costUsd: 0.56, durationMs: 1 },
    ]);
    expect(costSinceCleared(s)).toBeCloseTo(0.56);
    expect(s.extraCostUsd).toBe(0);
  });
});

describe('since-cleared cost after a history replay of a compact (Bugbot #738)', () => {
  it('pins the compact turn\'s cost to a divider the history already holds', () => {
    // The snapshot already has the boundary (the transcript wrote it); the live frames of that turn replay it.
    let s = fromHistory([
      { type: 'context-cleared', at: 'T1' },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'one' }], usage: { input_tokens: 30_000 } } },
      { type: 'context-compacted', uuid: 'b1', at: 'T2', preTokens: 30_000 },
    ], 'sess-1');
    s = run([
      { type: 'turn-start', text: '/compact', compact: true },
      { type: 'system', subtype: 'compact_boundary', uuid: 'b1', compact_metadata: { pre_tokens: 30_000 } },
      { type: 'result', subtype: 'success', result: '', local_command: 'compact', total_cost_usd: 0.46 },
      { type: 'turn-end', exitCode: 0, costUsd: 0.46 },
    ], s);
    expect(s.items.filter(it => it.kind === 'divider' && it.variant === 'compacted')).toHaveLength(1);
    expect(s.extraCostUsd).toBe(0);
    expect(costSinceCleared(s)).toBeCloseTo(0.46);
  });

  it('does the same through mergeHistory, live frames over a snapshot that has the boundary', () => {
    const s = mergeHistory({
      entries: [
        { type: 'context-cleared', at: 'T1' },
        { type: 'context-compacted', uuid: 'b1', at: 'T2', preTokens: 30_000 },
      ], sessionId: 'sess-1', running: true,
    }, [
      { type: 'turn-start', text: '/compact', compact: true },
      { type: 'system', subtype: 'compact_boundary', uuid: 'b1', compact_metadata: { pre_tokens: 30_000 } },
      { type: 'turn-end', exitCode: 0, costUsd: 0.46 },
    ]);
    expect(s.extraCostUsd).toBe(0);
    expect(costSinceCleared(s)).toBeCloseTo(0.46);
  });
});

// Bugbot on #755: a reload during a later turn replayed earlier turns'
// "Command running in background" results and showed those cards running again.
describe('fromHistory: only the running turn\'s background calls can still run', () => {
  const bg = (id: string, task: string) => [
    { type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `run ${id}`, run_in_background: true } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${task}. Output is being written to: /tmp/${task}.output` }] } },
  ];
  const card = (s: ChatState, id: string) => (s.items.find(i => i.kind === 'tool' && i.id === id) as Extract<ChatState['items'][number], { kind: 'tool' }>).background;
  const earlier = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
    ...bg('old', 'b-old'),
    { type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: 'Stopped before it said.' }] } },
  ];

  it('settles an earlier turn\'s card while a new turn runs, and keeps the new turn\'s', () => {
    const turn = { turnId: 't2', events: [{ type: 'turn-start', text: 'second', live: true }, ...bg('new', 'b-new')].map((event, i) => ({ seq: i + 1, event })) };
    const s = fromHistory(earlier, 's1', turn, [], { running: true, liveInput: true });
    expect(s.running).toBe(true);
    expect(card(s, 'old')).toBe('stopped');
    expect(card(s, 'new')).toBe('running');
  });

  it('settles a running turn\'s card whose task the box no longer lists, by the head of a cut replay', () => {
    const head = [
      { type: 'turn-start', text: 'second', live: true },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b-two', description: 'two' }] },
    ];
    const events = [...bg('one', 'b-one'), ...bg('two', 'b-two')].map((event, i) => ({ seq: 6001 + i, event }));
    const s = fromHistory(earlier, 's1', { turnId: 't2', events, head }, [], { running: true, liveInput: true });
    expect(card(s, 'one')).toBe('stopped');
    expect(card(s, 'two')).toBe('running');
  });

  it('an older agent\'s snapshot (no replay) settles cards before the running turn\'s prompt, found after the last finished turn', () => {
    const turns = [{ turnId: 't1', prompt: 'first', userUuid: 'u1', costUsd: null, durationMs: null }];
    const s = mergeHistory({ entries: [...earlier, { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } }, ...bg('new', 'b-new')], sessionId: 's1', running: true, turns }, []);
    expect(card(s, 'old')).toBe('stopped');
    expect(card(s, 'new')).toBe('running');
  });
});

// Bugbot on #755: mergeHistory (an agent with no turn replay) took the last
// user line for the running turn's prompt, so a message taken in while the
// turn waited settled that turn's own background cards.
describe('mergeHistory: the running turn\'s prompt is the line that started it', () => {
  const bg = (id: string) => [
    { type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `run ${id}`, run_in_background: true } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: b-${id}.` }] } },
  ];
  const card = (s: ChatState, id: string) => (s.items.find(i => i.kind === 'tool' && i.id === id) as Extract<ChatState['items'][number], { kind: 'tool' }>).background;
  const finished = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } }, ...bg('old'),
    { type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: 'Done.' }] } },
  ];
  const records = [{ turnId: 't1', prompt: 'first', userUuid: 'u1', costUsd: 0.01, durationMs: 1000 }];

  it('a message taken in while the turn waited does not end the turn\'s own cards', () => {
    const entries = [
      ...finished,
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } }, ...bg('new'),
      { type: 'assistant', message: { id: 'a2', content: [{ type: 'text', text: 'Started.' }] } },
      // Taken in while the turn only waited: a plain user line in the transcript.
      { type: 'user', uuid: 'u3', message: { role: 'user', content: 'and the docs?' } },
      // Taken in mid-work: the agent's entry from a queued_command.
      { type: 'user', uuid: 'u4', queued: true, message: { role: 'user', content: 'and the tests?' } },
    ];
    const s = mergeHistory({ entries, sessionId: 's1', running: true, turns: records }, []);
    expect(card(s, 'new')).toBe('running');
    expect(card(s, 'old')).toBe('stopped');
  });

  it('with no finished turn to go by, leaves a card running rather than guess', () => {
    const entries = [
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } }, ...bg('new'),
      { type: 'user', uuid: 'u3', message: { role: 'user', content: 'and the docs?' } },
    ];
    expect(card(mergeHistory({ entries, sessionId: 's1', running: true }, []), 'new')).toBe('running');
  });
});

describe('mergeHistory: a message taken in mid-turn is not the prompt a new turn-start matches', () => {
  it('a turn-start repeating a mid-turn message is a new bubble, and the old turn keeps its own', () => {
    const entries = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } },
      { type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: 'Working.' }] } },
      { type: 'user', uuid: 'u2', queued: true, message: { role: 'user', content: 'yes' } },
    ];
    const s = mergeHistory({ entries, sessionId: 's1', running: false }, [{ type: 'turn-start', text: 'yes' }]);
    expect(s.items.filter(i => i.kind === 'user').map(i => i.text)).toEqual(['go', 'yes', 'yes']);
    expect(s.running).toBe(true);
  });
});

describe('since-cleared cost past the history cap (Bugbot #738)', () => {
  it('counts the turns after the clear whose bubbles the cap cut, by when they ended', () => {
    // The cap kept the clear's divider and the newest bubble; an earlier turn after the clear was cut.
    const s = fromHistory([
      { type: 'context-cleared', at: '2026-10-26T12:00:00.000Z' },
      { type: 'user', uuid: 'u9', message: { role: 'user', content: 'latest' } },
      { type: 'assistant', message: { id: 'm9', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ], 'sess-2', null, [
      { turnId: 't0', prompt: 'before the clear', userUuid: 'old', at: '2026-10-26T11:00:00.000Z', costUsd: 5, durationMs: 1 },
      { turnId: 't1', prompt: 'cut by the cap', userUuid: 'u-cut', at: '2026-10-26T13:00:00.000Z', costUsd: 0.2, durationMs: 1 },
      { turnId: 't2', prompt: 'latest', userUuid: 'u9', at: '2026-10-26T14:00:00.000Z', costUsd: 0.1, durationMs: 1 },
    ]);
    expect(costSinceCleared(s)).toBeCloseTo(0.3);
    // The total is unchanged: every record still counts once.
    expect(chatCostTotal(s)).toBeCloseTo(5.3);
  });
});

describe('turn-start: whether the box asks for tool-group headings', () => {
  it('is on only when the turn-start says so (agent tool-group-headings), off for an ask, an older box, a flag-off sender', () => {
    expect(applyEvent(emptyChat, { type: 'turn-start', text: 'go', headings: true }).turnHeadings).toBe(true);
    expect(applyEvent(emptyChat, { type: 'turn-start', text: 'go' }).turnHeadings).toBe(false);
  });
});

describe('mergeHistory: a turn-start taken over the snapshot keeps whether the box asks for headings', () => {
  it('copies `headings` from the live turn-start, as it does `live`', () => {
    const entries = [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } }];
    const merged = mergeHistory({ entries, sessionId: 's1', running: true, turns: [] }, [{ type: 'turn-start', text: 'go', live: true, headings: true }]);
    expect(merged.liveTurn).toBe(true);
    expect(merged.turnHeadings).toBe(true);
    expect(mergeHistory({ entries, sessionId: 's1', running: true, turns: [] }, [{ type: 'turn-start', text: 'go' }]).turnHeadings).toBe(false);
  });
});

describe('stopChoices', () => {
  const bash = (description: string) => ({ description, subagent: false });
  const agent = (description: string) => ({ description, subagent: true });

  it('offers nothing when a stop has nothing in the background to keep or end', () => {
    expect(stopChoices([], 'split')).toEqual([]);
    expect(stopChoices([agent('Review the diff')], 'split')).toEqual([]);
    expect(stopChoices([], 'plain')).toEqual([]);
  });
  it('offers Claude alone or with its background commands, where the turn can stop on its own', () => {
    expect(stopChoices([bash('Run the test suite')], 'split')).toEqual([
      { scope: 'turn', label: 'Stop Claude', hint: 'Its background task keeps running' },
      { scope: 'all', label: 'Stop Claude and background tasks', hint: 'Also ends: Run the test suite' },
    ]);
    const [turn, all] = stopChoices([bash('Run the test suite'), bash('Build'), agent('Review'), bash('Lint')], 'split');
    expect(turn.hint).toBe('Its 3 background tasks keep running; the background subagent ends');
    expect(all.hint).toBe('Also ends: Run the test suite, Build and 2 more');
  });
  it('offers only the stop of everything where that is all the turn can do', () => {
    expect(stopChoices([bash('Run the test suite')], 'plain')).toEqual([
      { scope: 'all', label: 'Stop Claude and background tasks', hint: 'Also ends: Run the test suite' },
    ]);
    expect(stopChoices([bash('Run the test suite'), bash('Build')], 'background')).toEqual([
      { scope: 'all', label: 'Stop background tasks', hint: 'Claude has answered. Ends: Run the test suite, Build' },
    ]);
  });
  it('counts the tasks when one has no description', () => {
    expect(stopChoices([bash(''), bash('Build')], 'plain')[0].hint).toBe('Also ends the 2 background tasks');
  });
});

describe('desktopTurnStatus', () => {
  it("says the desktop app's thread is working on the session, or waiting there, not that the chat is done", () => {
    expect(desktopTurnStatus({ status: 'working', source: 't3:claude' })).toEqual({ tone: 'working', text: 'Working in the desktop app' });
    expect(desktopTurnStatus({ status: 'waiting', source: 't3:claude' })).toEqual({ tone: 'working', text: 'Waiting for you in the desktop app' });
  });

  it("is nothing for the chat's own runner, a pane, a resting thread or no status", () => {
    for (const st of [{ status: 'working', source: 'chat-runner' }, { status: 'working', source: 'claude' }, { status: 'idle', source: 't3:claude' }, { status: 'working' }, undefined]) {
      expect(desktopTurnStatus(st)).toBeNull();
    }
  });
});

describe('desktopTurnStep', () => {
  it("is a new step each time the desktop app's thread posts on the session, its last (the stop) too", () => {
    const steps = [
      { status: 'working', source: 't3:claude', updatedAt: '2026-11-03T21:00:00.000Z' },
      { status: 'working', source: 't3:claude', updatedAt: '2026-11-03T21:00:04.000Z' },
      { status: 'idle', source: 't3:claude', updatedAt: '2026-11-03T21:00:09.000Z' },
    ].map(desktopTurnStep);
    expect(new Set(steps).size).toBe(3);
    expect(steps.every(step => step !== null)).toBe(true);
  });

  it("is nothing for the chat's own runner, a pane or no status", () => {
    for (const st of [{ status: 'working', source: 'chat-runner', updatedAt: 'x' }, { status: 'working', source: 'claude', updatedAt: 'x' }, { status: 'working', updatedAt: 'x' }, undefined]) {
      expect(desktopTurnStep(st)).toBeNull();
    }
  });

  it('stays one step at rest, so a metadata-only push reads nothing', () => {
    const rest = (updatedAt: string) => desktopTurnStep({ status: 'idle', source: 't3:claude', updatedAt });
    expect(rest('2026-11-03T21:00:09.000Z')).toBe(rest('2026-11-03T21:03:00.000Z'));
    expect(desktopTurnStep({ status: 'not_running', source: 't3:claude', updatedAt: 'x' })).toBe(rest('y'));
  });
});

describe('desktopStepReloads', () => {
  it('reads again for a new step on the chat on screen', () => {
    expect(desktopStepReloads({ chatId: 'p|main', step: 'working|1' }, 'p|main', 'working|2')).toBe(true);
    expect(desktopStepReloads({ chatId: 'p|main', step: null }, 'p|main', 'working|1')).toBe(true);
  });

  it('never for the step a chat opens or switches with, the same step, or none', () => {
    expect(desktopStepReloads(null, 'p|main', 'idle|0')).toBe(false);
    expect(desktopStepReloads({ chatId: 'q|main', step: 'working|1' }, 'p|main', 'idle|0')).toBe(false);
    expect(desktopStepReloads({ chatId: 'p|main', step: 'working|1' }, 'p|main', 'working|1')).toBe(false);
    expect(desktopStepReloads({ chatId: 'p|main', step: 'working|1' }, 'p|main', null)).toBe(false);
  });
});

describe('withWaiting', () => {
  it('adds a queued bubble for each waiting message, images by their box references', () => {
    const s = withWaiting(emptyChat, [{ text: 'look at this', images: [{ id: 'a', path: '/img/a.png', mediaType: 'image/png' }] }, { nope: 1 }]);
    expect(s.items).toEqual([expect.objectContaining({ kind: 'user', text: 'look at this', pending: true, images: [{ mediaType: 'image/png', path: '/img/a.png' }] })]);
  });

  it('leaves the chat alone for an older agent that sends none', () => {
    expect(withWaiting(emptyChat, undefined)).toBe(emptyChat);
  });

  it('is taken in by a live turn that reads it', () => {
    const s = run([{ type: 'user', isReplay: true, uuid: 'u2', message: { role: 'user', content: 'and this?' } }], withWaiting({ ...emptyChat, running: true }, [{ text: 'and this?' }]));
    expect(s.items).toEqual([expect.objectContaining({ kind: 'user', text: 'and this?', midTurn: true })]);
    expect(s.items[0]).not.toHaveProperty('pending');
  });
});
