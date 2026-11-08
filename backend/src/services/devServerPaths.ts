/**
 * The dev-server paths a viewer never reaches through termag, whoever's app it
 * is and however it is shared
 * (security-review.md SR6, SR9): launch-editor's routes, which open a file in
 * the box's editor; Vite's `/@fs/` outside the checkout the share was made
 * for; the DevTools protocol's socket paths; and any traversal encoding.
 *
 * One list for every proxy in front of a box's dev server, so they can't
 * drift: the preview links relay uses it (services/previewHost.ts), and it
 * takes nothing but a path and a checkout, so preview shares' proxy can
 * import it as it is. Pure; devServerPaths.test.ts pins each rule.
 */

export type PathRefusal =
  /** `..`, a `.` segment, `%2e`, a backslash, a NUL, or an encoding that doesn't decode. */
  | 'traversal'
  /** launch-editor's routes: they open a file in the box's editor (SR9). */
  | 'editor'
  /** Vite's /@fs/ outside the workstream's checkout (SR9). */
  | 'fs_outside'
  /** The DevTools protocol's socket paths (SR6). */
  | 'devtools';

const EDITOR_PREFIXES = ['/__open-in-editor', '/__open-stack-frame-in-editor', '/__nextjs_launch-editor'];
const UUID_PATH = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;

function decodedOnce(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

/**
 * Why a path never reaches the app, or null. Checked on the percent-decoded
 * path, with runs of slashes collapsed as the dev servers do, so no encoding
 * slips a refused prefix past: any `..`, `.` segment, `%2e`, backslash or NUL is refused
 * outright, raw or decoded (a double encoding included). `checkout` is the
 * workstream's checkout, the only place `/@fs/` may read; `upgrade` adds the
 * DevTools socket paths.
 */
export function pathRefusal(path: string, checkout: string, upgrade = false): PathRefusal | null {
  const decoded = decodedOnce(path);
  if (decoded === null) return 'traversal';
  for (const s of [path, decoded]) {
    const lower = s.toLowerCase();
    if (s.includes('..') || s.includes('\\') || s.includes('\u0000') || lower.includes('%2e') || lower.includes('%5c') || lower.includes('%00')) return 'traversal';
  }
  const p = decoded.replace(/\/{2,}/g, '/');
  // A lone `.` segment: the dev servers parse the target as a URL, which drops it, so `/./@fs/…` would
  // reach /@fs/ past the prefix checks below. Browsers never send one (they resolve it first).
  if (/(^|\/)\.(\/|$)/.test(p)) return 'traversal';
  const lower = p.toLowerCase();
  if (EDITOR_PREFIXES.some(prefix => lower.startsWith(prefix))) return 'editor';
  if (lower.startsWith('/@fs/') || lower === '/@fs') {
    const target = p.slice('/@fs'.length);
    const root = checkout.replace(/\/+$/, '');
    if (!root || !(target === root || target.startsWith(`${root}/`))) return 'fs_outside';
  }
  if (upgrade && (lower.startsWith('/devtools/') || lower === '/devtools' || UUID_PATH.test(p))) return 'devtools';
  return null;
}
