// Boxes a project can be created on now or shortly: ready, or on their way
// there. Shared by the Welcome wizard and the phone's New project form so
// the two never drift.
import type { Instance } from '../types';

export const USABLE_BOX_STATUSES: ReadonlyArray<Instance['status']> = ['ready', 'provisioning', 'awaiting-agent', 'warming', 'warm', 'starting'];

export function usableBoxes(boxes: Instance[]): Instance[] {
  return boxes.filter(b => USABLE_BOX_STATUSES.includes(b.status));
}
