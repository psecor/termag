/**
 * The git state a chat's turn end records: its content,
 * its size, and the line the first turn on a new box reads.
 */
import { describe, expect, it } from 'vitest';
import { describeGitState, gitStateFrom, GIT_STATE_MAX_BYTES, parseGitState } from './chatGitState';

const SHA = 'abc1234def5678901234567890abcdef12345678';
const AT = new Date('2026-10-27T12:00:00Z');
// An origin with credentials in it, as a clone made with a token has. Built at
// run time from obviously fake parts, so no scanner reads it as a real one.
const ORIGIN_WITH_CREDENTIALS = ['https://', 'fake-user', ':', 'FAKE', '@', 'example.invalid/o/r.git'].join('');

describe('gitStateFrom', () => {
  it('keeps the branch, HEAD, upstream, counts and the PR, and nothing else', () => {
    const s = gitStateFrom({
      branch: 'feat/resume', head: SHA, upstream: 'origin/feat/resume', ahead: 0, behind: 2, abKnown: true,
      dirty: true, changed: 2, untracked: 1, baseBranch: 'main', aheadOfBase: 3,
      origin: ORIGIN_WITH_CREDENTIALS, lastCommitAt: '2026-10-27T11:00:00Z',
    }, { number: 12, url: 'https://github.com/org/repo/pull/12' }, AT);
    expect(s).toEqual({
      branch: 'feat/resume', head: SHA, upstream: 'origin/feat/resume', pushed: true, unpushed: 0,
      uncommitted: 2, untracked: 1, pr: { number: 12, url: 'https://github.com/org/repo/pull/12' }, at: AT.toISOString(),
    });
    expect(JSON.stringify(s)).not.toMatch(/fake-user|FAKE|example\.invalid/);
  });

  it('counts unpushed commits against the upstream, or against the base when never pushed', () => {
    expect(gitStateFrom({ branch: 'f', head: SHA, upstream: 'origin/f', ahead: 2, abKnown: true }, null, AT))
      .toMatchObject({ pushed: false, unpushed: 2 });
    expect(gitStateFrom({ branch: 'f', head: SHA, upstream: null, aheadOfBase: 4, baseBranch: 'main' }, null, AT))
      .toMatchObject({ pushed: null, unpushed: 4, unpushedAgainst: 'origin/main' });
    // The upstream's ref is gone: ahead 0 is not "pushed".
    expect(gitStateFrom({ branch: 'f', head: SHA, upstream: 'origin/f', ahead: 0, abKnown: false }, null, AT))
      .toMatchObject({ pushed: null, unpushed: null });
  });

  it('drops what does not validate, and an older agent leaves the counts unknown', () => {
    const s = gitStateFrom({ branch: 'bad\nname', head: 'nope', upstream: 42, changed: -1, untracked: 'x' },
      { number: 3, url: 'javascript:alert(1)' }, AT);
    expect(s).toMatchObject({ branch: null, head: null, upstream: null, uncommitted: null, untracked: null, pr: null });
  });

  it('stays under its size cap with the longest names it takes', () => {
    const long = 'b'.repeat(200);
    const s = gitStateFrom({ branch: long, head: SHA, upstream: `origin/${long}`.slice(0, 200), ahead: 1, abKnown: true, changed: 1e6, untracked: 1e6 },
      { number: 99999, url: 'https://github.com/org/repo/pull/99999' }, AT);
    expect(Buffer.byteLength(JSON.stringify(s))).toBeLessThanOrEqual(GIT_STATE_MAX_BYTES);
    expect(parseGitState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('describeGitState', () => {
  it('says HEAD, whether it was pushed and what was lost, naming no ref', () => {
    const s = gitStateFrom({ branch: 'X', head: SHA, upstream: 'origin/X', ahead: 0, abKnown: true, changed: 2, untracked: 0 }, null, AT);
    expect(describeGitState(s)).toBe(`Last state on the old box: HEAD at abc1234 on a branch, pushed to its upstream, 2 uncommitted files lost. Recorded at its last turn end, ${AT.toISOString()}.`);
  });

  it('says what was never pushed, and the open PR', () => {
    const s = gitStateFrom({ branch: 'wip', head: SHA, upstream: null, aheadOfBase: 1, baseBranch: 'main', changed: 0, untracked: 3 },
      { number: 7, url: 'https://github.com/o/r/pull/7' }, AT);
    expect(describeGitState(s)).toContain('HEAD at abc1234 on a branch, never pushed, 1 commit not on the default branch (lost), 3 untracked files lost, an open PR #7');
  });

  it('says when nothing was recorded', () => {
    expect(describeGitState(null)).toBe('No git state was recorded on the old box.');
  });
});
