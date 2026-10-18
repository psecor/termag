/**
 * Which box image a user's boxes launch from: the per-user
 * string flag `box-image`.
 *
 *   ""              the newest published image (tag Component=box), as every
 *                   box launched before this flag existed
 *   "ami-…"         that image, pinned
 *   "<channel>"     the newest image tagged Channel=<channel>, which a bake
 *                   with publish-ami.yml's `channel` input sets
 *
 * Every launch path for a user's own box goes through it: a new box
 * (routes/instances.ts, which also skips the warm-pool claim for a flagged
 * user, because pool boxes are always on the published image) and the box
 * update target (services/boxUpdate.ts). The warm pool never reads it: an
 * ownerless box has no user to evaluate, and its spec hash must not move
 * with anyone's flag.
 *
 * The flag only ever chooses among our own images: the resolver
 * (boxProvisioner.resolveBoxImage) asks EC2 for self-owned images, and
 * pickSelectedImage keeps only available ones tagged App=termag with a box
 * component. Anything else, a typo included, falls back to the published
 * image with a warning, so a bad flag value costs a user the image they
 * asked for, never a box.
 */
import { FlagBox, FlagUser } from './featureFlags';
import { stringVariation } from './featureFlags';

export const BOX_IMAGE_FLAG = 'box-image';

/** The AMI tag a channel bake sets (publish-ami.yml `channel`, packer var.channel). */
export const AMI_CHANNEL_TAG = 'Channel';

/** Images a box may launch from: the published one and the candidates a dispatch bake leaves. */
export const BOX_IMAGE_COMPONENTS: readonly string[] = ['box', 'box-candidate'];

export type BoxImageSelection =
  | { kind: 'published' }
  | { kind: 'pinned'; amiId: string }
  | { kind: 'channel'; channel: string };

export const PUBLISHED_IMAGE: BoxImageSelection = { kind: 'published' };

const AMI_ID = /^ami-(?:[0-9a-f]{8}|[0-9a-f]{17})$/;
/** The same rule publish-ami.yml applies to its `channel` input. */
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface ParsedBoxImageFlag {
  selection: BoxImageSelection;
  /** Why a non-empty value was not usable; null when it was, or was empty. */
  warning: string | null;
}

export function parseBoxImageFlag(value: unknown): ParsedBoxImageFlag {
  if (value === undefined || value === null) return { selection: PUBLISHED_IMAGE, warning: null };
  if (typeof value !== 'string') return { selection: PUBLISHED_IMAGE, warning: `${BOX_IMAGE_FLAG} is not a string` };
  const v = value.trim();
  if (!v) return { selection: PUBLISHED_IMAGE, warning: null };
  if (v.startsWith('ami-')) {
    return AMI_ID.test(v)
      ? { selection: { kind: 'pinned', amiId: v }, warning: null }
      : { selection: PUBLISHED_IMAGE, warning: `${BOX_IMAGE_FLAG} "${v}" is not an AMI id` };
  }
  return CHANNEL_NAME.test(v)
    ? { selection: { kind: 'channel', channel: v }, warning: null }
    : { selection: PUBLISHED_IMAGE, warning: `${BOX_IMAGE_FLAG} "${v}" is neither an AMI id nor a channel name` };
}

export function isPublished(selection: BoxImageSelection): boolean {
  return selection.kind === 'published';
}

/**
 * What Instance.imageSource records, and what the box list shows:
 * `published`, `channel:<name>`, `pinned`, or `fallback:<what was asked>`
 * when the asked-for image could not be used and the box got the published one.
 */
export function boxImageSource(selection: BoxImageSelection): string {
  switch (selection.kind) {
    case 'published': return 'published';
    case 'pinned': return 'pinned';
    case 'channel': return `channel:${selection.channel}`;
  }
}

export function fallbackImageSource(requested: BoxImageSelection): string {
  return `fallback:${requested.kind === 'pinned' ? `pinned:${requested.amiId}` : boxImageSource(requested)}`;
}

/** A stable key for caching per selection. */
export function selectionKey(selection: BoxImageSelection): string {
  return selection.kind === 'pinned' ? `pinned:${selection.amiId}` : boxImageSource(selection);
}

/** The fields of EC2's Image that choosing one reads. */
export interface ImageCandidate {
  ImageId?: string;
  State?: string;
  CreationDate?: string;
  Tags?: { Key?: string; Value?: string }[];
}

const tag = (image: ImageCandidate, key: string) => (image.Tags ?? []).find(t => t.Key === key)?.Value;

/**
 * The image a non-published selection names, from what DescribeImages
 * returned (already restricted to self-owned), or why there is none. Checks
 * everything again rather than trusting the request's filters: a pinned id is
 * looked up by id, which no tag filter constrains.
 */
export function pickSelectedImage<T extends ImageCandidate>(
  images: readonly T[],
  selection: Exclude<BoxImageSelection, { kind: 'published' }>,
): { image: T } | { reason: string } {
  const named = images.filter(i => selection.kind === 'pinned'
    ? i.ImageId === selection.amiId
    : tag(i, AMI_CHANNEL_TAG) === selection.channel);
  const what = selection.kind === 'pinned' ? selection.amiId : `channel ${selection.channel}`;
  if (named.length === 0) return { reason: `no self-owned image for ${what}` };
  const usable = named.filter(i => i.State === 'available'
    && tag(i, 'App') === 'termag'
    && BOX_IMAGE_COMPONENTS.includes(tag(i, 'Component') ?? '')
    && !!i.CreationDate);
  if (usable.length === 0) {
    return { reason: `${what} is not an available termag box image (App=termag, Component=${BOX_IMAGE_COMPONENTS.join('|')})` };
  }
  const newest = [...usable].sort((a, b) => (b.CreationDate! < a.CreationDate! ? -1 : 1))[0];
  return { image: newest };
}

/**
 * The selection for a user's box, from the flag. Fallback "" (published) when
 * no flag source sets it; a value that cannot be parsed is warned
 * about and treated the same.
 */
export async function boxImageSelectionFor(user: FlagUser, box?: FlagBox | null): Promise<BoxImageSelection> {
  const parsed = parseBoxImageFlag(await stringVariation(BOX_IMAGE_FLAG, user, '', box));
  if (parsed.warning) console.warn(`[BOX] ${user.unixUsername}: ${parsed.warning}; using the published box image`);
  return parsed.selection;
}
