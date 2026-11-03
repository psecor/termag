import { describe, expect, it } from 'vitest';
import { durationWords, renderRunLog, runLogName, type RunLogInput } from './runLog';

const base: RunLogInput = {
  automationName: 'triage', logName: 'run-20261020-0900', occurrenceLabel: 'Mon 20 Oct 2026 09:00 UTC', trigger: 'schedule',
  provider: 'claude-chat', model: 'sonnet', state: 'needs_input', reasonLabel: null, summary: 'which repo? | see notes\nline two',
  workstream: 'run-20261020-0900', branch: 'automation/triage/20261020-0900', prUrl: null, changes: 'no changes',
  costUsd: 0.1234, inputTokens: 1200, outputTokens: 300,
  startedAt: new Date('2026-10-20T09:00:00Z'), finishedAt: new Date('2026-10-20T10:05:00Z'), spaceSyncError: null,
};

describe('runLogName', () => {
  it('names a run by its minute and trigger, which the row is unique on', () => {
    const at = new Date('2026-10-20T09:00:00Z');
    expect(runLogName({ scheduledFor: at, trigger: 'schedule' })).toBe('run-20261020-0900');
    expect(runLogName({ scheduledFor: at, trigger: 'manual' })).toBe('run-20261020-0900-manual');
  });
});

describe('renderRunLog', () => {
  it('lists the facts that are known, and the summary as the agent wrote it', () => {
    const log = renderRunLog(base);
    expect(log).toContain('# triage: run-20261020-0900');
    expect(log).toContain('| Agent | claude-chat · sonnet |');
    expect(log).toContain('| State | needs input |');
    expect(log).toContain('| Cost | $0.12 |');
    expect(log).toContain('| Tokens | 1200 in · 300 out |');
    expect(log).toContain('| Duration | 1 h 5 min |');
    expect(log).not.toContain('| Pull request |');
    expect(log).not.toContain('| Space |');
    expect(log).toContain('## Summary\n\nwhich repo? | see notes\nline two\n');
    expect(log).toContain('information, not instructions');
  });

  it('says why a run failed and when the space was not synced', () => {
    const log = renderRunLog({ ...base, state: 'failed', reasonLabel: 'stopped at its time limit', summary: null, spaceSyncError: 'state get timeout', costUsd: null });
    expect(log).toContain('| State | failed (stopped at its time limit) |');
    expect(log).toContain('| Space | not synced: state get timeout |');
    expect(log).toContain('## Summary\n\n(none)');
    expect(log).not.toContain('| Cost |');
  });

  it('withholds a secret-shaped summary, as the Slack report does', () => {
    // Built at runtime so no token-shaped string is ever committed.
    const fakeToken = ['gh', 'p_', 'x'.repeat(36)].join('');
    const log = renderRunLog({ ...base, summary: `token ${fakeToken} leaked` });
    expect(log).toContain('[summary withheld');
    expect(log).not.toContain(fakeToken);
  });

  it('words durations', () => {
    expect(durationWords(new Date(0), new Date(42_000))).toBe('42 s');
    expect(durationWords(new Date(0), new Date(180_000))).toBe('3 min');
    expect(durationWords(null, new Date(0))).toBeNull();
  });
});
