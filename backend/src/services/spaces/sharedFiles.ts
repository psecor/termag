/**
 * Sharing one space file read-only with anyone signed in to termag.
 * A share is a SpaceFileShare row for
 * one normalized path, made by an editor or owner from the simple UI or the
 * CLI (`termag space share`). It follows the path: whatever is saved there
 * is what a viewer gets. A box (its agent token) may share too, with its
 * owner's role; the row then names the box's owner, and the file.share
 * event the box.
 *
 * A non-member reads a shared file only while all of this holds, checked on
 * every read: the share row exists, the space is live and not read-only,
 * whoever shared it is still at least an editor, the viewer's email still
 * passes ALLOWED_USERS, and SPACE_FILE_SHARING_DISABLED isn't set. Anything
 * else is "not shared", which the routes answer as the same 404 as a missing
 * file. There is no feature flag: the kill switch is the env var (or
 * deleting the rows).
 *
 * The bucket and KMS key let the presigner read any object, so this check is
 * the whole boundary between a non-member and the space.
 */
import { resolveSpaceAccess, roleAtLeast, type SpaceAccess } from './spaceAccess';
import type { FileShareRecord, SpaceRecord, SpaceStore } from './spaceStore';

/** A shared read's presigned URL works for a minute, so Make private cuts off anyone mid-read soon after. */
export const SHARED_READ_TTL_S = 60;

/** Set to `1` or `true` to turn every share off at once: shared reads 404 and no new share can be made. */
export const SHARING_DISABLED_ENV = 'SPACE_FILE_SHARING_DISABLED';

export function sharingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[SHARING_DISABLED_ENV] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Who may share or unshare a file: an editor or owner, never on a read-only space (the role is capped there). */
export function canShareFiles(access: SpaceAccess): boolean {
  return roleAtLeast(access.role, 'editor');
}

export interface SharedFileDeps {
  store: Pick<SpaceStore, 'findSpace' | 'memberRoles' | 'fileShare' | 'ldUser'>;
  /** Whether this email still signs in to termag (ALLOWED_USERS). */
  viewerAllowed: (email: string) => boolean;
  /** The kill switch; defaults to SPACE_FILE_SHARING_DISABLED. */
  disabled?: () => boolean;
}

export interface SharedFile { space: SpaceRecord; share: FileShareRecord }

/** The share that lets `viewerId` read `path` of `spaceRef`, or null. `path` must already be normalized. */
export async function resolveSharedFile(deps: SharedFileDeps, viewerId: string, spaceRef: string, path: string): Promise<SharedFile | null> {
  if ((deps.disabled ?? sharingDisabled)()) return null;
  const space = await deps.store.findSpace(spaceRef);
  if (!space || space.deletedAt) return null;
  const share = await deps.store.fileShare(space.id, path);
  if (!share) return null;
  // The sharer is checked as a user, which never consults box grants, so they aren't loaded.
  const members = await deps.store.memberRoles(space.id);
  const sharer = resolveSpaceAccess({ kind: 'user', userId: share.sharedById }, { space, members, grantedBoxIds: new Set() });
  if (!sharer || !canShareFiles(sharer)) return null;
  const viewer = await deps.store.ldUser(viewerId);
  if (!viewer?.googleEmail || !deps.viewerAllowed(viewer.googleEmail)) return null;
  return { space, share };
}
