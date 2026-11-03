/**
 * Teams: a roster of people, sourced from the
 * org-tree (ld-org-explorer) with effective-dated membership intervals. Pure,
 * so the roster rules are tested without a database or GitHub.
 *
 *   A team is a named set of GitHub logins. Membership is a list of intervals
 *   (a login on a team from `start` to `end`), so "who was on the team then"
 *   is answerable. A parent team's roster is the de-duped union of its
 *   descendants'. `openStart` marks a start that is only the first observation.
 *
 * The org-tree's ledger is partial (team_tags from 2026-09-17, coarse from
 * 2026-08-30, not everyone covered), so a seed roster is used until the live
 * sync (Phase 4) replaces it.
 */

export interface TeamDef {
  key: string;
  name: string;
  /** Another team's key, or null at the top. */
  parent: string | null;
  hidden: boolean;
  sort: number;
}

export interface MembershipInterval {
  login: string;
  email?: string | null;
  name?: string | null;
  start: Date;
  end?: Date | null;
  /** The start is the first observation, not the real join date. */
  openStart?: boolean;
  source?: 'synced' | 'manual';
}

/** A resolved team: its key and the logins on it (and its descendants) in a window. */
export interface TeamScope { key: string; logins: string[] }

/** A membership row as stored: the interval plus the team it belongs to. */
export interface StoredMembership extends MembershipInterval { teamKey: string }

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A team key as the admin routes take it (PUT/DELETE /prs/teams/:key): 1-40 lowercase letters, digits or dashes. */
export const isTeamKey = (key: string): boolean => KEY_RE.test(key);
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Teams seeded once each, by key, with their rosters: none ship. A deployment
 * defines its teams on the admin PRs tab's Teams card (or imports an org-tree
 * export there), and the team sync keeps the synced rows current.
 */
export const SEED_TEAMS: TeamDef[] = [];

export const SEED_TEAM_MEMBERS: Array<{ teamKey: string; login: string; name: string; email: string; start?: string; source?: 'synced' | 'manual' }> = [];

/** The sentinel start of a seed membership: before any PR the ingester stores. */
export const SEED_START = new Date('1970-01-01T00:00:00Z');

/** Validate an edited team; returns the normalised team or an error. */
export function parseTeam(input: unknown): TeamDef | { error: string } {
  if (typeof input !== 'object' || input === null) return { error: 'team must be an object' };
  const t = input as Record<string, unknown>;
  const key = typeof t.key === 'string' ? t.key.trim().toLowerCase() : '';
  if (!KEY_RE.test(key)) return { error: 'key must be 1-40 lowercase letters, digits or dashes' };
  const name = typeof t.name === 'string' && t.name.trim() ? t.name.trim().slice(0, 60) : key;
  const rawParent = typeof t.parent === 'string' ? t.parent.trim().toLowerCase() : '';
  if (rawParent && !KEY_RE.test(rawParent)) return { error: `not a team key: ${rawParent}` };
  if (rawParent === key) return { error: 'a team cannot be its own parent' };
  const hidden = t.hidden === true;
  const sort = Number.isInteger(t.sort) ? (t.sort as number) : 100;
  return { key, name, parent: rawParent || null, hidden, sort };
}

export interface ParsedMember { login: string; name: string; email: string; start: Date; end: Date | null; openStart: boolean }

/** Validate one membership row (a manual override); returns it normalised or an error. */
export function parseTeamMember(input: unknown): ParsedMember | { error: string } {
  if (typeof input !== 'object' || input === null) return { error: 'member must be an object' };
  const m = input as Record<string, unknown>;
  const login = typeof m.login === 'string' ? m.login.trim().replace(/^@/, '').toLowerCase() : '';
  if (!LOGIN_RE.test(login)) return { error: `not a GitHub login: ${m.login}` };
  const name = typeof m.name === 'string' ? m.name.trim().slice(0, 80) : '';
  const email = typeof m.email === 'string' ? m.email.trim().slice(0, 200) : '';
  const start = typeof m.start === 'string' || m.start instanceof Date ? new Date(m.start as string) : null;
  if (!start || Number.isNaN(start.getTime())) return { error: `${login}: start must be a date` };
  const end = m.end == null ? null : new Date(m.end as string);
  if (end && Number.isNaN(end.getTime())) return { error: `${login}: end must be a date` };
  if (end && end <= start) return { error: `${login}: end must be after start` };
  return { login, name, email, start, end, openStart: m.openStart === true };
}

/** A team and every team under it, breadth-first, in a stable order. */
export function descendantKeys(teams: Pick<TeamDef, 'key' | 'parent'>[], key: string): string[] {
  const children = new Map<string, string[]>();
  for (const t of teams) if (t.parent) children.set(t.parent, [...(children.get(t.parent) ?? []), t.key]);
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [key];
  while (queue.length) {
    const k = queue.shift()!;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    for (const c of (children.get(k) ?? []).sort()) queue.push(c);
  }
  return out;
}

/** Logins with a membership interval overlapping [since, until). An `openStart` row's start is
 * only the first observation, so it covers dates before it too. */
export function rosterInWindow(intervals: MembershipInterval[], since: Date, until: Date): string[] {
  const out = new Set<string>();
  for (const i of intervals) {
    if (i.end && i.end <= since) continue;
    if (!i.openStart && i.start >= until) continue;
    out.add(i.login.toLowerCase());
  }
  return [...out].sort();
}

/**
 * The logins on `key` and its descendants in a window. Manual rows win over
 * synced ones per login, but every interval of the winning source survives — a
 * rejoin, or a move between sub-teams, keeps all its intervals.
 */
export function teamLogins(
  teams: Pick<TeamDef, 'key' | 'parent'>[], intervals: StoredMembership[], key: string, since: Date, until: Date,
): string[] {
  const keys = new Set(descendantKeys(teams, key));
  const byLogin = new Map<string, MembershipInterval[]>();
  for (const i of intervals) {
    if (!keys.has(i.teamKey)) continue;
    const k = i.login.toLowerCase();
    byLogin.set(k, [...(byLogin.get(k) ?? []), i]);
  }
  const kept: MembershipInterval[] = [];
  for (const rows of byLogin.values()) {
    const manual = rows.filter(r => r.source === 'manual');
    kept.push(...(manual.length ? manual : rows));
  }
  return rosterInWindow(kept, since, until);
}
