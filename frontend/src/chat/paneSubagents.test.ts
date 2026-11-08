import { describe, expect, it } from 'vitest';
import { PANE_SUBAGENT_KEEP_MS, isPaneSessionTab, paneAlongsideViews, paneKeptSubagents, paneSessionId, paneSubagentId, paneSubagentViews, type PaneSubagent } from './paneSubagents';
import { subagentElapsed, subagentLine } from './subagents';

const sub = (over: Partial<PaneSubagent> = {}): PaneSubagent => ({
  agentId: 'ac9afc6661520867b', toolUseId: 'toolu_01', agentType: 'Explore', description: 'Find flaky tests', background: true, model: 'sonnet',
  finished: true, startedAt: '2026-11-05T16:41:00.000Z', updatedAt: '2026-11-05T16:42:30.000Z', prompt: 'Find the flaky tests', report: 'Two are flaky.', ...over,
});

describe('a pane chat\'s subagents', () => {
  it('are views as an SDK chat\'s are, oldest first, by their Agent call\'s id', () => {
    const views = paneSubagentViews([sub({ agentId: 'b2', toolUseId: null, description: null, finished: false, report: null, startedAt: '2026-11-05T16:43:00.000Z' }), sub()], true);
    expect(views.map(v => v.id)).toEqual(['toolu_01', 'pane-agent:b2']);
    expect(views[0]).toMatchObject({ description: 'Find flaky tests', agentType: 'Explore', status: 'done', report: 'Two are flaky.', agentId: 'ac9afc6661520867b', pane: true, durationMs: 90_000 });
    expect(views[0].call).toMatchObject({ name: 'Agent', done: true, startedAt: '2026-11-05T16:41:00.000Z', endedAt: '2026-11-05T16:42:30.000Z' });
    expect(views[1]).toMatchObject({ description: 'Subagent', status: 'running', durationMs: null, report: null });
    expect(paneSubagentId({ agentId: 'x', toolUseId: null })).toBe('pane-agent:x');
  });

  it('keep their place as they work: by when each started, not when it last wrote', () => {
    const first = sub({ agentId: 'first', toolUseId: 'toolu_a', startedAt: '2026-11-05T16:40:00.000Z', updatedAt: '2026-11-05T16:50:00.000Z', finished: false });
    const second = sub({ agentId: 'second', toolUseId: 'toolu_b', startedAt: '2026-11-05T16:45:00.000Z', updatedAt: '2026-11-05T16:46:00.000Z' });
    // The box lists the newest write first: the first one, still writing.
    expect(paneSubagentViews([first, second], true).map(v => v.id)).toEqual(['toolu_a', 'toolu_b']);
    expect(paneSubagentViews([second, first], true).map(v => v.id)).toEqual(['toolu_a', 'toolu_b']);
  });

  it('say how long they ran, and that one still going is running while the pane\'s Claude is', () => {
    const [done] = paneSubagentViews([sub()], true);
    expect(subagentLine(done, 0)).toBe('finished in 1m 30s');
    const [going] = paneSubagentViews([sub({ finished: false })], true);
    expect(subagentElapsed(going, Date.parse('2026-11-05T16:41:10.000Z'))).toBe(10_000);
    expect(paneSubagentViews([sub({ finished: false })], false)[0].status).toBe('stopped');
  });

  it('are kept in view while running, and for an hour after they end', () => {
    const views = paneSubagentViews([sub({ agentId: 'run', toolUseId: 'toolu_02', finished: false, startedAt: '2026-11-05T16:43:00.000Z' }), sub()], true);
    const end = Date.parse('2026-11-05T16:42:30.000Z');
    expect(paneKeptSubagents(views, end + 60_000).map(v => v.id)).toEqual(['toolu_01', 'toolu_02']);
    expect(paneKeptSubagents(views, end + PANE_SUBAGENT_KEEP_MS + 1).map(v => v.id)).toEqual(['toolu_02']);
  });
});

describe('sessions running alongside a pane chat\'s Claude', () => {
  it('are running views named by their first line, with no brief, read by their session', () => {
    const [v, w] = paneAlongsideViews([
      { sessionId: '564dbd9a-9a7e-4a8e-834c-9f371ae79f76', startedAt: Date.parse('2026-11-05T16:59:00.000Z'), updatedAt: null, title: 'Review the README\nfor stale steps' },
      { sessionId: '496bb91b-2f1d-42c9-a973-a47b0e6600fc', startedAt: null, updatedAt: null, title: null },
    ]);
    expect(v).toMatchObject({ id: 'pane-session:564dbd9a-9a7e-4a8e-834c-9f371ae79f76', description: 'Review the README', status: 'running', prompt: null, paneSession: '564dbd9a-9a7e-4a8e-834c-9f371ae79f76', agentType: 'Running alongside' });
    expect(v.call.startedAt).toBe('2026-11-05T16:59:00.000Z');
    expect(w.description).toBe('Claude session');
    expect(isPaneSessionTab(paneSessionId('x'))).toBe(true);
    expect(isPaneSessionTab('toolu_01')).toBe(false);
  });
});
