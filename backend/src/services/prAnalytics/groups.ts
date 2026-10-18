/**
 * Repo groups: what a group is made of and
 * how it resolves to repos. Pure; the ingester supplies the org's repo list
 * and topic search results.
 *
 * Members:
 *   repo     an explicit owner/name, included at any visibility
 *   pattern  a glob over owner/name (`*` within a segment), public/internal only
 *   topic    a GitHub topic within an org, public/internal only
 * The visibility rule keeps one admin's token from exposing private repos to
 * every admin: a private repo is in a group only when the group names it.
 */

export type MemberKind = 'repo' | 'pattern' | 'topic';
export interface GroupMember { kind: MemberKind; value: string; org?: string }
export interface GroupDef { slug: string; name: string; members: GroupMember[]; excluded: string[]; sort: number }
export interface RepoInfo { repo: string; visibility: string; archived: boolean; topics?: string[] }

export const DEFAULT_ORG = 'example-org';
const REPO_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The groups seeded on first start; admins add their own from the PRs tab. */
export const SEED_GROUPS: GroupDef[] = [
  { slug: 'termag', name: 'termag', members: [{ kind: 'repo', value: 'example-org/termag' }], excluded: [], sort: 10 },
];

export const lowerRepo = (r: string) => r.trim().toLowerCase();

/** Glob over owner/name: `*` matches within one segment, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  const esc = lowerRepo(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${esc}$`);
}

/** Validate an edited group; returns the normalised group or an error. */
export function parseGroup(input: unknown): GroupDef | { error: string } {
  if (typeof input !== 'object' || input === null) return { error: 'group must be an object' };
  const g = input as Record<string, unknown>;
  const slug = typeof g.slug === 'string' ? g.slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) return { error: 'slug must be 1-40 lowercase letters, digits or dashes' };
  const name = typeof g.name === 'string' && g.name.trim() ? g.name.trim().slice(0, 60) : slug;
  if (!Array.isArray(g.members) || g.members.length === 0) return { error: 'a group needs at least one member' };
  if (g.members.length > 200) return { error: 'at most 200 members' };
  const members: GroupMember[] = [];
  for (const m of g.members as unknown[]) {
    const mm = m as Record<string, unknown>;
    const kind = mm?.kind; const value = typeof mm?.value === 'string' ? mm.value.trim() : '';
    if (kind === 'repo') {
      if (!REPO_RE.test(lowerRepo(value))) return { error: `not an owner/name repo: ${value}` };
      members.push({ kind, value: lowerRepo(value) });
    } else if (kind === 'pattern') {
      if (!/^[a-z0-9_.-]+\/[a-z0-9_.*?-]+$/.test(lowerRepo(value))) return { error: `not an owner/name pattern: ${value}` };
      members.push({ kind, value: lowerRepo(value) });
    } else if (kind === 'topic') {
      const org = typeof mm.org === 'string' && mm.org.trim() ? mm.org.trim().toLowerCase() : DEFAULT_ORG;
      if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(value.toLowerCase())) return { error: `not a GitHub topic: ${value}` };
      members.push({ kind, value: value.toLowerCase(), org });
    } else return { error: `member kind must be repo, pattern or topic` };
  }
  const excluded = Array.isArray(g.excluded) ? (g.excluded as unknown[]).filter((x): x is string => typeof x === 'string').map(lowerRepo) : [];
  const bad = excluded.find(x => !REPO_RE.test(x));
  if (bad) return { error: `not an owner/name repo: ${bad}` };
  const sort = Number.isInteger(g.sort) ? (g.sort as number) : 100;
  return { slug, name, members, excluded, sort };
}

/**
 * Resolve one group against the known repos. `topicRepos` maps `org:topic` to
 * the repos the topic search returned. Explicit repos missing from `known` are
 * kept with visibility '' (the ingester learns it on the first sync).
 */
export function resolveGroup(group: GroupDef, known: RepoInfo[], topicRepos: Map<string, string[]>): Array<{ repo: string; visibility: string }> {
  const byName = new Map(known.map(r => [lowerRepo(r.repo), r]));
  const shared = (r: RepoInfo | undefined) => !!r && !r.archived && (r.visibility === 'public' || r.visibility === 'internal');
  const out = new Map<string, string>();
  for (const m of group.members) {
    if (m.kind === 'repo') out.set(m.value, byName.get(m.value)?.visibility ?? '');
    else if (m.kind === 'pattern') {
      const re = globToRegExp(m.value);
      for (const r of known) if (re.test(lowerRepo(r.repo)) && shared(r)) out.set(lowerRepo(r.repo), r.visibility);
    } else {
      for (const name of topicRepos.get(`${m.org ?? DEFAULT_ORG}:${m.value}`) ?? []) {
        const r = byName.get(lowerRepo(name));
        if (shared(r)) out.set(lowerRepo(name), r!.visibility);
      }
    }
  }
  for (const x of group.excluded) out.delete(x);
  return [...out].map(([repo, visibility]) => ({ repo, visibility })).sort((a, b) => a.repo.localeCompare(b.repo));
}

/** Orgs whose full repo list is needed: those that a pattern or topic member names. */
export function orgsToList(groups: GroupDef[]): string[] {
  const s = new Set<string>();
  for (const g of groups) for (const m of g.members) {
    if (m.kind === 'pattern') s.add(m.value.split('/')[0]);
    if (m.kind === 'topic') s.add(m.org ?? DEFAULT_ORG);
  }
  return [...s].sort();
}
