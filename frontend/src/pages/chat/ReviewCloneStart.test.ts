import { describe, expect, it } from 'vitest';
import { cloneOutcomeFor, cloneStartHref, noteCloneOutcome } from '../../chat/reviewClone';
import { cloneStartView } from './ReviewCloneStart';

describe('the page a review waits on while its project is cloned', () => {
  it('is at its own URL under the PR', () => {
    expect(cloneStartHref('example-org/termag', 4242)).toBe('/chat/review-start/example-org/termag/4242');
  });
  it('shows the clone\'s step as it reports it', () => {
    expect(cloneStartView({ repo: 'example-org/termag', box: 'box-1', phase: 'waking' }, { pending: true }))
      .toEqual({ kind: 'step', text: 'Waking box-1 to clone example-org/termag…' });
    expect(cloneStartView({ repo: 'example-org/termag', box: 'box-1', phase: 'cloning', projectName: 'termag' }, { pending: true }))
      .toEqual({ kind: 'step', text: 'Cloning example-org/termag into termag on box-1…' });
  });
  it('says the review is starting before the first step, and when the clone is done', () => {
    expect(cloneStartView(null, { pending: true })).toEqual({ kind: 'step', text: 'Starting the review…' });
  });
  it('says the session is opening once the clone is done, never that nothing is starting', () => {
    expect(cloneStartView(null, { to: { projectId: 'p', workstream: 'main', state: {} } })).toEqual({ kind: 'step', text: 'Opening the session…' });
  });
  it('shows why it failed over any step', () => {
    expect(cloneStartView({ repo: 'example-org/termag', box: 'box-1', phase: 'cloning' }, { error: 'The clone of example-org/termag failed: auth' }))
      .toEqual({ kind: 'error', text: 'The clone of example-org/termag failed: auth' });
  });
  it('keeps one clone-and-review per PR: under way until the page takes its session or it fails', () => {
    noteCloneOutcome('example-org/termag', 7, { pending: true });
    expect(cloneOutcomeFor('example-org/termag', 7)).toEqual({ pending: true });
    expect(cloneOutcomeFor('example-org/termag', 8)).toBeNull();
    noteCloneOutcome('example-org/termag', 7, { to: { projectId: 'p', workstream: 'main', state: {} } });
    noteCloneOutcome('example-org/termag', 7, null);
    expect(cloneOutcomeFor('example-org/termag', 7)).toBeNull();
  });
  it('says nothing is starting when no review started from this page load (a reload)', () => {
    expect(cloneStartView(null, null)).toEqual({ kind: 'idle' });
  });
});
