/**
 * The box list's image marker. Instance.imageSource is written at launch by
 * the backend (services/boxImage.ts): `published`, `channel:<name>`,
 * `pinned`, or `fallback:<what the box-image flag asked for>`.
 */
export interface BoxImageBadge {
  label: string;
  title: string;
  fallback: boolean;
}

/** Null for the published image and for boxes launched before the image was recorded: nothing to point out. */
export function boxImageBadge(imageId: string | null | undefined, imageSource: string | null | undefined): BoxImageBadge | null {
  if (!imageSource || imageSource === 'published') return null;
  const id = imageId ?? 'unknown image';
  if (imageSource.startsWith('fallback:')) {
    const asked = imageSource.slice('fallback:'.length);
    return { label: 'published', title: `box-image ${asked} was unusable; launched from the published image ${id}`, fallback: true };
  }
  if (imageSource.startsWith('channel:')) {
    const channel = imageSource.slice('channel:'.length);
    return { label: channel, title: `candidate image ${id} (channel ${channel})`, fallback: false };
  }
  if (imageSource === 'pinned') return { label: 'pinned', title: `pinned image ${id}`, fallback: false };
  return { label: imageSource, title: `image ${id}`, fallback: false };
}

/** The box name's tooltip: the hostname and the AMI, whichever are known. */
export function boxNameTitle(hostname: string | null | undefined, imageId: string | null | undefined): string | undefined {
  const parts = [hostname, imageId && `image ${imageId}`].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}
