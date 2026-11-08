import { describe, expect, it } from 'vitest';
import type { ChatItem } from './sdkChat';
import { alwaysShown, groupToolRuns, runHeading, runSummary, toolIntent, toolLabel, type HeadingContext, type ToolItem } from './toolRuns';

/** The run's counts and state with its heading line, as ToolRun shows them. */
const summary = (tools: ToolItem[], ctx: HeadingContext = {}) => ({ ...runSummary(tools), ...runHeading(tools, ctx) });

function tool(id: string, name = 'Bash', over: Partial<ToolItem> = {}): ToolItem {
  return { kind: 'tool', key: `tool:${id}`, id, name, input: {}, inputJson: '', result: 'ok', isError: false, done: true, ...over };
}
const text = (key: string, t: string, streaming = false): ChatItem => ({ kind: 'text', key, text: t, streaming });
const bash = (id: string, command: string, description?: string, over: Partial<ToolItem> = {}) =>
  tool(id, 'Bash', { input: description ? { command, description } : { command }, ...over });
const read = (id: string, path: string, over: Partial<ToolItem> = {}) => tool(id, 'Read', { input: { file_path: path }, ...over });

describe('groupToolRuns', () => {
  it('folds consecutive tool calls into one run and leaves prose between runs', () => {
    const items: ChatItem[] = [text('a', 'Starting.'), tool('1'), tool('2'), tool('3'), text('b', 'Next.'), tool('4'), tool('5')];
    const out = groupToolRuns(items);
    expect(out.map(e => (e.kind === 'tools' ? `run(${e.tools.map(t => t.id).join(',')})` : e.item.key))).toEqual([
      'a', 'run(1,2,3)', 'b', 'run(4,5)',
    ]);
  });

  it('keeps a lone call as its own card', () => {
    const out = groupToolRuns([text('a', 'Look.'), tool('1'), text('b', 'Done.')]);
    expect(out.map(e => e.kind)).toEqual(['item', 'item', 'item']);
    expect(out[1]).toEqual({ kind: 'item', item: tool('1') });
  });

  it('keys a run by its first call, so it keeps its identity as calls are added', () => {
    const before = groupToolRuns([tool('1'), tool('2')]);
    const after = groupToolRuns([tool('1'), tool('2'), tool('3')]);
    expect(before[0].kind === 'tools' && before[0].key).toBe('run:tool:1');
    expect(after[0].kind === 'tools' && after[0].key).toBe('run:tool:1');
  });

  it('does not let an empty finished text block split a run, but a streaming one does', () => {
    expect(groupToolRuns([tool('1'), text('e', '  '), tool('2')]).map(e => e.kind)).toEqual(['tools']);
    expect(groupToolRuns([tool('1'), text('s', '', true), tool('2')]).map(e => e.kind)).toEqual(['item', 'item', 'item']);
  });

  it('carries the text just before a run as its lead-in', () => {
    const out = groupToolRuns([text('a', 'Let me check the build.'), tool('1'), tool('2'), { kind: 'user', key: 'u', text: 'hi' }, tool('3'), tool('4')]);
    expect(out[1]).toMatchObject({ kind: 'tools', leadIn: 'Let me check the build.' });
    expect(out[3]).toMatchObject({ kind: 'tools', leadIn: null });
    // An empty text block between the lead-in and the run does not hide it.
    expect(groupToolRuns([text('a', 'Let me look.'), text('e', ' '), tool('1'), tool('2')])[1]).toMatchObject({ leadIn: 'Let me look.' });
  });

  it('breaks a run at a user message or an error', () => {
    const items: ChatItem[] = [tool('1'), tool('2'), { kind: 'error', key: 'x', text: 'boom' }, tool('3'), { kind: 'user', key: 'u', text: 'hi' }, tool('4')];
    expect(groupToolRuns(items).map(e => e.kind)).toEqual(['tools', 'item', 'item', 'item', 'item']);
  });
});

