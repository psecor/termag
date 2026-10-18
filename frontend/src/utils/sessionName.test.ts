import { describe, expect, it } from 'vitest';
import { sessionName } from './sessionName';

describe('sessionName', () => {
  it('matches the backend: workstream only off main, `.` and `:` as `_`', () => {
    expect(sessionName('alice', 'proj', 'agent')).toBe('alice-proj-agent');
    expect(sessionName('alice', 'proj', 'ctrl', 'feat-x')).toBe('alice-proj-feat-x-ctrl');
    expect(sessionName('first.last', 'webapp', 'agent')).toBe('first_last-webapp-agent');
  });
});
