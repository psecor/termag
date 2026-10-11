import { describe, it, expect } from 'vitest';
import { guessExplanation, parsePrInput, parsePrInputFull, reviewStateLabel, reviewStateText } from './review';

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
