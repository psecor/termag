// A new box's disk (backend services/boxDiskSize.ts): what the New box disk
// fields show and send, and how a box's disk reads where its size does. The
// server decides the disk (the one asked for, else the repositories'
// .termag/environment.json resources.diskGiB, else 120) and checks the range;
// GET /api/instances/sizes `disk` says the range and what a box for the picked
// repository gets, so nothing here is a second copy of that order.

export interface BoxDiskOptions {
  minGiB: number;
  maxGiB: number;
  /** What a box gets with nothing asked for: also every warm-pool box's disk. */
  defaultGiB: number;
  /** What a box for the repositories asked about gets, which the field preselects. */
  diskGiB: number;
}

/** What the field shows: what the person typed, else the server's answer for the repository. */
export function diskShown(disk: BoxDiskOptions, typed: string | null): string {
  return typed ?? String(disk.diskGiB);
}

function typedValue(disk: BoxDiskOptions, typed: string): number | null {
  const text = typed.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value >= disk.minGiB && value <= disk.maxGiB ? value : null;
}

/** The diskGiB to create with: only what the person typed, so with nothing typed the server's order applies. */
export function diskToSend(disk: BoxDiskOptions | null, typed: string | null): number | undefined {
  if (!disk || typed === null) return undefined;
  return typedValue(disk, typed) ?? undefined;
}

/** Why the create can't go ahead with what was typed; null when it can. */
export function diskInputError(disk: BoxDiskOptions | null, typed: string | null): string | null {
  if (!disk || typed === null || typedValue(disk, typed) !== null) return null;
  return `A whole number of GB from ${disk.minGiB} to ${disk.maxGiB}`;
}

/**
 * Every warm-pool box has the default disk, so another disk launches cold.
 * Said only when that is slower than what the person would get otherwise: a
 * ready box is waiting.
 */
export function diskNote(disk: BoxDiskOptions | null, typed: string | null, warmBoxReady: boolean): string | null {
  if (!disk || !warmBoxReady) return null;
  const value = typed === null ? disk.diskGiB : typedValue(disk, typed);
  if (value === null || value === disk.defaultGiB) return null;
  return `A ${value} GB disk means launching a new box, a few minutes; the ready ones have ${disk.defaultGiB} GB.`;
}

/** "200 GB disk"; null for a box from before disks were recorded, and external boxes. */
export function boxDiskLabel(diskGiB: number | null | undefined): string | null {
  return diskGiB ? `${diskGiB} GB disk` : null;
}
