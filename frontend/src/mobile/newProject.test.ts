import { describe, it, expect } from 'vitest';
import type { Instance } from '../types';
import { boxLabel, pickDefaultBox, usableBoxes } from './newProject';

const box = (id: string, status: Instance['status'], projects?: number): Instance =>
  ({ id, name: id, kind: 'ec2', status, createdAt: '2026-10-01T00:00:00Z', _count: projects == null ? undefined : { projects } });

describe('newProject helpers', () => {
  const boxes = [box('stopped', 'stopped'), box('busy', 'ready', 5), box('warm', 'warm'), box('quiet', 'ready', 1), box('dead', 'terminated')];

  it('keeps only usable boxes', () => {
    expect(usableBoxes(boxes).map(b => b.id)).toEqual(['busy', 'warm', 'quiet']);
  });

  it('preselects the ready box with the fewest projects, else the first usable', () => {
    expect(pickDefaultBox(boxes)?.id).toBe('quiet');
    expect(pickDefaultBox([box('a', 'warming'), box('b', 'provisioning')])?.id).toBe('a');
    expect(pickDefaultBox([box('a', 'stopped')])).toBeNull();
  });

  it('labels a box with its status and project count', () => {
    expect(boxLabel(box('b1', 'awaiting-agent'))).toBe('b1 · awaiting agent');
    expect(boxLabel(box('b1', 'ready', 1))).toBe('b1 · ready · 1 project');
    expect(boxLabel(box('b1', 'ready', 3))).toBe('b1 · ready · 3 projects');
  });
});
