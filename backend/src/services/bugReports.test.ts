import { describe, expect, it } from 'vitest';
import { LIMITS, fillCounts, parseBugFilter, parseBugReportInput, parseTriageChange, sortNewFirst, threadIdOf } from './bugReports';

// docs/bug-reports.md. Secret-shaped fixtures are built at run time: the
// gitleaks hook and ask publish refuse them as literals.
const ghToken = () => `ghp_${'q'.repeat(36)}`;
const pemLines = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj'];
const pem = () => [`-----BEGIN ${'PRIVATE'} KEY-----`, ...pemLines, `-----END ${'PRIVATE'} KEY-----`].join('\n');

describe('parseBugReportInput', () => {
  it('needs a title and a body, and defaults severity and area', () => {
    expect(parseBugReportInput({ body: 'x' })).toEqual({ error: 'title is required' });
    expect(parseBugReportInput({ title: 't', body: '  ' })).toMatchObject({ error: expect.stringMatching(/^body is required/) });
    const r = parseBugReportInput({ title: '  space put\n  answers 403 ', body: 'repro' });
    expect(r).toMatchObject({ ok: { title: 'space put answers 403', severity: 'medium', area: 'other', command: null, redacted: [] } });
  });

  it('takes only the known severities and areas', () => {
    expect(parseBugReportInput({ title: 't', body: 'b', severity: 'urgent' })).toMatchObject({ error: expect.stringMatching(/severity is one of low, medium, high/) });
    expect(parseBugReportInput({ title: 't', body: 'b', area: 'webapp' })).toMatchObject({ error: expect.stringMatching(/area is one of spaces, asks/) });
    expect(parseBugReportInput({ title: 't', body: 'b', severity: 'high', area: 'broker' })).toMatchObject({ ok: { severity: 'high', area: 'broker' } });
  });

  it('redacts secrets in every text field and names what it replaced', () => {
    const tok = ghToken();
    const r = parseBugReportInput({
      title: `push with ${tok} fails`, body: `GH_TOKEN=${tok}`, command: `gh pr list --search x`,
      errorOutput: `HTTP 403 for AKIA${'Z'.repeat(16)}`, agentModel: 'opus',
    });
    if (!('ok' in r)) throw new Error(r.error);
    expect(r.ok.title).toBe('push with [redacted: GitHub token] fails');
    expect(r.ok.body).toBe('GH_TOKEN=[redacted: GitHub token]');
    expect(r.ok.errorOutput).toBe('HTTP 403 for [redacted: AWS access key id]');
    expect(r.ok.redacted.sort()).toEqual(['AWS access key id', 'GitHub token']);
    expect(JSON.stringify(r.ok)).not.toContain(tok);
  });

  it('redacts a whole PEM private key from the title, body and error output', () => {
    const r = parseBugReportInput({ title: `ssh fails with ${pem()}`, body: `the key:\n${pem()}\nthen 403`, errorOutput: `${pem()}\nPermission denied` });
    if (!('ok' in r)) throw new Error(r.error);
    expect(r.ok.title).toBe('ssh fails with [redacted: private key]');
    expect(r.ok.body).toBe('the key:\n[redacted: private key]\nthen 403');
    expect(r.ok.errorOutput).toBe('[redacted: private key]\nPermission denied');
    expect(r.ok.redacted).toEqual(['private key']);
    for (const line of [...pemLines, 'END PRIVATE']) expect(JSON.stringify(r.ok)).not.toContain(line);
  });

  it('redacts long error output before keeping its tail, so a key whose header falls outside the tail still goes', () => {
    const key = pem().replace(pemLines[1], pemLines[1] + 'A'.repeat(LIMITS.errorOutput));
    const r = parseBugReportInput({ title: 't', body: 'b', errorOutput: `${key}\nTHE ERROR` });
    if (!('ok' in r)) throw new Error(r.error);
    expect(r.ok.errorOutput).toBe('[redacted: private key]\nTHE ERROR');
    expect(r.ok.redacted).toEqual(['private key']);
  });

  it('keeps the tail of long error output, refuses an overlong body, and drops a malformed project id', () => {
    const r = parseBugReportInput({ title: 't', body: 'b', errorOutput: 'x'.repeat(LIMITS.errorOutput) + 'THE ERROR', projectId: 'p; drop', workstream: 'ask-abcdefgh12' });
    if (!('ok' in r)) throw new Error(r.error);
    expect(r.ok.errorOutput!.endsWith('THE ERROR')).toBe(true);
    expect(r.ok.errorOutput!.length).toBe(LIMITS.errorOutput + 1);
    expect(r.ok.projectId).toBeNull();
    expect(r.ok.workstream).toBe('ask-abcdefgh12');
    expect(parseBugReportInput({ title: 't', body: 'b'.repeat(LIMITS.body + 1) })).toMatchObject({ error: expect.stringMatching(/body is at most/) });
  });
});

