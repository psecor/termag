import { describe, expect, it } from 'vitest';
import { parseCliUsage } from './cliUsage';

describe('parseCliUsage', () => {
  it('keeps a finished run: the command, its outcome and how it was run', () => {
    expect(parseCliUsage({
      command: 'box list', phase: 'finished', version: '0.4.1', exitCode: 0, durationMs: 412.6, interactive: true, claudeCode: false,
    })).toEqual({
      detail: { command: 'box list', phase: 'finished', version: '0.4.1', exitCode: 0, durationMs: 413, interactive: true, claudeCode: false },
    });
  });

  it('takes a started run with no outcome', () => {
    expect(parseCliUsage({ command: 'tui', phase: 'started' })).toEqual({ detail: expect.objectContaining({ command: 'tui', phase: 'started', exitCode: undefined }) });
  });

  it('refuses anything that is not a command name, so arguments never become a record', () => {
    for (const command of ['', 'box list --all', 'ask "fix the bug"', 'space get notes/plan.md', 'Box List', 'a b c', 'x'.repeat(40), 42]) {
      expect(parseCliUsage({ command, phase: 'finished' })).toHaveProperty('error');
    }
  });

  it('refuses a bad phase, version, exit code, duration or flag', () => {
    const ok = { command: 'whoami', phase: 'finished' };
    for (const bad of [
      { phase: 'done' }, { version: 'v 1' }, { exitCode: -1 }, { exitCode: 1.5 }, { exitCode: 256 },
      { durationMs: -1 }, { durationMs: '5' }, { durationMs: 2 * 24 * 60 * 60 * 1000 }, { interactive: 'yes' }, { claudeCode: 1 },
    ]) {
      expect(parseCliUsage({ ...ok, ...bad })).toHaveProperty('error');
    }
    expect(parseCliUsage(null)).toHaveProperty('error');
  });
});
