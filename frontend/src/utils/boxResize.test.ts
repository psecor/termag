import { describe, expect, it } from 'vitest';
import {
  busyRefusal, currentSizeLabel, defaultResizeTarget, resizeFromStatus, losesHibernation, offersResize, resizeBadge, resizeOptionLabel, resizeOutcome, resizeSteps, resizeWarning,
  type BoxResizeInfo, type ResizeView,
} from './boxResize';
import type { BoxSizeChoice } from './boxSize';

const SIZES: BoxSizeChoice[] = [
  { size: 'small', vcpus: 2, memoryGiB: 8, instanceType: 'm8g.large' },
  { size: 'medium', vcpus: 4, memoryGiB: 16, instanceType: 'm8g.xlarge' },
  { size: 'large', vcpus: 8, memoryGiB: 32, instanceType: 'm8g.2xlarge' },
];
const view = (over: Partial<ResizeView> = {}): ResizeView => ({
  to: 'large', from: 'small', phase: 'stopping', running: true, startedAt: new Date().toISOString(), finishedAt: null,
  error: null, byAdmin: false, reason: null, ...over,
});
const NOW = Date.parse('2026-10-28T12:00:00Z');

describe('the size choices', () => {
  it('reads each size as the New box pickers do, the current one marked', () => {
    expect(SIZES.map(s => resizeOptionLabel(s, 'medium'))).toEqual([
      'Small · 2 vCPU, 8 GB RAM', 'Medium · 4 vCPU, 16 GB RAM (current)', 'Large · 8 vCPU, 32 GB RAM',
    ]);
  });

  it('preselects the next size up, or the one below for the largest', () => {
    expect(defaultResizeTarget('small', SIZES)).toBe('medium');
    expect(defaultResizeTarget('medium', SIZES)).toBe('large');
    expect(defaultResizeTarget('large', SIZES)).toBe('medium');
    expect(defaultResizeTarget(null, SIZES)).toBe('small');
  });
});

describe('the current size, for the Resize box menu item', () => {
  it('reads "Medium: 4 vCPU 16GB RAM", or as the AWS type for a custom box', () => {
    expect(SIZES.map(s => currentSizeLabel({ size: s.size, instanceType: s.instanceType }, SIZES)))
      .toEqual(['Small: 2 vCPU 8GB RAM', 'Medium: 4 vCPU 16GB RAM', 'Large: 8 vCPU 32GB RAM']);
    // The dropdown options keep their own wording.
    expect(resizeOptionLabel(SIZES[1], null)).toBe('Medium · 4 vCPU, 16 GB RAM');
    expect(currentSizeLabel({ size: 'medium', instanceType: 'm8g.xlarge' }, null)).toBe('Medium');
    expect(currentSizeLabel({ size: null, instanceType: 'r8g.xlarge' }, SIZES)).toBe('r8g.xlarge');
    expect(currentSizeLabel({ size: 'custom', instanceType: 'r8g.xlarge' }, SIZES)).toBe('r8g.xlarge');
  });
});

describe('the warning', () => {
  it("is the one downtime notice, word for word", () => {
    expect(resizeWarning('ready')).toBe("The box stops for two to three minutes while it's resized. Anything running on it stops too: agent turns, terminals, dev servers.");
  });
  it('says how long, and that running work stops, for a running box', () => {
    expect(resizeWarning('ready')).toMatch(/two to three minutes.*agent turns/s);
  });
  it('says a box that is down stays down; a hibernated one loses its memory', () => {
    expect(resizeWarning('stopped')).toMatch(/stays stopped/);
    expect(resizeWarning('hibernated')).toMatch(/resumed first.*not kept.*stays stopped/);
  });
});