describe('runSummary', () => {
  it('says what the run did, by kind, in order of first use', () => {
    expect(summary([tool('1'), tool('2'), tool('3')]).text).toBe('Ran 3 commands');
    expect(summary([tool('1', 'Read'), tool('2', 'Bash'), tool('3', 'Read'), tool('4', 'Edit')]).text)
      .toBe('Read 2 files, ran 1 command, edited 1 file');
    expect(summary([tool('1', 'Grep'), tool('2', 'Glob'), tool('3', 'mcp__x')]).text).toBe('Ran 2 searches, used 1 tool');
  });

  it('counts failures and calls still running', () => {
    const s = summary([tool('1'), tool('2', 'Bash', { isError: true }), tool('3', 'Bash', { done: false, result: null })]);
    expect(s).toMatchObject({ failed: 1, running: 1, state: 'running' });
    expect(summary([tool('1'), tool('2', 'Bash', { isError: true })]).state).toBe('error');
    expect(summary([tool('1'), tool('2')]).state).toBe('done');
  });

  it('takes its state from the last call, so a failure the agent fixed is not an error', () => {
    const fixed = summary([tool('1', 'Bash', { isError: true }), tool('2'), tool('3')]);
    expect(fixed).toMatchObject({ failed: 1, state: 'done' });
    expect(summary([tool('1', 'Bash', { isError: true }), tool('2'), tool('3', 'Bash', { isError: true })]))
      .toMatchObject({ failed: 2, state: 'error' });
  });

  it('is running while any call is, even when a later parallel call already finished', () => {
    expect(summary([tool('1', 'Bash', { isError: true }), tool('2', 'Bash', { done: false, result: null })]).state).toBe('running');
    expect(summary([tool('1', 'Task', { done: false, result: null }), tool('2', 'Task', { isError: true })]).state).toBe('running');
  });
});

describe('alwaysShown', () => {
  it('keeps failures visible while the run is closed, and not the call running now (the step line says it)', () => {
    const failed = tool('2', 'Bash', { isError: true });
    const running = tool('4', 'Read', { done: false, result: null });
    expect(alwaysShown([tool('1'), failed, tool('3'), running])).toEqual([failed]);
    expect(alwaysShown([tool('1'), running])).toEqual([]);
  });

  it('only ever adds calls as a live run goes on, so the run never shrinks under the text above it', () => {
    // Each step of a run: a call starts, ends, the next starts, one fails, the last ends.
    const steps: ToolItem[][] = [
      [tool('1', 'Bash', { done: false, result: null })],
      [tool('1')],
      [tool('1'), tool('2', 'Read', { done: false, result: null })],
      [tool('1'), tool('2', 'Read', { isError: true })],
      [tool('1'), tool('2', 'Read', { isError: true }), tool('3', 'Grep', { done: false, result: null })],
      [tool('1'), tool('2', 'Read', { isError: true }), tool('3', 'Grep')],
    ];
    const shown = steps.map(s => alwaysShown(s).map(t => t.id));
    expect(shown).toEqual([[], [], [], ['2'], ['2'], ['2']]);
  });

  it('keeps a call still running in the background visible, and lets it fold once it has finished', () => {
    const bg = tool('2', 'Bash', { background: 'running' });
    expect(alwaysShown([tool('1'), bg, tool('3', 'Bash', { background: 'done' })])).toEqual([bg]);
  });
});

describe('runSummary: background calls', () => {
  it('a run with a call still running in the background is running, not a finished check', () => {
    const s = summary([tool('1'), tool('2', 'Bash', { background: 'running' })]);
    expect(s.state).toBe('running');
    expect(s.running).toBe(1);
    expect(summary([tool('1'), tool('2', 'Bash', { background: 'done' })]).state).toBe('done');
  });
});

describe('runSummary: skills', () => {
  it('counts Skill calls as skills used', () => {
    expect(summary([tool('1', 'Skill'), tool('2'), tool('3')]).text).toBe('Used 1 skill, ran 2 commands');
  });
});

