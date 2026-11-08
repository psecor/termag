import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCKER_UPDATE_POLICY, parseDockerUpdatePolicy } from './dockerUpdatePolicy';

describe('parseDockerUpdatePolicy', () => {
  it('defaults to the newest version an advisory requires (29.9.3), latest, restart none', () => {
    expect(parseDockerUpdatePolicy(null)).toEqual({ mode: 'off', floor: '29.9.3', target: 'latest', restart: 'none', drainSec: 600, forceAfterHours: 24 });
    expect(DEFAULT_DOCKER_UPDATE_POLICY.restart).toBe('none');
  });
  it('takes an exact target and a raised floor, and keeps the default for a bad key', () => {
    expect(parseDockerUpdatePolicy({ floor: '29.10.0', target: '29.10.0' })).toMatchObject({ floor: '29.10.0', target: '29.10.0' });
    expect(parseDockerUpdatePolicy({ target: 'stable', floor: 'x' })).toMatchObject({ floor: '29.9.3', target: 'latest' });
  });
});
