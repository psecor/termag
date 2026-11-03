import { describe, expect, it, vi } from 'vitest';
import { answerOf, cleanHeading, createHeadingStore, headingOfEvent } from './toolGroupHeadings';

describe('tool-group headings', () => {
  it('reads a heading frame or a failure frame, and nothing else', () => {
    expect(headingOfEvent({ type: 'tool-group-heading', runKey: 'run:tool:t1', heading: ' Fix the\nlogin race ' })).toEqual({ runKey: 'run:tool:t1', answer: { heading: 'Fix the login race' } });
    expect(headingOfEvent({ type: 'tool-group-heading', runKey: 'run:tool:t1', failed: true, calls: 2 })).toEqual({ runKey: 'run:tool:t1', answer: { failed: true, calls: 2 } });
    expect(headingOfEvent({ type: 'tool-group-heading', runKey: '', heading: 'x' })).toBeNull();
    // An empty or unusable heading is a failure, so the run takes its fallback instead of waiting on.
    expect(headingOfEvent({ type: 'tool-group-heading', runKey: 'run:tool:t1', heading: '   ' })).toEqual({ runKey: 'run:tool:t1', answer: { failed: true, calls: null } });
    expect(answerOf({ what: 1 })).toEqual({ failed: true, calls: null });
    expect(answerOf(42)).toBeNull();
    expect(headingOfEvent({ type: 'session-title', title: 'x' })).toBeNull();
    expect(answerOf({ failed: true })).toEqual({ failed: true, calls: null });
    expect(cleanHeading('x'.repeat(200))).toHaveLength(80);
  });

  it('keeps the first answer for a run, tells only that run, and a history load keeps what a frame brought', () => {
    const store = createHeadingStore();
    const one = vi.fn();
    const two = vi.fn();
    store.subscribe('run:tool:1', one);
    const off = store.subscribe('run:tool:2', two);
    store.add('run:tool:1', { heading: 'Find the bug' });
    store.add('run:tool:1', { heading: 'Something else' });
    expect(one).toHaveBeenCalledTimes(1);
    expect(store.get('run:tool:1')).toEqual({ heading: 'Find the bug' });
    expect(two).not.toHaveBeenCalled();
    store.load({ 'run:tool:1': { heading: 'From history' }, 'run:tool:2': { failed: true, calls: 2 }, 'run:tool:3': 42 });
    expect(store.get('run:tool:1')).toEqual({ heading: 'Find the bug' });
    expect(store.get('run:tool:2')).toEqual({ failed: true, calls: 2 });
    expect(store.get('run:tool:3')).toBeNull();

    // The wait and the chosen line are the run's, kept across ToolRuns.
    expect(store.waitSince('run:tool:9')).toBeNull();
    expect(store.waitSince('run:tool:9', 1000)).toBe(1000);
    expect(store.waitSince('run:tool:9', 5000)).toBe(1000);
    store.choose('run:tool:9', { text: 'First', source: 'calls' });
    store.choose('run:tool:9', { text: 'Second', source: 'model' });
    expect(store.chosen('run:tool:9')).toEqual({ text: 'First', source: 'calls' });
    off();
    store.add('run:tool:4', { heading: 'x' });
    expect(two).toHaveBeenCalledTimes(1);
    store.load(null);
    store.load(['x']);
  });
});
