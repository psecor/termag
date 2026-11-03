// Sharing a space from the simple UI (pages/chat/SpaceShareDialog.tsx): what
// each role may do there, the words for the roles, and the link Copy link
// hands out. Whole-space sharing defaults to Can edit: read-only sharing goes
// through a single file's Share.
import type { MenuAction } from '../pages/chat/ContextMenu';
import { roleAtLeast, type SpaceRole } from '../utils/spaces';
import { itemHref } from './openItems';

export const SHARE_ROLE_LABEL: Record<SpaceRole, string> = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' };
export const SHARE_ROLE_HINT: Record<SpaceRole, string> = {
  owner: 'Manages people, boxes and the space',
  editor: 'Adds, changes and deletes files, and adds their own boxes',
  viewer: 'Opens and downloads files',
};
/** The role picker's order, its first the default. */
export const SHARE_ROLES: readonly SpaceRole[] = ['editor', 'viewer', 'owner'];
export const DEFAULT_SHARE_ROLE: SpaceRole = 'editor';

export interface ShareAbilities {
  /** The add form: shown, refused by spaces-sharing-enabled, or not the caller's to use. */
  addPeople: 'yes' | 'sharing_off' | 'not_owner';
  /** Change roles, remove people and cancel invites. */
  manage: boolean;
  /** Add one of their own boxes (editor and up, as POST /boxes). */
  addBoxes: boolean;
}

/**
 * What the dialog offers someone with `role` in a space, as the routes
 * decide it (routes/spaces.ts): owners manage, editors add their boxes, and a
 * read-only space (no owner left) lets no one change anything. `sharing` is
 * the server's answer from GET /members, null until it has loaded.
 */
export function shareAbilities(role: SpaceRole | undefined, readOnly: boolean, sharing: boolean | null): ShareAbilities {
  const owner = role === 'owner' && !readOnly;
  return {
    addPeople: !owner ? 'not_owner' : sharing === false ? 'sharing_off' : 'yes',
    manage: owner,
    addBoxes: roleAtLeast(role, 'editor') && !readOnly,
  };
}

/** The space's page in the simple UI, `/termag/chat/files/<space>`: its New tab, or a no-access note for anyone else. */
export function spaceShareLink(origin: string, baseUrl: string, space: string): string {
  return `${origin}${baseUrl.replace(/\/$/, '')}${itemHref({ kind: 'explorer', space })}`;
}

/** Up to two letters for a person's avatar: the first of each of the first two words of the name, else of the email's local part. */
export function initials(nameOrEmail: string): string {
  const words = nameOrEmail.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return words.slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?';
}

/**
 * The space's own section of its head's ⋮ menu (chat/spaceMenu.ts, from the
 * space-sidebar work: New agent, New tab, then this, then the tab actions):
 * Share space, with a line under it as New agent and New tab have. "space",
 * so it isn't taken for sharing one file (the file view has its own Share).
 * Nothing for "No space" (null).
 */
export function spaceShareActions(space: string | null, open: (space: string) => void): Array<MenuAction & { hint: string }> {
  if (space === null) return [];
  return [{ label: 'Share space', hint: `People and boxes with access to ${space}`, onSelect: () => open(space) }];
}
