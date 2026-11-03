/**
 * Box sizes: which EC2 types a box launches as, chosen per box.
 *
 * Three sizes, all arm64 (the AMI is arm64-only), each an instance type and
 * the same-shape types to try when EC2 has no capacity for it
 * (boxProvisioner.withInstanceTypes walks them in order):
 *
 *   small   m8g.large    2 vCPU,  8 GiB
 *   medium  m8g.xlarge   4 vCPU, 16 GiB
 *   large   m8g.2xlarge  8 vCPU, 32 GiB
 *
 * A launch's size, in this order (decideBoxSize): the one asked for (`--size`,
 * the New box dropdown); else the repository's `.termag/environment.json` `size`,
 * the largest across a multi-repo project's repositories (largestBoxSize;
 * services/repoEnvironment.ts reads it), a preset or `{ vcpu, memoryGiB }`
 * minimums that services/boxRequirements.ts resolves to types; else the
 * owner's `box-default-size` flag. A box made for an ask is sized like any
 * other: asks do the same work people do. The New box dropdowns
 * preselect the same answer (GET /api/instances/sizes?repo=). The flag
 * serving "" (its off variation, and the fallback) means no size at all: the
 * box launches as BOX_INSTANCE_TYPE and its fallbacks, exactly as before
 * sizes, and neither the repo file nor an explicit size applies, so nothing
 * changes until the flag is on for someone.
 *
 * The warm pool holds some of each size while the flag serves a size for the
 * pool's fixed context (boxHibernationFlag.POOL_FLAG_CONTEXT); how many of each
 * is box-warm-pool-sizes (warmPoolSizes.ts). Each size has its own pool spec
 * hash, so a claim can only take a box of the size it asked for, and a size
 * the pool holds none of launches cold.
 */
import type { InstanceTypeChoice } from './boxProvisioner';
import { POOL_FLAG_CONTEXT } from './boxHibernationFlag';
import { stringVariation, stringVariationForContext } from './featureFlags';
import type { FlagUser } from './featureFlags';
import { parseRepoUrl } from './projectTemplates';

export const BOX_DEFAULT_SIZE_FLAG = 'box-default-size';

export const BOX_SIZES = ['small', 'medium', 'large'] as const;
export type BoxSize = typeof BOX_SIZES[number];

export interface BoxSizeSpec {
  size: BoxSize;
  vcpus: number;
  memoryGiB: number;
  /** The type to launch, then its fallbacks in order. */
  types: string[];
}

/**
 * Each size's types when its BOX_<SIZE>_INSTANCE_TYPES is unset: the m8g, then
 * the same vCPU and at least the memory in the families beside it, then the
 * next size up, which costs more but beats no box.
 */
const DEFAULT_TYPES: Record<BoxSize, string[]> = {
  small: ['m8g.large', 'm7g.large', 'r8g.large', 'r7g.large', 'm8g.xlarge'],
  medium: ['m8g.xlarge', 'm7g.xlarge', 'r8g.xlarge', 'r7g.xlarge', 'm8g.2xlarge'],
  large: ['m8g.2xlarge', 'm7g.2xlarge', 'r8g.2xlarge', 'r7g.2xlarge', 'm8g.4xlarge'],
};

const SHAPES: Record<BoxSize, { vcpus: number; memoryGiB: number }> = {
  small: { vcpus: 2, memoryGiB: 8 },
  medium: { vcpus: 4, memoryGiB: 16 },
  large: { vcpus: 8, memoryGiB: 32 },
};

export function isBoxSize(value: unknown): value is BoxSize {
  return typeof value === 'string' && (BOX_SIZES as readonly string[]).includes(value);
}

/** Graviton types only: a family with a `g` after its generation (m8g, c7gn, r7gd, t4g). */
const ARM64_TYPE_RE = /^[a-z]+\d+[a-z]*g[a-z]*\.[a-z0-9]+$/;

/**
 * A size's shape and types. BOX_SMALL_INSTANCE_TYPES (and _MEDIUM_, _LARGE_)
 * replace the defaults: comma-separated, the first is launched and the rest
 * are its fallbacks. A non-arm64 name is dropped with a warning, and a list
 * left empty falls back to the defaults.
 */
export function boxSizeSpec(size: BoxSize, env: NodeJS.ProcessEnv = process.env): BoxSizeSpec {
  const key = `BOX_${size.toUpperCase()}_INSTANCE_TYPES`;
  const listed = [...new Set((env[key] ?? '').split(',').map(t => t.trim()).filter(Boolean))];
  const arm64 = listed.filter(t => ARM64_TYPE_RE.test(t));
  if (arm64.length < listed.length) {
    console.warn(`[BOX] ${key}: ignoring non-arm64 type(s) ${listed.filter(t => !arm64.includes(t)).join(', ')}`);
  }
  return { size, ...SHAPES[size], types: arm64.length ? arm64 : DEFAULT_TYPES[size] };
}

/** What a launch of `size` walks; undefined (the configured BOX_INSTANCE_TYPE) for no size. */
export function instanceTypesForSize(size: BoxSize | null, env: NodeJS.ProcessEnv = process.env): InstanceTypeChoice | undefined {
  if (!size) return undefined;
  const [type, ...fallbacks] = boxSizeSpec(size, env).types;
  return { type, fallbacks };
}

/** A repository's `owner/name`, lower case, from a GitHub URL or an `owner/name`; null for anything else. */
export function repoKey(repo: string): string | null {
  const parsed = parseRepoUrl(repo);
  if (parsed.ok) return `${parsed.owner}/${parsed.repo}`.toLowerCase();
  return /^[\w.-]+\/[\w.-]+$/.test(repo.trim()) ? repo.trim().toLowerCase() : null;
}

