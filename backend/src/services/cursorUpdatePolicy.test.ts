import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CURSOR_PINNED_LATEST, DEFAULT_CURSOR_UPDATE_POLICY, isCursorVersion, parseCursorUpdatePolicy } from './cursorUpdatePolicy';
import { DEFAULT_CODEX_UPDATE_POLICY, parseCodexUpdatePolicy } from './codexUpdatePolicy';

describe('CURSOR_PINNED_LATEST', () => {
  // The box resolves latest to its recipe's newest pin; the Software tab compares with this (Bugbot on #1080).
  it('is the newest build deploy/termag-cursor-update pins, for every arch', () => {
    const recipe = readFileSync(join(__dirname, '../../../deploy/termag-cursor-update'), 'utf8');
    const block = /^PINS='([^']*)'$/m.exec(recipe)?.[1] ?? '';
    const pins = block.split('\n').map(l => l.trim().split(/\s+/)).filter(f => f.length === 3 && isCursorVersion(f[0]) && /^[0-9a-f]{64}$/.test(f[2]));
    expect(pins.length).toBeGreaterThan(0);
    const day = (b: string) => b.split('-')[0];
    for (const arch of ['x64', 'arm64']) {
      const builds = pins.filter(f => f[1] === arch).map(f => f[0]).sort((a, b) => day(a).localeCompare(day(b)));
      expect(builds.at(-1), arch).toBe(CURSOR_PINNED_LATEST);
    }
  });
});

describe('parseCursorUpdatePolicy', () => {
  it('is the defaults for no value: the CLI advisories\' floor, latest, and no restart', () => {
    for (const v of [undefined, null, [], 'latest', 3]) expect(parseCursorUpdatePolicy(v)).toEqual(DEFAULT_CURSOR_UPDATE_POLICY);
    expect(DEFAULT_CURSOR_UPDATE_POLICY).toEqual({ floor: '2025.09.17-25b418f', target: 'latest', restart: 'none', drainSec: 600, forceAfterHours: 24 });
  });

  it('takes Cursor\'s build versions, and only those', () => {
    expect(parseCursorUpdatePolicy({ floor: '2026.10.22-27dcf5f', target: '2026.10.22-27dcf5f', restart: 'idle' }))
      .toMatchObject({ floor: '2026.10.22-27dcf5f', target: '2026.10.22-27dcf5f', restart: 'idle' });
    for (const bad of ['2.1.308', '2026.10.22', '2026.10.22-XYZ', '2026.10.22-27dcf5f; rm -rf ~', 'v2026.10.22-27dcf5f', 'stable']) {
      expect(parseCursorUpdatePolicy({ floor: bad, target: bad })).toMatchObject({ floor: '2025.09.17-25b418f', target: 'latest' });
      expect(isCursorVersion(bad)).toBe(false);
    }
  });

  it('leaves Codex\'s parser as it was', () => {
    expect(parseCodexUpdatePolicy(null)).toEqual(DEFAULT_CODEX_UPDATE_POLICY);
    expect(parseCodexUpdatePolicy({ target: '2026.10.22-27dcf5f' }).target).toBe('latest');
  });
});
