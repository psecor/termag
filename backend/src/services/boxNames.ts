/**
 * The box-name rule, shared with project names: letters, digits, `-` and `_`.
 * It keeps `<box>/<project>` unambiguous for the CLI and every box usable as
 * an SSH host name (`termag-<box>`). Mirrored in frontend/src/utils/boxNames.ts.
 *
 * Enforced on create only: boxes named before the rule keep their names.
 */
const BOX_NAME_RE = /^[A-Za-z0-9_-]+$/;

export const BOX_NAME_ERROR = 'Box names may contain only letters, digits, - and _';

export function isValidBoxName(name: string): boolean {
  return BOX_NAME_RE.test(name);
}
