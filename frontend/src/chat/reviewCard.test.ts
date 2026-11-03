import { describe, expect, it } from 'vitest';
import { inlineOf, readReviewFence, reviewFormatInstruction, REVIEW_FORMAT_MARK, summaryOf, type ReviewFindings } from './reviewCard';

const FINDINGS = {
  kind: 'findings', round: 1, head: '9c3e1f2', verdict: 'REQUEST_CHANGES', take: 'Two regressions.', summary: 'Two cases are cut.',
  findings: [
    { id: 'f1', tier: 'blocks-merge', title: 'A slow service is cut', why: 'It closes after 60 s.', ask: 'skip it', at: { path: 'agent/tunnel-dial.js', line: 239 }, comment: 'Cut here.', ticked: true },
    { id: 'f2', tier: 'recommend', title: 'Docs overclaim', why: 'Slow readers are still cut.', ticked: false },
    { id: 'f3', tier: 'nonsense', title: 'dropped', why: 'no tier' },
    { title: 'no id', tier: 'question', why: 'gets one' },
  ],
  checked: ['CI passed', 7],
};

describe('readReviewFence', () => {
  it('reads the findings, dropping what has no shape', () => {
    const r = readReviewFence(JSON.stringify(FINDINGS)) as ReviewFindings;
    expect(r.kind).toBe('findings');
    expect(r.findings.map(f => [f.id, f.tier, f.ticked, f.at])).toEqual([
      ['f1', 'blocks-merge', true, { path: 'agent/tunnel-dial.js', line: 239 }],
      ['f2', 'recommend', false, null],
      ['f4', 'question', true, null],
    ]);
    expect(r.checked).toEqual(['CI passed']);
  });

  it('reads a follow-up round, and refuses what is not JSON or not a review', () => {
    const f = readReviewFence(JSON.stringify({ kind: 'followup', round: 2, head: 'a1b2c3d', addressed: [{ title: 'A slow service is cut', how: 'Fixed.' }, {}], fresh: [] }));
    expect(f).toEqual({ kind: 'followup', round: 2, head: 'a1b2c3d', addressed: [{ title: 'A slow service is cut', how: 'Fixed.', fixed: true }], fresh: [] });
    expect(readReviewFence('not json')).toBeNull();
    expect(readReviewFence('[1,2]')).toBeNull();
    expect(readReviewFence(JSON.stringify({ kind: 'other' }))).toBeNull();
  });
});

describe('what posts', () => {
  it('turns a finding with a line into its inline comment, and the rest into the summary', () => {
    const r = readReviewFence(JSON.stringify(FINDINGS)) as ReviewFindings;
    expect(inlineOf(r.findings[0])).toEqual({ path: 'agent/tunnel-dial.js', line: 239, body: 'Cut here.' });
    expect(inlineOf(r.findings[1])).toBeNull();
    const all = summaryOf(r, () => true, 'Drafted with Claude in termag.');
    expect(all).toBe('Two cases are cut.\n\n- **Docs overclaim.** Slow readers are still cut. \n- **no id.** gets one\n\nDrafted with Claude in termag.'.replace('cut. \n', 'cut.\n'));
  });

  it('asks for the fence after a marker the chat folds away', () => {
    const asked = reviewFormatInstruction('termag#804');
    expect(asked.startsWith(REVIEW_FORMAT_MARK)).toBe(true);
    expect(asked).toContain('"pr":"termag#804"');
    expect(asked).toContain("Don't post anything to GitHub");
  });
});
