/**
 * What a box flavor decides when a box is made (docs/box-provisioning.md,
 * "The minimal flavor"). Flavors are strategies, not forks: each spec owns
 * three decisions the launch reads, so extending image resolution is a new
 * entry here rather than another `minimal`-shaped boolean threading through
 * the route, the provisioner and the disk module.
 *
 *   * which image it launches (`resolveImage`) — a flavor's missing image
 *     fails the launch loudly; no spec ever hands its box another flavor's
 *     image;
 *   * the disk a box defaults to when neither the request nor a repo file
 *     names one (`defaultDiskGiB`, the fallback flavorFor… routes/instances
 *     hands to decideBoxDisk);
 *   * whether it may take a warm-pool box — pool boxes always run the
 *     published full bake (`warmPoolEligible`), so every other flavor goes
 *     cold whatever the owner's flags say;
 *   * whether it reads per-user flags at all (`flagAware`) — the box-image
 *     flag (a pin or a channel) is per-user and chooses among full-bake
 *     images, so the minimal flavor never spends the flag read.
 *
 * Two exist today. 'full' is the published Component=box bake, flag- and
 * channel-aware and claimable, deferring to BOX_ROOT_VOLUME_GB. 'minimal' is
 * the lean Component=box-min bake behind `termag box create --minimal` /
 * `flavor: 'minimal'`, cold and flagless, at BOX_MINIMAL_ROOT_VOLUME_GB's 60.
 * Anything else degrades to 'full', the way every tolerant read of an enum
 * here does.
 */
import type { EC2Client } from '@aws-sdk/client-ec2';
import { resolveBoxImage, resolveMinimalBoxImage, type BoxConfig, type ResolvedBoxImage } from './boxProvisioner';
import { defaultDiskGiB, minimalDefaultDiskGiB } from './boxDiskSize';

export type BoxFlavor = 'full' | 'minimal';

/** Only consumed by flag-aware flavors; the rest resolve from the flavor's own tag. */
export interface FlavorImageInputs {
  ec2: EC2Client;
  cfg: BoxConfig;
  /** The owner's box-image flag selection, as routes/instances reads it. */
  selection: import('./boxImage').BoxImageSelection;
}

export interface BoxFlavorSpec {
  id: BoxFlavor;
  /** Reads the per-user box-image flag; false = selection is ignored at resolve time. */
  flagAware: boolean;
  /** May take a warm-pool claim; pool boxes run the published full bake. */
  warmPoolEligible: boolean;
  /** The box's disk when neither the request nor a repo file names one (boxDiskSize's chain). */
  defaultDiskGiB(env?: NodeJS.ProcessEnv): number;
  /** The image a launch of this flavor uses. */
  resolveImage(inputs: FlavorImageInputs): Promise<ResolvedBoxImage>;
}

export const BOX_FLAVORS: Record<BoxFlavor, BoxFlavorSpec> = {
  full: {
    id: 'full',
    flagAware: true,
    warmPoolEligible: true,
    defaultDiskGiB: defaultDiskGiB,
    resolveImage({ ec2, cfg, selection }) {
      // The published image, else the owner's box-image flag (a pin or a
      // channel) — resolveBoxImage's published/pinned/channel chain is the
      // full flavor's whole image story.
      return resolveBoxImage(ec2, cfg, selection);
    },
  },
  minimal: {
    id: 'minimal',
    flagAware: false,
    warmPoolEligible: false,
    defaultDiskGiB: minimalDefaultDiskGiB,
    resolveImage({ ec2, cfg }) {
      return resolveMinimalBoxImage(ec2, cfg);
    },
  },
};

/**
 * The row's flavor from a request field: the canonical `flavor: 'minimal'`
 * (POST /api/instances, the CLI's `POST /boxes` body), and the same request
 * in 1.x's boolean spelling (`minimal: true`) — anything else is full.
 */
export function flavorOf(value: unknown): BoxFlavor {
  return value === 'minimal' || value === true ? 'minimal' : 'full';
}

/** The spec a request rides: `flavorSpec(box.flavor)` for a row, `flavorSpec(input.flavor …)` for a request. */
export function flavorSpec(flavor: unknown): BoxFlavorSpec {
  return BOX_FLAVORS[flavorOf(flavor)];
}
