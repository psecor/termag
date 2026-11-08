/**
 * The smallest root disk each box image can launch at, as last discovered:
 * the image's own root snapshot, which EC2 refuses to go under
 * (boxProvisioner.amiWithDisk). Kept here so a create can say, before the
 * launch looks the image up again, that a disk asked for below it will be
 * raised (routes/instances.ts, the 201's `disk`).
 *
 * In memory and per process: recorded by every discoverLatestAmi (each
 * launch, the warm pool's spec), so it is unknown only until this process
 * first looks an image up. A pinned or channel box-image (boxImage.ts) has
 * no entry: its image is only known at launch.
 */
export type ImageComponent = 'box' | 'box-min';

const floors = new Map<ImageComponent, number>();

export function recordImageFloor(component: ImageComponent, gib: number): void {
  if (Number.isFinite(gib) && gib > 0) floors.set(component, gib);
}

/** The component's last-seen floor in GiB; null when not looked up yet. */
export function knownImageFloorGiB(component: ImageComponent): number | null {
  return floors.get(component) ?? null;
}

export function resetImageFloorsForTests(): void {
  floors.clear();
}

/**
 * What the create says about a disk asked for (`--disk`) or raised: the
 * disk the box will get, the image's floor applied when it is known.
 * `floorKnown: false` means the launch may still raise it.
 */
export interface DiskNote {
  requestedGiB: number;
  diskGiB: number;
  raised: boolean;
  floorKnown: boolean;
}

/**
 * The disk a box launches with given its image's floor (null: unknown), and
 * the create's note when one is owed: the disk was asked for, or raised.
 * Pure.
 */
export function applyImageFloor(diskGiB: number, floor: number | null, asked: boolean): { diskGiB: number; note: DiskNote | null } {
  const raised = floor != null && floor > diskGiB;
  const effective = raised ? floor : diskGiB;
  const note = asked || raised ? { requestedGiB: diskGiB, diskGiB: effective, raised, floorKnown: floor != null } : null;
  return { diskGiB: effective, note };
}
