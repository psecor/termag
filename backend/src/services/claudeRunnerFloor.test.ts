import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boolVariation, jsonVariation } from './featureFlags';
import { runnerFloors } from './claudeRunnerFloor';

vi.mock('../db', () => ({
  prisma: { hostSoftware: { findMany: vi.fn(async () => [{ hostKey: 'box-v3', version: '2.1.290', ok: true }, { hostKey: 'box-v2', version: '2.1.290', ok: true }]) } },
}));
// boolVariation is there only to show it is never called: no on/off flag is read.
vi.mock('./featureFlags', () => ({ boolVariation: vi.fn(async () => true), jsonVariation: vi.fn() }));
vi.mock('./toolUpdate/runs', () => ({ requestFloorRun: vi.fn() }));

const ada = { id: 'u1', unixUsername: 'ada' } as never;
// Both below the floor 2.1.308: one wrapper enforces it itself (v3), one cannot.
const boxes = [{ id: 'box-v3', name: 'v3', kind: 'ec2', wrapperFloor: true }, { id: 'box-v2', name: 'v2', kind: 'ec2', wrapperFloor: false }];
// What Claude Code's on/off flag off gave before #1410, and what mode off has given since: the v3 wrapper keeps the floor, nothing is refused.
const OFF = { 'box-v3': { kind: 'pass', floor: '2.1.308' }, 'box-v2': { kind: 'ok' } };

describe('runnerFloors: mode off keeps the floor, as the on/off flag off did (Devin on #1410)', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

  it('off: a v3 wrapper still keeps the floor, and nothing is refused', async () => {
    vi.mocked(jsonVariation).mockResolvedValue({ mode: 'off', floor: '2.1.308' });
    expect(Object.fromEntries(await runnerFloors(ada, boxes))).toEqual(OFF);
    expect(boolVariation).not.toHaveBeenCalled();
  });

  it('missing, malformed, or the flag source down (null, the code\'s floor): the same as off', async () => {
    for (const value of [{ floor: '2.1.308' }, { mode: 'sometimes', floor: '2.1.308' }, null]) {
      vi.mocked(jsonVariation).mockResolvedValue(value);
      expect(Object.fromEntries(await runnerFloors(ada, boxes))).toEqual(OFF);
    }
    expect(boolVariation).not.toHaveBeenCalled();
  });

  it('manual or auto: the box that cannot enforce is too old', async () => {
    for (const mode of ['manual', 'auto']) {
      vi.mocked(jsonVariation).mockResolvedValue({ mode, floor: '2.1.308' });
      const floors = await runnerFloors(ada, boxes);
      expect(floors.get('box-v2')).toEqual({ kind: 'too-old', installed: '2.1.290', floor: '2.1.308' });
      expect(floors.get('box-v3')).toEqual({ kind: 'pass', floor: '2.1.308' });
    }
    expect(boolVariation).not.toHaveBeenCalled();
  });
});
