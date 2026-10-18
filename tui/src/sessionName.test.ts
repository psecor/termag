import { describe, expect, it } from 'vitest';
import { sessionName } from './sessionName.js';

describe('sessionName', () => {
  it('collapses main and names workstreams, like the backend', () => {
    expect(sessionName('psecor', 'termag', 'agent')).toBe('psecor-termag-agent');
    expect(sessionName('psecor', 'termag', 'ctrl', 'tui')).toBe('psecor-termag-tui-ctrl');
  });
  it('turns . and : into _ the way tmux stores session names', () => {
    expect(sessionName('first.last', 'termag', 'agent')).toBe('first_last-termag-agent');
    expect(sessionName('psecor', 'foo.bar', 'ctrl', 'v1:2')).toBe('psecor-foo_bar-v1_2-ctrl');
  });
});