describe('toolIntent and toolLabel', () => {
  it('takes the intent from Bash and subagent descriptions, on one line', () => {
    expect(toolIntent(bash('1', 'gh pr edit 1', 'Append clickable video links\n to each PR description'))).toBe('Append clickable video links to each PR description');
    expect(toolIntent(tool('2', 'Agent', { input: { description: 'Find the sign-in flow', prompt: '…' } }))).toBe('Find the sign-in flow');
    expect(toolIntent(tool('3', 'Task', { input: { description: 'Review the diff' } }))).toBe('Review the diff');
    expect(toolIntent(bash('4', 'ls'))).toBeNull();
    expect(toolIntent(bash('5', 'ls', '   '))).toBeNull();
    expect(toolIntent(read('6', '/r/a.ts'))).toBeNull();
  });

  it('says what a call without an intent touches, and nothing for a bare command', () => {
    expect(toolLabel(read('1', '/repo/src/a.ts'))).toBe('Read a.ts');
    expect(toolLabel(tool('2', 'Edit', { input: { file_path: '/repo/b.ts' } }))).toBe('Edit b.ts');
    expect(toolLabel(tool('3', 'Grep', { input: { pattern: 'TODO' } }))).toBe('Search for TODO');
    expect(toolLabel(tool('4', 'Glob', { input: { pattern: '**/*.md' } }))).toBe('Find **/*.md');
    expect(toolLabel(tool('5', 'WebFetch', { input: { url: 'https://docs.example.com/a?b=1' } }))).toBe('Fetch docs.example.com');
    expect(toolLabel(tool('6', 'WebSearch', { input: { query: 'vitest jsdom' } }))).toBe('Search the web for vitest jsdom');
    expect(toolLabel(bash('7', 'cd /tmp && u(){ termag space url; }'))).toBeNull();
    expect(toolLabel(tool('8', 'mcp__x__y', { input: { q: 'x' } }))).toBeNull();
    // A call whose input is still streaming has nothing to say yet.
    expect(toolLabel(tool('9', 'Read', { input: {}, done: false }))).toBeNull();
  });
});

describe('runSummary: what the run is for', () => {
  it('joins two or three short labels', () => {
    expect(summary([bash('1', 'ls -la', 'List the repository root'), read('2', '/r/README.md')]).text)
      .toBe('List the repository root · Read README.md');
    expect(summary([bash('1', 'git log', 'Show recent commits'), bash('2', 'git status', 'Check for changes'), read('3', '/r/a.ts')]).text)
      .toBe('Show recent commits · Check for changes · Read a.ts');
  });

  it('names the latest intent and counts the rest when the labels would not fit', () => {
    const tools = [
      bash('1', 'ls', 'List the repository root'), bash('2', 'git log', 'Show the last five commits'),
      bash('3', 'npm run lint', 'Run the linter', { isError: true }), bash('4', 'du -sh .', 'Measure the checkout size'),
      read('5', '/r/README.md'),
    ];
    expect(summary(tools)).toMatchObject({ text: 'Measure the checkout size · +4 more', counts: 'Ran 4 commands, read 1 file', failed: 1, state: 'done' });
    const long = [bash('1', 'a', 'Append clickable video links to each PR description'), bash('2', 'b', 'Upload the recordings to the space')];
    expect(summary(long).text).toBe('Upload the recordings to the space · +1 more');
  });

  it('does not join labels when a call in the run has none', () => {
    expect(summary([bash('1', 'make', 'Build it'), bash('2', 'ls')]).text).toBe('Build it · +1 more');
  });

  it('puts the call in progress on the step line while the run is running, never on the heading line', () => {
    const tools = [bash('1', 'ls', 'List the repository root'), bash('2', 'termag ask …', 'Wait for the sign-in agent\'s reply', { done: false, result: null })];
    expect(summary(tools)).toMatchObject({ step: 'Wait for the sign-in agent\'s reply', text: 'List the repository root · Wait for the sign-in agent\'s reply', state: 'running' });
    expect(summary([bash('1', 'ls', 'List the root'), read('2', '/r/a.ts', { done: false, result: null })]).step).toBe('Read a.ts');
  });

  it('falls back to the finished calls while the running one has nothing to say yet', () => {
    const streaming = tool('2', 'Bash', { input: {}, done: false, result: null });
    expect(summary([bash('1', 'ls', 'List the repository root'), streaming]).text).toBe('List the repository root · +1 more');
    expect(summary([bash('1', 'ls'), streaming]).text).toBe('Ran 2 commands');
  });

  it('counts the calls when none of them says what it is for, naming the files of a run of reads', () => {
    expect(summary([bash('1', 'ls'), bash('2', 'pwd')]).text).toBe('Ran 2 commands');
    expect(summary([read('1', '/r/a.ts'), read('2', '/r/b.ts')]).text).toBe('Read 2 files: a.ts, b.ts');
    expect(summary([read('1', '/r/a.ts'), read('2', '/r/b.ts'), read('3', '/r/c.ts'), read('4', '/r/d.ts')]).text).toBe('Read 4 files: a.ts, b.ts…');
    expect(summary([read('1', '/r/a.ts'), read('2', '/r/a.ts')]).text).toBe('Read 2 files: a.ts');
    expect(summary([tool('1', 'Edit', { input: { file_path: '/r/x.ts' } }), tool('2', 'Write', { input: { file_path: '/r/y.ts' } })]).text).toBe('Edited 2 files: x.ts, y.ts');
    expect(summary([read('1', '/r/a.ts'), bash('2', 'ls')]).text).toBe('Read 1 file, ran 1 command');
  });

  it('counts Agent calls as subagents', () => {
    expect(summary([tool('1', 'Agent'), tool('2', 'Agent')]).text).toBe('Started 2 subagents');
  });
});

