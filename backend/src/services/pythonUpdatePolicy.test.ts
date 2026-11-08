import { describe, expect, it } from 'vitest';
import { DEFAULT_PYTHON_UPDATE_POLICY, parsePythonUpdatePolicy } from './pythonUpdatePolicy';

describe('parsePythonUpdatePolicy', () => {
  it('is the defaults for no value: the newest 3.13 security release as the floor, latest, and no restart', () => {
    for (const v of [undefined, null, [], 'latest', 3]) expect(parsePythonUpdatePolicy(v)).toEqual(DEFAULT_PYTHON_UPDATE_POLICY);
    expect(DEFAULT_PYTHON_UPDATE_POLICY).toEqual({ mode: 'off', floor: '3.13.18', target: 'latest', restart: 'none', drainSec: 600, forceAfterHours: 24 });
  });

  it('takes x.y.z and latest, never anything a shell or a URL would read', () => {
    expect(parsePythonUpdatePolicy({ floor: '3.13.16', target: '3.13.17', restart: 'idle' })).toMatchObject({ floor: '3.13.16', target: '3.13.17', restart: 'idle' });
    for (const bad of ['stable', '3.13', '3.13.18rc1', '3.13.18; rm -rf /', '../3.13.18', '$(id)']) {
      expect(parsePythonUpdatePolicy({ floor: bad, target: bad })).toMatchObject({ floor: '3.13.18', target: 'latest' });
    }
  });
});
