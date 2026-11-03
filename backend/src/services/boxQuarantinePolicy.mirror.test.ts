import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { QUARANTINE_REASON_MAX, QUARANTINE_STEPS, STEP_LABELS } from './boxQuarantinePolicy';

// frontend/src/utils/boxQuarantine.ts copies the step labels, their order and
// the reason cap by hand. Its quarantineNeedsRetry counts the labels to tell a
// finished run from a short one, and its dialog caps the reason, so a drift
// shows as a Retry that never goes away or a reason the route refuses.
const frontend = readFileSync(resolve(__dirname, '../../../frontend/src/utils/boxQuarantine.ts'), 'utf8');

describe('frontend/src/utils/boxQuarantine.ts mirrors boxQuarantinePolicy', () => {
  it('lists every step with the same label, in the order the steps run', () => {
    const block = frontend.match(/QUARANTINE_STEP_LABELS[^=]*=\s*\[([\s\S]*?)\n\];/)?.[1] ?? '';
    const pairs = [...block.matchAll(/\['([a-z]+)',\s*'([^']*)'\]/g)].map(m => [m[1], m[2]]);
    expect(pairs).toEqual(QUARANTINE_STEPS.map(s => [s, STEP_LABELS[s]]));
  });

  it('caps the reason where the route does', () => {
    expect(frontend).toMatch(new RegExp(`export const QUARANTINE_REASON_MAX = ${QUARANTINE_REASON_MAX};`));
  });
});
