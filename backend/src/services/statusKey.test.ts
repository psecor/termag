import { describe, it, expect } from 'vitest';
import { parseStatusKey, statusKey } from './statusKey';

describe('statusKey', () => {
  it('keeps the same tmux name apart across instances', () => {
    const session = 'alice-cx-agent';
    const host = statusKey(null, session);
    const boxA = statusKey('box-a', session);
    const boxB = statusKey('box-b', session);
    expect(new Set([host, boxA, boxB]).size).toBe(3);
    expect(parseStatusKey(host)).toEqual({ instanceId: null, session });
    expect(parseStatusKey(boxA)).toEqual({ instanceId: 'box-a', session });
  });
});
