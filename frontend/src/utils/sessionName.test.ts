import { describe, expect, it } from 'vitest';
import { isAgentPaneSession, sessionName } from './sessionName';

describe('sessionName', () => {
  it('matches the backend: workstream only off main, `.` and `:` as `_`', () => {
    expect(sessionName('alice', 'proj', 'agent')).toBe('alice-proj-agent');
    expect(sessionName('alice', 'proj', 'ctrl', 'feat-x')).toBe('alice-proj-feat-x-ctrl');
    expect(sessionName('first.last', 'webapp', 'agent')).toBe('first_last-webapp-agent');
  });
});

describe('isAgentPaneSession', () => {
  it('is the -agent role suffix only, not a name that contains agent', () => {
    expect(isAgentPaneSession(sessionName('alice', 'proj', 'agent'))).toBe(true);
    expect(isAgentPaneSession(sessionName('alice', 'proj', 'agent', 'feat-x'))).toBe(true);
    expect(isAgentPaneSession(sessionName('alice', 'agentops', 'agent'))).toBe(true);
    expect(isAgentPaneSession(sessionName('alice', 'proj', 'ctrl'))).toBe(false);
    expect(isAgentPaneSession(sessionName('alice', 'agentops', 'ctrl'))).toBe(false);
    expect(isAgentPaneSession(sessionName('alice', 'proj', 'review', 'agent'))).toBe(false);
    expect(isAgentPaneSession(sessionName('alice', 'proj', 'data-ctrl'))).toBe(false);
  });
});
