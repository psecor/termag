import { describe, expect, it } from 'vitest';
import { ownerBoxCosts } from './owner';
import type { BoxRates } from './rates';

const rates: BoxRates = { source: 'test', perHour: { 'm9g.2xlarge': 0.16 }, perVcpuHour: 0.02, gp3PerGbMonth: 0 };
const hour = (instanceId: string, sec: { activeSec?: number; idleSec?: number; bootSec?: number }) => ({
  instanceId, instanceType: 'm9g.2xlarge', activeSec: 0, idleSec: 0, bootSec: 0, storageGbSec: 0, ...sec,
});

describe('ownerBoxCosts', () => {
  it("prices each box's owned hours today, with its idle share and its rate now", () => {
    const [devbox] = ownerBoxCosts(
      [{ id: 'devbox', instanceType: 'm9g.2xlarge' }],
      [hour('devbox', { activeSec: 3600 }), hour('devbox', { idleSec: 3600 }), hour('other', { activeSec: 3600 })],
      rates,
    );
    expect(devbox).toEqual({ id: 'devbox', todayUsd: 0.32, runningHours: 2, idleShare: 0.5, perHourUsd: 0.16 });
  });

  it('gives a box with no hours today its rate, and no idle share', () => {
    expect(ownerBoxCosts([{ id: 'parked', instanceType: 'm9g.4xlarge' }], [], rates)).toEqual([
      { id: 'parked', todayUsd: 0, runningHours: 0, idleShare: null, perHourUsd: 0.32 },
    ]);
  });

  it('has no rate for a box whose type is unknown', () => {
    expect(ownerBoxCosts([{ id: 'odd', instanceType: null }], [], rates)[0]?.perHourUsd).toBeNull();
  });
});
