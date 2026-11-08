import type { SoftwareUpdateRun } from '../services/adminApi';

/** The triggers the orchestrator's own sweep starts (backend services/toolUpdate/autoRuns.ts), with nobody pressing a button. */
const AUTOMATIC: Partial<Record<SoftwareUpdateRun['trigger'], string>> = { floor: 'floor breach', resume: 'resume', nightly: 'nightly' };
const BOX_SIDE: Partial<Record<SoftwareUpdateRun['trigger'], string>> = { boot: 'boot', guard: 'runner guard' };

export const isAutomaticRun = (r: Pick<SoftwareUpdateRun, 'trigger'>): boolean => r.trigger in AUTOMATIC;

/** The runs list's trigger cell: `auto · floor breach` for an automatic run, the box's own trigger, or `manual`. */
export function triggerText(r: Pick<SoftwareUpdateRun, 'trigger'>): string {
  const auto = AUTOMATIC[r.trigger];
  if (auto) return `auto · ${auto}`;
  return BOX_SIDE[r.trigger] ?? r.trigger;
}
