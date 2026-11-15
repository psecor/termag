import { describe, expect, it } from 'vitest';
import { parseCliUsage } from './cliUsage';
import { productEventRecord } from './productEvents';

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

  it('keeps a version built from git (cli/buildVersion.mjs)', () => {
    for (const version of ['0.1.157+c4b6b803', '0.1.157+c4b6b803.dirty', '0.1.0+unknown']) {
      expect(parseCliUsage({ command: 'whoami', phase: 'finished', version })).toEqual({ detail: expect.objectContaining({ version }) });
    }
  });

  it('keeps the runtime, node or go, and takes a report without one from an older CLI', () => {
    for (const runtime of ['node', 'go'] as const) {
      const parsed = parseCliUsage({ command: 'box list', phase: 'finished', durationMs: 50, runtime });
      expect(parsed).toEqual({ detail: expect.objectContaining({ runtime }) });
      // The recorded event carries it as termag.runtime, the attribute a dashboard splits durations by.
      if ('detail' in parsed) expect(productEventRecord('cli.command', { user: 'u1' }, parsed.detail).attributes).toMatchObject({ 'termag.runtime': runtime });
    }
    const older = parseCliUsage({ command: 'box list', phase: 'finished' });
    expect(older).toEqual({ detail: expect.objectContaining({ command: 'box list', runtime: undefined }) });
    if ('detail' in older) expect(productEventRecord('cli.command', { user: 'u1' }, older.detail).attributes).not.toHaveProperty('termag.runtime');
  });

  it('refuses a bad phase, version, exit code, duration or flag', () => {
    const ok = { command: 'whoami', phase: 'finished' };
    for (const bad of [
      { phase: 'done' }, { version: 'v 1' }, { exitCode: -1 }, { exitCode: 1.5 }, { exitCode: 256 },
      { durationMs: -1 }, { durationMs: '5' }, { durationMs: 2 * 24 * 60 * 60 * 1000 }, { interactive: 'yes' }, { claudeCode: 1 },
      { runtime: 'deno' }, { runtime: 'Go' }, { runtime: 1 }, { runtime: null },
    ]) {
      expect(parseCliUsage({ ...ok, ...bad })).toHaveProperty('error');
    }
    expect(parseCliUsage(null)).toHaveProperty('error');
  });
});
