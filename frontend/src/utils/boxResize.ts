// Resizing a box (backend services/boxResize.ts): what the Size… dialogs in
// both UIs and the Fleet tab show. The server decides everything (who may,
// what blocks it, which type); this is how its answers read.
import type { Instance } from '../types';
import { sizeName, sizeOptionLabel, type BoxSize, type BoxSizeChoice } from './boxSize';

export type ResizePhase = 'resuming' | 'stopping' | 'resizing' | 'starting' | 'ready' | 'stopped' | 'failed';

/** The box's current or last resize (backend boxResizePolicy.resizeView). */
export interface ResizeView {
  to: string | null;
  from: string | null;
  /** The box's status when asked (ready, stopped, hibernated): which steps it takes. Null from an older orchestrator. */
  fromStatus?: string | null;
  phase: ResizePhase | null;
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  byAdmin: boolean;
  reason: string | null;
}

export interface ResizeBlocker {
  check: string;
  reason: string;
  /** A turn and the like may be stopped on purpose; a claim or a box update may not. */
  forceable: boolean;
}

/** GET /api/instances/:id/resize (and the Fleet tab's): the sizes, the resize, and what would block one now. */
export interface BoxResizeInfo {
  box: { id: string; name: string; status: string; size: string | null; instanceType: string | null; hibernationConfigured: boolean };
  sizes: BoxSizeChoice[];
  resize: ResizeView | null;
  refusal: { status: number; code: string; error: string } | null;
  blockers: ResizeBlocker[];
}

export const RESIZE_DOWNTIME = "The box stops for two to three minutes while it's resized. "
  + 'Anything running on it stops too: agent turns, terminals, dev servers.';

const LOSES_HIBERNATION = ' At the larger size it can no longer hibernate, so it stops instead from then on.';

/**
 * The dialogs' one warning, which is also the confirmation: Resize goes
 * ahead (with `force`) whatever is running on the box, so there is no second
 * notice. A box that is down stays down; `losesHibernation` adds one sentence.
 */
export function resizeWarning(status: string, losesHibernation = false): string {
  const tail = losesHibernation ? LOSES_HIBERNATION : '';
  if (status === 'stopped') return `It is stopped, and stays stopped: the next start runs at the new size.${tail}`;
  if (status === 'hibernated') {
    return `It is hibernated, so it is resumed first, then stopped and resized. What it held in memory is not kept, and it stays stopped.${tail}`;
  }
  return RESIZE_DOWNTIME + tail;
}

/**
 * A box's current size under the Resize box menu items, in the wording the
 * person asked for ("Medium: 4 vCPU 16GB RAM"; the dropdown options keep
 * "Medium · 4 vCPU, 16 GB RAM"), from the server's size table; the size's name
 * alone before the table has loaded; a custom or unsized box's AWS type
 * (r8g.xlarge).
 */
export function currentSizeLabel(box: Pick<Instance, 'size' | 'instanceType'>, sizes: BoxSizeChoice[] | null): string {
  const choice = box.size ? sizes?.find(s => s.size === box.size) : undefined;
  if (choice) return `${sizeName(choice.size)}: ${choice.vcpus} vCPU ${choice.memoryGiB}GB RAM`;
  if (box.size && ['small', 'medium', 'large'].includes(box.size)) return sizeName(box.size);
  return box.instanceType ?? box.size ?? 'Size not recorded';
}

const PHASE_LABEL: Record<ResizePhase, string> = {
  resuming: 'Resuming it from hibernation',
  stopping: 'Stopping',
  resizing: 'Changing its instance type',
  starting: 'Starting, waiting for its agent',
  ready: 'Running at the new size',
  stopped: 'Resized, and left stopped',
  failed: 'Resize failed',
};

export function phaseLabel(phase: ResizePhase | null | undefined): string {
  return phase ? PHASE_LABEL[phase] ?? phase : 'Resizing';
}

export interface ResizeStep {
  phase: ResizePhase;
  label: string;
  state: 'done' | 'current' | 'todo';
}

/**
 * The progress list: stopping, resizing, starting, ready for a box that was
 * running (resuming first for a hibernated one; a box that was down ends at
 * stopped). `fromStatus` is the box's status when the resize was asked for.
 */
