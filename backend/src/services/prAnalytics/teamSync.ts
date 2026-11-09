/**
 * The team sync (Sync): pull the org-tree's team
 * registry and rosters into `Team`/`TeamMembership`, so teams stop being
 * seed-only.
 *
 * The org-tree's history API is keyed by email; PR analytics is keyed by GitHub
 * login, so each member is resolved through the `github` field the org API now
 * returns, falling back to a termag user's stored GitHub credential. A member
 * with neither is skipped (they contribute nothing to PR analytics anyway; an
 * admin can still add them by hand).
 *
 * Synced rows are replaced whole on each run; manual rows are never touched, and
 * win for the same login (services/prAnalytics/queries.ts loadTeamScope).
 */
import { readFileSync } from 'fs';
import { prisma } from '../../db';
import { isTeamKey } from './teams';

export interface OrgTeam { tag: string; label: string; parent: string | null; hidden?: boolean }
export interface OrgMember {
  key?: string;
  name?: string | null;
  email?: string | null;
  github?: string | null;
  start: string;
  end?: string | null;
  open_start?: boolean;
}

export interface SyncedMember {
  login: string;
  email: string | null;
  name: string | null;
  start: Date;
  end: Date | null;
  openStart: boolean;
}
export interface TeamSyncPlan {
  teams: Array<{ key: string; name: string; parent: string | null; hidden: boolean; sort: number }>;
  members: Array<SyncedMember & { teamKey: string }>;
  /** Members with no resolvable login, or a bad date: not written. */
  skipped: number;
}

/** The API base, e.g. `http://10.0.0.5:3042/org/api`. Unset means the sync is off. */
export const orgApiBase = (env: NodeJS.ProcessEnv = process.env): string | null =>
  env.ORG_EXPLORER_API ? env.ORG_EXPLORER_API.replace(/\/$/, '') : null;

/** A local JSON export of the registry + rosters, for when the API is unreachable. */
export const orgExportPath = (env: NodeJS.ProcessEnv = process.env): string | null =>
  env.ORG_EXPLORER_EXPORT || null;

/** The biggest export the import route takes (the real one is ~170 KB for 75 teams). */
export const TEAMS_EXPORT_BODY_LIMIT = '5mb';
const MAX_EXPORT_TEAMS = 1000;

/**
 * Why an export (an admin's upload, POST /api/admin/prs/teams/import) is not
 * one, or null: `teams` a non-empty list of `{ tag }`, `members` an object of
 * rosters with `current` / `former` lists. Checked before anything is written,
 * since a sync replaces every synced row of the teams it names.
 */
export function exportProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'The export must be a JSON object with teams and members';
  const o = raw as { teams?: unknown; members?: unknown };
  if (!Array.isArray(o.teams) || o.teams.length === 0) return 'The export has no teams';
  if (o.teams.length > MAX_EXPORT_TEAMS) return `The export has more than ${MAX_EXPORT_TEAMS} teams`;
  if (!o.teams.every(t => !!t && typeof (t as OrgTeam).tag === 'string' && (t as OrgTeam).tag.trim() !== '')) return 'Every team needs a tag';
  // A tag is written as Team.key: one the admin routes refuse could never be edited or deleted (Devin, #1094).
  for (const t of o.teams as OrgTeam[]) {
    if (!isTeamKey(t.tag)) return `Team tag ${JSON.stringify(t.tag)} is not a team key (1-40 lowercase letters, digits or dashes)`;
    if (t.parent != null && (typeof t.parent !== 'string' || !isTeamKey(t.parent))) return `Team ${t.tag}'s parent ${JSON.stringify(t.parent)} is not a team key`;
  }
  if (!o.members || typeof o.members !== 'object' || Array.isArray(o.members)) return 'The export has no members';
  for (const [tag, v] of Object.entries(o.members as Record<string, unknown>)) {
    const r = v as { current?: unknown; former?: unknown } | null;
    if (!r || typeof r !== 'object' || (r.current !== undefined && !Array.isArray(r.current)) || (r.former !== undefined && !Array.isArray(r.former))) {
      return `The roster of ${tag} is not { current: [...], former: [...] }`;
    }
    for (const m of [...((r.current as unknown[]) ?? []), ...((r.former as unknown[]) ?? [])]) {
      const problem = memberProblem(m);
      if (problem) return `A member of ${tag} ${problem}`;
    }
  }
  return null;
}

