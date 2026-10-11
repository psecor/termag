// Pure helpers for the phone's New project form.
import type { Instance } from '../types';
import { usableBoxes } from '../utils/usableBoxes';

export { USABLE_BOX_STATUSES, usableBoxes } from '../utils/usableBoxes';

/** The box to preselect: a ready one, preferring the fewest projects, else the first usable one. */
export function pickDefaultBox(boxes: Instance[]): Instance | null {
  const usable = usableBoxes(boxes);
  const ready = usable.filter(b => b.status === 'ready').sort((a, b) => (a._count?.projects ?? 0) - (b._count?.projects ?? 0));
  return ready[0] ?? usable[0] ?? null;
}

export function boxLabel(b: Instance): string {
  const n = b._count?.projects;
  return `${b.name} · ${b.status.replace(/-/g, ' ')}${n != null ? ` · ${n} project${n === 1 ? '' : 's'}` : ''}`;
}
