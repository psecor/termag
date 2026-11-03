/**
 * A new box's disk: the root volume's size in GiB, chosen when the box is
 * made (docs/box-provisioning.md, "Disk size"). No flag gates it.
 *
 * A whole number from 50 to 300, in this order (decideBoxDisk): the one asked
 * for (`--disk`, the New box disk field); else the repositories'
 * `.termag/environment.json` `resources.diskGiB`, the largest across a
 * multi-repo project's (services/repoEnvironment.ts reads it); else the
 * default, BOX_ROOT_VOLUME_GB (120). The launch never goes under the box
 * image's own snapshot, which EC2 refuses (boxProvisioner.amiWithDisk), and
 * hibernation adds the RAM on top (planHibernation).
 *
 * Warm-pool boxes all have the default disk, so a box asked for at any other
 * size launches cold. A box's disk only grows after that, through the admin
 * Fleet tab's Grow disk (services/boxDisk.ts); EBS volumes never shrink.
 */
import type { RepoBoxSizes } from './boxSize';

export const BOX_DISK_LIMITS = { minGiB: 50, maxGiB: 300 } as const;
const FALLBACK_DEFAULT_GIB = 120;

export const DISK_ERROR = `diskGiB must be a whole number of GB from ${BOX_DISK_LIMITS.minGiB} to ${BOX_DISK_LIMITS.maxGiB}`;

export function isDiskGiB(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= BOX_DISK_LIMITS.minGiB && value <= BOX_DISK_LIMITS.maxGiB;
}

/** The disk a box gets when nothing asks for another: BOX_ROOT_VOLUME_GB, the floor every launch used before disks were chosen. */
export function defaultDiskGiB(env: NodeJS.ProcessEnv = process.env): number {
  const configured = parseInt(env.BOX_ROOT_VOLUME_GB ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : FALLBACK_DEFAULT_GIB;
}

/**
 * The minimal flavor's (`--minimal` box's) fallback disk: BOX_MINIMAL_ROOT_VOLUME_GB,
 * default 60 — the box-min bake's root size (packer/box-min.pkr.hcl). Used by
 * routes/instances.ts wherever the flavor goes through the same decision chain
 * as a full box, so an explicit `--disk` or a repo's environment.json still
 * wins, and the launch never goes under the image's own snapshot (amiWithDisk).
 * A smaller BOX_ROOT_VOLUME_GB clamps the default down; an invalid value
 * degrades to the 60 default like defaultDiskGiB does.
 */
export function minimalDefaultDiskGiB(env: NodeJS.ProcessEnv = process.env): number {
  const configured = parseInt(env.BOX_MINIMAL_ROOT_VOLUME_GB ?? '', 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  const root = parseInt(env.BOX_ROOT_VOLUME_GB ?? '', 10);
  return Number.isFinite(root) && root > 0 && root < 60 ? root : 60;
}

export type DiskSource = 'explicit' | 'repo' | 'default';

export type DiskDecision =
  | { ok: true; diskGiB: number; source: DiskSource }
  | { ok: false; status: 400; code: 'invalid_disk'; error: string };

/**
 * The disk a new box launches with. `requested` is the request's `diskGiB`
 * as sent (undefined or null when it had none); `repo` what the repositories
 * the box is made for ask for; `fallback` the default. Pure.
 */
export function decideBoxDisk(requested: unknown, repo: RepoBoxSizes | null, fallback: number): DiskDecision {
  if (requested !== undefined && requested !== null) {
    if (!isDiskGiB(requested)) return { ok: false, status: 400, code: 'invalid_disk', error: DISK_ERROR };
    return { ok: true, diskGiB: requested, source: 'explicit' };
  }
  if (repo?.diskGiB != null) return { ok: true, diskGiB: repo.diskGiB, source: 'repo' };
  return { ok: true, diskGiB: fallback, source: 'default' };
}

/** The largest disk several repositories ask for (a multi-repo project's); null when none asks. */
export function largestDiskGiB(disks: ReadonlyArray<number | null | undefined>): number | null {
  const asked = disks.filter((d): d is number => d != null);
  return asked.length ? Math.max(...asked) : null;
}

/** What the New box disk fields show (GET /api/instances/sizes `disk`). */
export interface BoxDiskOptions {
  minGiB: number;
  maxGiB: number;
  /** What a box gets with nothing asked for and no repo file: the warm pool's size. */
  defaultGiB: number;
  /** What a box made for the repositories asked about gets: their file's, else the default. The field preselects it. */
  diskGiB: number;
}

export function diskOptions(fallback: number, repo: RepoBoxSizes | null): BoxDiskOptions {
  const decided = decideBoxDisk(undefined, repo, fallback);
  return { ...BOX_DISK_LIMITS, defaultGiB: fallback, diskGiB: decided.ok ? decided.diskGiB : fallback };
}
