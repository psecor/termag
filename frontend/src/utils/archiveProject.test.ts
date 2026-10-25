import { describe, expect, it } from 'vitest';
import { archiveMessage } from './archiveProject';

describe('archiveMessage', () => {
  it('names the project and counts the other workstreams that go with it', () => {
    expect(archiveMessage('termag', 26)).toMatch(/^Archive the whole termag project\? This stops its agent and terminals, and those of all 25 of its other workstreams\./);
  });

  it('reads right with one workstream besides main, and with main alone', () => {
    expect(archiveMessage('notes', 2)).toContain('all 1 of its other workstream.');
    expect(archiveMessage('notes', 1)).toContain('This stops its agent and terminals. ');
    expect(archiveMessage('notes', 0)).toContain('This stops its agent and terminals. ');
  });
});