describe('threadIdOf', () => {
  it('reads the thread id out of an ask workstream only', () => {
    expect(threadIdOf('ask-cmvsovavv0wi0nyiwjj48ugzn')).toBe('cmvsovavv0wi0nyiwjj48ugzn');
    expect(threadIdOf('main')).toBeNull();
    expect(threadIdOf('ask-')).toBeNull();
    expect(threadIdOf(null)).toBeNull();
  });
});

describe('parseBugFilter', () => {
  it('takes comma lists and repeated params, a search and a capped limit', () => {
    expect(parseBugFilter({ status: 'new,triaged', area: ['spaces', 'cli'], q: ' 403 ', limit: '900' }))
      .toEqual({ ok: { statuses: ['new', 'triaged'], areas: ['spaces', 'cli'], search: '403', limit: 500 } });
    expect(parseBugFilter({})).toEqual({ ok: { limit: 500 } });
  });
  it('refuses an unknown value and a bad limit', () => {
    expect(parseBugFilter({ status: 'open' })).toMatchObject({ error: expect.stringMatching(/status is one of .* \(got "open"\)/) });
    expect(parseBugFilter({ severity: 'p0' })).toMatchObject({ error: expect.stringMatching(/severity/) });
    expect(parseBugFilter({ limit: '0' })).toMatchObject({ error: expect.stringMatching(/limit/) });
  });
});

describe('parseTriageChange', () => {
  it('sets a status and clears a duplicate pointer when moving off duplicate', () => {
    expect(parseTriageChange({ status: 'fixed' }, 'b1')).toEqual({ ok: { status: 'fixed', duplicateOfId: null } });
  });
  it('marks a duplicate only with the report it duplicates, never itself', () => {
    expect(parseTriageChange({ duplicateOf: 'b0' }, 'b1')).toEqual({ ok: { status: 'duplicate', duplicateOfId: 'b0' } });
    expect(parseTriageChange({ status: 'duplicate' }, 'b1')).toMatchObject({ error: expect.stringMatching(/needs duplicateOf/) });
    expect(parseTriageChange({ duplicateOf: 'b1' }, 'b1')).toMatchObject({ error: expect.stringMatching(/itself/) });
    expect(parseTriageChange({ status: 'fixed', duplicateOf: 'b0' }, 'b1')).toMatchObject({ error: expect.stringMatching(/goes with status duplicate/) });
  });
  it('links a GitHub issue or PR, clears it with null, and refuses anything else', () => {
    expect(parseTriageChange({ link: 'https://github.com/example-org/termag/pull/912/' }, 'b1')).toEqual({ ok: { linkUrl: 'https://github.com/example-org/termag/pull/912' } });
    expect(parseTriageChange({ link: 'https://github.com/example-org/termag/issues/3' }, 'b1')).toEqual({ ok: { linkUrl: 'https://github.com/example-org/termag/issues/3' } });
    expect(parseTriageChange({ link: null }, 'b1')).toEqual({ ok: { linkUrl: null } });
    expect(parseTriageChange({ link: 'https://evil.example/pull/1' }, 'b1')).toMatchObject({ error: expect.stringMatching(/GitHub issue or pull request/) });
  });
  it('refuses an empty change and a note holding a secret', () => {
    expect(parseTriageChange({}, 'b1')).toMatchObject({ error: expect.stringMatching(/nothing to change/) });
    expect(parseTriageChange({ note: `see ${ghToken()}` }, 'b1')).toMatchObject({ error: expect.stringMatching(/secret/) });
  });
});

describe('sortNewFirst and fillCounts', () => {
  it('puts new reports first, newest first within each group', () => {
    const at = (s: string) => new Date(`2026-10-28T${s}:00Z`);
    const rows = [
      { id: 'a', status: 'fixed', createdAt: at('12:00') },
      { id: 'b', status: 'new', createdAt: at('09:00') },
      { id: 'c', status: 'new', createdAt: at('10:00') },
      { id: 'd', status: 'triaged', createdAt: at('08:00') },
    ];
    expect(sortNewFirst(rows).map(r => r.id)).toEqual(['c', 'b', 'a', 'd']);
  });
  it('lists every status, zeros included', () => {
    expect(fillCounts({ new: 3, fixed: 1 })).toEqual({ new: 3, triaged: 0, duplicate: 0, fixed: 1, wontfix: 0 });
  });
});