const optString = (v: unknown) => v == null || typeof v === 'string';
const isDate = (v: unknown) => typeof v === 'string' && !Number.isNaN(new Date(v).getTime());

/** Why one roster entry would break the sync, or null: an object with string fields and real dates. */
function memberProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'is not an object';
  const m = raw as Record<string, unknown>;
  for (const f of ['key', 'name', 'email', 'github'] as const) if (!optString(m[f])) return `has a ${f} that is not text`;
  if (!isDate(m.start)) return `has no valid start date (${JSON.stringify(m.start ?? null)})`;
  if (m.end != null && !isDate(m.end)) return `has an end that is not a date (${JSON.stringify(m.end)})`;
  return null;
}

/**
 * The export's shape, produced on the org-tree box (`teams-export.json`):
 *   { teams: [...], members: { "<tag>": { current: [...], former: [...] } } }
 * This is `/history/teams` and each `/history/team/<tag>` bundled into one file.
 */
export function parseExport(raw: unknown): { registry: OrgTeam[]; membersByTag: Map<string, OrgMember[]> } {
  const o = (raw ?? {}) as { teams?: OrgTeam[]; members?: Record<string, { current?: OrgMember[]; former?: OrgMember[] }> };
  const membersByTag = new Map<string, OrgMember[]>();
  for (const [tag, v] of Object.entries(o.members ?? {})) membersByTag.set(tag, [...(v.current ?? []), ...(v.former ?? [])]);
  return { registry: o.teams ?? [], membersByTag };
}

/**
 * The rows to write, from the registry and each team's roster. Pure, so the
 * resolution rule is tested without HTTP or a database. `loginFor` gets the
 * member's email and the org-tree's `github` and returns a login or null.
 */
export function buildSyncPlan(
  registry: OrgTeam[],
  membersByTag: Map<string, OrgMember[]>,
  loginFor: (email: string | null, github: string | null) => string | null,
): TeamSyncPlan {
  const teams = registry.map((t, i) => ({ key: t.tag, name: t.label || t.tag, parent: t.parent ?? null, hidden: !!t.hidden, sort: i }));
  const members: TeamSyncPlan['members'] = [];
  let skipped = 0;
  for (const t of teams) {
    for (const m of membersByTag.get(t.key) ?? []) {
      const login = loginFor(m.email ?? null, m.github ?? null);
      const start = m.start ? new Date(m.start) : null;
      const end = m.end ? new Date(m.end) : null;
      // A bad end would fail the whole write: skip the member like a bad start (Devin, #1094).
      if (!login || !start || Number.isNaN(start.getTime()) || (end && Number.isNaN(end.getTime()))) { skipped++; continue; }
      members.push({
        teamKey: t.key,
        login: login.toLowerCase(),
        email: (m.email ?? '').toLowerCase() || null,
        name: m.name ?? null,
        start,
        end,
        openStart: !!m.open_start,
      });
    }
  }
  return { teams, members, skipped };
}

async function getJson<T>(fetchImpl: typeof fetch, url: string): Promise<T> {
  // Bounded: the ingester tick awaits this, so an unreachable org-viewer must not stall it.
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return await res.json() as T;
}

export type TeamSyncSource = 'upload' | 'export' | 'api';