describe('the progress', () => {
  it('stopping, resizing, starting, ready for a running box', () => {
    expect(resizeSteps(view({ phase: 'resizing' }), 'ready').map(s => `${s.phase}:${s.state}`))
      .toEqual(['stopping:done', 'resizing:current', 'starting:todo', 'ready:todo']);
    expect(resizeSteps(view({ phase: 'ready', running: false }), 'ready').every(s => s.state === 'done')).toBe(true);
  });
  it('a hibernated box resumes first and ends stopped; a stopped box only resizes', () => {
    expect(resizeSteps(view({ phase: 'resuming' }), 'hibernated').map(s => s.phase)).toEqual(['resuming', 'stopping', 'resizing', 'stopped']);
    expect(resizeSteps(view({ phase: 'resizing' }), 'stopped').map(s => s.phase)).toEqual(['resizing', 'stopped']);
  });
  it("follows the status the resize started from; without one, guesses from the phase, not the live row", () => {
    expect(resizeFromStatus(view({ phase: 'resizing', fromStatus: 'ready' }), 'stopped')).toBe('ready');
    expect(resizeFromStatus(view({ phase: 'stopping', fromStatus: 'hibernated' }), 'stopping')).toBe('hibernated');
    expect(resizeFromStatus(view({ phase: 'starting' }), 'starting')).toBe('ready');
    expect(resizeFromStatus(view({ phase: 'resizing' }), 'stopped')).toBe('stopped');
  });
  it('reads the outcome', () => {
    expect(resizeOutcome(view({ phase: 'ready', running: false }), SIZES)).toBe('Now Large · 8 vCPU, 32 GB RAM, and running.');
    expect(resizeOutcome(view({ phase: 'stopped', running: false, to: 'medium' }), SIZES)).toBe('Now Medium · 4 vCPU, 16 GB RAM, and stopped.');
    expect(resizeOutcome(view({ phase: 'failed', running: false, error: 'no capacity' }), SIZES)).toBe('The resize failed: no capacity');
    expect(resizeOutcome(view(), SIZES)).toBe(null);
  });
});

describe('the box lists', () => {
  const row = { kind: 'ec2' as const, status: 'ready' as const, ec2InstanceId: 'i-1', resize: null };
  it('offers Size… on an EC2 box that is up or down, and while it is resized', () => {
    expect(offersResize(row)).toBe(true);
    expect(offersResize({ ...row, status: 'stopped' })).toBe(true);
    expect(offersResize({ ...row, status: 'starting' })).toBe(false);
    expect(offersResize({ ...row, kind: 'external' })).toBe(false);
    expect(offersResize({ ...row, status: 'starting', resize: view({ phase: 'starting' }) })).toBe(true);
  });
  it("shows a resize under way, as the server reads its box_events row, and not a finished one", () => {
    expect(resizeBadge({ resize: view({ phase: 'starting' }) })).toBe('resizing to large: starting, waiting for its agent');
    expect(resizeBadge({ resize: view({ phase: 'ready', running: false }) })).toBe(null);
    expect(resizeBadge({ resize: null })).toBe(null);
  });
});


describe('hibernation and refusals', () => {
  const info = (over: Partial<BoxResizeInfo['box']> = {}): BoxResizeInfo => ({
    box: { id: 'b1', name: 'olive', status: 'ready', size: 'medium', instanceType: 'm8g.xlarge', hibernationConfigured: true, ...over },
    sizes: SIZES, resize: null, refusal: null, blockers: [],
  });
  it('a hibernation-capable box loses it going up in RAM, not going down', () => {
    expect(losesHibernation(info(), 'large')).toBe(true);
    expect(losesHibernation(info(), 'small')).toBe(false);
    expect(losesHibernation(info({ hibernationConfigured: false }), 'large')).toBe(false);
  });
  it('reads a 409 box_busy, and nothing else, as a busy box', () => {
    const blockers = [{ check: 'working', reason: 'an agent is working on it', forceable: true }];
    expect(busyRefusal({ response: { status: 409, data: { code: 'box_busy', error: 'busy', blockers, forceable: true } } }))
      .toEqual({ error: 'busy', blockers, forceable: true });
    expect(busyRefusal({ response: { status: 409, data: { code: 'resize_running', error: 'x' } } })).toBe(null);
  });
});
