// Resizing a box (backend services/boxResize.ts): what the Size… dialogs in
// both UIs and the Fleet tab show. The server decides everything (who may,
// what blocks it, which type); this is how its answers read.
import type { Instance } from '../types';
import { sizeName, sizeOptionLabel, type BoxSize, type BoxSizeChoice } from './boxSize';
import type { BoxDiskOptions } from './boxDisk';

/** `disk`: the resize waits for the box's disk to grow before it stops the box (the dialog asked for both). */
export type ResizePhase = 'disk' | 'resuming' | 'stopping' | 'resizing' | 'starting' | 'ready' | 'stopped' | 'failed';

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
  /** The owner's routes only (backend services/boxDisk.ts diskView); absent from the Fleet tab's and older orchestrators. */
  disk?: DiskView | null;
}

/** A disk grow (backend boxDisk.ts growView). */
export interface GrowView {
  fromGb: number;
  toGb: number;
  /** modifying: EBS is growing the volume · filesystem: the box's agent grows the file system · done · failed */
  state: 'modifying' | 'filesystem' | 'done' | 'failed';
  running: boolean;
  detail: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** The box's disk in the owner's Resize box dialogs. */
export interface DiskView {
  sizeGb: number | null;
  maxGb: number;
  /** Why it can't grow now (stopped, EBS's six hours, already at the cap); null when it can. */
  refusal: string | null;
  grow: GrowView | null;
  /** The last grow reached the volume's size but not its file system: the same size again finishes it (absent from older orchestrators). */
  retry?: { sizeGb: number; error: string | null } | null;
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
  disk: 'Waiting for the disk to grow',
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
 * The progress list: waiting for the disk first when it grows in the same go (`withDisk`), then stopping, resizing, starting, ready for a box that was
 * running (resuming first for a hibernated one; a box that was down ends at
 * stopped). `fromStatus` is the box's status when the resize was asked for.
 */
export function resizeSteps(view: ResizeView, fromStatus: string, withDisk = false): ResizeStep[] {
  const base: ResizePhase[] = fromStatus === 'stopped'
    ? ['resizing', 'stopped']
    : fromStatus === 'hibernated' ? ['resuming', 'stopping', 'resizing', 'stopped'] : ['stopping', 'resizing', 'starting', 'ready'];
  // A resize asked for with a disk grow waits for it first (backend boxResize.ts).
  const order: ResizePhase[] = withDisk || view.phase === 'disk' ? ['disk', ...base] : base;
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

// ── The disk, beside the size (backend services/boxDisk.ts) ────────────────

export const DISK_GROW_NOTE = "Growing the disk doesn't stop the box. A disk never shrinks, and EBS allows one change to it every six hours.";

/** "120 GB disk", beside the current size; null when the disk isn't known. */
export function currentDiskLabel(disk: DiskView | null | undefined): string | null {
  return disk?.sizeGb ? `${disk.sizeGb} GB disk` : null;
}

/** The disk field's range (utils/boxDisk.ts): from the current disk (grow only) to the server's cap; null when the disk isn't known. */
export function growFieldOptions(disk: DiskView | null | undefined): BoxDiskOptions | null {
  if (!disk?.sizeGb) return null;
  return { minGiB: disk.sizeGb, maxGiB: Math.max(disk.maxGb, disk.sizeGb), defaultGiB: disk.sizeGb, diskGiB: disk.sizeGb };
}

/**
 * The dialogs' one warning for what is about to change: the downtime notice
 * only when the instance type changes (a disk grows with the box up), the
 * disk's own note when only it does, nothing when nothing does.
 */
export function changeWarning(status: string, changes: { size: boolean; disk: boolean }, losesHibernation = false): string | null {
  if (changes.size) {
    const sized = resizeWarning(status, losesHibernation);
    return changes.disk ? `${sized} The disk grows first, with the box up; a disk never shrinks, and EBS allows one change to it every six hours.` : sized;
  }
  return changes.disk ? DISK_GROW_NOTE : null;
}

export interface GrowStep {
  state: 'done' | 'current' | 'todo';
  label: string;
  key: 'modifying' | 'filesystem';
}

/** The grow's progress list, drawn like the resize's: EBS grows the volume, then the agent the file system. */
export function growSteps(grow: GrowView): GrowStep[] {
  const order = ['modifying', 'filesystem'] as const;
  const at = grow.state === 'done' ? order.length : grow.state === 'failed' ? -1 : order.indexOf(grow.state);
  return order.map((key, i) => ({
    key,
    label: key === 'modifying' ? `Growing the disk to ${grow.toGb} GB` : 'Growing its file system',
    state: i < at ? 'done' : i === at ? 'current' : 'todo',
  }));
}

/** How a finished grow reads, or null while it runs. */
export function growOutcome(grow: GrowView): string | null {
  if (grow.running) return null;
  if (grow.state === 'failed') return `The disk grow failed: ${grow.detail ?? 'no reason given'}`;
  return `The disk is now ${grow.toGb} GB.`;
}

/** What the dialogs say beside "Finish growing the disk" (DiskView.retry). */
export function retryNote(retry: { sizeGb: number; error: string | null }): string {
  return `The disk is ${retry.sizeGb} GB, but its file system was not grown into it${retry.error ? `: ${retry.error}` : ''}.`;
}