export function resizeSteps(view: ResizeView, fromStatus: string): ResizeStep[] {
  const order: ResizePhase[] = fromStatus === 'stopped'
    ? ['resizing', 'stopped']
    : fromStatus === 'hibernated' ? ['resuming', 'stopping', 'resizing', 'stopped'] : ['stopping', 'resizing', 'starting', 'ready'];
  const at = view.phase === 'failed' ? -1 : order.indexOf(view.phase ?? order[0]);
  const finished = !view.running && view.phase !== 'failed';
  return order.map((phase, i) => ({
    phase,
    label: PHASE_LABEL[phase],
    state: finished || i < at ? 'done' : i === at ? 'current' : 'todo',
  }));
}

/**
 * The status a running resize started from, for its steps: the server's
 * record, else (an older orchestrator) a guess from the phase. The live
 * status says nothing: a running box is `stopped` while it is retyped, and a
 * hibernated one `ready` and then `stopping` on its way down.
 */
export function resizeFromStatus(view: ResizeView, liveStatus: string): string {
  if (view.fromStatus) return view.fromStatus;
  if (view.phase === 'resuming') return 'hibernated';
  if (view.phase === 'stopping' || view.phase === 'starting') return 'ready';
  return liveStatus === 'stopped' ? 'stopped' : 'ready';
}

/** Whether the list row says a resize holds the box: the server's own reading of its open box_events row. */
export function rowResizing(box: Pick<Instance, 'resize'>): boolean {
  return !!box.resize?.running;
}

/** The Boxes list's line for a box being resized ("resizing to large: stopping"), or null. */
export function resizeBadge(box: Pick<Instance, 'resize'>): string | null {
  const r = box.resize;
  if (!r?.running) return null;
  return `resizing${r.to ? ` to ${r.to}` : ''}: ${phaseLabel(r.phase).toLowerCase()}`;
}

/** The size choice's label, the current one marked: "Medium · 4 vCPU, 16 GB RAM (current)". */
export function resizeOptionLabel(choice: BoxSizeChoice, current: string | null): string {
  return `${sizeOptionLabel(choice)}${choice.size === current ? ' (current)' : ''}`;
}

/** The size the dialog preselects: the next one up from the current, or the largest; small for a box with none. */
export function defaultResizeTarget(current: string | null, sizes: BoxSizeChoice[]): BoxSize {
  const order = sizes.map(s => s.size);
  const i = current ? order.indexOf(current as BoxSize) : -1;
  if (i < 0) return order[0] ?? 'small';
  return order[i + 1] ?? order[i - 1] ?? order[i];
}

/** How a finished resize reads: the new size, or why it failed. */
export function resizeOutcome(view: ResizeView, sizes: BoxSizeChoice[]): string | null {
  if (view.running) return null;
  if (view.phase === 'failed') return `The resize failed: ${view.error ?? 'no reason given'}`;
  const choice = sizes.find(s => s.size === view.to);
  const label = choice ? sizeOptionLabel(choice) : view.to ? sizeName(view.to) : 'the new size';
  return view.phase === 'stopped' ? `Now ${label}, and stopped.` : `Now ${label}, and running.`;
}

/** Whether a type with more RAM costs this box hibernation (backend boxResizePolicy.keepsHibernation). */
export function losesHibernation(info: BoxResizeInfo, to: string): boolean {
  if (!info.box.hibernationConfigured) return false;
  const from = info.sizes.find(s => s.size === info.box.size);
  const target = info.sizes.find(s => s.size === to);
  return !from || !target || target.memoryGiB > from.memoryGiB;
}

/** A 409 box_busy's body, from an axios error, or null for any other failure. */
export function busyRefusal(err: unknown): { error: string; blockers: ResizeBlocker[]; forceable: boolean } | null {
  const data = (err as { response?: { status?: number; data?: Record<string, unknown> } })?.response?.data;
  if (!data || data.code !== 'box_busy') return null;
  return {
    error: typeof data.error === 'string' ? data.error : 'The box is busy',
    blockers: Array.isArray(data.blockers) ? data.blockers as ResizeBlocker[] : [],
    forceable: data.forceable === true,
  };
}

/** The server's error message, or a fallback. */
export function resizeError(err: unknown, fallback = 'Could not resize the box'): string {
  const msg = (err as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  return typeof msg === 'string' && msg ? msg : err instanceof Error && err.message ? err.message : fallback;
}

/** Whether a box's menu offers Size…: an EC2 box termag runs that is up or down (not on its way), or one being resized. */
export function offersResize(box: Pick<Instance, 'kind' | 'status' | 'ec2InstanceId' | 'resize'>): boolean {
  if (box.kind !== 'ec2' || !box.ec2InstanceId) return false;
  return rowResizing(box) || ['ready', 'stopped', 'hibernated'].includes(box.status);
}
