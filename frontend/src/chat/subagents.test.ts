import { describe, expect, it } from 'vitest';
import { applyEvent, emptyChat, fromHistory, tasksLine, type ChatItem, type ChatState } from './sdkChat';
import { agentResult, notificationInfo, recentSubagents, reportGist, subagentLine, subagentsOf, subagentsSummary, taskEvent } from './subagents';

const run = (events: unknown[], from: ChatState = emptyChat) => events.reduce<ChatState>(applyEvent, from);
const kinds = (items: ChatItem[]) => items.map(i => (i.kind === 'tool' ? `tool:${i.name}` : i.kind));

// Claude Code 2.1.312's own words, from `claude -p --output-format stream-json --verbose` and the session file.
const HAND_BACK = "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:\n  pong\n  and more\nagentId: afe6c366effdaa87c (use SendMessage with to: 'afe6c366effdaa87c', summary: '<5-10 word recap>' to continue this agent)\n<usage>subagent_tokens: 23854\ntool_uses: 0\nduration_ms: 1194</usage>";
const LAUNCHED = "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: aacba55454ef877bf (internal ID - do not mention to user.)\nThe agent is working in the background. You will be notified automatically when it completes.";
const NOTE = '<task-notification>\n<task-id>aacba55454ef877bf</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<output-file>/tmp/x/tasks/aacba55454ef877bf.output</output-file>\n<status>completed</status>\n<summary>Agent "List files" finished</summary>\n<note>A task-notification fires each time this agent stops.</note>\n<result>The directory has 6 entries &amp; 4 real ones.</result>\n<usage><subagent_tokens>26614</subagent_tokens><tool_uses>1</tool_uses><duration_ms>3519</duration_ms></usage>\n</task-notification>';

const fgCall = { type: 'tool_use', id: 'toolu_fg', name: 'Agent', input: { description: 'Say pong', prompt: 'Reply with the single word pong.', subagent_type: 'general-purpose', run_in_background: false } };
const bgCall = { type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { description: 'List files', prompt: 'Run ls -la, then reply with the number of entries.', subagent_type: 'general-purpose', run_in_background: true } };

const foreground = [
  { type: 'turn-start', text: 'spin up a subagent' },
  { type: 'assistant', message: { id: 'm1', content: [fgCall] } },
  { type: 'system', subtype: 'task_started', task_id: 'afe6c366effdaa87c', tool_use_id: 'toolu_fg', description: 'Say pong', subagent_type: 'general-purpose', is_backgrounded: false, task_type: 'local_agent', prompt: 'Reply with the single word pong.' },
  // The prompt, as the subagent's own first message: it was a bubble in the chat.
  { type: 'user', parent_tool_use_id: 'toolu_fg', message: { role: 'user', content: [{ type: 'text', text: 'Reply with the single word pong.' }] } },
  { type: 'system', subtype: 'task_updated', task_id: 'afe6c366effdaa87c', patch: { status: 'completed', end_time: 1793231958956 } },
  { type: 'system', subtype: 'task_notification', task_id: 'afe6c366effdaa87c', tool_use_id: 'toolu_fg', status: 'completed', output_file: '/tmp/x/tasks/afe6c366effdaa87c.output', summary: 'pong', usage: { total_tokens: 23855, tool_uses: 0, duration_ms: 1193 } },
  {
    type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_fg', type: 'tool_result', content: [{ type: 'text', text: HAND_BACK }] }] },
    tool_use_result: { status: 'completed', agentId: 'afe6c366effdaa87c', agentType: 'general-purpose', content: [{ type: 'text', text: 'pong' }], resolvedModel: 'claude-sonnet-5-5', totalDurationMs: 1194, totalTokens: 23854, totalToolUseCount: 0 },
  },
  { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'pong' }] } },
];

