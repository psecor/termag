// The publish form's checks, as it's typed: a copy of the name grammar and the
// lifetime bounds in backend/src/services/previewLinkRules.ts, which the
// frontend can't import. backend/src/services/previewLinkRules.mirror.test.ts
// runs both on the same names and fails when they disagree; change both
// together. The server checks everything again on publish.

export const PREVIEW_NAME_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const RESERVED_PREVIEW_NAMES: ReadonlySet<string> = new Set(['www', 'api', 'auth', 'admin', 'termag', 'preview', 'mail', 'login', 'confirm', 'reverify']);
export const MIN_TTL_HOURS = 1;
export const MAX_TTL_HOURS = 168;
/** A link lives at most 30 days from its first publish (the server's MAX_LINK_LIFETIME_MS). */
export const MAX_LINK_LIFETIME_DAYS = 30;

export type NameRefusal = 'invalid' | 'reserved';

export function nameRefusal(name: string): NameRefusal | null {
  if (!PREVIEW_NAME_RE.test(name)) return 'invalid';
  if (RESERVED_PREVIEW_NAMES.has(name)) return 'reserved';
  // `--` separates a host's name from its suffix (`<name>--<suffix>`); it also covers IDNA's `ab--` and punycode's `xn--`.
  if (name.includes('--')) return 'reserved';
  return null;
}

/** What's wrong with a name, in words for the field; null when the server would take it. */
export function nameProblem(name: string): string | null {
  const refusal = nameRefusal(name);
  if (refusal === 'reserved') return `"${name}" is reserved; pick another name.`;
  if (refusal === 'invalid') return '3 to 40 lowercase letters, digits and hyphens, not starting or ending with a hyphen.';
  return null;
}

/** `<project>-<workstream>` (the project alone for main), as the server suggests it; null when that isn't a valid name. */
export function suggestName(project: string, workstream: string): string | null {
  const raw = workstream === 'main' ? project : `${project}-${workstream}`;
  const label = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
  return nameRefusal(label) === null ? label : null;
}

export function clampTtlHours(n: number): number {
  if (!Number.isFinite(n)) return 24;
  return Math.min(MAX_TTL_HOURS, Math.max(MIN_TTL_HOURS, Math.round(n)));
}

/** A comma- or space-separated list of emails, trimmed, lowercased and without repeats. */
export function parseEmails(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map(e => e.trim().toLowerCase()).filter(Boolean))];
}
