import { describe, expect, it } from 'vitest';
import { DEFAULT_DEVIN_UPDATE_POLICY, parseDevinUpdatePolicy } from './devinUpdatePolicy';

describe('parseDevinUpdatePolicy', () => {
  it('is the defaults for no value: the fleet\'s oldest version as the floor (no advisory gives one), latest, and no restart', () => {
    for (const v of [undefined, null, [], 'latest', 3]) expect(parseDevinUpdatePolicy(v)).toEqual(DEFAULT_DEVIN_UPDATE_POLICY);
    expect(DEFAULT_DEVIN_UPDATE_POLICY).toEqual({ mode: 'off', floor: '3000.11.92', target: 'latest', restart: 'none', drainSec: 600, forceAfterHours: 24 });
  });

  it('takes x.y.z versions and latest, nothing else', () => {
    expect(parseDevinUpdatePolicy({ floor: '3000.11.200', target: '3000.11.234', restart: 'idle' })).toMatchObject({ floor: '3000.11.200', target: '3000.11.234', restart: 'idle' });
    for (const bad of ['stable', '3000.11', '2026.10.22-27dcf5f', '3000.11.234; rm -rf ~']) expect(parseDevinUpdatePolicy({ floor: bad, target: bad })).toMatchObject({ floor: '3000.11.92', target: 'latest' });
  });
});
