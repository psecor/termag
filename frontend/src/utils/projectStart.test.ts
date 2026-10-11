import { describe, expect, it } from 'vitest';
import { boxIsUsableForProject, funnyProjectName, pickDefaultBox } from './projectStart';

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