const background = [
  { type: 'turn-start', text: 'list the files in the background', live: true },
  { type: 'assistant', message: { id: 'm1', content: [bgCall] } },
  { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'aacba55454ef877bf', task_type: 'local_agent', subagent_type: 'general-purpose', description: 'List files' }] },
  { type: 'system', subtype: 'task_started', task_id: 'aacba55454ef877bf', tool_use_id: 'toolu_bg', description: 'List files', subagent_type: 'general-purpose', is_backgrounded: true, task_type: 'local_agent', prompt: 'Run ls -la, then reply with the number of entries.' },
  {
    type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_bg', type: 'tool_result', content: [{ type: 'text', text: LAUNCHED }] }] },
    tool_use_result: { isAsync: true, status: 'async_launched', agentId: 'aacba55454ef877bf', description: 'List files', resolvedModel: 'claude-sonnet-5-5' },
  },
  { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'The agent is running in the background.' }] } },
  { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01 },
  // Its own work, under its call's id.
  { type: 'assistant', parent_tool_use_id: 'toolu_bg', message: { id: 's1', content: [{ type: 'tool_use', id: 'toolu_ls', name: 'Bash', input: { command: 'ls -la', description: 'List directory contents' } }] } },
  { type: 'system', subtype: 'task_progress', task_id: 'aacba55454ef877bf', tool_use_id: 'toolu_bg', description: 'Running List directory contents', usage: { total_tokens: 22107, tool_uses: 1, duration_ms: 1192 }, last_tool_name: 'Bash' },
];
const backgroundEnd = [
  { type: 'user', parent_tool_use_id: 'toolu_bg', message: { role: 'user', content: [{ tool_use_id: 'toolu_ls', type: 'tool_result', content: 'total 176\n.\n..' }] } },
  { type: 'assistant', parent_tool_use_id: 'toolu_bg', message: { id: 's2', content: [{ type: 'text', text: 'The directory has 6 entries.' }] } },
  { type: 'system', subtype: 'task_updated', task_id: 'aacba55454ef877bf', patch: { status: 'completed', end_time: 1793231998860 } },
  { type: 'system', subtype: 'task_notification', task_id: 'aacba55454ef877bf', tool_use_id: 'toolu_bg', status: 'completed', output_file: '/tmp/x/tasks/aacba55454ef877bf.output', summary: 'The directory has 6 entries.', usage: { total_tokens: 26614, tool_uses: 1, duration_ms: 3519 } },
  { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
  { type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: 'It found 6 entries.' }] } },
];

describe('a foreground subagent, live', () => {
  const s = run(foreground);

  it('keeps its prompt and its end out of the chat: the call, then Claude\'s answer', () => {
    expect(kinds(s.items)).toEqual(['user', 'tool:Agent', 'text']);
    expect(s.items.some(it => it.kind === 'user' && it.text === 'Reply with the single word pong.')).toBe(false);
    // No "finished in background", no "Background command finished" line: it ran in the foreground.
    expect(s.items[1]).toMatchObject({ kind: 'tool', done: true });
    expect((s.items[1] as Extract<ChatItem, { kind: 'tool' }>).background).toBeUndefined();
  });

  it('is one subagent with its id, report and usage, its prompt in its own transcript', () => {
    const [a] = subagentsOf(s);
    expect(a).toMatchObject({
      id: 'toolu_fg', description: 'Say pong', agentType: 'general-purpose', background: false, status: 'done',
      agentId: 'afe6c366effdaa87c', report: 'pong', tokens: 23854, toolUses: 0, durationMs: 1194, model: 'claude-sonnet-5-5',
    });
    expect(kinds(a.items)).toEqual(['user']);
    expect(a.items[0]).toMatchObject({ text: 'Reply with the single word pong.' });
  });

  it('is running until its result comes', () => {
    const [a] = subagentsOf(run(foreground.slice(0, 4)));
    expect(a.status).toBe('running');
  });
});

