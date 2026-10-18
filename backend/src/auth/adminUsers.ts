// ADMIN_USERS parsing: who may reach the admin REST surface and the admin MCP
// server. Comma-separated; each entry is one of:
//   email            exact, case-insensitive
//   @domain.com      anyone in the domain (use sparingly)
// An optional ":unixuser" suffix is tolerated and ignored so an ALLOWED_USERS
// entry can be pasted verbatim. Pure, like ./allowedUsers.ts, so it is
// unit-testable; the DB sync lives in services/admin/adminAccess.ts.

export interface AdminUsersConfig {
  exact: Set<string>;   // lowercased emails
  domains: Set<string>; // lowercased, leading "@" stripped
}

export function parseAdminUsers(raw: string | undefined): AdminUsersConfig {
  const exact = new Set<string>();
  const domains = new Set<string>();
  for (const rawEntry of (raw ?? '').split(',')) {
    const entry = rawEntry.trim().split(':')[0].trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith('@')) {
      const domain = entry.slice(1);
      if (domain) domains.add(domain);
    } else if (entry.includes('@')) {
      exact.add(entry);
    }
  }
  return { exact, domains };
}

export function isAdminEmail(config: AdminUsersConfig, email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (config.exact.has(normalized)) return true;
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return false;
  return config.domains.has(normalized.slice(at + 1));
}

/** True when the config grants nobody anything — the fail-closed default. */
export function isEmptyAdminConfig(config: AdminUsersConfig): boolean {
  return config.exact.size === 0 && config.domains.size === 0;
}
