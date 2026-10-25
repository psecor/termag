/**
 * Renaming a box: the checks `renameOwnedBox` (routes/instances.ts) makes
 * before it writes, behind the `box-rename-enabled` flag.
 *
 * A box's name is only the label on its Instance row. Everything that keeps
 * hold of a box keys it by id (projects, tokens, shares, spaces, asks), and
 * the CLI resolves `<box>/<project>` and `ssh termag-<box>` by name per call,
 * so a rename needs nothing from the box itself and works while it is parked.
 * The EC2 `BoxName` tag keeps the launch name, as it does after a warm claim.
 *
 * A new name follows the create rule (services/boxNames.ts), even for a box
 * named before that rule existed.
 */
import { BOX_NAME_ERROR, isValidBoxName } from './boxNames';
import { boolVariation } from './featureFlags';
import type { FlagUser } from './featureFlags';

export const BOX_RENAME_FLAG = 'box-rename-enabled';

/** The `code` a refused rename carries while the flag is off. */
export const RENAME_DISABLED_CODE = 'rename_disabled';

export async function boxRenameEnabled(user: FlagUser): Promise<boolean> {
  return boolVariation(BOX_RENAME_FLAG, user, false);
}

export type BoxRenameCheck =
  | { ok: true; name: string; unchanged: boolean }
  | { ok: false; status: 400 | 404; error: string };

/**
 * `box` is the caller's own box, or null when they have none with that id. A
 * terminated box is gone from their list and its name is free for reuse, so
 * it answers like a missing one.
 */
export function checkBoxRename(box: { name: string; status: string } | null, raw: unknown): BoxRenameCheck {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, status: 400, error: 'name required' };
  const name = raw.trim();
  if (!isValidBoxName(name)) return { ok: false, status: 400, error: BOX_NAME_ERROR };
  if (!box || box.status === 'terminated') return { ok: false, status: 404, error: 'Box not found' };
  return { ok: true, name, unchanged: name === box.name };
}

/** The label `createBox` gives a box's agent token, renamed with the box. */
export function boxTokenName(boxName: string): string {
  return `box: ${boxName}`;
}
