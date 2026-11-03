/**
 * The folder of its space an automation lives in:
 * always `.termag/automations/<automation id>`. It is derived
 * from the automation's id, never chosen, so a rename never moves it and two
 * automations can never share one. It is written to the row when a space is
 * attached; the row is what the runs read, so a row from before the fixed
 * folder (`automations/<name>`, a folder its owner chose, or the backfilled
 * `automations/<projectId>`) keeps working where its files are until
 * scripts/moveAutomationFolders.ts has moved them. Pure.
 */

/** Where every automation's folder is, inside the space's `.termag/` (not space memory: spaces/spaceMemory.ts). */
export const AUTOMATIONS_SPACE_ROOT = '.termag/automations/';

/** The folder an automation lives in: fixed by its id. */
export function spaceFolderFor(automationId: string): string {
  return `${AUTOMATIONS_SPACE_ROOT}${automationId}`;
}

/**
 * The folder an automation's files are in: the stored one, else the fixed
 * one. A row is stored the fixed folder when its space is attached; an older
 * row keeps the folder it had until the move script moves it.
 */
export function folderOf(a: { id: string; spaceFolder: string | null }): string {
  return a.spaceFolder ?? spaceFolderFor(a.id);
}

/**
 * The `spaceFolder` of a create or PATCH body, which only the fixed folder
 * may be: a client that round-trips the view sends that, and anything else
 * is refused, never silently ignored, so no caller believes its folder was
 * used. Null when the body is fine.
 */
export function chosenFolderRefusal(raw: unknown, fixed: string | null): string | null {
  if (raw === undefined) return null;
  const asked = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : raw;
  if (fixed !== null && asked === fixed) return null;
  return `An automation's space folder is fixed (${fixed ?? `${AUTOMATIONS_SPACE_ROOT}<automation id>`}); leave spaceFolder out`;
}

/** The legacy layouts the move script moves from: what the one-file mirror and the chosen folders used. */
export function legacyFolderOf(a: { spaceFolder: string | null; projectId: string }): string {
  return a.spaceFolder ?? `automations/${a.projectId}`;
}
