import { describe, it, expect } from 'vitest';
import { guessExplanation, parsePrInput, parsePrInputFull, renderReviewTemplate, reviewerDisplayName, reviewPromptHeader, reviewStateLabel, reviewStateText, reviewTargetView, type PrGuess } from './review';

describe('parsePrInput', () => {
  it('accepts a number, #number, "PR 123" and a GitHub PR URL', () => {
    expect(parsePrInput('123')).toBe(123);
    expect(parsePrInput('#123')).toBe(123);
    expect(parsePrInput('PR 42')).toBe(42);
    expect(parsePrInput('https://github.com/example-org/termag/pull/185')).toBe(185);
  });
  it('keeps a pasted url so the dock can link it', () => {
    expect(parsePrInputFull(' https://github.com/example-org/termag/pull/185 ')).toEqual({ number: 185, url: 'https://github.com/example-org/termag/pull/185' });
    expect(parsePrInputFull('#9')).toEqual({ number: 9, url: null });
  });
  it('reads owner/repo#N as that repository\'s PR', () => {
    expect(parsePrInputFull('example-org/termag#342')).toEqual({ number: 342, url: 'https://github.com/example-org/termag/pull/342' });
    expect(parsePrInputFull('example-org/termag#')).toBeNull();
  });
  it('rejects anything else', () => {
    expect(parsePrInput('')).toBeNull();
    expect(parsePrInput('0')).toBeNull();
    expect(parsePrInput('main')).toBeNull();
    expect(parsePrInput('https://github.com/example-org/termag/issues/185')).toBeNull();
  });
});

describe('guessExplanation', () => {
  it('names the source of the prefilled number', () => {
    expect(guessExplanation({ number: 1, url: null, title: 'T', branch: 'feat', state: 'OPEN', source: 'gh' }, 'feat')).toBe('Open PR for branch feat: T');
    expect(guessExplanation({ number: 1, url: null, title: 'T', branch: 'feat', state: 'MERGED', source: 'gh' }, 'feat')).toBe('Merged PR for branch feat: T');
    expect(guessExplanation({ number: 1, url: null, title: null, branch: null, state: null, source: 'milestone' }, null)).toMatch(/just opened or merged/);
    expect(guessExplanation({ number: 1, url: null, title: null, branch: null, state: null, source: 'pane' }, null)).toMatch(/agent pane/);
  });
  it('asks for a number when nothing was found', () => {
    expect(guessExplanation(null, 'wip')).toBe('No pull request found for branch wip. Type the PR number.');
    expect(guessExplanation(null, null)).toBe('No pull request found. Type the PR number.');
  });
});

describe('reviewStateLabel', () => {
  it('passes the pane state through, reads no pane as gone and an unknown state as reviewing', () => {
    expect(reviewStateLabel({ alive: true, state: 'reviewing' })).toBe('reviewing');
    expect(reviewStateLabel({ alive: true, state: 'waiting' })).toBe('waiting');
    expect(reviewStateLabel({ alive: true, state: 'done' })).toBe('done');
    expect(reviewStateLabel({ alive: true, state: 'exited' })).toBe('exited');
    expect(reviewStateLabel({ alive: true, state: null })).toBe('reviewing');
    expect(reviewStateLabel({ alive: false, state: 'done' })).toBe('gone');
  });
  it('has a line for every state', () => {
    expect(reviewStateText('waiting')).toMatch(/answer/);
    expect(reviewStateText('done')).toMatch(/ready/i);
    expect(reviewStateText('gone')).toBe('');
  });
});

describe('renderReviewTemplate', () => {
  it('fills {{pr}} and {{url}} for the confirmed PR, like the backend', () => {
    expect(renderReviewTemplate('gh pr diff {{pr}} · {{ url }}', 12, 'https://github.com/o/r/pull/12'))
      .toBe('gh pr diff 12 · https://github.com/o/r/pull/12');
    expect(renderReviewTemplate('{{url}}', 12, 'https://github.com/o/r/pull/13')).toBe('#12');
  });
  it('leaves the placeholders alone until there is a PR', () => {
    expect(renderReviewTemplate('gh pr diff {{pr}}', null, null)).toBe('gh pr diff {{pr}}');
  });
});

describe('reviewer names in the labels', () => {
  it('names the reviewer, Devin when unknown', () => {
    expect(reviewerDisplayName('claude')).toBe('Claude');
    expect(reviewerDisplayName('cursor')).toBe('Cursor');
    expect(reviewerDisplayName(undefined)).toBe('Devin');
    expect(reviewerDisplayName('nope')).toBe('Devin');
    expect(reviewStateText('reviewing', 'claude')).toBe('Claude reviewing…');
    expect(reviewStateText('waiting', 'cursor')).toBe('Cursor needs an answer');
    expect(reviewStateText('exited')).toBe('Devin exited');
    expect(reviewStateText('done', 'claude')).toBe('Review ready');
  });
});

describe('reviewTargetView', () => {
  const termag = 'https://github.com/example-org/termag/pull/342';
  const paneGuess: PrGuess = { number: 342, url: null, title: null, branch: null, state: null, source: 'pane' };
  it('a bare number is in the workstream\'s repository', () => {
    expect(reviewTargetView({ pr: 342, typedUrl: null, guess: null, repo: 'example-org/termag', repoKnown: true }))
      .toEqual({ url: termag, repo: 'example-org/termag', title: null, problem: null, mismatch: null });
  });
  it('refuses a bare number when the directory has no GitHub remote (the webapp#342 case)', () => {
    const v = reviewTargetView({ pr: 342, typedUrl: null, guess: paneGuess, repo: null, repoKnown: true });
    expect(v.url).toBeNull();
    expect(v.problem).toMatch(/no GitHub remote.*owner\/repo#342/);
    expect(reviewTargetView({ pr: 342, typedUrl: termag, guess: null, repo: null, repoKnown: true }).problem).toBeNull();
  });
  it('flags a PR in another repository than the checkout', () => {
    const webapp = { ...paneGuess, url: 'https://github.com/example-org/webapp/pull/342', title: 'Old PR' };
    expect(reviewTargetView({ pr: 342, typedUrl: null, guess: webapp, repo: 'example-org/termag', repoKnown: true }))
      .toMatchObject({ repo: 'example-org/webapp', title: 'Old PR', mismatch: 'example-org/termag' });
  });
  it('the guess\'s url and title apply only to the guessed number', () => {
    const g = { ...paneGuess, url: termag, title: 'T' };
    expect(reviewTargetView({ pr: 5, typedUrl: null, guess: g, repo: null, repoKnown: false }))
      .toEqual({ url: null, repo: null, title: null, problem: null, mismatch: null });
  });
});

describe('reviewPromptHeader', () => {
  it('names the repository and pins gh to it when the PR has a URL', () => {
    expect(reviewPromptHeader(342, 'https://github.com/example-org/termag/pull/342'))
      .toBe('Review GitHub pull request #342 (https://github.com/example-org/termag/pull/342) in the repository example-org/termag. Pass --repo example-org/termag to every gh command: the current directory may be a different repository, or none.');
    expect(reviewPromptHeader(342, null)).toBe('Review GitHub pull request #342 for the repository in the current directory.');
    expect(reviewPromptHeader(null, null)).toBe('Review GitHub pull request #… for the repository in the current directory.');
  });
});
