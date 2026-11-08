import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PI_UPDATE_POLICY, PI_PINNED_LATEST, parsePiUpdatePolicy } from './piUpdatePolicy';
import { isClaudeVersion } from './claudeUpdatePolicy';

describe('PI_PINNED_LATEST', () => {
  // The box resolves latest to its recipe's newest pin; the Software tab compares with this, as Cursor's (#1080).
  it('is the newest version deploy/termag-pi-update pins', () => {
    const recipe = readFileSync(join(__dirname, '../../../deploy/termag-pi-update'), 'utf8');
    const block = /^PINS='([^']*)'$/m.exec(recipe)?.[1] ?? '';
    const pins = block.split('\n').map(l => l.trim().split(/\s+/)).filter(f => f.length === 2 && isClaudeVersion(f[0]) && /^sha512-[A-Za-z0-9+/]{86}==$/.test(f[1])).map(f => f[0]);
    expect(pins.length).toBeGreaterThan(0);
    const num = (v: string) => v.split('.').map(Number);
    const newest = [...pins].sort((a, b) => { const x = num(a), y = num(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }).at(-1);
    expect(newest).toBe(PI_PINNED_LATEST);
    // The image's pin stays, for a put-back.
    expect(pins).toContain('1.0.2');
  });
});

describe('parsePiUpdatePolicy', () => {
  it('is the defaults for no value: the advisories\' floor, latest, and no restart', () => {
    for (const v of [undefined, null, [], 'latest', 3]) expect(parsePiUpdatePolicy(v)).toEqual(DEFAULT_PI_UPDATE_POLICY);
    expect(DEFAULT_PI_UPDATE_POLICY).toEqual({ mode: 'off', floor: '0.79.0', target: 'latest', restart: 'none', drainSec: 600, forceAfterHours: 24 });
  });

  it('takes x.y.z and latest, never another dist-tag', () => {
    expect(parsePiUpdatePolicy({ floor: '1.0.2', target: '1.4.0', restart: 'idle' })).toMatchObject({ floor: '1.0.2', target: '1.4.0', restart: 'idle' });
    for (const bad of ['legacy-node20', 'stable', '1.4', '1.4.0; rm -rf ~']) expect(parsePiUpdatePolicy({ floor: bad, target: bad })).toMatchObject({ floor: '0.79.0', target: 'latest' });
  });
});
