import { describe, expect, it } from 'vitest';
import type { ChatItem } from './sdkChat';
import { alwaysShown, groupToolRuns, runSummary, type ToolItem } from './toolRuns';

function tool(id: string, name = 'Bash', over: Partial<ToolItem> = {}): ToolItem {
  return { kind: 'tool', key: `tool:${id}`, id, name, input: {}, inputJson: '', result: 'ok', isError: false, done: true, ...over };
}
const text = (key: string, t: string, streaming = false): ChatItem => ({ kind: 'text', key, text: t, streaming });

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

  it('breaks a run at a user message or an error', () => {
    const items: ChatItem[] = [tool('1'), tool('2'), { kind: 'error', key: 'x', text: 'boom' }, tool('3'), { kind: 'user', key: 'u', text: 'hi' }, tool('4')];
    expect(groupToolRuns(items).map(e => e.kind)).toEqual(['tools', 'item', 'item', 'item', 'item']);
  });
});

describe('runSummary', () => {
  it('says what the run did, by kind, in order of first use', () => {
    expect(runSummary([tool('1'), tool('2'), tool('3')]).text).toBe('Ran 3 commands');
    expect(runSummary([tool('1', 'Read'), tool('2', 'Bash'), tool('3', 'Read'), tool('4', 'Edit')]).text)
      .toBe('Read 2 files, ran 1 command, edited 1 file');
    expect(runSummary([tool('1', 'Grep'), tool('2', 'Glob'), tool('3', 'mcp__x')]).text).toBe('Ran 2 searches, used 1 tool');
  });

  it('counts failures and calls still running', () => {
    const s = runSummary([tool('1'), tool('2', 'Bash', { isError: true }), tool('3', 'Bash', { done: false, result: null })]);
    expect(s).toMatchObject({ failed: 1, running: 1, state: 'running' });
    expect(runSummary([tool('1'), tool('2', 'Bash', { isError: true })]).state).toBe('error');
    expect(runSummary([tool('1'), tool('2')]).state).toBe('done');
  });

  it('takes its state from the last call, so a failure the agent fixed is not an error', () => {
    const fixed = runSummary([tool('1', 'Bash', { isError: true }), tool('2'), tool('3')]);
    expect(fixed).toMatchObject({ failed: 1, state: 'done' });
    expect(runSummary([tool('1', 'Bash', { isError: true }), tool('2'), tool('3', 'Bash', { isError: true })]))
      .toMatchObject({ failed: 2, state: 'error' });
  });

  it('is running while any call is, even when a later parallel call already finished', () => {
    expect(runSummary([tool('1', 'Bash', { isError: true }), tool('2', 'Bash', { done: false, result: null })]).state).toBe('running');
    expect(runSummary([tool('1', 'Task', { done: false, result: null }), tool('2', 'Task', { isError: true })]).state).toBe('running');
  });
});

describe('alwaysShown', () => {
  it('keeps failures and the running call visible while the run is closed', () => {
    const failed = tool('2', 'Bash', { isError: true });
    const running = tool('4', 'Read', { done: false, result: null });
    expect(alwaysShown([tool('1'), failed, tool('3'), running])).toEqual([failed, running]);
  });
});

describe('runSummary: skills', () => {
  it('counts Skill calls as skills used', () => {
    expect(runSummary([tool('1', 'Skill'), tool('2'), tool('3')]).text).toBe('Used 1 skill, ran 2 commands');
  });
});
