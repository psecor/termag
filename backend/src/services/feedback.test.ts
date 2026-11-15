import { describe, it, expect } from 'vitest';
import { LIMITS, fillCounts, parseFeedbackFilter, parseFeedbackInput, parseStatusChange, underRateLimit, FEEDBACK_PER_HOUR } from './feedback';

// Feedback parsing (services/feedback.ts): the body, the
// kind, the reporter context and the redaction a bug report also gets.
describe('parseFeedbackInput', () => {
  it('keeps the body, the kind, the CLI context and the claimed place', () => {
    const r = parseFeedbackInput({
      body: '  the sidebar is confusing  ', kind: 'problem', cliVersion: '0.4.1', agentProvider: 'claude', agentModel: 'opus',
      agentVersion: 'claude-code 2.1.3', projectId: 'p-1', workstream: 'ask-thread0001abc',
    });
    expect(r).toEqual({ ok: {
      body: 'the sidebar is confusing', kind: 'problem', cliVersion: '0.4.1', agentProvider: 'claude', agentModel: 'opus',
      agentVersion: 'claude-code 2.1.3', projectId: 'p-1', workstream: 'ask-thread0001abc', redacted: [],
    } });
  });

  it('defaults the kind to other and drops malformed ids', () => {
    const r = parseFeedbackInput({ body: 'love it', projectId: 'p 1; drop', workstream: '../x' });
    expect(r).toMatchObject({ ok: { kind: 'other', projectId: null, workstream: null, cliVersion: null } });
  });

  it('refuses an empty or overlong body, and an unknown kind', () => {
    expect(parseFeedbackInput({ body: '   ' })).toEqual({ error: expect.stringMatching(/body is required/) });
    expect(parseFeedbackInput({})).toEqual({ error: expect.stringMatching(/body is required/) });
    expect(parseFeedbackInput({ body: 'x'.repeat(LIMITS.body + 1) })).toEqual({ error: expect.stringMatching(/at most 5000/) });
    expect(parseFeedbackInput({ body: 'x', kind: 'rant' })).toEqual({ error: 'kind is one of praise, problem, idea, other' });
  });

  it('redacts secret-shaped strings in every field and names their kinds', () => {
    const tok = `ghp_${'s'.repeat(36)}`;
    const r = parseFeedbackInput({ body: `pasting ${tok} into chat should be blocked`, agentModel: tok });
    if (!('ok' in r)) throw new Error(r.error);
    expect(r.ok.body).toBe('pasting [redacted: GitHub token] into chat should be blocked');
    expect(r.ok.agentModel).toBe('[redacted: GitHub token]');
    expect(r.ok.redacted).toEqual(['GitHub token']);
  });
});

describe('parseFeedbackFilter', () => {
  it('reads status, kind, q and limit, capping the limit', () => {
    expect(parseFeedbackFilter({ status: 'new', kind: 'idea,problem', q: ' sidebar ', limit: '9999' }))
      .toEqual({ ok: { statuses: ['new'], kinds: ['idea', 'problem'], search: 'sidebar', limit: 500 } });
    expect(parseFeedbackFilter({})).toEqual({ ok: { limit: 500 } });
  });

  it('refuses unknown values with the allowed list', () => {
    expect(parseFeedbackFilter({ status: 'triaged' })).toEqual({ error: 'status is one of new, seen (got "triaged")' });
    expect(parseFeedbackFilter({ kind: 'rant' })).toMatchObject({ error: expect.stringMatching(/kind is one of/) });
    expect(parseFeedbackFilter({ limit: '0' })).toMatchObject({ error: expect.stringMatching(/limit/) });
  });
});

describe('the rest', () => {
  it('takes new or seen only', () => {
    expect(parseStatusChange({ status: 'seen' })).toEqual({ ok: 'seen' });
    expect(parseStatusChange({ status: 'new' })).toEqual({ ok: 'new' });
    expect(parseStatusChange({ status: 'fixed' })).toMatchObject({ error: expect.any(String) });
  });

  it('fills every status, and counts the hourly limit', () => {
    expect(fillCounts({ new: 2 })).toEqual({ new: 2, seen: 0 });
    expect(underRateLimit(FEEDBACK_PER_HOUR - 1)).toBe(true);
    expect(underRateLimit(FEEDBACK_PER_HOUR)).toBe(false);
  });
});