/** The flag's value as a size: "" (off) and anything unrecognised are no size. */
export function sizeFromFlag(value: string): BoxSize | null {
  if (value === '') return null;
  if (isBoxSize(value)) return value;
  console.warn(`[BOX] ${BOX_DEFAULT_SIZE_FLAG} served ${JSON.stringify(value)}, not one of ${BOX_SIZES.join(', ')}; launching the configured type`);
  return null;
}

/** The owner's default size, or null for the configured type. Read with the claim decision, so the claim and the launch agree. */
export async function ownerDefaultSize(owner: FlagUser): Promise<BoxSize | null> {
  return sizeFromFlag(await stringVariation(BOX_DEFAULT_SIZE_FLAG, owner, ''));
}

/** The warm pool's size: the flag for its fixed context, so it follows the fallthrough. */
export async function poolDefaultSize(): Promise<BoxSize | null> {
  return sizeFromFlag(await stringVariationForContext(BOX_DEFAULT_SIZE_FLAG, POOL_FLAG_CONTEXT, ''));
}

export type SizeSource = 'explicit' | 'repo' | 'flag' | 'configured';

/**
 * `requirements`: the repo file asked for minimums rather than a preset; the
 * launch resolves them to types, and takes `size` (the default) if that fails.
 */
export type SizeDecision =
  | { ok: true; size: BoxSize | null; source: SizeSource; requirements?: BoxRequirements }
  | { ok: false; status: 400 | 403; code: 'invalid_size' | 'box_size_disabled'; error: string };

export const SIZE_ERROR = `size must be one of ${BOX_SIZES.join(', ')}`;
export const SIZE_DISABLED_ERROR = 'Choosing a box size is not turned on for you yet';

/** A size as minimums rather than a preset (services/boxRequirements.ts resolves it to types). */
export interface BoxRequirements {
  vcpu: number;
  memoryGiB: number;
}

/** What a repository's `.termag/environment.json` says (services/repoEnvironment.ts): its size, a preset or requirements; null when absent or unusable. */
export interface RepoBoxSizes {
  size: BoxSize | BoxRequirements | null;
  /** `resources.diskGiB` (services/boxDiskSize.ts): set only when the file asks for a disk it can have. */
  diskGiB?: number;
}

/**
 * The largest of several repositories' sizes (a multi-repo project's): the
 * most vCPUs and the most memory any of them asks for, each on its own, so
 * 4/32 and 8/16 make 8/32. A preset counts as its shape, and a result that
 * is a preset's shape is that preset. Each input is within the limits
 * (boxRequirements.BOX_REQUIREMENT_LIMITS is large's shape), so the result
 * is too. Null when none says anything.
 */
export function largestBoxSize(sizes: ReadonlyArray<BoxSize | BoxRequirements | null>): BoxSize | BoxRequirements | null {
  const shapes = sizes.filter((s): s is BoxSize | BoxRequirements => s != null)
    .map(s => (isBoxSize(s) ? { vcpu: SHAPES[s].vcpus, memoryGiB: SHAPES[s].memoryGiB } : s));
  if (!shapes.length) return null;
  const vcpu = Math.max(...shapes.map(s => s.vcpu));
  const memoryGiB = Math.max(...shapes.map(s => s.memoryGiB));
  return BOX_SIZES.find(size => SHAPES[size].vcpus === vcpu && SHAPES[size].memoryGiB === memoryGiB) ?? { vcpu, memoryGiB };
}

/**
 * The size a new box launches at. `requested` is the request's `size` field
 * as sent (undefined or null when it had none); `repo` what the repositories
 * the box is made for ask for (largestBoxSize), when there are any;
 * `flagDefault` the owner's box-default-size. A repo's requirements come back
 * with the default as `size`, for when they can't be met. Pure, so every
 * rule is a unit test.
 */
export function decideBoxSize(requested: unknown, repo: RepoBoxSizes | null, flagDefault: BoxSize | null): SizeDecision {
  if (requested !== undefined && requested !== null && requested !== '') {
    if (!isBoxSize(requested)) return { ok: false, status: 400, code: 'invalid_size', error: SIZE_ERROR };
    if (!flagDefault) return { ok: false, status: 403, code: 'box_size_disabled', error: SIZE_DISABLED_ERROR };
    return { ok: true, size: requested, source: 'explicit' };
  }
  if (!flagDefault) return { ok: true, size: null, source: 'configured' };
  const forRepo = repo?.size;
  if (isBoxSize(forRepo)) return { ok: true, size: forRepo, source: 'repo' };
  if (forRepo) return { ok: true, size: flagDefault, source: 'repo', requirements: forRepo };
  return { ok: true, size: flagDefault, source: 'flag' };
}

/** What the New box pickers show (GET /api/instances/sizes): off, or the sizes with the owner's default. */
export interface BoxSizeOptions {
  enabled: boolean;
  default: BoxSize | null;
  /**
   * What the New box dropdowns preselect: the owner's box-default-size (the
   * same value as `default`), which GET /api/instances/sizes?repo= replaces
   * with decideBoxSize's answer for that repository.
   */
  defaultSize: BoxSize | null;
  sizes: Array<{ size: BoxSize; vcpus: number; memoryGiB: number; instanceType: string }>;
}

export function boxSizeOptions(flagDefault: BoxSize | null, env: NodeJS.ProcessEnv = process.env): BoxSizeOptions {
  if (!flagDefault) return { enabled: false, default: null, defaultSize: null, sizes: [] };
  return {
    enabled: true,
    default: flagDefault,
    defaultSize: flagDefault,
    sizes: BOX_SIZES.map(size => {
      const spec = boxSizeSpec(size, env);
      return { size, vcpus: spec.vcpus, memoryGiB: spec.memoryGiB, instanceType: spec.types[0] };
    }),
  };
}