describe('a background subagent, live', () => {
  it('runs in the background from its launch, on the step its progress says, its own calls in its transcript', () => {
    const s = run(background);
    expect(kinds(s.items)).toEqual(['user', 'tool:Agent', 'text']);
    expect(s.items[1]).toMatchObject({ background: 'running', taskId: 'aacba55454ef877bf' });
    const [a] = subagentsOf(s);
    expect(a).toMatchObject({ status: 'running', background: true, step: 'Running List directory contents', tokens: 22107, toolUses: 1 });
    expect(kinds(a.items)).toEqual(['tool:Bash']);
    expect(a.items[0]).toMatchObject({ done: false });
    // The chat waits on it: its work doesn't set the chat going again.
    expect(s.phase).toBe('waiting');
    expect(s.woken).toBeFalsy();
  });

  it('ends with its notification: its report, its usage, a line named by its call, its own work settled', () => {
    const s = run([...background, ...backgroundEnd]);
    expect(kinds(s.items)).toEqual(['user', 'tool:Agent', 'text', 'tasks', 'text']);
    expect(s.items[1]).toMatchObject({ background: 'done' });
    const tasks = s.items[3] as Extract<ChatItem, { kind: 'tasks' }>;
    expect(tasks.ended).toEqual([expect.objectContaining({ label: 'List files', agent: true, status: 'done' })]);
    expect(tasksLine(tasks).text).toBe('Background agent finished: List files');
    const [a] = subagentsOf(s);
    expect(a).toMatchObject({ status: 'done', report: 'The directory has 6 entries.', tokens: 26614, step: null });
    expect(kinds(a.items)).toEqual(['tool:Bash', 'text']);
    expect(a.items[0]).toMatchObject({ done: true, result: 'total 176\n.\n..' });
  });

  it('has stopped when the turn ends with it unreported', () => {
    const [a] = subagentsOf(run([...background, { type: 'turn-end', exitCode: 0 }]));
    expect(a.status).toBe('stopped');
    expect(a.items[0]).toMatchObject({ done: true });
  });
});

describe('subagents in a transcript', () => {
  it('a foreground one: its id, report and usage from its call\'s result', () => {
    const s = fromHistory([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'spin up a subagent' } },
      { type: 'assistant', message: { id: 'm1', content: [fgCall] } },
      { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_fg', type: 'tool_result', content: [{ type: 'text', text: HAND_BACK }] }] } },
    ]);
    expect(subagentsOf(s)[0]).toMatchObject({ status: 'done', agentId: 'afe6c366effdaa87c', report: 'pong\nand more', tokens: 23854, toolUses: 0, durationMs: 1194, items: [] });
  });

  it('a background one: stopped with nothing running and no notification, done with its notification, which carries its report', () => {
    const launched = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'list the files in the background' } },
      { type: 'assistant', message: { id: 'm1', content: [bgCall] } },
      { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_bg', type: 'tool_result', content: [{ type: 'text', text: LAUNCHED }] }] } },
    ];
    expect(subagentsOf(fromHistory(launched, null, null, [], { running: false }))[0]).toMatchObject({ status: 'stopped', agentId: 'aacba55454ef877bf', background: true });
    const s = fromHistory([...launched, { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: NOTE } }]);
    expect(kinds(s.items)).toEqual(['user', 'tool:Agent', 'tasks']);
    expect(subagentsOf(s)[0]).toMatchObject({ status: 'done', report: 'The directory has 6 entries & 4 real ones.', tokens: 26614, toolUses: 1, durationMs: 3519 });
    expect(tasksLine(s.items[2] as Extract<ChatItem, { kind: 'tasks' }>).text).toBe('Background agent finished: List files');
  });

  it('a failed one says so', () => {
    const s = fromHistory([
      { type: 'assistant', message: { id: 'm1', content: [fgCall] } },
      { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_fg', type: 'tool_result', is_error: true, content: 'Agent failed: overloaded' }] } },
    ]);
    expect(subagentsOf(s)[0]).toMatchObject({ status: 'failed', report: 'Agent failed: overloaded' });
  });
});

