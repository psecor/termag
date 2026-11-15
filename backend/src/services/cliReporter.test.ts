import { describe, it, expect } from 'vitest';
import { parseClaimedPlace, threadIdOf } from './cliReporter';
import { parseBugReportInput } from './bugReports';
import { parseFeedbackInput } from './feedback';

// What a CLI caller claims about where it runs (services/cliReporter.ts),
// shared by bug reports and feedback. Secret-shaped fixtures are built at run time.
describe('parseClaimedPlace', () => {
  it('keeps well-formed ids and drops malformed ones', () => {
    expect(parseClaimedPlace({ projectId: 'p-1', workstream: 'ask-thread0001abc' })).toEqual({ projectId: 'p-1', workstream: 'ask-thread0001abc' });
    expect(parseClaimedPlace({ projectId: 'p 1', workstream: '../x' })).toEqual({ projectId: null, workstream: null });
    expect(parseClaimedPlace({})).toEqual({ projectId: null, workstream: null });
  });

  it('drops a secret-shaped id, which would otherwise be stored and shown to admins unredacted', () => {
    const gh = `ghp_${'s'.repeat(36)}`;
    const agent = `tmag_${'a'.repeat(16)}`;
    expect(parseClaimedPlace({ projectId: gh, workstream: agent })).toEqual({ projectId: null, workstream: null });
    const fb = parseFeedbackInput({ body: 'x', projectId: 'p-1', workstream: gh });
    expect(fb).toMatchObject({ ok: { projectId: 'p-1', workstream: null } });
    expect(JSON.stringify(fb)).not.toContain(gh);
    const bug = parseBugReportInput({ title: 't', body: 'b', workstream: agent });
    expect(JSON.stringify(bug)).not.toContain(agent);
  });

  it('reads the ask thread from an ask workstream only', () => {
    expect(threadIdOf('ask-thread0001abc')).toBe('thread0001abc');
    expect(threadIdOf('main')).toBeNull();
    expect(threadIdOf(null)).toBeNull();
  });
});
