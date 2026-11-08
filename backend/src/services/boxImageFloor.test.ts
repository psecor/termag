import { beforeEach, describe, expect, it } from 'vitest';
import { applyImageFloor, knownImageFloorGiB, recordImageFloor, resetImageFloorsForTests } from './boxImageFloor';

describe('boxImageFloor', () => {
  beforeEach(() => resetImageFloorsForTests());

  it('remembers each image component\'s last floor, and nothing until one is recorded', () => {
    expect(knownImageFloorGiB('box')).toBeNull();
    recordImageFloor('box', 120);
    recordImageFloor('box-min', 60);
    recordImageFloor('box', 0);
    expect([knownImageFloorGiB('box'), knownImageFloorGiB('box-min')]).toEqual([120, 60]);
  });

  it('raises a disk under the floor, and notes a disk asked for or raised', () => {
    expect(applyImageFloor(50, 120, true)).toEqual({ diskGiB: 120, note: { requestedGiB: 50, diskGiB: 120, raised: true, floorKnown: true } });
    expect(applyImageFloor(200, 120, true)).toEqual({ diskGiB: 200, note: { requestedGiB: 200, diskGiB: 200, raised: false, floorKnown: true } });
    expect(applyImageFloor(50, null, true)).toEqual({ diskGiB: 50, note: { requestedGiB: 50, diskGiB: 50, raised: false, floorKnown: false } });
    expect(applyImageFloor(60, 120, false)).toEqual({ diskGiB: 120, note: { requestedGiB: 60, diskGiB: 120, raised: true, floorKnown: true } });
    expect(applyImageFloor(120, 120, false)).toEqual({ diskGiB: 120, note: null });
  });
});
