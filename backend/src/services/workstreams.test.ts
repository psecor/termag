import { describe, expect, it } from 'vitest';
import { mainWorkstreamBranch } from './workstreams';

describe('mainWorkstreamBranch', () => {
  it('uses main on a box when nothing was requested, even if this host detected trunk', () => {
    expect(mainWorkstreamBranch({ instanceId: 'box-1', detected: 'trunk' })).toBe('main');
  });

  it('keeps an explicit branch on a box', () => {
    expect(mainWorkstreamBranch({ requested: 'develop', instanceId: 'box-1', detected: 'trunk' })).toBe('develop');
  });

  it('uses the detected branch on the host', () => {
    expect(mainWorkstreamBranch({ instanceId: null, detected: 'trunk' })).toBe('trunk');
  });

  it('falls back to main on the host when the request is blank and detection is empty', () => {
    expect(mainWorkstreamBranch({ requested: '   ', instanceId: null, detected: '' })).toBe('main');
  });

  it('ignores a whitespace request', () => {
    expect(mainWorkstreamBranch({ requested: '  ', instanceId: null, detected: 'trunk' })).toBe('trunk');
  });
});
