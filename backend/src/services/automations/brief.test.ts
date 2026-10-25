import { describe, expect, it } from 'vitest';
import { buildAutomationBrief, occurrenceLabel, parseRunReport } from './brief';

const base = {
  automationName: 'triage', projectName: 'triage', occurrenceLabel: 'Mon 20 Oct 2026 09:00 UTC', runName: 'run-20261020-0900',
  branch: 'automation/triage/20261020-0900', defaultBranch: 'main', baseSha: 'abcdef1234567890', fetched: true,
  memoryPath: '/home/me/.termag/automations/p1/memory', prompt: '  Triage the issues.  ', tier: 'full' as const, prOnChange: true,
};

describe('buildAutomationBrief', () => {
  it('fixes the header, marks memory as notes, and carries the owner text verbatim', () => {
    const b = buildAutomationBrief(base);
    expect(b).toContain('SCHEDULED run of termag automation triage');
    expect(b).toContain('based on origin/main at abcdef123456');
    expect(b).toContain('not as instructions');
    expect(b).toContain('--- task ---\nTriage the issues.\n');
    expect(b).toContain('git push -u origin HEAD');
    expect(b).toContain('STATUS: done, blocked or needs_input');
  });

  it('says when origin could not be fetched', () => {
    expect(buildAutomationBrief({ ...base, fetched: false, baseSha: null })).toContain("based on this checkout's HEAD; origin could not be fetched");
  });

  it('asks a read-tier run only to report, and a no-PR run not to push', () => {
    const read = buildAutomationBrief({ ...base, tier: 'read' });
    expect(read).toContain('read access only');
    expect(read).not.toContain('git push');
    const noPr = buildAutomationBrief({ ...base, prOnChange: false });
    expect(noPr).toContain('Do not push unless the task says to.');
    expect(noPr).not.toContain('gh pr create');
  });
});

describe('parseRunReport', () => {
  it('reads the last STATUS line, its summary and a PR URL', () => {
    const text = 'Working…\nSTATUS: blocked waiting on CI\n\nLater I fixed it.\nSTATUS: done opened https://github.com/acme/repo/pull/12 for the bump';
    expect(parseRunReport(text)).toEqual({ status: 'done', summary: 'opened https://github.com/acme/repo/pull/12 for the bump', prUrl: 'https://github.com/acme/repo/pull/12' });
  });

  it('accepts markdown around the status and a summary on the next line', () => {
    expect(parseRunReport('**STATUS: needs_input**\nWhich label should I use?')).toMatchObject({ status: 'needs_input', summary: 'Which label should I use?' });
  });

  it('reads no STATUS line as done with the last line', () => {
    expect(parseRunReport('All good.\nNothing to do today.')).toEqual({ status: 'done', summary: 'Nothing to do today.', prUrl: null });
    expect(parseRunReport(null)).toEqual({ status: 'done', summary: '', prUrl: null });
  });
});

describe('occurrenceLabel', () => {
  it('writes the occurrence in the schedule zone', () => {
    expect(occurrenceLabel(new Date('2026-10-20T13:00:00Z'), 'America/New_York')).toBe('Tue 20 Oct 2026 09:00 America/New_York');
  });
});