describe('runHeading: written once, Haiku first, then the fallback', () => {
  const done = [
    bash('1', 'ls -la', 'List the repository root'),
    bash('2', 'npm run lint', 'Run the linter', { isError: true, result: 'missing' }),
    bash('3', 'du -sh .', 'Measure the checkout size'),
  ];
  const lead = 'Let me survey how the repo is set up and whether its checks pass.';

  it('without Haiku\'s headings: Claude\'s lead-in, else the calls\' labels', () => {
    expect(runHeading(done, { leadIn: lead })).toEqual({ text: 'Survey how the repo is set up and whether its checks pass', source: 'lead-in' });
    expect(runHeading(done, { leadIn: 'Done.' })).toEqual({ text: 'List the repository root · Run the linter · Measure the checkout size', source: 'calls' });
  });

  it('with them: the heading, nothing while it may still come, the fallback once it failed or never will come', () => {
    const on = { headingsOn: true, leadIn: lead };
    expect(runHeading(done, { ...on, answer: { heading: 'Check the repo builds and lints' } })).toEqual({ text: 'Check the repo builds and lints', source: 'model' });
    expect(runHeading(done, { ...on, pending: true })).toEqual({ text: null, source: 'pending' });
    expect(runHeading(done, { ...on, answer: { failed: true, calls: 1 } })).toMatchObject({ source: 'lead-in' });
    expect(runHeading(done, { ...on, pending: false }).source).toBe('lead-in');
  });

  it('a failure\'s fallback is made from the calls the run had when it failed, so it is the same however the run grows', () => {
    const failed = { headingsOn: true, answer: { failed: true as const, calls: 2 } };
    const atFailure = runHeading(done.slice(0, 2), failed);
    expect(atFailure).toEqual({ text: 'List the repository root · Run the linter', source: 'calls' });
    expect(runHeading(done, failed)).toEqual(atFailure);
    expect(runHeading([...done, bash('4', 'pwd', 'Print the directory')], failed)).toEqual(atFailure);
  });
});

describe('runSummary: the step line', () => {
  it('is the call running now, else the latest', () => {
    const running = [bash('1', 'ls', 'List the root'), bash('2', 'du -sh .', 'Measure the checkout size', { done: false, result: null })];
    expect(runSummary(running)).toMatchObject({ step: 'Measure the checkout size', running: 1, state: 'running' });
    expect(runSummary([bash('1', 'ls', 'List the root'), read('2', '/r/a.ts')]).step).toBe('Read a.ts');
    expect(runSummary([bash('1', 'ls'), bash('2', 'pwd')]).step).toBe('Bash');
    // With nothing in flight, a last call without words gives way to the latest call that has some.
    expect(runSummary([bash('1', 'ls', 'List the root'), bash('2', 'pwd')]).step).toBe('List the root');
  });

  it('names a call still streaming in by its tool, never by an earlier, finished call', () => {
    const before = bash('1', 'ls', 'List the root');
    // Its input is still on its way: no path yet.
    expect(runSummary([before, read('2', '', { input: {}, done: false, result: null })]).step).toBe('Read');
    expect(runSummary([before, tool('2', 'Bash', { input: {}, done: false, result: null })]).step).toBe('Bash');
    // Then its words, once they have come in.
    expect(runSummary([before, read('2', '/r/a.ts', { done: false, result: null })]).step).toBe('Read a.ts');
  });
});
