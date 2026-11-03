import { describe, expect, it } from 'vitest';
import { applyEvent, emptyChat, fromHistory, mergeHistory, type ChatItem, type ChatState } from './sdkChat';

const fold = (events: unknown[], from: ChatState = emptyChat) => events.reduce<ChatState>(applyEvent, from);
const tool = (s: ChatState, id: string) => s.items.find(it => it.kind === 'tool' && it.id === id) as Extract<ChatItem, { kind: 'tool' }>;

const prompt = (uuid: string, text: string, timestamp?: string) => ({ type: 'user', uuid, ...(timestamp && { timestamp }), message: { role: 'user', content: text } });
const call = (id: string, timestamp?: string, mid = `m-${id}`) => ({
  type: 'assistant', ...(timestamp && { timestamp }),
  message: { id: mid, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'make', description: 'Build' } }] },
});
const result = (id: string, timestamp?: string) => ({
  type: 'user', ...(timestamp && { timestamp }), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});

describe('times on a live turn', () => {
  it('starts a call at its message’s time and ends it at its result’s', () => {
    const s = fold([
      { type: 'turn-start', text: 'build it' },
      call('t1', '2026-10-28T18:02:11.000Z'),
      result('t1', '2026-10-28T18:14:05.000Z'),
    ]);
    expect(tool(s, 't1')).toMatchObject({ startedAt: '2026-10-28T18:02:11.000Z', endedAt: '2026-10-28T18:14:05.000Z', done: true });
    expect(tool(s, 't1').startGuessed).toBeUndefined();
    expect(tool(s, 't1').endGuessed).toBeUndefined();
  });

  it('gives a call first seen streaming the nearest earlier time, then its message’s own', () => {
    const started = fold([
      { type: 'turn-start', text: 'build it' },
      call('t0', '2026-10-28T18:00:00.000Z'),
      result('t0', '2026-10-28T18:01:00.000Z'),
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'm-t1' } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash' } } },
    ]);
    // Stream events carry no time: the result just before it is the nearest.
    expect(tool(started, 't1')).toMatchObject({ startedAt: '2026-10-28T18:01:00.000Z', startGuessed: true, done: false });
    const s = fold([call('t1', '2026-10-28T18:02:11.000Z')], started);
    expect(tool(s, 't1').startedAt).toBe('2026-10-28T18:02:11.000Z');
    expect(tool(s, 't1').startGuessed).toBeUndefined();
  });

  it('settles a call still open at the turn-end with the turn-end’s time, and the reply ends then', () => {
    const s = fold([
      { type: 'turn-start', text: 'build it' },
      call('t1', '2026-10-28T18:02:11.000Z'),
      { type: 'turn-end', exitCode: 0, costUsd: 0.14, sessionCostUsd: 0.14, durationMs: 9000, at: '2026-10-28T18:14:05.000Z' },
    ]);
    expect(tool(s, 't1')).toMatchObject({ done: true, endedAt: '2026-10-28T18:14:05.000Z' });
    expect(Object.values(s.costs)[0]).toEqual({ costUsd: 0.14, durationMs: 9000, endedAt: '2026-10-28T18:14:05.000Z' });
  });

  it('ends an older agent’s turn (no `at`) at its last event’s time, marked a guess on the calls it settles', () => {
    const s = fold([
      { type: 'turn-start', text: 'build it' },
      call('t1', '2026-10-28T18:02:11.000Z'),
      { type: 'turn-end', exitCode: 0, costUsd: 0.14, sessionCostUsd: 0.14, durationMs: 9000 },
    ]);
    expect(tool(s, 't1')).toMatchObject({ endedAt: '2026-10-28T18:02:11.000Z', endGuessed: true });
    expect(Object.values(s.costs)[0].endedAt).toBe('2026-10-28T18:02:11.000Z');
  });

  it('leaves a call with no time anywhere untimed, rather than inventing one', () => {
    const s = fold([{ type: 'turn-start', text: 'go' }, call('t1'), result('t1')]);
    expect(tool(s, 't1').startedAt).toBeUndefined();
    expect(tool(s, 't1').endedAt).toBeUndefined();
    expect(s.clock).toBeUndefined();
  });

  it('keeps its clock when an older event is replayed', () => {
    const s = fold([call('t1', '2026-10-28T18:02:11.000Z'), result('t1', '2026-10-28T17:00:00.000Z')]);
    expect(s.clock).toBe('2026-10-28T18:02:11.000Z');
  });
});

describe('times on a reload', () => {
  const entries = [
    prompt('u1', 'build it', '2026-10-28T18:02:00.000Z'),
    call('t1', '2026-10-28T18:02:11.000Z'),
    result('t1', '2026-10-28T18:14:05.000Z'),
    // A call whose entry has no timestamp (an older transcript): the nearest earlier time, a guess.
    call('t2'),
    result('t2', '2026-10-28T18:14:07.000Z'),
    { type: 'assistant', timestamp: '2026-10-28T18:14:09.000Z', message: { id: 'm3', content: [{ type: 'text', text: 'Built.' }] } },
  ];
  const records = [{ turnId: 'turn-1', userUuid: 'u1', prompt: 'build it', at: '2026-10-28T18:14:10.000Z', costUsd: 0.14, sessionCostUsd: 0.14, durationMs: 9000 }];

  it('reads each call’s times from the transcript and the reply’s end from its record', () => {
    const s = fromHistory(entries, 'sess-1', null, records);
    expect(tool(s, 't1')).toMatchObject({ startedAt: '2026-10-28T18:02:11.000Z', endedAt: '2026-10-28T18:14:05.000Z' });
    expect(tool(s, 't2')).toMatchObject({ startedAt: '2026-10-28T18:14:05.000Z', startGuessed: true, endedAt: '2026-10-28T18:14:07.000Z' });
    expect(Object.values(s.costs)[0]).toEqual({ costUsd: 0.14, durationMs: 9000, endedAt: '2026-10-28T18:14:10.000Z' });
  });

  it('shows the same times as the live turn did', () => {
    const live = fold([
      { type: 'turn-start', text: 'build it' },
      ...entries.slice(1),
      { type: 'turn-end', exitCode: 0, costUsd: 0.14, sessionCostUsd: 0.14, durationMs: 9000, at: '2026-10-28T18:14:10.000Z' },
    ]);
    const reloaded = mergeHistory({ entries, sessionId: 'sess-1', running: false, turns: records }, []);
    const times = (s: ChatState) => s.items.filter(it => it.kind === 'tool').map(t => [(t as any).startedAt, (t as any).endedAt]);
    expect(times(reloaded)).toEqual(times(live));
    expect(Object.values(reloaded.costs)[0].endedAt).toBe(Object.values(live.costs)[0].endedAt);
  });

  it('has no end for a record without `at`', () => {
    const s = fromHistory(entries, 'sess-1', null, [{ ...records[0], at: null }]);
    expect(Object.values(s.costs)[0].endedAt).toBeUndefined();
  });
});
