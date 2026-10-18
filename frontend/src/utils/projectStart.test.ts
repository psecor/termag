import { describe, expect, it } from 'vitest';
import { boxIsUsableForProject, funnyProjectName, isBoxFailedRefusal, pickDefaultBox, unusableBoxAdvice } from './projectStart';

describe('pickDefaultBox', () => {
  it('prefers ready, then in-flight, never parked', () => {
    const boxes = [
      { id: 'a', status: 'stopped' as const },
      { id: 'b', status: 'provisioning' as const },
      { id: 'c', status: 'ready' as const },
    ];
    expect(pickDefaultBox(boxes)?.id).toBe('c');
    expect(pickDefaultBox(boxes.slice(0, 2))?.id).toBe('b');
    expect(pickDefaultBox(boxes.slice(0, 1))).toBeNull();
    expect(boxIsUsableForProject({ status: 'hibernated' })).toBe(false);
  });
});

describe('funnyProjectName', () => {
  it('is proj-<adjective>-<noun> in the project-name alphabet', () => {
    for (let i = 0; i < 50; i++) expect(funnyProjectName()).toMatch(/^proj-[a-z]+-[a-z]+$/);
  });
  it('is deterministic for a given rng', () => {
    expect(funnyProjectName(() => 0)).toBe('proj-fuzzy-pants');
    expect(funnyProjectName(() => 0.999999)).toBe(funnyProjectName(() => 0.999999));
  });
});

describe('unusableBoxAdvice', () => {
  it('offers Try again for a failed EC2 box, never "start it"', () => {
    expect(unusableBoxAdvice({ kind: 'ec2', status: 'failed' })).toBe('try-again');
    expect(unusableBoxAdvice({ kind: 'external', status: 'failed' })).toBeNull();
  });

  it('sends a failed box a project waits on to that project\'s Retry', () => {
    expect(unusableBoxAdvice({ kind: 'ec2', status: 'failed' }, 1)).toBe('retry-project');
  });

  it('keeps the start advice for a stopped or hibernated box', () => {
    expect(unusableBoxAdvice({ kind: 'ec2', status: 'stopped' })).toBe('start-it');
    expect(unusableBoxAdvice({ kind: 'ec2', status: 'hibernated' })).toBe('start-it');
  });

  it('says nothing about a usable box', () => {
    expect(unusableBoxAdvice({ kind: 'ec2', status: 'ready' })).toBeNull();
    expect(unusableBoxAdvice({ kind: 'ec2', status: 'provisioning' })).toBeNull();
  });
});

describe('isBoxFailedRefusal', () => {
  it('recognizes the server\'s box-failed refusal and nothing else', () => {
    expect(isBoxFailedRefusal({ response: { data: { code: 'box-failed', error: 'The box failed to launch' } } })).toBe(true);
    expect(isBoxFailedRefusal({ response: { data: { error: 'Box agent is not connected' } } })).toBe(false);
    expect(isBoxFailedRefusal(new Error('network'))).toBe(false);
  });
});