describe('what is not a subagent', () => {
  it('a background command\'s notification keeps its line and makes no subagent', () => {
    const s = run([
      { type: 'turn-start', text: 'run the tests' },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tb', name: 'Bash', input: { command: 'npm test', run_in_background: true } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tb', content: 'Command running in background with ID: b1' }] } },
      { type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'tb', status: 'completed', output_file: '/tmp/b1.output', summary: 'Background command "npm test" completed (exit code 0)' },
    ]);
    expect(s.subagents).toBeUndefined();
    expect(tasksLine(s.items[s.items.length - 1] as Extract<ChatItem, { kind: 'tasks' }>).text).toBe('Background command finished: npm test (exit 0)');
  });
});

describe('a subagent of a subagent', () => {
  it('folds into the one that called it', () => {
    const s = run([
      { type: 'turn-start', text: 'nest them' },
      { type: 'assistant', message: { id: 'm1', content: [fgCall] } },
      { type: 'assistant', parent_tool_use_id: 'toolu_fg', message: { id: 's1', content: [{ type: 'tool_use', id: 'toolu_inner', name: 'Agent', input: { description: 'Inner', prompt: 'go' } }] } },
      { type: 'system', subtype: 'task_started', task_id: 'ainner', tool_use_id: 'toolu_inner', description: 'Inner', task_type: 'local_agent', is_backgrounded: false },
      { type: 'assistant', parent_tool_use_id: 'toolu_inner', message: { id: 's2', content: [{ type: 'text', text: 'deep' }] } },
      { type: 'system', subtype: 'task_progress', task_id: 'ainner', tool_use_id: 'toolu_inner', description: 'Writing', usage: { total_tokens: 5, tool_uses: 0, duration_ms: 1 } },
    ]);
    expect(Object.keys(s.subagents ?? {})).toEqual(['toolu_fg']);
    const [outer] = subagentsOf(s);
    expect(kinds(outer.items)).toEqual(['tool:Agent']);
    const [inner] = subagentsOf(outer.nested);
    expect(inner).toMatchObject({ description: 'Inner', agentId: 'ainner', step: 'Writing', status: 'running' });
    expect(kinds(inner.items)).toEqual(['text']);
  });

  it('its end is the one that called it\'s: no line in the chat, and it stops when the turn ends with it unreported', () => {
    const nested = [
      { type: 'turn-start', text: 'nest them' },
      { type: 'assistant', message: { id: 'm1', content: [fgCall] } },
      { type: 'assistant', parent_tool_use_id: 'toolu_fg', message: { id: 's1', content: [{ type: 'tool_use', id: 'toolu_inner', name: 'Agent', input: { description: 'Inner', prompt: 'go' } }] } },
      { type: 'system', subtype: 'task_started', task_id: 'ainner', tool_use_id: 'toolu_inner', description: 'Inner', task_type: 'local_agent', is_backgrounded: false },
    ];
    const ended = run([...nested, { type: 'system', subtype: 'task_notification', task_id: 'ainner', tool_use_id: 'toolu_inner', status: 'completed', output_file: '/tmp/x/ainner.output', summary: 'deep' }]);
    expect(kinds(ended.items)).toEqual(['user', 'tool:Agent']);
    expect(ended.phase).not.toBe('thinking');
    expect(subagentsOf(subagentsOf(ended)[0].nested)[0]).toMatchObject({ status: 'done', report: 'deep' });
    const stopped = run([...nested, { type: 'turn-end', exitCode: 0 }]);
    const [outer] = subagentsOf(stopped);
    expect(outer.status).toBe('stopped');
    expect(subagentsOf(outer.nested)[0].status).toBe('stopped');
  });
});

