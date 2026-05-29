// Allow-list parsing and resolution for Google sign-ins.
//
// ALLOWED_USERS is a comma-separated list where each entry is one of:
//   email:unixuser              exact mapping (highest priority)
//   @domain.com                 anyone in domain; unix username = email local part
//   @domain.com:unixuser        anyone in domain mapped to a fixed unix username

// Domain wildcard rule. `unixUser` null means "derive the unix username from
// the email's local part" (e.g. jane@launchdarkly.com -> jane).
interface DomainRule {
  domain: string; // lowercased, leading "@" stripped, e.g. "launchdarkly.com"
  unixUser: string | null;
}

export interface AllowedUsersConfig {
  exact: Map<string, string>; // keys are lowercased emails
  domains: DomainRule[];
}

// Parse an ALLOWED_USERS string into exact mappings and domain wildcard rules.
// Exact emails are lowercased so lookups are case-insensitive (matching the
// domain-rule behavior). When duplicate domain rules exist, first match wins.
export function parseAllowedUsers(raw: string | undefined): AllowedUsersConfig {
  const exact = new Map<string, string>();
  const domains: DomainRule[] = [];
  for (const rawEntry of (raw ?? '').split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const [left, right] = entry.split(':');
    const key = left.trim();
    const unixUser = right?.trim();
    if (key.startsWith('@')) {
      const domain = key.slice(1).toLowerCase();
      if (domain) domains.push({ domain, unixUser: unixUser || null });
    } else if (key && unixUser) {
      exact.set(key.toLowerCase(), unixUser);
    }
  }
  return { exact, domains };
}

// Resolve the unix username for an email, honoring exact matches first and then
// domain wildcards (first matching rule wins). Returns undefined if the email is
// not allowed. Email comparison is case-insensitive; for derived usernames the
// local part is lowercased and any "+tag" alias suffix is stripped.
export function resolveUnixUsername(
  allowed: AllowedUsersConfig,
  email: string
): string | undefined {
  if (!email) return undefined;
  const normalized = email.toLowerCase();

  const exact = allowed.exact.get(normalized);
  if (exact) return exact;

  const at = normalized.lastIndexOf('@');
  if (at <= 0) return undefined;
  const localPart = normalized.slice(0, at).split('+')[0];
  const domain = normalized.slice(at + 1);
  for (const rule of allowed.domains) {
    if (rule.domain === domain) {
      return rule.unixUser ?? localPart;
    }
  }
  return undefined;
}
