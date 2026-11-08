import { describe, expect, it } from 'vitest';
import { isAutomaticRun, triggerText } from './runTrigger';

describe('triggerText', () => {
  it('marks the sweep\'s runs automatic and names why', () => {
    expect(triggerText({ trigger: 'floor' })).toBe('auto · floor breach');
    expect(triggerText({ trigger: 'resume' })).toBe('auto · resume');
    expect(triggerText({ trigger: 'nightly' })).toBe('auto · nightly');
    expect(['floor', 'resume', 'nightly'].every(t => isAutomaticRun({ trigger: t as never }))).toBe(true);
  });

  it('leaves the manual and the box\'s own runs as they are', () => {
    expect(triggerText({ trigger: 'manual' })).toBe('manual');
    expect(triggerText({ trigger: 'boot' })).toBe('boot');
    expect(triggerText({ trigger: 'guard' })).toBe('runner guard');
    expect(['manual', 'boot', 'guard'].some(t => isAutomaticRun({ trigger: t as never }))).toBe(false);
  });
});