describe('reading what Claude Code says', () => {
  it('a foreground result\'s report, past its frame and indent', () => {
    expect(agentResult(HAND_BACK, false)).toMatchObject({ agentId: 'afe6c366effdaa87c', report: 'pong\nand more', status: 'done', tokens: 23854 });
  });

  it('a background launch', () => {
    expect(agentResult(LAUNCHED, false)).toEqual({ agentId: 'aacba55454ef877bf', background: true });
  });

  it('a notification\'s report and usage', () => {
    expect(notificationInfo(NOTE)).toEqual({ report: 'The directory has 6 entries & 4 real ones.', tokens: 26614, toolUses: 1, durationMs: 3519 });
  });

  it('only a local agent\'s task_started is a subagent\'s', () => {
    expect(taskEvent({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'tb', task_type: 'local_bash' })).toBeNull();
    expect(taskEvent({ type: 'system', subtype: 'task_started', task_id: '../x', tool_use_id: 'ta', task_type: 'local_agent' })?.info.agentId).toBeUndefined();
  });
});

describe('a subagent in a few words', () => {
  const call = { startedAt: '2026-10-28T12:00:00.000Z', endedAt: '2026-10-28T12:00:45.000Z' } as Extract<ChatItem, { kind: 'tool' }>;
  const now = Date.parse('2026-10-28T12:01:05.000Z');
  it('says its tools and its time so far while it runs', () => {
    expect(subagentLine({ status: 'running', durationMs: null, call, toolUses: 2, background: false }, now)).toBe('2 tools · 1m 5s');
    expect(subagentLine({ status: 'running', durationMs: null, call: { ...call, startedAt: null }, toolUses: null, background: true }, now)).toBe('in the background');
    // A guessed start (a call that streamed with no time) is not counted from: its progress's time is.
    expect(subagentLine({ status: 'running', durationMs: 6_000, call: { ...call, startGuessed: true }, toolUses: 1, background: true }, now)).toBe('1 tool · 6s');
  });
  it('says how long it took once it ends: its usage, else its call\'s span', () => {
    expect(subagentLine({ status: 'done', durationMs: 3519, call, toolUses: 1, background: true }, now)).toBe('finished in 4s');
    expect(subagentLine({ status: 'done', durationMs: null, call, toolUses: null, background: false }, now)).toBe('finished in 45s');
    // A background one's call ends at its launch, which says nothing of how long it ran.
    expect(subagentLine({ status: 'done', durationMs: null, call, toolUses: null, background: true }, now)).toBe('finished');
    expect(subagentLine({ status: 'failed', durationMs: 12_000, call, toolUses: 0, background: false }, now)).toBe('failed after 12s');
    expect(subagentLine({ status: 'stopped', durationMs: null, call, toolUses: 3, background: false }, now)).toBe('stopped');
  });
});

describe('the subagents kept in view', () => {
  it('are those started since the last message sent, and any still running', () => {
    const s = run([
      { type: 'turn-start', text: 'first' },
      { type: 'assistant', message: { id: 'm1', content: [bgCall] } },
      { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_bg', type: 'tool_result', content: [{ type: 'text', text: LAUNCHED }] }] } },
      { type: 'result', subtype: 'success' },
      { type: 'turn-end', exitCode: 0 },
      { type: 'turn-start', text: 'second' },
      { type: 'assistant', message: { id: 'm2', content: [fgCall] } },
    ]);
    // The first turn's background agent stopped with its turn; the second's runs.
    expect(recentSubagents(s.items, subagentsOf(s)).map(v => v.id)).toEqual(['toolu_fg']);
    // Once that turn ends and another starts, the new turn has none yet.
    const next = run([{ type: 'turn-end', exitCode: 0 }, { type: 'turn-start', text: 'third' }], s);
    expect(recentSubagents(next.items, subagentsOf(next))).toEqual([]);
  });

  it('read as a summary and a report\'s first plain words', () => {
    expect(subagentsSummary([{ status: 'running' }, { status: 'running' }, { status: 'done' }])).toBe('2 running · 1 done');
    expect(subagentsSummary([{ status: 'done' }, { status: 'failed' }])).toBe('1 done · 1 failed');
    expect(reportGist('**3 callers.**\n\n| a |')).toBe('3 callers.');
    expect(reportGist('## Layout\n- `src/` holds it')).toBe('Layout');
    expect(reportGist('```\nx\n```\nAll [14 tests](http://x) pass')).toBe('x');
    expect(reportGist(null)).toBeNull();
  });
});
