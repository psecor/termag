/**
 * The preview host's grammar, in one place for the backend and nginx:
 * the name a link is
 * published under, the label its host carries, and the preview domain those
 * hosts end in. nginx's preview `server_name` is generated from these at boot
 * (scripts/previewNginxSnippet.ts), so the two can't drift:
 * deploy/termag-preview-nginx.test.sh runs real nginx on the rendered line and
 * checks it accepts exactly the labels PREVIEW_HOST_LABEL_RE accepts.
 *
 * No imports: the snippet script runs as root before nginx starts, and loads
 * only this file.
 */

/**
 * A name is a DNS label (PRD P2): 3 to 40 of a-z, 0-9 and `-`, neither end a
 * hyphen. Unanchored, so it can be composed; PREVIEW_NAME_RE anchors it.
 */
export const PREVIEW_NAME_SOURCE = '[a-z0-9][a-z0-9-]{1,38}[a-z0-9]';

/** A link's host suffix (SR19): 4 to 6 base32 characters; new links get 6. */
export const PREVIEW_HOST_SUFFIX_SOURCE = '[a-z2-7]{4,6}';

/** A character a host label may hold: what ends a label is anything else (`.`, or its end). */
const LABEL_CHAR = '[a-z0-9-]';

/**
 * The first label of a preview host, `<label>.<domain>`, exactly the labels
 * previewLinkRules.parseHostLabel parses (previewHostGrammar.test.ts pins it):
 * - `<name>--<suffix>`, the link's own host;
 * - or a bare name (the backend sends it to the landing page), unless it ends in
 *   `--<suffix>`: parseHostLabel splits at the last `--`, so such a label is
 *   that name and suffix, or nothing.
 * A name published before 2026-11-06 may hold `--` itself (`abc--d`, served on
 * `abc--d--<suffix>`). nginx matches the label and passes it on as
 * X-Termag-Preview-Name, and classifyHost parses it again. Change it here and
 * nginx follows at the next start.
 *
 * It goes into nginx inside a double-quoted string, so it must stay free of
 * `"`, `$`, `;`, `\`, whitespace and anchors (the label's end is a lookahead,
 * so it reads the same before nginx's `\.` and the backend's `$`);
 * previewHostGrammar.test.ts checks. The syntax is the common ground of
 * JavaScript and PCRE.
 */
export const PREVIEW_HOST_LABEL_SOURCE =
  `(?:${PREVIEW_NAME_SOURCE}--${PREVIEW_HOST_SUFFIX_SOURCE}` +
  `|(?!${LABEL_CHAR}*--${PREVIEW_HOST_SUFFIX_SOURCE}(?!${LABEL_CHAR}))${PREVIEW_NAME_SOURCE})`;

export const PREVIEW_HOST_LABEL_RE = new RegExp(`^${PREVIEW_HOST_LABEL_SOURCE}$`);

/** PREVIEW_LINKS_DOMAIN as the backend reads it: trimmed, lowercased, no leading or trailing dots. Null when unset or empty. */
export function normalisePreviewDomain(raw: string | undefined | null): string | null {
  return raw?.trim().toLowerCase().replace(/^\.+|\.+$/g, '') || null;
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type PreviewDomainRefusal = 'unset' | 'malformed';

/**
 * Why a (normalised) preview domain can't go into nginx, or null when it can:
 * two or more DNS labels of a-z, 0-9 and `-`, 253 characters at most. Anything
 * else (a space, a quote, a `;` or `{`, a wildcard, a port, a path, an
 * internationalised name not yet in punycode) is malformed, so nothing that
 * nginx would read as syntax ever reaches its config.
 */
export function previewDomainRefusal(domain: string | null): PreviewDomainRefusal | null {
  if (!domain) return 'unset';
  if (domain.length > 253) return 'malformed';
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => DNS_LABEL.test(l))) return 'malformed';
  return null;
}

/** `s` as a PCRE literal outside a character class: every metacharacter backslashed. */
export function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The snippet's one line, for a domain previewDomainRefusal accepts:
 *   server_name "~^<label>\.<escaped domain>$";
 * Quoted, because nginx reads a bare `{` (the label's `{1,38}`) as a block.
 * Throws for a domain it refuses: an unescaped domain is never written.
 */
export function nginxServerNameLine(domain: string): string {
  const refusal = previewDomainRefusal(domain);
  if (refusal) throw new Error(`preview domain is ${refusal}`);
  return `server_name "~^${PREVIEW_HOST_LABEL_SOURCE}\\.${escapeRegexLiteral(domain)}$";\n`;
}
