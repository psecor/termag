import type { Instance } from '../types';

// termag setup on or off for a box. With it off, termag
// runs, updates and parks the box and delivers nothing else there; the
// server refuses what needs what it leaves out with code setup_disabled
// (backend services/boxSetup.ts). Nothing in the UI turns it on or off: that
// is the CLI's, the API's and the repository's environment.json. A control
// that is off there says SETUP_OFF_TOOLTIP.

/** True only for a box stored with setup off; a box from before the field, or with it absent, has setup on. */
export function isSetupOff(box: Pick<Instance, 'setupEnabled'> | null | undefined): boolean {
  return box?.setupEnabled === false;
}

/** A control that is off on a box with termag setup off says only this, in its disabled tooltip. */
export const SETUP_OFF_TOOLTIP = 'termag setup is off on this box';
