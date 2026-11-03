import { describe, expect, it } from 'vitest';
import { agentPaneIndex, planRelaunches, sessionCounts, type BoxProject } from './panes';
import type { ReportedPane } from './run';

const wf = (workstream: string, over: Partial<BoxProject['workflows'][number]> = {}): BoxProject['workflows'][number] =>
  ({ type: 'agent', provider: 'claude', backend: null, model: null, workstream: { name: workstream, askThread: null }, ...over });

// `web` and `web-api` are two projects; `web`'s workstream `api` would name the same pane as
// project `web-api`'s main if names were parsed, so they are named forward and looked up.
const projects: BoxProject[] = [
  { id: 'p1', name: 'web', workflows: [wf('main'), wf('fix-login', { provider: null }), wf('ask', { workstream: { name: 'ask-1', askThread: { id: 't1' } } }), wf('data', { type: 'data' })] },
  { id: 'p2', name: 'web-api', workflows: [wf('main', { provider: 'pi', backend: 'pi', model: 'm' })] },
  { id: 'p3', name: 'notes.v2', workflows: [wf('main')] },
];
const index = agentPaneIndex(projects, 'ada', 'codex');
const pane = (session: string, over: Partial<ReportedPane> = {}): ReportedPane => ({ session, role: 'agent', sessionId: null, hadConversation: true, ...over });

describe('agentPaneIndex', () => {
  it('names every agent pane forward, with its provider; an ask chat and a data workflow have none', () => {
    expect([...index.keys()].sort()).toEqual(['ada-notes_v2-agent', 'ada-web-agent', 'ada-web-api-agent', 'ada-web-fix-login-agent']);
    expect(index.get('ada-web-fix-login-agent')).toEqual({ projectId: 'p1', projectName: 'web', workstream: 'fix-login', provider: 'codex', backend: null, model: null });
    expect(index.get('ada-web-api-agent')).toMatchObject({ projectId: 'p2', workstream: 'main', provider: 'pi', backend: 'pi' });
  });
});

describe('planRelaunches', () => {
  it('relaunches exactly the reported agent panes, resuming only those with a conversation', () => {
    expect(planRelaunches([pane('ada-web-agent'), pane('ada-web-api-agent', { hadConversation: false })], index, 'ada', ['claude', 'pi'])).toEqual([
      { session: 'ada-web-agent', action: 'relaunch', resume: true, sessionId: null, target: expect.objectContaining({ projectId: 'p1', workstream: 'main' }) },
      { session: 'ada-web-api-agent', action: 'relaunch', resume: false, sessionId: null, target: expect.objectContaining({ projectId: 'p2', workstream: 'main' }) },
    ]);
  });

  it('carries the conversation id of a pane that had one, for a Codex resume by id; Codex\'s run relaunches only Codex panes', () => {
    const id = '01a18c85-d963-7800-93d4-991c84da09d5';
    expect(planRelaunches([
      pane('ada-web-fix-login-agent', { sessionId: id }),
      pane('ada-web-agent', { sessionId: id }),
    ], index, 'ada', ['codex'])).toEqual([
      { session: 'ada-web-fix-login-agent', action: 'relaunch', resume: true, sessionId: id, target: expect.objectContaining({ provider: 'codex', workstream: 'fix-login' }) },
      { session: 'ada-web-agent', action: 'skip', reason: 'other-provider' },
    ]);
    expect(planRelaunches([pane('ada-web-fix-login-agent', { sessionId: id, hadConversation: false })], index, 'ada', ['codex'])[0])
      .toMatchObject({ action: 'relaunch', resume: false, sessionId: null });
  });

  it('a dotted project name maps through tmux\'s rewrite', () => {
    expect(planRelaunches([pane('ada-notes_v2-agent')], index, 'ada', ['claude'])[0]).toMatchObject({ action: 'relaunch', target: { projectName: 'notes.v2' } });
  });

  it('skips other panes, other users\' sessions, names no project has, another tool\'s agents, and repeats', () => {
    expect(planRelaunches([
      pane('ada-web-ctrl', { role: 'other' }),
      pane('bob-web-agent'),
      pane('adam-web-agent'),
      pane('ada-claude-runner-s2-order1-r'),
      pane('ada-web-gone-agent'),
      pane('ada-web-api-agent'),
      pane('ada-web-agent'), pane('ada-web-agent'),
    ], index, 'ada', ['claude']).map(p => (p.action === 'skip' ? p.reason : p.action))).toEqual([
      'not-agent', 'not-owner', 'not-owner', 'unknown-session', 'unknown-session', 'other-provider', 'relaunch', 'duplicate',
    ]);
  });
});

describe('sessionCounts', () => {
  it('counts live panes and the ones in a turn', () => {
    expect(sessionCounts(['working', 'waiting', 'idle', 'not_running', 'working'])).toEqual({ liveSessions: 4, busySessions: 2 });
    expect(sessionCounts([])).toEqual({ liveSessions: 0, busySessions: 0 });
  });
});
