import type { Instance, InstanceStatus } from '../types';
import { hibernationAgeNote, showsBoxError } from './boxPower';

/**
 * Which box groups the full UI's Projects list folds away behind "Show
 * stopped (N)" (the `sidebarShowStopped` theme key). Old ask boxes and spikes pile up stopped, since auto-park stops
 * rather than hibernates, and crowd out the running ones. Only the Projects
 * list hides them: the Boxes section, the box pickers, Recents and search
 * still list every box and project.
 *
 * A group is hidden only when its box is down and settled (stopped,
 * hibernated, terminated) and nothing in it wants the person: never the open
 * project's box (the URL's `?project=`, so following a link to a stopped
 * box's project shows it and starts the box), never a box starting or
 * stopping (those statuses aren't hideable), never one showing an error or a
 * warning, or holding unpushed work, and never one with a live cloud session.
 */
export const HIDEABLE_BOX_STATUSES: readonly InstanceStatus[] = ['stopped', 'hibernated', 'terminated'];

type BoxLike = Pick<Instance, 'id' | 'status' | 'provisioningError' | 'hibernatedAt' | 'lifecycle' | 'onClaimStatus'>;

/** Whether a down box shows something to act on: an error, an auto-park warning, the hibernation limit, unpushed work. */
export function boxNeedsAttention(box: BoxLike, now = Date.now()): boolean {
  return showsBoxError(box)
    || box.onClaimStatus === 'failed'
    || !!box.lifecycle?.warning
    || box.lifecycle?.unsavedWork === 'unsaved'
    || hibernationAgeNote(box, now) !== null;
}

export interface StoppedGroupsInput {
  boxes: BoxLike[];
  /** Box id per project in the list (null for "this host" projects). */
  projects: { id: string; instanceId?: string | null }[];
  activeProjectId: string | null;
  /** Box ids with a Claude Code cloud session listed under them. */
  boxesWithCloud?: ReadonlySet<string>;
  now?: number;
}

/** Ids of the boxes whose Projects-list group may be hidden, and how many projects they hold. */
export function stoppedBoxGroups(input: StoppedGroupsInput): { boxIds: Set<string>; projectCount: number } {
  const activeBox = input.activeProjectId
    ? input.projects.find(p => p.id === input.activeProjectId)?.instanceId ?? null
    : null;
  // Only a box with a project in the list has a group to hide.
  const withProjects = new Set(input.projects.map(p => p.instanceId).filter(Boolean));
  const boxIds = new Set<string>();
  for (const b of input.boxes) {
    if (!withProjects.has(b.id)) continue;
    if (!HIDEABLE_BOX_STATUSES.includes(b.status)) continue;
    if (b.id === activeBox) continue;
    if (input.boxesWithCloud?.has(b.id)) continue;
    if (boxNeedsAttention(b, input.now)) continue;
    boxIds.add(b.id);
  }
  const projectCount = input.projects.filter(p => p.instanceId && boxIds.has(p.instanceId)).length;
  return { boxIds, projectCount };
}

/** The toggle's label: what it does next, and how many boxes it is about. */
export function stoppedToggleLabel(shown: boolean, boxCount: number): string {
  return `${shown ? 'Hide' : 'Show'} stopped (${boxCount})`;
}
