// A docs site for the settings page's help links, set at build time with
// VITE_DOCS_SITE_URL (an origin ending in "/"). Unset, the links are hidden.
export const DOCS_SITE_URL: string = (import.meta.env.VITE_DOCS_SITE_URL as string | undefined) ?? '';

/** Headings in the docs site's settings guide, as GitHub slugs them. */
export const SETTINGS_DOCS_ANCHORS = [
  'ssh-keys',
  'ssh-into-a-box',
  'credentials-on-your-boxes',
  'claude-through-the-gateway',
  'github-token',
  'mcp-servers',
  'dotfiles',
  'cli-sign-ins',
  'notifications',
  'appearance',
  'account',
] as const;

export type SettingsDocsAnchor = typeof SETTINGS_DOCS_ANCHORS[number];

export function settingsDocsHref(anchor: SettingsDocsAnchor, base: string = DOCS_SITE_URL): string | null {
  if (!base) return null;
  return `${base}#/docs?doc=settings&h=${anchor}`;
}