/** The registry and every roster: an uploaded export, else the export file when one is set, else the API. */
async function loadOrgData(deps: { apiBase?: string; exportPath?: string; exportData?: unknown; fetchImpl?: typeof fetch }): Promise<{ registry: OrgTeam[]; membersByTag: Map<string, OrgMember[]>; source: TeamSyncSource }> {
  if (deps.exportData !== undefined) {
    const problem = exportProblem(deps.exportData);
    if (problem) throw new Error(problem);
    return { ...parseExport(deps.exportData), source: 'upload' };
  }
  const exportPath = deps.exportPath ?? orgExportPath();
  if (exportPath) {
    const raw = readFileSync(exportPath, 'utf8');
    if (!raw.trim()) throw new Error(`${exportPath} is empty (the export did not write)`);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (err) { throw new Error(`${exportPath} is not valid JSON: ${(err as Error).message}`); }
    return { ...parseExport(parsed), source: 'export' };
  }
  const apiBase = deps.apiBase ?? orgApiBase();
  if (!apiBase) throw new Error('ORG_EXPLORER_API or ORG_EXPLORER_EXPORT is required');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const registry = await getJson<{ teams: OrgTeam[] }>(fetchImpl, `${apiBase}/history/teams`);
  const membersByTag = new Map<string, OrgMember[]>();
  for (const t of registry.teams) {
    const r = await getJson<{ current: OrgMember[]; former: OrgMember[] }>(fetchImpl, `${apiBase}/history/team/${encodeURIComponent(t.tag)}`);
    membersByTag.set(t.tag, [...(r.current ?? []), ...(r.former ?? [])]);
  }
  return { registry: registry.teams, membersByTag, source: 'api' };
}

/** email → login for termag users with a connected GitHub (user_credentials label '@login'). */
async function credentialLogins(): Promise<Map<string, string>> {
  const rows = await prisma.userCredential.findMany({ where: { provider: 'github' }, select: { label: true, user: { select: { googleEmail: true } } } });
  const m = new Map<string, string>();
  for (const r of rows) if (r.label?.startsWith('@') && r.user.googleEmail) m.set(r.user.googleEmail.toLowerCase(), r.label.slice(1).toLowerCase());
  return m;
}

export interface TeamSyncDeps {
  apiBase?: string;
  /** A local export file (from a space, say); wins over `apiBase`. */
  exportPath?: string;
  /**
   * An export's parsed contents, uploaded by an admin (POST …/prs/teams/import):
   * wins over both, for a deployment that can reach neither the file nor the
   * API (production: the org-viewer's box takes no inbound traffic).
   */
  exportData?: unknown;
  fetchImpl?: typeof fetch;
  loginMap?: Map<string, string>;
}

export interface TeamSyncResult { teams: number; members: number; skipped: number; source: TeamSyncSource }

/** Pull the registry and every roster, then replace the synced rows. */
export async function syncTeams(deps: TeamSyncDeps = {}): Promise<TeamSyncResult> {
  const [{ registry, membersByTag, source }, credentials] = await Promise.all([
    loadOrgData(deps),
    deps.loginMap ?? credentialLogins(),
  ]);
  const plan = buildSyncPlan(registry, membersByTag, (email, github) => github || (email ? credentials.get(email.toLowerCase()) ?? null : null));
  const syncedAt = new Date();
  const keys = plan.teams.map(t => t.key);
  // What createMany wrote: a member listed twice in a roster is one row (skipDuplicates), so plan.members.length overstates it.
  let written = 0;
  await prisma.$transaction(async tx => {
    for (const t of plan.teams) {
      await tx.team.upsert({
        where: { key: t.key },
        create: { ...t, syncedAt },
        update: { name: t.name, parent: t.parent, hidden: t.hidden, sort: t.sort, syncedAt },
      });
    }
    // The synced rows are derived: replace them whole. Manual rows stay.
    await tx.teamMembership.deleteMany({ where: { source: 'synced', teamKey: { in: keys } } });
    if (plan.members.length) {
      ({ count: written } = await tx.teamMembership.createMany({
        data: plan.members.map(m => ({ teamKey: m.teamKey, login: m.login, email: m.email, name: m.name, start: m.start, end: m.end, openStart: m.openStart, source: 'synced' })),
        skipDuplicates: true,
      }));
    }
  }, { timeout: 120_000, maxWait: 15_000 });
  return { teams: plan.teams.length, members: written, skipped: plan.skipped, source };
}
