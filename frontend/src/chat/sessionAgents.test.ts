import { describe, expect, it } from 'vitest';
import { applyEvent, emptyChat } from './sdkChat';
import { subagentsOf } from './subagents';
import { findSubagent, historySubagents, keptNested, keptSessionAgents, nestedSubagents, sentAsks, sessionAgentsGoing, sessionAgentsSource } from './sessionAgents';
import type { ChatAskThread } from './asks';

const call = (id: string, description: string, background = false) => ({ type: 'tool_use', id, name: 'Agent', input: { description, prompt: 'go', subagent_type: 'general-purpose', run_in_background: background } });
const result = (id: string, text: string) => ({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: [{ type: 'text', text }] }] } });

describe('where a session\'s subagents are read from', () => {
  it('an SDK chat\'s history, a pane Claude\'s folder, else nowhere', () => {
    expect(sessionAgentsSource('claude-chat')).toBe('chat');
    expect(sessionAgentsSource('claude')).toBe('pane');
    expect(sessionAgentsSource('codex')).toBe('none');
    expect(sessionAgentsSource(null)).toBe('none');
  });
});

describe('keptNested', () => {
  it('keeps every one going and the newest ended, in order', () => {
    const list = [1, 2, 3, 4, 5, 6].map(n => ({ n, going: n === 1 }));
    expect(keptNested(list, t => t.going, 2).map(t => t.n)).toEqual([1, 5, 6]);
  });
});

describe('an SDK chat\'s subagents from its history', () => {
  it('one per Agent call: a finished one done, a background one with nothing running stopped', () => {
    const list = historySubagents({
      sessionId: null, running: false,
      entries: [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'build both candidates' } },
        { type: 'assistant', message: { id: 'm1', content: [call('t1', 'FLASH candidate build'), call('t2', 'KIMI candidate build', true)] } },
        result('t1', 'all built\nagentId: aflash'),
        result('t2', 'Async agent launched successfully.\nagentId: akimi'),
      ],
    });
    expect(list.map(v => [v.description, v.status])).toEqual([['FLASH candidate build', 'done'], ['KIMI candidate build', 'stopped']]);
  });
});

describe('a subagent\'s own subagents', () => {
  const state = [
    { type: 'turn-start', text: 'nest them' },
    { type: 'assistant', message: { id: 'm1', content: [call('outer', 'Outer')] } },
    { type: 'assistant', parent_tool_use_id: 'outer', message: { id: 's1', content: [{ type: 'tool_use', id: 'inner', name: 'Agent', input: { description: 'Inner', prompt: 'go' } }] } },
    { type: 'system', subtype: 'task_started', task_id: 'ainner', tool_use_id: 'inner', description: 'Inner', task_type: 'local_agent', is_backgrounded: false },
  ].reduce(applyEvent, emptyChat);

  it('are under the one that started it, and its tab finds them there', () => {
    const list = subagentsOf(state);
    expect(list.map(v => v.description)).toEqual(['Outer']);
    expect(nestedSubagents(list[0]).map(v => [v.description, v.status])).toEqual([['Inner', 'running']]);
    expect(findSubagent(list, 'inner')?.description).toBe('Inner');
    expect(findSubagent(list, 'nope')).toBeNull();
  });
});

describe('the asks a session sent', () => {
  const thread = (id: string, status: string, completedAt: string | null): ChatAskThread => ({
    id, title: `Ask ${id}`, target: 'box/p', chat: { projectId: 'p', workstream: `ask-${id}` }, prs: [], createdAt: `2026-11-0${id}T00:00:00Z`,
    messages: [{ id: `m${id}`, hop: 1, status, queued: false, error: null, reply: 'pending', notice: 'none', supersededBy: null, publish: null, createdAt: `2026-11-0${id}T00:00:00Z`, startedAt: null, completedAt }],
  });

  it('oldest first, and going while one is', () => {
    const asks = sentAsks([thread('2', 'working', null), thread('1', 'completed', '2026-11-01T01:00:00Z')]);
    expect(asks.map(a => [a.title, a.state])).toEqual([['Ask 1', 'done'], ['Ask 2', 'working']]);
    expect(sessionAgentsGoing(keptSessionAgents([], asks))).toBe(true);
    expect(sessionAgentsGoing(keptSessionAgents([], asks.slice(0, 1)))).toBe(false);
  });
});
